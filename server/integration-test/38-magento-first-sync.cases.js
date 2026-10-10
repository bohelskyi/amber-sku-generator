// Registered by magento-first-sync.test.js; owns a unique disposable database.
// Magento transport is synthetic and permits GET requests only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { Client, Pool } = require('pg');
const exec = promisify(execFile);

test('first-sync coordinator preserves real names, partial progress and transaction boundaries', async t => {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = 'amber_first_sync_coordinator_' + process.pid + '_test';
  const control = new Client({ connectionString: source.toString() });
  await control.connect(); let created = false, db;
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0);
    await control.query('CREATE DATABASE ' + name); created = true;
    const target = new URL(source); target.pathname = '/' + name;
    await exec(process.execPath, ['-e', "require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});"],
      { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: target.toString() } });
    db = new Pool({ connectionString: target.toString(), max: 10 });
    t.mock.method(globalThis, 'fetch', () => assert.fail('No live HTTP or NBU request is permitted'));
    const service = require('../src/services/magento/first-sync.service');
    const previews = require('../src/services/magento/sync-preview-db');
    const transaction = require('../src/services/magento/sync-job-transaction');
    const gate = require('../src/services/full-product-cutover-gate');
    const bindings = require('../src/services/magento/binding.service');
    const templates = require('../src/services/export-templates/template.service');
    const fixture = require('../test/fixtures/magento-bindings');
    const c = require('../src/services/magento/binding-contract');
    const { insertProductFixture } = require('./product-fixture');
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','First coordinator administrator') RETURNING id")).rows[0].id);
    const backup = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Backup administrator') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT user_id,id FROM roles CROSS JOIN unnest($1::bigint[]) user_id WHERE role_key='administrator'", [[actor, backup]]);
    const config = { configured: true, baseUrl: 'https://first-coordinator.invalid',
      consumerKey: 'fixture-key', consumerSecret: 'fixture-secret', accessToken: 'fixture-token', accessTokenSecret: 'fixture-token-secret' };
    const calls = [];
    const options = { databasePool: db, actorUserId: actor, mutationContext: { actorUserId: actor },
      observeRate: async () => ({ rateInfo: { rate: 40, rateDate: '2026-10-09', source: 'fixture', stale: false } }),
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), method: init?.method || 'GET' });
        assert.equal(init?.method || 'GET', 'GET');
        assert.ok(new URL(url).pathname.endsWith('/store/storeConfigs'));
        return new Response(JSON.stringify([
          { id: 805, code: 'default', website_id: 801, locale: 'uk_UA', base_currency_code: 'UAH' },
          { id: 804, code: 'en', website_id: 801, locale: 'en_US', base_currency_code: 'UAH' },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      } };
    for (const code of ['BR','NM','KL','CH','AR','SV']) await db.query('INSERT INTO categories(code,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [code]);
    await db.query("INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required) VALUES('BR','braclet_size','Size','text',0,0)");
    await db.query("INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required) VALUES('SV','weight','Weight','text',0,0)");
    const definition = structuredClone(fixture.definition()), literal = value => ({ op: 'literal', value });
    const size = { op: 'text', input: { op: 'source', id: 'size' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' };
    definition.sources.size.key = 'braclet_size';
    definition.sources = { sku: definition.sources.sku, size: definition.sources.size,
      svWeight: { kind: 'information', category: 'SV', key: 'weight', type: 'scalar',
        provenance: 'supplied-stored-answers-v1', aliases: [] } }; definition.tables = {};
    for (const group of definition.groups) for (const row of group.rows) {
      delete row.cells.kolir; delete row.cells.decor_weight; delete row.cells.dovzhyna_brasletu_diuimiv;
      if (row.id === 'english') row.cells.price = literal('');
    }
    const br = definition.groups.find(group => group.route === 'BR');
    br.rows[0].cells.dovzhyna_brasletu_diuimiv = size;
    br.rows[0].cells.name = { op: 'join', items: [literal('Generated UA'), size], delimiter: ' ', omitEmpty: true };
    br.rows[1].cells.name = literal('Local EN');
    br.rows[0].cells.product_websites = literal('fixture');
    const sv = definition.groups.find(group => group.route === 'SV');
    sv.rows[0].cells.decor_weight = { op: 'numberText', input: { op: 'source', id: 'svWeight' },
      format: 'js-number-positive-v1', error: { op: 'error', field: 'decor_weight',
        message: literal('Немає додатної ваги для Magento.') } };
    const rawSchema = structuredClone(fixture.schema());
    rawSchema.attributes.find(a => a.attribute_code === 'name').scope = 'store';
    const attribute = rawSchema.attributes.find(a => a.attribute_code === 'dovzhyna_brasletu_diuimiv');
    attribute.frontend_input = 'text'; attribute.options = [];
    const weightAttribute = rawSchema.attributes.find(a => a.attribute_code === 'decor_weight');
    weightAttribute.frontend_input = 'text'; weightAttribute.options = [];
    rawSchema.storeTopology.websites[0].default_group_id = 802;
    rawSchema.storeTopology.storeGroups[0].default_store_id = 805;
    rawSchema.storeTopology.storeViews.push({ id: 805, code: 'default', name: 'Ukrainian', website_id: 801, store_group_id: 802, is_active: true });
    const schema = c.normalizeSchema(rawSchema);
    const family = await templates.createTemplate({ key: 'coordinator-' + randomUUID(), displayName: 'First coordinator', definition }, options);
    const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    const approved = fixture.approvedBindings(definition, schema, 'BR');
    const svApproved = fixture.approvedBindings(definition, schema, 'SV');
    approved.routes = approved.routes.map(route => svApproved.routes.find(candidate => candidate.routeKey === route.routeKey && candidate.enabled) || route);
    for (const key of ['attributes', 'options', 'policies']) approved[key].push(...svApproved[key]);
    for (const policy of approved.policies) policy.policy = 'authoritative_create_update';
    async function publish(expectedCurrentId) {
      let value = await bindings.createDraft({ installationKey: 'first-coordinator-fixture', origin: config.baseUrl,
        templateVersionId: version.id, observedAt: '2026-10-09T00:00:00Z', schema }, options);
      value = await bindings.updateDraft(value.id, { expectedRevision: value.revision, bindings: approved }, options);
      return bindings.publishDraft(value.id, { expectedRevision: value.revision, expectedCurrentId }, options);
    }
    let binding = await publish(null), sequence = 0;
    async function product() {
      const sku = 'BR-FIRST-' + (++sequence);
      const p = (await insertProductFixture(db, "INSERT INTO products(full_sku,category,weight,total_price_uah,details) VALUES($1,'BR',5,42,$2::jsonb) RETURNING id,full_sku,public_product_identity_id",
        [sku, JSON.stringify({ answers: { braclet_size: '17' }, manualPriceUah: 42 })])).rows[0];
      await db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1", [p.id]);
      return p;
    }
    async function write(operation) {
      const client = await db.connect();
      try { await gate.begin(client, 'BEGIN'); const result = await operation(client); await gate.commit(client); return result; }
      catch (cause) { await gate.rollback(client); throw cause; } finally { await gate.release(client); client.release(); }
    }
    async function observation(p, patch = {}) {
      const amber = await previews.readPreviewProduct(db, { productId: p.id, bindingRevisionId: binding.id });
      const raw = { id: patch.id || 1000 + p.id, sku: patch.sku || amber.product.public_sku, attribute_set_id: 8001,
        name: patch.ua ?? 'Remote UA', price: '42.000',
        custom_attributes: [{ attribute_code: 'dovzhyna_brasletu_diuimiv', value: patch.size ?? '18' }] };
      const domainEvidence = patch.unknownEnglish ? { failures: [{ operation: 'storeViews', code: 'STORE_VIEW_READ_UNAVAILABLE' }] }
        : { english: { id: raw.id, sku: raw.sku, fields: { name: patch.en ?? '' } }, failures: [] };
      return { amber, raw, schema, domainEvidence, categoryNodes: [], categoryFailures: [] };
    }
    async function capture(p, opts = options) {
      const client = await db.connect();
      try { await client.query('BEGIN'); const state = await transaction.readState(client, config, { bindingRevisionId: binding.id }, opts, p.full_sku);
        await gate.commit(client); return state;
      } catch (cause) { await gate.rollback(client); throw cause; } finally { await gate.release(client); client.release(); }
    }
    async function reviewed(p, remote = {}, decision = null, opts = options) {
      const observed = await observation(p, remote), state = await capture(p, opts);
      const inspection = await service.inspect(config, observed, opts, { decision });
      assert.equal(inspection.mode, 'first', JSON.stringify(inspection.blockers));
      return { inspection, state, opts };
    }
    const commit = reviewed => service.commit(config, reviewed.inspection, reviewed.state, reviewed.opts);
    const actual = async p => (await db.query('SELECT * FROM products WHERE id=$1', [p.id])).rows[0];
    const session = async p => (await db.query('SELECT * FROM magento_first_sync_sessions WHERE public_product_identity_id=$1', [p.public_product_identity_id])).rows[0];
    const nameState = async p => (await db.query('SELECT * FROM magento_name_sync_states WHERE public_product_identity_id=$1', [p.public_product_identity_id])).rows[0];
    const scope = async (p, target, language = 'all') => (await db.query(`SELECT f.* FROM magento_first_sync_fields f
      JOIN magento_first_sync_sessions s ON s.id=f.session_id WHERE s.public_product_identity_id=$1 AND f.target=$2 AND f.scope=$3
      ORDER BY f.revision DESC LIMIT 1`, [p.public_product_identity_id, target, language])).rows[0];
    const snapshot = async () => c.hash((await db.query(`SELECT
      (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,
      (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) lifecycle,
      (SELECT jsonb_agg(s ORDER BY origin_hash,public_product_identity_id) FROM magento_name_sync_states s) names,
      (SELECT jsonb_agg(s ORDER BY id) FROM magento_first_sync_sessions s) sessions,
      (SELECT jsonb_agg(r ORDER BY session_id,revision) FROM magento_first_sync_progress r) progress,
      (SELECT jsonb_agg(f ORDER BY session_id,revision,target,scope) FROM magento_first_sync_fields f) fields,
      (SELECT jsonb_agg(r ORDER BY public_product_identity_id) FROM magento_product_sync_requests r) requests,
      (SELECT jsonb_agg(j ORDER BY id) FROM magento_sync_jobs j) jobs,
      (SELECT jsonb_agg(s ORDER BY job_id,ordinal) FROM magento_sync_steps s) steps,
      (SELECT jsonb_agg(i ORDER BY id) FROM public_product_identities i) identities,
      (SELECT jsonb_agg(r ORDER BY full_sku) FROM sku_registry r) reservations,
      (SELECT jsonb_agg(r ORDER BY currency_pair) FROM exchange_rate_cache r) rates,
      (SELECT jsonb_agg(a ORDER BY id) FROM audit_events a) audits`)).rows[0]);

    await t.test('fresh public preview ignores saved diagnosis and preserves populated SV weight, names and all durable state', async () => {
      const item = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,weight,total_price_uah,details,magento_name_override)
        VALUES('SV11500004','SV',132.300,42,'{"answers":{"weight":"132,3"},"manualPriceUah":42}',
          '{"generated":{"all":"Fixture name","en":"Fixture name"},"values":{"all":"Existing Amber UA","en":"Existing Amber EN"}}')
        RETURNING id,full_sku,public_product_identity_id`)).rows[0];
      await db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1", [item.id]);
      const request = { sku: item.full_sku, bindingRevisionId: binding.id }, http = [], methods = [];
      // The remote ID is synthetic; the reported 1488 is Amber's local product ID.
      const remote = { id: 91488, sku: item.full_sku, attribute_set_id: 8001, name: 'Existing Magento UA',
        price: 42, custom_attributes: [{ attribute_code: 'decor_weight', value: '140' }] };
      let report;
      const previewOptions = { ...options,
        observeRate: () => require('../src/services/currency.service').observeUsdRate({ databasePool: db,
          fetchLive: async () => ({ rate: 40, rateDate: '2026-10-09', fetchedAt: '2026-10-09T00:00:00Z' }) }),
        preview: async (config, input) => {
          report = await require('../src/services/magento/sync-preview').previewProduct(config,
            { ...input, discover: async () => schema, categoryObservation: { trees: [], categoryFailures: [] } });
          return report;
        },
        fetchImpl: async (url, init) => {
          const target = new URL(url), pathname = target.pathname;
          methods.push(init?.method || 'GET');
          assert.equal(init?.method || 'GET', 'GET', 'Preview must never write to Magento');
          http.push(pathname);
          if (pathname.endsWith('/store/storeConfigs')) return options.fetchImpl(url, init);
          assert.ok(pathname.endsWith('/products'), pathname);
          assert.equal(target.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'), item.full_sku);
          return new Response(JSON.stringify({ total_count: 1,
            items: [{ ...remote, name: pathname.includes('/rest/en/') ? 'Existing Magento EN' : remote.name }] }),
            { status: 200, headers: { 'content-type': 'application/json' } });
        } };
      for (const code of ['PRODUCT_EVALUATION_NOT_READY', 'NAME_READ_UNAVAILABLE']) {
        await db.query(`INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id,state,reason_code,diagnostics)
          VALUES($1,$2,'needs_attention','data_or_binding',$3::jsonb)
          ON CONFLICT(public_product_identity_id) DO UPDATE SET diagnostics=EXCLUDED.diagnostics`,
        [item.public_product_identity_id, item.id, JSON.stringify([{ code, issueFields: ['decor_weight'] }])]);
        const before = await snapshot(), productBefore = await actual(item), start = http.length;
        const preview = await service.review(config, request, previewOptions);
        assert.equal(preview.mode, 'first');
        assert.equal(report.blockers.some(blocker => blocker.code === 'PRODUCT_EVALUATION_NOT_READY' && blocker.issueFields.includes('decor_weight')),false);
        assert.equal(preview.readyForOutbound, false, 'Readable filled grams still require a decision against different remote grams');
        const weight = preview.fields.find(field => field.target === 'decor_weight');
        assert.ok(weight && ['review_required', 'conflict'].includes(weight.status));
        assert.equal(weight.local.known, true); assert.equal(weight.local.present, true);
        assert.equal(weight.local.value, '132.300'); assert.equal(weight.remote.value, '140');
        assert.ok(http.slice(start).some(pathname => pathname.includes('/rest/all/')));
        assert.ok(http.slice(start).some(pathname => pathname.includes('/rest/en/')));
        assert.ok(methods.every(method => method === 'GET'), 'Even a caught transport failure cannot hide a write attempt');
        assert.equal(await snapshot(), before, 'Preview cannot persist names, weight, jobs, requests, ledger, audit, rates or identifiers');
        assert.deepEqual(await actual(item), productBefore);
        assert.equal(productBefore.weight, '132.300'); assert.equal(productBefore.details.answers.weight, '132,3');
        assert.deepEqual(productBefore.magento_name_override.values, { all: 'Existing Amber UA', en: 'Existing Amber EN' });
        assert.equal(await session(item), undefined);
        const repeated = await service.review(config, request, previewOptions);
        assert.equal(repeated.previewToken, preview.previewToken);
        assert.equal(await snapshot(), before, 'Repeated preview remains read-only');
      }
      const beforeHttp = http.length;
      await db.query("UPDATE application_users SET status='disabled',deactivated_at=CURRENT_TIMESTAMP WHERE id=$1", [actor]);
      try {
        const before = await snapshot();
        await assert.rejects(service.review(config, request, previewOptions), { code: 'ADMIN_PERMISSION_REVOKED' });
        assert.equal(await snapshot(), before); assert.equal(http.length, beforeHttp, 'Revoked actor cannot start Magento reads');
      } finally { await db.query("UPDATE application_users SET status='active',deactivated_at=NULL WHERE id=$1", [actor]); }
      binding = await publish(binding.id);
      const beforePublicationReview = await snapshot(), callsBeforePublicationReview = http.length;
      await assert.rejects(service.review(config, request, previewOptions), { code: 'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED' });
      assert.equal(http.length, callsBeforePublicationReview, 'An old binding cannot start Magento reads');
      const current = await service.review(config, { ...request, bindingRevisionId: binding.id }, previewOptions);
      assert.equal(current.mode, 'first'); assert.equal(current.readyForOutbound, false);
      assert.equal(await snapshot(), beforePublicationReview);
      assert.ok(methods.every(method => method === 'GET'));
    });

    const p = await product();
    await t.test('partial UA import preserves local EN and never fabricates a common name baseline', async () => {
      const preview = await reviewed(p), before = await actual(p);
      assert.ok(preview.inspection.fields.some(f => f.target === 'name' && f.scope === 'all' && f.status === 'imported'));
      assert.ok(preview.inspection.fields.some(f => f.target === 'name' && f.scope === 'en' && f.status === 'pending_outward_confirmation'));
      const result = await commit(preview);
      assert.equal(result.localChanged, true); assert.equal(result.complete, false); assert.equal(result.readyForOutbound, false);
      const after = await actual(p);
      assert.deepEqual(after.magento_name_override.values, { all: 'Remote UA', en: 'Local EN' });
      assert.equal(after.details.answers.braclet_size, '17');
      assert.equal(after.full_sku, before.full_sku); assert.equal(after.weight, before.weight); assert.equal(after.total_price_uah, before.total_price_uah);
      assert.equal((await nameState(p)).baseline_names, null);
      assert.equal((await session(p)).completed_at, null);
      assert.equal((await scope(p, 'name')).state, 'name_received');
      assert.equal((await scope(p, 'name','en')).state, 'pending_outward_confirmation');
      assert.equal((await scope(p, 'dovzhyna_brasletu_diuimiv')).state, 'conflict');
    });
    await t.test('later information import reanchors an already received UA name without importing EN', async () => {
      const before = await actual(p), nameReceipt = await scope(p,'name');
      const decision = { target: 'dovzhyna_brasletu_diuimiv', scope: 'all', choice: 'accept_remote' };
      const preview = await reviewed(p, {}, decision, { ...options, firstSyncDecision: decision });
      assert.ok(preview.inspection.prepared.rows.some(f => f.target === decision.target && f.record.state === 'imported'));
      await commit(preview);
      const after = await actual(p);
      assert.equal(after.details.answers.braclet_size, '18');
      assert.deepEqual(after.magento_name_override.values, before.magento_name_override.values);
      assert.notDeepEqual(after.magento_name_override.generated, before.magento_name_override.generated);
      assert.deepEqual(await scope(p,'name'), nameReceipt);
      assert.equal((await nameState(p)).baseline_names, null);
      assert.equal((await session(p)).completed_at, null);
    });
    await t.test('received-name UNKNOWN read blocks outward and exact remote identity changes are rejected', async () => {
      const before = await snapshot();
      const unknown = await reviewed(p, { size: '18', unknownEnglish: true });
      assert.equal(unknown.inspection.readyForOutbound, false); assert.equal(unknown.inspection.complete, false);
      assert.ok(unknown.inspection.blockers.some(b => b.scope === 'en' || /EN_/.test(b.code)));
      const wrong = await service.inspect(config, await observation(p, { id: 999999, size: '18' }), options);
      assert.equal(wrong.mode, 'review');
      assert.ok(wrong.blockers.some(b => b.code === 'FIRST_SYNC_IDENTITY_CHANGED'));
      assert.equal(await snapshot(), before);
    });
    await t.test('later manager edit survives the new EN receipt and no old UA name is restored', async () => {
      const firstUa = await scope(p,'name');
      await write(async client => {
        await client.query("UPDATE products SET magento_name_override=jsonb_set(magento_name_override,'{values,all}',to_jsonb('Manager edited UA'::text)) WHERE id=$1", [p.id]);
        const lifecycle = (await client.query('SELECT revision FROM product_full_export_state WHERE product_id=$1 FOR UPDATE',[p.id])).rows[0];
        await require('../src/services/full-product-export.service').advanceFullProductRevision(client,p.id,lifecycle.revision);
      });
      const preview = await reviewed(p, { size: '18', en: 'Remote EN' });
      await commit(preview);
      assert.deepEqual((await actual(p)).magento_name_override.values, { all: 'Manager edited UA', en: 'Remote EN' });
      assert.deepEqual(await scope(p,'name'), firstUa);
      assert.equal((await scope(p,'name','en')).state, 'name_received');
      assert.equal((await nameState(p)).baseline_names, null);
    });
    await t.test('keep-local conflict waits for actual fresh read equality before full manifest completion', async () => {
      const item = await product(), decision = { target: 'dovzhyna_brasletu_diuimiv', scope: 'all', choice: 'keep_local' };
      const preview = await reviewed(item, { en: 'Remote EN' }, decision, { ...options, firstSyncDecision: decision });
      assert.equal(preview.inspection.readyForOutbound, true, JSON.stringify(preview.inspection.blockers)); assert.equal(preview.inspection.complete, false);
      await commit(preview);
      assert.equal((await actual(item)).details.answers.braclet_size, '17');
      assert.equal((await session(item)).completed_at, null);
      assert.equal((await scope(item, decision.target)).state, 'pending_outward_confirmation');
      const readback = await reviewed(item, { size: '17', en: 'Remote EN' });
      assert.equal(readback.inspection.complete, true, JSON.stringify(readback.inspection.blockers));
      assert.equal(readback.inspection.prepared.rows.find(f => f.target === decision.target).record.state, 'outward_verified');
      await commit(readback);
      assert.ok((await session(item)).completed_at);
      assert.equal((await scope(item,decision.target)).state,'outward_verified');
      const terminalCount=(await db.query(`SELECT count(*)::int n FROM (
        SELECT DISTINCT ON(f.target,f.scope) f.state FROM magento_first_sync_fields f JOIN magento_first_sync_sessions s ON s.id=f.session_id
        WHERE s.public_product_identity_id=$1 ORDER BY f.target,f.scope,f.revision DESC) latest
        WHERE state IN ('imported','equal','optional_empty','outward_verified','name_received')`,[item.public_product_identity_id])).rows[0].n;
      assert.equal(terminalCount, readback.inspection.prepared.manifest.length);
    });
    await t.test('two real coordinator transactions importing the same first progress produce one local write and audit', async () => {
      const item = await product(), preview = await reviewed(item), holder = await db.connect();
      let attempts = [];
      try {
        await holder.query('BEGIN'); await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[item.id]);
        attempts = [commit(preview), commit(preview)];
        for (const attempt of attempts) attempt.catch(()=>{});
        let blocked = false;
        for(let n=0;n<300;n++) {
          blocked=(await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT p.*,i.public_sku FROM products%') blocked",[name])).rows[0].blocked;
          if(blocked)break; await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(blocked,true,'Coordinator must actually wait on independent product row lock');
        await holder.query('COMMIT');
        const results=await Promise.allSettled(attempts);
        assert.ok(results.some(r=>r.status==='fulfilled'));
        for(const failed of results.filter(r=>r.status==='rejected')) assert.ok(
          ['MAGENTO_SYNC_AMBER_CHANGED','MAGENTO_FIRST_SYNC_EVIDENCE_CHANGED','FIRST_SYNC_LEDGER_STALE'].includes(failed.reason.code), failed.reason.stack);
        assert.equal((await session(item)).revision,'1');
        assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.magento_name_external_accepted' AND subject_id=$1",[String(item.id)])).rows[0].n,1);
        assert.equal((await db.query("SELECT count(*)::int n FROM magento_first_sync_progress WHERE session_id=$1",[(await session(item)).id])).rows[0].n,1);
        assert.equal((await actual(item)).magento_name_override.values.all,'Remote UA');
      } finally {await holder.query('ROLLBACK');holder.release();await Promise.allSettled(attempts);}
    });
    await t.test('actor, product, generation and correction-lineage drift reject before local changes', async () => {
      const item = await product();
      let preview = await reviewed(item);
      await db.query("UPDATE application_users SET status='disabled',deactivated_at=CURRENT_TIMESTAMP WHERE id=$1",[actor]);
      try {const before=await snapshot();await assert.rejects(commit(preview),{code:'ADMIN_PERMISSION_REVOKED'});assert.equal(await snapshot(),before);}
      finally {await db.query("UPDATE application_users SET status='active',deactivated_at=NULL WHERE id=$1",[actor]);}
      preview=await reviewed(item);
      await write(client=>client.query('UPDATE products SET total_price_uah=43 WHERE id=$1',[item.id]));
      let before=await snapshot();await assert.rejects(commit(preview),{code:'MAGENTO_SYNC_AMBER_CHANGED'});assert.equal(await snapshot(),before);

      await db.query('UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2 WHERE singleton',[binding.installationKey,actor]);
      await db.query("INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id) VALUES($1,$2) ON CONFLICT(public_product_identity_id) DO NOTHING",[item.public_product_identity_id,item.id]);
      const request=(await db.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[item.public_product_identity_id])).rows[0];
      const automatic={...options,automatic:{publicIdentityId:item.public_product_identity_id,productId:item.id,generation:request.desired_generation,installationKey:binding.installationKey}};
      preview=await reviewed(item,{},null,automatic);
      await db.query('UPDATE magento_product_sync_requests SET desired_generation=desired_generation+1 WHERE public_product_identity_id=$1',[item.public_product_identity_id]);
      before=await snapshot();await assert.rejects(commit(preview),{code:'MAGENTO_SYNC_AMBER_CHANGED'});assert.equal(await snapshot(),before);
      await db.query('UPDATE magento_auto_sync_activation SET enabled=FALSE WHERE singleton');

      const lineage = await product(), related = await product();
      preview=await reviewed(lineage);
      await write(client=>client.query('INSERT INTO product_corrections(source_product_id,corrected_product_id,source_sku,corrected_sku) VALUES($1,$2,$3,$4)',[lineage.id,related.id,lineage.full_sku,related.full_sku]));
      before=await snapshot();await assert.rejects(commit(preview),{code:'MAGENTO_FIRST_SYNC_EVIDENCE_CHANGED'});assert.equal(await snapshot(),before);
      assert.equal(await session(item),undefined); assert.equal(await session(lineage),undefined);
    });

    await t.test('public apply recovers a committed lost response without rereading Magento or reapplying local fields', async () => {
      const item = await product();
      let observationCount = 0, refuseObservation = false;
      const publicOptions = { ...options, preview: async (_config, request) => {
        observationCount++;
        if (refuseObservation) throw Object.assign(new Error('Synthetic remote read unavailable'), { code: 'FIXTURE_REMOTE_UNAVAILABLE' });
        assert.equal(request.sku, item.full_sku);
        request.onObservation(await observation(item, { en: 'Remote EN' }));
        return {};
      } };
      const selection = { sku: item.full_sku, bindingRevisionId: binding.id };
      const review = await service.review(config, selection, publicOptions);
      const input = { ...selection, previewToken: review.previewToken,
        target: 'dovzhyna_brasletu_diuimiv', scope: 'all', choice: 'accept_remote' };
      const first = await service.apply(config, input, publicOptions);
      assert.equal(first.receipt.state, 'imported');
      assert.equal(first.complete, false); assert.equal(first.readyForOutbound, false);
      assert.equal((await actual(item)).details.answers.braclet_size, '18');
      await write(async client => {
        await client.query("UPDATE products SET magento_name_override=jsonb_set(magento_name_override,'{values,all}',to_jsonb('Manager after response loss'::text)) WHERE id=$1", [item.id]);
        const lifecycle = (await client.query('SELECT revision FROM product_full_export_state WHERE product_id=$1 FOR UPDATE', [item.id])).rows[0];
        await require('../src/services/full-product-export.service').advanceFullProductRevision(client,item.id,lifecycle.revision);
      });
      const before = await snapshot(), previousObservations = observationCount, previousFetches = calls.length;
      refuseObservation = true;
      const retry = await service.apply(config, input, publicOptions);
      assert.deepEqual(retry, { ...first, receipt: { ...first.receipt, alreadyApplied: true } });
      assert.equal(observationCount, previousObservations); assert.equal(calls.length, previousFetches);
      assert.equal(await snapshot(), before);
      assert.equal((await actual(item)).magento_name_override.values.all, 'Manager after response loss');
      for (const changed of [{ choice: 'keep_local' }, { target: 'name' }, { previewToken: 'f'.repeat(64) }]) {
        await assert.rejects(service.apply(config, { ...input, ...changed }, publicOptions), { code: 'FIXTURE_REMOTE_UNAVAILABLE' });
        assert.equal(await snapshot(), before);
      }
      await db.query("UPDATE application_users SET status='disabled',deactivated_at=CURRENT_TIMESTAMP WHERE id=$1", [actor]);
      try {
        await assert.rejects(service.apply(config,input,publicOptions), { code: 'ADMIN_PERMISSION_REVOKED' });
        assert.equal(await snapshot(),before);
      } finally { await db.query("UPDATE application_users SET status='active',deactivated_at=NULL WHERE id=$1", [actor]); }
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_first_sync_progress WHERE session_id=$1',[(await session(item)).id])).rows[0].n,1);
    });

    await t.test('a newly published current binding invalidates an old coordinator inspection', async () => {
      const item=await product(), preview=await reviewed(item);
      binding=await publish(binding.id);
      const before=await snapshot();
      await assert.rejects(commit(preview),{code:'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED'});
      assert.equal(await snapshot(),before);assert.equal(await session(item),undefined);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n,0);
      assert.ok(calls.every(call=>call.method==='GET'));
    });


    await t.test('enqueue persists safe first fields but blocks dispatch until remaining conflicts are resolved', async () => {
      const item=await product(), jobs=require('../src/services/magento/sync-job.service');
      let dispatches=0;
      const runtimeOptions={...options,preview:async(_config,request)=>{
        request.onObservation(await observation(item,{en:'Remote EN'}));return {};
      },dispatch:async()=>{dispatches++;assert.fail('Unresolved first fields must never dispatch');}};
      const selection={sku:item.full_sku,bindingRevisionId:binding.id};
      await assert.rejects(jobs.enqueue(config,selection,runtimeOptions),{code:'MAGENTO_SYNC_AMBER_CHANGED'});
      assert.equal((await actual(item)).magento_name_override.values.all,'Remote UA');
      assert.equal((await scope(item,'dovzhyna_brasletu_diuimiv')).state,'conflict');
      await assert.rejects(jobs.enqueue(config,selection,runtimeOptions),{code:'MAGENTO_FIRST_SYNC_FIELDS_UNRESOLVED'});
      assert.equal(dispatches,0);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs WHERE product_id=$1',[item.id])).rows[0].n,0);
    });
    await t.test('pre-existing queued UPDATE is rechecked by enqueue and APPLY before any dispatch', async () => {
      const item=await product(), state=await capture(item), jobs=require('../src/services/magento/sync-job.service');
      const intent={mode:'update',operations:[]}, id=randomUUID();
      await db.query(`INSERT INTO magento_sync_jobs(id,product_id,public_product_identity_id,sku,installation_key,origin_hash,
        binding_revision_id,binding_hash,amber_hash,plan_hash,intent,baseline,created_by_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'{}',$12)`,
      [id,item.id,item.public_product_identity_id,item.full_sku,binding.installationKey,binding.originHash,
        binding.id,state.bindingHash,state.amberHash,c.hash(intent),JSON.stringify(intent),actor]);
      const before=await snapshot();let dispatches=0;
      const runtimeOptions={...options,apply:true,preview:async(_config,request)=>{
        request.onObservation(await observation(item,{en:'Remote EN'}));return {};
      },dispatch:async()=>{dispatches++;assert.fail('Unreviewed old UPDATE must never dispatch');}};
      await assert.rejects(jobs.enqueue(config,{sku:item.full_sku,bindingRevisionId:binding.id},runtimeOptions),
        {code:'MAGENTO_FIRST_SYNC_FIELDS_UNRESOLVED'});
      assert.equal(await snapshot(),before);
      const result=await jobs.applyJob(config,id,runtimeOptions);
      assert.equal(result.state,'blocked');assert.equal(result.failure.code,'MAGENTO_FIRST_SYNC_FIELDS_UNRESOLVED');
      assert.equal(dispatches,0);assert.equal(await session(item),undefined);
      assert.equal((await actual(item)).magento_name_override,null);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_steps WHERE job_id=$1',[id])).rows[0].n,0);
    });
    await t.test('verified own CREATE continuation keeps its lane but rejects a different remote identity', async () => {
      const item=await product(), state=await capture(item), runtime=require('../src/services/magento/first-sync-runtime');
      const observed=await observation(item,{en:'Remote EN'}), id=randomUUID();
      const intent={mode:'create',operations:[{domain:'coreProduct',payload:{product:{sku:item.full_sku}}}]};
      const job=(await db.query(`INSERT INTO magento_sync_jobs(id,product_id,public_product_identity_id,sku,installation_key,origin_hash,
        binding_revision_id,binding_hash,amber_hash,plan_hash,intent,baseline,created_by_user_id,remote_product_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'{"raw":null}',$12,$13) RETURNING *`,
      [id,item.id,item.public_product_identity_id,item.full_sku,binding.installationKey,binding.originHash,
        binding.id,state.bindingHash,state.amberHash,c.hash(intent),JSON.stringify(intent),actor,observed.raw.id])).rows[0];
      // This fixture models an already committed, independently verified CREATE step.
      await db.query(`INSERT INTO magento_sync_steps(job_id,ordinal,state,dispatched_at,verified_at)
        VALUES($1,0,'verified',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,[id]);
      const before=await snapshot(), lane=await runtime.enforce(config,observed,state,options,{job});
      assert.equal(runtime.isCreateLane(lane),true);
      await write(client=>runtime.assertDispatchOnClient(client,lane));
      assert.equal(await runtime.enforce(config,observed,state,options,{job,createLane:lane}),lane);
      await assert.rejects(runtime.enforce(config,{...observed,raw:{...observed.raw,id:observed.raw.id+1}},
        state,options,{job,createLane:lane}),{code:'MAGENTO_FIRST_SYNC_CREATE_IDENTITY_CHANGED'});
      assert.equal(await snapshot(),before);assert.equal(await session(item),undefined);
    });


    await t.test('reviewed recovery exempts only the exact active job and completes pending fields by fresh readback', async () => {
      const item=await product(), decision={target:'dovzhyna_brasletu_diuimiv',scope:'all',choice:'keep_local'};
      await commit(await reviewed(item,{en:'Remote EN'},decision,{...options,firstSyncDecision:decision}));
      assert.equal((await scope(item,decision.target)).state,'pending_outward_confirmation');
      const state=await capture(item), observed=await observation(item,{size:'17',en:'Remote EN'});
      observed.domainEvidence.inventory={stockId:1,websiteCode:'base',
        sources:[{sourceCode:'default',enabled:true}],sourceItems:[{sourceCode:'default',qty:1,isInStock:true}]};
      const intent={mode:'update',operations:[{domain:'coreProduct',payload:{product:{sku:item.full_sku,name:'Remote UA'}}}],
        websiteIds:[],englishValues:{}};
      const baseline={raw:observed.raw,preservation:{},domainEvidence:observed.domainEvidence},id=randomUUID();
      const job=(await db.query(`INSERT INTO magento_sync_jobs(id,product_id,public_product_identity_id,sku,installation_key,origin_hash,
        binding_revision_id,binding_hash,amber_hash,plan_hash,intent,baseline,created_by_user_id,remote_product_id,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,'uncertain') RETURNING *`,
      [id,item.id,item.public_product_identity_id,item.full_sku,binding.installationKey,binding.originHash,binding.id,
        state.bindingHash,state.amberHash,c.hash(intent),JSON.stringify(intent),JSON.stringify(baseline),actor,observed.raw.id])).rows[0];
      await db.query(`INSERT INTO magento_sync_steps(job_id,ordinal,state,dispatched_at)
        VALUES($1,0,'dispatched',CURRENT_TIMESTAMP)`,[id]);
      await db.query(`INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id,active_job_id,active_generation,state,reason_code)
        VALUES($1,$2,$3,1,'needs_attention','reconciliation_required')`,[item.public_product_identity_id,item.id,id]);
      const eligibility=require('../src/services/magento/first-sync-eligibility');
      for(const params of [{jobId:id},{jobId:null,reviewedRecovery:true},{jobId:randomUUID(),reviewedRecovery:true}]) {
        const blocked=await eligibility.readFirstSyncEligibility(db,config,observed,params);
        assert.equal(blocked.mode,'review');assert.ok(blocked.blockers.some(b=>b.code==='FIRST_SYNC_UNFINISHED_WORK'));
      }
      assert.equal((await eligibility.readFirstSyncEligibility(db,config,observed,{jobId:id,reviewedRecovery:true})).mode,'first');
      const steps=(await db.query('SELECT * FROM magento_sync_steps WHERE job_id=$1 ORDER BY ordinal',[id])).rows;
      const recovery=require('../src/services/magento/sync-job-recovery'),runtime=require('../src/services/magento/first-sync-runtime');
      const review={jobId:id,planHash:job.plan_hash,jobFingerprint:recovery.fingerprint(job,steps),
        remoteFingerprint:recovery.remoteFingerprint(observed),blockers:[]};
      const proof=runtime.reviewedRecovery(job,steps,observed,review,{allowDispatched:true});
      const recoveryOptions={...options,firstSyncRecoveryProof:proof};
      const inspection=await service.inspect(config,observed,recoveryOptions,{jobId:id});
      assert.equal(inspection.mode,'first');assert.equal(inspection.complete,true,JSON.stringify(inspection.blockers));
      const result=await service.commit(config,inspection,state,recoveryOptions,{jobId:id});
      assert.equal(result.complete,true);assert.equal(result.localChanged,false);
      assert.ok((await session(item)).completed_at);
      assert.equal((await scope(item,decision.target)).state,'outward_verified');
      const request=(await db.query('SELECT reason_code,active_job_id FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[item.public_product_identity_id])).rows[0];
      assert.equal(request.reason_code,'reconciliation_required');assert.equal(request.active_job_id,id);
      assert.equal((await db.query('SELECT state FROM magento_sync_steps WHERE job_id=$1',[id])).rows[0].state,'dispatched',
        'First-field readback must not fabricate job or dispatch acknowledgement');
    });


    await t.test('lost name readback restores only the exact sent-name proof without advancing pending receipts', async () => {
      const item=await product(), state=await capture(item);
      const runtime=require('../src/services/magento/first-sync-runtime'), names=require('../src/services/magento/first-sync-name-proof');
      const initial=await observation(item,{ua:'',en:'',size:'17'});
      const inspection=await service.inspect(config,initial,options);
      assert.equal(inspection.readyForOutbound,true,JSON.stringify(inspection.blockers));
      for(const language of ['all','en']) assert.equal(inspection.prepared.rows.find(row=>row.target==='name'&&row.scope===language).record.state,
        'pending_outward_confirmation');
      await service.commit(config,inspection,state,options);
      const lane=await runtime.enforce(config,initial,state,options);
      assert.ok(runtime.nameProof(lane),'Real initial empty-name proof must be available');
      const ref=await write(client=>runtime.nameBaselineOnClient(client,lane,initial));
      assert.deepEqual(ref.scopes.sort(),['all','en']);
      const sent={all:'Generated UA 17',en:'Local EN'};
      const intent={mode:'update',operations:[
        {domain:'coreProduct',payload:{product:{sku:item.full_sku,name:sent.all}}},
        {domain:'storeViews',payload:{product:{sku:item.full_sku,name:sent.en}}},
      ],websiteIds:[],englishValues:{name:sent.en}};
      const baseline={raw:initial.raw,domainEvidence:initial.domainEvidence,preservation:{},firstSyncNames:ref},id=randomUUID();
      const job=(await db.query(`INSERT INTO magento_sync_jobs(id,product_id,public_product_identity_id,sku,installation_key,origin_hash,
        binding_revision_id,binding_hash,amber_hash,plan_hash,intent,baseline,created_by_user_id,remote_product_id,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,'uncertain') RETURNING *`,
      [id,item.id,item.public_product_identity_id,item.full_sku,binding.installationKey,binding.originHash,binding.id,
        state.bindingHash,state.amberHash,c.hash(intent),JSON.stringify(intent),JSON.stringify(baseline),actor,initial.raw.id])).rows[0];
      await db.query(`INSERT INTO magento_sync_steps(job_id,ordinal,state,dispatched_at)
        VALUES($1,0,'dispatched',CURRENT_TIMESTAMP),($1,1,'dispatched',CURRENT_TIMESTAMP)`,[id]);
      const current=await observation(item,{ua:sent.all,en:sent.en,size:'17'}),before=await snapshot();
      const restored=await runtime.readNameProof(db,job,current);
      assert.ok(restored,'Exact remote names written by the original job must restore proof while receipts remain pending');
      assert.equal(names.allows(current,restored),true);assert.equal(names.baselineAllows(job,current,restored),true);
      assert.equal(await snapshot(),before,'Read-only proof reconstruction must not advance any durable receipt');
      for(const language of ['all','en']) assert.equal((await scope(item,'name',language)).state,'pending_outward_confirmation');
      const other=await observation(item,{ua:sent.all,en:'Unrelated remote edit',size:'17'});
      assert.equal(await runtime.readNameProof(db,job,other),null);
      assert.equal(await snapshot(),before);
      const readback=await service.inspect(config,current,options,{jobId:id});
      assert.equal(readback.complete,true,JSON.stringify(readback.blockers));
      const result=await service.commit(config,readback,state,options,{jobId:id});
      assert.equal(result.localChanged,false);assert.equal(result.complete,true);
      for(const language of ['all','en']) assert.equal((await scope(item,'name',language)).state,'outward_verified');
      assert.ok((await session(item)).completed_at);
      assert.equal((await db.query("SELECT count(*)::int n FROM magento_sync_steps WHERE job_id=$1 AND state='dispatched'",[id])).rows[0].n,2);
    });


    await t.test('external-delivery floors require the linked immutable exact-origin remote identity evidence', async () => {
      async function externallyDelivered(alter = value => value) {
        const sku='BR-EXTERNAL-'+(++sequence);
        return write(async client => {
          const item=(await client.query(`INSERT INTO products(full_sku,category,weight,total_price_uah,details)
            VALUES($1,'BR',5,42,'{"answers":{"braclet_size":"17"},"manualPriceUah":42}') RETURNING id,full_sku,public_product_identity_id`,[sku])).rows[0];
          const remoteId=1000+item.id;
          const proof=alter({eventKey:'product.external_delivery_acknowledged',subjectType:'product',subjectId:String(item.id),
            details:{planHash:'a'.repeat(64),entryHash:'b'.repeat(64),resolutionKey:'synthetic-external-'+item.id,
              internalSku:sku,publicSku:sku,fullRevision:'1',confirmedRevision:'0',deliveryVersionBefore:'1',routeBefore:'normal',
              remote:{originHash:binding.originHash,productId:remoteId,sku,observedAt:'2026-10-09T00:00:00Z'},
              externalDeliverySemantic:true,snapshotConfirmationClaimed:false,payloadEqualityClaimed:false,
              automaticSyncSuccessClaimed:false,snapshotEvidenceUsed:false,futureDeliveryWaived:false}});
          const event=(await client.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id,details)
            VALUES($1,$2,'{"displayName":"First coordinator administrator","preferredUsername":null}',$3,$4,$5,$6::jsonb) RETURNING id`,
          [proof.eventKey,actor,proof.subjectType,proof.subjectId,randomUUID(),JSON.stringify(proof.details)])).rows[0];
          // Seed the historical acknowledgement only in the initial synthetic lifecycle row.
          // The real acknowledgement update boundary and immutable audit triggers stay enabled.
          await client.query(`INSERT INTO product_full_export_state(product_id,route,evidence,business_exclusion_state,
            externally_delivered_revision,externally_delivered_event_id)
            VALUES($1,'normal','{"origin":"ordinary_save","fixture":true}','none',1,$2)`,[item.id,event.id]);
          return item;
        });
      }
      for(const example of [
        {label:'exact',expected:null,alter:proof=>proof},
        {label:'foreign origin',expected:'FIRST_SYNC_ORIGIN_REVIEW_REQUIRED',alter:proof=>{
          proof.details.remote.originHash=c.originHash('https://other-installation.invalid');return proof;}},
        {label:'different remote ID',expected:'FIRST_SYNC_IDENTITY_CHANGED',alter:proof=>proof,remote:{id:999999}},
        {label:'missing remote',expected:'FIRST_SYNC_IDENTITY_CHANGED',alter:proof=>proof,absent:true},
        {label:'different acknowledged SKU',expected:'FIRST_SYNC_IDENTITY_CHANGED',alter:proof=>{
          proof.details.remote.sku='BR-OTHER-REMOTE';return proof;}},
        {label:'missing remote evidence',expected:'FIRST_SYNC_HISTORY_REVIEW_REQUIRED',alter:proof=>{
          delete proof.details.remote;return proof;}},
        {label:'malformed remote ID',expected:'FIRST_SYNC_HISTORY_REVIEW_REQUIRED',alter:proof=>{
          proof.details.remote.productId=-1;return proof;}},
        {label:'unrelated linked audit subject',expected:'FIRST_SYNC_HISTORY_REVIEW_REQUIRED',alter:proof=>{
          proof.subjectId='999999';return proof;}},
      ]) {
        const item=await externallyDelivered(example.alter), observed=await observation(item,example.remote||{});
        if(example.absent)observed.raw=null;
        const before=await snapshot(), result=await service.inspect(config,observed,options);
        assert.equal(result.mode,example.expected?'review':'ordinary',example.label+': '+JSON.stringify(result.blockers));
        assert.equal(result.readyForOutbound,!example.expected,example.label);
        if(example.expected)assert.ok(result.blockers.some(blocker=>blocker.code===example.expected),
          example.label+': '+JSON.stringify(result.blockers));
        assert.equal(await snapshot(),before,example.label+' must remain read-only');
        assert.equal(await session(item),undefined);
      }
    });

    await t.test('an allocated native identity cannot adopt names or values from an unacknowledged same-SKU remote product', async () => {
      const audit = async eventKey => (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
        VALUES($1,$2,'{"displayName":"First coordinator administrator","preferredUsername":null}','public_sku_activation','singleton',$3) RETURNING id`,
      [eventKey,actor,randomUUID()])).rows[0].id;
      const activationEvent = await audit('public_sku.activated'), cutoverEvent = await audit('magento_delivery.cutover');
      await write(async client => {
        await client.query("SET LOCAL amber.public_sku_activation='on'");
        await client.query(`UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,
          activated_by_user_id=$1,activation_event_id=$2 WHERE singleton`,[actor,activationEvent]);
        await client.query("SET LOCAL amber.magento_delivery_cutover='on'");
        await client.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,
          legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton`,
        [binding.installationKey,actor,cutoverEvent]);
      });
      const item = (await require('./product-fixture').insertNativeProductFixture(db, {
        category:'BR',totalPriceUah:42,weight:5,details:{answers:{braclet_size:'17'},manualPriceUah:42},actorUserId:actor,
      })).rows[0];
      const identity = (await db.query('SELECT origin,public_sku FROM public_product_identities WHERE id=$1',[item.public_product_identity_id])).rows[0];
      assert.equal(identity.origin,'allocated'); assert.equal(item.full_sku,null); assert.ok(item.characteristic_version_id);
      const observed = await observation(item,{en:'Remote EN'});
      assert.equal(observed.raw.sku,identity.public_sku);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs WHERE public_product_identity_id=$1',[item.public_product_identity_id])).rows[0].n,0);
      const before = await snapshot();
      const inspection = await service.inspect(config,observed,options);
      assert.equal(inspection.mode,'review'); assert.equal(inspection.readyForOutbound,false);
      assert.ok(inspection.blockers.some(blocker=>blocker.code==='MAGENTO_NATIVE_IDENTITY_COLLISION'));
      const result = await service.commit(config,inspection,null,options);
      assert.equal(result.localChanged,false); assert.equal(await snapshot(),before);
      assert.equal(await session(item),undefined);
      assert.equal((await actual(item)).magento_name_override,null);
    });

  } finally {
    if(db)await db.end();
    if(created)await control.query('DROP DATABASE '+name);
    await control.end();
  }
});
