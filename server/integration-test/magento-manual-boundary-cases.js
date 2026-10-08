const { runAccessAdminMutation, APPLICATION_USER_ADMIN_LOCK_KEY } = require('../src/services/access-admin-transaction');
const { enqueue, applyJob } = require('../src/services/magento/sync-job.service');

module.exports = async function manualBoundaryCases({ t, suite, scenario, config, installationKey, actorUserId }) {
  const { assert, pool, Pool, TEST_DATABASE_URL } = suite;
  const otherPool = () => new Pool({ connectionString: TEST_DATABASE_URL, statement_timeout: 2000 });
  const adminMutation = (db, operation) => runAccessAdminMutation({ databasePool: db, actorUserId,
    requiredPermission: 'export_templates.publish', createError: require('../src/services/magento/binding-contract').error, operation });
  function pauseRead(s) {
    let release, entered;
    const arrived = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    s.hooks.beforeRead = async () => { s.hooks.beforeRead = null; entered(); await hold; };
    return { arrived, release: () => release() };
  }
  const steps = id => pool.query('SELECT ordinal,state FROM magento_sync_steps WHERE job_id=$1 ORDER BY ordinal', [id]);

  await t.test('manual enqueue releases authority and product locks during GET and rejects a concurrently changed snapshot', async () => {
    const s = await scenario(), pause = pauseRead(s), other = otherPool();
    const pending = s.enqueue().then(value => ({ value }), error => ({ error }));
    await pause.arrived;
    try {
      await adminMutation(other, client => client.query('UPDATE products SET weight=weight+1 WHERE id=$1', [s.product.id]));
    } finally { pause.release(); await other.end(); }
    assert.equal((await pending).error.code, 'MAGENTO_SYNC_AMBER_CHANGED');
    assert.equal((await pool.query('SELECT count(*)::int n FROM magento_sync_jobs WHERE product_id=$1', [s.product.id])).rows[0].n, 0);
    assert.equal(s.writes.length, 0);
  });

  await t.test('manual APPLY rechecks a real concurrent product mutation after GET and before its first dispatch marker', async () => {
    const s = await scenario(), job = await s.enqueue(), pause = pauseRead(s), other = otherPool();
    const pending = s.apply(job); await pause.arrived;
    try {
      await adminMutation(other, client => client.query('UPDATE products SET weight=weight+1 WHERE id=$1', [s.product.id]));
    } finally { pause.release(); await other.end(); }
    const result = await pending;
    assert.equal(result.state, 'blocked'); assert.equal(result.failure.code, 'MAGENTO_SYNC_AMBER_CHANGED');
    assert.equal(s.writes.length, 0); assert.deepEqual((await steps(job.id)).rows, []);
    assert.equal(Number((await pool.query('SELECT weight FROM products WHERE id=$1', [s.product.id])).rows[0].weight), 6);
  });

  await t.test('manual in-flight HTTP retains only its SKU lane and does not block unrelated automatic delivery', async () => {
    await pool.query('UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2', [installationKey, actorUserId]);
    const s = await scenario(), unrelated = await scenario(), job = await s.enqueue(), other = otherPool();
    let release, entered;
    const arrived = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    s.hooks.beforeWrite = async () => { s.hooks.beforeWrite = null; entered(); await hold; };
    const pending = s.apply(job); await arrived;
    try {
      const client = await other.connect();
      try {
        await client.query('BEGIN');
        assert.equal((await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) held', [APPLICATION_USER_ADMIN_LOCK_KEY])).rows[0].held, true);
        await client.query('COMMIT');
      } finally { await client.query('ROLLBACK'); client.release(); }
      await require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(config,
        { databasePool: other, jobOptions: unrelated.options }).runProduct(unrelated.product.public_product_identity_id);
      assert.equal((await pool.query('SELECT state FROM magento_product_sync_requests WHERE product_id=$1', [unrelated.product.id])).rows[0].state, 'synced');
      assert.ok(unrelated.writes.length > 0);
      await assert.rejects(applyJob(config, job.id, { ...s.options, databasePool: other }), { code: 'MAGENTO_SYNC_BUSY' });
    } finally { release(); await pending; await other.end(); await pool.query('UPDATE magento_auto_sync_activation SET enabled=FALSE'); }
    assert.equal((await pool.query('SELECT state FROM magento_sync_jobs WHERE id=$1', [job.id])).rows[0].state, 'succeeded');
    assert.equal(s.writes.length, 4);
  });

  await t.test('manual APPLY observes permission revocation committed by an independent authority transaction during GET', async () => {
    const admin = await suite.authenticateApplicationSession();
    const actor = await suite.authenticateIdentitySession({ subject: 'manual-race-' + suite.crypto.randomUUID() });
    const roleResponse = await suite.request('/api/admin/roles', { authentication: admin, method: 'POST', body: {
      displayName: 'Manual sync race ' + suite.crypto.randomUUID(), description: 'Disposable fixture', permissionKeys: ['export_templates.publish'],
    } });
    assert.equal(roleResponse.response.status, 201, roleResponse.text);
    const role = roleResponse.data.role;
    const approved = await suite.request('/api/admin/users/' + actor.applicationUser.id + '/approve',
      { authentication: admin, method: 'POST', body: { roleId: role.id } });
    assert.equal(approved.response.status, 200, approved.text);
    const s = await scenario(), job = await s.enqueue(), pause = pauseRead(s), other = otherPool();
    const pending = applyJob(config, job.id, { ...s.options, actorUserId: Number(actor.applicationUser.id) });
    await pause.arrived;
    try {
      await adminMutation(other, client => client.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_key='export_templates.publish'", [role.id]));
    } finally { pause.release(); await other.end(); }
    const result = await pending;
    assert.equal(result.failure.code, 'ADMIN_PERMISSION_REVOKED');
    assert.equal(s.writes.length, 0); assert.deepEqual((await steps(job.id)).rows, []);
    assert.equal((await pool.query("SELECT count(*)::int n FROM role_permissions WHERE role_id=$1 AND permission_key='export_templates.publish'", [role.id])).rows[0].n, 0);
    const afterDispatch = await scenario({ create: true }), created = await afterDispatch.enqueue(), authority = otherPool();
    try {
      await adminMutation(authority, client => client.query("INSERT INTO role_permissions(role_id,permission_key) VALUES($1,'export_templates.publish')", [role.id]));
      afterDispatch.hooks.afterWrite = async () => {
        afterDispatch.hooks.afterWrite = null;
        await adminMutation(authority, client => client.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_key='export_templates.publish'", [role.id]));
      };
      const stopped = await applyJob(config, created.id, { ...afterDispatch.options, actorUserId: Number(actor.applicationUser.id) });
      assert.equal(stopped.failure.code,'ADMIN_PERMISSION_REVOKED');
      assert.equal(afterDispatch.writes.length,1);
      assert.deepEqual((await steps(created.id)).rows,[{ordinal:0,state:'verified'}]);
      await assert.rejects(applyJob(config,created.id,{...afterDispatch.options,actorUserId:Number(actor.applicationUser.id)}),
        {code:'ADMIN_PERMISSION_REVOKED'});
      assert.equal(afterDispatch.writes.length,1);
    } finally { await authority.end(); }
  });

  await t.test('manual CREATE preserves its verified first dispatch when local inputs change in flight and sends no later or repeated operation', async () => {
    const s = await scenario({ create: true }), job = await s.enqueue(), other = otherPool();
    s.hooks.afterWrite = async () => {
      s.hooks.afterWrite = null;
      await adminMutation(other, client => client.query('UPDATE products SET weight=weight+1 WHERE id=$1', [s.product.id]));
    };
    try {
      const result = await s.apply(job);
      assert.equal(result.state, 'blocked'); assert.equal(result.failure.code, 'MAGENTO_SYNC_AMBER_CHANGED');
      assert.equal(s.writes.length, 1); assert.equal(s.remote().status, 2);
      assert.deepEqual((await steps(job.id)).rows, [{ ordinal: 0, state: 'verified' }]);
      assert.equal((await s.apply(job)).state, 'blocked'); assert.equal(s.writes.length, 1);
      assert.deepEqual((await steps(job.id)).rows, [{ ordinal: 0, state: 'verified' }]);
    } finally { await other.end(); }
  });

  await t.test('reviewed acknowledgement revalidates local snapshot after its GET and preserves unresolved dispatch on a concurrent change', async () => {
    const recovery = require('../src/services/magento/sync-job-recovery');
    const s = await scenario(), job = await s.enqueue();
    s.hooks.afterWrite = async () => { s.hooks.afterWrite = null; s.hooks.readFailure = true; throw Error('synthetic lost response'); };
    assert.equal((await s.apply(job)).state, 'uncertain');
    s.hooks.readFailure = false;
    const inspection = await recovery.inspect(config, job.id, s.options);
    assert.equal(inspection.canReconcile, true);
    const pause = pauseRead(s), other = otherPool();
    const pending = recovery.reconcile(config, job.id, { review: inspection.review, reviewHash: inspection.reviewHash,
      reason: 'Synthetic reviewed receipt' }, s.options).then(value => ({ value }), error => ({ error }));
    await pause.arrived;
    try {
      await adminMutation(other, client => client.query('UPDATE products SET weight=weight+1 WHERE id=$1', [s.product.id]));
    } finally { pause.release(); await other.end(); }
    assert.equal((await pending).error.code, 'MAGENTO_SYNC_AMBER_CHANGED');
    assert.deepEqual((await steps(job.id)).rows, [{ ordinal: 0, state: 'dispatched' }]);
    assert.equal((await pool.query('SELECT state FROM magento_sync_jobs WHERE id=$1', [job.id])).rows[0].state, 'uncertain');
    assert.equal(s.writes.length, 1);
  });

  await t.test('real PostgreSQL advisory timeout parks the exact request with SQLSTATE/phase and preserves unrelated diagnostics', async () => {
    await pool.query('UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2', [installationKey, actorUserId]);
    const s = await scenario(), controller = await pool.connect();
    const short = new Pool({ connectionString: TEST_DATABASE_URL, statement_timeout: 500 });
    const events = [];
    try {
      await pool.query(`UPDATE magento_product_sync_requests SET diagnostics='[{"code":"ATTRIBUTE_NOT_FOUND","target":"fixture"}]'
        WHERE product_id=$1`, [s.product.id]);
      await controller.query('BEGIN');
      await controller.query('SELECT pg_advisory_xact_lock(hashtext($1))', [APPLICATION_USER_ADMIN_LOCK_KEY]);
      const blockerPid = (await controller.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const running = require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(config,
        { databasePool: short, jobOptions: s.options, logger: { error: (...args) => events.push(args) } })
        .runProduct(s.product.public_product_identity_id);
      let blocked = false;
      for (let i=0;i<60&&!blocked;i++) {
        blocked=(await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'
          AND $1=ANY(pg_blocking_pids(pid))) blocked`, [blockerPid])).rows[0].blocked;
        if (!blocked) await new Promise(resolve=>setTimeout(resolve,5));
      }
      assert.equal(blocked,true,'independent worker must actually wait on the held authority lock');
      await running;
      const request=(await pool.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1',[s.product.id])).rows[0];
      assert.equal(request.state,'needs_attention'); assert.equal(request.reason_code,'unexpected_failure');
      assert.deepEqual(request.diagnostics,[{code:'LOCAL_DATABASE_FAILURE',sqlState:'57014',phase:'authority_lock'},
        {code:'ATTRIBUTE_NOT_FOUND',target:'fixture'}]);
      assert.equal(request.active_job_id,null); assert.equal(request.synced_generation,'0');
      assert.equal((await pool.query('SELECT count(*)::int n FROM magento_sync_jobs WHERE product_id=$1',[s.product.id])).rows[0].n,0);
      assert.equal(s.writes.length,0);
      assert(events.some(([,detail])=>detail.sqlState==='57014'&&detail.phase==='authority_lock'));
      assert.doesNotMatch(JSON.stringify(events),/password|OAuth|STATEMENT|SELECT pg|fake-secret/);
    } finally {
      await controller.query('ROLLBACK'); controller.release(); await short.end();
      await pool.query('UPDATE magento_auto_sync_activation SET enabled=FALSE');
    }
  });
};
