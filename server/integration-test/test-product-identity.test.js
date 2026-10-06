const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('069 TEST creation races, receipts and recount preserve separate immutable numbering and disabled authority', async () => {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = `amber_test_identity_${process.pid}_test`;
  const marker = process.env.CODEX_FINAL_DB_MARKER || `test-identity-${randomUUID()}`;
  const control = new Client({ connectionString: source.toString() }); await control.connect();
  const before = (await control.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(row => row.datname);
  let created = false, db, appPool, checkpoint; const connections = [];
  const oldFetch = global.fetch; global.fetch = async () => { assert.fail('No HTTP permitted'); };
  try {
    assert.equal(before.includes(name), false); await control.query(`CREATE DATABASE ${name}`); created = true;
    await control.query(`COMMENT ON DATABASE ${name} IS '${marker.replace(/'/g, "''")}'`);
    const url = new URL(source); url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString(); process.env.NBU_RATE_OVERRIDE = '40'; process.env.MAGENTO_BASE_URL = '';
    require('../test/setup-env'); appPool = require('../src/db/pool');
    db = new Client({ connectionString: url.toString() }); await db.connect();
    const runMigrations = require('../src/db/run-migrations').runMigrations;
    checkpoint = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-test-identity-068-'));
    const migrationRoot = path.join(__dirname, '..', 'migrations');
    for (const file of await fs.readdir(migrationRoot)) if (/^[0-9]{3}_.*\.sql$/.test(file) && Number(file.slice(0, 3)) <= 68) {
      await fs.copyFile(path.join(migrationRoot, file), path.join(checkpoint, file));
    }
    await runMigrations({ directory: checkpoint });
    const actor = (await db.query("INSERT INTO application_users(status,display_name) VALUES('active','TEST fixture admin') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator' AND is_system", [actor]);
    const nonAdminCreator = (await db.query("INSERT INTO application_users(status,display_name) VALUES('active','TEST fixture Storekeeper') RETURNING id")).rows[0].id;
    const creatorAssignment = await db.query(`INSERT INTO user_role_assignments(application_user_id,role_id)
      SELECT $1,id FROM roles WHERE role_key='storekeeper' AND is_system=TRUE AND status='active'`, [nonAdminCreator]);
    assert.equal(creatorAssignment.rowCount, 1, 'fixture assigns the existing active Storekeeper role');
    const creatorAuthority = (await db.query(`SELECT r.role_key,r.is_system,
      EXISTS(SELECT 1 FROM role_permissions p WHERE p.role_id=r.id AND p.permission_key='products.create') AS can_create
      FROM user_role_assignments a JOIN roles r ON r.id=a.role_id
      WHERE a.application_user_id=$1 AND a.revoked_at IS NULL`, [nonAdminCreator])).rows;
    assert.deepEqual(creatorAuthority, [{ role_key: 'storekeeper', is_system: true, can_create: true }],
      'non-Administrator fixture has genuine product creation authority');
    const options = { mutationContext: { actorUserId: actor } };
    await require('../src/services/catalog.service').createCategory({ code: 'TX', name: 'Disposable TEST fixture', requires_weight: 0 }, options);
    const service = require('../src/services/product.service');
    const payload = { categoryCode: 'TX', answers: {}, weight: 1, isTestProduct: true,
      pricingDecision: { mode: 'manual_uah', manualPriceUah: 100, marketingRoundingEnabled: false } };
    await assert.rejects(service.buildNewProductPreview(payload, options), { code: 'TEST_PRODUCT_NATIVE_REQUIRED' });
    // Nonempty known checkpoint: retained legacy identifier, answers and permanent reservation.
    await require('./product-fixture').insertProductFixture(db, "INSERT INTO products(full_sku,base_sku,category,weight,total_price,total_price_uah,details,created_by_user_id) VALUES('TX-LEGACY-001','TX-LEGACY-', 'TX',1,2.5,100,'{\"answers\":{}}',$1)", [actor]);
    const event = async key => (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES($1,$2,'{"displayName":"TEST fixture admin","preferredUsername":null}','public_sku_activation','singleton',$3) RETURNING id`, [key, actor, randomUUID()])).rows[0].id;
    const activation = await event('public_sku.activated'), cutover = await event('magento_delivery.cutover');
    await db.query('BEGIN'); await db.query("SET LOCAL amber.public_sku_activation='on'");
    await db.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton', [actor, activation]);
    await db.query("SET LOCAL amber.magento_delivery_cutover='on'");
    await db.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='test-identity',actor_user_id=$1,
      legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`, [actor, cutover]);
    await db.query('COMMIT');
    // The existing checkpoint fixture uses only 060–068 columns and the normal
    // lifecycle boundary. New runtime joins are deliberately not used pre-069.
    const oldNative = await require('./product-fixture').insertNativeProductFixture(appPool,
      { category: 'TX', totalPriceUah: 100, details: { answers: {} }, weight: 1 });
    assert.equal((await db.query('SELECT public_sku FROM public_product_identities WHERE id=$1', [oldNative.rows[0].public_product_identity_id])).rows[0].public_sku, 'AG-000001');
    const tables = ['products','public_product_identities','sku_registry','roles','role_permissions','permissions','user_role_assignments',
      'audit_events','magento_sync_jobs','magento_sync_steps','magento_product_sync_requests','product_creation_receipts','product_full_export_state'];
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async table => [table,
      (await db.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.row)])));
    const historyBefore = await snapshot(); assert.ok(historyBefore.products.length >= 2); assert.ok(historyBefore.public_product_identities.length >= 2);
    const oldChecksums = (await db.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
    const agCheckpoint = (await db.query('SELECT last_value,is_called FROM public_product_sku_sequence')).rows[0];
    // Native activation alone cannot grant the not-yet-installed TEST namespace.
    // Reject even a forged save before the old allocator can consume an AG number.
    await assert.rejects(service.buildNewProductPreview(payload, options),
      { code: 'TEST_PRODUCT_NAMESPACE_UNAVAILABLE', statusCode: 409 });
    await assert.rejects(service.saveProduct({ ...payload, characteristicConfigHash: '0'.repeat(64),
      previewToken: 'pre-069-forged-preview' }, options),
    { code: 'TEST_PRODUCT_NAMESPACE_UNAVAILABLE', statusCode: 409 });
    assert.deepEqual(await snapshot(), historyBefore, '068 TEST rejection leaves every checkpoint row unchanged');
    assert.deepEqual((await db.query('SELECT last_value,is_called FROM public_product_sku_sequence')).rows[0], agCheckpoint,
      '068 TEST rejection never reaches the ordinary AG allocator');
    const ddl = await fs.readFile(path.join(migrationRoot, '069_native_test_product_identity.sql'), 'utf8');
    await db.query('BEGIN');
    await db.query("INSERT INTO public_product_identities(public_sku,origin) VALUES('TEST-000012','legacy')");
    await db.query(ddl);
    assert.deepEqual((await db.query('SELECT last_value,is_called FROM test_product_sku_sequence')).rows[0], { last_value: '12', is_called: true }, 'retained TEST-like identities advance only TEST floor');
    assert.ok((await db.query("SELECT to_regclass('test_product_sku_sequence') present")).rows[0].present);
    await db.query('ROLLBACK');
    assert.deepEqual(await snapshot(), historyBefore, '069 rollback preserves all nonempty prior history');
    assert.equal((await db.query("SELECT to_regclass('test_product_sku_sequence') present")).rows[0].present, null);
    assert.deepEqual((await db.query('SELECT last_value,is_called FROM public_product_sku_sequence')).rows[0], agCheckpoint);
    await runMigrations();
    const historyAfter = await snapshot();
    historyAfter.public_product_identities = historyAfter.public_product_identities.map(row => {
      assert.equal(row.is_test_product, false); assert.equal(row.test_allocation_number, null);
      const { is_test_product, test_allocation_number, ...old } = row; void is_test_product; void test_allocation_number; return old;
    });
    // Raw JSON key order may change when new columns are introduced; exact values/membership stay unchanged.
    for (const table of tables) assert.deepEqual(historyAfter[table].sort((x,y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
      historyBefore[table].sort((x,y) => JSON.stringify(x).localeCompare(JSON.stringify(y))), table);
    assert.deepEqual((await db.query('SELECT * FROM schema_migrations ORDER BY name')).rows.filter(row => oldChecksums.some(old => old.name === row.name)), oldChecksums);
    assert.deepEqual((await db.query('SELECT last_value,is_called FROM public_product_sku_sequence')).rows[0], agCheckpoint);
    assert.deepEqual((await db.query('SELECT last_value,is_called FROM test_product_sku_sequence')).rows[0], { last_value: '1', is_called: false });
    const ag = async () => (await db.query('SELECT last_value,is_called FROM public_product_sku_sequence')).rows[0];
    const agBefore = await ag(); const identitiesBefore = (await db.query('SELECT * FROM public_product_identities ORDER BY id')).rows;
    await assert.rejects(service.buildNewProductPreview(payload, { mutationContext: { actorUserId: nonAdminCreator } }), { code: 'TEST_PRODUCT_ADMINISTRATOR_REQUIRED' });
    await assert.rejects(service.saveProduct({ ...payload, isTestProduct: 'true' }, options), { code: 'TEST_PRODUCT_FLAG_INVALID' });
    const preview = await service.buildNewProductPreview(payload, options);
    assert.equal(preview.isTestProduct, true); assert.equal(preview.testTargetStatus, 2);
    const save = { ...payload, category: 'TX', characteristicConfigHash: preview.characteristicConfigHash,
      previewToken: preview.previewToken, idempotencyKey: randomUUID() };
    // Two real pool connections race the exact original attempt; both return one receipt.
    const [saved, replay] = await Promise.all([service.saveProduct(save, options), service.saveProduct(save, options)]);
    assert.deepEqual(saved, replay); assert.equal(saved.publicSku, 'TEST-000001'); assert.equal(saved.isTestProduct, true);
    assert.deepEqual(await ag(), agBefore);
    await assert.rejects(service.saveProduct({ ...save, isTestProduct: false }, options), { code: 'CREATION_ATTEMPT_CONFLICT' });
    await assert.rejects(service.saveProduct({ ...save, idempotencyKey: randomUUID(), isTestProduct: false }, options), { statusCode: 409 });
    const stored = (await db.query('SELECT * FROM products WHERE id=$1', [saved.id])).rows[0];
    const identity = (await db.query('SELECT * FROM public_product_identities WHERE id=$1', [stored.public_product_identity_id])).rows[0];
    assert.equal(identity.is_test_product, true); assert.equal(identity.allocation_number, null); assert.equal(identity.test_allocation_number, '1');
    assert.equal(stored.full_sku, null); assert.equal(stored.sku_schema_version_id, null);
    await assert.rejects(db.query('UPDATE public_product_identities SET is_test_product=FALSE WHERE id=$1', [identity.id]), /immutable/);
    await assert.rejects(db.query('DELETE FROM public_product_identities WHERE id=$1', [identity.id]), /permanent|immutable/);
    await assert.rejects(db.query("INSERT INTO public_product_identities(public_sku,origin,allocation_number,is_test_product) VALUES('AG-999999','allocated',999999,TRUE)"), /check constraint/);
    await assert.rejects(db.query("INSERT INTO public_product_identities(public_sku,origin,test_allocation_number,is_test_product) VALUES('AG-999998','allocated',999998,TRUE)"), /check constraint/);
    await assert.rejects(db.query('INSERT INTO product_photo_sets(product_id,version,photo_ids,enable_when_verified) VALUES($1,1,ARRAY[]::uuid[],TRUE)', [saved.id]), /TEST product activation/);
    // Real PostgreSQL exercises the exact production trigger against closed test
    // payloads without fabricating binding/job dispatch receipts.
    await db.query(`CREATE TEMP TABLE test_sync_guard_fixture(public_product_identity_id BIGINT,intent JSONB);
      CREATE TRIGGER fixture_test_status BEFORE INSERT ON test_sync_guard_fixture FOR EACH ROW EXECUTE FUNCTION guard_test_sync_job_status()`);
    const guardIntent = (mode, value, include = true) => ({ mode, operations: [{ domain: 'coreProduct', payload: { product: { sku: saved.publicSku, ...(include ? { status: value } : {}) } } }] });
    for (const [mode, value, include] of [['create', 1, true], ['create', '2', true], ['create', null, true], ['create', null, false],
      ['update', 1, true], ['update', '1', true], ['update', true, true], ['update', null, true]]) {
      await assert.rejects(db.query('INSERT INTO test_sync_guard_fixture VALUES($1,$2::jsonb)', [identity.id, JSON.stringify(guardIntent(mode, value, include))]), /TEST sync/);
    }
    for (const intent of [guardIntent('create', 2), guardIntent('update', null, false)]) await db.query('INSERT INTO test_sync_guard_fixture VALUES($1,$2::jsonb)', [identity.id, JSON.stringify(intent)]);
    assert.equal((await db.query('SELECT count(*)::int n FROM test_sync_guard_fixture')).rows[0].n, 2);
    await assert.rejects(db.query('INSERT INTO product_photo_sets(product_id,version,photo_ids,enable_when_verified) VALUES(2147483647,1,ARRAY[]::uuid[],FALSE)'), /foreign key/, 'ordinary invalid reference retains existing FK failure');
    const gate = require('../src/services/full-product-cutover-gate'), full = require('../src/services/full-product-export.service');
    const photoCreationAuthority = require('../src/services/product/product-creation-receipts');
    const photoSetsBefore=(await db.query('SELECT count(*)::int n FROM product_photo_sets')).rows[0].n;
    const photoJobsBefore=(await db.query('SELECT count(*)::int n FROM product_media_jobs')).rows[0].n;
    await photoCreationAuthority.lockAuthority(db);
    try {
      await gate.begin(db);
      await assert.rejects(require('../src/services/product-photos.service').attachCreatedProduct(db,saved.id,
        {photoIds:[randomUUID()],enableWhenVerified:true},options.mutationContext),
      {code:'TEST_PRODUCT_ENABLE_FORBIDDEN',statusCode:422},'the actual immutable TEST marker blocks service photo activation');
    } finally {await gate.rollback(db);await photoCreationAuthority.releaseAuthority(db);}
    assert.equal((await db.query('SELECT count(*)::int n FROM product_photo_sets')).rows[0].n,photoSetsBefore);
    assert.equal((await db.query('SELECT count(*)::int n FROM product_media_jobs')).rows[0].n,photoJobsBefore);
    assert.deepEqual(await ag(),agBefore);
    for (let i = 0; i < 2; i++) { const client = new Client({ connectionString: url.toString() }); await client.connect(); connections.push(client); }
    const authority = require('../src/services/product/product-creation-receipts');
    for (const client of connections) {
      await authority.lockAuthority(client);
      await gate.begin(client, 'BEGIN');
      await client.query("SELECT set_config('amber.create_test_product','on',TRUE),set_config('amber.create_test_product_actor',$1,TRUE)", [String(actor)]);
    }
    // Both transactions are open before independent INSERTs; sequence uniqueness survives a real race.
    const raced = await Promise.all(connections.map(client => client.query(`INSERT INTO products(category,weight,total_price,total_price_uah,details,characteristic_version_id,created_by_user_id)
      VALUES('TX',1,2.5,100,'{"answers":{}}',$1,$2) RETURNING id,public_product_identity_id`, [stored.characteristic_version_id, actor])));
    for (let i = 0; i < connections.length; i++) { await full.initializeNewProduct(connections[i], raced[i].rows[0].id); await gate.commit(connections[i]); await gate.release(connections[i]); await authority.releaseAuthority(connections[i]); }
    const numbers = (await db.query('SELECT public_sku,test_allocation_number FROM public_product_identities WHERE id=ANY($1::bigint[]) ORDER BY test_allocation_number', [raced.map(row => row.rows[0].public_product_identity_id)])).rows;
    assert.deepEqual(numbers.map(row => row.public_sku), ['TEST-000002', 'TEST-000003']); assert.deepEqual(await ag(), agBefore);
    const rollbackClient = connections[0]; await authority.lockAuthority(rollbackClient); await gate.begin(rollbackClient, 'BEGIN');
    await rollbackClient.query("SELECT set_config('amber.create_test_product','on',TRUE),set_config('amber.create_test_product_actor',$1,TRUE)", [String(actor)]);
    await rollbackClient.query("INSERT INTO products(category,weight,total_price,total_price_uah,details,characteristic_version_id,created_by_user_id) VALUES('TX',1,2.5,100,'{}',$1,$2)", [stored.characteristic_version_id, actor]);
    await gate.rollback(rollbackClient); await gate.release(rollbackClient); await authority.releaseAuthority(rollbackClient);
    assert.equal((await db.query('SELECT last_value FROM test_product_sku_sequence')).rows[0].last_value, '4');
    const afterGap = await service.saveProduct({ ...save, idempotencyKey: randomUUID() }, options);
    assert.equal(afterGap.publicSku, 'TEST-000005'); assert.deepEqual(await ag(), agBefore);
    const decoded = await service.decodeSku(saved.publicSku); assert.equal(decoded.isTestProduct, true); assert.equal(decoded.testTargetStatus, 2);
    const register = await require('../src/services/product/product-queries').getProductRegisterPage(db, { search: saved.publicSku });
    assert.equal(register.items[0].isTestProduct, true); assert.equal(register.items[0].testTargetStatus, 2);
    const recountInput = { sourceSku: saved.publicSku, answers: {}, weight: 2, manualPriceUah: 110 };
    const recount = await service.buildProductRecountPreview(recountInput);
    const corrected = await service.applyProductRecount({ ...recountInput, sourceStateSignature: recount.source.stateSignature }, options);
    assert.equal(corrected.corrected.publicSku, saved.publicSku);
    assert.equal((await service.decodeSku(saved.publicSku)).isTestProduct, true); assert.deepEqual(await ag(), agBefore);
    const testFloor = (await db.query('SELECT last_value,is_called FROM test_product_sku_sequence')).rows[0];
    const normalPayload = { ...payload, isTestProduct: false };
    const ordinary = await service.buildNewProductPreview(normalPayload, options);
    const ordinarySaved = await service.saveProduct({ ...normalPayload, characteristicConfigHash: ordinary.characteristicConfigHash, previewToken: ordinary.previewToken }, options);
    assert.equal(ordinarySaved.publicSku, 'AG-000002'); assert.equal(ordinarySaved.isTestProduct, false);
    assert.deepEqual((await db.query('SELECT last_value,is_called FROM test_product_sku_sequence')).rows[0], testFloor);
    for (const row of identitiesBefore) assert.deepEqual((await db.query('SELECT * FROM public_product_identities WHERE id=$1', [row.id])).rows[0], row);
    assert.equal((await db.query('SELECT count(*)::int n FROM product_creation_receipts WHERE idempotency_key=$1', [save.idempotencyKey])).rows[0].n, 1);
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.created' AND subject_id=$1", [String(saved.id)])).rows[0].n, 1);
    await require('../src/db/run-migrations').runMigrations();
    assert.deepEqual((await db.query('SELECT last_value,is_called FROM test_product_sku_sequence')).rows[0], testFloor);
  } finally {
    global.fetch = oldFetch;
    for (const client of connections) { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
    if (db) await db.end(); if (appPool) await appPool.end();
    if (created) {
      assert.equal((await control.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=$1", [name])).rows[0].marker, marker);
      await control.query(`DROP DATABASE ${name}`);
    }
    assert.deepEqual((await control.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(row => row.datname), before);
    await control.end();
    if (checkpoint) {
      const temporaryRoot = path.resolve(os.tmpdir());
      const checkpointPath = path.resolve(checkpoint);
      const relativeCheckpoint = path.relative(temporaryRoot, checkpointPath);
      if (!path.isAbsolute(checkpoint) || !relativeCheckpoint
        || path.isAbsolute(relativeCheckpoint) || relativeCheckpoint === '..'
        || relativeCheckpoint.startsWith(`..${path.sep}`)
        || path.dirname(checkpointPath) !== temporaryRoot
        || !/^amber-test-identity-068-[A-Za-z0-9]{6}$/.test(path.basename(checkpointPath))) {
        throw new Error('Refusing cleanup of an unowned TEST checkpoint directory');
      }
      await fs.rm(checkpointPath, { recursive: true, force: true });
    }
  }
});
