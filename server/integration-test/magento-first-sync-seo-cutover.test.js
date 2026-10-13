require('../test/setup-env');
// Actual cutover/admission/progress/job transactions; entirely synthetic Magento.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const fixture = require('../test/fixtures/magento-bindings');
const { insertProductFixture } = require('./product-fixture');
const c = require('../src/services/magento/binding-contract');
const service = require('../src/services/magento/first-sync.service');
const admission = require('../src/services/magento/first-sync-cutover-admission');
const ledger = require('../src/services/magento/first-sync-ledger');
const jobs = require('../src/services/magento/sync-job.service');
const seo = require('../src/services/magento/first-sync-seo-proof');
const gate = require('../src/services/full-product-cutover-gate');
const repair = require('../src/services/export-exposure/repair-loader');

test('native NM SEO completion preserves the real cutover admission root and captured lifecycle state', async t => {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432');
  assert.ok(source.pathname.endsWith('_test'));
  const name = 'amber_first_sync_seo_cutover_' + process.pid + '_test';
  const control = new Client({ connectionString: source.toString() });
  await control.connect(); let created = false, db;
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0);
    await control.query('CREATE DATABASE ' + name); created = true;
    const target = new URL(source); target.pathname = '/' + name;
    await promisify(execFile)(process.execPath, ['-e', "require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});"],
      { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: target.toString() } });
    db = new Pool({ connectionString: target.toString(), max: 5 });
    t.mock.method(globalThis, 'fetch', () => assert.fail('No live Magento or NBU transport'));
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Synthetic NM cutover Administrator') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    for (const code of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) await db.query('INSERT INTO categories(code,name) VALUES($1,$1)', [code]);
    const config = { configured: true, baseUrl: 'https://nm-cutover.invalid', consumerKey: 'fixture-key',
      consumerSecret: 'fixture-secret', accessToken: 'fixture-token', accessTokenSecret: 'fixture-token-secret' };
    const options = { databasePool: db, actorUserId: actor, mutationContext: { actorUserId: actor } };
    const literal = value => ({ op: 'literal', value });
    const text = id => ({ op: 'text', input: { op: 'source', id }, trim: false, format: 'scalar-v1', onAbsent: 'empty' });
    const definition = structuredClone(fixture.definition());
    definition.sources = { sku: definition.sources.sku, weight: definition.sources.weight,
      price: { kind: 'product', field: 'total_price_uah', type: 'scalar' } }; definition.tables = {};
    for (const group of definition.groups) for (const row of group.rows) {
      delete row.cells.kolir; delete row.cells.decor_weight; delete row.cells.dovzhyna_brasletu_diuimiv;
      row.cells.price = row.id === 'base' ? text('price') : literal('');
    }
    const targets = ['meta_title', 'meta_description'], nm = definition.groups.find(group => group.route === 'NM');
    nm.rows[0].cells.decor_weight = text('weight'); nm.rows[0].cells.product_websites = literal('fixture');
    for (const row of nm.rows) for (const target of targets) row.cells[target] = literal('Active NM template ' + row.id + ' ' + target);
    const rawSchema = structuredClone(fixture.schema());
    rawSchema.attributes.find(attribute => attribute.attribute_code === 'name').scope = 'store';
    Object.assign(rawSchema.attributes.find(attribute => attribute.attribute_code === 'decor_weight'), { frontend_input: 'text', options: [] });
    for (const [index, target] of targets.entries()) {
      rawSchema.attributes.push({ attribute_code: target, attribute_id: 970 + index, frontend_input: index ? 'textarea' : 'text', scope: 'store', options: [] });
      rawSchema.attributeSets[0].attributeCodes.push(target);
    }
    rawSchema.storeTopology.websites[0].default_group_id = 802;
    rawSchema.storeTopology.storeGroups[0].default_store_id = 805;
    rawSchema.storeTopology.storeViews.push({ id: 805, code: 'default', name: 'Ukrainian', website_id: 801, store_group_id: 802, is_active: true });
    const schema = c.normalizeSchema(rawSchema), templates = require('../src/services/export-templates/template.service');
    const family = await templates.createTemplate({ key: 'nm-cutover-' + randomUUID(), displayName: 'Synthetic NM SEO cutover', definition }, options);
    const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    const approved = fixture.approvedBindings(definition, schema, 'NM');
    const transports = { attribute_set_code: 'product.attribute_set_id', product_type: 'product.type_id', product_websites: 'product.extension_attributes.website_ids' };
    for (const attribute of approved.attributes) if (transports[attribute.target]) attribute.transportTarget = transports[attribute.target];
    for (const policy of approved.policies) {
      const attribute = approved.attributes.find(attribute => require('../src/services/magento/binding-validation').bindingKey(attribute.routeKey, attribute.rowId, attribute.target) === policy.bindingKey);
      policy.policy = attribute?.rowId === 'english' && ['sku', 'product_type', 'attribute_set_code', 'store_view_code'].includes(attribute.target)
        ? 'magento_managed' : 'authoritative_create_update';
    }
    const bindings = require('../src/services/magento/binding.service');
    let binding = await bindings.createDraft({ installationKey: 'nm-cutover-fixture', origin: config.baseUrl,
      templateVersionId: version.id, observedAt: '2026-10-12T00:00:00Z', schema }, options);
    binding = await bindings.updateDraft(binding.id, { expectedRevision: binding.revision, bindings: approved }, options);
    binding = await bindings.publishDraft(binding.id, { expectedRevision: binding.revision, expectedCurrentId: null }, options);
    const product = (await insertProductFixture(db, "INSERT INTO products(full_sku,category,weight,total_price_uah,details) VALUES('NM99001900','NM',24.375,1250,$1::jsonb) RETURNING *",
      [JSON.stringify({ answers: {}, manualPriceUah: 1250 })])).rows[0];
    await db.query("UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',business_exclusion_state='none',delivery_version=delivery_version+1,evidence='{\"origin\":\"migration_039\",\"coverage\":\"unresolved_historical\"}' WHERE product_id=$1", [product.id]);
    await db.query('INSERT INTO product_export_revisions(product_id,has_product_snapshot) VALUES($1,TRUE)', [product.id]);
    await db.query('UPDATE export_state SET exported_to_product_id=$1', [product.id]);
    const cutover = require('../src/services/full-product-cutover.service');
    const maintenance = { ...options, expectedDatabase: name, deploymentEvidence: 'Disposable NM fixture with no legacy CSV writer' };
    await cutover.prepare(maintenance);
    const index = await cutover.generate('index', maintenance); assert.deepEqual(index.indexing.diagnostics, []);
    await cutover.indexHistorical(index, index.contentSha256, maintenance);
    const manifest = await cutover.generate('cutover', maintenance);
    assert.equal(manifest.entries.length, 1); assert.equal(manifest.entries[0].action, 'legacy_baseline');
    await cutover.approve(manifest, manifest.contentSha256, 'Explicit synthetic legacy baseline acceptance', maintenance);
    await cutover.applyBatch(manifest.contentSha256, 0, maintenance); await cutover.activate(manifest.contentSha256, maintenance);
    async function write(operation) {
      const client = await db.connect();
      try { await gate.begin(client, 'BEGIN'); const result = await operation(client); await gate.commit(client); return result; }
      catch (cause) { await gate.rollback(client); throw cause; } finally { await gate.release(client); client.release(); }
    }
    const activationEvent = (await db.query("INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id) VALUES('magento_delivery.cutover',$1,'{\"displayName\":\"Fixture\",\"preferredUsername\":null}','fixture','csv-disabled',$2) RETURNING id", [actor, randomUUID()])).rows[0].id;
    await write(async client => {
      await client.query("SET LOCAL amber.magento_delivery_cutover='on'");
      await client.query('UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton', [binding.installationKey, actor, activationEvent]);
    });
    const originalProduct = (await db.query('SELECT * FROM products WHERE id=$1', [product.id])).rows[0];
    const remoteSeo = { all: Object.fromEntries(targets.map(target => [target, 'Existing Magento UA ' + target])),
      en: Object.fromEntries(targets.map(target => [target, 'Existing Magento EN ' + target])) };
    let remote = { id: 99019, sku: product.full_sku, attribute_set_id: 8001, type_id: 'simple', name: 'Fixture name', price: 1250, status: 1, visibility: 4,
      custom_attributes: [{ attribute_code: 'decor_weight', value: '25' }, ...targets.map(target => ({ attribute_code: target, value: remoteSeo.all[target] }))],
      extension_attributes: { website_ids: [801], category_links: [] } };
    const traffic = []; let allowWrites = false;
    const runtimeOptions = { ...options, observeRate: async () => ({ rateInfo: { rate: 40, rateDate: '2026-10-12', source: 'fixture', stale: false } }),
      fetchImpl: async (url, init = {}) => {
        const u = new URL(url), method = init.method || 'GET', route = u.pathname.split('/V1/')[1];
        assert.equal(u.hostname, 'nm-cutover.invalid'); traffic.push({ method, route });
        const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
        if (method === 'GET') {
          if (route === 'products') return response({ items: [{ ...remote, custom_attributes: remote.custom_attributes.map(attribute => u.pathname.includes('/rest/en/') && targets.includes(attribute.attribute_code)
            ? { ...attribute, value: remoteSeo.en[attribute.attribute_code] } : attribute) }], total_count: 1 });
          if (route === 'categories') return response({ id: 803, parent_id: 1, name: 'Fixture root', children_data: [] });
          if (route === 'store/storeConfigs') return response([{ id: 805, code: 'default', website_id: 801, locale: 'uk_UA', base_currency_code: 'UAH' },
            { id: 804, code: 'en', website_id: 801, locale: 'en_US', base_currency_code: 'UAH' }]);
          assert.fail('Unexpected synthetic GET ' + route);
        }
        assert.equal(allowWrites, true, 'history and field adoption/enqueue must not dispatch');
        assert.equal(method, 'POST'); assert.equal(route, 'products');
        const payload = JSON.parse(init.body).product; assert.equal(payload.sku, product.full_sku);
        assert.ok((payload.custom_attributes || []).every(attribute => !targets.includes(attribute.attribute_code)), 'first job never writes accepted SEO');
        const attributes = new Map(remote.custom_attributes.map(attribute => [attribute.attribute_code, attribute]));
        for (const attribute of payload.custom_attributes || []) attributes.set(attribute.attribute_code, attribute);
        remote = { ...remote, ...payload, custom_attributes: [...attributes.values()] }; return response(true);
      }, preview: async (cfg, input) => require('../src/services/magento/sync-preview').previewProduct(cfg, { ...input, discover: async () => schema }) };
    const selection = { sku: product.full_sku, bindingRevisionId: binding.id };
    const key = { originHash: binding.originHash, publicIdentityId: String(product.public_product_identity_id) };
    const current = () => ledger.readOnClient(db, key);
    const admissionCount = async () => Number((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.magento_first_sync_cutover_reviewed'")).rows[0].n);
    const snapshot = async () => c.hash((await db.query(`SELECT
      (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,
      (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) lifecycle,
      (SELECT jsonb_agg(a ORDER BY id) FROM audit_events a) audits,
      (SELECT jsonb_agg(s ORDER BY id) FROM magento_first_sync_sessions s) sessions,
      (SELECT jsonb_agg(p ORDER BY session_id,revision) FROM magento_first_sync_progress p) progress,
      (SELECT jsonb_agg(f ORDER BY session_id,revision,target,scope) FROM magento_first_sync_fields f) fields,
      (SELECT jsonb_agg(r ORDER BY product_id) FROM magento_product_sync_requests r) requests,
      (SELECT jsonb_agg(j ORDER BY id) FROM magento_sync_jobs j) jobs,
      (SELECT jsonb_agg(s ORDER BY job_id,ordinal) FROM magento_sync_steps s) steps`)).rows[0]);
    const before = await snapshot(), proposal = await service.review(config, selection, runtimeOptions);
    assert.equal(proposal.mode, 'review'); assert.equal(proposal.historyReview.legacySnapshotFlag, true); assert.equal(await snapshot(), before);
    const admissionCommand = { ...selection, previewToken: proposal.historyReview.previewToken };
    const approvedHistory = await admission.apply(config, admissionCommand, runtimeOptions);
    const admissionRoot = String(approvedHistory.receipt.auditEventId);
    assert.match(admissionRoot, /^[1-9][0-9]*$/); assert.equal(await admissionCount(), 1);
    assert.equal((await admission.apply(config, admissionCommand, runtimeOptions)).receipt.alreadyApplied, true);
    const reviewed = await service.review(config, selection, runtimeOptions);
    assert.equal(reviewed.mode, 'first'); assert.equal(reviewed.fields.filter(field => targets.includes(field.target) && field.status === 'conflict').length, 4);
    const weight = reviewed.fields.find(field => field.target === 'decor_weight'); assert.equal(weight.status, 'conflict'); assert.equal(weight.canKeepLocal, true);
    const choice = { ...selection, previewToken: reviewed.previewToken, choices: [
      {target:'decor_weight',scope:'all',choice:'keep_local'},
      ...reviewed.fields.filter(field=>targets.includes(field.target)&&field.canAcceptRemote)
        .map(({target,scope})=>({target,scope,choice:'accept_remote'}))] };
    // Prepare through the real guarded observation/inspection/decision path, then
    // instrument only commit. Preview captures must not hide a duplicate final read.
    const choices = service.decisions(choice);
    const withPreparedCommit = operation => jobs.recoveryBoundary.guard(config, selection, runtimeOptions, async state => {
      const { observation } = await jobs.recoveryBoundary.observe(config, selection, runtimeOptions);
      const base = await service.inspect(config, observation, runtimeOptions);
      assert.equal(base.mode, 'first'); assert.equal(base.previewToken, choice.previewToken);
      const { prepared } = await service.prepareDecision(config, base, choices, runtimeOptions);
      const inspection = { ...base, prepared, previewToken: c.hash({ previewToken: choice.previewToken, choices }) };
      return operation(() => service.commit(config, inspection, state, { ...runtimeOptions, firstSyncDecision: choices }));
    });
    await t.test('one fresh commit capture still rolls back actual ledger, audit and field writes on failure', async subtest => {
      const beforeCommit = await snapshot(), read = repair.readRepairInput, record = ledger.recordProgressOnClient;
      const failure = new Error('Synthetic failure after real ledger persistence'); let captures = 0, recorded = false;
      await withPreparedCommit(async commit => {
        subtest.mock.method(repair, 'readRepairInput', async client => { captures++; return read(client); });
        subtest.mock.method(ledger, 'recordProgressOnClient', async (client, input) => {
          const result = await record(client, input); recorded = true;
          const persisted = (await client.query(`SELECT
            (SELECT count(*)::int FROM magento_first_sync_progress WHERE session_id=$1) progress,
            (SELECT count(*)::int FROM magento_first_sync_fields WHERE session_id=$1) fields,
            (SELECT count(*)::int FROM audit_events WHERE event_key='magento.first_sync_progress_recorded' AND subject_id=$1::text) audits`,
          [result.sessionId])).rows[0];
          assert.equal(persisted.progress, 1); assert.ok(persisted.fields > 0); assert.equal(persisted.audits, 1);
          throw failure;
        });
        await assert.rejects(commit(), error => error === failure);
      });
      assert.equal(recorded, true); assert.equal(captures, 1);
      assert.equal(await snapshot(), beforeCommit); assert.equal(await current(), null);
      assert.ok(traffic.every(call => call.method === 'GET'));
    });
    await t.test('commit rejects a changed latest receipt read after its fresh retained capture and rolls it back', async subtest => {
      const beforeCommit = await snapshot(), read = repair.readRepairInput; let captures = 0, inserted = false;
      await withPreparedCommit(async commit => {
        subtest.mock.method(repair, 'readRepairInput', async client => {
          const input = await read(client); captures++;
          assert.equal(captures, 1);
          const details = structuredClone((await client.query('SELECT details FROM audit_events WHERE id=$1', [admissionRoot])).rows[0].details);
          // Even identical details cannot replace the reviewed root audit ID.
          // This new receipt is transaction-local; the other
          // cutover suite covers independent-connection receipt races.
          const receipt = await require('../src/audit/audit-events').writeAuditEvent(client, {
            mutationContext: { actorUserId: actor }, eventKey: 'product.magento_first_sync_cutover_reviewed',
            subjectType: 'magento_first_sync_cutover_admission', subjectId: c.hash('synthetic NM changed commit receipt'), details });
          assert.notEqual(String(receipt.id), admissionRoot);
          inserted = true; return input;
        });
        await assert.rejects(commit(), { code: 'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED' });
      });
      assert.equal(inserted, true); assert.equal(captures, 1);
      assert.equal(await snapshot(), beforeCommit); assert.equal(await current(), null);
      assert.equal(await admissionCount(), 1); assert.ok(traffic.every(call => call.method === 'GET'));
    });
    await t.test('successful canonical progress commit uses one fresh retained capture and preserves the admission root', async subtest => {
      const read = repair.readRepairInput; let captures = 0;
      const kept = await withPreparedCommit(async commit => {
        subtest.mock.method(repair, 'readRepairInput', async client => { captures++; return read(client); });
        return commit();
      });
      assert.equal(captures, 1, 'one locked eligibility read supplies the final commit evidence check');
      assert.equal(kept.complete, false); assert.equal(kept.readyForOutbound, true);
      assert.equal((await current()).historyAdmissionEventId, admissionRoot);
    });
    assert.equal((await service.apply(config, choice, runtimeOptions)).receipt.alreadyApplied, true);
    const pending = await current(); assert.equal(pending.historyAdmissionEventId, admissionRoot); assert.equal(pending.session.completed_at, null);
    assert.equal(pending.fields.filter(field => field.state === seo.PENDING).length, 4);
    assert.equal(traffic.some(call => call.method !== 'GET'), false);
    const queued = await jobs.enqueue(config, selection, runtimeOptions); assert.ok(queued.baseline.firstSyncSeo);
    assert.equal((await jobs.enqueue(config, selection, runtimeOptions)).id, queued.id); assert.equal(await admissionCount(), 1);
    allowWrites = true; const done = await jobs.applyJob(config, queued.id, { ...runtimeOptions, apply: true });
    assert.equal(done.state, 'succeeded', JSON.stringify(done.failure)); assert.ok(done.acknowledged_at);
    const final = await current(); assert.equal(final.historyAdmissionEventId, admissionRoot); assert.ok(final.session.completed_at);
    assert.equal(final.fields.filter(field => field.state === seo.RECEIVED).length, 4);
    const state = await admission.captureState(db, product.id);
    assert.deepEqual(final.admissionProgress.result.historyAdmissionState, state);
    assert.equal(final.admissionProgress.command.historyAdmissionEventId, admissionRoot);
    assert.equal(final.admissionProgress.command.complete, true); assert.equal(final.admissionProgress.result.completed, true);
    const progress = (await db.query('SELECT command,result FROM magento_first_sync_progress WHERE session_id=$1 ORDER BY revision', [final.session.id])).rows;
    assert.ok(progress.every(row => row.command.historyAdmissionEventId === admissionRoot && row.result.historyAdmissionState));
    assert.equal(await admissionCount(), 1, 'native acknowledgement never re-admits legacy history');
    const terminalCount = (await db.query("SELECT count(*)::int n FROM magento_first_sync_fields WHERE session_id=$1 AND state='seo_received'", [final.session.id])).rows[0].n;
    const writes = traffic.filter(call => call.method === 'POST').length; assert.ok(writes > 0);
    await jobs.applyJob(config, queued.id, { ...runtimeOptions, apply: true });
    assert.equal(traffic.filter(call => call.method === 'POST').length, writes);
    assert.equal((await db.query("SELECT count(*)::int n FROM magento_first_sync_fields WHERE session_id=$1 AND state='seo_received'", [final.session.id])).rows[0].n, terminalCount);
    assert.deepEqual(await current(), final); assert.equal((await service.review(config, selection, runtimeOptions)).mode, 'ordinary');
    assert.deepEqual((await db.query('SELECT * FROM products WHERE id=$1', [product.id])).rows[0], originalProduct);
    for (const target of targets) assert.equal(remote.custom_attributes.find(attribute => attribute.attribute_code === target).value, remoteSeo.all[target]);
    assert.equal(remote.custom_attributes.find(attribute => attribute.attribute_code === 'decor_weight').value, '24.375');
    assert.equal((await db.query('SELECT definition_hash FROM export_template_versions WHERE id=$1', [version.id])).rows[0].definition_hash, version.definitionHash);
  } finally {
    if (db) await db.end(); if (created) await control.query('DROP DATABASE ' + name); await control.end();
  }
});
