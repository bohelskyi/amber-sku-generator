const c = require('./binding-contract');
const { createMagentoClient } = require('./client');
const { setVisibility } = require('./product-visibility-transport');
const state = require('../product-lifecycle-state');
const lifecycle = require('../product-lifecycle.service');
const { runAccessAdminMutation, assertActorStillAuthorized } = require('../access-admin-transaction');
const { writeAuditEvent } = require('../../audit/audit-events');

const safeCode = (cause) => /^(PRODUCT|PHOTO|MAGENTO|ADMIN|EXPORT|LIFECYCLE)_[A-Z_]+$/.test(cause.code || '') ? cause.code : 'PRODUCT_VISIBILITY_FAILED';
function matches(intent, raw) {
  return raw != null && raw.sku === intent.public_sku && Number(raw.id) === Number(intent.remote_product_id)
    && Number(raw.status) === intent.target_status;
}
async function remote(config, intent, options) {
  try { return await createMagentoClient(config, { fetchImpl: options.fetchImpl }).findProductBySku(intent.public_sku); }
  catch (cause) { if (cause.code === 'MAGENTO_PRODUCT_NOT_FOUND') return null; throw cause; }
}
async function locks(db, config, intent, operation) {
  const lane = await db.connect(), held = [];
  try {
    if (intent.origin_hash !== c.originHash(config.baseUrl)) state.fail('PRODUCT_VISIBILITY_ORIGIN_CHANGED');
    for (const key of [`amber_magento_public_identity:${intent.public_product_identity_id}`,
      `amber_magento_sync:${intent.origin_hash}:${intent.public_sku}`]) {
      if (!(await lane.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [key])).rows[0].held) return { busy: true };
      held.push(key);
    }
    return await operation();
  } finally {
    for (const key of held.reverse()) await lane.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {});
    lane.release();
  }
}
async function cancelUndispatchedNative(client, intent, mutationContext) {
  const canceled = (await client.query(`UPDATE magento_sync_jobs j SET state='superseded',updated_at=CURRENT_TIMESTAMP
    WHERE j.product_id=$1 AND j.public_product_identity_id=$2 AND j.origin_hash=$3 AND j.sku=$4
      AND j.automatic_generation IS NOT NULL AND j.state IN ('queued','running','retryable','blocked')
      AND NOT EXISTS(SELECT 1 FROM magento_sync_steps s WHERE s.job_id=j.id) RETURNING j.id`,
  [intent.product_id, intent.public_product_identity_id, intent.origin_hash, intent.public_sku])).rows;
  if (canceled.length) {
    await client.query(`UPDATE magento_product_sync_requests SET active_job_id=NULL,active_generation=NULL,
      state='needs_attention',reason_code='product_retired',updated_at=CURRENT_TIMESTAMP
      WHERE public_product_identity_id=$2 AND product_id=$3 AND active_job_id=ANY($1::text[])`,
    [canceled.map((row) => row.id), intent.public_product_identity_id, intent.product_id]);
    for (const row of canceled) await writeAuditEvent(client, { mutationContext, eventKey: 'magento_sync.superseded',
      subjectType: 'magento_sync_job', subjectId: row.id, details: { reason: 'product_archived', visibilityIntentId: intent.id } });
  }
  return (await client.query(`SELECT 1 FROM magento_sync_jobs WHERE public_product_identity_id=$1 AND origin_hash=$2
    AND state NOT IN ('succeeded','superseded') LIMIT 1`, [intent.public_product_identity_id, intent.origin_hash])).rowCount > 0;
}
async function verifyLocal(client, config, intent, { photoProof, canEnable, mutationContext } = {}) {
  const activation = await lifecycle.deliveryGate(client, config, intent.origin_hash);
  if (!activation || activation.installation_key !== intent.installation_key) state.fail('PRODUCT_AUTOMATIC_DELIVERY_REQUIRED');
  await assertActorStillAuthorized(client, Number(activation.actor_user_id), 'export_templates.publish', c.error);
  const current = await state.readTarget(client, intent.product_id, { origin: intent.origin_hash, lock: true });
  require('../product/test-products').assertDisabled(current.product, null, intent.target_status === 1);
  if (current.facts.testDeletion || current.facts.activeSuccessor || current.facts.newerRevision
    || current.product.corrected_to_product_id != null || current.facts.correctionSource) state.fail('PRODUCT_RETIRED_ANCESTOR');
  if (state.fingerprint(current.product, current.lifecycle) !== intent.local_fingerprint) state.fail('PRODUCT_VISIBILITY_LOCAL_CHANGED');
  if (Number(current.facts.confirmedRemoteId) !== Number(intent.remote_product_id)) state.fail('PRODUCT_REMOTE_IDENTITY_CHANGED');
  if (intent.kind === 'hide') {
    if (current.product.status !== 'archived' || current.lifecycle?.route !== 'retired') state.fail('PRODUCT_NOT_ARCHIVED');
    if (current.facts.unresolvedStep) state.fail('PRODUCT_SYNC_RECONCILIATION_REQUIRED');
    if (current.facts.unfinishedJob && await cancelUndispatchedNative(client, intent, mutationContext)) state.fail('PRODUCT_SYNC_RECONCILIATION_REQUIRED');
  } else {
    if (current.product.status !== 'active' || !['normal', 'replacement'].includes(current.lifecycle?.route)) state.fail('PRODUCT_NOT_CURRENT');
    if (current.facts.unfinishedJob || current.facts.unresolvedStep) return { waiting: true, reasonCode: 'PRODUCT_NATIVE_SYNC_PENDING' };
    const request = (await client.query(`SELECT product_id,desired_generation,synced_generation,state FROM magento_product_sync_requests
      WHERE public_product_identity_id=$1`, [intent.public_product_identity_id])).rows[0];
    if (String(request?.desired_generation) !== String(intent.expected_generation)) state.fail('PRODUCT_VISIBILITY_GENERATION_CHANGED');
    if (request.state !== 'synced' || String(request.synced_generation) !== String(intent.expected_generation)
      || Number(request.product_id) !== Number(intent.product_id)) return { waiting: true, reasonCode: 'PRODUCT_NATIVE_SYNC_PENDING' };
    const confirmed = (await client.query(`SELECT 1 FROM magento_sync_jobs WHERE product_id=$1 AND public_product_identity_id=$2
      AND origin_hash=$3 AND automatic_generation=$4 AND state='succeeded' AND acknowledged_at IS NOT NULL`,
    [intent.product_id, intent.public_product_identity_id, intent.origin_hash, intent.expected_generation])).rowCount;
    if (!confirmed) return { waiting: true, reasonCode: 'PRODUCT_NATIVE_SYNC_PENDING' };
    if (photoProof && intent.target_status === 1) {
      // Photos own the enabling contract. This hook is injected by the matched
      // media runtime; absence cannot silently enable a hidden product.
      const localProof = await canEnable?.(client, intent.product_id);
      const { verifiedAt: ignored, ...sealed } = photoProof; void ignored;
      if (!localProof || c.hash(localProof) !== c.hash(sealed)
        || Number(localProof.remoteProductId) !== Number(intent.remote_product_id)
        || String(localProof.nativeGeneration) !== String(intent.expected_generation)) state.fail('PRODUCT_VISIBILITY_PHOTOS_REQUIRED');
    }
  }
  return { waiting: false };
}
async function change(db, config, intent, mutationContext, operation) {
  return runAccessAdminMutation({ databasePool: db, actorUserId: Number(mutationContext.actorUserId),
    requiredPermission: 'products.archive', createError: c.error, operation: async (client) => {
      const current = (await client.query('SELECT * FROM product_visibility_intents WHERE id=$1 FOR UPDATE', [intent.id])).rows[0];
      if (!current || current.origin_hash !== intent.origin_hash) state.fail('PRODUCT_VISIBILITY_NOT_FOUND');
      return operation(client, current);
    } });
}
async function acknowledge(client, intent, mutationContext) {
  if (intent.state === 'verified') return intent;
  const result = (await client.query(`UPDATE product_visibility_intents SET state='verified',reason_code=NULL,
    verified_at=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *`, [intent.id])).rows[0];
  await writeAuditEvent(client, { mutationContext, eventKey: 'product.visibility_verified', subjectType: 'product',
    subjectId: intent.product_id, details: { intentId: intent.id, kind: intent.kind, targetStatus: intent.target_status,
      remoteProductId: String(intent.remote_product_id) } });
  return result;
}
async function photoChecks(config, intent, options) {
  if (intent.kind !== 'restore' || intent.target_status !== 1) return {};
  const canEnable = options.canEnable || ((client, productId) => require('./product-media-delivery').assertCanEnableVisibility(client, productId));
  const verifyPhotos = options.verifyPhotoSet || require('./product-media-delivery').verifyCurrentPhotoSet;
  const photoProof = await verifyPhotos(config, intent.product_id, { databasePool: options.databasePool, fetchImpl: options.fetchImpl });
  if (!photoProof || Number(photoProof.remoteProductId) !== Number(intent.remote_product_id)
    || String(photoProof.nativeGeneration) !== String(intent.expected_generation)) state.fail('PRODUCT_VISIBILITY_PHOTOS_REQUIRED');
  return { photoProof, canEnable };
}

async function runIntent(config, id, options = {}) {
  const db = options.databasePool;
  const intent = (await db.query('SELECT * FROM product_visibility_intents WHERE id=$1', [id])).rows[0];
  if (!intent || intent.state !== 'queued') return intent;
  const mutationContext = { actorUserId: Number(intent.actor_user_id), requestId: `product-visibility-${intent.id}` };
  return locks(db, config, intent, async () => {
    let dispatched = false;
    try {
      const ready = await change(db, config, intent, mutationContext, (client, current) =>
        verifyLocal(client, config, current, { mutationContext }));
      if (ready.waiting) return { ...intent, waiting: ready.reasonCode };
      const raw = await remote(config, intent, options);
      if (!raw || raw.sku !== intent.public_sku || Number(raw.id) !== Number(intent.remote_product_id)) state.fail('PRODUCT_REMOTE_IDENTITY_CHANGED');
      if (![1, 2].includes(Number(raw.status))) state.fail('PRODUCT_VISIBILITY_STATUS_UNSUPPORTED');
      if (intent.kind === 'restore' && Number(raw.status) !== 2 && Number(raw.status) !== intent.target_status) state.fail('PRODUCT_VISIBILITY_REMOTE_CHANGED');
      const photos = await photoChecks(config, intent, options);
      const prepared = await change(db, config, intent, mutationContext, async (client, current) => {
        if (current.state !== 'queued') return { waiting: true };
        const ready = await verifyLocal(client, config, current, { ...photos, mutationContext });
        if (ready.waiting) return ready;
        if (current.kind === 'hide' && current.previous_remote_status == null) await client.query(`UPDATE product_visibility_intents
          SET previous_remote_status=$2 WHERE id=$1`, [id, Number(raw.status)]);
        if (matches(intent, raw)) {
          await acknowledge(client, current, mutationContext); return { alreadyVerified: true };
        }
        await client.query(`UPDATE product_visibility_intents SET state='dispatched',dispatched_at=CURRENT_TIMESTAMP,reason_code=NULL WHERE id=$1`, [id]);
        await writeAuditEvent(client, { mutationContext, eventKey: 'product.visibility_dispatched', subjectType: 'product',
          subjectId: intent.product_id, details: { intentId: id, kind: intent.kind, targetStatus: intent.target_status } });
        return { dispatched: true };
      });
      if (prepared.waiting || prepared.alreadyVerified) return (await db.query('SELECT * FROM product_visibility_intents WHERE id=$1', [id])).rows[0];
      dispatched = true;
      try { await (options.setVisibility || setVisibility)(config, { sku: intent.public_sku, status: intent.target_status },
        { apply: true, fetchImpl: options.fetchImpl }); } catch { /* A dispatch marker is never reset or resent. */ }
      const after = await remote(config, intent, options);
      if (!matches(intent, after)) state.fail('PRODUCT_VISIBILITY_UNCERTAIN');
      return await change(db, config, intent, mutationContext, async (client, current) => {
        const ready = await verifyLocal(client, config, current, { ...photos, mutationContext });
        if (ready.waiting) state.fail('PRODUCT_NATIVE_SYNC_PENDING');
        return acknowledge(client, current, mutationContext);
      });
    } catch (cause) {
      const current = (await db.query('SELECT * FROM product_visibility_intents WHERE id=$1', [id])).rows[0];
      if (current?.state === 'verified') return current;
      // Safe operational failure classification cannot send or reset a step,
      // including when the initiating actor's capability has been revoked.
      await db.query(`UPDATE product_visibility_intents SET state=CASE WHEN dispatched_at IS NULL THEN 'blocked' ELSE 'dispatched' END,
        reason_code=$2 WHERE id=$1 AND state IN ('queued','dispatched')`, [id, safeCode(cause)]).catch(() => {});
      options.logger?.warn?.('product.visibility.failed', { intentId: id, code: safeCode(cause), dispatched });
      return (await db.query('SELECT * FROM product_visibility_intents WHERE id=$1', [id])).rows[0];
    }
  });
}
async function processPending(config, options) {
  const db = options.databasePool;
  if (!config.configured || !await lifecycle.deliveryGate(db, config, c.originHash(config.baseUrl))) return;
  const rows = (await db.query(`SELECT id FROM product_visibility_intents WHERE state='queued' AND origin_hash=$1
    ORDER BY last_checked_at NULLS FIRST,created_at,id LIMIT 2`, [c.originHash(config.baseUrl)])).rows;
  for (const row of rows) {
    if (options.stopping?.()) break;
    await db.query("UPDATE product_visibility_intents SET last_checked_at=CURRENT_TIMESTAMP WHERE id=$1 AND state='queued'", [row.id]);
    await runIntent(config, row.id, options);
  }
}

async function inspect(config, id, options) {
  const db = options.databasePool;
  const intent = (await db.query('SELECT * FROM product_visibility_intents WHERE id=$1', [id])).rows[0];
  if (!intent) state.fail('PRODUCT_VISIBILITY_NOT_FOUND');
  return locks(db, config, intent, async () => {
    const raw = await remote(config, intent, options);
    const observation = { remoteId: raw?.id || null, sku: raw?.sku || null, status: raw?.status ?? null };
    return { intentId: id, article: intent.public_sku, expectedMagentoId: intent.remote_product_id,
      observedMagentoId: observation.remoteId, observedStatus: observation.status, targetStatus: intent.target_status,
      state: intent.state, canConfirm: ['blocked','dispatched'].includes(intent.state) && matches(intent, raw),
      reviewHash: c.hash({ intent, observation }) };
  });
}
async function reconcile(config, input, options) {
  c.command(input, ['intentId', 'reviewHash', 'confirmVerifiedResult']);
  if (input.confirmVerifiedResult !== true || !/^[a-f0-9]{64}$/.test(input.reviewHash)) state.fail('PRODUCT_VISIBILITY_CONFIRMATION_REQUIRED');
  const db = options.databasePool;
  const intent = (await db.query('SELECT * FROM product_visibility_intents WHERE id=$1', [input.intentId])).rows[0];
  if (!intent) state.fail('PRODUCT_VISIBILITY_NOT_FOUND');
  if (intent.state === 'verified') return change(db, config, intent, options.mutationContext,
    (_client, current) => lifecycle.receipt(current));
  return locks(db, config, intent, async () => {
    const raw = await remote(config, intent, options);
    const observation = { remoteId: raw?.id || null, sku: raw?.sku || null, status: raw?.status ?? null };
    if (c.hash({ intent, observation }) !== input.reviewHash || !['blocked','dispatched'].includes(intent.state) || !matches(intent, raw)) {
      state.fail('PRODUCT_VISIBILITY_REVIEW_STALE');
    }
    const photos = await photoChecks(config, intent, options);
    return change(db, config, intent, options.mutationContext, async (client, current) => {
      if (c.hash(current) !== c.hash(intent)) state.fail('PRODUCT_VISIBILITY_REVIEW_STALE');
      const ready = await verifyLocal(client, config, current, { ...photos, mutationContext: options.mutationContext });
      if (ready.waiting) state.fail('PRODUCT_NATIVE_SYNC_PENDING');
      return lifecycle.receipt(await acknowledge(client, current, options.mutationContext));
    });
  });
}
module.exports = { matches, verifyLocal, runIntent, processPending, inspect, reconcile };
