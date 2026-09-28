const single = require('./exposure-reconciliation');
const { hash, originHash, error, safeData } = require('./binding-contract');

const FORMAT = 'magento-prior-exposure-bulk-v1';
const MAX_PRODUCTS = 5000;
const PLAN_STATUSES = ['eligible', 'skipped', 'conflicted', 'failed'];
const OUTCOMES = ['succeeded', 'skipped', 'conflicted', 'failed', 'pending'];
const invalid = () => { throw error(422, 'EXPOSURE_BULK_PLAN_INVALID', 'Exact bounded exposure plan required'); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const skuValid = s => typeof s === 'string' && s.trim() === s && s.length > 0 && s.length <= 256 && !/[\u0000-\u001f\u007f]/.test(s);
function safeCode(cause) {
  return /^(EXPOSURE|MAGENTO|REPAIR|ADMIN|EXPORT|LIFECYCLE)_[A-Z_]+$/.test(cause?.code || '') ? cause.code : 'EXPOSURE_PRODUCT_FAILED';
}
function failure(cause) {
  const code = safeCode(cause);
  const conflicted = ['EXPOSURE_RECONCILIATION_CONFLICT', 'EXPOSURE_PRODUCT_NOT_UNIQUE', 'EXPOSURE_REMOTE_CHANGED',
    'REPAIR_MANIFEST_STALE', 'EXPORT_CUTOVER_PREPARING', 'EXPOSURE_DATABASE_MISMATCH', 'REPAIR_DATABASE_MISMATCH'].includes(code);
  return { status: conflicted ? 'conflicted' : 'failed', reasons: [code] };
}
function counts(entries, statuses) {
  return Object.fromEntries(statuses.map(s => [s, entries.filter(e => e.status === s).length]));
}
function uniqueScope(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_PRODUCTS
    || entries.some(e => !positive(e.productId) || !positive(e.magentoProductId) || !skuValid(e.sku))
    || ['productId', 'sku', 'magentoProductId'].some(k => new Set(entries.map(e => e[k])).size !== entries.length)) invalid();
}
function candidates(source, config, database) {
  safeData(source, [], 64 * 1024 * 1024);
  if (source.database !== database || source.originHash !== originHash(config.baseUrl)
    || !Array.isArray(source.candidates) || source.count !== source.candidates.length) invalid();
  const scope = source.candidates.map(c => ({ productId: c.amberProductId, sku: c.sku, magentoProductId: c.magentoProductId }));
  uniqueScope(scope);
  return scope.sort((a, b) => a.productId - b.productId);
}
async function preview(config, source, options) {
  const scope = candidates(source, config, options.expectedDatabase);
  const entries = new Array(scope.length); let next = 0;
  // Fixed bounded GET concurrency. Every child preview uses a read-only snapshot.
  await Promise.all(Array.from({ length: Math.min(4, scope.length) }, async () => {
    for (;;) {
      const i = next++; if (i >= scope.length) return;
      const candidate = scope[i];
      if (options.signal?.aborted) { entries[i] = { ...candidate, status: 'failed', reasons: ['EXPOSURE_INTERRUPTED'] }; continue; }
      try {
        const plan = await single.preview(config, candidate.sku, options);
        let status = plan.eligible ? 'eligible' : plan.remote.status === 'lookup_error' ? 'failed' : 'skipped';
        let reasons = plan.blockers;
        if (plan.productId !== candidate.productId || (plan.remote.status === 'found' && plan.remote.id !== candidate.magentoProductId)) {
          status = 'conflicted'; reasons = ['EXPOSURE_CANDIDATE_IDENTITY_CHANGED'];
        }
        entries[i] = { ...candidate, status, reasons, plan };
      } catch (cause) { entries[i] = { ...candidate, ...failure(cause) }; }
    }
  }));
  // Detect local changes during the bounded remote scan before sealing the plan.
  for (const entry of entries.filter(e => e.status === 'eligible')) {
    if (options.signal?.aborted) throw error(409, 'EXPOSURE_INTERRUPTED', 'Exposure planning interrupted');
    try {
      const { state } = await single.snapshot(options.databasePool, options.expectedDatabase, entry.sku);
      if (hash(state) !== entry.plan.beforeFingerprint || single.blockers(state).length) {
        entry.status = 'conflicted'; entry.reasons = ['EXPOSURE_RECONCILIATION_CONFLICT'];
      }
    } catch (cause) { Object.assign(entry, failure(cause)); }
  }
  const body = { format: FORMAT, database: options.expectedDatabase, originHash: originHash(config.baseUrl),
    sourceHash: hash(source), generatedAt: new Date().toISOString(), entries, summary: counts(entries, PLAN_STATUSES) };
  safeData(body, options.sensitiveValues, 64 * 1024 * 1024);
  return { ...body, planHash: hash(body) };
}
function verify(plan, expectedHash, config, database) {
  safeData(plan, [], 64 * 1024 * 1024);
  const { planHash, ...body } = plan;
  if (!/^[a-f0-9]{64}$/.test(expectedHash || '') || planHash !== expectedHash || hash(body) !== expectedHash
    || plan.format !== FORMAT || plan.database !== database || plan.originHash !== originHash(config.baseUrl)) invalid();
  uniqueScope(plan.entries);
  if (hash(plan.summary) !== hash(counts(plan.entries, PLAN_STATUSES))) invalid();
  for (const entry of plan.entries) {
    if (!PLAN_STATUSES.includes(entry.status) || !Array.isArray(entry.reasons)) invalid();
    if (entry.status !== 'eligible') continue;
    single.verify(entry.plan, entry.plan?.planHash, config, database);
    if (entry.reasons.length || entry.plan.productId !== entry.productId || entry.plan.sku !== entry.sku
      || entry.plan.remote.id !== entry.magentoProductId) invalid();
  }
}
function summary(plan, outcomes, complete = false, stoppedReason = null) {
  const pending = plan.entries.filter(e => !outcomes.some(o => o.productId === e.productId)).map(e => e.productId);
  const ids = Object.fromEntries(OUTCOMES.map(s => [s, s === 'pending' ? pending : outcomes.filter(o => o.status === s).map(o => o.productId)]));
  return { format: 'magento-prior-exposure-bulk-receipt-v1', database: plan.database, originHash: plan.originHash,
    planHash: plan.planHash, updatedAt: new Date().toISOString(), total: plan.entries.length, complete, stoppedReason,
    counts: Object.fromEntries(OUTCOMES.map(s => [s, ids[s].length])), ids, outcomes };
}
async function apply(config, plan, expectedHash, options) {
  verify(plan, expectedHash, config, options.expectedDatabase);
  if (typeof options.checkpoint !== 'function') invalid();
  const outcomes = [];
  // The initial durable pending receipt must succeed before any product mutation.
  let receipt = summary(plan, outcomes);
  await options.checkpoint(receipt);
  for (const entry of plan.entries) {
    if (options.signal?.aborted) {
      receipt = summary(plan, outcomes, false, 'EXPOSURE_INTERRUPTED');
      await options.checkpoint(receipt); return receipt;
    }
    let outcome;
    if (entry.status !== 'eligible') outcome = { status: entry.status, reasons: entry.reasons };
    else {
      try {
        // The single-product implementation owns authority, CAS, live GET and
        // atomic mutation/audit. Its immutable receipt is the resume authority.
        const result = await single.apply(config, entry.plan, entry.plan.planHash, options);
        outcome = { status: result.alreadyApplied ? 'skipped' : 'succeeded',
          reasons: result.alreadyApplied ? ['ALREADY_APPLIED'] : [], result };
      } catch (cause) { outcome = failure(cause); }
    }
    outcomes.push({ productId: entry.productId, sku: entry.sku, ...outcome });
    const fatal = outcome.reasons.find(code => ['ADMIN_PERMISSION_REVOKED', 'REPAIR_DATABASE_MISMATCH',
      'EXPOSURE_DATABASE_MISMATCH', 'EXPORT_CUTOVER_PREPARING', 'LIFECYCLE_WRITER_UNSUPPORTED', 'EXPOSURE_INTERRUPTED'].includes(code));
    receipt = summary(plan, outcomes, outcomes.length === plan.entries.length, fatal || null);
    // A receipt I/O failure stops immediately. Never catch it as another row's
    // outcome. A committed-but-unrecorded row is recovered via its audit on retry.
    await options.checkpoint(receipt);
    if (fatal) return receipt;
  }
  return receipt;
}
module.exports = { preview, verify, apply, candidates, summary, MAX_PRODUCTS };
