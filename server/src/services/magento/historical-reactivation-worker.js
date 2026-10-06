const c = require('./binding-contract');
const s = require('../historical-reactivation-state');
const lifecycle = require('../product-lifecycle-state');
const { createMagentoClient } = require('./client');
const atomic = require('./historical-update-transport');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { writeAuditEvent } = require('../../audit/audit-events');

async function readRemote(config, intent, options) {
  try { return await createMagentoClient(config, { fetchImpl: options.fetchImpl }).findProductBySku(intent.public_sku); }
  catch (cause) { if (cause.code === 'MAGENTO_PRODUCT_NOT_FOUND') return null; throw cause; }
}
async function lane(db, config, intent, operation) {
  if (intent.origin_hash !== c.originHash(config.baseUrl)) s.fail('HISTORICAL_ORIGIN_CHANGED');
  const client = await db.connect(), locks = [];
  try {
    for (const key of [`amber_magento_public_identity:${intent.public_product_identity_id}`, `amber_magento_sync:${intent.origin_hash}:${intent.public_sku}`]) {
      if (!(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [key])).rows[0].held) s.fail('HISTORICAL_BUSY');
      locks.push(key);
    }
    return await operation();
  } finally {
    for (const key of locks.reverse()) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {});
    client.release();
  }
}
async function verifyLocal(client, config, intent) {
  await s.authority(client, Number(intent.actor_user_id));
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${intent.installation_key}`]);
  const binding = await s.currentBinding(client, config);
  if (binding.row.id !== intent.binding_revision_id || binding.fingerprint !== intent.binding_hash
    || binding.row.installation_key !== intent.installation_key) s.fail('HISTORICAL_BINDING_CHANGED');
  const target = await lifecycle.readTarget(client, Number(intent.product_id), { origin: intent.origin_hash, lock: true });
  if (s.localIssue(target) || s.fingerprint(target.product, target.lifecycle) !== intent.local_fingerprint
    || target.product.public_sku !== intent.public_sku || String(target.product.public_product_identity_id) !== String(intent.public_product_identity_id)) s.fail('HISTORICAL_CURRENT_FACTS_CHANGED');
  const request = (await client.query('SELECT desired_generation FROM magento_product_sync_requests WHERE public_product_identity_id=$1 FOR UPDATE', [intent.public_product_identity_id])).rows[0];
  if ((request?.desired_generation || null) !== intent.request_generation) s.fail('HISTORICAL_GENERATION_CHANGED');
  if ((await client.query(`SELECT 1 FROM historical_reactivation_intents WHERE public_product_identity_id=$1
    AND id<>$2 AND state IN ('queued','dispatched','awaiting_native')`, [intent.public_product_identity_id, intent.id])).rowCount) s.fail('HISTORICAL_INTENT_EXISTS');
  return target;
}
async function change(db, config, intent, options, operation) {
  return runAccessAdminMutation({ databasePool: db, actorUserId: Number(options.actorUserId || options.mutationContext?.actorUserId || intent.actor_user_id),
    requiredPermission: 'export_templates.publish', createError: c.error, operation: async client => {
      await s.authority(client, Number(options.actorUserId || options.mutationContext?.actorUserId || intent.actor_user_id));
      const target = await verifyLocal(client, config, intent, options);
      const current = (await client.query('SELECT * FROM historical_reactivation_intents WHERE id=$1 FOR UPDATE', [intent.id])).rows[0];
      if (!current) s.fail('HISTORICAL_INTENT_NOT_FOUND', 404);
      return operation(client, current, target);
    } });
}
async function activate(client, intent, target, mutationContext) {
  if (!['queued', 'blocked', 'dispatched'].includes(intent.state)) s.fail('HISTORICAL_INTENT_STATE_CHANGED');
  const expected = String(BigInt(intent.request_generation || 0) + 1n);
  await client.query(`UPDATE historical_reactivation_intents SET state='awaiting_native',reason_code=NULL,
    hidden_verified_at=CURRENT_TIMESTAMP,local_activated_at=CURRENT_TIMESTAMP,expected_generation=$2 WHERE id=$1`, [intent.id, expected]);
  await client.query("SELECT set_config('amber.historical_reactivation_apply',$1,true)", [intent.id]);
  await client.query(`UPDATE products SET status='active',exclude_from_export=0,archived_by_user_id=NULL WHERE id=$1`, [intent.product_id]);
  await client.query(`UPDATE product_full_export_state SET route='normal',hold_reason=NULL,business_exclusion_state='none',
    evidence=evidence||jsonb_build_object('historicalReactivationIntent',$2::text),delivery_version=delivery_version+1,updated_at=CURRENT_TIMESTAMP WHERE product_id=$1`, [intent.product_id, intent.id]);
  const request = (await client.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1', [intent.public_product_identity_id])).rows[0];
  if (!request || String(request.desired_generation) !== expected || Number(request.product_id) !== Number(intent.product_id)) s.fail('HISTORICAL_GENERATION_CHANGED');
  await writeAuditEvent(client, { mutationContext, eventKey: 'product.historical_reactivation_hidden_verified', subjectType: 'product', subjectId: intent.product_id,
    details: { intentId: intent.id, publicSku: intent.public_sku, remoteProductId: String(intent.remote_product_id), targetStatus: 2, priorFacts: 'unknown', generation: expected } });
  return (await client.query('SELECT * FROM historical_reactivation_intents WHERE id=$1', [intent.id])).rows[0];
}
async function runIntent(config, id, options) {
  const db = options.databasePool;
  const intent = (await db.query('SELECT * FROM historical_reactivation_intents WHERE id=$1', [id])).rows[0];
  if (!intent || intent.state !== 'queued') return intent;
  const mutationContext = { actorUserId: Number(intent.actor_user_id), requestId: `historical-reactivation-${id}` };
  return lane(db, config, intent, async () => {
    try {
      await change(db, config, intent, { ...options, mutationContext }, () => {});
      await atomic.capability(config, options);
      const raw = await readRemote(config, intent, options);
      if (!s.remoteMatches(intent, raw) || ![1,2].includes(raw.status)) s.fail(raw ? 'HISTORICAL_REMOTE_IDENTITY_MISMATCH' : 'HISTORICAL_REMOTE_COUNTERPART_MISSING');
      if (s.remoteMatches(intent, raw, true)) return await change(db, config, intent, { ...options, mutationContext },
        (client, current, target) => activate(client, current, target, mutationContext));
      await change(db, config, intent, { ...options, mutationContext }, async (client, current) => {
        if (current.state !== 'queued') s.fail('HISTORICAL_INTENT_STATE_CHANGED');
        await client.query("UPDATE historical_reactivation_intents SET state='dispatched',dispatched_at=CURRENT_TIMESTAMP WHERE id=$1", [id]);
        await writeAuditEvent(client, { mutationContext, eventKey: 'product.historical_reactivation_hide_dispatched', subjectType: 'product', subjectId: intent.product_id,
          details: { intentId: id, publicSku: intent.public_sku, remoteProductId: String(intent.remote_product_id), targetStatus: 2 } });
      });
      try { await atomic.hideExisting(config, intent, { apply: true, fetchImpl: options.fetchImpl }); }
      catch { /* Immutable dispatch remains uncertain, never resent. */ }
      const after = await readRemote(config, intent, options);
      if (!s.remoteMatches(intent, after, true)) s.fail('HISTORICAL_HIDE_UNCERTAIN');
      return await change(db, config, intent, { ...options, mutationContext }, (client, current, target) => activate(client, current, target, mutationContext));
    } catch (cause) {
      const reason = /^(HISTORICAL|MAGENTO|ADMIN|LIFECYCLE)_[A-Z_]+$/.test(cause.code || '') ? cause.code : 'HISTORICAL_REACTIVATION_FAILED';
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(`UPDATE historical_reactivation_intents SET state=CASE WHEN dispatched_at IS NULL THEN 'blocked' ELSE 'dispatched' END,
          reason_code=$2 WHERE id=$1 AND state IN ('queued','dispatched') RETURNING state`, [id,reason]);
        if (updated.rowCount) await writeAuditEvent(client,{mutationContext,eventKey:'product.historical_reactivation_review_required',subjectType:'product',subjectId:intent.product_id,
          details:{intentId:id,state:updated.rows[0].state,reasonCode:reason}});
        await client.query('COMMIT');
      } catch { await client.query('ROLLBACK').catch(()=>{}); }
      finally { client.release(); }
      options.logger?.warn?.('product.historical_reactivation.failed', { intentId: id, code: reason });
      return (await db.query('SELECT * FROM historical_reactivation_intents WHERE id=$1', [id])).rows[0];
    }
  });
}
async function inspect(config, id, options) {
  c.identity(id); const db = options.databasePool;
  await s.authority(db, Number(options.actorUserId || options.mutationContext?.actorUserId), true);
  const intent = (await db.query('SELECT * FROM historical_reactivation_intents WHERE id=$1', [id])).rows[0];
  if (!intent) s.fail('HISTORICAL_INTENT_NOT_FOUND', 404);
  return lane(db, config, intent, async () => {
    const raw = await readRemote(config, intent, options);
    const observation = { id: raw?.id || null, sku: raw?.sku || null, status: raw?.status ?? null, fingerprint: s.remoteFingerprint(raw) };
    let currentValid = false;
    try {
      await s.authority(db, Number(intent.actor_user_id), true);
      const binding = await s.currentBinding(db, config);
      const target = await lifecycle.readTarget(db, Number(intent.product_id), { origin: intent.origin_hash });
      const request = (await db.query('SELECT desired_generation FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[intent.public_product_identity_id])).rows[0];
      await atomic.capability(config, options);
      currentValid = binding.row.id === intent.binding_revision_id && binding.fingerprint === intent.binding_hash
        && !s.localIssue(target) && s.fingerprint(target.product,target.lifecycle) === intent.local_fingerprint
        && (request?.desired_generation || null) === intent.request_generation;
    } catch { /* Inspection reports eligibility; it never weakens a fence or mutates a receipt. */ }
    return { intentId: id, article: intent.public_sku, state: intent.state, expectedMagentoId: Number(intent.remote_product_id),
      observedMagentoId: observation.id, observedStatus: observation.status, targetStatus: 2,
      canConfirm: currentValid && ['blocked','dispatched'].includes(intent.state) && s.remoteMatches(intent, raw, true), reviewHash: c.hash({ intent, observation }) };
  });
}
async function reconcile(config, input, options) {
  c.command(input, ['intentId','reviewHash','confirmObservedHiddenResult']); c.identity(input.intentId);
  if (input.confirmObservedHiddenResult !== true || !/^[a-f0-9]{64}$/.test(input.reviewHash || '')) s.fail('HISTORICAL_CONFIRMATION_REQUIRED', 422);
  const db = options.databasePool;
  await s.authority(db, Number(options.actorUserId || options.mutationContext?.actorUserId), true);
  const intent = (await db.query('SELECT * FROM historical_reactivation_intents WHERE id=$1', [input.intentId])).rows[0];
  if (!intent) s.fail('HISTORICAL_INTENT_NOT_FOUND', 404);
  if (['awaiting_native','completed'].includes(intent.state)) return s.receipt(intent);
  return lane(db, config, intent, async () => {
    await atomic.capability(config, options);
    const raw = await readRemote(config, intent, options);
    const observation = { id: raw?.id || null, sku: raw?.sku || null, status: raw?.status ?? null, fingerprint: s.remoteFingerprint(raw) };
    if (!['blocked','dispatched'].includes(intent.state) || c.hash({ intent, observation }) !== input.reviewHash || !s.remoteMatches(intent, raw, true)) s.fail('HISTORICAL_REVIEW_STALE');
    const row = await change(db, config, intent, options, async (client, current, target) => {
      if (c.hash(current) !== c.hash(intent)) s.fail('HISTORICAL_REVIEW_STALE');
      return activate(client, current, target, options.mutationContext);
    });
    return s.receipt(row);
  });
}
async function processPending(config, options) {
  if (!config.configured) return;
  const db = options.databasePool;
  const rows = (await db.query(`SELECT id FROM historical_reactivation_intents WHERE state='queued' AND origin_hash=$1
    ORDER BY last_checked_at NULLS FIRST,created_at,id LIMIT 2`, [c.originHash(config.baseUrl)])).rows;
  for (const row of rows) {
    if (options.stopping?.()) break;
    await db.query("UPDATE historical_reactivation_intents SET last_checked_at=CURRENT_TIMESTAMP WHERE id=$1 AND state='queued'", [row.id]);
    await runIntent(config, row.id, options);
  }
  const uncertain = (await db.query(`SELECT * FROM historical_reactivation_intents WHERE state='dispatched' AND origin_hash=$1
    ORDER BY last_checked_at NULLS FIRST,created_at,id LIMIT 2`, [c.originHash(config.baseUrl)])).rows;
  for (const intent of uncertain) {
    if (options.stopping?.()) break;
    await db.query("UPDATE historical_reactivation_intents SET last_checked_at=CURRENT_TIMESTAMP WHERE id=$1 AND state='dispatched'", [intent.id]);
    try {
      await lane(db, config, intent, async () => {
        await atomic.capability(config, options);
        const raw = await readRemote(config, intent, options);
        if (!s.remoteMatches(intent, raw, true)) return;
        const mutationContext = { actorUserId: Number(intent.actor_user_id), requestId: `historical-readback-${intent.id}` };
        await change(db, config, intent, { ...options, mutationContext }, (client, current, target) => activate(client, current, target, mutationContext));
      });
    } catch (cause) { options.logger?.warn?.('product.historical_reactivation.readback_pending', { intentId: intent.id, code: cause.code || 'HISTORICAL_HIDE_UNCERTAIN' }); }
  }
  await require('./historical-update-boundary').confirmCompleted(config, options);
}
module.exports = { lane, readRemote, verifyLocal, activate, runIntent, inspect, reconcile, processPending };
