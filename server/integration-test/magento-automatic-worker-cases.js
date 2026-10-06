const { createAutomaticSyncWorker } = require('../src/services/magento/automatic-sync-worker');

module.exports = async function automaticCases({ t, suite, scenario, config, published, installationKey, actorUserId, makeDraft }) {
  const { assert, pool, Pool, TEST_DATABASE_URL } = suite;
  const state = async (id) => (await pool.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1', [id])).rows[0];
  const enable = () => pool.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2`, [installationKey, actorUserId]);
  const disable = () => pool.query('UPDATE magento_auto_sync_activation SET enabled=FALSE');
  const worker = (s, db = pool) => createAutomaticSyncWorker(config, { databasePool: db, jobOptions: s.options });
  const edit = (id, db = pool) => db.query('UPDATE products SET total_price_uah=total_price_uah+1 WHERE id=$1', [id]);
  const identity = (s) => s.product.public_product_identity_id;
  const automatic = (s, generation) => ({ ...s.options,
    automatic: { publicIdentityId: identity(s), productId: s.product.id, generation, installationKey } });

  await t.test('automatic disabled records no obligation and does no remote work, while manual enqueue works', async () => {
    await disable(); const s = await scenario(); await edit(s.product.id);
    assert.equal(await state(s.product.id), undefined);
    s.hooks.readFailure = true; await worker(s).tick(); assert.equal(s.writes.length, 0);
    s.hooks.readFailure = false; assert.equal((await s.enqueue()).state, 'queued');
  });
  await enable();
  try {
    await t.test('automatic trigger and business writes commit or roll back together', async () => {
      const s = await scenario(); const before = await state(s.product.id);
      assert.equal(before.desired_generation, '1');
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN'); await edit(s.product.id, connection);
        assert.equal((await connection.query('SELECT desired_generation FROM magento_product_sync_requests WHERE product_id=$1', [s.product.id])).rows[0].desired_generation, '2');
        await connection.query('ROLLBACK');
      } finally { connection.release(); }
      assert.deepEqual(await state(s.product.id), before);
      await pool.query("UPDATE products SET details=jsonb_set(details,'{logMessage}','\"metadata only\"') WHERE id=$1", [s.product.id]);
      assert.equal((await state(s.product.id)).desired_generation, '1');
    });
    await t.test('automatic rapid concurrent mutations coalesce without losing a generation', async () => {
      const s = await scenario({ create: true }); const other = new Pool({ connectionString: TEST_DATABASE_URL });
      const connection = await pool.connect(); const contender = await other.connect(); let racing;
      try {
        await connection.query('BEGIN'); await edit(s.product.id, connection);
        const pid = (await contender.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        racing = edit(s.product.id, contender);
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          blocked = (await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true, 'independent writer must actually wait on the first transaction');
        await connection.query('COMMIT'); await racing;
        assert.equal((await state(s.product.id)).desired_generation, '3');
        await worker(s).runProduct(identity(s));
        const row = await state(s.product.id);
        assert.equal(row.state, 'synced'); assert.equal(row.synced_generation, '3');
        assert.equal(s.remote().price, 44, 'planner must dispatch the latest authoritative price');
        assert.equal((await pool.query('SELECT count(*)::int n FROM magento_sync_jobs WHERE product_id=$1', [s.product.id])).rows[0].n, 1);
      } finally { await connection.query('ROLLBACK'); await racing; connection.release(); contender.release(); await other.end(); }
    });
    await t.test('automatic worker uses published current revision while a newer draft exists', async () => {
      const s = await scenario(); await makeDraft();
      await worker(s).runProduct(identity(s));
      const job = (await pool.query('SELECT * FROM magento_sync_jobs WHERE product_id=$1', [s.product.id])).rows[0];
      assert.equal(job.binding_revision_id, published.id); assert.equal(job.state, 'succeeded');
      const response = await suite.request('/api/product-timeline?sku=' + encodeURIComponent(s.input.sku),
        { authentication: await suite.authenticateApplicationSession() });
      assert.equal(response.response.status, 200, response.text);
      assert.deepEqual(response.data.lineage.products[0].magentoSync, { state: 'synced', reason: null, confirmedAt: new Date(job.acknowledged_at).toISOString() });
    });
    await t.test('automatic A to B to A is a new generation, never an old successful receipt', async () => {
      const s = await scenario(); await worker(s).runProduct(identity(s));
      const original = (await pool.query('SELECT total_price_uah FROM products WHERE id=$1', [s.product.id])).rows[0].total_price_uah;
      await edit(s.product.id);
      await worker(s).runProduct(identity(s));
      assert.equal(s.remote().price, 43);
      await pool.query('UPDATE products SET total_price_uah=$2 WHERE id=$1', [s.product.id, original]);
      await worker(s).runProduct(identity(s));
      const row = await state(s.product.id);
      assert.equal(row.synced_generation, '3'); assert.equal(row.state, 'synced');
      assert.equal(s.remote().price, 42);
      assert.equal((await pool.query('SELECT count(*)::int n FROM magento_sync_jobs WHERE product_id=$1', [s.product.id])).rows[0].n, 3);
    });
    await t.test('automatic missing publication and blocked product become needs_attention without writes', async () => {
      const s = await scenario();
      await pool.query("UPDATE magento_auto_sync_activation SET installation_key='missing-test-publication'");
      await worker(s).runProduct(identity(s)); assert.equal((await state(s.product.id)).state, 'needs_attention');
      await enable();
      await pool.query("UPDATE products SET exclude_from_export=1 WHERE id=$1", [s.product.id]);
      await worker(s).runProduct(identity(s));
      assert.equal((await state(s.product.id)).state, 'needs_attention'); assert.equal(s.writes.length, 0);
    });
    await t.test('automatic Magento outage does not roll back a save and retries only pre-dispatch', async () => {
      const s = await scenario(); s.hooks.readFailure = true; await edit(s.product.id);
      await worker(s).runProduct(identity(s));
      assert.equal((await state(s.product.id)).desired_generation, '2');
      assert.equal((await state(s.product.id)).state, 'pending'); assert.equal(s.writes.length, 0);
      assert.equal((await suite.request('/health/ready', { authentication: null })).response.status, 200);
      s.hooks.readFailure = false; await worker(s).runProduct(identity(s));
      assert.equal((await state(s.product.id)).state, 'synced');
    });
    await t.test('automatic disable fences the next dispatch and re-enable resumes only unsent steps', async () => {
      const s = await scenario();
      s.hooks.afterWrite = async () => { s.hooks.afterWrite = null; await disable(); };
      await worker(s).runProduct(identity(s)); assert.equal(s.writes.length, 1);
      await worker(s).runProduct(identity(s)); assert.equal(s.writes.length, 1);
      await enable(); await worker(s).runProduct(identity(s));
      assert.equal((await state(s.product.id)).state, 'synced');
      assert.equal(s.writes.filter((w) => w.body.product?.name === 'Amber name').length, 1);
    });
    await t.test('automatic in-flight Magento call does not lock Amber saves; older success leaves latest generation pending', async () => {
      const s = await scenario(); let release; let entered;
      const arrival = new Promise((r) => { entered = r; }); const hold = new Promise((r) => { release = r; });
      s.hooks.beforeWrite = async () => { entered(); await hold; };
      const other = new Pool({ connectionString: TEST_DATABASE_URL, statement_timeout: 1500 });
      const running = worker(s).runProduct(identity(s)); await arrival;
      try {
        await edit(s.product.id, other);
        await worker(s, other).runProduct(identity(s)); // another replica cannot dispatch
        assert.equal(s.writes.length, 1);
      } finally { release(); await running; await other.end(); }
      const row = await state(s.product.id);
      assert.equal(row.desired_generation, '2'); assert.equal(row.synced_generation, '1'); assert.equal(row.state, 'pending');
      assert.equal(s.remote().price, 42);
      s.hooks.beforeWrite = null; await worker(s).runProduct(identity(s));
      assert.equal((await state(s.product.id)).synced_generation, '2');
      assert.equal(s.remote().price, 43);
    });
    await t.test('automatic stale undispatched intent is superseded safely on restart', async () => {
      const s = await scenario();
      const job = await require('../src/services/magento/sync-job.service').enqueue(config, s.input, automatic(s, '1'));
      await edit(s.product.id);
      const restartedPool = new Pool({ connectionString: TEST_DATABASE_URL });
      try { await worker(s, restartedPool).runProduct(identity(s)); } finally { await restartedPool.end(); }
      assert.equal((await pool.query('SELECT state FROM magento_sync_jobs WHERE id=$1', [job.id])).rows[0].state, 'superseded');
      assert.equal((await state(s.product.id)).synced_generation, '2');
    });
    await t.test('automatic uncertain dispatch survives process restart and later edits without resend', async () => {
      const s = await scenario(); s.hooks.noMutation = true;
      await worker(s).runProduct(identity(s)); const row = await state(s.product.id);
      assert.equal(row.reason_code, 'reconciliation_required'); assert.equal(s.writes.length, 1);
      await edit(s.product.id); assert.equal((await state(s.product.id)).state, 'needs_attention');
      await suite.runNodeInDatabase(TEST_DATABASE_URL, `
        const assert=require('node:assert/strict'); const pool=require('./src/db/pool');
        const {createAutomaticSyncWorker}=require('./src/services/magento/automatic-sync-worker');
        let calls=0;
        const worker=createAutomaticSyncWorker(${JSON.stringify(config)}, {databasePool:pool,
          jobOptions:{fetchImpl:async()=>{calls++;throw new Error('network forbidden');}}});
        worker.runProduct(${identity(s)}).then(async()=>{
          assert.equal(calls,0);
          const r=(await pool.query('SELECT state,desired_generation FROM magento_product_sync_requests WHERE product_id=$1',[${s.product.id}])).rows[0];
          assert.equal(r.state,'needs_attention');assert.equal(r.desired_generation,'2');
        }).finally(()=>pool.end()).catch(e=>{console.error(e);process.exitCode=1;});`);
      assert.equal(s.writes.length, 1);
    });
    await t.test('automatic worker refuses an existing uncertain manual job and a crash left at dispatched', async () => {
      const s = await scenario(); const manual = await s.enqueue(); s.hooks.noMutation = true;
      assert.equal((await s.apply(manual)).state, 'uncertain');
      await worker(s).runProduct(identity(s));
      assert.equal((await state(s.product.id)).reason_code, 'reconciliation_required'); assert.equal(s.writes.length, 1);
      const crashed = await scenario(); crashed.hooks.noMutation = true;
      await worker(crashed).runProduct(identity(crashed));
      const row = await state(crashed.product.id);
      await pool.query("UPDATE magento_sync_jobs SET state='running' WHERE id=$1", [row.active_job_id]);
      await worker(crashed).runProduct(identity(crashed));
      assert.equal((await state(crashed.product.id)).reason_code, 'reconciliation_required'); assert.equal(crashed.writes.length, 1);
    });
    await t.test('automatic recovery acknowledges only the generation attached to an already succeeded job', async () => {
      const s = await scenario(); const service = require('../src/services/magento/sync-job.service');
      const opts = automatic(s, '1'); const job = await service.enqueue(config, s.input, opts);
      assert.equal((await service.applyJob(config, job.id, opts)).state, 'succeeded');
      await edit(s.product.id); await worker(s).runProduct(identity(s));
      const row = await state(s.product.id);
      assert.equal(row.synced_generation, '1'); assert.equal(row.desired_generation, '2'); assert.equal(row.state, 'pending');
    });
  } finally { await disable(); }
};
