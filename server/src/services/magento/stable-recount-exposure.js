const exposure = require('./exposure-reconciliation');
const c = require('./binding-contract');
const gate = require('../full-product-cutover-gate');
const { repairTransaction, lockRepairProducts, receipt } = require('../recount-repair.service');
const { writeAuditEvent } = require('../../audit/audit-events');
const { readPreviewProductOnClient } = require('./sync-preview-db');
const { previewProduct, planPreview } = require('./sync-preview');
const { nameStateEvidence } = require('./name-state');
const FORMAT = 'magento-stable-recount-exposure-v1';
const EVENT = 'product.magento_stable_recount_exposure_reconciled';
const transition = { from: { route: 'hold', holdReason: 'historical_ambiguity' }, to: { route: 'hold', holdReason: 'prior_exposure' } };
const fail = (code = 'EXPOSURE_RECONCILIATION_CONFLICT') => { throw c.error(409, code, 'Repeat the stable recount exposure review'); };
const clean = value => JSON.parse(JSON.stringify(value));

// Read the complete connected component, including incoming/inconsistent links
// and disconnected users of the same identity. Never prove lineage from hints.
async function read(client, config, sku, bindingRevisionId) {
  const state = await exposure.readState(client, sku);
  const p = state.product;
  const members = (await client.query(`WITH RECURSIVE edges(a,b) AS (
    SELECT id,corrected_from_product_id FROM products WHERE corrected_from_product_id IS NOT NULL
    UNION SELECT id,corrected_to_product_id FROM products WHERE corrected_to_product_id IS NOT NULL
    UNION SELECT source_product_id,corrected_product_id FROM product_corrections
  ), component(id) AS (
    SELECT id FROM products WHERE public_product_identity_id=$1
    UNION SELECT CASE WHEN e.a=c.id THEN e.b ELSE e.a END FROM component c JOIN edges e ON e.a=c.id OR e.b=c.id
  ) SELECT to_jsonb(p)||jsonb_build_object('public_sku',i.public_sku) product,to_jsonb(f) lifecycle,
    (SELECT to_jsonb(r) FROM sku_registry r WHERE r.full_sku=p.full_sku) reservation
    FROM component c JOIN products p ON p.id=c.id JOIN public_product_identities i ON i.id=p.public_product_identity_id
    LEFT JOIN product_full_export_state f ON f.product_id=p.id ORDER BY p.id`, [p.public_product_identity_id])).rows;
  const ids = members.map(m => m.product.id);
  const conflictingReservations = (await client.query(`SELECT EXISTS(SELECT 1 FROM products
    WHERE full_sku=ANY($1::text[]) AND NOT(id=ANY($2::int[]))) conflict`,
  [[p.public_sku,...members.map(m => m.product.full_sku)],ids])).rows[0].conflict;
  const corrections = (await client.query('SELECT * FROM product_corrections WHERE source_product_id=ANY($1::int[]) OR corrected_product_id=ANY($1::int[]) ORDER BY id', [ids])).rows;
  const activeRequests = (await client.query("SELECT * FROM correction_requests WHERE source_product_id=ANY($1::int[]) AND status IN ('pending','in_progress') ORDER BY id", [ids])).rows;
  const jobs = (await client.query(`SELECT to_jsonb(j) job,(SELECT jsonb_agg(to_jsonb(s) ORDER BY s.ordinal) FROM magento_sync_steps s WHERE s.job_id=j.id) steps
    FROM magento_sync_jobs j WHERE j.public_product_identity_id=$1 OR j.product_id=ANY($2::int[]) OR (j.origin_hash=$3 AND j.sku=$4) ORDER BY j.id`,
  [p.public_product_identity_id,ids,c.originHash(config.baseUrl),p.public_sku])).rows;
  const request = (await client.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1', [p.public_product_identity_id])).rows[0] || null;
  const deletions = (await client.query('SELECT * FROM magento_test_deletions WHERE public_product_identity_id=$1', [p.public_product_identity_id])).rows;
  const activation = (await client.query('SELECT * FROM public_sku_activation WHERE singleton')).rows[0];
  const automatic = (await client.query('SELECT * FROM magento_auto_sync_activation WHERE singleton')).rows[0];
  const amber = await readPreviewProductOnClient(client, { productId: p.id, bindingRevisionId });
  const binding = amber.revision;
  if (!binding || binding.originHash !== c.originHash(config.baseUrl)) fail('EXPOSURE_BINDING_REQUIRED');
  const current = await require('./binding-repository').current(client,binding.installationKey);
  state.stable = clean({ members, corrections, activeRequests, jobs, request, deletions, activation, automatic, binding, conflictingReservations,
    currentBindingId: current?.id || null,
    publicEvaluator: require('../export-templates/version-contract').isPublicEvaluator(amber.compiled.definition.evaluatorVersion),
    remoteId: Number(amber.nameState?.remote_product_id) || null,
    // Bind evaluation/support inputs as well as immutable template and binding.
    evaluation: require('./binding-evidence-products').evaluate(amber,amber.product),
    product: amber.product, nameState: nameStateEvidence(amber.nameState) });
  return { state, amber };
}
function commonBlockers(state) {
  const p = state.product, s = state.stable;
  const out = exposure.blockers(state).filter(b => b !== 'CORRECTION_LINEAGE');
  const block = code => out.push(code);
  if (!s.activation?.enabled) block('STABLE_PUBLIC_SKU_NOT_ACTIVE');
  if (s.automatic.legacy_product_csv_enabled !== false || !s.automatic.cutover_at) block('MAGENTO_DELIVERY_CUTOVER_REQUIRED');
  if (p.status !== 'active' || p.corrected_to_product_id != null || p.corrected_from_product_id == null) block('STABLE_RECOUNT_NOT_TERMINAL');
  if (s.binding.state !== 'published' || s.binding.id !== s.currentBindingId || !s.publicEvaluator
    || s.automatic.installation_key !== s.binding.installationKey) block('CURRENT_PUBLIC_BINDING_REQUIRED');
  if (!Number.isSafeInteger(s.remoteId) || s.remoteId <= 0) block('DURABLE_REMOTE_ID_REQUIRED');
  if (s.activeRequests.length || s.deletions.length) block('ACTIVE_CORRECTION_OR_DELETION');
  if (s.conflictingReservations) block('SKU_RESERVATION_CONFLICT');
  if (s.request && (s.request.product_id !== p.id || s.request.reason_code === 'reconciliation_required'
    || s.request.active_job_id != null || s.request.active_generation != null || s.request.state === 'syncing')) block('UNFINISHED_SYNC_WORK');
  if (s.jobs.some(j => !['succeeded','superseded'].includes((j.job || j).state)
    || j.steps?.some(step => step.state !== 'verified'))) block('UNFINISHED_SYNC_WORK');
  return [...new Set(out)];
}
function blockers(state) {
  const p = state.product, s = state.stable, out = commonBlockers(state);
  const block = code => out.push(code);
  const graph = require('../export-exposure/manifest').buildLineageGraph(s.members.map(m => m.product),s.corrections);
  const component = graph.components.get(p.id);
  if (!component || component.issues.length || component.productIds.length < 2
    || component.productIds.length !== s.members.length || new Set(s.members.map(m => m.product.id)).size !== s.members.length
    || c.hash(graph.terminals(p.id)) !== c.hash([p.id])) block('CORRECTION_LINEAGE_CONFLICT');
  for (const member of s.members) {
    const current = member.product, f = member.lifecycle;
    if (String(current.public_product_identity_id) !== String(p.public_product_identity_id) || current.public_sku !== p.public_sku) block('PUBLIC_IDENTITY_CHANGED');
    if (!member.reservation || member.reservation.first_product_id !== current.id) block('SKU_RESERVATION_CONFLICT');
    // Recount always sets the retired source's legacy export flag to 1.
    // That retirement marker is not an independent business exclusion. Typed
    // lifecycle policy remains authoritative for every member of the chain.
    if ((current.id === p.id && current.exclude_from_export !== 0) || f?.business_exclusion_state !== 'none' || f?.evidence?.independentExclusion === true
      || ['unknown','independent_exclusion'].includes(f?.evidence?.exclusionProvenance)) block('EXCLUSION_OR_UNKNOWN_POLICY');
    if (f?.recount_compatibility_excluded !== false) block('RECOUNT_COMPATIBILITY_EXCLUSION');
    if (current.id !== p.id && (current.status !== 'corrected' || f?.route !== 'retired')) block('PREDECESSOR_NOT_RETIRED');
    if (current.corrected_from_product_id == null) { if (f?.source_correction_id != null) block('CORRECTION_LINEAGE_CONFLICT'); continue; }
    const source = s.members.find(m => m.product.id === current.corrected_from_product_id)?.product;
    const links = s.corrections.filter(v => v.corrected_product_id === current.id);
    if (!source || source.full_sku === current.full_sku || links.length !== 1
      || links[0].id !== f?.source_correction_id) block('CORRECTION_LINEAGE_CONFLICT');
  }
  return [...new Set(out)];
}
async function snapshot(config, sku, options, reader = read) {
  c.identity(options.bindingRevisionId);
  const client = await options.databasePool.connect();
  try {
    await gate.begin(client,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if ((await client.query('SELECT current_database() name')).rows[0].name !== options.expectedDatabase) fail('EXPOSURE_DATABASE_MISMATCH');
    const result = await reader(client,config,sku,options.bindingRevisionId);
    await gate.commit(client); return result;
  } catch (cause) { await gate.rollback(client); throw cause; }
  finally { await gate.release(client); client.release(); }
}
async function inspectSync(config, local, options) {
  let remote = null, hypothetical;
  await (options.preview || previewProduct)(config,{ ...options, sku: local.state.product.public_sku,
    readAmber: async () => local.amber, onObservation(observation) {
      const { amber, schema, raw, categoryNodes, domainEvidence, categoryFailures } = observation;
      remote = raw ? { id: raw.id, sku: raw.sku } : null;
      // Preserve the loader's private source-support association; change only
      // this detached read snapshot, never persist a hypothetical eligibility.
      const before = amber.product.exportState;
      try {
        amber.product.exportState = { ...before, hold_reason: 'prior_exposure' };
        hypothetical = planPreview(amber,schema,raw,categoryNodes,{ domainEvidence });
        if (categoryFailures.length) hypothetical.sendable = false;
      } finally { amber.product.exportState = before; }
    } });
  const reasons = [];
  if (!remote || remote.sku !== local.state.product.public_sku || remote.id !== local.state.stable.remoteId) reasons.push('EXPOSURE_REMOTE_CHANGED');
  if (!hypothetical?.sendable || hypothetical.mode !== 'update') reasons.push('UPDATE_NOT_SENDABLE');
  return { remote, reasons, sendable: hypothetical?.sendable === true,
    problems: (hypothetical?.blockers || []).map(({ code, message, target, field, path, question, value }) =>
      clean({ code, message, target, field, path, question, value })),
    blockerCodes: (hypothetical?.blockers || []).map(b => b.code) };
}
// Recipes share the transaction/CAS/outbox boundary, but have separate proof
// readers, eligibility rules, formats and audit receipts. HTTP input cannot
// select or override these functions.
function createRecipe({ format = FORMAT, event = EVENT, reader = read, check = blockers, inspect = inspectSync,
  proof = () => ({}), validateEvidence = () => null, source = 'stable_recount_exposure',
  action = 'magento_stable_recount_prior_exposure', resolutionPrefix = 'stable-recount-exposure',
  lanes = plan => [plan.publicIdentityId], articles = plan => [plan.sku] } = {}) {
async function preview(config,sku,options) {
  const local = await snapshot(config,sku,options,reader);
  const reasons = check(local.state);
  const sync = reasons.length ? null : await inspect(config,local,options);
  if (sync) reasons.push(...sync.reasons);
  const fresh = await snapshot(config,sku,options,reader);
  if (c.hash(fresh.state) !== c.hash(local.state)) reasons.push('LOCAL_EVIDENCE_CHANGED');
  const plan = { format, database: options.expectedDatabase, originHash: c.originHash(config.baseUrl),
    productId: local.state.product.id, publicIdentityId: String(local.state.product.public_product_identity_id),
    sourceCorrectionId: local.state.lifecycle.source_correction_id,
    sku: local.state.product.public_sku, internalSku: local.state.product.full_sku,
    lineageProductIds: local.state.stable.members.map(m => m.product.id), bindingRevisionId: options.bindingRevisionId,
    installationKey: local.state.stable.binding.installationKey, beforeFingerprint: c.hash(local.state),
    deliveryVersion: String(local.state.lifecycle?.delivery_version), transition, sync, ...proof(local.state),
    blockers: [...new Set(reasons)], eligible: reasons.length === 0, generatedAt: new Date().toISOString() };
  c.safeData(plan,options.sensitiveValues); return { ...plan, planHash: c.hash(plan) };
}
function verify(config,plan,expectedHash,options) {
  const { planHash,...body } = plan || {}; c.safeData(body);
  if (planHash !== expectedHash || c.hash(body) !== expectedHash || plan.format !== format || !plan.eligible || plan.blockers.length
    || plan.database !== options.expectedDatabase || plan.originHash !== c.originHash(config.baseUrl)
    || c.hash(plan.transition) !== c.hash(transition) || !plan.sync?.sendable || plan.sync.remote?.sku !== plan.sku) fail('EXPOSURE_PLAN_INVALID');
}
async function apply(config,plan,expectedHash,options) {
  verify(config,plan,expectedHash,options);
  const reviewedEvidence = validateEvidence(plan,options.reviewedEvidence);
  const commandHash = reviewedEvidence ? c.hash({ planHash: plan.planHash, evidence: reviewedEvidence, reason: options.reason }) : null;
  const connection = await options.databasePool.connect(), held = [];
  const borrowed = { query: (...args) => connection.query(...args), release() {} };
  try {
    // Same order as automatic sync and controlled test deletion. Fail busy
    // before taking authority/product locks; never wait behind dispatched work.
    for (const key of [...lanes(plan).map(id => `amber_magento_public_identity:${id}`),
      ...articles(plan).map(sku => `amber_magento_sync:${plan.originHash}:${sku}`)]) {
      if (!(await connection.query('SELECT pg_try_advisory_lock(hashtext($1)) held',[key])).rows[0].held) fail('EXPOSURE_SYNC_BUSY');
      held.push(key);
    }
    return await repairTransaction({ ...options,databasePool: { connect: async () => borrowed } },async(client,context) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`amber_magento_binding:${plan.installationKey}`]);
      const previous = await receipt(client,plan.planHash,event);
      if (previous) {
        if (commandHash && previous.commandHash !== commandHash) fail('RECONCILIATION_KEY_CONFLICT');
        return { ...previous.result,alreadyApplied: true };
      }
      await lockRepairProducts(client,plan.lineageProductIds);
      const local = await reader(client,config,plan.sku,plan.bindingRevisionId);
      const p = local.state.product, s = local.state.stable;
      if (c.hash(local.state) !== plan.beforeFingerprint || check(local.state).length
        || p.id !== plan.productId || String(p.public_product_identity_id) !== plan.publicIdentityId || p.public_sku !== plan.sku
        || p.full_sku !== plan.internalSku || s.binding.installationKey !== plan.installationKey
        || local.state.lifecycle.source_correction_id !== plan.sourceCorrectionId
        || c.hash(s.members.map(m => m.product.id)) !== c.hash(plan.lineageProductIds)
        || String(local.state.lifecycle.delivery_version) !== plan.deliveryVersion) fail();
      if (c.hash(proof(local.state)) !== c.hash(Object.fromEntries(Object.keys(proof(local.state)).map(key => [key,plan[key]])))) fail();
      const sync = await inspect(config,local,options);
      if (sync.reasons.length || c.hash(sync.remote) !== c.hash(plan.sync.remote)) fail('EXPOSURE_REMOTE_CHANGED');
      if (options.signal?.aborted) fail('EXPOSURE_INTERRUPTED');
      if (c.hash((await reader(client,config,plan.sku,plan.bindingRevisionId)).state) !== plan.beforeFingerprint) fail();
      const prior = local.state.lifecycle;
      const evidence = { ...prior.evidence,origin: 'reconciliation',action,
        ...(reviewedEvidence ? { reviewedHistory: { ...proof(local.state), evidence: reviewedEvidence, remote: sync } } : {}),
        priorEvidence: prior.evidence,magentoPriorExposure: { originHash: plan.originHash,productId: sync.remote.id,sku: plan.sku,
          observedAt: new Date().toISOString(),planHash: plan.planHash,doesNotAcknowledgeExport: true } };
      const changed = (await client.query(`UPDATE product_full_export_state SET hold_reason='prior_exposure',evidence=$2::jsonb,
        delivery_version=delivery_version+1,last_resolution_key=$3,resolved_by_user_id=$4,resolved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
        WHERE product_id=$1 AND route='hold' AND hold_reason='historical_ambiguity' AND delivery_version=$5::bigint RETURNING delivery_version`,
      [plan.productId,JSON.stringify(evidence),`${resolutionPrefix}:${plan.planHash}`,context.actorUserId,plan.deliveryVersion])).rows[0];
      if (!changed) fail();
      // Reuse the reviewed broader-resync outbox. Enrollment and dispatch retain
      // their own actor, current-product and uncertain-work checks. No SQL repair
      // of a parked request, fabricated acknowledgement or Magento write here.
      const handoffId = await require('./binding-handoff').record(client,context,local.state.stable.binding,'broader_resync',plan.planHash,
        { source,planHash: plan.planHash,doesNotAcknowledgeExport: true },
        [{ productId: plan.productId,publicIdentityId: plan.publicIdentityId,reason: 'reviewed_resync' }]);
      const result = { productId: plan.productId,sku: plan.sku,publicIdentityId: plan.publicIdentityId,
        route: 'hold',holdReason: 'prior_exposure',deliveryVersion: changed.delivery_version,handoffId,planHash: plan.planHash };
      await writeAuditEvent(client,{ mutationContext: context,eventKey: event,subjectType: 'magento_exposure_resolution',subjectId: plan.planHash,
        details: { beforeFingerprint: plan.beforeFingerprint,transition,remote: sync.remote,lineageProductIds: plan.lineageProductIds,
          ...(reviewedEvidence ? { commandHash, reason: options.reason, reviewedHistory: { ...proof(local.state), evidence: reviewedEvidence, remote: sync } } : {}),
          bindingRevisionId: plan.bindingRevisionId,originHash: plan.originHash,result,doesNotAcknowledgeExport: true } });
      return { ...result,alreadyApplied: false };
    });
  } finally {
    for (const key of held.reverse()) await connection.query('SELECT pg_advisory_unlock(hashtext($1))',[key]);
    connection.release();
  }
}
return { preview,apply };
}
module.exports = { blockers,commonBlockers,read,inspectSync,createRecipe,...createRecipe() };
