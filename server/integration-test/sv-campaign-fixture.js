'use strict';
require('../test/setup-env');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
const fixture = require('../test/fixtures/magento-bindings');
const { insertProductFixture } = require('./product-fixture');
const c = require('../src/services/magento/binding-contract');
const gate = require('../src/services/full-product-cutover-gate');
const stages = require('../scripts/sv-campaign-stages');
const outbound = require('../scripts/sv-campaign-outbound');
const serverRoot = path.resolve(__dirname, '..');

// Observe the real pg.Pool without replacing clients, SQL, guards or services.
function instrumentPool(db) {
  const statistics = { active: 0, peak: 0, peakWaiting: 0, peakSaturatedWaiting: 0, acquired: 0, released: 0 };
  db.on('acquire', () => { statistics.active++; statistics.acquired++; statistics.peak = Math.max(statistics.peak, statistics.active); });
  db.on('release', () => { statistics.active--; statistics.released++; });
  const connect = db.connect;
  db.connect = function (...args) {
    const result = connect.apply(this, args);
    statistics.peakWaiting = Math.max(statistics.peakWaiting, this.waitingCount);
    // pg schedules idle-client reuse on the next tick; that short queue is not
    // pool exhaustion. Record waiting while every physical lease is held apart.
    if (statistics.active === this.options.max) statistics.peakSaturatedWaiting = Math.max(statistics.peakSaturatedWaiting, this.waitingCount);
    return result;
  };
  const reset = () => {
    assert.equal(statistics.active, 0); assert.equal(db.waitingCount, 0);
    Object.assign(statistics, { peak: 0, peakWaiting: 0, peakSaturatedWaiting: 0, acquired: 0, released: 0 });
  };
  return { statistics, reset };
}

async function setup(t) {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432');
  assert.equal(source.pathname, '/amber_test');
  assert.equal(source.username, 'amber_test');
  const name = 'amber_sv_campaign_' + process.pid + '_' + randomUUID().replaceAll('-', '').slice(0, 10) + '_test';
  assert.match(name, /^amber_sv_campaign_[a-z0-9_]+_test$/);
  const control = new Client({ connectionString: source.toString() }); await control.connect();
  let created = false, db, probe;
  t.after(async () => {
    if (probe) await probe.end();
    if (db) await db.end();
    if (created) await control.query('DROP DATABASE ' + name);
    await control.end();
  });
  assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0);
  await control.query('CREATE DATABASE ' + name); created = true;
  const target = new URL(source); target.pathname = '/' + name;
  const env = { ...process.env, DATABASE_URL: target.toString() };
  await promisify(execFile)(process.execPath, ['-e', "require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});"],
    { cwd: serverRoot, env, timeout: 60000 });
  t.mock.method(globalThis, 'fetch', () => assert.fail('Live network is forbidden in the synthetic SV campaign fixture'));
  const runtime = Object.assign(stages.createRuntime(serverRoot), outbound.extendRuntime(serverRoot));
  db = runtime.createPool(env);
  assert.equal(db.options.max, 4, 'Exercise the actual standalone runtime pool budget');
  const { statistics, reset } = instrumentPool(db);
  probe = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 5000, statement_timeout: 5000 }); await probe.connect();
  const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','SV campaign fixture Administrator') RETURNING id")).rows[0].id);
  await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
  for (const code of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) await db.query('INSERT INTO categories(code,name) VALUES($1,$1)', [code]);
  await db.query("INSERT INTO questions(category_code,key,label,sku_index,display_order,required,include_in_sku,input_type) VALUES('SV','weight','Synthetic stored weight',0,99,0,0,'text')");
  await db.query("INSERT INTO exchange_rate_cache(currency_pair,rate,rate_date,fetched_at) VALUES('USD_UAH',40,CURRENT_DATE,clock_timestamp())");
  const definition = structuredClone(fixture.definition());
  const literal = value => ({ op: 'literal', value });
  const text = id => ({ op: 'text', input: { op: 'source', id }, trim: false, format: 'scalar-v1', onAbsent: 'empty' });
  definition.sources = { sku: definition.sources.sku, price: { kind: 'product', field: 'total_price_uah', type: 'scalar' },
    svWeight: { kind: 'information', category: 'SV', key: 'weight', type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] } };
  definition.tables = {};
  for (const group of definition.groups) for (const row of group.rows) {
    delete row.cells.kolir; delete row.cells.decor_weight; delete row.cells.dovzhyna_brasletu_diuimiv;
    row.cells.price = row.id === 'base' ? text('price') : literal('');
    row.cells.name = literal(row.id === 'base' ? 'Generated SV UA' : 'Generated SV EN');
    if (group.route === 'SV' && row.id === 'base') {
      row.cells.decor_weight = text('svWeight'); row.cells.product_websites = literal('fixture');
    }
  }
  const rawSchema = structuredClone(fixture.schema());
  rawSchema.attributes.find(row => row.attribute_code === 'name').scope = 'store';
  Object.assign(rawSchema.attributes.find(row => row.attribute_code === 'decor_weight'), { frontend_input: 'text', options: [] });
  rawSchema.storeTopology.websites[0].default_group_id = 802;
  rawSchema.storeTopology.storeGroups[0].default_store_id = 805;
  rawSchema.storeTopology.storeViews.push({ id: 805, code: 'default', name: 'Ukrainian', website_id: 801, store_group_id: 802, is_active: true });
  const schema = c.normalizeSchema(rawSchema);
  const config = { configured: true, baseUrl: 'https://sv-campaign.invalid', consumerKey: 'synthetic-oauth-consumer-key',
    consumerSecret: 'synthetic-oauth-consumer-secret', accessToken: 'synthetic-oauth-access-token', accessTokenSecret: 'synthetic-oauth-access-secret' };
  const options = { databasePool: db, actorUserId: actor, mutationContext: { actorUserId: actor, requestId: randomUUID() } };
  const templates = require('../src/services/export-templates/template.service');
  const family = await templates.createTemplate({ key: 'sv-campaign-' + randomUUID(), displayName: 'SV campaign fixture', definition }, options);
  const version = await templates.publishTemplate(family.id,
    { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
  const bindings = require('../src/services/magento/binding.service'), approved = fixture.approvedBindings(definition, schema, 'SV');
  const native = { attribute_set_code: 'product.attribute_set_id', product_type: 'product.type_id', product_websites: 'product.extension_attributes.website_ids' };
  for (const row of approved.attributes) if (native[row.target]) row.transportTarget = native[row.target];
  for (const row of approved.policies) {
    const field = approved.attributes.find(field => require('../src/services/magento/binding-validation').bindingKey(field.routeKey, field.rowId, field.target) === row.bindingKey);
    row.policy = field.rowId === 'english' && ['sku', 'product_type', 'attribute_set_code', 'store_view_code'].includes(field.target)
      ? 'magento_managed' : 'authoritative_create_update';
  }
  let binding = await bindings.createDraft({ installationKey: 'sv-campaign-fixture', origin: config.baseUrl,
    templateVersionId: version.id, observedAt: '2026-10-14T00:00:00Z', schema }, options);
  binding = await bindings.updateDraft(binding.id, { expectedRevision: binding.revision, bindings: approved }, options);
  binding = await bindings.publishDraft(binding.id, { expectedRevision: binding.revision, expectedCurrentId: null }, options);
  const products = [], remotes = new Map(), calls = [];
  async function addProduct(sku, historical) {
    const insert = client => insertProductFixture(client,
      'INSERT INTO products(full_sku,category,weight,total_price_uah,details) VALUES($1,\'SV\',5.400,1700,$2::jsonb) RETURNING *',
      [sku, JSON.stringify({ answers: { souvenir: 5, weight: '5.400' }, manualPriceUah: 1700 })]);
    const row = (historical ? await insert(db) : await write(async client => {
      const result = await insert(client);
      await client.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1", [result.rows[0].id]);
      return result;
    })).rows[0];
    const p = { id: row.id, productId: row.id, sku, remoteId: 98700 + products.length, remoteProductId: 98700 + products.length,
      publicIdentityId: String(row.public_product_identity_id), category: 'SV' };
    if (historical) {
      await db.query("UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',business_exclusion_state='none',delivery_version=delivery_version+1,evidence='{\"origin\":\"migration_039\",\"coverage\":\"unresolved_historical\"}' WHERE product_id=$1", [row.id]);
      await db.query('INSERT INTO product_export_revisions(product_id,has_product_snapshot) VALUES($1,TRUE)', [row.id]);
    }
    products.push(p);
    remotes.set(sku, { id: p.remoteId, sku, attribute_set_id: 8001, type_id: 'simple', name: 'Exact remote UA ' + products.length,
      price: 1650, status: 1, visibility: 4, custom_attributes: [{ attribute_code: 'decor_weight', value: '5' }],
      extension_attributes: { website_ids: [801], category_links: [] }, en: { name: 'Exact remote EN ' + products.length } });
    return p;
  }
  async function write(operation) {
    const client = await db.connect();
    try { await gate.begin(client, 'BEGIN'); const result = await operation(client); await gate.commit(client); return result; }
    catch (cause) { await gate.rollback(client); throw cause; } finally { await gate.release(client); client.release(); }
  }
  await addProduct('SV-CAMPAIGN-HISTORY', true); await addProduct('SV-CAMPAIGN-EQUAL', true);
  await db.query('UPDATE export_state SET exported_to_product_id=$1', [products.at(-1).id]);
  const cutover = require('../src/services/full-product-cutover.service');
  const maintenance = { ...options, expectedDatabase: name, deploymentEvidence: 'Disposable SV campaign fixture; no legacy CSV writer' };
  await cutover.prepare(maintenance); const index = await cutover.generate('index', maintenance);
  assert.deepEqual(index.indexing.diagnostics, []); await cutover.indexHistorical(index, index.contentSha256, maintenance);
  const manifest = await cutover.generate('cutover', maintenance);
  assert.equal(manifest.entries.length, 2); assert.ok(manifest.entries.every(row => row.action === 'legacy_baseline'));
  await cutover.approve(manifest, manifest.contentSha256, 'Synthetic SV campaign fixture only', maintenance);
  await cutover.applyBatch(manifest.contentSha256, 0, maintenance); await cutover.activate(manifest.contentSha256, maintenance);
  const event = (await db.query("INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id) VALUES('magento_delivery.cutover',$1,'{\"displayName\":\"Fixture\",\"preferredUsername\":null}','fixture','csv-disabled',$2) RETURNING id", [actor, randomUUID()])).rows[0].id;
  await write(async client => {
    await client.query("SET LOCAL amber.magento_delivery_cutover='on'");
    await client.query('UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton', [binding.installationKey, actor, event]);
  });
  await addProduct('AG-CAMPAIGN-PRISTINE', false);
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); assert.equal(u.hostname, 'sv-campaign.invalid');
    assert.equal(init.method || 'GET', 'GET'); assert.equal(init.body, undefined);
    calls.push({ path: u.pathname, method: 'GET' });
    const endpoint = u.pathname.replace(/^\/rest\/[^/]+\/V1\//, ''); let data;
    if (endpoint === 'products') {
      const sku = u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');
      const value = structuredClone(remotes.get(sku)); assert.ok(value, sku);
      if (u.pathname.includes('/rest/en/')) { value.name = value.en.name; value.custom_attributes = []; }
      delete value.en; data = { items: [value], total_count: 1 };
    } else if (endpoint === 'store/websites') data = rawSchema.storeTopology.websites;
    else if (endpoint === 'store/storeGroups') data = rawSchema.storeTopology.storeGroups;
    else if (endpoint === 'store/storeViews') data = rawSchema.storeTopology.storeViews;
    else if (endpoint === 'products/attribute-sets/sets/list') data = { items: rawSchema.attributeSets, total_count: rawSchema.attributeSets.length };
    else if (endpoint === 'products/attributes') data = { items: rawSchema.attributes, total_count: rawSchema.attributes.length };
    else if (endpoint === 'products/attribute-sets/8001/attributes') data = rawSchema.attributes;
    else if (/^products\/attributes\/[^/]+\/options$/.test(endpoint)) {
      const code = endpoint.split('/')[2]; data = rawSchema.attributes.find(row => row.attribute_code === code)?.options;
      assert.ok(data, endpoint);
    } else if (endpoint === 'categories') data = { id: 803, parent_id: 0, name: 'Synthetic root', is_active: true, position: 0, level: 0, product_count: 0, children_data: [] };
    else if (endpoint === 'store/storeConfigs') data = [
      { id: 805, code: 'default', website_id: 801, locale: 'uk_UA', base_currency_code: 'UAH' },
      { id: 804, code: 'en', website_id: 801, locale: 'en_US', base_currency_code: 'UAH' }];
    else assert.fail('Unexpected synthetic Magento endpoint: ' + endpoint);
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  };
  const run = { ...options, installation: binding.installationKey, fetchImpl, requestId: randomUUID() };
  const scope = { bindingRevisionId: binding.id, expectedDefinitionHash: binding.definitionHash,
    installationKey: binding.installationKey, publicationHash: c.hash(binding) };
  const authority = async () => {
    const observed = await require('../scripts/first-sync-local-discovery').readAuthority(runtime, config, run);
    assert.deepEqual(observed, { bindingRevisionId: binding.id, expectedDefinitionHash: binding.definitionHash, publicationHash: scope.publicationHash });
  };
  const request = p => ({ sku: p.sku, bindingRevisionId: binding.id });
  const fields = p => require('../src/services/magento/first-sync-ledger').readOnClient(db,
    { originHash: c.originHash(config.baseUrl), publicIdentityId: p.publicIdentityId });
  const assertLaneHeld = async p => {
    const key = 'amber_magento_public_identity:' + p.publicIdentityId;
    const held = (await probe.query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [key])).rows[0].held;
    if (held) await probe.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
    assert.equal(held, false, 'Independent session must not enter an active campaign lane');
  };
  const f = { name, target: target.toString(), env, db, probe, actor, binding, config, options, run, scope, runtime,
    products, remotes, calls, write, fetchImpl, request, fields, authority, statistics, reset, assertLaneHeld };
  reset(); return f;
}

module.exports = { setup, instrumentPool };
