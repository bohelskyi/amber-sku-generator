const suite = require('./suite-context');

suite.test('lifecycle hold read models preserve saved state and create no jobs, audits or remote requests', async (t) => {
  const { assert, Pool, runNodeInDatabase, recreateTestDatabase, dropTestDatabase } = suite;
  const name = 'amber_lifecycle_reads_test'; const url = await recreateTestDatabase(name);
  const db = new Pool({ connectionString: url });
  try {
    await runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    await db.query("INSERT INTO categories(code,name) VALUES('SV','Synthetic hold fixture')");
    // Insert synthetic held evidence, never repair or release an existing row.
    const product = (await db.query(`WITH p AS (
      INSERT INTO products(full_sku,category,total_price_uah) VALUES('SV5111010','SV',42) RETURNING *
    ), f AS (INSERT INTO product_full_export_state(product_id,route,hold_reason,evidence)
      SELECT id,'hold','historical_ambiguity',
      '{"origin":"recount","classification":"historical_ambiguous","primaryReason":"INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP","ancestorProductIds":[1368],"privatePayload":"must-not-leak"}'::jsonb FROM p)
    SELECT * FROM p`)).rows[0];
    await db.query(`INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id,desired_generation,state,reason_code,diagnostics)
      VALUES($1,$2,7,'needs_attention','data_or_binding','[{"code":"AMBER_SYNC_ELIGIBILITY_UNRESOLVED"}]')`,
    [product.public_product_identity_id, product.id]);
    const snapshot = async () => (await db.query(`SELECT
      (SELECT jsonb_agg(f) FROM product_full_export_state f) lifecycle,
      (SELECT jsonb_agg(r) FROM magento_product_sync_requests r) requests,
      (SELECT count(*) FROM magento_sync_jobs) jobs,
      (SELECT count(*) FROM audit_events) audits`)).rows[0];
    const before = await snapshot();
    t.mock.method(globalThis, 'fetch', () => assert.fail('Local status must not contact Magento'));
    const client = await db.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const config = { configured: true, baseUrl: 'https://local-fixture.invalid' };
      const service = require('../src/services/magento/sync-problems');
      const list = await service.problems(config, client);
      const page = await service.problemPage(config, {}, client);
      const statuses = await require('../src/services/magento/automatic-sync-status').readStatuses(client, [product.id]);
      const counts = await require('../src/services/magento/integration-overview').operationalCounts(client, 'unconfigured');
      for (const item of [list[0], page.items[0]]) {
        assert.equal(item.article, 'SV5111010');
        assert.equal(item.problems[0].resolution, 'lifecycle_reconciliation');
        assert.equal(JSON.stringify(item).includes('must-not-leak'), false);
      }
      assert.equal(statuses.get(product.id).problems[0].eligibilityIssue.deliveryVersion, '1');
      assert.equal(counts.categories.get('SV').reasons[0].resolution, 'lifecycle_reconciliation');
      assert.equal(counts.count, 1);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.deepEqual(await snapshot(), before);
    assert.equal(before.jobs, '0');
    assert.equal(before.requests[0].attempts, 0);
  } finally { await db.end(); await dropTestDatabase(name); }
});

suite.test('automatic Magento obligations cover authoritative create rollback price repricing recount and correction transactions', async () => {
  const name = 'amber_automatic_mutations_test'; const url = await suite.recreateTestDatabase(name);
  try {
    await suite.runNodeInDatabase(url, "require('./integration-test/magento-automatic-mutations-worker').run().catch(e=>{console.error(e);process.exitCode=1;})");
  } finally { await suite.dropTestDatabase(name); }
});

suite.test('automatic sync migration 044 upgrades checkpoint 043 atomically without enrolling legacy products', async () => {
  const { fs, os, path, Pool, assert, serverRoot, runNodeInDatabase, recreateTestDatabase, dropTestDatabase } = suite;
  const name = 'amber_automatic_migration_test'; const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-auto-043-')); const db = new Pool({ connectionString: url });
  const migrate = () => runNodeInDatabase(url, `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;})`);
  try {
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations'))).filter((f) => f.endsWith('.sql') && f < '044')) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    await migrate(); const before = (await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    await db.query("INSERT INTO categories(code,name) VALUES('MT','Legacy migration fixture')");
    await require('./product-fixture').insertProductFixture(db, "INSERT INTO products(full_sku,category,total_price_uah) VALUES('MT-LEGACY','MT',100) RETURNING id");
    const file = '044_magento_automatic_sync.sql'; const sql = await fs.readFile(path.join(serverRoot, 'migrations', file), 'utf8');
    await fs.writeFile(path.join(directory, file), sql + '\nSELECT 1/0;');
    await assert.rejects(migrate(), /division by zero/);
    assert.equal((await db.query("SELECT to_regclass('magento_product_sync_requests') AS present")).rows[0].present, null);
    assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows, before);
    await fs.writeFile(path.join(directory, file), sql); await migrate(); await migrate();
    assert.equal((await db.query('SELECT enabled FROM magento_auto_sync_activation')).rows[0].enabled, false);
    assert.equal((await db.query('SELECT count(*)::int n FROM magento_product_sync_requests')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int n FROM products')).rows[0].n, 1);
    assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name<'044' ORDER BY name")).rows, before);
  } finally {
    await db.end(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('amber-auto-043-'));
    await fs.rm(directory, { recursive: true, force: true }); await dropTestDatabase(name);
  }
});
