const { createMagentoClient } = require('./client');
const { originHash, error } = require('./binding-contract');
const { readPreviewProduct } = require('./sync-preview-db');
const { evaluate } = require('./binding-evidence-products');
const { reconcileObservation } = require('./name-state');
const { assertActorStillAuthorized, APPLICATION_USER_ADMIN_LOCK_KEY } = require('../access-admin-transaction');

// Exactly one base GET and, when required by the evaluator, one EN GET. This
// discovery lane never invokes a Magento mutation or product/schema audit.
async function readNames(config, amber, { fetchImpl } = {}) {
  const expected = evaluate(amber, amber.product);
  const sku = amber.product.public_sku;
  const raw = await createMagentoClient(config, { fetchImpl, storeCode: 'all' }).findProductBySku(sku);
  const domainEvidence = { english: null, failures: [] };
  if (typeof expected.english.name === 'string') {
    const remote = await createMagentoClient(config, { fetchImpl, storeCode: 'en' }).findProductBySku(sku);
    if (remote.id !== raw.id || remote.sku !== sku) throw error(409, 'MAGENTO_NAME_IDENTITY_CHANGED', 'Ідентичність Magento змінилася.');
    domainEvidence.english = { fields: { name: remote.name } };
  }
  if (raw.sku !== sku || !Number.isSafeInteger(raw.id) || raw.id <= 0
    || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 1024
    || /[\u0000-\u001f\u007f]/.test(raw.name)
    || (domainEvidence.english && (typeof domainEvidence.english.fields.name !== 'string'
      || !domainEvidence.english.fields.name.trim() || domainEvidence.english.fields.name.length > 1024
      || /[\u0000-\u001f\u007f]/.test(domainEvidence.english.fields.name)))) {
    throw error(422, 'MAGENTO_RESPONSE_INVALID', 'Не вдалося перевірити назву Magento.');
  }
  return { amber, raw, domainEvidence };
}
async function unresolvedDispatch(db, origin, sku) {
  return (await db.query(`SELECT 1 FROM magento_sync_jobs j WHERE j.origin_hash=$1 AND j.sku=$2
    AND (j.state='uncertain' OR (j.state NOT IN ('succeeded','superseded')
      AND EXISTS(SELECT 1 FROM magento_sync_steps s WHERE s.job_id=j.id AND s.state='dispatched')))`, [origin, sku])).rowCount > 0;
}
function createNameDiscovery(config, { databasePool: db, fetchImpl, logger = { error() {} }, intervalMs = 60000, batchSize = 10 } = {}) {
  let timer; let active; let stopped = false;
  async function tick() {
    if (stopped || !config.configured) return;
    const origin = originHash(config.baseUrl); const lock = `amber_magento_name_discovery:${origin}`;
    const lane = await db.connect(); let held = false;
    try {
      held = (await lane.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [lock])).rows[0].held;
      if (!held) return;
      const gate = (await lane.query('SELECT * FROM magento_auto_sync_activation WHERE singleton')).rows[0];
      if (!gate?.enabled) return;
      // Verify the current service actor before any remote reads. No access or
      // product transaction lock survives the remote call.
      await lane.query('BEGIN');
      await lane.query('SELECT pg_advisory_xact_lock(hashtext($1))', [APPLICATION_USER_ADMIN_LOCK_KEY]);
      await assertActorStillAuthorized(lane, Number(gate.actor_user_id), 'export_templates.publish', error);
      await lane.query('COMMIT');
      const binding = (await lane.query(`SELECT id,origin_hash FROM magento_binding_revisions WHERE installation_key=$1
        AND state='published' ORDER BY version_number DESC LIMIT 1`, [gate.installation_key])).rows[0];
      if (!binding || binding.origin_hash !== origin) return;
      await lane.query('INSERT INTO magento_name_discovery_cursors(origin_hash) VALUES($1) ON CONFLICT DO NOTHING', [origin]);
      const cursor = (await lane.query(`SELECT * FROM magento_name_discovery_cursors WHERE origin_hash=$1
        AND next_scan_at<=CURRENT_TIMESTAMP`, [origin])).rows[0];
      if (!cursor) return;
      const products = (await lane.query(`SELECT r.*,i.public_sku FROM magento_product_sync_requests r
        JOIN public_product_identities i ON i.id=r.public_product_identity_id JOIN products p ON p.id=r.product_id
        WHERE i.id>$1 AND p.status='active' AND p.corrected_to_product_id IS NULL
          AND NOT EXISTS(SELECT 1 FROM magento_test_deletions d WHERE d.public_product_identity_id=i.id)
          AND (EXISTS(SELECT 1 FROM magento_sync_jobs j WHERE j.public_product_identity_id=i.id
            AND j.origin_hash=$2 AND j.remote_product_id IS NOT NULL)
            OR EXISTS(SELECT 1 FROM magento_name_sync_states n WHERE n.public_product_identity_id=i.id
              AND n.origin_hash=$2))
        ORDER BY i.id LIMIT $3`, [cursor.after_identity_id, origin, Math.max(1, Math.min(10, batchSize))])).rows;
      for (const product of products) {
        if (stopped) break;
        const identityLock = `amber_magento_public_identity:${product.public_product_identity_id}`;
        const skuLock = `amber_magento_sync:${origin}:${product.public_sku}`;
        let identityHeld = false; let skuHeld = false;
        try {
          identityHeld = (await lane.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [identityLock])).rows[0].held;
          if (!identityHeld) break; // Do not skip a busy identity permanently on restart.
          skuHeld = (await lane.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [skuLock])).rows[0].held;
          if (!skuHeld) break;
          if ((await lane.query('SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=$1',
            [product.public_product_identity_id])).rowCount) continue;
          if (!await unresolvedDispatch(lane, origin, product.public_sku)) {
            const amber = await readPreviewProduct(db, { productId: Number(product.product_id), bindingRevisionId: binding.id });
            const observation = await readNames(config, amber, { fetchImpl });
            const automatic = { publicIdentityId: product.public_product_identity_id, productId: Number(product.product_id),
              generation: product.desired_generation, installationKey: gate.installation_key };
            const result = await reconcileObservation(config, observation, { databasePool: db, actorUserId: Number(gate.actor_user_id), automatic });
            if (['identity_changed', 'unavailable', 'foreign_identity'].includes(result.action)) {
              await lane.query(`UPDATE magento_product_sync_requests SET state='needs_attention',reason_code='data_or_binding',
                diagnostics=$3::jsonb WHERE public_product_identity_id=$1 AND desired_generation=$2
                AND reason_code IS DISTINCT FROM 'reconciliation_required'`, [product.public_product_identity_id,
              product.desired_generation, JSON.stringify([{ code: result.action === 'foreign_identity' ? require('./native-identity-ownership').CODE : result.action === 'identity_changed' ? 'NAME_REMOTE_IDENTITY_CHANGED' : 'NAME_READ_UNAVAILABLE' }])]);
            }
          }
        } catch (cause) {
          // A failed GET does not alter either name or common baseline. The next
          // bounded cycle revisits it; do not manufacture a write or retry job.
          logger.error('magento.name_discovery.read_failed', { code: /^MAGENTO_[A-Z_]+$/.test(cause.code || '') ? cause.code : 'LOCAL_READ_FAILED' });
        } finally {
          if (skuHeld) await lane.query('SELECT pg_advisory_unlock(hashtext($1))', [skuLock]);
          if (identityHeld) await lane.query('SELECT pg_advisory_unlock(hashtext($1))', [identityLock]);
        }
        await lane.query('UPDATE magento_name_discovery_cursors SET after_identity_id=$2 WHERE origin_hash=$1',
          [origin, product.public_product_identity_id]);
      }
      await lane.query(`UPDATE magento_name_discovery_cursors SET next_scan_at=CURRENT_TIMESTAMP+interval '60 seconds',
        after_identity_id=CASE WHEN $2 THEN 0 ELSE after_identity_id END WHERE origin_hash=$1`, [origin, products.length === 0]);
    } finally {
      await lane.query('ROLLBACK').catch(() => {});
      if (held) await lane.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]).catch(() => {});
      lane.release();
    }
  }
  function start() {
    const loop = () => { active = tick().catch(() => logger.error('magento.name_discovery.failed', { code: 'LOCAL_DISCOVERY_FAILURE' }))
      .finally(() => { active = null; if (!stopped) { timer = setTimeout(loop, intervalMs); timer.unref(); } }); };
    timer = setTimeout(loop, intervalMs); timer.unref();
  }
  async function stop() { stopped = true; clearTimeout(timer); await active; }
  return { tick, start, stop };
}
module.exports = { createNameDiscovery, readNames, unresolvedDispatch };
