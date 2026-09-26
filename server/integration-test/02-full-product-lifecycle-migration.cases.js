const { test, assert, pool, Pool, fs, os, path, serverRoot, runNodeInDatabase,
  recreateTestDatabase, dropTestDatabase, runMigrations } = require('./suite-context');

test('migration 039 fresh schema enforces complete products, counters, routes and immutable membership', async () => {
  const before = (await pool.query('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows;
  assert.equal(before.length, 40);
  await runMigrations();
  assert.deepEqual((await pool.query('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows, before);
  const grants = (await pool.query(`SELECT role_key FROM roles r JOIN role_permissions p ON p.role_id=r.id
    WHERE permission_key='exports.reconcile' ORDER BY role_key`)).rows;
  assert.deepEqual(grants, [{ role_key: 'administrator' }]);
  await assert.rejects(pool.query(`INSERT INTO products(full_sku,category) VALUES('ZZ-MISSING-LIFECYCLE','ZZ')`), /requires full export state/);
  assert.equal((await pool.query("SELECT * FROM sku_registry WHERE full_sku='ZZ-MISSING-LIFECYCLE'")).rows.length, 0);
  const id = (await pool.query('SELECT product_id FROM product_full_export_state ORDER BY product_id LIMIT 1')).rows[0].product_id;
  for (const sql of ["revision=0", "delivery_version=0", "confirmed_revision=revision+1",
    "route='hold'", "route='normal',hold_reason='prior_exposure'", "evidence='[]'::jsonb",
    "repair_manifest_hash='bad'"]) await assert.rejects(pool.query(`UPDATE product_full_export_state SET ${sql} WHERE product_id=$1`, [id]));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE product_full_export_state SET revision=revision+1, delivery_version=delivery_version+1 WHERE product_id=$1', [id]);
    await assert.rejects(client.query('UPDATE product_full_export_state SET revision=revision-1 WHERE product_id=$1', [id]), /cannot regress/);
  } finally { await client.query('ROLLBACK'); client.release(); }
  for (const counter of ['confirmed_revision', 'delivery_version']) {
    const transaction = await pool.connect();
    try {
      await transaction.query('BEGIN');
      await transaction.query(`UPDATE product_full_export_state SET revision=3,confirmed_revision=2,delivery_version=3 WHERE product_id=$1`, [id]);
      await assert.rejects(transaction.query(`UPDATE product_full_export_state SET ${counter}=${counter}-1 WHERE product_id=$1`, [id]), /cannot regress/);
    } finally { await transaction.query('ROLLBACK'); transaction.release(); }
  }
  await assert.rejects(pool.query(`INSERT INTO export_snapshots(id,idempotency_key,from_sku,resolved_to_sku,
    exported_to_product_id,row_count,file_name,csv_content,full_product_lifecycle_version)
    VALUES('incomplete-lifecycle','incomplete-lifecycle','x','x',1,1,'x.csv','sku',1)`), /requires complete exact product membership/);
  assert.equal((await pool.query("SELECT * FROM export_snapshots WHERE id='incomplete-lifecycle'")).rows.length, 0);
  const delegation = await pool.connect();
  try {
    await delegation.query('BEGIN');
    const role = (await delegation.query(`INSERT INTO roles(role_key,display_name,description,is_system)
      VALUES('phase1_reconcile','Phase 1 reconciliation','Delegable fixture',false) RETURNING id`)).rows[0];
    await delegation.query("INSERT INTO role_permissions(role_id,permission_key) VALUES($1,'exports.reconcile')", [role.id]);
    assert.equal((await delegation.query('SELECT * FROM role_permissions WHERE role_id=$1', [role.id])).rows.length, 1);
  } finally { await delegation.query('ROLLBACK'); delegation.release(); }
  for (const sql of ['DELETE FROM product_full_export_state', 'TRUNCATE product_full_export_state']) {
    await assert.rejects(pool.query(sql), /permanent/);
  }
  const indexes = (await pool.query("SELECT indexname FROM pg_indexes WHERE tablename IN ('product_full_export_state','export_snapshot_products')")).rows;
  assert.equal(indexes.length, 7);
});

test('migration 039 upgrade from 038 is conservative, transactional and repeatable with unchanged historical checksums', async () => {
  const databaseName = 'amber_full_lifecycle_upgrade_test';
  const url = await recreateTestDatabase(databaseName);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-lifecycle-038-'));
  const db = new Pool({ connectionString: url });
  const migrate = () => runNodeInDatabase(url, `const db=require('./src/db/pool');
    require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}})
      .finally(()=>db.end()).catch(e=>{console.error(e);process.exitCode=1;});`);
  try {
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations'))).filter((f) => f.endsWith('.sql') && f < '039')) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    await migrate();
    await db.query(`INSERT INTO categories(code,name) VALUES('HX','Historical');
      INSERT INTO products(full_sku, category, status, exclude_from_export) VALUES
      ('HX-A','HX','active',0),('HX-B','HX','active',1),('HX-C','HX','corrected',1),('HX-D','HX','archived',1);
      UPDATE export_state SET exported_to_product_id=2;
      INSERT INTO export_snapshots(id,idempotency_key,from_sku,resolved_to_sku,exported_to_product_id,row_count,file_name,csv_content)
      VALUES('old','old','HX-A','HX-A',1,1,'old.csv',E'sku,price_uah,size\\nHX-A,,')`);
    const checksums = (await db.query('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows;
    const snapshots = (await db.query('SELECT to_jsonb(s) AS data FROM export_snapshots s')).rows;
    const products = (await db.query('SELECT id,full_sku,status,exclude_from_export FROM products ORDER BY id')).rows;
    const sql = await fs.readFile(path.join(serverRoot, 'migrations/039_full_product_export_lifecycle.sql'), 'utf8');
    const target = path.join(directory, '039_full_product_export_lifecycle.sql');
    await fs.writeFile(target, `${sql}\nSELECT 1/0;\n`);
    await assert.rejects(migrate(), /division by zero/);
    assert.equal((await db.query("SELECT to_regclass('product_full_export_state') AS t")).rows[0].t, null);
    assert.equal((await db.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='products' AND column_name='magento_name_review_required'")).rows[0].n, 0);
    assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows, checksums);
    await fs.writeFile(target, sql);
    await migrate(); await migrate();
    assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name < '039' ORDER BY name")).rows, checksums);
    assert.deepEqual((await db.query('SELECT id,full_sku,status,exclude_from_export FROM products ORDER BY id')).rows, products);
    assert.deepEqual((await db.query("SELECT to_jsonb(s)-'full_product_lifecycle_version' AS data FROM export_snapshots s")).rows, snapshots);
    assert.deepEqual((await db.query('SELECT route,hold_reason,revision,confirmed_revision FROM product_full_export_state ORDER BY product_id')).rows,
      ['hold','hold','retired','retired'].map((route) => ({ route, hold_reason: route === 'hold' ? 'historical_ambiguity' : null, revision: '1', confirmed_revision: '0' })));
    assert.equal((await db.query('SELECT * FROM export_snapshot_products')).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM audit_events')).rows.length, 0);
    await assert.rejects(db.query("UPDATE export_snapshots SET full_product_lifecycle_version=1 WHERE id='old'"), /provenance is immutable/);
    const born = await db.connect();
    try {
      await born.query('BEGIN');
      const p = (await born.query("INSERT INTO products(full_sku,category) VALUES('HX-NEW','HX') RETURNING id")).rows[0];
      await require('../src/services/full-product-export.service').initializeNewProduct(born, p.id);
      await born.query('COMMIT');
      assert.equal((await db.query('SELECT route FROM product_full_export_state WHERE product_id=$1', [p.id])).rows[0].route, 'normal');
    } finally { await born.query('ROLLBACK'); born.release(); }
  } finally {
    await db.end();
    await fs.rm(directory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});
