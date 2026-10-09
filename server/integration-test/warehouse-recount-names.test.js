const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

test('Storekeeper recount name edits need recount permission without export creation', async (t) => {
  const source = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = `amber_recount_names_${process.pid}_test`, control = new Client({ connectionString: source.toString() });
  await control.connect(); let db, appPool, created = false;
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0);
    await control.query(`CREATE DATABASE ${name}`); created = true;
    const target = new URL(source); target.pathname = `/${name}`;
    process.env.DATABASE_URL = target.toString(); process.env.MAGENTO_BASE_URL = 'https://effective-names.invalid';
    for (const key of ['MAGENTO_CONSUMER_KEY','MAGENTO_CONSUMER_SECRET','MAGENTO_ACCESS_TOKEN','MAGENTO_ACCESS_TOKEN_SECRET']) process.env[key] = 'warehouse-hotfix-test-credential-' + key; process.env.NBU_RATE_OVERRIDE = '40';
    require('../test/setup-env'); appPool = require('../src/db/pool');
    db = new Client({ connectionString: target.toString() }); await db.connect();
    await require('../src/db/run-migrations').runMigrations();
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Effective names fixture') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const config = { configured: true, baseUrl: 'https://effective-names.invalid', consumerKey: 'fixture', consumerSecret: 'fixture', accessToken: 'fixture', accessTokenSecret: 'fixture' };
    const options = { databasePool: appPool, mutationContext: { actorUserId: actor }, config, creationDeliveryConfig: config };
    await db.query("INSERT INTO categories(code,name,requires_weight,sku_publication_mode) VALUES('AR','Art',1,'explicit')");
    const question = (await db.query("INSERT INTO questions(category_code,key,label,sku_index,include_in_sku,required,input_type) VALUES('AR','type','Type',1,1,1,'options') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,1,'1','One')", [question]);
    const schema = await require('../src/services/sku-schema.service').publishSkuSchema('AR', options);
    await db.query('BEGIN');
    const legacyId = (await db.query(`INSERT INTO products(full_sku,base_sku,sequence_number,category,weight,total_price_uah,details,sku_schema_version_id,created_by_user_id)
      VALUES('AR1-000001','AR1',1,'AR',2,100,'{"answers":{"type":1}}',$1,$2) RETURNING id`, [schema.id, actor])).rows[0].id;
    await require('../src/services/full-product-export.service').initializeNewProduct(db, legacyId);
    await db.query('COMMIT');
    const fixture = require('../test/fixtures/magento-v4');
    const definition = fixture.definition(['AR']); delete definition.sources.color; delete definition.sources.note;
    definition.questionContracts = {}; definition.tables = {};
    definition.sources.weight = { kind: 'product', field: 'weight', type: 'scalar' };
    definition.groups[0].rows.forEach(row => { row.cells.name = { op: 'when', if: { op: 'in', input: { op: 'source', id: 'weight' }, values: [1, '1', '1.000'] },
      then: { op: 'join', delimiter: '', omitEmpty: false, items: [{ op: 'literal', value: row.id === 'base' ? 'Автоматична назва ' : 'Generated name ' }, { op: 'text', input: { op: 'source', id: 'sku' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' }] }, else: { op: 'literal', value: '' } }; });
    const templates = require('../src/services/export-templates/template.service');
    const family = await templates.createTemplate({ key: 'effective-names', displayName: 'Effective names', definition }, options);
    const old = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    const oldRow = (await db.query('SELECT * FROM export_template_versions WHERE id=$1', [old.id])).rows[0];
    const loaded = await templates.getTemplate(family.id, options);
    const upgraded = await templates.upgradeDraft(family.id, { expectedRevision: loaded.draft.revision, expectedDefinitionHash: loaded.draft.definitionHash,
      targetContract: 'effective-product-names-v1' }, options);
    const version = await templates.publishTemplate(family.id, { expectedRevision: upgraded.revision, expectedDefinitionHash: upgraded.definitionHash }, options);
    const bindings = require('../src/services/magento/binding.service'), observation = fixture.observation();
    let binding = await bindings.createDraft({ installationKey: 'effective-names', origin: config.baseUrl, templateVersionId: version.id, observedAt: new Date().toISOString(), schema: observation }, options);
    binding = await bindings.updateDraft(binding.id, { expectedRevision: binding.revision, bindings: fixture.approvedBindings(version.definition, observation) }, options);
    binding = await bindings.publishDraft(binding.id, { expectedRevision: binding.revision, expectedCurrentId: null }, options);
    const event = (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('public_sku.activated',$1,'{"displayName":"Effective names fixture","preferredUsername":null}','public_sku_activation','singleton',$2) RETURNING id`, [actor, crypto.randomUUID()])).rows[0].id;
    await db.query('BEGIN'); await db.query("SET LOCAL amber.public_sku_activation='on'");
    await db.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton', [actor, event]);
    const cutoverEvent = (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('magento_delivery.cutover',$1,'{"displayName":"Effective names fixture","preferredUsername":null}','public_sku_activation','singleton',$2) RETURNING id`, [actor, crypto.randomUUID()])).rows[0].id;
    await db.query("SET LOCAL amber.magento_delivery_cutover='on'");
    await db.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='effective-names',actor_user_id=$1,
      legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`, [actor, cutoverEvent]);
    await db.query('UPDATE magento_auto_sync_activation SET enabled=FALSE WHERE singleton'); await db.query('COMMIT');
    const products = require('../src/services/product.service');
    const nativePayload = { categoryCode: 'AR', answers: { type: 1 }, weight: 2,
      pricingDecision: { mode: 'manual_uah', manualPriceUah: 100 } };
    const actors = {};
    const servers = [];
    const localFetch = global.fetch;
    let externalFetches = 0;
    global.fetch = (url, ...args) => {
      if (new URL(url).hostname !== '127.0.0.1') { externalFetches++; throw Error('EXTERNAL_FETCH_FORBIDDEN'); }
      return localFetch(url, ...args);
    };
    const { createApp } = require('../src/app');
    async function login(role) {
      const calls = [];
      const issuer = 'https://auth.example.invalid/realms/amber';
      const adapter = { issuer, redirectUri: 'http://localhost:5000/api/auth/callback',
        async buildAuthorizationRedirect(transaction) { calls.push(transaction); return new URL('https://auth.example.invalid/authorize'); },
        async exchangeAuthorizationCode() { return { iss: issuer, sub: 'hotfix-' + role, name: 'Hotfix ' + role }; },
        async buildLogoutRedirect() { return null; } };
      const app = createApp({ oidcAdapter: adapter });
      const server = await new Promise(resolve => { const started = app.listen(0, '127.0.0.1', () => resolve(started)); });
      servers.push(server);
      const root = `http://127.0.0.1:${server.address().port}/api`;
      const start = await fetch(root + '/auth/login', { redirect: 'manual' }); assert.equal(start.status, 302);
      const callback = await fetch(root + '/auth/callback?code=fixture&state=' + calls[0].state,
        { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie').split(';')[0] } });
      assert.equal(callback.status, 303);
      const cookie = callback.headers.get('set-cookie').split(';')[0];
      const initial = await (await fetch(root + '/auth/me', { headers: { Cookie: cookie } })).json();
      const id = initial.applicationUser.id;
      await db.query("UPDATE application_users SET status='active',activated_at=CURRENT_TIMESTAMP WHERE id=$1", [id]);
      await db.query('INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key=$2', [id, role]);
      const command = async (route, body, { csrf = true } = {}) => {
        const response = await fetch(root + route, { method: body === undefined ? 'GET' : 'POST',
          headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': initial.csrfToken } : {}) }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json() };
      };
      return { id, command, options: { ...options, mutationContext: { actorUserId: id } } };
    }
    const savedPayload = (input, preview) => ({ ...input, category: input.categoryCode,
      characteristicConfigHash: preview.characteristicConfigHash, previewToken: preview.previewToken,
      ...(preview.skuReservation ? { skuReservation: preview.skuReservation } : {}) });
    try {
      actors.storekeeper = await login('storekeeper'); actors.manager = await login('manager');
      const warehouse = actors.storekeeper;
      await t.test('actual Storekeeper HTTP permissions and exact UA/EN recount save preserve history', async () => {
        const me = await warehouse.command('/auth/me'); assert.equal(me.status, 200);
        assert.equal(me.body.roles[0].key, 'storekeeper');
        assert.ok(me.body.permissions.includes('products.recount')); assert.ok(me.body.permissions.includes('products.create'));
        assert.ok(!me.body.permissions.includes('exports.create')); assert.ok(!me.body.permissions.includes('roles.manage'));
        const originalInput = { ...nativePayload, magentoNames: { all: ' Original UA ', en: ' Original EN ' } };
        const originalPreview = await products.buildNewProductPreview(originalInput, warehouse.options);
        const original = await products.saveProduct(savedPayload(originalInput, originalPreview), warehouse.options);
        const before = (await db.query('SELECT * FROM products WHERE id=$1', [original.id])).rows[0];
        const nextNames = { all: ' Назва комірниці ' + original.publicSku, en: ' Warehouse name ' + original.publicSku };
        const recount = { sourceSku: original.publicSku, answers: {}, weight: 2,
          pricingDecision: nativePayload.pricingDecision, nameChange: nextNames };
        const preview = await warehouse.command('/recount/preview', recount); assert.equal(preview.status, 200, JSON.stringify(preview.body));
        assert.deepEqual(preview.body.changes, []); assert.deepEqual(preview.body.nameChanges.to, nextNames);
        const applied = await warehouse.command('/recount/apply', { ...recount,
          sourceStateSignature: preview.body.source.stateSignature, previewToken: preview.body.previewToken });
        assert.equal(applied.status, 200, JSON.stringify(applied.body));
        const successor = (await db.query('SELECT * FROM products WHERE id=$1', [applied.body.correctedProductId])).rows[0];
        assert.deepEqual(successor.magento_name_override.values, nextNames);
        assert.equal(successor.public_product_identity_id, before.public_product_identity_id);
        assert.deepEqual([successor.magento_name_subject_ua, successor.magento_name_subject_en], [before.magento_name_subject_ua, before.magento_name_subject_en]);
        const retired = (await db.query('SELECT * FROM products WHERE id=$1', [original.id])).rows[0];
        assert.equal(retired.status, 'corrected'); assert.equal(retired.corrected_to_product_id, successor.id);
        assert.deepEqual(retired.magento_name_override, before.magento_name_override);
        assert.equal((await db.query('SELECT performed_by_user_id FROM product_corrections WHERE source_product_id=$1', [original.id])).rows[0].performed_by_user_id, String(warehouse.id));
        assert.deepEqual((await warehouse.command('/product-names/' + successor.id)).body.names, nextNames);
        for (const route of ['/product-names/save', '/magento/name-resolution/apply', '/export/snapshots', '/admin/roles']) {
          assert.equal((await warehouse.command(route, {})).status, 403, route);
        }
        assert.equal((await warehouse.command('/recount/preview', recount, { csrf: false })).status, 403);
        assert.equal((await warehouse.command('/recount/apply', recount, { csrf: false })).status, 403);
        const nextRecount={...recount,nameChange:{all:'Revoked UA',en:'Revoked EN'}};
        const nextPreview=await warehouse.command('/recount/preview',nextRecount);assert.equal(nextPreview.status,200);
        const nextApply={...nextRecount,sourceStateSignature:nextPreview.body.source.stateSignature,previewToken:nextPreview.body.previewToken};
        await db.query('DELETE FROM user_role_assignments WHERE application_user_id=$1',[warehouse.id]);
        try { await assert.rejects(products.applyProductRecount(nextApply,{...warehouse.options,authorizedDirectDecision:true,authorizedNameChange:true}),{statusCode:403}); }
        finally { await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='storekeeper'",[warehouse.id]); }
        assert.equal((await db.query('SELECT status FROM products WHERE id=$1',[successor.id])).rows[0].status,'active');
        assert.equal((await actors.manager.command('/recount/preview', recount)).status, 403);
        assert.equal((await actors.manager.command('/recount/apply', recount)).status, 403);
      });
      assert.equal(externalFetches, 0);
    } finally {
      global.fetch = localFetch;
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    }
  } finally {
    if (db) await db.end(); if (appPool) await appPool.end();
    if (created) { await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name]); await control.query(`DROP DATABASE ${name}`); }
    await control.end();
  }
});
