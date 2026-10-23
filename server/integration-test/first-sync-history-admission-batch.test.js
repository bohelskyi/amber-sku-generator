'use strict';
require('../test/setup-env');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Client, Pool } = require('pg');
const c = require('../src/services/magento/binding-contract');
const fixture = require('../test/fixtures/magento-bindings');
const { insertProductFixture } = require('./product-fixture');
const preview = require('../src/services/magento/sync-preview');
const first = require('../src/services/magento/first-sync.service');
const admission = require('../src/services/magento/first-sync-cutover-admission');
const EVENT = 'product.magento_first_sync_cutover_reviewed';
const serverRoot = path.resolve(__dirname, '..');
const sha = data => createHash('sha256').update(data).digest('hex');

// Every public table is compared, including immutable history, lifecycle, media,
// first-sync fields, automatic requests and jobs. Only scoped audit additions
// may differ after an admission; old audit rows must remain byte-identical.
async function snapshot(db) {
  const data = {};
  for (const { tablename } of (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    assert.match(tablename, /^[a-z_]+$/);
    data[tablename] = (await db.query(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) rows
      FROM (SELECT to_jsonb(t) j FROM public."${tablename}" t) entries`)).rows[0].rows;
  }
  return data;
}
function onlyAdmissions(before, after, skus) {
  const oldIds = new Set(before.audit_events.map(row => row.id));
  const added = after.audit_events.filter(row => !oldIds.has(row.id));
  assert.equal(added.length, skus.length);
  assert.deepEqual(added.map(row => row.details.admission.identity.sku).sort(), [...skus].sort());
  for (const row of added) {
    assert.equal(row.event_key, EVENT);
    assert.equal(row.subject_type, 'magento_first_sync_cutover_admission');
    assert.equal(row.details.admission.scope, 'first_sync_review_only');
    assert.equal(row.details.admission.doesNotAcknowledgeExport, true);
    assert.equal(row.details.remoteWrites, 0);
    assert.equal(row.details.enqueued, false);
  }
  assert.deepEqual({ ...after, audit_events: after.audit_events.filter(row => oldIds.has(row.id)) }, before);
}

async function setup(t) {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1');
  assert.equal(source.port, '55432');
  assert.ok(source.pathname.endsWith('_test'));
  const name = 'amber_history_batch_' + process.pid + '_test';
  const control = new Client({ connectionString: source.toString() });
  await control.connect();
  let created = false, db;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-history-batch-'));
  t.after(async () => {
    if (db) await db.end();
    if (created) await control.query('DROP DATABASE ' + name);
    await control.end();
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0);
  await require('./harness').createTestDatabase(name); created = true;
  const target = new URL(source); target.pathname = '/' + name;

  db = new Pool({ connectionString: target.toString(), max: 4 });
  t.mock.method(globalThis, 'fetch', () => assert.fail('Live HTTP is forbidden in this disposable fixture'));
  const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','History batch fixture Administrator') RETURNING id")).rows[0].id);
  await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
  for (const code of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) await db.query('INSERT INTO categories(code,name) VALUES($1,$1)', [code]);
  const definition = structuredClone(fixture.definition()), literal = value => ({ op: 'literal', value });
  definition.sources = { sku: definition.sources.sku }; definition.tables = {};
  for (const group of definition.groups) for (const row of group.rows) {
    delete row.cells.kolir; delete row.cells.decor_weight; delete row.cells.dovzhyna_brasletu_diuimiv;
    if (row.id === 'english') row.cells.price = literal('');
  }
  definition.groups.find(group => group.route === 'BR').rows[0].cells.product_websites = literal('fixture');
  const rawSchema = structuredClone(fixture.schema());
  rawSchema.attributes.find(row => row.attribute_code === 'name').scope = 'store';
  rawSchema.storeTopology.websites[0].default_group_id = 802;
  rawSchema.storeTopology.storeGroups[0].default_store_id = 805;
  rawSchema.storeTopology.storeViews.push({ id: 805, code: 'default', name: 'Ukrainian', website_id: 801, store_group_id: 802, is_active: true });
  const schema = c.normalizeSchema(rawSchema);
  const config = { configured: true, baseUrl: 'https://history-batch.invalid', consumerKey: 'fixture-key',
    consumerSecret: 'fixture-secret', accessToken: 'fixture-token', accessTokenSecret: 'fixture-token-secret' };
  const options = { databasePool: db, actorUserId: actor, mutationContext: { actorUserId: actor } };
  const templates = require('../src/services/export-templates/template.service');
  const family = await templates.createTemplate({ key: 'history-batch-' + randomUUID(), displayName: 'History admission batch', definition }, options);
  const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
  const bindings = require('../src/services/magento/binding.service'), approved = fixture.approvedBindings(definition, schema, 'BR');
  const nativeTargets = { attribute_set_code: 'product.attribute_set_id', product_type: 'product.type_id', product_websites: 'product.extension_attributes.website_ids' };
  for (const attribute of approved.attributes) if (nativeTargets[attribute.target]) attribute.transportTarget = nativeTargets[attribute.target];
  for (const policy of approved.policies) policy.policy = 'authoritative_create_update';
  async function publish(expectedCurrentId) {
    let value = await bindings.createDraft({ installationKey: 'history-batch-fixture', origin: config.baseUrl,
      templateVersionId: version.id, observedAt: '2026-10-12T00:00:00Z', schema }, options);
    value = await bindings.updateDraft(value.id, { expectedRevision: value.revision, bindings: approved }, options);
    return bindings.publishDraft(value.id, { expectedRevision: value.revision, expectedCurrentId }, options);
  }
  let binding = await publish(null);
  const products = [], remotes = new Map(), calls = [];
  for (let index = 0; index < 13; index++) {
    const sku = 'BR-HISTORY-BATCH-' + (index + 1);
    const p = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,weight,total_price_uah,details)
      VALUES($1,'BR',5,42,'{"answers":{},"manualPriceUah":42}') RETURNING id,full_sku,public_product_identity_id`, [sku])).rows[0];
    products.push({ sku, productId: p.id, remoteProductId: 31000 + p.id, publicIdentityId: p.public_product_identity_id });
    remotes.set(sku, { id: 31000 + p.id, sku, attribute_set_id: 8001, type_id: 'simple', name: 'Fixture name', price: 42,
      status: 1, visibility: 4, custom_attributes: [], extension_attributes: { website_ids: [801], category_links: [] } });
  }
  await db.query('INSERT INTO product_export_revisions(product_id,has_product_snapshot) SELECT unnest($1::int[]),TRUE', [products.map(p => p.productId)]);
  await db.query(`UPDATE product_full_export_state SET evidence='{"origin":"migration_039","coverage":"unresolved_historical"}',
    business_exclusion_state='none',delivery_version=delivery_version+1`);
  await db.query('UPDATE export_state SET exported_to_product_id=$1', [products.at(-1).productId]);
  const cutover = require('../src/services/full-product-cutover.service');
  const maintenance = { ...options, expectedDatabase: name, deploymentEvidence: 'Disposable synthetic fixture; no old writer' };
  await cutover.prepare(maintenance);
  const index = await cutover.generate('index', maintenance);
  await cutover.indexHistorical(index, index.contentSha256, maintenance);
  const manifest = await cutover.generate('cutover', maintenance);
  assert.ok(manifest.entries.every(row => row.action === 'legacy_baseline'));
  await cutover.approve(manifest, manifest.contentSha256, 'Explicit synthetic fixture baseline', maintenance);
  await cutover.applyBatch(manifest.contentSha256, 0, maintenance);
  await cutover.activate(manifest.contentSha256, maintenance);
  const fetchImpl = async (url, init) => {
    assert.equal(init.method, 'GET');
    const u = new URL(url); calls.push({ path: u.pathname, sku: u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]') });
    if (u.pathname.endsWith('/V1/products')) {
      const remote = remotes.get(calls.at(-1).sku); assert.ok(remote);
      return new Response(JSON.stringify({ items: [remote], total_count: 1 }), { headers: { 'content-type': 'application/json' } });
    }
    assert.ok(u.pathname.endsWith('/store/storeConfigs'), u.pathname);
    return new Response(JSON.stringify([
      { id: 805, code: 'default', website_id: 801, locale: 'uk_UA', base_currency_code: 'UAH' },
      { id: 804, code: 'en', website_id: 801, locale: 'en_US', base_currency_code: 'UAH' },
    ]), { headers: { 'content-type': 'application/json' } });
  };
  const canonicalPreview = (config, input) => preview.previewProduct(config, { ...input,
    discover: async () => binding.schema, categoryObservation: { trees: [], categoryFailures: [] } });
  return { db, name, actor, binding, definitionHash: family.draft.definitionHash, config, options, products, remotes, calls,
    fetchImpl, canonicalPreview, dir, publishNext: async () => { binding = await publish(binding.id); return binding; } };
}

test('standalone history batch uses exact canonical admissions, changes audits only and stops safely', async t => {
  const f = await setup(t);
  const runner = require('../scripts/first-sync-history-batch');
  const runtime = runner.createRuntime(serverRoot);
  runtime.preview = f.canonicalPreview;
  // Services remain real. The only remote integration seam is synthetic GET
  // transport plus the frozen schema/category response supplied to preview.
  assert.equal(runtime.first.review, first.review);
  assert.equal(runtime.admission.apply, admission.apply);
  let attempt = 0;
  async function invoke(products, mode, overrides = {}) {
    const tag = String(++attempt), input = path.join(f.dir, tag + '-scope.json'), output = path.join(f.dir, tag + '-journal.jsonl');
    const scope = { bindingRevisionId: f.binding.id, expectedDefinitionHash: f.definitionHash, installationKey: f.binding.installationKey,
      items: products.map(({ sku, productId, remoteProductId }) => ({ sku, productId, remoteProductId })) };
    const bytes = Buffer.from(JSON.stringify(scope) + '\n'); await fs.writeFile(input, bytes);
    const messages = [];
    const code = await runner.main(['--server-root', serverRoot, '--mode', mode, '--input', input, '--output', output,
      '--expected-database', f.name, '--actor-id', String(f.actor), '--scope-sha256', sha(bytes)],
    { runtime, pool: f.db, config: f.config, fetchImpl: f.fetchImpl, env: {},
      print: message => messages.push(JSON.parse(message)), printError: message => messages.push(JSON.parse(message)), ...overrides });
    const journal = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(journal.length, JSON.stringify(messages));
    return { code, journal, messages };
  }
  async function protect(product) {
    const id = randomUUID();
    await f.db.query(`INSERT INTO product_media_jobs(id,product_id,public_product_identity_id,version,photo_ids,enable_when_verified,
      actor_user_id,request_key,required_permission,intent_hash) VALUES($1,$2,$3,1,'{}',FALSE,$4,$5,'products.create',$6)`,
    [id, product.productId, product.publicIdentityId, f.actor, randomUUID(), c.hash(id)]);
  }
  const requestOptions = { ...f.options, preview: f.canonicalPreview, fetchImpl: f.fetchImpl };
  const selection = product => ({ sku: product.sku, bindingRevisionId: f.binding.id });
  const review = product => first.review(f.config, selection(product), requestOptions);
  const receipts = result => result.journal.filter(row => row.type === 'receipt');
  async function live(product) {
    let observation;
    await f.canonicalPreview(f.config, { ...requestOptions, ...selection(product), onObservation: value => { observation = value; } });
    const client = await f.db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const evidence = await runtime.eligibility.readFirstSyncEligibility(client, f.config, observation);
      await client.query('COMMIT');
      return { evidence, observation };
    } catch (cause) { await client.query('ROLLBACK'); throw cause; }
    finally { client.release(); }
  }
  const sessions = product => f.db.query('SELECT * FROM magento_first_sync_sessions WHERE public_product_identity_id=$1', [product.publicIdentityId]);

  await t.test('preview obtains actual exact Magento identities without changing any table', async () => {
    const before = await snapshot(f.db), result = await invoke(f.products.slice(0, 2), 'preview');
    assert.equal(result.code, 0, JSON.stringify(result.messages));
    assert.deepEqual(await snapshot(f.db), before);
    assert.ok(f.calls.some(row => row.path === '/rest/all/V1/products'));
    assert.ok(f.calls.some(row => row.path === '/rest/en/V1/products'));
  });
  await t.test('apply adds exactly one immutable scoped audit per exact product and no other state', async () => {
    const products = f.products.slice(0, 2), before = await snapshot(f.db), result = await invoke(products, 'apply');
    assert.equal(result.code, 0, JSON.stringify(result.messages));
    onlyAdmissions(before, await snapshot(f.db), products.map(p => p.sku));
  });
  await t.test('rerun freshly recognizes existing admissions with no duplicate audit or field session', async () => {
    const before = await snapshot(f.db), result = await invoke(f.products.slice(0, 2), 'apply');
    assert.equal(result.code, 0, JSON.stringify(result.messages));
    assert.deepEqual(await snapshot(f.db), before);
  });
  await t.test('remote identity drift from an earlier preview blocks without changes', async () => {
    const product = f.products[5];
    const checked = await invoke([product], 'preview'); assert.equal(checked.code, 0, JSON.stringify(checked.messages));
    f.remotes.get(product.sku).id += 1000;
    const before = await snapshot(f.db), result = await invoke([product], 'apply');
    assert.equal(result.code, 2, JSON.stringify(result.messages));
    assert.deepEqual(await snapshot(f.db), before);
  });
  await t.test('protected work added after preview stops later rows and preserves only earlier receipts', async () => {
    const products = f.products.slice(2, 5), checked = await invoke(products, 'preview');
    assert.equal(checked.code, 0, JSON.stringify(checked.messages));
    await protect(products[1]);
    const before = await snapshot(f.db), reads = f.calls.length, result = await invoke(products, 'apply');
    assert.equal(result.code, 2, JSON.stringify(result.messages));
    onlyAdmissions(before, await snapshot(f.db), [products[0].sku]);
    assert.ok(!f.calls.slice(reads).some(row => row.sku === products[2].sku));
  });
  await t.test('a previously admitted row with new protected work blocks rerun before later products', async () => {
    await protect(f.products[0]);
    const before = await snapshot(f.db), reads = f.calls.length, result = await invoke(f.products.slice(0, 2), 'apply');
    assert.equal(result.code, 2, JSON.stringify(result.messages));
    assert.deepEqual(await snapshot(f.db), before);
    assert.ok(!f.calls.slice(reads).some(row => row.sku === f.products[1].sku));
  });
  await t.test('identity changing between canonical review and canonical apply cannot gain an audit', async () => {
    const product = f.products[6], before = await snapshot(f.db);
    let reads = 0;
    const changingRuntime = { ...runtime, preview: async (config, input) => {
      if (++reads === 2) f.remotes.get(product.sku).id += 1000;
      return f.canonicalPreview(config, input);
    } };
    const result = await invoke([product], 'apply', { runtime: changingRuntime });
    assert.equal(result.code, 2, JSON.stringify(result.messages));
    assert.ok(reads >= 2);
    assert.deepEqual(await snapshot(f.db), before);
  });
  await t.test('admission without a field session requires a fresh current-publication admission instead of skipping old audit', async () => {
    const product = f.products[7], initial = await invoke([product], 'apply');
    assert.equal(initial.code, 0, JSON.stringify(initial.messages));
    const oldRoot = receipts(initial)[0].receipt.auditEventId;
    const oldCommand = initial.journal.find(row => row.type === 'prepared').command;
    assert.equal((await sessions(product)).rowCount, 0);
    const old = await live(product);
    assert.equal(old.evidence.mode, 'first');
    assert.equal(admission.rootId(old.evidence.historyAdmission), oldRoot);
    f.binding = await f.publishNext();
    const before = await snapshot(f.db), plan = await review(product), unadmitted = await live(product);
    assert.equal(plan.mode, 'review');
    assert.equal(plan.historyReviewAssessment.status, 'available');
    assert.equal(plan.historyReviewAssessment.legacySnapshotFlag, true);
    assert.equal(unadmitted.evidence.historyAdmission, null);
    assert.equal(admission.allows(unadmitted.observation, old.evidence.historyAdmission), false);
    await assert.rejects(admission.apply(f.config, oldCommand, requestOptions), { code: 'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED' });
    assert.deepEqual(await snapshot(f.db), before);
    const result = await invoke([product], 'apply');
    assert.equal(result.code, 0, JSON.stringify(result.messages));
    assert.equal(receipts(result)[0].status, 'recorded');
    const newRoot = receipts(result)[0].receipt.auditEventId;
    assert.notEqual(newRoot, oldRoot);
    onlyAdmissions(before, await snapshot(f.db), [product.sku]);
    const audits = (await f.db.query('SELECT details FROM audit_events WHERE id=ANY($1::bigint[]) ORDER BY id', [[oldRoot, newRoot]])).rows;
    assert.ok(audits.every(row => row.details.admission.rootAdmissionEventId === null));
    assert.equal((await sessions(product)).rowCount, 0);
    const current = await live(product);
    assert.equal(admission.rootId(current.evidence.historyAdmission), newRoot);
    assert.equal(admission.allows(current.observation, current.evidence.historyAdmission), true);
    const admitted = await snapshot(f.db), repeat = await invoke([product], 'apply');
    assert.equal(repeat.code, 0);
    assert.equal(receipts(repeat)[0].status, 'already_admitted');
    assert.equal(receipts(repeat)[0].existing.rootAuditEventId, newRoot);
    assert.deepEqual(await snapshot(f.db), admitted);
  });
  await t.test('renewal with incomplete field progress preserves its original root and every existing field receipt', async () => {
    const product = f.products[7], boundary = require('../src/services/magento/sync-job.service').recoveryBoundary;
    f.remotes.get(product.sku).price = 43;
    await boundary.guard(f.config, selection(product), requestOptions, async state => {
      const { observation } = await boundary.observe(f.config, selection(product), requestOptions);
      const inspection = await first.inspect(f.config, observation, requestOptions);
      assert.equal(inspection.mode, 'first');
      assert.equal(inspection.complete, false);
      await first.commit(f.config, inspection, state, requestOptions);
    });
    const previous = await live(product), root = previous.evidence.progress.historyAdmissionEventId;
    assert.ok(root);
    assert.equal(previous.evidence.progress.session.completed_at, null);
    f.binding = await f.publishNext();
    const before = await snapshot(f.db), plan = await review(product);
    assert.equal(plan.mode, 'review');
    assert.equal(plan.historyReviewAssessment.status, 'available');
    const result = await invoke([product], 'apply');
    assert.equal(result.code, 0, JSON.stringify(result.messages));
    onlyAdmissions(before, await snapshot(f.db), [product.sku]);
    const current = await live(product);
    assert.equal(current.evidence.mode, 'first');
    assert.equal(current.evidence.progress.historyAdmissionEventId, root);
    assert.equal(admission.rootId(current.evidence.historyAdmission), root);
    assert.deepEqual(current.evidence.progress.fields, previous.evidence.progress.fields);
    const event = (await f.db.query('SELECT details FROM audit_events WHERE id=$1', [receipts(result)[0].receipt.auditEventId])).rows[0];
    assert.equal(event.details.admission.rootAdmissionEventId, root);
  });
  await t.test('exact-token receipt recovery proves past commit but new protected work stops a fresh runner and its tail', async () => {
    const product = f.products[8], initial = await invoke([product], 'apply');
    assert.equal(initial.code, 0, JSON.stringify(initial.messages));
    const command = initial.journal.find(row => row.type === 'prepared').command;
    await protect(product);
    const before = await snapshot(f.db), current = await review(product);
    assert.equal(current.mode, 'review');
    assert.ok(current.blockers.some(row => row.code === 'FIRST_SYNC_UNFINISHED_WORK'));
    const recovered = await admission.apply(f.config, command, requestOptions);
    assert.equal(recovered.receipt.alreadyApplied, true);
    assert.equal(recovered.receipt.auditEventId, receipts(initial)[0].receipt.auditEventId);
    assert.deepEqual(await snapshot(f.db), before);
    const reads = f.calls.length, result = await invoke([product, f.products[10]], 'apply');
    assert.equal(result.code, 2);
    assert.equal(receipts(result)[0].status, 'blocked');
    assert.equal(result.journal.at(-1).notChecked, 1);
    assert.ok(!f.calls.slice(reads).some(row => row.sku === f.products[10].sku));
    assert.deepEqual(await snapshot(f.db), before);
  });
  await t.test('ordinary acknowledged delivery is not reported as already admitted by the history runner', async () => {
    const product = f.products[9], job = randomUUID(), hash = c.hash(job);
    await f.db.query(`INSERT INTO magento_sync_jobs(id,product_id,public_product_identity_id,sku,installation_key,
      origin_hash,binding_revision_id,binding_hash,amber_hash,plan_hash,intent,baseline,state,remote_product_id,acknowledged_at,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,'{}','{}','succeeded',$9,CURRENT_TIMESTAMP,$10)`,
    [job, product.productId, product.publicIdentityId, product.sku, f.binding.installationKey,
      f.binding.originHash, f.binding.id, hash, product.remoteProductId, f.actor]);
    const before = await snapshot(f.db), current = await review(product);
    assert.equal(current.mode, 'ordinary');
    assert.equal(current.complete, true);
    const result = await invoke([product, f.products[10]], 'apply');
    assert.equal(result.code, 2);
    assert.equal(receipts(result)[0].code, 'HISTORY_BATCH_ADMISSION_NOT_AVAILABLE');
    assert.equal(result.journal.at(-1).already_admitted, 0);
    assert.equal(result.journal.at(-1).notChecked, 1);
    assert.deepEqual(await snapshot(f.db), before);
  });
  await t.test('eligible first-sync without a cutover root is not confused with an existing scoped admission', async () => {
    const sku = 'BR-HISTORY-UNHISTORICAL';
    const gate = require('../src/services/full-product-cutover-gate'), client = await f.db.connect();
    let row;
    try {
      await gate.begin(client, 'BEGIN');
      row = (await client.query(`INSERT INTO products(full_sku,category,weight,total_price_uah,details)
        VALUES($1,'BR',5,42,'{"answers":{},"manualPriceUah":42}') RETURNING id,public_product_identity_id`, [sku])).rows[0];
      await require('../src/services/full-product-export.service').initializeNewProduct(client, row.id);
      await gate.commit(client);
    } catch (cause) { await gate.rollback(client); throw cause; }
    finally { await gate.release(client); client.release(); }
    const product = { sku, productId: row.id, publicIdentityId: row.public_product_identity_id, remoteProductId: 31000 + row.id };
    f.remotes.set(sku, { ...f.remotes.get(f.products[10].sku), id: product.remoteProductId, sku });
    const before = await snapshot(f.db), current = await live(product), plan = await review(product);
    assert.equal(current.evidence.mode, 'first');
    assert.equal(current.evidence.historyAdmission, null);
    assert.equal(plan.mode, 'first');
    const result = await invoke([product, f.products[10]], 'apply');
    assert.equal(result.code, 2);
    assert.equal(receipts(result)[0].code, 'HISTORY_BATCH_EXISTING_ADMISSION_UNCONFIRMED');
    assert.equal(result.journal.at(-1).notChecked, 1);
    assert.deepEqual(await snapshot(f.db), before);
  });
  await t.test('campaign resume validates real recorded and already-admitted audits and freshly reviews only untouched identities', async () => {
    const campaign = require('../scripts/first-sync-campaign-history'), products = f.products.slice(10, 13);
    const existing = await invoke([products[1]], 'apply');
    assert.equal(existing.code, 0, JSON.stringify(existing.messages));
    const input = path.join(f.dir, 'campaign-scope.json'), output = path.join(f.dir, 'campaign');
    const scope = { bindingRevisionId: f.binding.id, expectedDefinitionHash: f.definitionHash,
      installationKey: f.binding.installationKey,
      items: products.map(({ sku, productId, remoteProductId }) => ({ sku, productId, remoteProductId })) };
    const bytes = Buffer.from(JSON.stringify(scope) + '\n'); await fs.writeFile(input, bytes);
    async function execute(mode, interrupt = false) {
      const messages = [];
      const code = await campaign.main(['--server-root', serverRoot, '--mode', mode, '--input', input,
        '--scope-sha256', sha(bytes), '--output', output, '--expected-database', f.name, '--actor-id', String(f.actor)],
      { runtime, pool: f.db, config: f.config, fetchImpl: f.fetchImpl, env: {},
        print: text => {
          const message = JSON.parse(text); messages.push(message);
          if (interrupt && message.sku === products[1].sku) process.emit('SIGTERM');
        }, printError: text => messages.push(JSON.parse(text)) });
      const journal = (await fs.readFile(path.join(output, 'journal.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      return { code, messages, journal };
    }
    const before = await snapshot(f.db), initialReads = f.calls.length, stopped = await execute('apply', true);
    assert.equal(stopped.code, 2, JSON.stringify(stopped.messages));
    assert.deepEqual(receipts(stopped).map(row => row.status), ['recorded', 'already_admitted']);
    assert.equal(stopped.journal.at(-1).notChecked, 1);
    onlyAdmissions(before, await snapshot(f.db), [products[0].sku]);
    assert.ok(!f.calls.slice(initialReads).some(row => row.sku === products[2].sku));
    const beforeResume = await snapshot(f.db), resumedReads = f.calls.length, resumed = await execute('resume');
    assert.equal(resumed.code, 0, JSON.stringify(resumed.messages));
    assert.equal(resumed.journal.at(-1).historicalSkipped, 2);
    assert.equal(resumed.journal.at(-1).complete, true);
    assert.equal(resumed.journal.at(-1).resumeSkipsAreHistoricalOnly, true);
    assert.equal(receipts(resumed).length, 3);
    onlyAdmissions(beforeResume, await snapshot(f.db), [products[2].sku]);
    assert.ok(f.calls.slice(resumedReads).some(row => row.sku === products[2].sku));
    assert.ok(!f.calls.slice(resumedReads).some(row => [products[0].sku, products[1].sku].includes(row.sku)));
    const complete = await snapshot(f.db), lastReads = f.calls.length, repeated = await execute('resume');
    assert.equal(repeated.code, 0, JSON.stringify(repeated.messages));
    assert.equal(repeated.journal.at(-1).historicalSkipped, 3);
    assert.equal(f.calls.length, lastReads);
    assert.deepEqual(await snapshot(f.db), complete);
    for (const product of products) assert.equal((await sessions(product)).rowCount, 0);
  });
});
