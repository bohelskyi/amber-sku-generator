const { test, assert, Pool, runNodeInDatabase, recreateTestDatabase, dropTestDatabase } = require('./suite-context');
const editor = require('../src/services/magento/integration-editor.service');
const fixtures = require('../test/fixtures/magento-v4');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');
const integrationOverview = require('../src/services/magento/integration-overview');
const { insertProductFixture } = require('./product-fixture');

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
    const concise = await integrationOverview.overview({ configured: false }, { databasePool: db, canViewProducts: true });
    assert.equal(concise.integration.activePublication, null);
    assert.equal(concise.integration.structureObservation, null);
    assert.equal(concise.integration.delivery.state, 'disabled');
    assert.deepEqual(concise.integration.operational, { state: 'known', count: 0 });
    assert.equal(concise.categories[0].preparation.reasons[0].code, 'NOT_CONNECTED');
    assert.equal(concise.categories[0].impact, 'unexamined');
    assert.equal(Object.hasOwn(concise.categories[0], 'values'), false);
    const restricted = await integrationOverview.overview({ configured: false }, { databasePool: db });
    assert.deepEqual(restricted.integration.operational, { state: 'unavailable', count: null });
    assert.deepEqual(restricted.categories[0].operational, { state: 'unavailable', count: null, reasons: [] });
    for (const table of ['products','sku_registry','magento_sync_jobs','magento_product_sync_requests']) {
      assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    }
  } finally { await db.end(); await dropTestDatabase(name); }
});

test('concise integration overview separates publication, stored observation and exact current operational identities', async () => {
  const name = 'amber_integration_summary_test'; const url = await recreateTestDatabase(name);
  const db = new Pool({ connectionString: url });
  try {
    await runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Overview admin') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    await db.query("INSERT INTO categories(code,name) VALUES('XG','Current category'),('YG','Historical category')");
    const options = { databasePool: db, mutationContext: { actorUserId: actor } };
    const definition = fixtures.definition();
    definition.sources = { sku: definition.sources.sku }; definition.tables = {}; definition.questionContracts = {};
    for (const group of definition.groups) {
      group.columns = require('../src/services/export-templates/column-contract').REQUIRED;
      for (const row of group.rows) { delete row.cells.kolir; delete row.cells.new_note; row.cells.price = { op: 'literal', value: '42' }; }
    }
    const family = await templates.createTemplate({ key: 'overview', displayName: 'Overview', definition }, options);
    const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    const config = { configured: true, baseUrl: 'https://overview.invalid' };
    let current = await bindings.createDraft({ installationKey: 'overview', origin: config.baseUrl, templateVersionId: version.id,
      observedAt: '2026-10-01T00:00:00.000Z', schema: fixtures.observation() }, options);
    current = await bindings.updateDraft(current.id, { expectedRevision: current.revision, bindings: fixtures.approvedBindings(definition) }, options);
    current = await bindings.publishDraft(current.id, { expectedRevision: current.revision, expectedCurrentId: null }, options);
    const newer = await bindings.createDraft({ installationKey: 'overview', origin: config.baseUrl, templateVersionId: version.id,
      observedAt: '2026-10-02T00:00:00.000Z', schema: fixtures.observation() }, options);
    await bindings.createDraft({ installationKey: 'another-installation', origin: config.baseUrl, templateVersionId: version.id,
      observedAt: '2026-10-03T00:00:00.000Z', schema: fixtures.observation() }, options);
    const event = (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id)
      VALUES('test.activation',$1,'{"displayName":"Test","preferredUsername":null}','test','test') RETURNING id`, [actor])).rows[0].id;
    const activation = await db.connect();
    try {
      await activation.query('BEGIN');
      await activation.query("SET LOCAL amber.public_sku_activation='on'; SET LOCAL amber.magento_delivery_cutover='on'");
      await activation.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2', [actor, event]);
      await activation.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='overview',actor_user_id=$1,
        legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2`, [actor, event]);
      await activation.query('COMMIT');
    } finally { activation.release(); }
    const source = (await insertProductFixture(db, "INSERT INTO products(full_sku,category,status,total_price_uah) VALUES('YG-OLD','YG','archived',42) RETURNING *")).rows[0];
    const product = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,corrected_from_product_id,total_price_uah)
      VALUES('XG-NOW','XG',$1,42) RETURNING *`, [source.id])).rows[0];
    assert.equal(product.public_product_identity_id, source.public_product_identity_id);
    await db.query(`UPDATE magento_product_sync_requests SET state='needs_attention',reason_code='data_or_binding',
      diagnostics='[{"code":"OPTION_UNRESOLVED"},{"code":"ATTRIBUTE_NOT_FOUND"},{"code":"OPTION_UNRESOLVED"}]' WHERE product_id=$1`, [product.id]);
    const before = async () => (await db.query(`SELECT (SELECT count(*) FROM products) products,(SELECT count(*) FROM sku_registry) reserved,
      (SELECT count(*) FROM public_product_identities) identities,(SELECT count(*) FROM magento_sync_jobs) jobs,
      (SELECT jsonb_agg(r) FROM magento_product_sync_requests r) requests`)).rows[0];
    const state = await before();
    const result = await integrationOverview.overview(config, { databasePool: db, canViewProducts: true });
    assert.equal(result.integration.activePublication.id, current.id);
    assert.equal(result.integration.activePublication.templateId, current.templateId);
    assert.equal(result.integration.activePublication.versionNumber, current.versionNumber);
    assert.equal(result.integration.activePublication.templateVersionNumber, version.versionNumber);
    assert.equal(result.integration.activePublication.observedAt.toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(result.integration.structureObservation.bindingId, newer.id);
    assert.equal(result.integration.structureObservation.observedAt.toISOString(), '2026-10-02T00:00:00.000Z');
    assert.equal(result.integration.structureObservation.state, 'draft');
    assert.equal(result.integration.draftCount, 1);
    assert.equal(result.integration.delivery.state, 'enabled');
    assert.equal(result.integration.operational.count, 1);
    const category = result.categories.find((item) => item.code === 'XG');
    assert.equal(category.operational.count, 1);
    assert.equal(category.operational.reasons.length, 2);
    assert.ok(category.operational.reasons.every((reason) => reason.count === 1));
    assert.equal(result.categories.find((item) => item.code === 'YG').operational.count, 0);
    assert.deepEqual(await before(), state);
    await db.query("UPDATE magento_auto_sync_activation SET enabled=FALSE WHERE singleton");
    assert.equal((await integrationOverview.overview(config, { databasePool: db, canViewProducts: true })).integration.operational.count, 1);
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
    await db.query("UPDATE options SET label='Unpublished mutable label' WHERE question_id=$1", [q.id]);
    await db.query("UPDATE questions SET label='Current information field' WHERE category_code='XG' AND key='new_note'");
    await db.query("INSERT INTO categories(code,name) VALUES('YG','Another category')");
    const creationInputs = await editor.creationInputs({ categoryCode: 'XG' }, { databasePool: db });
    assert.deepEqual(Object.keys(creationInputs.categories), ['XG']);
    assert.deepEqual(Object.keys(creationInputs.questions), ['XG']);
    assert.equal(creationInputs.questions.XG.find((item) => item.id === 'new_color').options[0].label, 'Explicit Amber label');
    assert.equal(creationInputs.questions.XG.find((item) => item.id === 'new_note').label, 'Current information field');
    assert.ok(creationInputs.categories.XG.sku_schema_version_id);
    assert.deepEqual(creationInputs.productCreateRequirements, {});
    assert.equal(Object.hasOwn(creationInputs, 'extraConfig'), false);
    await assert.rejects(editor.creationInputs({ categoryCode: 'UNKNOWN' }, { databasePool: db }), { code: 'MAGENTO_CREATION_CATEGORY_NOT_FOUND' });
    await db.query("INSERT INTO categories(code,name) VALUES('SV','Souvenirs')");
    assert.deepEqual((await editor.creationInputs({ categoryCode: 'SV' }, { databasePool: db })).productCreateRequirements,
      { SV: require('../src/services/product/new-product-readiness').requirements.SV });
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
