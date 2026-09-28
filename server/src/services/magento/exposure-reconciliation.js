const gate = require('../full-product-cutover-gate');
const { repairTransaction, lockRepairProducts, receipt } = require('../recount-repair.service');
const { writeAuditEvent } = require('../../audit/audit-events');
const { hash, originHash, error, safeData } = require('./binding-contract');
const { createMagentoClient } = require('./client');
const { resolveProductLookup } = require('../product/public-identity');

const FORMAT = 'magento-prior-exposure-v1';
const EVENT = 'product.magento_prior_exposure_reconciled';
const transition = { from: { route: 'hold', holdReason: 'historical_ambiguity' },
  to: { route: 'hold', holdReason: 'prior_exposure' } };
const fail = (code = 'EXPOSURE_RECONCILIATION_CONFLICT') => { throw error(409, code, 'Exposure reconciliation requires fresh nonconflicting evidence'); };

// Also bind incoming lineage links, active correction requests and permanent SKU
// ownership. The apply reader runs again after the ordinary product/state locks.
async function readState(client, sku) {
  const resolved = await resolveProductLookup(client, sku);
  if (!resolved.product || resolved.internalMatchCount > 1) fail('EXPOSURE_PRODUCT_NOT_UNIQUE');
  const rows = (await client.query(`SELECT to_jsonb(p) AS product,
    CASE WHEN f.product_id IS NULL THEN NULL ELSE to_jsonb(f) || jsonb_build_object(
      'revision',f.revision::text,'confirmed_revision',f.confirmed_revision::text,
      'delivery_version',f.delivery_version::text,'cutover_baseline_revision',f.cutover_baseline_revision::text) END AS lifecycle,
    (SELECT to_jsonb(r) FROM sku_registry r WHERE r.full_sku=p.full_sku) AS reservation,
    EXISTS(SELECT 1 FROM product_corrections c WHERE c.source_product_id=p.id OR c.corrected_product_id=p.id) AS correction,
    EXISTS(SELECT 1 FROM products q WHERE q.corrected_from_product_id=p.id OR q.corrected_to_product_id=p.id) AS linked,
    EXISTS(SELECT 1 FROM correction_requests c WHERE c.source_product_id=p.id AND c.status IN ('pending','in_progress')) AS active_request
    FROM (SELECT p.*,i.public_sku FROM products p JOIN public_product_identities i
      ON i.id=p.public_product_identity_id WHERE p.id=$1) p
    LEFT JOIN product_full_export_state f ON f.product_id=p.id`, [resolved.product.id])).rows;
  if (rows.length !== 1) fail('EXPOSURE_PRODUCT_NOT_UNIQUE');
  return { ...rows[0], gate: await gate.readGate(client) };
}
function blockers(state) {
  const p = state.product; const f = state.lifecycle; const out = [];
  if (!f || p.status !== 'active') out.push('PRODUCT_NOT_CURRENT');
  if (p.corrected_from_product_id != null || p.corrected_to_product_id != null || f?.source_correction_id != null
    || state.correction || state.linked) out.push('CORRECTION_LINEAGE');
  if (state.active_request) out.push('ACTIVE_CORRECTION_REQUEST');
  if (f?.route !== 'hold' || f?.hold_reason !== 'historical_ambiguity') out.push('HOLD_NOT_HISTORICALLY_AMBIGUOUS');
  if (p.exclude_from_export !== 0 || f?.business_exclusion_state !== 'none'
    || f?.evidence?.independentExclusion === true
    || ['unknown', 'independent_exclusion'].includes(f?.evidence?.exclusionProvenance)) out.push('EXCLUSION_OR_UNKNOWN_POLICY');
  if (f?.recount_compatibility_excluded) out.push('RECOUNT_COMPATIBILITY_EXCLUSION');
  if (!state.reservation || state.reservation.first_product_id !== p.id) out.push('SKU_RESERVATION_CONFLICT');
  if (!['legacy', 'active'].includes(state.gate.phase)) out.push('CUTOVER_PREPARING');
  return out;
}
async function snapshot(databasePool, expectedDatabase, sku) {
  if (typeof sku !== 'string' || !sku.trim() || sku.length > 256 || /[\u0000-\u001f\u007f]/.test(sku)) fail();
  const client = await databasePool.connect();
  try {
    await gate.begin(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const database = (await client.query('SELECT current_database() name')).rows[0].name;
    if (database !== expectedDatabase) fail('EXPOSURE_DATABASE_MISMATCH');
    const state = await readState(client, sku);
    await gate.commit(client); return { database, state };
  } catch (cause) { await gate.rollback(client); throw cause; }
  finally { await gate.release(client); client.release(); }
}
async function observe(config, sku, options) {
  const client = createMagentoClient(config, { fetchImpl: options.fetchImpl });
  try {
    const remote = await client.findProductBySku(sku);
    if (!Number.isSafeInteger(remote.id) || remote.id <= 0 || remote.sku !== sku) fail('MAGENTO_RESPONSE_INVALID');
    return { status: 'found', id: remote.id, sku: remote.sku, observedAt: new Date().toISOString() };
  } catch (cause) {
    return { status: cause.code === 'MAGENTO_PRODUCT_NOT_FOUND' ? 'not_found' : 'lookup_error',
      code: /^MAGENTO_[A-Z_]+$/.test(cause.code || '') ? cause.code : 'MAGENTO_LOOKUP_FAILED' };
  }
}
async function preview(config, sku, options) {
  const { database, state } = await snapshot(options.databasePool, options.expectedDatabase, sku);
  const publicSku = state.product.public_sku || state.product.full_sku;
  const remote = await observe(config, publicSku, options);
  const reasons = blockers(state);
  if (remote.status !== 'found') reasons.push(remote.status === 'not_found' ? 'MAGENTO_PRODUCT_NOT_FOUND' : 'MAGENTO_LOOKUP_ERROR');
  const plan = { format: FORMAT, database, originHash: originHash(config.baseUrl), productId: state.product.id, sku: publicSku,
    internalSku: state.product.full_sku, publicSku,
    beforeFingerprint: hash(state), deliveryVersion: String(state.lifecycle?.delivery_version),
    transition, remote, blockers: reasons, eligible: reasons.length === 0, generatedAt: new Date().toISOString() };
  safeData(plan, options.sensitiveValues);
  return { ...plan, planHash: hash(plan) };
}
function verify(plan, expectedHash, config, database) {
  const { planHash, ...body } = plan || {};
  safeData(body);
  if (planHash !== expectedHash || hash(body) !== expectedHash || plan.format !== FORMAT || !plan.eligible
    || plan.blockers.length || hash(plan.transition) !== hash(transition) || plan.database !== database
    || plan.originHash !== originHash(config.baseUrl) || plan.remote.status !== 'found'
    || plan.remote.sku !== plan.sku || !Number.isSafeInteger(plan.productId) || plan.productId <= 0) fail('EXPOSURE_PLAN_INVALID');
}
async function apply(config, plan, expectedHash, options) {
  verify(plan, expectedHash, config, options.expectedDatabase);
  return repairTransaction(options, async (client, context) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_exposure:${plan.planHash}`]);
    const previous = await receipt(client, plan.planHash, EVENT);
    // Completed identical retries return the immutable receipt; no new GET,
    // attribution, version increment or rewrite of later lifecycle decisions.
    if (previous) return { ...previous.result, alreadyApplied: true };
    await lockRepairProducts(client, [plan.productId]);
    const state = await readState(client, plan.sku);
    if (state.product.id !== plan.productId || hash(state) !== plan.beforeFingerprint || blockers(state).length) fail();
    const remote = await observe(config, plan.sku, options);
    if (options.signal?.aborted) fail('EXPOSURE_INTERRUPTED');
    if (remote.status === 'lookup_error') fail('EXPOSURE_REMOTE_LOOKUP_FAILED');
    if (remote.status !== 'found' || remote.id !== plan.remote.id || remote.sku !== plan.sku) fail('EXPOSURE_REMOTE_CHANGED');
    // Only exposure certainty changes. The CSV route stays held; every exclusion,
    // reservation, payload/delivery acknowledgement and baseline stays untouched.
    const evidence = { ...state.lifecycle.evidence, origin: 'reconciliation', action: 'magento_prior_exposure',
      priorEvidence: state.lifecycle.evidence, magentoPriorExposure: {
      originHash: plan.originHash, productId: remote.id, sku: remote.sku,
      observedAt: remote.observedAt, planHash: plan.planHash, doesNotAcknowledgeExport: true } };
    const changed = await client.query(`UPDATE product_full_export_state SET hold_reason='prior_exposure',
      evidence=$2::jsonb, delivery_version=delivery_version+1, last_resolution_key=$3,
      resolved_by_user_id=$4,resolved_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE product_id=$1 AND route='hold' AND hold_reason='historical_ambiguity'
      AND delivery_version=$5::bigint RETURNING delivery_version`,
    [plan.productId, JSON.stringify(evidence), `magento-exposure:${plan.planHash}`, context.actorUserId, plan.deliveryVersion]);
    if (changed.rows.length !== 1) fail();
    const result = { productId: plan.productId, sku: plan.sku, route: 'hold', holdReason: 'prior_exposure',
      deliveryVersion: changed.rows[0].delivery_version, planHash: plan.planHash };
    await writeAuditEvent(client, { mutationContext: context, eventKey: EVENT, subjectType: 'magento_exposure_resolution',
      subjectId: plan.planHash, details: { beforeFingerprint: plan.beforeFingerprint, transition,
        originHash: plan.originHash, remote, result, doesNotAcknowledgeExport: true } });
    return { ...result, alreadyApplied: false };
  });
}
async function hypotheticalSync(config, plan, options) {
  verify(plan, plan.planHash, config, options.expectedDatabase);
  const { previewProduct, planPreview } = require('./sync-preview');
  let hypothetical;
  const actual = await previewProduct(config, { ...options, sku: plan.sku, onObservation(observation) {
    const { amber, schema, raw, categoryNodes, domainEvidence, categoryFailures } = observation;
    if (raw?.id !== plan.remote.id || raw?.sku !== plan.sku || categoryFailures.length) fail('EXPOSURE_REMOTE_CHANGED');
    const projected = structuredClone(amber.product);
    projected.exportState.hold_reason = 'prior_exposure';
    hypothetical = planPreview({ ...amber, product: projected }, schema, raw, categoryNodes, { domainEvidence });
  } });
  const fresh = await snapshot(options.databasePool, options.expectedDatabase, plan.sku);
  if (hash(fresh.state) !== plan.beforeFingerprint || blockers(fresh.state).length) fail();
  return { hypotheticalOnly: true, persisted: false, actual, hypothetical };
}
module.exports = { readState, blockers, snapshot, observe, preview, verify, apply, hypotheticalSync };
