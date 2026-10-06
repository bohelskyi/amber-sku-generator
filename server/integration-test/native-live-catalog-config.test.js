const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

test('native public config and creation use unpublished live values/questions while legacy projection and publications stay frozen', async () => {
  const sourceUrl = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(sourceUrl.hostname, '127.0.0.1'); assert.equal(sourceUrl.port, '55432');
  assert.ok(sourceUrl.pathname.endsWith('_test'));
  const name = `amber_native_live_config_${process.pid}_test`;
  const control = new Client({ connectionString: sourceUrl.toString() }); await control.connect();
  let db, appPool, created = false;
  const previousFetch = global.fetch;
  global.fetch = async () => { assert.fail('This fixture prohibits all HTTP'); };
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0,
      'Never reuse or drop a database this test did not create');
    await control.query(`CREATE DATABASE ${name}`); created = true;
    const url = new URL(sourceUrl); url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString(); process.env.NBU_RATE_OVERRIDE = '40'; process.env.MAGENTO_BASE_URL = '';
    require('../test/setup-env'); appPool = require('../src/db/pool');
    db = new Client({ connectionString: url.toString() }); await db.connect();
    await require('../src/db/run-migrations').runMigrations();
    const actor = (await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Live catalog fixture') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const options = { mutationContext: { actorUserId: actor } };
    const catalog = require('../src/services/catalog.service');
    const schemas = require('../src/services/sku-schema.service');
    await catalog.createCategory({ code: 'XX', name: 'Native live category', requires_weight: 0 }, options);
    const kind = (await catalog.createQuestion({ category_code: 'XX', key: 'kind', label: 'Kind', include_in_sku: 1,
      sku_index: 1, display_order: 1, input_type: 'options', required: 1 }, options)).id;
    await catalog.createOption({ question_id: kind, value_id: 1, sku_code: '1', label: 'Original' }, options);
    await schemas.publishSkuSchema('XX', options);
    const frozen = async () => ({ versions: (await db.query('SELECT * FROM sku_schema_versions ORDER BY id')).rows,
      questions: (await db.query('SELECT * FROM sku_schema_questions ORDER BY id')).rows,
      options: (await db.query('SELECT * FROM sku_schema_options ORDER BY id')).rows,
      reservations: (await db.query('SELECT * FROM sku_registry ORDER BY full_sku')).rows });
    const before = await frozen();
    assert.equal((await catalog.getAppConfig(db)).catalogWorkflow.identityMode, 'encoded_sku');
    await assert.rejects(catalog.createQuestion({ category_code: 'XX', label: 'Missing legacy key' }, options), { statusCode: 400 });
    const fresh = await catalog.createOption({ question_id: kind, label: 'Unpublished', label_en: 'New English' }, options);
    const freshValue = (await db.query('SELECT value_id FROM options WHERE id=$1', [fresh.id])).rows[0].value_id;
    const newer = (await catalog.createQuestion({ category_code: 'XX', key: 'new_kind', label: 'New kind', include_in_sku: 1,
      sku_index: 2, display_order: 2, input_type: 'options', required: 1 }, options)).id;
    const newerOption = await catalog.createOption({ question_id: newer, label: 'New choice' }, options);
    const newerValue = (await db.query('SELECT value_id FROM options WHERE id=$1', [newerOption.id])).rows[0].value_id;
    const legacy = await schemas.getPublicConfig(db);
    assert.deepEqual(legacy.questions.XX.map(q => q.id), ['kind']);
    assert.deepEqual(legacy.questions.XX[0].options.map(o => o.id), [1]);
    const event = async key => (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES($1,$2,'{"displayName":"Live catalog fixture","preferredUsername":null}','public_sku_activation','singleton',$3) RETURNING id`, [key, actor, crypto.randomUUID()])).rows[0].id;
    const activationEvent = await event('public_sku.activated'), cutoverEvent = await event('magento_delivery.cutover');
    await db.query('BEGIN'); await db.query("SET LOCAL amber.public_sku_activation='on'");
    await db.query(`UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton`, [actor, activationEvent]);
    await db.query("SET LOCAL amber.magento_delivery_cutover='on'");
    await db.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='native-live-config',actor_user_id=$1,
      legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`, [actor, cutoverEvent]);
    await db.query('COMMIT');
    assert.deepEqual((await catalog.getAppConfig(db)).catalogWorkflow, { identityMode: 'public_identity', serverGeneratedQuestionKeys: true });
    const automatic = await catalog.createQuestion({ category_code: 'XX', label: 'Opaque optional question', required: 0, display_order: 3 }, options);
    assert.match(automatic.key, /^q_[a-f0-9]{32}$/);
    const row = (await db.query('SELECT key,include_in_sku,sku_index FROM questions WHERE id=$1', [automatic.id])).rows[0];
    assert.deepEqual(row, { key: automatic.key, include_in_sku: 0, sku_index: 0 });
    await catalog.updateQuestion({ id: automatic.id, key: automatic.key, label: 'Renamed ordinary label', required: 0, include_in_sku: 0, display_order: 3 }, options);
    assert.equal((await db.query('SELECT key FROM questions WHERE id=$1', [automatic.id])).rows[0].key, automatic.key);
    assert.deepEqual(await frozen(), before);
    const native = await schemas.getPublicConfig(db);
    assert.deepEqual(native.questions.XX.map(q => q.id), ['kind', 'new_kind', automatic.key]);
    assert.ok(native.questions.XX[0].options.some(o => o.id === freshValue && o.label_en === 'New English' && o.sku_code === null));
    assert.equal(native.categories.XX.sku_schema_version_id, undefined);
    await catalog.createCategory({ code: 'YY', name: 'New native category', requires_weight: 0 }, options);
    await catalog.createQuestion({ category_code: 'YY', key: 'quantity', label: 'Quantity', input_type: 'text', required: 1,
      display_order: 1, numeric_validation: { kind: 'decimal', min: 0, maxFractionDigits: 1 } }, options);
    const products = require('../src/services/product.service');
    for (const [category, answers] of [['XX', { kind: freshValue, new_kind: newerValue }], ['YY', { quantity: '2,5' }]]) {
      const payload = { categoryCode: category, answers, weight: 1,
        pricingDecision: { mode: 'manual_uah', manualPriceUah: 100, marketingRoundingEnabled: false } };
      const preview = await products.buildNewProductPreview(payload);
      const saved = await products.saveProduct({ ...payload, category, characteristicConfigHash: preview.characteristicConfigHash, previewToken: preview.previewToken }, options);
      assert.match(saved.publicSku, /^AG-/);
      const product = (await db.query('SELECT * FROM products WHERE id=$1', [saved.id])).rows[0];
      assert.equal(product.full_sku, null); assert.equal(product.sku_schema_version_id, null);
      assert.ok(product.characteristic_version_id);
      if (category === 'YY') assert.equal(product.details.answers.quantity, 2.5);
    }
    assert.equal((await db.query("SELECT count(*)::int n FROM sku_schema_versions WHERE category_code='YY'")).rows[0].n, 0);
    assert.deepEqual(await frozen(), before, 'Native config/save must not publish, modify or reserve legacy SKU state');
  } finally {
    global.fetch = previousFetch;
    if (db) await db.end(); if (appPool) await appPool.end();
    if (created) { await control.query(`DROP DATABASE ${name} WITH (FORCE)`); }
    await control.end();
  }
});
