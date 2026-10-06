const { test } = require('node:test');
const assert = require('node:assert/strict');
const { presentStatus } = require('../src/services/magento/automatic-sync-status');

test('worker keeps idle cadence and avoids another five seconds after a long nonoverlapping pass', async (t) => {
  const { createAutomaticSyncWorker } = require('../src/services/magento/automatic-sync-worker');
  const scheduled = []; let clock = 0, reads = 0, current = 0, peak = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unref() {} }; scheduled.push(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const db = { async query() {
    reads++; current++; peak = Math.max(peak, current);
    await new Promise((resolve) => setImmediate(resolve)); current--; if (reads === 1) clock += 8000;
    return { rows: [{ enabled: false }] };
  } };
  const worker = createAutomaticSyncWorker({}, { databasePool: db, now: () => clock });
  worker.start(); worker.start(); assert.equal(scheduled.length, 1); assert.equal(scheduled[0].delay, 5000);
  scheduled[0].callback(); worker.start();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled.length, 2); assert.equal(scheduled[1].delay, 0); assert.equal(peak, 1);
  scheduled[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled[2].delay, 5000, 'idle passes retain the original cadence');
  await worker.stop(); scheduled[2].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2); assert.equal(scheduled.length, 3);
});

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
