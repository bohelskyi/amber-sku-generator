const suite = require('./suite-context');
const { test, assert, request, authenticateApplicationSession, authenticateIdentitySession, crypto, pool } = suite;
const { insertProductFixture } = require('./product-fixture');

test('Magento recovery HTTP boundaries require authenticated active users, CSRF and independently delegated capabilities', async () => {
  const admin = await authenticateApplicationSession();
  const actor = await authenticateIdentitySession({ subject: `recovery-${crypto.randomUUID()}` });
  const root = '/api/admin/magento-recovery';
  const id = crypto.randomUUID();
  const calls = [
    [`${root}/products/2147483647`, 'GET', null],
    [`${root}/jobs/${id}`, 'GET', 'export_templates.publish'],
    ...['inspect', 'reconcile', 'continue'].map((action) => [`${root}/jobs/${id}/${action}`, 'POST', 'export_templates.publish']),
    ...['lifecycle-preview', 'lifecycle-apply'].map((action) => [`${root}/products/2147483647/${action}`, 'POST', 'exports.reconcile']),
    [`${root}/products/2147483647/history-inspect`, 'POST', 'exports.reconcile'],
  ];
  for (const [url, method] of calls) {
    const unauthenticated = await request(url, { method, body: method === 'GET' ? undefined : {}, authentication: null });
    assert.equal(unauthenticated.response.status, 401); assert.equal(unauthenticated.response.headers.get('location'), null);
    const pending = await request(url, { method, body: method === 'GET' ? undefined : {}, authentication: actor });
    assert.equal(pending.response.status, 403); assert.equal(pending.data.code, 'APP_ACCESS_PENDING');
    if (method !== 'GET') {
      const denied = await request(url, { method, body: {}, authentication: admin, csrfToken: null });
      assert.equal(denied.response.status, 403);
    }
  }
  const created = await request('/api/admin/roles', { authentication: admin, method: 'POST', body: {
    displayName: `Recovery ${crypto.randomUUID()}`, description: 'Recovery delegation fixture', permissionKeys: [],
  } });
  assert.equal(created.response.status, 201, created.text); let role = created.data.role;
  assert.equal((await request(`/api/admin/users/${actor.applicationUser.id}/approve`, { authentication: admin,
    method: 'POST', body: { roleId: role.id } })).response.status, 200);
  async function grant(permissionKeys) {
    const result = await request(`/api/admin/roles/${role.id}/permissions`, { authentication: admin, method: 'PUT', body: {
      permissionKeys, expectedVersion: role.version, expectedActiveAssignedUserCount: 1,
    } });
    assert.equal(result.response.status, 200, result.text); role = result.data.role;
  }
  for (const [url, method] of calls) {
    const denied = await request(url, { method, body: method === 'GET' ? undefined : {}, authentication: actor });
    assert.equal(denied.response.status, 403); assert.equal(denied.data.code, 'INSUFFICIENT_PERMISSION');
  }
  for (const capability of ['exports.reconcile', 'export_templates.publish']) {
    await grant([capability]);
    for (const [url, method, required] of calls) {
      const result = await request(url, { method, body: method === 'GET' ? undefined : {}, authentication: actor });
      if (required && required !== capability) assert.equal(result.response.status, 403, result.text);
      else assert.ok([404, 422].includes(result.response.status), result.text);
    }
  }
  await pool.query("UPDATE application_users SET status='disabled',deactivated_at=CURRENT_TIMESTAMP WHERE id=$1", [actor.applicationUser.id]);
  for (const [url, method] of calls) {
    const denied = await request(url, { method, body: method === 'GET' ? undefined : {}, authentication: actor });
    assert.equal(denied.response.status, 403); assert.equal(denied.data.code, 'APP_ACCESS_DISABLED');
  }
});

test('historical recovery diagnoses changed public articles and inspects both exact SKUs without granting a repair or changing data', async t => {
  const name = 'amber_recovery_history_test', url = await suite.recreateTestDatabase(name);
  const db = new suite.Pool({ connectionString: url });
  const history = require('../src/services/magento/recovery-history');
  const lifecycle = require('../src/services/magento/lifecycle-recovery');
  const config = require('../src/config/magento').parseMagentoConfig({ MAGENTO_BASE_URL: 'https://history.example.invalid',
    MAGENTO_CONSUMER_KEY: 'fake', MAGENTO_CONSUMER_SECRET: 'fake', MAGENTO_ACCESS_TOKEN: 'fake', MAGENTO_ACCESS_TOKEN_SECRET: 'fake' });
  try {
    await suite.runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','History test') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    await db.query("INSERT INTO categories(code,name) VALUES('KL','Кулони')");
    const source = (await insertProductFixture(db, "INSERT INTO products(full_sku,category,total_price_uah) VALUES('KL-OLD','KL',100) RETURNING id")).rows[0];
    const current = (await insertProductFixture(db, "INSERT INTO products(full_sku,category,total_price_uah,corrected_from_product_id) VALUES('KL-CURRENT','KL',100,$1) RETURNING id", [source.id])).rows[0];
    await db.query("UPDATE products SET status='corrected',corrected_to_product_id=$2,exclude_from_export=1 WHERE id=$1", [source.id, current.id]);
    const correction = (await db.query("INSERT INTO product_corrections(source_product_id,corrected_product_id,source_sku,corrected_sku) VALUES($1,$2,'KL-OLD','KL-CURRENT') RETURNING id", [source.id, current.id])).rows[0];
    await db.query("UPDATE product_full_export_state SET route='retired',delivery_version=delivery_version+1,business_exclusion_state='unknown' WHERE product_id=$1", [source.id]);
    await db.query("UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1", [current.id]);
    const conn = await db.connect();
    try {
      await conn.query('BEGIN'); await conn.query("SET LOCAL amber.magento_delivery_cutover='on'");
      const event = (await conn.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
        VALUES('magento_delivery.cutover',$1,'{"displayName":"History test","preferredUsername":null}','fixture','singleton','history') RETURNING id`, [actor])).rows[0].id;
      await conn.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='history-test',actor_user_id=$1,
        legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`, [actor, event]);
      await conn.query('COMMIT');
    } finally { await conn.query('ROLLBACK'); conn.release(); }
    const reads = [];
    const fetchImpl = async (address, init) => {
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
      const sku = new URL(address).searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'); reads.push(sku);
      return new Response(JSON.stringify({ total_count: sku === 'KL-OLD' ? 1 : 0, items: sku === 'KL-OLD' ? [{ id: 42, sku }] : [] }), { headers: { 'content-type': 'application/json' } });
    };
    const options = { databasePool: db, mutationContext: { actorUserId: actor }, fetchImpl, canRecoverJobs: true, canReconcileLifecycle: true };
    const state = async () => (await db.query(`SELECT
      (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,
      (SELECT jsonb_agg(c ORDER BY id) FROM product_corrections c) corrections,
      (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) lifecycle,
      (SELECT jsonb_agg(r ORDER BY full_sku) FROM sku_registry r) reservations,
      (SELECT jsonb_agg(r ORDER BY product_id) FROM magento_product_sync_requests r) requests,
      (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM magento_sync_jobs) jobs,
      (SELECT count(*) FROM magento_binding_handoffs) handoffs`)).rows[0];
    await t.test('local recovery never recommends the stable recipe for different public identities or calls Magento', async () => {
      const before = await state(), record = await lifecycle.productRecovery(config, current.id, options);
      assert.equal(record.history.identityChanged, true); assert.equal(record.history.stableRecount, false);
      assert.equal(record.lifecycle.suggestedKind, null); assert.deepEqual(record.lifecycle.availableKinds, []);
      assert.deepEqual(record.history.products.map(p => p.article), ['KL-CURRENT', 'KL-OLD']);
      assert.deepEqual(record.history.issues, [{ code: 'SOURCE_CORRECTION_NOT_RECORDED', productId: current.id, correctionId: correction.id, recordedCorrectionId: null }]);
      assert.deepEqual(reads, []); assert.deepEqual(await state(), before);
    });
    await t.test('explicit inspection reads both articles, retains missing evidence and writes no local or remote state', async () => {
      const before = await state(), result = await history.inspect(config, current.id, options);
      assert.equal(result.stale, false); assert.equal(result.remoteWrites, 0);
      assert.deepEqual(result.remote.map(r => [r.article, r.status]), [['KL-CURRENT', 'not_found'], ['KL-OLD', 'found']]);
      assert.deepEqual(reads, ['KL-CURRENT', 'KL-OLD']); assert.deepEqual(await state(), before);
      const failed = await history.inspect(config, current.id, { ...options, fetchImpl: async () => { throw new Error('offline'); } });
      assert.ok(failed.remote.every(r => r.status === 'lookup_error')); assert.equal(failed.history.identityChanged, true);
      assert.deepEqual(await state(), before);
    });
    await t.test('reviewing an independent exclusion retains the separate history step instead of suggesting resync', async () => {
      await db.query("UPDATE product_full_export_state SET business_exclusion_state='unknown',delivery_version=delivery_version+1 WHERE product_id=$1", [current.id]);
      const before = await state();
      const review = await lifecycle.preview(config, current.id, { kind: 'release_exclusion' }, options);
      assert.equal(review.eligible, true); assert.deepEqual(review.review.nextAction, { kind: 'review_history', productId: current.id });
      assert.deepEqual(await state(), before);
    });
    await t.test('revoked actor fails before remote reads and a real independent writer marks the observed history stale', async () => {
      await assert.rejects(history.inspect(config, current.id, { ...options, mutationContext: { actorUserId: 99999999 },
        fetchImpl: () => assert.fail('revoked actor must not reach Magento') }), { code: 'ADMIN_PERMISSION_REVOKED' });
      let reached, release; const entered = new Promise(resolve => { reached = resolve; }); const wait = new Promise(resolve => { release = resolve; });
      let first = true;
      const inspection = history.inspect(config, current.id, { ...options, fetchImpl: async (...args) => {
        if (first) { first = false; reached(); await wait; } return fetchImpl(...args);
      } }); inspection.catch(() => {}); await entered;
      const other = new suite.Pool({ connectionString: url });
      try { await other.query("UPDATE product_full_export_state SET business_exclusion_state='excluded',delivery_version=delivery_version+1 WHERE product_id=$1", [current.id]); }
      finally { release(); await other.end(); }
      const result = await inspection; assert.equal(result.stale, true);
      assert.ok(result.history.issues.some(v => v.code === 'SOURCE_CORRECTION_NOT_RECORDED'));
      assert.equal(result.history.products.find(p => p.productId === current.id).businessExclusion, 'unknown');
      assert.equal((await history.read(db, current.id)).products.find(p => p.productId === current.id).businessExclusion, 'excluded');
    });
  } finally { await db.end(); await suite.dropTestDatabase(name); }
});
