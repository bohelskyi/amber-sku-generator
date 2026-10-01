const { test } = require('node:test');
const assert = require('node:assert/strict');
const { presentStatus } = require('../src/services/magento/automatic-sync-status');

test('archive gap: automatic worker reports product_retired without dispatching a remote write', async () => {
  const { createAutomaticSyncWorker } = require('../src/services/magento/automatic-sync-worker');
  const { originHash } = require('../src/services/magento/binding-contract');
  const config = { configured: true, baseUrl: 'https://store.example.invalid' };
  const updates = [];
  const db = { release() {}, async connect() { return this; }, async query(sql, values) {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ held: true }] };
    if (sql.includes('FROM magento_auto_sync_activation')) return { rows: [{ enabled: true, actor_user_id: 1, installation_key: 'test' }] };
    if (sql.includes('FROM magento_product_sync_requests')) return { rows: [{ product_id: 1, state: 'pending', desired_generation: '2' }] };
    if (sql.includes('FROM magento_binding_revisions')) return { rows: [{ id: 'publication', origin_hash: originHash(config.baseUrl) }] };
    if (sql.includes('FROM products')) return { rows: [{ status: 'archived', corrected_to_product_id: null, public_sku: 'AG-000002' }] };
    if (sql.includes('FROM magento_sync_jobs')) return { rows: [] };
    if (sql.startsWith('UPDATE')) updates.push(values);
    return { rows: [] };
  } };
  await createAutomaticSyncWorker(config, { databasePool: db, jobOptions: {
    fetchImpl: async () => assert.fail('Archive must not call Magento'),
  } }).runProduct('1');
  assert.equal(updates[0][1], 'product_retired');
});

test('automatic sync status exposes only a closed state and safe reason, never remote evidence', () => {
  assert.deepEqual(presentStatus(null), { state: 'not_tracked', reason: null });
  const status = presentStatus({ state: 'needs_attention', reason_code: 'reconciliation_required', failure: 'secret OAuth body' });
  assert.equal(status.state, 'needs_attention'); assert.match(status.reason, /адміністратором/);
  assert.deepEqual(Object.keys(status), ['state', 'reason']);
  assert.doesNotMatch(JSON.stringify(status), /secret|OAuth|body/);
});

test('automatic status CLI help and missing explicit database never start a worker', async () => {
  const { run } = require('../scripts/magento-auto-status'); const output = [];
  assert.equal(await run(['--help'], {}, (value) => output.push(value)), 0);
  assert.equal(await run(['--expected-database', 'amber'], {}, (value) => output.push(value)), 1);
  assert.match(output[0], /no .env loading/);
  assert.equal(JSON.parse(output[1]).code, 'EXPLICIT_DATABASE_REQUIRED');
});
