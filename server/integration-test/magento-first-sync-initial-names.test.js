'use strict';
require('../test/setup-env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Pool, Client } = require('pg');
const fixture = require('../test/fixtures/magento-bindings');
const { insertProductFixture } = require('./product-fixture');
const c = require('../src/services/magento/binding-contract');
const first = require('../src/services/magento/first-sync.service');
const admission = require('../src/services/magento/first-sync-cutover-admission');
const ledger = require('../src/services/magento/first-sync-ledger');
const jobs = require('../src/services/magento/sync-job.service');
const gate = require('../src/services/full-product-cutover-gate');
const serverRoot = path.resolve(__dirname, '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const targets = ['meta_title', 'meta_description'];
const template = (target, scope) => 'Synthetic local ' + scope + ' ' + target;
const clean = row => Object.fromEntries(['target', 'scope', 'state', 'before', 'remote', 'after', 'source', 'mappingHash'].map(key => [key, row[key]]));

async function snapshot(db) {
  const data = {};
  for (const { tablename } of (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    assert.match(tablename, /^[a-z_]+$/);
    data[tablename] = (await db.query(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) rows
      FROM (SELECT to_jsonb(t) j FROM public."${tablename}" t) entries`)).rows[0].rows;
  }
  return data;
}

async function setup(t) {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.ok(source.pathname.endsWith('_test'));
  const name = 'amber_initial_names_' + process.pid + '_test';
  const control = new Client({ connectionString: source.toString() }); await control.connect();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-initial-names-')); let db, readOnly, created = false;
  t.after(async () => {
    if (readOnly) await readOnly.end(); if (db) await db.end();
    if (created) await control.query('DROP DATABASE ' + name);
    await control.end(); await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0);
  await require('./harness').createTestDatabase(name); created = true;
  const target = new URL(source); target.pathname = '/' + name;

  db = new Pool({ connectionString: target.toString(), max: 4 });
  readOnly = new Pool({ connectionString: target.toString(), max: 1, options: '-c default_transaction_read_only=on' });
  t.mock.method(globalThis, 'fetch', () => assert.fail('No live Magento or NBU HTTP in this synthetic fixture'));
  const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Initial names fixture Administrator') RETURNING id")).rows[0].id);
  await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
  for (const code of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) await db.query('INSERT INTO categories(code,name) VALUES($1,$1)', [code]);
  const definition = structuredClone(fixture.definition());
  const literal = value => ({ op: 'literal', value });
  const text = id => ({ op: 'text', input: { op: 'source', id }, trim: false, format: 'scalar-v1', onAbsent: 'empty' });
  definition.sources = { sku: definition.sources.sku, weight: definition.sources.weight, price: { kind: 'product', field: 'total_price_uah', type: 'scalar' } };
  definition.tables = {};
  for (const group of definition.groups) for (const row of group.rows) {
    delete row.cells.kolir; delete row.cells.decor_weight; delete row.cells.dovzhyna_brasletu_diuimiv;
    row.cells.price = row.id === 'base' ? text('price') : literal('');
    row.cells.name = literal(row.id === 'base' ? 'Generated local UA' : 'Generated local EN');
    if (['AR', 'NM'].includes(group.route) && row.id === 'base') {
      if (group.route === 'NM') row.cells.decor_weight = text('weight');
      row.cells.product_websites = literal('fixture');
    }
    if (group.route === 'NM') for (const field of targets) row.cells[field] = literal(template(field, row.id === 'base' ? 'all' : 'en'));
  }
  const raw = structuredClone(fixture.schema());
  raw.attributes.find(row => row.attribute_code === 'name').scope = 'store';
  Object.assign(raw.attributes.find(row => row.attribute_code === 'decor_weight'), { frontend_input: 'text', options: [] });
  for (const [index, field] of targets.entries()) {
    raw.attributes.push({ attribute_id: 970 + index, attribute_code: field, frontend_input: index ? 'textarea' : 'text', scope: 'store', options: [] });
    raw.attributeSets[0].attributeCodes.push(field);
  }
  raw.storeTopology.websites[0].default_group_id = 802; raw.storeTopology.storeGroups[0].default_store_id = 805;
  raw.storeTopology.storeViews.push({ id: 805, code: 'default', name: 'Ukrainian', website_id: 801, store_group_id: 802, is_active: true });
  const schema = c.normalizeSchema(raw);
  const config = { configured: true, baseUrl: 'https://initial-names.invalid', consumerKey: 'fixture-key', consumerSecret: 'fixture-secret', accessToken: 'fixture-token', accessTokenSecret: 'fixture-token-secret' };
  const options = { databasePool: db, actorUserId: actor, mutationContext: { actorUserId: actor } };
  const templates = require('../src/services/export-templates/template.service');
  const family = await templates.createTemplate({ key: 'initial-names-' + randomUUID(), displayName: 'Initial names fixture', definition }, options);
  const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
  const bindings = require('../src/services/magento/binding.service');
  const approved = fixture.approvedBindings(definition, schema, 'AR'), nm = fixture.approvedBindings(definition, schema, 'NM');
  approved.routes = approved.routes.map(route => route.enabled ? route : nm.routes.find(other => other.routeKey === route.routeKey));
  for (const key of ['attributes', 'options', 'policies']) approved[key].push(...nm[key]);
  const native = { attribute_set_code: 'product.attribute_set_id', product_type: 'product.type_id', product_websites: 'product.extension_attributes.website_ids' };
  for (const row of approved.attributes) if (native[row.target]) row.transportTarget = native[row.target];
  for (const row of approved.policies) {
    const field = approved.attributes.find(field => require('../src/services/magento/binding-validation').bindingKey(field.routeKey, field.rowId, field.target) === row.bindingKey);
    row.policy = field.rowId === 'english' && ['sku', 'product_type', 'attribute_set_code', 'store_view_code'].includes(field.target) ? 'magento_managed' : 'authoritative_create_update';
  }
  let binding = await bindings.createDraft({ installationKey: 'initial-names-fixture', origin: config.baseUrl, templateVersionId: version.id, observedAt: '2026-10-13T00:00:00Z', schema }, options);
  binding = await bindings.updateDraft(binding.id, { expectedRevision: binding.revision, bindings: approved }, options);
  binding = await bindings.publishDraft(binding.id, { expectedRevision: binding.revision, expectedCurrentId: null }, options);
  const products = [], remotes = new Map(), calls = [];
  for (let index = 0; index < 16; index++) {
    const category = index < 14 ? 'AR' : 'NM', sku = category + '-INITIAL-NAMES-' + index, remoteId = 98100 + index;
    const row = (await insertProductFixture(db, "INSERT INTO products(full_sku,category,weight,total_price_uah,details) VALUES($1,$2,132.300,1700,$3::jsonb) RETURNING *",
      [sku, category, JSON.stringify({ answers: {}, manualPriceUah: 1700 })])).rows[0];
    await db.query("UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',business_exclusion_state='none',delivery_version=delivery_version+1,evidence='{\"origin\":\"migration_039\",\"coverage\":\"unresolved_historical\"}' WHERE product_id=$1", [row.id]);
    await db.query('INSERT INTO product_export_revisions(product_id,has_product_snapshot) VALUES($1,TRUE)', [row.id]);
    products.push({ sku, id: row.id, remoteId, category, publicIdentityId: String(row.public_product_identity_id) });
    remotes.set(sku, { id: remoteId, sku, attribute_set_id: 8001, type_id: 'simple', name: 'Exact remote UA ' + index, price: 1650, status: 1, visibility: 4,
      custom_attributes: [{ attribute_code: 'decor_weight', value: 132 }, ...targets.map(field => ({ attribute_code: field, value: 'Remote all ' + field }))],
      extension_attributes: { website_ids: [801], category_links: [] }, en: { name: 'Exact remote EN ' + index, ...Object.fromEntries(targets.map(field => [field, 'Remote en ' + field])) } });
  }
  await db.query('UPDATE export_state SET exported_to_product_id=$1', [products.at(-1).id]);
  const cutover = require('../src/services/full-product-cutover.service');
  const maintenance = { ...options, expectedDatabase: name, deploymentEvidence: 'Disposable names fixture; no legacy CSV writer' };
  await cutover.prepare(maintenance); const index = await cutover.generate('index', maintenance);
  assert.deepEqual(index.indexing.diagnostics, []); await cutover.indexHistorical(index, index.contentSha256, maintenance);
  const manifest = await cutover.generate('cutover', maintenance);
  assert.equal(manifest.entries.length, products.length); assert.ok(manifest.entries.every(row => row.action === 'legacy_baseline'));
  await cutover.approve(manifest, manifest.contentSha256, 'Synthetic names fixture only', maintenance);
  await cutover.applyBatch(manifest.contentSha256, 0, maintenance); await cutover.activate(manifest.contentSha256, maintenance);
  async function write(operation) {
    const client = await db.connect();
    try { await gate.begin(client, 'BEGIN'); const result = await operation(client); await gate.commit(client); return result; }
    catch (cause) { await gate.rollback(client); throw cause; } finally { await gate.release(client); client.release(); }
  }
  const event = (await db.query("INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id) VALUES('magento_delivery.cutover',$1,'{\"displayName\":\"Fixture\",\"preferredUsername\":null}','fixture','csv-disabled',$2) RETURNING id", [actor, randomUUID()])).rows[0].id;
  await write(async client => {
    await client.query("SET LOCAL amber.magento_delivery_cutover='on'");
    await client.query('UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton', [binding.installationKey, actor, event]);
  });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); assert.equal(u.hostname, 'initial-names.invalid'); assert.equal(init.method || 'GET', 'GET');
    calls.push({ path: u.pathname, method: init.method || 'GET' }); let data;
    if (u.pathname.endsWith('/V1/products')) {
      const sku = u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'), value = structuredClone(remotes.get(sku)); assert.ok(value);
      if (u.pathname.includes('/rest/en/')) { value.name = value.en.name; value.custom_attributes = targets.map(field => ({ attribute_code: field, value: value.en[field] })); }
      delete value.en; data = { items: [value], total_count: 1 };
    } else {
      assert.ok(u.pathname.endsWith('/store/storeConfigs'), u.pathname);
      data = [{ id: 805, code: 'default', website_id: 801, locale: 'uk_UA', base_currency_code: 'UAH' }, { id: 804, code: 'en', website_id: 801, locale: 'en_US', base_currency_code: 'UAH' }];
    }
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  };
  const canonicalPreview = (cfg, input) => require('../src/services/magento/sync-preview').previewProduct(cfg,
    { ...input, discover: async () => binding.schema, categoryObservation: { trees: [], categoryFailures: [] } });
  const run = { ...options, preview: canonicalPreview, fetchImpl };
  const f = { db, readOnly, dir, name, actor, binding, config, run, products, remotes, calls, write, canonicalPreview, fetchImpl };
  f.request = p => ({ sku: p.sku, bindingRevisionId: binding.id });
  f.fields = p => ledger.readOnClient(db, { originHash: c.originHash(config.baseUrl), publicIdentityId: p.publicIdentityId });
  f.state = async p => (await db.query('SELECT * FROM product_full_export_state WHERE product_id=$1', [p.id])).rows[0];
  f.admit = async p => {
    const review = await first.review(config, f.request(p), run);
    assert.equal(review.historyReviewAssessment?.status, 'available', JSON.stringify(review));
    const receipt = await admission.apply(config, { ...f.request(p), previewToken: review.historyReview.previewToken }, run);
    assert.equal(await f.fields(p), null); return String(receipt.receipt.auditEventId);
  };
  let artifactIndex = 0;
  f.runtime = () => {
    const runtime = require('../scripts/first-sync-initial-names').createRuntime(serverRoot);
    runtime.preview = canonicalPreview;
    runtime.boundary = { ...runtime.boundary, observe: (cfg, input, opts) => jobs.recoveryBoundary.observe(cfg, input, { ...opts, preview: canonicalPreview }) };
    return runtime;
  };
  f.review = async selected => {
    const scope = { bindingRevisionId: binding.id, expectedDefinitionHash: binding.definitionHash, installationKey: binding.installationKey, choice: 'magento',
      items: selected.map(p => ({ sku: p.sku, productId: p.id, remoteProductId: p.remoteId })) };
    const input = path.join(dir, 'scope-' + (++artifactIndex) + '.json'), bytes = Buffer.from(JSON.stringify(scope) + '\n'); await fs.writeFile(input, bytes);
    const output = path.join(dir, 'preview-' + artifactIndex), messages = [];
    const before = await snapshot(db);
    const code = await require('../scripts/first-sync-initial-names').main(['--mode', 'preview', '--input', input, '--scope-sha256', sha(bytes), '--output', output,
      '--server-root', serverRoot, '--expected-database', name, '--actor-id', String(actor)],
    { runtime: f.runtime(), pool: readOnly, config, env: {}, fetchImpl, print: text => messages.push(JSON.parse(text)), printError: text => messages.push(JSON.parse(text)) });
    assert.deepEqual(await snapshot(db), before, 'preview changes no persisted table');
    const reviewBytes = await fs.readFile(path.join(output, 'review.json'));
    return { code, directory: output, hash: sha(reviewBytes), review: JSON.parse(reviewBytes), messages };
  };
  f.invoke = async (review, mode = 'apply', { output = path.join(dir, 'run-' + (++artifactIndex)), ...overrides } = {}) => {
    const messages = [];
    const code = await require('../scripts/first-sync-initial-names').main(['--mode', mode, '--review', review.directory, '--review-sha256', review.hash,
      '--output', output, '--server-root', serverRoot, '--expected-database', name, '--actor-id', String(actor)],
    { runtime: f.runtime(), pool: db, config, env: {}, fetchImpl, print: text => messages.push(JSON.parse(text)), printError: text => messages.push(JSON.parse(text)), ...overrides });
    const journal = await fs.readFile(path.join(output, 'results.jsonl'), 'utf8').then(text => text.trim().split('\n').map(JSON.parse)).catch(() => []);
    return { code, output, journal, messages };
  };
  return f;
}

test('bounded initial names uses genuine legacy admission despite the ordinary baseline blocker', async t => {
  const f = await setup(t);
  const sameOldRows = (before, after) => {
    for (const table of ['magento_first_sync_fields', 'magento_first_sync_progress', 'audit_events']) {
      const rows = new Set(after[table].map(c.hash));
      for (const row of before[table]) assert.ok(rows.has(c.hash(row)), table + ' old immutable row');
    }
  };
  await t.test('read-only preview refuses missing history admission without creating a session', async () => {
    const p = f.products[13], result = await f.review([p]);
    assert.notEqual(result.code, 0); assert.equal(await f.fields(p), null);
    assert.ok(f.calls.every(call => call.method === 'GET'));
  });
  await t.test('ordinary name acceptance before history advances the CSV floor and keeps admission available while legacy CSV is disabled', async () => {
    const p = f.products[10], resolution = require('../src/services/magento/name-resolution.service');
    const input = { productId: p.id, choice: 'magento' }, options = { ...f.run, config: f.config };
    assert.equal((await first.review(f.config, f.request(p), f.run)).historyReviewAssessment?.status, 'available');
    const before = await f.state(p), preview = await resolution.preview(input, options);
    await resolution.apply({ ...input, previewToken: preview.previewToken }, options);
    const state = await f.state(p), checked = await first.review(f.config, f.request(p), f.run);
    assert.equal(BigInt(state.revision), BigInt(before.revision) + 1n);
    assert.equal(state.csv_retired_revision, state.revision); assert.equal(await f.fields(p), null);
    // A revision retired at birth while legacy CSV is disabled cannot have been exported (approved 2026-10-14).
    assert.equal(checked.mode, 'review'); assert.equal(checked.historyReviewAssessment?.status, 'available');
    assert.ok(checked.historyReview, 'admission is still offered'); assert.equal(await f.fields(p), null);
    assert.ok(f.calls.every(call => call.method === 'GET'));
  });
  await t.test('no-session AR baseline conflict imports only two names and atomically captures the advanced CSV floor', async () => {
    const p = f.products[0], root = await f.admit(p);
    const observed = await jobs.recoveryBoundary.observe(f.config, f.request(p), f.run);
    assert.deepEqual(observed.report.blockers.map(row => row.code), ['NAME_BASELINE_REQUIRED']);
    assert.equal(observed.observation.amber.nameState, null);
    assert.equal(await f.fields(p), null); assert.equal((await f.state(p)).csv_retired_revision, '0');
    const review = await f.review([p]); assert.equal(review.code, 0, JSON.stringify(review.messages));
    const before = await snapshot(f.db), applied = await f.invoke(review);
    assert.equal(applied.code, 0, JSON.stringify(applied));
    const current = await f.fields(p), state = await f.state(p), after = await snapshot(f.db);
    assert.equal(current.session.revision, '1'); assert.equal(current.historyAdmissionEventId, root);
    assert.equal(current.fields.filter(row => row.target === 'name' && row.state === 'name_received').length, 2);
    assert.ok(current.fields.filter(row => row.target !== 'name').every(row => !['imported', 'name_received'].includes(row.state) && !row.source?.decision));
    const oldProduct = before.products.find(row => row.id === p.id), product = after.products.find(row => row.id === p.id);
    assert.deepEqual(product.magento_name_override.values, { all: f.remotes.get(p.sku).name, en: f.remotes.get(p.sku).en.name });
    assert.deepEqual({ ...product, magento_name_override: oldProduct.magento_name_override }, oldProduct);
    const oldState = before.product_full_export_state.find(row => row.product_id === p.id);
    assert.equal(BigInt(state.revision), BigInt(oldState.revision) + 1n); assert.equal(state.csv_retired_revision, state.revision);
    assert.deepEqual(current.admissionProgress.result.historyAdmissionState, { revision: state.revision, csvRetiredRevision: state.csv_retired_revision });
    assert.equal(current.admissionProgress.command.historyAdmissionEventId, root);
    const allowed = new Set(['products', 'product_full_export_state', 'magento_product_sync_requests', 'magento_name_sync_states',
      'magento_first_sync_sessions', 'magento_first_sync_fields', 'magento_first_sync_progress', 'audit_events']);
    for (const [table, rows] of Object.entries(before)) if (!allowed.has(table)) assert.deepEqual(after[table], rows, table);
    sameOldRows(before, after);
    const request = after.magento_product_sync_requests.find(row => row.product_id === p.id);
    assert.equal(request.state, 'pending'); assert.equal(request.active_job_id, null);
    assert.equal(after.magento_sync_jobs.length, 0); assert.ok(f.calls.every(call => call.method === 'GET'));
    const next = await first.review(f.config, f.request(p), f.run);
    assert.equal(next.mode, 'first'); assert.ok(!next.blockers.some(row => row.code === 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED'));
    const resumed = await f.invoke(review, 'resume', { output: applied.output });
    assert.equal(resumed.code, 0, JSON.stringify(resumed)); assert.deepEqual(await snapshot(f.db), after);
    const repeat = await f.invoke(review); assert.notEqual(repeat.code, 0, 'old reviewed source cannot be applied again');
    assert.deepEqual(await snapshot(f.db), after);
  });
  for (const terminalSeo of [false, true]) await t.test('existing canonical price, weight and ' + (terminalSeo ? 'terminal/pending' : 'pending') + ' SEO remain unchanged while names append a fresh history state', async () => {
    const p = f.products[terminalSeo ? 15 : 14], remote = f.remotes.get(p.sku), names = { all: remote.name, en: remote.en.name };
    if (terminalSeo) {
      remote.custom_attributes.find(row => row.attribute_code === 'meta_title').value = template('meta_title', 'all');
      remote.en.meta_title = template('meta_title', 'en');
    }
    remote.name = ''; remote.en.name = ''; const root = await f.admit(p);
    const review = await first.review(f.config, f.request(p), f.run);
    const choices = review.fields.filter(row => ['price', 'decor_weight', ...targets].includes(row.target) && row.canKeepLocal)
      .map(({ target, scope }) => ({ target, scope, choice: 'keep_local' }));
    assert.equal(choices.length, terminalSeo ? 4 : 6, JSON.stringify(review));
    await first.apply(f.config, { ...f.request(p), previewToken: review.previewToken, choices }, f.run);
    const prior = await f.fields(p); assert.equal(prior.historyAdmissionEventId, root);
    assert.equal(prior.fields.filter(row => row.source?.decision === 'keep_local').length, terminalSeo ? 4 : 6);
    if (terminalSeo) assert.equal(prior.fields.filter(row => row.target === 'meta_title' && row.state === 'equal').length, 2);
    remote.name = names.all; remote.en.name = names.en;
    const observed = await jobs.recoveryBoundary.observe(f.config, f.request(p), f.run);
    assert.deepEqual(observed.report.blockers.map(row => row.code), ['NAME_BASELINE_REQUIRED']);
    const sealed = await f.review([p]); assert.equal(sealed.code, 0, JSON.stringify(sealed.messages));
    const before = await snapshot(f.db), applied = await f.invoke(sealed); assert.equal(applied.code, 0, JSON.stringify(applied));
    const current = await f.fields(p), after = await snapshot(f.db), state = await f.state(p);
    assert.equal(BigInt(current.session.revision), BigInt(prior.session.revision) + 1n);
    assert.equal(current.historyAdmissionEventId, root);
    assert.deepEqual(current.fields.filter(row => row.target !== 'name').map(clean), prior.fields.filter(row => row.target !== 'name').map(clean));
    assert.equal(current.fields.filter(row => row.state === 'name_received').length, 2);
    assert.deepEqual(current.admissionProgress.result.historyAdmissionState, { revision: state.revision, csvRetiredRevision: state.csv_retired_revision });
    sameOldRows(before, after); assert.equal((await first.review(f.config, f.request(p), f.run)).mode, 'first');
    const oldRequest = before.magento_product_sync_requests.find(row => row.product_id === p.id), request = after.magento_product_sync_requests.find(row => row.product_id === p.id);
    assert.equal(BigInt(request.desired_generation), BigInt(oldRequest?.desired_generation || '0') + 1n);
  });
  await t.test('failure after real ledger persistence rolls back names, lifecycle, request, baseline and receipts', async subtest => {
    const p = f.products[1]; await f.admit(p); const review = await f.review([p]); assert.equal(review.code, 0, JSON.stringify(review.messages));
    const before = await snapshot(f.db), record = ledger.recordProgressOnClient; let reached = false;
    subtest.mock.method(ledger, 'recordProgressOnClient', async (client, input) => {
      const result = await record(client, input); reached = true;
      assert.equal((await client.query('SELECT count(*)::int n FROM magento_first_sync_progress WHERE session_id=$1', [result.sessionId])).rows[0].n, 1);
      assert.ok((await client.query('SELECT magento_name_override FROM products WHERE id=$1', [p.id])).rows[0].magento_name_override);
      throw Object.assign(Error('Synthetic post-ledger failure'), { code: 'SYNTHETIC_LEDGER_ROLLBACK' });
    });
    const result = await f.invoke(review); assert.notEqual(result.code, 0); assert.equal(reached, true);
    assert.equal(await f.fields(p), null); assert.deepEqual(await snapshot(f.db), before);
  });
  await t.test('lost caller reply after actual COMMIT stops the tail and rejects resume without another write or GET', async () => {
    const selected = [f.products[2], f.products[3]]; for (const p of selected) await f.admit(p);
    const review = await f.review(selected); assert.equal(review.code, 0, JSON.stringify(review.messages)); let commits = 0;
    const result = await f.invoke(review, 'apply', { runNameCommit: async (...args) => {
      commits++; await require('../scripts/first-sync-name-commit').runNameCommit(...args);
      throw Object.assign(Error('Synthetic lost caller reply'), { unconfirmed: true });
    } });
    assert.notEqual(result.code, 0); assert.equal(commits, 1);
    assert.ok(result.journal.some(row => row.type === 'receipt' && row.status === 'unconfirmed'));
    assert.equal((await f.fields(selected[0])).fields.filter(row => row.state === 'name_received').length, 2);
    assert.equal(await f.fields(selected[1]), null);
    const after = await snapshot(f.db), gets = f.calls.length;
    const resumed = await f.invoke(review, 'resume', { output: result.output });
    assert.notEqual(resumed.code, 0); assert.deepEqual(await snapshot(f.db), after); assert.equal(f.calls.length, gets);
  });
  const drifts = [
    ['remote name', p => { f.remotes.get(p.sku).en.name += ' changed'; }],
    ['remote identity', p => { f.remotes.get(p.sku).id += 10000; }],
    ['empty remote name', p => { f.remotes.get(p.sku).name = ''; }],
    ['local source', p => f.write(client => client.query('UPDATE products SET weight=133 WHERE id=$1', [p.id]))],
    ['lifecycle', p => f.write(client => client.query('UPDATE product_full_export_state SET delivery_version=delivery_version+1 WHERE product_id=$1', [p.id]))],
    ['protected work', p => f.write(client => client.query(`INSERT INTO product_media_jobs(id,product_id,public_product_identity_id,version,photo_ids,enable_when_verified,actor_user_id,request_key,required_permission,intent_hash)
      VALUES($1,$2,$3,1,'{}',FALSE,$4,$5,'products.create',$6)`, [randomUUID(), p.id, p.publicIdentityId, f.actor, randomUUID(), c.hash(p)]))],
  ];
  for (const [index, [label, mutate]] of drifts.entries()) await t.test(label + ' drift rejects the exact sealed preview without any new database change', async () => {
    const p = f.products[4 + index]; await f.admit(p); const review = await f.review([p]); assert.equal(review.code, 0, JSON.stringify(review.messages));
    await mutate(p); const before = await snapshot(f.db), result = await f.invoke(review);
    assert.notEqual(result.code, 0); assert.equal(result.journal.some(row => row.type === 'prepared'), false);
    assert.deepEqual(await snapshot(f.db), before); assert.equal(await f.fields(p), null);
  });
});
