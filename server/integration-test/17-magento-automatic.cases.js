const suite = require('./suite-context');

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
