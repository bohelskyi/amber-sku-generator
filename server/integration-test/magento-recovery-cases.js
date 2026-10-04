module.exports = async function recoveryCases({ t, suite, scenario, config }) {
  const { assert, pool, Pool, TEST_DATABASE_URL } = suite;
  const recovery = require('../src/services/magento/sync-job-recovery');
  const request = (review) => ({ review: review.review, reviewHash: review.reviewHash, reason: 'Перевірено початкову операцію' });
  async function uncertain() {
    const s = await scenario(); const job = await s.enqueue();
    s.hooks.afterWrite = async () => { s.hooks.readFailure = true; throw new Error('lost acknowledgement'); };
    const result = await s.apply(job); assert.equal(result.state, 'uncertain'); assert.equal(s.writes.length, 1);
    s.hooks.afterWrite = null; s.hooks.readFailure = false;
    return { s, job };
  }
  await t.test('browser recovery inspects and confirms only with GET, then explicitly continues the original unsent steps', async () => {
    const { s, job } = await uncertain();
    const before = (await pool.query('SELECT * FROM magento_sync_jobs WHERE id=$1', [job.id])).rows[0];
    const review = await recovery.inspect(config, job.id, s.options);
    assert.equal(review.canReconcile, true, JSON.stringify(review.blockers)); assert.equal(review.canContinue, false);
    assert.equal(s.writes.length, 1); assert.deepEqual((await pool.query('SELECT * FROM magento_sync_jobs WHERE id=$1', [job.id])).rows[0], before);
    const confirmed = await recovery.reconcile(config, job.id, request(review), s.options);
    assert.equal(confirmed.remoteWrites, 0); assert.equal(confirmed.job.state, 'uncertain'); assert.equal(s.writes.length, 1);
    assert.equal(confirmed.job.steps[0].state, 'verified');
    const repeated = await recovery.reconcile(config, job.id, request(review), { ...s.options, fetchImpl: () => assert.fail('stored receipt must not read Magento') });
    assert.equal(repeated.alreadyApplied, true); assert.equal(s.writes.length, 1);
    const continuation = await recovery.inspect(config, job.id, s.options);
    assert.equal(continuation.canContinue, true, JSON.stringify(continuation.blockers));
    const done = await recovery.continueJob(config, job.id, request(continuation), s.options);
    assert.equal(done.job.state, 'succeeded', JSON.stringify(done.job.failure)); assert.equal(s.writes.length, 4);
    assert.equal(s.writes.filter((w) => w.route === 'products' && w.scope === 'all').length, 1);
    assert.equal((await recovery.continueJob(config, job.id, request(continuation), s.options)).job.state, 'succeeded');
    assert.equal(s.writes.length, 4);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE event_key='magento_sync.recovery_continued' AND subject_id=$1", [continuation.reviewHash])).rows[0].n, 1);
  });
  await t.test('missing remote confirmation and altered reviewed evidence never authorize another dispatch', async () => {
    const { s, job } = await uncertain(); s.remote().price = 999;
    const report = await recovery.inspect(config, job.id, s.options);
    assert.equal(report.canReconcile, false); assert.equal(report.canContinue, false); assert.equal(s.writes.length, 1);
    await assert.rejects(recovery.reconcile(config, job.id, request(report), s.options));
    assert.equal(s.writes.length, 1);
    const other = await scenario(); const pending = await other.enqueue(); const review = await recovery.inspect(config, pending.id, other.options);
    other.remote().name = 'Changed after review';
    const result = await recovery.continueJob(config, pending.id, request(review), other.options);
    assert.notEqual(result.job.state, 'succeeded'); assert.equal(other.writes.length, 0);
    assert.equal(result.job.failure.code, 'MAGENTO_RECOVERY_REVIEW_STALE');
  });
  await t.test('independent recovery callers contend on the same original job and record a single immutable confirmation', async () => {
    const { s, job } = await uncertain(); const review = await recovery.inspect(config, job.id, s.options);
    let entered, release;
    const reached = new Promise((resolve) => { entered = resolve; }); const wait = new Promise((resolve) => { release = resolve; });
    let held = false;
    const fetchImpl = async (...args) => { if (!held) { held = true; entered(); await wait; } return s.options.fetchImpl(...args); };
    const running = recovery.reconcile(config, job.id, request(review), { ...s.options, fetchImpl });
    await reached;
    const other = new Pool({ connectionString: TEST_DATABASE_URL });
    try {
      await assert.rejects(recovery.reconcile(config, job.id, request(review), { ...s.options, databasePool: other }), { code: 'MAGENTO_SYNC_BUSY' });
    } finally { release(); await other.end(); }
    await running;
    assert.equal(s.writes.length, 1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE event_key='magento_sync.recovery_reconciled' AND subject_id=$1", [review.reviewHash])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT state FROM magento_sync_steps WHERE job_id=$1 AND ordinal=0', [job.id])).rows[0].state, 'verified');
  });
  await t.test('recovery authorization is rechecked inside the boundary before Magento reads', async () => {
    const { s, job } = await uncertain();
    await assert.rejects(recovery.inspect(config, job.id, { ...s.options, actorUserId: 99999999,
      fetchImpl: () => assert.fail('revoked actor cannot inspect remote') }), { code: 'ADMIN_PERMISSION_REVOKED' });
    assert.equal(s.writes.length, 1);
  });
  await t.test('a business save commits while read-only inspection is paused in Magento GET and invalidates subsequent reconciliation', async () => {
    const { s, job } = await uncertain();
    let reached, release;
    const entered = new Promise((resolve) => { reached = resolve; });
    const wait = new Promise((resolve) => { release = resolve; }); let paused = false;
    const fetchImpl = async (...args) => {
      if (!paused) { paused = true; reached(); await wait; }
      return s.options.fetchImpl(...args);
    };
    const inspection = recovery.inspect(config, job.id, { ...s.options, fetchImpl });
    inspection.catch(() => {}); await entered;
    const other = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 }); const writer = await other.connect();
    try {
      await writer.query('BEGIN'); await writer.query("SET LOCAL statement_timeout='1500ms'");
      // A separate connection proves no product/access/publication transaction
      // locks are held across the paused remote read, not merely that GET is used.
      await writer.query('SELECT pg_advisory_xact_lock(hashtext($1))',
        [require('../src/services/access-admin-transaction').APPLICATION_USER_ADMIN_LOCK_KEY]);
      await writer.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${job.installation_key}`]);
      await writer.query('UPDATE products SET weight=weight+1 WHERE id=$1', [s.product.id]);
      await writer.query('COMMIT');
    } finally {
      await writer.query('ROLLBACK'); writer.release(); await other.end(); release();
    }
    const review = await inspection;
    assert.equal(s.writes.length, 1);
    await assert.rejects(recovery.reconcile(config, job.id, request(review), s.options), { code: 'MAGENTO_RECOVERY_REVIEW_STALE' });
    assert.equal(s.writes.length, 1);
    assert.equal((await pool.query('SELECT state FROM magento_sync_steps WHERE job_id=$1 AND ordinal=0', [job.id])).rows[0].state, 'dispatched');
  });
  await t.test('exact recovery read suppresses incompatible lifecycle choices while the original job is unresolved', async () => {
    const { s, job } = await uncertain();
    await pool.query("UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',delivery_version=delivery_version+1 WHERE product_id=$1", [s.product.id]);
    const read = require('../src/services/magento/lifecycle-recovery').productRecovery;
    const visible = await read(config, s.product.id, { databasePool: pool, canRecoverJobs: true, canReconcileLifecycle: true });
    assert.equal(visible.productId, s.product.id); assert.equal(visible.job.id, job.id);
    assert.equal(visible.job.steps[0].state, 'dispatched'); assert.deepEqual(visible.lifecycle.availableKinds, []);
    assert.equal(visible.lifecycle.suggestedKind, null); assert.equal(visible.lifecycle.blocker, 'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED');
    assert.equal(visible.nextAction, null);
    const restricted = await read(config, s.product.id, { databasePool: pool, canRecoverJobs: false, canReconcileLifecycle: true });
    assert.equal(restricted.job, null); assert.equal(restricted.actions.jobRecovery, false);
  });
  await t.test('an externally appeared CREATE counterpart cannot be adopted without the original durable dispatch marker', async () => {
    const s = await scenario({ create: true }); const job = await s.enqueue();
    // Simulate another writer only inside the disposable fake Magento fixture.
    await s.options.fetchImpl(new URL('/rest/all/V1/products', config.baseUrl), {
      method: 'POST', redirect: 'manual', body: JSON.stringify(job.intent.operations[0].payload),
    });
    const writesBefore = s.writes.length;
    const review = await recovery.inspect(config, job.id, s.options);
    assert.equal(review.canReconcile, false); assert.equal(review.canContinue, false);
    assert.ok(review.blockers.some((b) => b.code === 'MAGENTO_SYNC_REMOTE_STATE_CHANGED'));
    await assert.rejects(recovery.reconcile(config, job.id, request(review), s.options));
    assert.equal(s.writes.length, writesBefore);
    assert.equal((await pool.query('SELECT count(*)::int n FROM magento_sync_steps WHERE job_id=$1', [job.id])).rows[0].n, 0);
  });
};
