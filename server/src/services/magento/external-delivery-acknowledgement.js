const gate = require('../full-product-cutover-gate');
const { repairTransaction, lockRepairProducts } = require('../recount-repair.service');
const { writeAuditEvent } = require('../../audit/audit-events');
const { hash, originHash, error, safeData } = require('./binding-contract');
const { createMagentoClient } = require('./client');

const CANDIDATE_FORMAT = 'amber-external-delivery-candidates-v1';
const PLAN_FORMAT = 'amber-external-delivery-plan-v1';
const RECEIPT_FORMAT = 'amber-external-delivery-receipt-v1';
const EVENT = 'product.external_delivery_acknowledged';
const MAX_PRODUCTS = 500;
const PLAN_STATUSES = ['eligible', 'skipped', 'conflicted', 'failed'];
const OUTCOMES = ['succeeded', 'skipped', 'conflicted', 'failed', 'pending'];

const fail = (code = 'EXTERNAL_DELIVERY_CONFLICT', message = 'External delivery acknowledgement requires fresh exact evidence') => {
  throw error(409, code, message);
};
const text = (value, max = 4000) => typeof value === 'string' && value.trim() === value
  && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const sku = (value) => text(value, 256);

function validateCandidates(source, database) {
  safeData(source, [], 16 * 1024 * 1024);
  if (source?.format !== CANDIDATE_FORMAT || source.database !== database
    || !Array.isArray(source.entries) || source.entries.length < 1 || source.entries.length > MAX_PRODUCTS) {
    fail('EXTERNAL_DELIVERY_CANDIDATES_INVALID');
  }
  const entries = source.entries.map((entry) => ({
    productId: entry.productId,
    internalSku: entry.internalSku,
    publicSku: entry.publicSku,
    ...(entry.magentoProductId == null ? {} : { magentoProductId: entry.magentoProductId }),
    resolutionKey: entry.resolutionKey,
    reason: entry.reason,
    evidence: entry.evidence,
  }));
  if (entries.some((entry) => !positive(entry.productId) || (entry.magentoProductId != null && !positive(entry.magentoProductId))
      || !sku(entry.internalSku) || !sku(entry.publicSku) || !text(entry.resolutionKey, 200)
      || !text(entry.reason) || !text(entry.evidence))
    || ['productId', 'internalSku', 'publicSku', 'resolutionKey']
      .some((key) => new Set(entries.map((entry) => entry[key])).size !== entries.length)
    || new Set(entries.filter((entry) => entry.magentoProductId != null)
      .map((entry) => entry.magentoProductId)).size !== entries.filter((entry) => entry.magentoProductId != null).length) {
    fail('EXTERNAL_DELIVERY_CANDIDATES_INVALID');
  }
  return entries.sort((a, b) => a.productId - b.productId);
}

async function readState(client, productId) {
  const result = await client.query(`SELECT
    to_jsonb(p) - 'details' || jsonb_build_object('detailsHash',encode(sha256(convert_to(p.details::text,'UTF8')),'hex')) AS product,
    to_jsonb(f) || jsonb_build_object(
      'revision',f.revision::text,'confirmed_revision',f.confirmed_revision::text,
      'cutover_baseline_revision',f.cutover_baseline_revision::text,
      'externally_delivered_revision',f.externally_delivered_revision::text,
      'csv_retired_revision',f.csv_retired_revision::text,'delivery_version',f.delivery_version::text) AS lifecycle,
    to_jsonb(i) AS public_identity,
    (SELECT to_jsonb(r) FROM sku_registry r WHERE r.full_sku=p.full_sku) AS reservation,
    (SELECT count(*)::int FROM products q WHERE q.full_sku=p.full_sku) AS internal_sku_count,
    (SELECT count(*)::int FROM products q JOIN public_product_identities qi ON qi.id=q.public_product_identity_id
      WHERE qi.public_sku=i.public_sku AND q.status='active' AND q.corrected_to_product_id IS NULL) AS current_public_sku_count,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('snapshotId',m.snapshot_id,'sku',m.sku_at_capture,
      'fullRevision',m.full_revision::text,'deliveryVersion',m.delivery_version::text,'captureKind',m.capture_kind,
      'evidenceHash',m.evidence_hash,'status',s.status) ORDER BY m.snapshot_id),'[]'::jsonb)
      FROM export_snapshot_products m JOIN export_snapshots s ON s.id=m.snapshot_id WHERE m.product_id=p.id) AS memberships,
    (SELECT to_jsonb(r) FROM product_export_revisions r WHERE r.product_id=p.id) AS price_revision,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',j.id,'state',j.state,'sku',j.sku) ORDER BY j.id),'[]'::jsonb)
      FROM magento_sync_jobs j WHERE j.product_id=p.id) AS sync_jobs,
    (SELECT to_jsonb(r) FROM magento_product_sync_requests r WHERE r.product_id=p.id) AS sync_request,
    (SELECT to_jsonb(a) FROM full_product_export_activation a WHERE singleton) AS lifecycle_gate,
    (SELECT to_jsonb(a) FROM public_sku_activation a WHERE singleton) AS public_sku_activation,
    (SELECT to_jsonb(a) FROM magento_auto_sync_activation a WHERE singleton) AS delivery_gate
    FROM products p
    JOIN public_product_identities i ON i.id=p.public_product_identity_id
    JOIN product_full_export_state f ON f.product_id=p.id
    WHERE p.id=$1`, [productId]);
  if (result.rows.length !== 1) fail('EXTERNAL_DELIVERY_PRODUCT_NOT_UNIQUE');
  return result.rows[0];
}

function blockers(state, candidate) {
  const p = state.product; const f = state.lifecycle; const out = [];
  if (p.id !== candidate.productId || p.full_sku !== candidate.internalSku
    || state.public_identity.public_sku !== candidate.publicSku) out.push('PRODUCT_IDENTITY_MISMATCH');
  if (p.status !== 'active' || p.corrected_to_product_id != null) out.push('PRODUCT_NOT_CURRENT');
  if (state.internal_sku_count !== 1 || state.current_public_sku_count !== 1
    || !state.reservation || state.reservation.first_product_id !== p.id) out.push('PRODUCT_IDENTITY_CONFLICT');
  if (!['normal', 'replacement'].includes(f.route)) out.push('ROUTE_NOT_ACKNOWLEDGEABLE');
  if (p.exclude_from_export !== 0 || f.business_exclusion_state !== 'none'
    || f.recount_compatibility_excluded) out.push('PRODUCT_EXCLUDED_OR_HELD');
  const floor = [f.confirmed_revision, f.cutover_baseline_revision,
    f.externally_delivered_revision, f.csv_retired_revision].map(BigInt).reduce((a, b) => a > b ? a : b);
  if (BigInt(f.revision) <= floor) out.push('REVISION_NOT_PENDING');
  if (state.lifecycle_gate.phase !== 'active' || Number(state.lifecycle_gate.selector_version) !== 1) out.push('LIFECYCLE_NOT_ACTIVE');
  if (state.delivery_gate.legacy_product_csv_enabled !== true || state.delivery_gate.enabled !== false
    || state.delivery_gate.cutover_at != null || state.delivery_gate.cutover_event_id != null) out.push('API_DELIVERY_CUTOVER_STATE_INVALID');
  return out;
}

async function observe(config, publicSku, options) {
  try {
    const remote = await createMagentoClient(config, { fetchImpl: options.fetchImpl }).findProductBySku(publicSku);
    if (!positive(remote.id) || remote.sku !== publicSku) fail('MAGENTO_RESPONSE_INVALID');
    return { status: 'found', id: remote.id, sku: remote.sku, observedAt: new Date().toISOString() };
  } catch (cause) {
    return { status: cause.code === 'MAGENTO_PRODUCT_NOT_FOUND' ? 'not_found' : 'lookup_error',
      code: /^MAGENTO_[A-Z_]+$/.test(cause.code || '') ? cause.code : 'MAGENTO_LOOKUP_FAILED' };
  }
}

async function snapshot(databasePool, expectedDatabase, entries) {
  const client = await databasePool.connect();
  try {
    await gate.begin(client, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const database = (await client.query('SELECT current_database() name')).rows[0].name;
    if (database !== expectedDatabase) fail('EXTERNAL_DELIVERY_DATABASE_MISMATCH');
    const states = [];
    for (const entry of entries) states.push(await readState(client, entry.productId));
    await gate.commit(client);
    return { database, states };
  } catch (cause) { await gate.rollback(client); throw cause; }
  finally { await gate.release(client); client.release(); }
}

function counts(entries, statuses) {
  return Object.fromEntries(statuses.map((status) => [status, entries.filter((entry) => entry.status === status).length]));
}

async function preview(config, source, options) {
  const candidates = validateCandidates(source, options.expectedDatabase);
  const { database, states } = await snapshot(options.databasePool, options.expectedDatabase, candidates);
  const entries = new Array(candidates.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    for (;;) {
      const index = next++; if (index >= candidates.length) return;
      const candidate = candidates[index]; const state = states[index];
      const localBlockers = blockers(state, candidate);
      const remote = await observe(config, candidate.publicSku, options);
      const reasons = [...localBlockers];
      if (remote.status !== 'found') reasons.push(remote.status === 'not_found' ? 'MAGENTO_PRODUCT_NOT_FOUND' : remote.code);
      else if ((candidate.magentoProductId != null && remote.id !== candidate.magentoProductId)
        || remote.sku !== candidate.publicSku) reasons.push('MAGENTO_IDENTITY_MISMATCH');
      const approved = { candidate, beforeFingerprint: hash(state), state, remote };
      entries[index] = { ...approved, entryHash: hash(approved), status: reasons.length ? 'skipped' : 'eligible', reasons };
    }
  }));
  const foundIds = new Map();
  for (const entry of entries.filter((item) => item.remote.status === 'found')) {
    const prior = foundIds.get(entry.remote.id);
    if (prior && prior !== entry.candidate.productId) {
      entry.status = 'conflicted'; entry.reasons.push('MAGENTO_REMOTE_IDENTITY_CONFLICT');
      const other = entries.find((item) => item.candidate.productId === prior);
      other.status = 'conflicted'; other.reasons.push('MAGENTO_REMOTE_IDENTITY_CONFLICT');
    } else foundIds.set(entry.remote.id, entry.candidate.productId);
  }
  const fresh = await snapshot(options.databasePool, options.expectedDatabase,
    entries.filter((entry) => entry.status === 'eligible').map((entry) => entry.candidate));
  let cursor = 0;
  for (const entry of entries) {
    if (entry.status !== 'eligible') continue;
    const state = fresh.states[cursor++];
    if (hash(state) !== entry.beforeFingerprint || blockers(state, entry.candidate).length) {
      entry.status = 'conflicted'; entry.reasons = ['EXTERNAL_DELIVERY_CONFLICT'];
    }
  }
  const body = { format: PLAN_FORMAT, database, originHash: originHash(config.baseUrl),
    sourceHash: hash(source), generatedAt: new Date().toISOString(), entries,
    summary: counts(entries, PLAN_STATUSES) };
  safeData(body, options.sensitiveValues, 64 * 1024 * 1024);
  return { ...body, planHash: hash(body) };
}

function verify(plan, expectedHash, config, database) {
  safeData(plan, [], 64 * 1024 * 1024);
  const { planHash, ...body } = plan || {};
  if (!/^[a-f0-9]{64}$/.test(expectedHash || '') || planHash !== expectedHash || hash(body) !== expectedHash
    || plan.format !== PLAN_FORMAT || plan.database !== database || plan.originHash !== originHash(config.baseUrl)
    || !Array.isArray(plan.entries) || plan.entries.length < 1 || plan.entries.length > MAX_PRODUCTS
    || hash(plan.summary) !== hash(counts(plan.entries, PLAN_STATUSES))) fail('EXTERNAL_DELIVERY_PLAN_INVALID');
  validateCandidates({ format: CANDIDATE_FORMAT, database,
    entries: plan.entries.map((entry) => entry.candidate) }, database);
  for (const entry of plan.entries) {
    if (!PLAN_STATUSES.includes(entry.status) || !Array.isArray(entry.reasons)) fail('EXTERNAL_DELIVERY_PLAN_INVALID');
    const approved = { candidate: entry.candidate, beforeFingerprint: entry.beforeFingerprint,
      state: entry.state, remote: entry.remote };
    if (entry.entryHash !== hash(approved)) fail('EXTERNAL_DELIVERY_PLAN_INVALID');
    if (entry.status === 'eligible' && (entry.reasons.length || entry.remote.status !== 'found'
      || (entry.candidate.magentoProductId != null && entry.remote.id !== entry.candidate.magentoProductId)
      || entry.remote.sku !== entry.candidate.publicSku)) {
      fail('EXTERNAL_DELIVERY_PLAN_INVALID');
    }
  }
}

async function applyEntry(config, plan, entry, options) {
  const key = hash({ resolutionKey: entry.candidate.resolutionKey });
  return repairTransaction(options, async (client, context) => {
    await gate.requireActive(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_external_delivery:${key}`]);
    const receipts = (await client.query(`SELECT id,details FROM audit_events
      WHERE event_key=$1 AND details->>'resolutionKey'=$2 ORDER BY id`,
    [EVENT, entry.candidate.resolutionKey])).rows;
    if (receipts.length > 1) fail('EXTERNAL_DELIVERY_KEY_CONFLICT');
    const previous = receipts[0]?.details;
    if (previous) {
      if (previous.entryHash !== entry.entryHash) fail('EXTERNAL_DELIVERY_KEY_CONFLICT');
      return { ...previous.result, alreadyApplied: true };
    }
    await lockRepairProducts(client, [entry.candidate.productId]);
    const state = await readState(client, entry.candidate.productId);
    if (hash(state) !== entry.beforeFingerprint || blockers(state, entry.candidate).length) fail();
    const remote = await observe(config, entry.candidate.publicSku, options);
    if (options.signal?.aborted) fail('EXTERNAL_DELIVERY_INTERRUPTED');
    if (remote.status !== 'found' || remote.id !== entry.remote.id
      || (entry.candidate.magentoProductId != null && remote.id !== entry.candidate.magentoProductId)
      || remote.sku !== entry.candidate.publicSku) fail('EXTERNAL_DELIVERY_REMOTE_CHANGED');
    const lifecycle = state.lifecycle;
    const projectedResult = { productId: entry.candidate.productId, internalSku: entry.candidate.internalSku,
      publicSku: entry.candidate.publicSku, fullRevision: lifecycle.revision,
      externallyDeliveredRevision: lifecycle.revision, route: 'normal',
      deliveryVersion: String(BigInt(lifecycle.delivery_version) + (lifecycle.route === 'replacement' ? 1n : 0n)),
      resolutionKey: entry.candidate.resolutionKey, planHash: plan.planHash };
    const details = { planHash: plan.planHash, entryHash: entry.entryHash,
      resolutionKey: entry.candidate.resolutionKey, reason: entry.candidate.reason,
      operatorEvidence: entry.candidate.evidence, internalSku: entry.candidate.internalSku,
      publicSku: entry.candidate.publicSku, fullRevision: lifecycle.revision,
      confirmedRevision: lifecycle.confirmed_revision, deliveryVersionBefore: lifecycle.delivery_version,
      routeBefore: lifecycle.route, remote: { originHash: plan.originHash, productId: remote.id,
        sku: remote.sku, observedAt: remote.observedAt }, externalDeliverySemantic: true,
      snapshotConfirmationClaimed: false, payloadEqualityClaimed: false, automaticSyncSuccessClaimed: false,
      snapshotEvidenceUsed: false, futureDeliveryWaived: false, result: projectedResult };
    const audit = await writeAuditEvent(client, { mutationContext: context, eventKey: EVENT,
      subjectType: 'product', subjectId: entry.candidate.productId, details });
    await client.query("SET LOCAL amber.external_delivery_acknowledgement = 'on'");
    const changed = await client.query(`UPDATE product_full_export_state SET
      externally_delivered_revision=revision,externally_delivered_event_id=$2,
      route='normal',delivery_version=delivery_version+CASE WHEN route='replacement' THEN 1 ELSE 0 END,
      updated_at=CURRENT_TIMESTAMP
      WHERE product_id=$1 AND revision=$3::bigint AND confirmed_revision=$4::bigint
        AND cutover_baseline_revision=$5::bigint AND externally_delivered_revision=$6::bigint
        AND csv_retired_revision=$7::bigint AND delivery_version=$8::bigint AND route=$9
      RETURNING revision,delivery_version,route,externally_delivered_revision,externally_delivered_event_id`,
    [entry.candidate.productId, audit.id, lifecycle.revision, lifecycle.confirmed_revision,
      lifecycle.cutover_baseline_revision, lifecycle.externally_delivered_revision,
      lifecycle.csv_retired_revision, lifecycle.delivery_version, lifecycle.route]);
    if (changed.rows.length !== 1) fail();
    const row = changed.rows[0];
    const result = { ...projectedResult, fullRevision: row.revision,
      externallyDeliveredRevision: row.externally_delivered_revision, route: row.route,
      deliveryVersion: row.delivery_version, auditEventId: Number(row.externally_delivered_event_id),
    };
    return { ...result, alreadyApplied: false };
  });
}

function failure(cause) {
  const code = /^(EXTERNAL_DELIVERY|MAGENTO|REPAIR|ADMIN|EXPORT|LIFECYCLE)_[A-Z_]+$/.test(cause?.code || '')
    ? cause.code : 'EXTERNAL_DELIVERY_PRODUCT_FAILED';
  return { status: ['EXTERNAL_DELIVERY_CONFLICT', 'EXTERNAL_DELIVERY_KEY_CONFLICT',
    'EXTERNAL_DELIVERY_REMOTE_CHANGED', 'REPAIR_MANIFEST_STALE'].includes(code) ? 'conflicted' : 'failed',
  reasons: [code] };
}

function summary(plan, outcomes, complete = false, stoppedReason = null) {
  const pending = plan.entries.filter((entry) => !outcomes.some((outcome) => outcome.productId === entry.candidate.productId))
    .map((entry) => entry.candidate.productId);
  const ids = Object.fromEntries(OUTCOMES.map((status) => [status, status === 'pending' ? pending
    : outcomes.filter((outcome) => outcome.status === status).map((outcome) => outcome.productId)]));
  return { format: RECEIPT_FORMAT, database: plan.database, originHash: plan.originHash,
    planHash: plan.planHash, updatedAt: new Date().toISOString(), total: plan.entries.length,
    complete, stoppedReason, counts: Object.fromEntries(OUTCOMES.map((status) => [status, ids[status].length])), ids, outcomes };
}

async function apply(config, plan, expectedHash, options) {
  verify(plan, expectedHash, config, options.expectedDatabase);
  if (typeof options.checkpoint !== 'function') fail('EXTERNAL_DELIVERY_PLAN_INVALID');
  const outcomes = []; let current = summary(plan, outcomes);
  await options.checkpoint(current);
  for (const entry of plan.entries) {
    if (options.signal?.aborted) {
      current = summary(plan, outcomes, false, 'EXTERNAL_DELIVERY_INTERRUPTED');
      await options.checkpoint(current); return current;
    }
    let outcome;
    if (entry.status !== 'eligible') outcome = { status: entry.status, reasons: entry.reasons };
    else {
      try {
        const result = await applyEntry(config, plan, entry, options);
        outcome = { status: result.alreadyApplied ? 'skipped' : 'succeeded',
          reasons: result.alreadyApplied ? ['ALREADY_APPLIED'] : [], result };
      } catch (cause) { outcome = failure(cause); }
    }
    outcomes.push({ productId: entry.candidate.productId, internalSku: entry.candidate.internalSku,
      publicSku: entry.candidate.publicSku, ...outcome });
    const fatal = outcome.reasons.find((code) => ['ADMIN_PERMISSION_REVOKED', 'REPAIR_DATABASE_MISMATCH',
      'EXTERNAL_DELIVERY_DATABASE_MISMATCH', 'EXPORT_CUTOVER_PREPARING', 'LIFECYCLE_WRITER_UNSUPPORTED',
      'EXTERNAL_DELIVERY_INTERRUPTED'].includes(code));
    current = summary(plan, outcomes, outcomes.length === plan.entries.length, fatal || null);
    await options.checkpoint(current);
    if (fatal) return current;
  }
  return current;
}

module.exports = { CANDIDATE_FORMAT, PLAN_FORMAT, MAX_PRODUCTS, validateCandidates, readState,
  blockers, snapshot, preview, verify, applyEntry, apply, summary };
