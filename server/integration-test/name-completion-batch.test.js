'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const nodePath = require('node:path');
const { Client } = require('pg');

// Real canonical name-resolution completion through the batch wrapper: two legacy products
// with no effective Amber names, a remote change between batch preview and locked apply,
// then resume. Magento is a GET-only fixture.
test('name completion batch accepts missing names through the canonical action and resumes a stale product', async () => {
  const source = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = `amber_name_completion_${process.pid}_test`, control = new Client({ connectionString: source.toString() });
  await control.connect(); let db, appPool, created = false;
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0);
    await control.query(`CREATE DATABASE ${name}`); created = true;
    const target = new URL(source); target.pathname = `/${name}`;
    process.env.DATABASE_URL = target.toString(); process.env.MAGENTO_BASE_URL = ''; process.env.NBU_RATE_OVERRIDE = '40';
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
    const legacyIds = [];
    for (const sequence of [1, 2]) {
      const id = (await db.query(`INSERT INTO products(full_sku,base_sku,sequence_number,category,weight,total_price_uah,details,sku_schema_version_id,created_by_user_id)
        VALUES($3,'AR1',$4,'AR',2,100,'{"answers":{"type":1}}',$1,$2) RETURNING id`, [schema.id, actor, `AR1-00000${sequence}`, sequence])).rows[0].id;
      await require('../src/services/full-product-export.service').initializeNewProduct(db, id);
      legacyIds.push(Number(id));
    }
    await db.query('COMMIT');
    const fixture = require('../test/fixtures/magento-v4');
    const definition = fixture.definition(['AR']); delete definition.sources.color; delete definition.sources.note;
    definition.questionContracts = {}; definition.tables = {};
    definition.sources.weight = { kind: 'product', field: 'weight', type: 'scalar' };
    definition.groups[0].rows.forEach(row => { row.cells.name = { op: 'when', if: { op: 'in', input: { op: 'source', id: 'weight' }, values: [1, '1', '1.000'] },
      then: { op: 'literal', value: row.id === 'base' ? 'Автоматична назва' : 'Generated name' }, else: { op: 'literal', value: '' } }; });
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
    const batch = require('../scripts/name-completion-batch');
    const skus = [];
    for (const id of legacyIds) skus.push((await db.query(`SELECT i.public_sku FROM products p
      JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1`, [id])).rows[0].public_sku);
    const remoteIds = new Map(skus.map((sku, index) => [sku, 77 + index]));
    const json = { headers: { 'content-type': 'application/json' } };
    let gets = 0, changedEnAfter = Infinity; const methods = new Set();
    const fetchImpl = async (url, request = {}) => {
      methods.add(request.method || 'GET'); gets++;
      const target = new URL(url), path = target.pathname;
      if (path.endsWith('/store/storeViews')) return new Response(JSON.stringify([{ id: 1, code: 'ua', is_active: true }, { id: 2, code: 'en', is_active: true }]), json);
      const sku = target.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');
      const english = path.includes('/en/');
      const name = english ? (sku === skus[1] && gets > changedEnAfter ? 'Changed EN ' + sku : 'Magento EN ' + sku) : 'Magento UA ' + sku;
      return new Response(JSON.stringify({ items: [{ id: remoteIds.get(sku), sku, name }], total_count: 1 }), json);
    };
    const directory = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'name-completion-it-'));
    const input = nodePath.join(directory, 'skus.json'), output = nodePath.join(directory, 'run');
    await fs.writeFile(input, JSON.stringify({ items: skus.map(sku => ({ sku })) }));
    const lines = [];
    const main = (args) => batch.main([...args, '--expected-database', name, '--actor-id', String(actor)],
      { pool: appPool, config, fetchImpl, print: line => lines.push(JSON.parse(line)), printError: line => lines.push(JSON.parse(line)) });

    const preview = await main(['--mode', 'preview', '--input', input, '--output', nodePath.join(directory, 'preview')]);
    assert.equal(preview, 0, JSON.stringify(lines));
    assert.equal((await db.query('SELECT count(*)::int n FROM products WHERE magento_name_override IS NOT NULL')).rows[0].n, 0);

    // Product 1: preview + locked apply (3 + 6 GETs). Product 2 changes EN right after its batch preview.
    gets = 0; changedEnAfter = 12; lines.length = 0;
    assert.equal(await main(['--mode', 'apply', '--input', input, '--output', output]), 2);
    assert.deepEqual(lines.at(-1).counts, { completed: 1, 'review:MAGENTO_NAME_PREVIEW_STALE': 1 });
    const first = (await db.query('SELECT magento_name_override FROM products WHERE id=$1', [legacyIds[0]])).rows[0].magento_name_override;
    assert.deepEqual(first.values, { all: 'Magento UA ' + skus[0], en: 'Magento EN ' + skus[0] });
    assert.equal((await db.query('SELECT magento_name_override FROM products WHERE id=$1', [legacyIds[1]])).rows[0].magento_name_override, null);

    // Resume reads the current remote pair afresh; the completed product is not applied again.
    lines.length = 0;
    assert.equal(await main(['--mode', 'resume', '--output', output]), 0);
    assert.deepEqual(lines.at(-1).counts, { completed: 2 });
    const second = (await db.query('SELECT magento_name_override FROM products WHERE id=$1', [legacyIds[1]])).rows[0].magento_name_override;
    assert.deepEqual(second.values, { all: 'Magento UA ' + skus[1], en: 'Changed EN ' + skus[1] });
    assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.magento_name_external_accepted'")).rows[0].n, 2);
    assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n, 0);
    assert.deepEqual([...methods], ['GET']);

    lines.length = 0;
    await main(['--mode', 'status', '--output', output]);
    assert.equal(lines.at(-1).completedNames, 2);
    await fs.rm(directory, { recursive: true, force: true });
  } finally {
    if (db) await db.end(); if (appPool) await appPool.end();
    if (created) await control.query(`DROP DATABASE ${name}`);
    await control.end();
  }
});
