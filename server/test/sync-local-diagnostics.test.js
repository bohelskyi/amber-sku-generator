const { test } = require('node:test');
const assert = require('node:assert/strict');
const local = require('../src/services/magento/sync-local-diagnostics');

test('local SQL failure retains only a closed SQLSTATE/phase and strips secret exception fields', async () => {
  const error = Object.assign(Error('secret password payload'), { code: '57014', query: 'secret SQL', detail: 'OAuth secret' });
  await assert.rejects(local.phase('authority_lock', async () => { throw error; }), { code: '57014' });
  const events = [];
  local.log(error, { logger: { error: (...args) => events.push(args) }, telemetryStage: 'apply' }, { jobId: 'job', publicIdentityId: 7, raw: 'secret' });
  assert.deepEqual(local.diagnostic(error), { code: 'LOCAL_DATABASE_FAILURE', sqlState: '57014', phase: 'authority_lock' });
  assert.deepEqual(events[0], ['magento.sync.local_failure', {
    code: 'LOCAL_DATABASE_FAILURE', sqlState: '57014', phase: 'authority_lock', jobId: 'job', publicIdentityId: '7', stage: 'apply',
  }]);
  assert.doesNotMatch(JSON.stringify(events), /secret|password|OAuth|query|detail/);
  assert.equal(local.diagnostic({ code: 'ECONNRESET', syncPhase: 'secret' }), null);
  assert.deepEqual(local.diagnostic({ code: '57014', syncPhase: 'secret' }), { code: 'LOCAL_DATABASE_FAILURE', sqlState: '57014', phase: 'unknown' });
});

test('support diagnostics keep SQLSTATE/closed phase and present a database failure without mapping advice', () => {
  const { safeDiagnostics, presentProblems } = require('../src/services/magento/sync-problems');
  const diagnostics = safeDiagnostics([{ code: 'LOCAL_DATABASE_FAILURE', sqlState: '57014', phase: 'authority_lock', message: 'password', query: 'secret' }]);
  assert.deepEqual(diagnostics, [{ code: 'LOCAL_DATABASE_FAILURE', sqlState: '57014', phase: 'authority_lock' }]);
  const problem = presentProblems(diagnostics)[0];
  assert.equal(problem.resolution, 'administrator'); assert.match(problem.message, /бази даних/);
  assert.doesNotMatch(JSON.stringify(problem), /password|secret/);
});

test('automatic local timeout is parked with safe diagnostics; uncertain dispatch remains reconciliation-only', async (t) => {
  const jobs = require('../src/services/magento/sync-job.service');
  const { createAutomaticSyncWorker } = require('../src/services/magento/automatic-sync-worker');
  const { originHash } = require('../src/services/magento/binding-contract');
  const config = { configured: true, baseUrl: 'https://store.example.invalid' };
  const updates = [], logs = [];
  const request = { product_id: 1, state: 'pending', desired_generation: '1', active_job_id: 'job', active_generation: '1' };
  const job = { id: 'job', state: 'queued', automatic_generation: '1', binding_revision_id: 'publication' };
  const db = { release() {}, async connect() { return this; }, async query(sql, values) {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ held: true }] };
    if (sql.includes('FROM magento_auto_sync_activation')) return { rows: [{ enabled: true, actor_user_id: 1, installation_key: 'test' }] };
    if (sql.includes('FROM magento_product_sync_requests')) return { rows: [request] };
    if (sql.includes('FROM magento_binding_revisions')) return { rows: [{ id: 'publication', origin_hash: originHash(config.baseUrl) }] };
    if (sql.includes('FROM products')) return { rows: [{ status: 'active', corrected_to_product_id: null, public_sku: 'AG-000002' }] };
    if (sql.includes('FROM magento_sync_jobs')) return { rows: [job] };
    if (sql.startsWith('UPDATE')) updates.push(values);
    return { rows: [] };
  } };
  const error = Object.assign(Error('password and remote payload'), { code: '57014', syncPhase: 'authority_lock' });
  t.mock.method(jobs, 'applyJob', async () => { throw error; });
  const worker = createAutomaticSyncWorker(config, { databasePool: db, logger: { error: (...args) => logs.push(args) } });
  await worker.runProduct('1');
  assert.equal(updates.at(-1)[1], 'unexpected_failure');
  assert.deepEqual(JSON.parse(updates.at(-1)[3]), { code: 'LOCAL_DATABASE_FAILURE', sqlState: '57014', phase: 'authority_lock' });
  assert.doesNotMatch(JSON.stringify(logs), /password|payload/);
  t.mock.method(jobs, 'applyJob', async () => ({ ...job, state: 'uncertain',
    failure: { code: 'MAGENTO_SYNC_FAILED', sqlState: '57014', phase: 'dispatch_marker' } }));
  await worker.runProduct('1');
  assert.equal(updates.at(-1)[1], 'reconciliation_required');
  assert.equal(JSON.parse(updates.at(-1)[3]).phase, 'dispatch_marker');
});
