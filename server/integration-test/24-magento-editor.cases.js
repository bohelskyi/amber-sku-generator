const { test, assert, Pool, runNodeInDatabase, recreateTestDatabase, dropTestDatabase } = require('./suite-context');
const editor = require('../src/services/magento/integration-editor.service');
const fixtures = require('../test/fixtures/magento-v4');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');

test('integration editor overview: all configured categories, read-only consistent snapshot and no allocation', async () => {
  const name = 'amber_integration_editor_test'; const url = await recreateTestDatabase(name);
  const db = new Pool({ connectionString: url });
  try {
    await runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    await db.query("INSERT INTO categories(code,name) VALUES('XX','Нова категорія')");
    const before = (await db.query('SELECT * FROM public_product_identities')).rows;
    const result = await editor.overview({ configured: false }, {}, { databasePool: db });
    assert.equal(result.categories.length, 1); assert.equal(result.categories[0].code, 'XX');
    assert.equal(result.categories[0].ready, false); assert.equal(result.revision, null);
    assert.equal(result.categories[0].message, 'Категорія ще не готова до Magento');
    assert.deepEqual((await db.query('SELECT * FROM public_product_identities')).rows, before);
    for (const table of ['products','sku_registry','magento_sync_jobs','magento_product_sync_requests']) {
      assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    }
  } finally { await db.end(); await dropTestDatabase(name); }
});

test('integration CREATE preview uses published schema and authoritative pricing without reserving identifiers', async () => {
  const name = 'amber_integration_create_preview_test'; const url = await recreateTestDatabase(name);
  const db = new Pool({ connectionString: url });
  try {
    await runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Preview admin') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    await db.query("INSERT INTO categories(code,name) VALUES('XG','Нова категорія')");
    const q = (await db.query("INSERT INTO questions(category_code,key,label,sku_index,input_type,include_in_sku,required) VALUES('XG','new_color','Колір',1,'options',1,1) RETURNING id")).rows[0];
    await db.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,7,'91','Explicit Amber label')", [q.id]);
    await db.query("INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required) VALUES('XG','new_note','Примітка','text',0,0)");
    await runNodeInDatabase(url, `require('./src/services/sku-schema.service').publishSkuSchema('XG',{mutationContext:{actorUserId:${actor}}}).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>require('./src/db/pool').end());`);
    const options = { databasePool: db, mutationContext: { actorUserId: actor } };
    const family = await templates.createTemplate({ key: 'preview-v4', displayName: 'Preview', definition: fixtures.definition() }, options);
    const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    const config = { configured: true, baseUrl: 'https://preview.invalid', consumerKey: 'fixture-consumer-key', consumerSecret: 'fixture-consumer-secret', accessToken: 'fixture-access-token', accessTokenSecret: 'fixture-token-secret' };
    const revision = await bindings.createDraft({ installationKey: 'preview', origin: config.baseUrl, templateVersionId: version.id,
      observedAt: '2026-10-01T00:00:00.000Z', schema: fixtures.observation() }, options);
    const before = async () => (await db.query(`SELECT (SELECT count(*) FROM products) products,
      (SELECT count(*) FROM sku_registry) reserved,(SELECT count(*) FROM public_product_identities) identities,
      (SELECT count(*) FROM magento_sync_jobs) jobs,(SELECT count(*) FROM magento_product_sync_requests) requests`)).rows[0];
    const state = await before();
    const result = await editor.prospectivePreview(config, { bindingRevisionId: revision.id,
      product: { categoryCode: 'XG', weight: 5, answers: { new_color: 7, new_note: 'Example' } },
      pricingDecision: { mode: 'manual_uah', manualPriceUah: 42 } }, { ...options,
      discover: async () => ({ schema: fixtures.observation(), categories: [] }),
      fetchImpl: async () => { throw new Error('Unexpected remote call'); } });
    assert.equal(result.mode, 'create'); assert.equal(result.hypothetical, true); assert.equal(result.article, 'AG-PREVIEW');
    assert.equal(result.sendable, false); assert.ok(result.blockers.length); assert.deepEqual(await before(), state);
  } finally { await db.end(); await dropTestDatabase(name); }
});
