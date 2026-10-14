'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('schema reuse is limited to one slot, the same publication/scope and a bounded age, and returns copies', async () => {
  const { reuseSchema, SCHEMA_REUSE_MS } = require('../src/services/magento/sync-job.service');
  let reads = 0, clock = 1000;
  const read = async () => ({ attributes: [{ code: 'a', options: [{ id: ++reads }] }] });
  const now = () => clock;
  const input = { bindingRevisionId: 'publication-1' };
  const slot = {};
  const first = await reuseSchema(slot, input, 'all', read, now);
  first.attributes[0].options.push({ id: 'mutated' });
  const second = await reuseSchema(slot, input, 'all', read, now);
  assert.equal(reads, 1);
  assert.deepEqual(second.attributes[0].options, [{ id: 1 }], 'a planner mutation never leaks into the retained copy');
  await reuseSchema(slot, input, 'en', read, now);
  assert.equal(reads, 2, 'another store scope reads again');
  await reuseSchema(slot, { bindingRevisionId: 'publication-2' }, 'en', read, now);
  assert.equal(reads, 3, 'another publication reads again');
  clock += SCHEMA_REUSE_MS + 1;
  await reuseSchema(slot, { bindingRevisionId: 'publication-2' }, 'en', read, now);
  assert.equal(reads, 4, 'an expired copy reads again');
  await reuseSchema(undefined, input, 'all', read, now);
  await reuseSchema(undefined, input, 'all', read, now);
  assert.equal(reads, 6, 'without a worker slot every observation stays fresh');
});

test('worker gives enqueue and the following APPLY of one product the same private schema slot', async (t) => {
  const jobs = require('../src/services/magento/sync-job.service');
  const { createAutomaticSyncWorker } = require('../src/services/magento/automatic-sync-worker');
  const { originHash } = require('../src/services/magento/binding-contract');
  const config = { configured: true, baseUrl: 'https://store.example.invalid' };
  const request = { product_id: 1, state: 'pending', desired_generation: '1', active_job_id: null, active_generation: null };
  const db = { release() {}, async connect() { return this; }, async query(sql) {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ held: true }] };
    if (sql.includes('FROM magento_auto_sync_activation')) return { rows: [{ enabled: true, actor_user_id: 1, installation_key: 'test' }] };
    if (sql.includes('FROM magento_product_sync_requests')) return { rows: [request] };
    if (sql.includes('FROM magento_binding_revisions')) return { rows: [{ id: 'publication', origin_hash: originHash(config.baseUrl) }] };
    if (sql.includes('FROM products')) return { rows: [{ status: 'active', corrected_to_product_id: null, public_sku: 'AG-000002' }] };
    return { rows: [] };
  } };
  const slots = [];
  t.mock.method(jobs, 'enqueue', async (_config, _input, options) => { slots.push(options.schemaReuse); return { id: 'job', state: 'queued' }; });
  t.mock.method(jobs, 'applyJob', async (_config, _id, options) => { slots.push(options.schemaReuse); return { id: 'job', state: 'succeeded' }; });
  const worker = createAutomaticSyncWorker(config, { databasePool: db });
  await worker.runProduct('1');
  await worker.runProduct('1');
  assert.equal(slots.length, 4);
  assert.ok(slots[0] && slots[0] === slots[1], 'enqueue and APPLY share one slot');
  assert.notEqual(slots[2], slots[0], 'another product pass starts with a new slot');
  assert.equal(slots[2], slots[3]);
});

async function runPass(concurrency) {
  const { createAutomaticSyncWorker } = require('../src/services/magento/automatic-sync-worker');
  let inFlight = 0, peak = 0; const claimed = [];
  const client = { release() {}, async query(sql, values) {
    if (sql.includes('pg_try_advisory_lock')) {
      claimed.push(values[0]); inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5)); inFlight--;
      return { rows: [{ held: false }] };
    }
    return { rows: [] };
  } };
  const db = { async connect() { return client; }, async query(sql) {
    if (sql.includes('SELECT enabled FROM magento_auto_sync_activation')) return { rows: [{ enabled: true }] };
    if (sql.includes('FROM magento_product_sync_requests')) return { rows: [1, 2, 3, 4, 5].map((id) => ({ public_product_identity_id: String(id) })) };
    return { rows: [] };
  } };
  const worker = createAutomaticSyncWorker({ configured: false }, { databasePool: db, concurrency });
  await worker.tick();
  return { peak, claimed: claimed.sort() };
}

test('worker lanes default to one and run distinct products in parallel only when configured', async () => {
  const sequential = await runPass(undefined);
  assert.equal(sequential.peak, 1);
  const parallel = await runPass(2);
  assert.equal(parallel.peak, 2);
  const capped = await runPass(9);
  assert.equal(capped.peak, 4);
  const each = ['1', '2', '3', '4', '5'].map((id) => `amber_magento_public_identity:${id}`);
  for (const pass of [sequential, parallel, capped]) assert.deepEqual(pass.claimed, each, 'each selected product is claimed exactly once');
});

test('concurrency configuration defaults to one and accepts only 1..4', () => {
  const { loadConfig } = require('../src/config/env');
  const base = { ...process.env };
  assert.equal(loadConfig(base).magentoAutoSyncConcurrency, 1);
  assert.equal(loadConfig({ ...base, MAGENTO_AUTO_SYNC_CONCURRENCY: '2' }).magentoAutoSyncConcurrency, 2);
  assert.throws(() => loadConfig({ ...base, MAGENTO_AUTO_SYNC_CONCURRENCY: '5' }));
  assert.throws(() => loadConfig({ ...base, MAGENTO_AUTO_SYNC_CONCURRENCY: '0' }));
});
