const pool = require('../../db/pool');
const c = require('./binding-contract');
const editor = require('./integration-editor.service');
const exposure = require('./exposure-reconciliation');
const stable = require('./stable-recount-exposure');
const repair = require('../recount-repair.service');
const reconciliation = require('../full-product-reconciliation.service');
const { boundedGet } = require('./integration-readiness');
const { assertActorStillAuthorized } = require('../access-admin-transaction');
const { createMutationContext } = require('../../audit/mutation-context');

const KINDS = ['prior_exposure', 'stable_recount_exposure', 'replacement', 'unexposed_first_delivery', 'generated_first_delivery', 'release_exclusion'];
const FORMAT = 'magento-lifecycle-recovery-v1';
const fail = (code = 'MAGENTO_LIFECYCLE_REVIEW_STALE') => { throw c.error(409, code, 'Повторіть перевірку історії доставки цього товару.'); };
async function nextResync(client, config, id) {
  const binding = await editor.selected(client, config);
  return binding ? { kind: 'reviewed_resync', productId: id, bindingRevisionId: binding.id, expectedRevision: binding.revision,
    administratorOnly: true, requiredPermissions: ['export_templates.manage', 'export_templates.publish', 'exports.view'] }
    : { kind: 'configuration_required', productId: id };
}
async function setup(options) {
  const databasePool = options.databasePool || pool;
  const expectedDatabase = (await databasePool.query('SELECT current_database() name')).rows[0].name;
  return { ...options, databasePool, expectedDatabase, fetchImpl: boundedGet(options.fetchImpl) };
}
async function product(client, id) {
  if (!Number.isSafeInteger(id) || id <= 0) c.invalid();
  const row = (await client.query(`SELECT p.id,p.full_sku,p.status,p.corrected_from_product_id,p.public_product_identity_id,
    i.public_sku,CASE WHEN f.product_id IS NULL THEN NULL ELSE to_jsonb(f) ||
      jsonb_build_object('delivery_version',f.delivery_version::text) END AS lifecycle
    FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
    LEFT JOIN product_full_export_state f ON f.product_id=p.id WHERE p.id=$1`, [id])).rows[0];
  if (!row) throw c.error(404, 'PRODUCT_NOT_FOUND', 'Товар не знайдено.');
  return row;
}
function requirements(entry, kind) {
  const exact = [...entry.generatedMemberships, ...entry.confirmedMemberships];
  return {
    oldSkus: [...new Set([...entry.ancestorChain.map((a) => a.sku), ...exact.map((m) => m.sku)])].sort(),
    files: [...new Set(exact.map((m) => m.snapshotId))].sort(),
    externalHistory: entry.exposure.classification === 'historical_ambiguous',
    exclusionResolution: kind === 'unexposed_first_delivery' || ['unknown', 'independent_exclusion'].includes(entry.independentExclusion.provenance),
    exclusionDisposition: kind === 'unexposed_first_delivery' && entry.lifecycle.business_exclusion_state !== 'excluded' ? 'recount_only_attested' : 'release',
    redeliveryEvidence: kind === 'generated_first_delivery',
  };
}
function actionBlockers(entry, kind) {
  const out = [];
  if (entry.status !== 'active' || entry.lifecycle.route !== 'hold'
    || c.hash(entry.terminalDescendants) !== c.hash([entry.productId]) || entry.exposure.issues.length) out.push('LIFECYCLE_NOT_HELD_TERMINAL');
  if (kind !== 'generated_first_delivery' && !entry.correctionId) out.push('LIFECYCLE_SUCCESSOR_REQUIRED');
  if (kind === 'unexposed_first_delivery' && entry.exposure.classification !== 'reliably_unexposed') out.push('LIFECYCLE_UNEXPOSED_EVIDENCE_REQUIRED');
  if (kind === 'generated_first_delivery' && (entry.correctionId || entry.ancestorChain.length
    || !['generated_exact', 'confirmed_exact'].includes(entry.exposure.classification))) out.push('LIFECYCLE_RETAINED_FILE_EVIDENCE_REQUIRED');
  return out;
}
async function preview(config, id, input, options = {}) {
  c.command(input, ['kind']); if (!KINDS.includes(input.kind)) c.invalid();
  options = await setup(options);
  const p = await editor.read(options, async (client) => {
    await assertActorStillAuthorized(client, createMutationContext(options.mutationContext).actorUserId, 'exports.reconcile', c.error, { readOnly: true });
    return product(client, id);
  });
  let payload; let blockers = []; let requiredEvidence = null;
  if (input.kind === 'prior_exposure') {
    payload = await exposure.preview(config, p.public_sku, options); blockers = payload.blockers;
  } else if (input.kind === 'stable_recount_exposure') {
    const binding = await editor.read(options, (client) => editor.selected(client, config));
    if (!binding) fail('MAGENTO_BINDING_REQUIRED');
    payload = await stable.preview(config, p.public_sku, { ...options, bindingRevisionId: binding.id }); blockers = payload.blockers;
  } else if (input.kind === 'release_exclusion') {
    payload = { productId: id, deliveryVersion: String(p.lifecycle?.delivery_version),
      businessExclusion: p.lifecycle?.business_exclusion_state, route: p.lifecycle?.route };
    if (!p.lifecycle || p.lifecycle.route === 'retired' || p.lifecycle.business_exclusion_state === 'none') blockers = ['LIFECYCLE_EXCLUSION_NOT_PRESENT'];
  } else {
    const manifest = await repair.dryRunRepair(options.databasePool, options);
    const entry = manifest.repairEntries.find((e) => e.productId === id);
    if (!entry) fail('LIFECYCLE_EVIDENCE_UNAVAILABLE');
    payload = { successorId: id, beforeFingerprint: entry.beforeFingerprint,
      deliveryVersion: String(entry.lifecycle.delivery_version), ancestorSkus: entry.ancestorChain.map((a) => a.sku).sort() };
    requiredEvidence = requirements(entry, input.kind); blockers = actionBlockers(entry, input.kind);
    const delivery = (await options.databasePool.query('SELECT legacy_product_csv_enabled FROM magento_auto_sync_activation WHERE singleton')).rows[0];
    if (delivery?.legacy_product_csv_enabled === false) blockers.push('LIFECYCLE_LEGACY_DELIVERY_RETIRED');
    const activation = await require('../full-product-cutover-gate').readGate(options.databasePool);
    if (activation.phase !== 'active') blockers.push('LIFECYCLE_ACTIVATION_REQUIRED');
  }
  const nextAction = input.kind === 'release_exclusion' && p.lifecycle?.route === 'hold' && p.lifecycle.hold_reason !== 'prior_exposure'
    ? { kind: 'review_history', productId: id }
    : input.kind === 'prior_exposure' || input.kind === 'release_exclusion'
      ? await editor.read(options, (client) => nextResync(client, config, id)) : null;
  const review = { format: FORMAT, kind: input.kind, productId: id, article: p.public_sku,
    payload, requiredEvidence, blockers, nextAction };
  c.safeData(review);
  return { review, reviewHash: c.hash(review), eligible: blockers.length === 0, blockers, requiredEvidence };
}
async function withLocalSafety(config, p, options, operation) {
  const client = await options.databasePool.connect(); const locks = [];
  try {
    for (const key of [`amber_magento_public_identity:${p.public_product_identity_id}`,
      `amber_magento_sync:${c.originHash(config.baseUrl)}:${p.public_sku}`]) {
      if (!(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) held', [key])).rows[0].held) fail('MAGENTO_SYNC_BUSY');
      locks.push(key);
    }
    if ((await client.query(`SELECT 1 FROM magento_sync_jobs j WHERE public_product_identity_id=$1
      AND state NOT IN ('succeeded','superseded') AND (state='uncertain' OR EXISTS(
        SELECT 1 FROM magento_sync_steps s WHERE s.job_id=j.id)) LIMIT 1`, [p.public_product_identity_id])).rowCount) {
      fail('MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED');
    }
    if ((await client.query('SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=$1', [p.public_product_identity_id])).rowCount) fail('MAGENTO_SYNC_TEST_DELETION');
    return await operation();
  } finally {
    for (const key of locks.reverse()) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    client.release();
  }
}
async function apply(config, id, input, options = {}) {
  c.command(input, ['review', 'reviewHash', 'reason'], ['evidence']);
  if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 2000) c.invalid();
  c.safeData(input.review);
  const review = input.review;
  c.command(review, ['format', 'kind', 'productId', 'article', 'payload', 'requiredEvidence', 'blockers', 'nextAction']);
  if (!review.payload || typeof review.payload !== 'object' || Array.isArray(review.payload) || !Array.isArray(review.blockers)) c.invalid();
  if (review.format !== FORMAT || review.productId !== id || c.hash(review) !== input.reviewHash
    || !KINDS.includes(review.kind) || review.blockers.length) fail();
  if ((review.payload.productId ?? review.payload.successorId) !== id) fail();
  options = await setup(options);
  const p = await editor.read(options, (client) => product(client, id));
  if (p.public_sku !== review.article) fail();
  if (review.kind === 'stable_recount_exposure') {
    const result = await stable.apply(config, review.payload, review.payload.planHash, { ...options, bindingRevisionId: review.payload.bindingRevisionId });
    return { ...result, nextAction: { kind: 'await_delivery', handoffId: result.handoffId } };
  }
  return withLocalSafety(config, p, options, async () => {
    if (review.kind === 'prior_exposure') return { ...await exposure.apply(config, review.payload, review.payload.planHash, options), nextAction: review.nextAction };
    const resolutionKey = `manager-recovery:${input.reviewHash}`;
    if (review.kind === 'release_exclusion') return { ...await reconciliation.setBusinessExclusion({ productId: id,
      deliveryVersion: review.payload.deliveryVersion, excluded: false, reason: input.reason, resolutionKey }, options), nextAction: review.nextAction };
    const evidence = input.evidence || {};
    c.command(evidence, ['oldSkus', 'files'], ['externalHistory', 'exclusionResolution', 'redeliveryAuthorization']);
    return reconciliation.reconcileFullProduct({ ...review.payload, ...evidence, action: review.kind, reason: input.reason, resolutionKey },
      { ...options, requireLegacyDelivery: true });
  });
}
async function productRecovery(config, id, options = {}) {
  return editor.read(options, async (client) => {
    const p = await product(client, id);
    const row = config.configured ? (await client.query(`SELECT * FROM magento_sync_jobs WHERE public_product_identity_id=$1 AND origin_hash=$2
      ORDER BY CASE WHEN state NOT IN ('succeeded','superseded') THEN 0 ELSE 1 END,created_at DESC LIMIT 1`,
    [p.public_product_identity_id, c.originHash(config.baseUrl)])).rows[0] : null;
    const steps = row ? (await client.query('SELECT * FROM magento_sync_steps WHERE job_id=$1 ORDER BY ordinal', [row.id])).rows : [];
    const delivery = (await client.query('SELECT legacy_product_csv_enabled FROM magento_auto_sync_activation WHERE singleton')).rows[0];
    const request = (await client.query('SELECT active_job_id,reason_code,state FROM magento_product_sync_requests WHERE public_product_identity_id=$1',
      [p.public_product_identity_id])).rows[0];
    const protectedWork = request?.reason_code === 'reconciliation_required' || request?.active_job_id != null || request?.state === 'syncing'
      || (row && !['succeeded', 'superseded'].includes(row.state) && (row.state === 'uncertain' || steps.length > 0));
    const history = p.lifecycle?.route === 'hold' && p.lifecycle.hold_reason === 'historical_ambiguity'
      ? await require('./recovery-history').read(client, id) : null;
    const availableKinds = [];
    if (!protectedWork && p.lifecycle && p.lifecycle.route !== 'retired') {
      if (p.lifecycle.business_exclusion_state !== 'none') availableKinds.push('release_exclusion');
      if (p.lifecycle.route === 'hold' && p.lifecycle.hold_reason === 'historical_ambiguity') {
        if (history?.stableRecount) availableKinds.push('stable_recount_exposure');
        else if (history?.complete && !history.hasRecount) availableKinds.push('prior_exposure');
        if (delivery?.legacy_product_csv_enabled === true) availableKinds.push('replacement', 'unexposed_first_delivery', 'generated_first_delivery');
      }
    }
    return { productId: id, article: p.public_sku, history,
      job: options.canRecoverJobs && row ? require('./sync-job-recovery').summary(row, steps) : null,
      lifecycle: p.lifecycle ? { route: p.lifecycle.route, holdReason: p.lifecycle.hold_reason,
        deliveryVersion: String(p.lifecycle.delivery_version), businessExclusion: p.lifecycle.business_exclusion_state,
        suggestedKind: availableKinds[0] || null, availableKinds, legacyDeliveryEnabled: delivery?.legacy_product_csv_enabled === true,
        blocker: protectedWork ? 'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED' : null } : null,
      nextAction: options.canReconcileLifecycle && !protectedWork && p.lifecycle?.hold_reason === 'prior_exposure'
        ? await nextResync(client, config, id) : null,
      actions: { jobRecovery: !!options.canRecoverJobs, lifecycleRecovery: !!options.canReconcileLifecycle } };
  });
}
module.exports = { KINDS, FORMAT, preview, apply, productRecovery, requirements, actionBlockers };
