const gate = require('./full-product-cutover-gate');
const { repairTransaction, lockRepairProducts, receipt, conflict, error } = require('./recount-repair.service');
const { readRepairInput, loadRepairInput } = require('./export-exposure/repair-loader');
const { buildRepairManifest, digest } = require('./export-exposure/repair-manifest');
const { buildHistoricalIndex } = require('./export-exposure/historical-index');
const { writeAuditEvent } = require('../audit/audit-events');

const FORMAT = 'amber-full-product-cutover-v1';
const BATCH_SIZE = 100;
const maintenance = (options) => ({ ...options, maintenance: true, exclusive: true });
const seal = (value) => ({ ...value, contentSha256: digest(value) });
function verify(manifest, hash, kind) {
  const { contentSha256, ...body } = manifest || {};
  if (manifest?.format !== FORMAT || manifest.kind !== kind || contentSha256 !== hash || digest(body) !== hash) {
    throw error(422, 'CUTOVER_MANIFEST_INVALID', 'Exact cutover manifest and hash required');
  }
}
const stateView = (s) => Object.fromEntries(['revision','confirmed_revision','delivery_version','route','hold_reason',
  'cutover_baseline_revision','business_exclusion_state','recount_compatibility_excluded','repair_manifest_hash',
  'evidence','source_correction_id','last_resolution_key','resolved_by_user_id','resolved_at'].map((k) => [k, s[k]]));
function environment(input) {
  return digest({ database: input.database, migrations: input.migrations, products: input.products,
    corrections: input.corrections, registry: input.registry, revisions: input.revisions,
    events: input.events, state: input.state, snapshots: input.snapshots, artifacts: input.artifacts, members: input.members });
}
async function preparation(client, { indexed = false, approved = false } = {}) {
  const current = await gate.readGate(client);
  if (current.phase !== 'preparing' || (indexed && !current.historical_index_event_id)
    || (approved && !current.approval_event_id)) throw conflict('Canonical preparation/index/approval boundary not reached');
  return current;
}
async function prepare(options) {
  if (typeof options.deploymentEvidence !== 'string' || !options.deploymentEvidence.trim() || options.deploymentEvidence.length > 4000) {
    throw error(422, 'CUTOVER_DEPLOYMENT_EVIDENCE_REQUIRED', 'Record the deployed writer version, drained old instances and operational freeze');
  }
  return repairTransaction(maintenance(options), async (client, context) => {
    const current = await gate.readGate(client);
    if (current.phase === 'preparing') return current;
    if (current.phase !== 'legacy' || !current.singleton) throw conflict('Migration 040 and legacy gate required');
    await writeAuditEvent(client, { mutationContext: context, eventKey: 'full_product_cutover.preparing',
      subjectType: 'cutover', subjectId: 'singleton', details: { writerVersion: gate.WRITER_VERSION, freezeThroughActivation: true,
        deploymentEvidence: options.deploymentEvidence } });
    return (await client.query(`UPDATE full_product_export_activation SET phase='preparing', generation=generation+1,
      updated_at=CURRENT_TIMESTAMP WHERE singleton RETURNING *`)).rows[0];
  });
}
function indexingManifest(input, current) {
  const indexing = buildHistoricalIndex(input);
  return seal({ format: FORMAT, kind: 'index', database: input.database, generation: String(current.generation),
    environmentHash: environment(input), lifecycleHash: digest(input.lifecycle), indexing });
}
function cutoverManifest(input, current) {
  const repair = buildRepairManifest(input);
  if (repair.indexing.proposed.length || repair.indexing.diagnostics.length) throw conflict('Historical indexing must finish first');
  const payloads = new Map(input.products.map((p) => [Number(p.id), digest(p)]));
  const entries = repair.repairEntries.map((e) => {
    const before = stateView(e.lifecycle);
    const entry = { productId: e.productId, sku: e.sku, lineageProductIds: e.lineageProductIds,
      classification: e.exposure.classification, payloadHash: payloads.get(e.productId), before, after: before, action: 'preserve' };
    if (e.status !== 'active' || e.before.products.find((p) => p.id === e.productId)?.corrected_to_product_id) return entry;
    if (e.lifecycle.evidence?.origin !== 'migration_039'
      || e.lifecycle.revision !== '1' || e.lifecycle.confirmed_revision !== '0') {
      throw conflict(`Product ${e.productId} requires a separately reviewed cutover plan`);
    }
    const ordinary = !e.correctionId && !e.ancestorChain.length;
    if (ordinary && Number(e.exclude_from_export) !== 0) throw conflict(`Ordinary exclusion ${e.productId} requires explicit resolution`);
    const baseline = ordinary && ['confirmed_exact','historical_ambiguous'].includes(e.exposure.classification);
    const pending = ordinary && e.exposure.classification === 'reliably_unexposed';
    entry.action = baseline ? 'legacy_baseline' : pending ? 'first_delivery' : 'hold';
    entry.after = { ...before, route: baseline || pending ? 'normal' : 'hold',
      hold_reason: baseline || pending ? null : ['confirmed_exact','generated_exact'].includes(e.exposure.classification)
        ? 'prior_exposure' : 'historical_ambiguity',
      cutover_baseline_revision: baseline ? '1' : '0', delivery_version: String(BigInt(before.delivery_version)+1n),
      business_exclusion_state: Number(e.exclude_from_export) === 0 ? 'none' : 'unknown',
      recount_compatibility_excluded: false,
      evidence: { origin: 'cutover', classification: e.exposure.classification,
        decision: entry.action, retainedIssues: e.exposure.issues, currentPayloadEquality: 'not_proven', confirmationIsNotImportReceipt: true,
        historicalCoverage: pending ? 'retained_evidence_unexposed' : 'historical_exposure' } };
    return entry;
  });
  return seal({ format: FORMAT, kind: 'cutover', database: input.database, generation: String(current.generation),
    historicalIndexEventId: String(current.historical_index_event_id), environmentHash: environment(input), entries,
    policy: { baseline: 'confirmed_exact_and_legacy_indicators', preserveUnexposedFirstDelivery: true,
      generatedOnly: 'hold_for_file_reconciliation', successorExclusions: 'preserve_until_operator_resolution',
      freezeThroughActivation: true, batchSize: BATCH_SIZE } });
}
async function generate(kind, options) {
  // One repeatable-read view includes the gate and data. No useful DB writes.
  const input = await loadRepairInput(options.databasePool, { expectedDatabase: options.expectedDatabase });
  const current = input.activation;
  if (kind === 'amendment') {
    if (current?.phase !== 'preparing' || !current.approval_event_id) throw conflict('An approved preparing manifest is required');
    const event = (await options.databasePool.query('SELECT details FROM audit_events WHERE id=$1',[current.approval_event_id])).rows[0];
    return amendmentManifest(input,current,event.details.manifest);
  }
  if (current?.phase !== 'preparing' || (kind === 'cutover' && !current.historical_index_event_id)
    || current.approval_event_id) throw conflict('Generate fresh manifests inside the unapproved preparing gate');
  if (kind === 'index') return indexingManifest(input, current);
  if (kind === 'cutover') return cutoverManifest(input, current);
  throw error(422, 'CUTOVER_KIND_INVALID', 'Use index or cutover');
}
function amendmentManifest(input, current, parent) {
  verify(parent,current.manifest_hash,'cutover');
  const repair=buildRepairManifest(input);
  if (repair.indexing.proposed.length || repair.indexing.diagnostics.length || input.products.length!==parent.entries.length) {
    throw conflict('Amendment cannot waive indexing failures or change inventory scope');
  }
  const observed=new Map(repair.repairEntries.map((e)=>[e.productId,e]));
  const payloads=new Map(input.products.map((p)=>[Number(p.id),digest(p)]));
  const entries=parent.entries.map((e)=>{
    const row=observed.get(e.productId);
    if (!row || row.sku!==e.sku || row.exposure.classification!==e.classification) {
      throw conflict(`Product ${e.productId} identity/exposure changed; no automatic amendment policy applies`);
    }
    const state=stateView(row.lifecycle);
    // Completed decisions remain bound to their original audit/hash. Never
    // re-baseline them or synthesize replacement receipts under the new hash.
    if (digest(state)===digest(expectedAfter(e,parent.contentSha256))) {
      if (payloads.get(e.productId)!==e.payloadHash) throw conflict(`Completed product ${e.productId} payload changed; restore it or review a forward correction`);
      return {...e,action:'preserve',before:state,after:state};
    }
    if (digest(state)!==digest(e.before)) throw conflict(`Product ${e.productId} lifecycle drift needs separate review`);
    return {...e,payloadHash:payloads.get(e.productId)};
  });
  return seal({format:FORMAT,kind:'cutover',database:input.database,generation:String(current.generation),
    historicalIndexEventId:String(current.historical_index_event_id),parentManifestHash:parent.contentSha256,
    environmentHash:environment(input),entries,policy:parent.policy});
}
async function indexHistorical(manifest, hash, options) {
  verify(manifest, hash, 'index');
  return repairTransaction(maintenance(options), async (client, context) => {
    const prior = await receipt(client, hash, 'full_product_cutover.indexed');
    if (prior) return { ...prior.result, alreadyApplied: true };
    const current = await preparation(client);
    if (current.approval_event_id || current.historical_index_event_id) throw conflict('Indexing already sealed');
    const fresh = indexingManifest(await readRepairInput(client), current);
    if (fresh.contentSha256 !== hash || fresh.indexing.diagnostics.length) throw conflict('Indexing evidence changed');
    await lockRepairProducts(client, fresh.indexing.proposed.map((m) => m.product_id));
    for (const m of fresh.indexing.proposed) await client.query(`INSERT INTO export_snapshot_products
      (snapshot_id,product_id,sku_at_capture,full_revision,delivery_version,capture_kind,evidence_origin,evidence_hash)
      VALUES($1,$2,$3,NULL,NULL,'legacy_compatibility','verified_stored_csv',$4)`,
    [m.snapshot_id,m.product_id,m.sku_at_capture,m.evidence_hash]);
    const result = { manifestHash: hash, indexedMemberships: fresh.indexing.proposed.length };
    const event = await writeAuditEvent(client, { mutationContext: context, eventKey: 'full_product_cutover.indexed',
      subjectType: 'cutover_manifest', subjectId: hash, details: { result, manifest } });
    await client.query(`UPDATE full_product_export_activation SET historical_index_event_id=$1,
      generation=generation+1,updated_at=CURRENT_TIMESTAMP WHERE singleton`, [event.id]);
    return result;
  });
}
async function approve(manifest, hash, reason, options) {
  verify(manifest, hash, 'cutover');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 4000) throw error(422, 'CUTOVER_REASON_REQUIRED', 'Cutover business acceptance requires a reason');
  return repairTransaction(maintenance(options), async (client, context) => {
    const observed = await gate.readGate(client);
    if (observed.phase === 'active' && observed.manifest_hash === hash) return {manifestHash:hash,alreadyApproved:true};
    const current = await preparation(client, { indexed: true });
    if (current.manifest_hash === hash) return { manifestHash: hash, alreadyApproved: true };
    if (current.manifest_hash && manifest.parentManifestHash!==current.manifest_hash) throw conflict('Explicit reviewed amendment required');
    const input=await readRepairInput(client);
    const fresh=current.manifest_hash ? amendmentManifest(input,current,await approved(client,current.manifest_hash)) : cutoverManifest(input,current);
    if (fresh.contentSha256 !== hash) throw conflict('Cutover manifest changed');
    const event = await writeAuditEvent(client, { mutationContext: context, eventKey: 'full_product_cutover.approved',
      subjectType: 'cutover_manifest', subjectId: hash, details: { manifest, reason, previousApprovalEventId:current.approval_event_id,
        acceptanceIsBusinessAssertion: true, confirmsDelivery: false, confirmsMagentoImport: false } });
    await client.query(`UPDATE full_product_export_activation SET manifest_hash=$1,approval_event_id=$2,
      generation=generation+1,updated_at=CURRENT_TIMESTAMP WHERE singleton`, [hash,event.id]);
    return { manifestHash: hash, alreadyApproved: false };
  });
}
async function approved(client, hash) {
  const current = await preparation(client, { indexed: true, approved: true });
  if (current.manifest_hash !== hash) throw conflict('Exact approved manifest required');
  const event = (await client.query('SELECT details FROM audit_events WHERE id=$1', [current.approval_event_id])).rows[0];
  const manifest = event.details.manifest;
  verify(manifest, hash, 'cutover');
  return manifest;
}
const expectedAfter = (entry, hash) => entry.action === 'preserve' ? entry.before : { ...entry.after, repair_manifest_hash: hash };
function assertEnvironment(input, manifest) {
  if (environment(input) !== manifest.environmentHash) throw conflict('Inventory, payload, schema or historical evidence changed');
}
async function applyBatch(hash, batchNumber, options) {
  if (!Number.isSafeInteger(batchNumber) || batchNumber < 0) throw error(422, 'CUTOVER_BATCH_INVALID', 'Zero-based batch number required');
  return repairTransaction(maintenance(options), async (client, context) => {
    const key = `${hash}:${batchNumber}`;
    const previous = await receipt(client, key, 'full_product_cutover.batch_applied');
    if (previous) return { ...previous.result, alreadyApplied: true };
    const manifest = await approved(client, hash);
    const entries = manifest.entries.filter((e) => e.action !== 'preserve').slice(batchNumber*BATCH_SIZE,(batchNumber+1)*BATCH_SIZE);
    if (!entries.length) throw error(422, 'CUTOVER_BATCH_INVALID', 'Batch absent from approved manifest');
    await lockRepairProducts(client, entries.flatMap((e) => e.lineageProductIds));
    const input = await readRepairInput(client); assertEnvironment(input, manifest);
    const states = new Map(input.lifecycle.map((s) => [Number(s.product_id),s]));
    for (const entry of entries) {
      if (digest(stateView(states.get(entry.productId))) !== digest(entry.before)) throw conflict(`Stale entry ${entry.productId}; entire batch rolled back`);
      const after = expectedAfter(entry, hash); let baselineEvent = null;
      if (entry.action === 'legacy_baseline') baselineEvent = await writeAuditEvent(client, {
        mutationContext: context, eventKey: 'product.full_export_baselined', subjectType: 'product', subjectId: entry.productId,
        details: { manifestHash: hash, baselineRevision: after.cutover_baseline_revision, factualEvidence: entry.classification,
          assertion: 'current_inventory_accepted_as_legacy_external_baseline', deliveryNotProven: true } });
      await client.query(`UPDATE product_full_export_state SET route=$2,hold_reason=$3,delivery_version=$4,
        cutover_baseline_revision=$5,cutover_baseline_event_id=$6,business_exclusion_state=$7,
        recount_compatibility_excluded=$8,evidence=$9::jsonb,repair_manifest_hash=$10,updated_at=CURRENT_TIMESTAMP
        WHERE product_id=$1`, [entry.productId,after.route,after.hold_reason,after.delivery_version,
        after.cutover_baseline_revision,baselineEvent?.id || null,after.business_exclusion_state,
        after.recount_compatibility_excluded,JSON.stringify(after.evidence),hash]);
    }
    const result = { manifestHash: hash, batchNumber, productIds: entries.map((e) => e.productId) };
    await writeAuditEvent(client, { mutationContext: context, eventKey: 'full_product_cutover.batch_applied',
      subjectType: 'cutover_batch', subjectId: key, details: { result, beforeAfterHash: digest(entries) } });
    return { ...result, alreadyApplied: false };
  });
}
async function validateInside(client, hash) {
  const manifest = await approved(client, hash);
  const input = await readRepairInput(client); assertEnvironment(input, manifest);
  const states = new Map(input.lifecycle.map((s) => [Number(s.product_id),s]));
  if (states.size !== manifest.entries.length) throw conflict('Lifecycle coverage changed');
  for (const e of manifest.entries) {
    if (digest(stateView(states.get(e.productId))) !== digest(expectedAfter(e, hash))) throw conflict(`Unfinished or stale entry ${e.productId}`);
  }
  const batches = Math.ceil(manifest.entries.filter((e) => e.action !== 'preserve').length/BATCH_SIZE);
  for (let n=0;n<batches;n++) if (!await receipt(client, `${hash}:${n}`, 'full_product_cutover.batch_applied')) throw conflict(`Batch receipt ${n} missing`);
  const invalid = await client.query(`SELECT p.id FROM products p LEFT JOIN product_full_export_state f ON f.product_id=p.id
    WHERE f.product_id IS NULL OR (p.status<>'active' OR p.corrected_to_product_id IS NOT NULL) AND f.route<>'retired'
    OR COALESCE(p.exclude_from_export,0) <> CASE WHEN f.route='retired' OR f.business_exclusion_state<>'none'
      OR f.recount_compatibility_excluded THEN 1 ELSE 0 END LIMIT 1`);
  if (invalid.rows.length) throw conflict(`Exclusion/lifecycle projection inconsistent: ${invalid.rows[0].id}`);
  return { manifestHash: hash, products: states.size, batches, mutations: manifest.entries.filter((e) => e.action !== 'preserve').length };
}
async function validate(hash, options) {
  return repairTransaction(maintenance(options), async (client) => validateInside(client, hash));
}
async function activate(hash, options) {
  return repairTransaction(maintenance(options), async (client, context) => {
    const current = await gate.readGate(client);
    if (current.phase === 'active' && current.manifest_hash === hash) return { manifestHash: hash, alreadyActive: true };
    const result = await validateInside(client, hash);
    const event = await writeAuditEvent(client, { mutationContext: context, eventKey: 'full_product_cutover.activated',
      subjectType: 'cutover_manifest', subjectId: hash, details: { ...result, selectorVersion: 1, successorExclusionsReleased: 0 } });
    await client.query(`UPDATE full_product_export_activation SET phase='active',selector_version=1,
      activation_event_id=$1,generation=generation+1,updated_at=CURRENT_TIMESTAMP WHERE singleton`, [event.id]);
    return { ...result, alreadyActive: false };
  });
}
async function status(options) {
  return repairTransaction({...options,maintenance:true},async(client)=>({
    gate:await gate.readGate(client), queues:await require('./full-product-selection').queues(client),
  }));
}
module.exports = { prepare, generate, indexHistorical, approve, applyBatch, validate, activate, status, BATCH_SIZE, stateView };
