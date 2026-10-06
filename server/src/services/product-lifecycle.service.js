const { randomUUID } = require('node:crypto');
const c = require('./magento/binding-contract');
const state = require('./product-lifecycle-state');
const { runAccessAdminMutation, assertActorStillAuthorized } = require('./access-admin-transaction');
const { writeAuditEvent } = require('../audit/audit-events');
const gate = require('./full-product-cutover-gate');

function dependencies(options = {}) {
  const config = options.config || require('../config/env').magento;
  return { config, db: options.databasePool || require('../db/pool'), origin: config.configured
    ? c.originHash(config.baseUrl) : c.hash('magento-unconfigured') };
}
function receipt(row) {
  return { intentId: row.id, state: row.state, reasonCode: row.reason_code,
    hiddenAt: row.kind === 'hide' && row.state === 'verified' ? row.verified_at : null,
    visibilityRestoredAt: row.kind === 'restore' && row.state === 'verified' ? row.verified_at : null };
}
async function deliveryGate(client, config, origin) {
  const activation = (await client.query('SELECT * FROM magento_auto_sync_activation WHERE singleton')).rows[0];
  if (!config.configured || !activation?.enabled || activation.legacy_product_csv_enabled !== false) return null;
  const publication = (await client.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=$1
    AND origin_hash=$2 AND state='published' ORDER BY version_number DESC LIMIT 1`, [activation.installation_key, origin])).rows[0];
  return publication ? activation : null;
}

// Caller owns the ordinary archive transaction and its product/lifecycle locks.
// This hook records only the exact future deliberate action, never remote I/O.
async function queueArchivedVisibility(client, input, options = {}) {
  const { config, origin } = dependencies({ ...options, databasePool: client });
  const { product, lifecycle, facts } = await state.readTarget(client, input.productId, { origin });
  const before = state.clean(input.previousProduct || {}), previous = state.clean(input.previousLifecycle || {});
  if (Number(before.id) !== Number(product.id) || Number(previous.product_id) !== Number(product.id)) state.fail('PRODUCT_ARCHIVE_PROOF_REQUIRED');
  if (before.status === 'archived') {
    const existing = (await client.query(`SELECT * FROM product_visibility_intents WHERE product_id=$1 AND kind='hide'
      AND origin_hash=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [product.id, origin])).rows[0];
    if (!existing) return { status: 'not_applicable', intentId: null, reasonCode: 'PRODUCT_ARCHIVE_PROOF_MISSING' };
    if (existing.local_fingerprint !== state.fingerprint(product, lifecycle)) return {
      status: 'blocked', intentId: existing.id, reasonCode: 'PRODUCT_ARCHIVE_CHANGED',
    };
    return { status: existing.state === 'queued' ? 'queued' : existing.state === 'verified' ? 'not_applicable' : 'blocked',
      intentId: existing.id, reasonCode: existing.reason_code || null };
  }
  // The enclosing archive transaction rolls back its local changes on this
  // conflict. Never invalidate a media job's pinned native generation or its
  // permanent dispatch evidence, including a job with no dispatch yet.
  if (facts.unfinishedMedia) state.fail('PRODUCT_MEDIA_RECONCILIATION_REQUIRED');
  const unfinished = (await client.query(`SELECT * FROM product_visibility_intents WHERE public_product_identity_id=$1
    AND origin_hash=$2 AND state IN ('queued','dispatched') ORDER BY created_at DESC`, [product.public_product_identity_id, origin])).rows;
  if (unfinished.some((intent) => intent.state === 'dispatched')) {
    state.fail('PRODUCT_VISIBILITY_RECONCILIATION_REQUIRED', 'Попередню зміну видимості ще не підтверджено. Спочатку перевірте її результат.');
  }
  for (const intent of unfinished) await client.query(`UPDATE product_visibility_intents SET state='superseded',
    reason_code='PRODUCT_NEWER_ARCHIVE' WHERE id=$1`, [intent.id]);
  let reason = product.status !== 'archived' || before.status !== 'active' || product.corrected_to_product_id != null
    || facts.newerRevision || facts.activeSuccessor || facts.correctionSource ? 'PRODUCT_RETIRED_ANCESTOR'
    : facts.testDeletion ? 'PRODUCT_TEST_DELETION_FROZEN'
      : !config.configured ? 'MAGENTO_NOT_CONFIGURED'
        : facts.confirmedRemoteId == null ? 'PRODUCT_CONFIRMED_REMOTE_ID_REQUIRED'
          : !Number.isSafeInteger(Number(facts.confirmedRemoteId)) || Number(facts.confirmedRemoteId) <= 0 ? 'PRODUCT_REMOTE_IDENTITY_INVALID' : null;
  const activation = (await client.query('SELECT installation_key FROM magento_auto_sync_activation WHERE singleton')).rows[0];
  const id = randomUUID();
  const row = (await client.query(`INSERT INTO product_visibility_intents
    (id,product_id,public_product_identity_id,public_sku,origin_hash,installation_key,kind,actor_user_id,
      previous_product,previous_lifecycle,local_fingerprint,remote_product_id,target_status,state,reason_code)
    VALUES($1,$2,$3,$4,$5,$6,'hide',$7,$8::jsonb,$9::jsonb,$10,$11,2,$12,$13) RETURNING *`,
  [id, product.id, product.public_product_identity_id, product.public_sku, origin, activation?.installation_key || null,
    input.actorUserId, JSON.stringify(before), JSON.stringify(previous), state.fingerprint(product, lifecycle),
    facts.confirmedRemoteId || null, reason ? 'blocked' : 'queued', reason])).rows[0];
  await writeAuditEvent(client, { mutationContext: input.mutationContext, eventKey: 'product.visibility_requested',
    subjectType: 'product', subjectId: product.id, details: { intentId: id, kind: 'hide', state: row.state, reasonCode: reason } });
  return { status: reason ? 'blocked' : 'queued', intentId: id, reasonCode: reason };
}

async function lookup(client, skus, origin) {
  const matches = (await client.query(`SELECT p.id,p.status,p.corrected_to_product_id,p.public_product_identity_id,
    p.full_sku,i.public_sku FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
    WHERE upper(i.public_sku)=ANY($1::text[]) OR upper(p.full_sku)=ANY($1::text[]) ORDER BY p.id`, [skus])).rows;
  const targets = [];
  for (const inputSku of skus) {
    const publicMatches = matches.filter((p) => p.public_sku.toUpperCase() === inputSku);
    const rows = publicMatches.length ? publicMatches : matches.filter((p) => p.full_sku?.toUpperCase() === inputSku);
    if (!rows.length) { targets.push({ inputSku, disposition: 'skipped', reasonCode: 'PRODUCT_RESTORE_NOT_FOUND' }); continue; }
    if (new Set(rows.map((p) => String(p.public_product_identity_id))).size !== 1 || !publicMatches.length && rows.length !== 1) {
      targets.push({ inputSku, disposition: 'conflict', reasonCode: 'PRODUCT_RESTORE_AMBIGUOUS' }); continue;
    }
    const selected = rows.at(-1);
    const context = await state.readTarget(client, Number(selected.id), { origin });
    const proof = state.restoreProof(context.product, context.lifecycle, context.facts, context.hide);
    targets.push({ inputSku, productId: Number(selected.id), article: selected.public_sku,
      status: selected.status, category: context.product.category, disposition: proof.eligible ? 'found' : proof.reasonCode === 'PRODUCT_ALREADY_ACTIVE' ? 'skipped' : 'conflict',
      reasonCode: proof.reasonCode, mode: proof.mode || null, visibility: proof.visibility || null,
      fingerprint: state.fingerprint(context.product, context.lifecycle), hideId: context.hide?.id || null,
      priorExclusion: context.hide?.previous_product?.exclude_from_export ?? null,
      priorRoute: context.hide?.previous_lifecycle?.route ?? null,
      confirmedMagentoId: context.facts.confirmedRemoteId || null });
  }
  // Public/internal aliases may identify the same product; restore it only once.
  const seen = new Set();
  for (const item of targets) if (item.productId != null) {
    if (seen.has(item.productId)) { item.disposition = 'skipped'; item.reasonCode = 'PRODUCT_RESTORE_DUPLICATE_TARGET'; }
    seen.add(item.productId);
  }
  return targets;
}
async function preview(input, options = {}) {
  const skus = state.inputSkus(input), { config, db, origin } = dependencies(options);
  const client = await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actor = Number(options.actorUserId || options.mutationContext?.actorUserId);
    await assertActorStillAuthorized(client, actor, 'products.archive', c.error, { readOnly: true });
    await assertActorStillAuthorized(client, actor, 'products.view', c.error, { readOnly: true });
    const activation = await deliveryGate(client, config, origin);
    const items = await lookup(client, skus, origin);
    if (!activation) for (const item of items) if (item.disposition === 'found') {
      item.disposition = 'conflict'; item.reasonCode = 'PRODUCT_AUTOMATIC_DELIVERY_REQUIRED';
    }
    const review = { format: 'product-restore-v1', reviewNonce: options.reviewNonce || randomUUID(), originHash: origin, installationKey: activation?.installation_key || null,
      skus, items };
    await client.query('COMMIT');
    return { ...review, reviewHash: c.hash(review), counts: { found: items.filter((i) => i.disposition === 'found').length,
      skipped: items.filter((i) => i.disposition === 'skipped').length, conflicts: items.filter((i) => i.disposition === 'conflict').length } };
  } catch (cause) { await client.query('ROLLBACK').catch(() => {}); throw cause; }
  finally { client.release(); }
}

async function readBatch(id, options = {}) {
  const { db } = dependencies(options);
  const batch = (await db.query('SELECT * FROM product_restore_batches WHERE id=$1', [id])).rows[0];
  if (!batch) state.fail('PRODUCT_RESTORE_BATCH_NOT_FOUND');
  const items = (await db.query(`SELECT i.*,r.product_id AS request_product_id,r.desired_generation,r.synced_generation,r.state AS sync_state,
    r.reason_code AS sync_reason,v.state AS visibility_state,v.reason_code AS visibility_reason,v.verified_at AS visibility_verified_at,
    (SELECT acknowledged_at FROM magento_sync_jobs j WHERE j.product_id=i.product_id AND j.state='succeeded'
      AND j.public_product_identity_id=p.public_product_identity_id AND j.origin_hash=$2
      AND j.automatic_generation=i.expected_generation ORDER BY acknowledged_at DESC LIMIT 1) AS confirmed_at
    FROM product_restore_items i LEFT JOIN products p ON p.id=i.product_id
    LEFT JOIN magento_product_sync_requests r ON r.public_product_identity_id=p.public_product_identity_id
    LEFT JOIN product_visibility_intents v ON v.id=i.visibility_intent_id WHERE i.batch_id=$1 ORDER BY i.product_id`, [id, batch.review.originHash])).rows;
  return { batchId: id, createdAt: batch.created_at, items: items.map((item) => {
    const confirmed = item.state === 'restored' && item.confirmed_at != null && item.sync_state === 'synced'
      && Number(item.request_product_id) === Number(item.product_id)
      && String(item.synced_generation) === String(item.expected_generation)
      && String(item.desired_generation) === String(item.expected_generation)
      && (!item.visibility_intent_id || item.visibility_state === 'verified');
    const failed = item.state === 'error' || item.visibility_state === 'blocked'
      || item.visibility_state === 'dispatched' && item.visibility_reason != null
      || item.sync_state === 'needs_attention'
      || item.expected_generation != null && String(item.desired_generation) !== String(item.expected_generation);
    return { productId: item.product_id, article: item.public_sku,
      state: failed ? 'error' : confirmed ? 'synced' : item.expected_generation != null ? 'queued' : 'restored',
      reasonCode: item.reason_code || item.visibility_reason || (item.sync_state === 'needs_attention' ? item.sync_reason : null)
        || (item.expected_generation != null && String(item.desired_generation) !== String(item.expected_generation) ? 'PRODUCT_RESTORE_GENERATION_CHANGED' : null),
      restoredAt: item.restored_at, confirmedAt: confirmed ? item.confirmed_at : null,
      visibilityRestoredAt: item.visibility_state === 'verified' ? item.visibility_verified_at : null };
  }), pending: batch.review.items.filter((item) => item.disposition === 'found' && !items.some((done) => Number(done.product_id) === item.productId)) };
}

async function apply(input, options = {}) {
  c.command(input, ['skus', 'reviewNonce', 'reviewHash', 'confirmRestoreAndSync']);
  c.identity(input.reviewNonce);
  if (input.confirmRestoreAndSync !== true || !/^[a-f0-9]{64}$/.test(input.reviewHash)) {
    throw c.error(422, 'PRODUCT_RESTORE_CONFIRMATION_REQUIRED', 'Підтвердьте відновлення та синхронізацію точного перевіреного списку.');
  }
  const skus = state.inputSkus({ skus: input.skus }), { config, db, origin } = dependencies(options);
  const actorUserId = Number(options.actorUserId || options.mutationContext?.actorUserId);
  const batchId = c.hash({ actorUserId, reviewHash: input.reviewHash });
  let batch = (await db.query('SELECT * FROM product_restore_batches WHERE id=$1', [batchId])).rows[0];
  if (!batch) {
    const checked = await preview({ skus }, { ...options, reviewNonce: input.reviewNonce });
    const { reviewHash, counts: ignored, ...review } = checked; void ignored;
    if (reviewHash !== input.reviewHash) state.fail('PRODUCT_RESTORE_REVIEW_STALE');
    if (!review.items.some((item) => item.disposition === 'found')) state.fail('PRODUCT_RESTORE_NO_ELIGIBLE_ITEMS');
    batch = await runAccessAdminMutation({ databasePool: db, actorUserId, requiredPermission: 'products.archive', createError: c.error,
      operation: async (client) => {
        await assertActorStillAuthorized(client, actorUserId, 'products.view', c.error);
        await client.query(`INSERT INTO product_restore_batches(id,actor_user_id,review_hash,review)
          VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(actor_user_id,review_hash) DO NOTHING`,
        [batchId, actorUserId, reviewHash, JSON.stringify(review)]);
        return (await client.query('SELECT * FROM product_restore_batches WHERE id=$1', [batchId])).rows[0];
      } });
  }
  if (batch.actor_user_id !== String(actorUserId) && Number(batch.actor_user_id) !== actorUserId
    || c.hash(batch.review) !== input.reviewHash || c.hash(batch.review.skus) !== c.hash(skus)) state.fail('PRODUCT_RESTORE_REVIEW_STALE');
  for (const item of batch.review.items.filter((row) => row.disposition === 'found')) {
    try {
      await runAccessAdminMutation({ databasePool: db, actorUserId, requiredPermission: 'products.archive', createError: c.error,
        operation: async (client) => {
          await assertActorStillAuthorized(client, actorUserId, 'products.view', c.error);
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`product_restore_batch:${batchId}:${item.productId}`]);
          if ((await client.query('SELECT 1 FROM product_restore_items WHERE batch_id=$1 AND product_id=$2', [batchId, item.productId])).rowCount) return;
          await gate.requireActive(client);
          const current = await state.readTarget(client, item.productId, { origin, lock: true });
          const lockKey = `amber_magento_public_identity:${current.product.public_product_identity_id}`;
          if (!(await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS held', [lockKey])).rows[0].held) state.fail('PRODUCT_RESTORE_BUSY');
          const proof = state.restoreProof(current.product, current.lifecycle, current.facts, current.hide);
          if (!proof.eligible) state.fail(proof.reasonCode);
          if (current.hide.id !== item.hideId || state.fingerprint(current.product, current.lifecycle) !== item.fingerprint
            || current.product.public_sku !== item.article || proof.mode !== item.mode || c.hash(proof.visibility) !== c.hash(item.visibility)) state.fail('PRODUCT_RESTORE_REVIEW_STALE');
          const activation = await deliveryGate(client, config, origin);
          if (!activation || activation.installation_key !== batch.review.installationKey) state.fail('PRODUCT_AUTOMATIC_DELIVERY_REQUIRED');
          if (current.hide.state === 'queued') await client.query(`UPDATE product_visibility_intents SET state='superseded',
            reason_code='PRODUCT_RESTORED_BEFORE_HIDE' WHERE id=$1`, [current.hide.id]);
          const old = current.hide.previous_lifecycle;
          await client.query(`UPDATE products SET status='active',exclude_from_export=$2,archived_by_user_id=NULL
            WHERE id=$1`, [item.productId, current.hide.previous_product.exclude_from_export]);
          await client.query(`UPDATE product_full_export_state SET route=$2,hold_reason=$3,delivery_version=delivery_version+1,
            updated_at=CURRENT_TIMESTAMP WHERE product_id=$1`, [item.productId, old.route, old.hold_reason || null]);
          const request = (await client.query('SELECT desired_generation,state,reason_code FROM magento_product_sync_requests WHERE public_product_identity_id=$1',
            [current.product.public_product_identity_id])).rows[0];
          if (!request || request.reason_code === 'reconciliation_required') state.fail('PRODUCT_SYNC_RECONCILIATION_REQUIRED');
          let visibilityId = null;
          if (proof.visibility.action === 'restore_confirmed_status') {
            const restored = await state.readTarget(client, item.productId, { origin });
            visibilityId = randomUUID();
            await client.query(`INSERT INTO product_visibility_intents
              (id,product_id,public_product_identity_id,public_sku,origin_hash,installation_key,kind,source_hide_id,actor_user_id,
                previous_product,previous_lifecycle,local_fingerprint,remote_product_id,target_status,expected_generation,state)
              VALUES($1,$2,$3,$4,$5,$6,'restore',$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,'queued')`,
            [visibilityId, item.productId, current.product.public_product_identity_id, item.article, origin, activation.installation_key,
              current.hide.id, actorUserId, JSON.stringify(current.hide.previous_product), JSON.stringify(old),
              state.fingerprint(restored.product, restored.lifecycle), current.facts.confirmedRemoteId, proof.visibility.status, request.desired_generation]);
          }
          await client.query(`INSERT INTO product_restore_items(batch_id,product_id,public_sku,state,expected_generation,visibility_intent_id,restored_at)
            VALUES($1,$2,$3,'restored',$4,$5,CURRENT_TIMESTAMP)`, [batchId, item.productId, item.article, request.desired_generation, visibilityId]);
          await writeAuditEvent(client, { mutationContext: options.mutationContext, eventKey: 'product.restored', subjectType: 'product',
            subjectId: item.productId, details: { batchId, reviewHash: input.reviewHash, publicSku: item.article,
              generation: String(request.desired_generation), visibilityIntentId: visibilityId } });
        } });
    } catch (cause) {
      if (cause.code === 'ADMIN_PERMISSION_REVOKED') throw cause;
      const code = /^(PRODUCT|MAGENTO|EXPORT|LIFECYCLE)_[A-Z_]+$/.test(cause.code || '') ? cause.code : 'PRODUCT_RESTORE_FAILED';
      await runAccessAdminMutation({ databasePool: db, actorUserId, requiredPermission: 'products.archive', createError: c.error,
        operation: async (client) => {
          await assertActorStillAuthorized(client, actorUserId, 'products.view', c.error);
          return client.query(`INSERT INTO product_restore_items(batch_id,product_id,public_sku,state,reason_code)
            VALUES($1,$2,$3,'error',$4) ON CONFLICT(batch_id,product_id) DO NOTHING`, [batchId, item.productId, item.article, code]);
        } });
    }
  }
  return readBatch(batchId, options);
}

async function status(productId, options = {}) {
  const { db } = dependencies(options);
  const product = (await db.query('SELECT id,status FROM products WHERE id=$1', [productId])).rows[0];
  if (!product) state.fail('PRODUCT_RESTORE_NOT_FOUND');
  const intents = (await db.query(`SELECT * FROM product_visibility_intents WHERE product_id=$1 ORDER BY created_at DESC,id DESC LIMIT 2`, [productId])).rows;
  return { productId, localState: product.status, visibility: intents[0] ? receipt(intents[0]) : null };
}
module.exports = { queueArchivedVisibility, preview, apply, readBatch, status, dependencies, deliveryGate, receipt };
