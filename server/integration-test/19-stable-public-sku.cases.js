const suite = require('./suite-context');
const { insertProductFixture } = require('./product-fixture');

suite.test('stable public SKU migration backfills exact legacy identity and enforces deferred recount uniqueness', async () => {
  const { assert, Pool, crypto, fs, os, path, serverRoot, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = suite;
  const name = 'amber_public_sku_migration_test'; const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-public-sku-045-'));
  const db = new Pool({ connectionString: url });
  const migrate = () => runNodeInDatabase(url,
    `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
  try {
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations')))
      .filter((file) => file.endsWith('.sql') && file < '046')) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    await migrate();
    await db.query("INSERT INTO categories(code,name) VALUES('ZZ','Stable identity')");
    const legacy = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah)
      VALUES('AG-001234','ZZ',100) RETURNING id`)).rows[0];
    const source = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah)
      VALUES('ZZ-SOURCE','ZZ',100) RETURNING id`)).rows[0];
    const activatedSource = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah)
      VALUES('ZZ-ACTIVATED-SOURCE','ZZ',100) RETURNING id`)).rows[0];
    const { buildRecountEvidence } = require('../src/services/product/recount-evidence');
    const migration = '046_stable_public_product_sku.sql';
    await fs.copyFile(path.join(serverRoot, 'migrations', migration), path.join(directory, migration));
    await migrate(); await migrate();
    // Current recount evidence also binds the shared-name state. Upgrade the
    // fixture to the current runtime schema before exercising that service.
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations')))
      .filter((file) => file.endsWith('.sql') && file > migration)) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    await migrate();
    const evidenceSource = (await db.query(`SELECT p.*,i.public_sku FROM products p
      JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1`, [activatedSource.id])).rows[0];
    const evidenceTarget = { categoryCode: 'ZZ', skuSchemaVersionId: null, answers: {}, weight: 0 };
    const preActivationEvidence = await buildRecountEvidence(db, evidenceSource, evidenceTarget, []);
    assert.equal((await db.query(`SELECT i.public_sku FROM products p JOIN public_product_identities i
      ON i.id=p.public_product_identity_id WHERE p.id=$1`, [legacy.id])).rows[0].public_sku, 'AG-001234');

    const legacyRecount = await db.connect();
    let legacySuccessor;
    try {
      await legacyRecount.query('BEGIN');
      legacySuccessor = (await insertProductFixture(legacyRecount, `INSERT INTO products(full_sku,category,total_price_uah,corrected_from_product_id)
        VALUES('ZZ-LEGACY-SUCCESSOR','ZZ',100,$1) RETURNING id,public_product_identity_id`, [source.id])).rows[0];
      await legacyRecount.query(`UPDATE products SET status='corrected',corrected_to_product_id=$1 WHERE id=$2`,
        [legacySuccessor.id, source.id]);
      await legacyRecount.query('COMMIT');
    } finally { legacyRecount.release(); }
    const identities = (await db.query('SELECT id,public_product_identity_id FROM products WHERE id=ANY($1::int[]) ORDER BY id',
      [[source.id, legacySuccessor.id]])).rows;
    assert.notEqual(identities[0].public_product_identity_id, identities[1].public_product_identity_id);

    const actor = (await db.query(`INSERT INTO application_users(status,display_name,activated_at)
      VALUES('active','Public SKU actor',CURRENT_TIMESTAMP) RETURNING id`)).rows[0];
    const event = async (key) => (await db.query(`INSERT INTO audit_events
      (event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES($1,$2,'{"displayName":"Public SKU actor","preferredUsername":null}'::jsonb,
        'public_sku_activation','singleton',$3) RETURNING id`,
    [key, actor.id, crypto.randomUUID()])).rows[0].id;
    const activationEvent = await event('public_sku.activated');
    const cutoverEvent = await event('magento_delivery.cutover');

    // Product writer gets the activation row share lock first. Activation must
    // wait, allowing the writer to commit before activation (the safe order).
    const writerFirst = await db.connect();
    const activationFirst = await db.connect();
    try {
      await writerFirst.query('BEGIN');
      await insertProductFixture(writerFirst, `INSERT INTO products(full_sku,category,total_price_uah)
        VALUES('ZZ-WRITER-FIRST','ZZ',100)`);
      await activationFirst.query('BEGIN');
      await activationFirst.query("SET LOCAL amber.public_sku_activation='on'");
      const activationUpdate = activationFirst.query(`UPDATE public_sku_activation SET enabled=TRUE,
        activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton`,
      [actor.id, activationEvent]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await writerFirst.query('COMMIT');
      await activationUpdate;
      await activationFirst.query('COMMIT');
    } finally {
      await writerFirst.query('ROLLBACK').catch(() => {});
      await activationFirst.query('ROLLBACK').catch(() => {});
      writerFirst.release(); activationFirst.release();
    }
    const postActivationEvidence = await buildRecountEvidence(db, evidenceSource, evidenceTarget, []);
    assert.equal(preActivationEvidence.binding.publicSkuActivation, false);
    assert.equal(postActivationEvidence.binding.publicSkuActivation, true);
    assert.notEqual(preActivationEvidence.signature, postActivationEvidence.signature);

    // With activation committed first and legacy CSV still enabled, later
    // product writes are fenced at the database boundary.
    await assert.rejects(insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah)
      VALUES('ZZ-ACTIVATION-FIRST','ZZ',100)`), /product writes remain frozen/);

    await db.query('BEGIN');
    await db.query("SET LOCAL amber.magento_delivery_cutover='on'");
    await db.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='test',actor_user_id=$1,
      legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2
      WHERE singleton`, [actor.id, cutoverEvent]);
    await db.query('COMMIT');

    const bad = await db.connect();
    try {
      await bad.query('BEGIN');
      await insertProductFixture(bad, `INSERT INTO products(full_sku,category,total_price_uah,corrected_from_product_id)
        VALUES('ZZ-BAD-SUCCESSOR','ZZ',100,$1)`, [activatedSource.id]);
      await assert.rejects(bad.query('COMMIT'), /multiple current revisions/);
    } finally { await bad.query('ROLLBACK').catch(() => {}); bad.release(); }

    const recount = await db.connect();
    let successor;
    try {
      await recount.query('BEGIN');
      successor = (await insertProductFixture(recount, `INSERT INTO products(full_sku,category,total_price_uah,corrected_from_product_id)
        VALUES('ZZ-SUCCESSOR','ZZ',100,$1) RETURNING id,public_product_identity_id`, [activatedSource.id])).rows[0];
      await recount.query(`UPDATE products SET status='corrected',corrected_to_product_id=$1 WHERE id=$2`,
        [successor.id, activatedSource.id]);
      await recount.query('COMMIT');
    } finally { recount.release(); }
    const activatedIdentities = (await db.query(`SELECT id,public_product_identity_id FROM products
      WHERE id=ANY($1::int[]) ORDER BY id`, [[activatedSource.id, successor.id]])).rows;
    assert.equal(activatedIdentities[0].public_product_identity_id, activatedIdentities[1].public_product_identity_id);
    const request = (await db.query(`SELECT public_product_identity_id,product_id,desired_generation
      FROM magento_product_sync_requests WHERE public_product_identity_id=$1`,
    [successor.public_product_identity_id])).rows;
    assert.deepEqual(request, [{ public_product_identity_id: successor.public_product_identity_id,
      product_id: successor.id, desired_generation: '1' }]);

    const rolledBack = await db.connect();
    let burned;
    try {
      await rolledBack.query('BEGIN');
      burned = (await insertProductFixture(rolledBack, `INSERT INTO products(full_sku,category,total_price_uah)
        VALUES('ZZ-ROLLBACK','ZZ',100) RETURNING public_product_identity_id`)).rows[0].public_product_identity_id;
      await rolledBack.query('ROLLBACK');
    } finally { rolledBack.release(); }
    assert.ok(burned);

    const insert = async (sku) => {
      const connection = new Pool({ connectionString: url, max: 1 });
      try {
        return (await insertProductFixture(connection, `INSERT INTO products(full_sku,category,total_price_uah)
          VALUES($1,'ZZ',100) RETURNING id`, [sku])).rows[0].id;
      } finally { await connection.end(); }
    };
    const ids = await Promise.all([insert('ZZ-CONCURRENT-A'), insert('ZZ-CONCURRENT-B')]);
    const allocated = (await db.query(`SELECT i.public_sku,i.allocation_number FROM products p
      JOIN public_product_identities i ON i.id=p.public_product_identity_id
      WHERE p.id=ANY($1::int[]) ORDER BY i.allocation_number`, [ids])).rows;
    assert.deepEqual(allocated.map((row) => row.public_sku), ['AG-001236', 'AG-001237']);
    assert.equal(new Set(allocated.map((row) => row.allocation_number)).size, 2);

    await db.query("SELECT setval('public_product_sku_sequence',999999,TRUE)");
    const beyondSixDigits = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah)
      VALUES('ZZ-SEVEN-DIGITS','ZZ',100) RETURNING id`)).rows[0];
    assert.equal((await db.query(`SELECT i.public_sku FROM products p
      JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1`,
    [beyondSixDigits.id])).rows[0].public_sku, 'AG-1000000');
  } finally {
    await db.end(); await fs.rm(directory, { recursive: true, force: true }); await dropTestDatabase(name);
  }
});

suite.test('stable public SKU migration refuses non-canonical legacy SKU values without rewriting them', async () => {
  const { assert, Pool, fs, os, path, serverRoot, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = suite;
  const name = 'amber_public_sku_noncanonical_test'; const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-public-sku-noncanonical-'));
  const db = new Pool({ connectionString: url });
  const migrate = () => runNodeInDatabase(url,
    `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
  try {
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations')))
      .filter((file) => file.endsWith('.sql') && file < '046')) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    await migrate();
    await db.query("INSERT INTO categories(code,name) VALUES('ZZ','Noncanonical identity')");
    await db.query('ALTER TABLE products DISABLE TRIGGER products_reserve_sku');
    await insertProductFixture(db,
      `INSERT INTO products(full_sku,category,total_price_uah) VALUES(' zz-bad ','ZZ',100)`);
    await db.query('ALTER TABLE products ENABLE TRIGGER products_reserve_sku');
    await fs.copyFile(path.join(serverRoot, 'migrations', '046_stable_public_product_sku.sql'),
      path.join(directory, '046_stable_public_product_sku.sql'));
    await assert.rejects(migrate(), /canonical legacy full_sku values/);
    assert.equal((await db.query('SELECT full_sku FROM products')).rows[0].full_sku, ' zz-bad ');
    assert.equal((await db.query("SELECT count(*) FROM schema_migrations WHERE name='046_stable_public_product_sku.sql'")).rows[0].count, '0');
  } finally {
    await db.end(); await fs.rm(directory, { recursive: true, force: true }); await dropTestDatabase(name);
  }
});

suite.test('migration runner upgrades an active lifecycle database through stable public SKU migration', async () => {
  const { assert, Pool, crypto, fs, os, path, serverRoot, recreateTestDatabase,
    dropTestDatabase, runNodeInDatabase } = suite;
  const name = 'amber_public_sku_active_upgrade_test'; const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-public-sku-active-045-'));
  const db = new Pool({ connectionString: url });
  const migrate = () => runNodeInDatabase(url,
    `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
  try {
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations')))
      .filter((file) => file.endsWith('.sql') && file < '046')) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    await migrate();
    await db.query("INSERT INTO categories(code,name) VALUES('ZZ','Active upgrade')");
    const product = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah)
      VALUES('ZZ-ACTIVE-UPGRADE','ZZ',100) RETURNING id`)).rows[0];
    await db.query(`UPDATE product_full_export_state SET business_exclusion_state='none',
      delivery_version=delivery_version+1
      WHERE product_id=$1`, [product.id]);
    const actor = (await db.query(`INSERT INTO application_users(status,display_name,activated_at)
      VALUES('active','Migration runner actor',CURRENT_TIMESTAMP) RETURNING id`)).rows[0];
    const auditEvent = async (eventKey) => (await db.query(`INSERT INTO audit_events
      (event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES($1,$2,'{"displayName":"Migration runner actor","preferredUsername":null}'::jsonb,
        'cutover','singleton',$3) RETURNING id`, [eventKey, actor.id, crypto.randomUUID()])).rows[0].id;
    const approvalEventId = await auditEvent('full_product_cutover.approved');
    const activationEventId = await auditEvent('full_product_cutover.activated');
    await db.query('BEGIN');
    try {
      await db.query("SET LOCAL amber.lifecycle_maintenance = 'on'");
      await db.query("UPDATE full_product_export_activation SET phase='preparing',generation=generation+1 WHERE singleton");
      await db.query(`UPDATE full_product_export_activation SET manifest_hash=$1,approval_event_id=$2,
        generation=generation+1 WHERE singleton`, ['a'.repeat(64), approvalEventId]);
      await db.query(`UPDATE full_product_export_activation SET phase='active',selector_version=1,
        activation_event_id=$1,generation=generation+1 WHERE singleton`, [activationEventId]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
    const beforeProduct = (await db.query('SELECT full_sku,status FROM products WHERE id=$1', [product.id])).rows[0];
    const beforeLifecycle = (await db.query('SELECT * FROM product_full_export_state WHERE product_id=$1', [product.id])).rows[0];

    await fs.copyFile(path.join(serverRoot, 'migrations', '046_stable_public_product_sku.sql'),
      path.join(directory, '046_stable_public_product_sku.sql'));
    await migrate();
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM schema_migrations
      WHERE name='046_stable_public_product_sku.sql'`)).rows[0].count, 1);
    assert.deepEqual((await db.query('SELECT full_sku,status FROM products WHERE id=$1', [product.id])).rows[0], beforeProduct);
    assert.deepEqual((await db.query('SELECT * FROM product_full_export_state WHERE product_id=$1', [product.id])).rows[0], beforeLifecycle);
    assert.deepEqual((await db.query(`SELECT i.public_sku,i.origin FROM products p
      JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1`, [product.id])).rows[0],
    { public_sku: 'ZZ-ACTIVE-UPGRADE', origin: 'legacy' });
    assert.equal((await db.query('SELECT phase FROM full_product_export_activation WHERE singleton')).rows[0].phase, 'active');

    await migrate();
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM schema_migrations
      WHERE name='046_stable_public_product_sku.sql'`)).rows[0].count, 1);
  } finally {
    await db.end(); await fs.rm(directory, { recursive: true, force: true }); await dropTestDatabase(name);
  }
});
