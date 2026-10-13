require('../test/setup-env');
// Real cutover command receipts in a dedicated disposable database.
// Magento transport is synthetic and permits GET requests only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { Client, Pool } = require('pg');
const exec = promisify(execFile);

test('explicit cutover-only first-sync admission preserves history and field decisions', async t => {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = 'amber_first_sync_cutover_' + process.pid + '_test';
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
        name: patch.ua ?? 'Remote UA', price: patch.price ?? String(amber.product.total_price_uah),
        custom_attributes: [{ attribute_code: p.category==='SV' ? 'decor_weight' : 'dovzhyna_brasletu_diuimiv',
          value: p.category==='SV' ? patch.weight ?? '140' : patch.size ?? '18' }] };
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
      (SELECT jsonb_agg(r ORDER BY product_id) FROM product_export_revisions r) priceExports,
      (SELECT jsonb_agg(s ORDER BY id) FROM export_snapshots s) snapshots,
      (SELECT jsonb_agg(a ORDER BY snapshot_id,group_code,profile_version) FROM magento_export_artifacts a) artifacts,
      (SELECT jsonb_agg(m ORDER BY snapshot_id,product_id) FROM export_snapshot_products m) memberships,
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

    const products=[];
    for(let n=0;n<18;n++) products.push(await product());
    const svAcceptance=(await insertProductFixture(db,`INSERT INTO products(id,full_sku,category,weight,total_price_uah,details,
      magento_name_subject_ua,magento_name_subject_en)
      VALUES(1488,'SV11500004','SV',132.300,2950,'{"answers":{"weight":"132,3"},"manualPriceUah":2950}',
        'Existing Amber UA','Existing Amber EN') RETURNING id,full_sku,category,public_product_identity_id`)).rows[0];
    products.push(svAcceptance);
    await db.query('INSERT INTO product_export_revisions(product_id,has_product_snapshot) SELECT unnest($1::int[]),TRUE',
      [[products[0].id,products[1].id,products[3].id,products[8].id,products[10].id,products[11].id,products[12].id,products[13].id,products[14].id,products[15].id,products[16].id,products[17].id,svAcceptance.id]]);
    await db.query(`UPDATE product_full_export_state SET evidence='{"origin":"migration_039","coverage":"unresolved_historical"}',
      business_exclusion_state='none',delivery_version=delivery_version+1`);
    await db.query('UPDATE export_state SET exported_to_product_id=$1',[products.at(-1).id]);
    const cutover=require('../src/services/full-product-cutover.service');
    const maintenance={...options,expectedDatabase:name,deploymentEvidence:'Disposable cutover fixture, no old writer'};
    await cutover.prepare(maintenance);
    const index=await cutover.generate('index',maintenance);
    await cutover.indexHistorical(index,index.contentSha256,maintenance);
    const manifest=await cutover.generate('cutover',maintenance);
    assert.ok(manifest.entries.every(e=>e.action==='legacy_baseline'));
    await cutover.approve(manifest,manifest.contentSha256,'Explicit fixture legacy baseline',maintenance);
    await cutover.applyBatch(manifest.contentSha256,0,maintenance);
    await cutover.activate(manifest.contentSha256,maintenance);
    const admission=require('../src/services/magento/first-sync-cutover-admission');
    let remote={size:'18',en:'Remote EN'};
    const requestOptions={...options,preview:async(_config,input)=>{
      const p=products.find(p=>p.full_sku===input.sku);assert.ok(p);
      input.onObservation(await observation(p,remote));return {};
    }};
    const selection=p=>({sku:p.full_sku,bindingRevisionId:binding.id});
    const review=p=>service.review(config,selection(p),requestOptions);
    const admit=async p=>{const plan=await review(p);assert.equal(plan.mode,'review',JSON.stringify(plan));
      assert.ok(plan.historyReview,JSON.stringify(plan));
      const command={...selection(p),previewToken:plan.historyReview.previewToken};
      return {command,result:await admission.apply(config,command,requestOptions)};
    };
    const counter=async p=>(await db.query('SELECT revision,confirmed_revision,cutover_baseline_revision,cutover_baseline_event_id,csv_retired_revision,externally_delivered_revision,delivery_version FROM product_full_export_state WHERE product_id=$1',[p.id])).rows[0];
    const auditCount=async()=> (await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.magento_first_sync_cutover_reviewed'")).rows[0].n;

    const repair=require('../src/services/export-exposure/repair-loader');
    const publicState=async()=>{
      const result={};
      for(const {tablename}of(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
        assert.match(tablename,/^[a-z_]+$/);
        result[tablename]=(await db.query(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) rows
          FROM (SELECT to_jsonb(t) j FROM public."${tablename}" t) entries`)).rows[0].rows;
      }
      return result;
    };
    const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
    const reached=async promise=>{
      let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error('Synthetic eligibility race barrier timed out')),10000);
      })]);}finally{clearTimeout(timer);}
    };
    await t.test('new admission captures retained inventory once per review and twice per apply with two remote observations',async subtest=>{
      const p=products[13],before=await publicState(),captures=[],read=repair.readRepairInput;
      let phase='review',observations=0;
      subtest.mock.method(repair,'readRepairInput',async client=>{captures.push(phase);return read(client);});
      const opts={...requestOptions,preview:async(...args)=>{observations++;return requestOptions.preview(...args);}};
      const plan=await service.review(config,selection(p),opts);
      assert.equal(plan.historyReviewAssessment.status,'available');assert.equal(plan.historyReview.legacySnapshotFlag,true);
      assert.deepEqual(captures,['review']);assert.equal(observations,1);assert.deepEqual(await publicState(),before);
      phase='apply';const result=await admission.apply(config,{...selection(p),previewToken:plan.historyReview.previewToken},opts);
      assert.deepEqual(captures,['review','apply','apply']);assert.equal(observations,2);
      assert.equal(result.receipt.alreadyApplied,false);assert.equal(result.scope,'first_sync_review_only');
      const after=await publicState(),oldIds=new Set(before.audit_events.map(row=>row.id));
      const added=after.audit_events.filter(row=>!oldIds.has(row.id));assert.equal(added.length,1);
      assert.equal(added[0].event_key,'product.magento_first_sync_cutover_reviewed');
      assert.equal(added[0].details.remoteWrites,0);assert.equal(added[0].details.enqueued,false);
      assert.equal(added[0].details.admission.identity.productId,p.id);
      assert.deepEqual({...after,audit_events:after.audit_events.filter(row=>oldIds.has(row.id))},before);
    });
    await t.test('locked admission assertion captures once per invocation and never reuses the earlier opaque proof',async subtest=>{
      const p=products[16];await admit(p);
      const inspected=await service.inspect(config,await observation(p,remote),options);
      assert.equal(inspected.mode,'first');assert.ok(inspected.first.historyAdmission);
      const before=await publicState(),read=repair.readRepairInput,requests=calls.length;let captures=0;
      subtest.mock.method(repair,'readRepairInput',async client=>{captures++;return read(client);});
      let previous=inspected.first.historyAdmission;
      for(let invocation=1;invocation<=2;invocation++){
        const result=await write(tx=>admission.assertOnClient(tx,config,inspected.observation,previous));
        assert.equal(captures,invocation);assert.notEqual(result.admission,previous);
        assert.equal(admission.allows(inspected.observation,result.admission),true);
        assert.equal(admission.rootId(result.admission),admission.rootId(previous));
        assert.equal(result.evidenceHash,inspected.first.historyAdmissionHash);previous=result.admission;
      }
      assert.equal(calls.length,requests);assert.deepEqual(await publicState(),before);
    });
    await t.test('a separate lifecycle writer invalidates a previously asserted proof on the next invocation',async()=>{
      const p=products[16],inspected=await service.inspect(config,await observation(p,remote),options);
      const proof=await write(tx=>admission.assertOnClient(tx,config,inspected.observation,inspected.first.historyAdmission));
      const writer=new Client({connectionString:target.toString()});await writer.connect();
      try{
        await gate.begin(writer,'BEGIN');
        await require('../src/services/full-product-export.service').advanceFullProductRevision(writer,p.id,(await counter(p)).revision);
        await gate.commit(writer);await gate.release(writer);
        const after=await publicState();
        await assert.rejects(write(tx=>admission.assertOnClient(tx,config,inspected.observation,proof.admission)),
          {code:'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED'});
        assert.deepEqual(await publicState(),after);
      }finally{await gate.rollback(writer).catch(()=>{});await gate.release(writer);await writer.end();}
    });
    await t.test('locked assertion rejects a newer receipt committed during its fresh retained capture',async subtest=>{
      const p=products[17];await admit(p);
      const inspected=await service.inspect(config,await observation(p,remote),options);
      assert.equal(inspected.mode,'first');assert.ok(inspected.first.historyAdmission);
      const read=repair.readRepairInput,captured=deferred(),resume=deferred(),pids=[];
      const writer=new Client({connectionString:target.toString()});await writer.connect();let asserting,paused=false;
      subtest.mock.method(repair,'readRepairInput',async client=>{
        const input=await read(client);pids.push((await client.query('SELECT pg_backend_pid() pid')).rows[0].pid);
        if(!paused){paused=true;captured.resolve();await resume.promise;}return input;
      });
      try{
        asserting=write(tx=>admission.assertOnClient(tx,config,inspected.observation,inspected.first.historyAdmission))
          .then(result=>({result}),error=>({error}));await reached(captured.promise);
        const writerPid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const prior=(await writer.query(`SELECT details FROM audit_events WHERE event_key='product.magento_first_sync_cutover_reviewed'
          AND details->'admission'->'identity'->>'publicIdentityId'=$1 ORDER BY id DESC LIMIT 1`,[String(p.public_product_identity_id)])).rows[0];
        const details=structuredClone(prior.details);details.admission.retainedHash='0'.repeat(64);
        await gate.begin(writer,'BEGIN');await require('../src/audit/audit-events').writeAuditEvent(writer,{
          mutationContext:{actorUserId:actor},eventKey:'product.magento_first_sync_cutover_reviewed',
          subjectType:'magento_first_sync_cutover_admission',subjectId:c.hash('newer receipt during locked assertion'),details});
        await gate.commit(writer);await gate.release(writer);const after=await publicState();resume.resolve();
        const outcome=await asserting;assert.equal(outcome.error?.code,'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED');
        assert.ok(pids.length>0);assert.ok(pids.every(pid=>pid!==writerPid));assert.deepEqual(await publicState(),after);
      }finally{resume.resolve();if(asserting)await asserting;await gate.rollback(writer).catch(()=>{});
        await gate.release(writer);await writer.end();}
    });
    await t.test('an exact receipt appearing during capture is read again under READ COMMITTED instead of reusing the earlier receipt',async subtest=>{
      const p=products[13],observed=await observation(p,remote),read=repair.readRepairInput,captured=deferred(),resume=deferred();
      const reader=new Client({connectionString:target.toString()}),writer=new Client({connectionString:target.toString()});
      await reader.connect();await writer.connect();let reading,captures=0;
      const ids=await Promise.all([reader,writer].map(async client=>(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid));assert.notEqual(ids[0],ids[1]);
      subtest.mock.method(repair,'readRepairInput',async client=>{const input=await read(client);captures++;captured.resolve();await resume.promise;return input;});
      try{
        await reader.query('BEGIN READ ONLY');assert.equal((await reader.query('SHOW transaction_isolation')).rows[0].transaction_isolation,'read committed');
        reading=admission.readOnClient(reader,config,observed).then(result=>({result}),error=>({error}));await reached(captured.promise);
        const prior=(await writer.query(`SELECT details FROM audit_events WHERE event_key='product.magento_first_sync_cutover_reviewed'
          AND details->'admission'->'identity'->>'publicIdentityId'=$1 ORDER BY id DESC LIMIT 1`,[String(p.public_product_identity_id)])).rows[0];
        const details=structuredClone(prior.details);details.admission.retainedHash='0'.repeat(64);
        await gate.begin(writer,'BEGIN');await require('../src/audit/audit-events').writeAuditEvent(writer,{
          mutationContext:{actorUserId:actor},eventKey:'product.magento_first_sync_cutover_reviewed',
          subjectType:'magento_first_sync_cutover_admission',subjectId:c.hash('synthetic newer invalid receipt'),details});
        await gate.commit(writer);await gate.release(writer);const afterRace=await publicState();resume.resolve();
        const outcome=await reading;assert.equal(outcome.error,undefined);assert.deepEqual(outcome.result,{admission:null,evidenceHash:null});
        assert.equal(captures,1);await reader.query('COMMIT');assert.deepEqual(await publicState(),afterRace);
      }finally{resume.resolve();if(reading)await reading;await reader.query('ROLLBACK').catch(()=>{});await reader.end();
        await gate.rollback(writer).catch(()=>{});await gate.release(writer);await writer.end();}
    });

    for(const [index,kind]of ['legacy_flag','retained_file'].entries())await t.test(
      'fresh final eligibility rejects '+kind+' committed by an independent connection after apply inspection',async subtest=>{
        const p=products[14+index],read=repair.readRepairInput,inspect=service.inspect,captures=[];
        const inspected=deferred(),resume=deferred();let phase='review',observations=0,paused=false,applying;
        const writer=new Client({connectionString:target.toString()});await writer.connect();
        const writerPid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        subtest.mock.method(repair,'readRepairInput',async client=>{
          const input=await read(client),pid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
          captures.push({phase,pid,flag:input.revisions.find(row=>row.product_id===p.id)?.has_product_snapshot,
            retained:input.snapshots.map(row=>row.id)});return input;
        });
        subtest.mock.method(service,'inspect',async(...args)=>{
          const result=await inspect(...args);
          if(phase==='apply_inspect'&&!paused){paused=true;assert.ok(result.historyReview);inspected.resolve();await resume.promise;}
          return result;
        });
        const opts={...requestOptions,preview:async(...args)=>{observations++;return requestOptions.preview(...args);}};
        try{
          const plan=await service.review(config,selection(p),opts);assert.ok(plan.historyReview);
          const count=await auditCount();phase='apply_inspect';
          applying=admission.apply(config,{...selection(p),previewToken:plan.historyReview.previewToken},opts)
            .then(result=>({result}),error=>({error}));
          await reached(inspected.promise);assert.deepEqual(captures.map(row=>row.phase),['review','apply_inspect']);
          assert.ok(captures.every(row=>row.pid!==writerPid));
          await gate.begin(writer,'BEGIN');
          if(kind==='legacy_flag')await writer.query('UPDATE product_export_revisions SET has_product_snapshot=FALSE WHERE product_id=$1',[p.id]);
          else {
            const id=randomUUID();await writer.query(`INSERT INTO export_snapshots(id,idempotency_key,from_sku,to_sku,resolved_to_sku,exported_to_product_id,
              row_count,file_name,csv_content,status) VALUES($1,$1,$2,$2,$2,$3,1,'race.csv',$4,'generated')`,
            [id,p.full_sku,p.id,`sku,price_uah\r\n${p.full_sku},42\r\n`]);
          }
          await gate.commit(writer);await gate.release(writer);
          const afterRace=await publicState();phase='apply_final';resume.resolve();const outcome=await applying;
          assert.equal(outcome.error?.code,'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED');
          assert.deepEqual(captures.map(row=>row.phase),['review','apply_inspect','apply_final']);assert.equal(observations,2);
          assert.ok(captures.every(row=>row.pid!==writerPid));
          if(kind==='legacy_flag')assert.deepEqual(captures.map(row=>row.flag),[true,true,false]);
          else assert.equal(captures[2].retained.length,captures[1].retained.length+1);
          assert.equal(await auditCount(),count);assert.equal(await session(p),undefined);
          assert.deepEqual(await publicState(),afterRace);
        }finally{
          resume.resolve();if(applying)await applying;await gate.rollback(writer).catch(()=>{});
          await gate.release(writer);await writer.end();
        }
      });
    await t.test('preview is read-only and explicit admission only records one scoped immutable audit',async()=>{
      const p=products[0],before=await snapshot(),original=await counter(p);
      const preview=await review(p);assert.equal(preview.mode,'review');assert.ok(preview.historyReview);
      assert.equal(preview.historyReview.legacySnapshotFlag,true);
      assert.equal(preview.historyReviewAssessment.code,'FIRST_SYNC_LEGACY_SNAPSHOT_FLAG_REVIEW_AVAILABLE');
      assert.equal(preview.readyForOutbound,false);assert.equal(preview.complete,false);assert.deepEqual(preview.fields,[]);
      assert.equal(await snapshot(),before);
      const {command,result}=await admit(p);assert.equal(result.scope,'first_sync_review_only');assert.equal(result.doesNotAcknowledgeExport,true);
      assert.equal(result.receipt.alreadyApplied,false);assert.deepEqual(await counter(p),original);assert.equal(await session(p),undefined);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n,0);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_binding_handoffs')).rows[0].n,0);
      const after=await snapshot();const repeat=await admission.apply(config,command,requestOptions);
      assert.equal(repeat.receipt.auditEventId,result.receipt.auditEventId);assert.equal(repeat.receipt.alreadyApplied,true);assert.equal(await snapshot(),after);
      const fields=await review(p);assert.equal(fields.mode,'first');assert.ok(fields.fields.some(f=>f.status==='conflict'));
      assert.equal(await snapshot(),after);assert.equal(await session(p),undefined);
      assert.equal((await db.query('SELECT has_product_snapshot FROM product_export_revisions WHERE product_id=$1',[p.id])).rows[0].has_product_snapshot,true);
    });
    await t.test('SV11500004 populated comma grams and existing names enter field review only after explicit flag-only admission',async()=>{
      const p=svAcceptance;
      await db.query(`INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id,state,reason_code,diagnostics)
        VALUES($1,$2,'needs_attention','data_or_binding','[{"code":"PRODUCT_EVALUATION_NOT_READY","issueFields":["decor_weight"]}]')`,
      [p.public_product_identity_id,p.id]);
      const before=await snapshot(),productBefore=await actual(p),counters=await counter(p);
      const plan=await review(p);assert.equal(plan.mode,'review');assert.deepEqual(plan.fields,[]);
      assert.equal(plan.historyReview.legacySnapshotFlag,true);assert.equal(await snapshot(),before);
      const {result}=await admit(p);assert.equal(result.doesNotAcknowledgeExport,true);
      const admitted=await snapshot(),fields=await review(p),weight=fields.fields.find(f=>f.target==='decor_weight');
      assert.equal(fields.mode,'first');assert.equal(weight.local.known,true);assert.equal(weight.local.present,true);
      assert.equal(weight.local.value,'132.300');assert.equal(weight.remote.value,'140');assert.equal(weight.canAcceptRemote,false);
      assert.equal(fields.readyForOutbound,false);assert.deepEqual(await actual(p),productBefore);
      assert.deepEqual(await counter(p),counters);assert.equal(await snapshot(),admitted);assert.equal(await session(p),undefined);
      assert.equal((await db.query('SELECT has_product_snapshot FROM product_export_revisions WHERE product_id=$1',[p.id])).rows[0].has_product_snapshot,true);
      assert.equal(productBefore.total_price_uah,'2950.00');assert.equal(productBefore.details.answers.weight,'132,3');
      assert.equal(productBefore.magento_name_subject_ua,'Existing Amber UA');assert.equal(productBefore.magento_name_subject_en,'Existing Amber EN');
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs WHERE product_id=$1',[p.id])).rows[0].n,0);
    });
    await t.test('stale local, remote and publication evidence cannot issue admission',async()=>{
      const p=products[1],plan=await review(p),command={...selection(p),previewToken:plan.historyReview.previewToken};
      const count=await auditCount();
      await write(tx=>tx.query('UPDATE product_export_revisions SET has_product_snapshot=FALSE WHERE product_id=$1',[p.id]));
      await assert.rejects(admission.apply(config,command,requestOptions),{code:'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED'});
      await write(tx=>tx.query('UPDATE product_export_revisions SET has_product_snapshot=TRUE WHERE product_id=$1',[p.id]));
      remote={...remote,id:90001};
      await assert.rejects(admission.apply(config,command,requestOptions),{code:'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED'});
      remote={size:'18',en:'Remote EN'};
      await write(tx=>tx.query("UPDATE products SET details=jsonb_set(details,'{answers,braclet_size}','\"19\"') WHERE id=$1",[p.id]));
      await assert.rejects(admission.apply(config,command,requestOptions),{code:'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED'});
      assert.equal(await auditCount(),count);assert.equal(await session(p),undefined);
    });
    await t.test('concurrent same-review admission uses independent connections and records one audit',async()=>{
      const p=products[2],plan=await review(p),command={...selection(p),previewToken:plan.historyReview.previewToken};
      const count=await auditCount(),results=await Promise.all([admission.apply(config,command,requestOptions),admission.apply(config,command,requestOptions)]);
      assert.equal(results[0].receipt.auditEventId,results[1].receipt.auditEventId);
      assert.deepEqual(results.map(r=>r.receipt.alreadyApplied).sort(),[false,true]);assert.equal(await auditCount(),count+1);
    });
    await t.test('CSV-disabled local import retains immutable root admission through progress, dispatch and completion',async subtest=>{
      const p=products[3];await admit(p);
      const event=(await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
        VALUES('magento_delivery.cutover',$1,'{"displayName":"Fixture","preferredUsername":null}','fixture','csv-disabled',$2) RETURNING id`,[actor,randomUUID()])).rows[0].id;
      await write(async tx=>{await tx.query("SET LOCAL amber.magento_delivery_cutover='on'");
        await tx.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,
          legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton`,[binding.installationKey,actor,event]);});
      const prepared=await reviewed(p,{size:'18',en:'Remote EN'},{target:'dovzhyna_brasletu_diuimiv',scope:'all',choice:'keep_local'});
      const read=repair.readRepairInput;let captures=0;
      const commitRead=subtest.mock.method(repair,'readRepairInput',async client=>{captures++;return read(client);});
      const result=await commit(prepared);assert.equal(result.localChanged,true);
      assert.equal(captures,2,'commit keeps its separate fresh eligibility after the one-capture admission assertion');
      commitRead.mock.restore();
      const f=await counter(p);assert.equal(f.csv_retired_revision,f.revision);assert.ok(BigInt(f.revision)>1n);
      const pending=await service.inspect(config,await observation(p,{size:'18',ua:'Remote UA',en:'Remote EN'}),options);
      assert.equal(pending.mode,'first',JSON.stringify(pending.blockers));assert.ok(pending.first.historyAdmission);
      assert.ok(pending.first.progress.historyAdmissionEventId);
      captures=0;
      const readMock=subtest.mock.method(repair,'readRepairInput',async client=>{captures++;return read(client);});
      await write(tx=>require('../src/services/magento/first-sync-history-admission').assertOnClient(tx,config,pending.observation,pending.first.historyAdmission));
      assert.equal(captures,1,'pending progress assertion reuses its own fresh eligibility proof');
      readMock.mock.restore();
      const done=await reviewed(p,{size:'17',ua:'Remote UA',en:'Remote EN'});assert.equal(done.inspection.complete,true);
      await commit(done);
      captures=0;subtest.mock.method(repair,'readRepairInput',async client=>{captures++;return read(client);});
      await write(tx=>require('../src/services/magento/first-sync-history-admission').assertOnClient(tx,config,done.inspection.observation,done.inspection.first.historyAdmission));
      assert.equal(captures,1,'completed eligibility still uses the fresh admission fallback');
      assert.equal((await service.inspect(config,await observation(p,{size:'17'}),options)).mode,'ordinary');
    });
    await t.test('an incomplete session cannot bypass admission after unrelated revision/CSV drift',async()=>{
      const p=products[4];await admit(p);await commit(await reviewed(p,{size:'18',en:'Remote EN'}));
      const before=await counter(p);
      await write(tx=>require('../src/services/full-product-export.service').advanceFullProductRevision(tx,p.id,before.revision));
      const changed=await service.inspect(config,await observation(p,{size:'18',en:'Remote EN'}),options);
      assert.equal(changed.mode,'review');assert.ok(changed.blockers.some(b=>b.code==='FIRST_SYNC_HISTORY_REVIEW_REQUIRED'));
      assert.equal(changed.first.historyAdmission,null);assert.equal(changed.historyReview,undefined);
    });
    await t.test('current administrator authority is required and denied apply is side-effect free',async()=>{
      const p=products[5],plan=await review(p),command={...selection(p),previewToken:plan.historyReview.previewToken};
      await db.query("UPDATE application_users SET status='disabled',deactivated_at=CURRENT_TIMESTAMP WHERE id=$1",[actor]);
      const before=await snapshot();await assert.rejects(admission.apply(config,command,requestOptions),{code:'ADMIN_PERMISSION_REVOKED'});
      assert.equal(await snapshot(),before);
      await db.query("UPDATE application_users SET status='active',deactivated_at=NULL WHERE id=$1",[actor]);
    });
    await t.test('an incomplete admitted session can re-review a newer publication without resetting receipts',async()=>{
      const p=products[6];await admit(p);await commit(await reviewed(p,{size:'18',en:'Remote EN'}));
      const previous=await scope(p,'name'),root=(await db.query('SELECT command FROM magento_first_sync_progress WHERE session_id=$1 AND revision=1',[(await session(p)).id])).rows[0].command.historyAdmissionEventId;
      const oldBinding=binding.id;binding=await publish(oldBinding);
      const stale=await service.inspect(config,await observation(p,{size:'18',en:'Remote EN'}),options);
      assert.equal(stale.mode,'review');assert.ok(stale.historyReview);
      await assert.rejects(admission.apply(config,{sku:p.full_sku,bindingRevisionId:oldBinding,previewToken:stale.historyReview.previewToken},requestOptions),{code:'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED'});
      await admit(p);const resumed=await service.inspect(config,await observation(p,{size:'18',en:'Remote EN'}),options);
      assert.equal(resumed.mode,'first');assert.equal(resumed.first.progress.historyAdmissionEventId,root);assert.deepEqual(await scope(p,'name'),previous);
    });
    await t.test('true indicator proof survives dedicated price-stream revision advancement',async()=>{
      const p=products[11];await admit(p);
      await commit(await reviewed(p,{size:'18',en:'Remote EN'}));
      await write(tx=>tx.query('UPDATE product_export_revisions SET revision=revision+1 WHERE product_id=$1',[p.id]));
      const price=(await db.query('SELECT * FROM product_export_revisions WHERE product_id=$1',[p.id])).rows[0];
      assert.equal(price.has_product_snapshot,true);assert.ok(BigInt(price.revision)>0n);
      const resumed=await service.inspect(config,await observation(p,{size:'18',en:'Remote EN'}),options);
      assert.equal(resumed.mode,'first');assert.ok(resumed.first.historyAdmission);
      await write(tx=>admission.assertOnClient(tx,config,resumed.observation,resumed.first.historyAdmission));
      const receipts=await scope(p,'name');
      await write(tx=>tx.query('UPDATE product_export_revisions SET has_product_snapshot=FALSE WHERE product_id=$1',[p.id]));
      const changed=await review(p);assert.equal(changed.mode,'review');assert.equal(changed.historyReview,undefined);
      assert.equal(changed.historyReviewAssessment.code,'FIRST_SYNC_REVIEW_PROGRESS_CHANGED');
      assert.deepEqual(await scope(p,'name'),receipts);
      await assert.rejects(write(tx=>admission.assertOnClient(tx,config,resumed.observation,resumed.first.historyAdmission)),
        {code:'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED'});
    });
    await t.test('captured admission rechecks new jobs and media instead of relying on earlier eligibility',async()=>{
      const p=products[8];await admit(p);
      await commit(await reviewed(p,{size:'18',en:'Remote EN'}));
      const inspected=await service.inspect(config,await observation(p,{size:'18',en:'Remote EN'}),options),state=await capture(p);
      const intent={mode:'update',operations:[]},jobId=randomUUID();
      await db.query(`INSERT INTO magento_sync_jobs(id,product_id,public_product_identity_id,sku,installation_key,origin_hash,
        binding_revision_id,binding_hash,amber_hash,plan_hash,intent,baseline,created_by_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'{}',$12)`,
      [jobId,p.id,p.public_product_identity_id,p.full_sku,binding.installationKey,binding.originHash,binding.id,state.bindingHash,state.amberHash,c.hash(intent),JSON.stringify(intent),actor]);
      await assert.rejects(write(tx=>admission.assertOnClient(tx,config,inspected.observation,inspected.first.historyAdmission)),
        {code:'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED'});
      await write(tx=>admission.assertOnClient(tx,config,inspected.observation,inspected.first.historyAdmission,{jobId}));
      assert.equal((await review(p)).historyReview,undefined);
      const pending=inspected,mediaId=randomUUID();
      await db.query(`INSERT INTO product_media_jobs(id,product_id,public_product_identity_id,version,photo_ids,enable_when_verified,
        actor_user_id,request_key,required_permission,intent_hash) VALUES($1,$2,$3,1,'{}',FALSE,$4,$5,'products.create',$6)`,
      [mediaId,p.id,p.public_product_identity_id,actor,randomUUID(),c.hash(mediaId)]);
      await assert.rejects(write(tx=>admission.assertOnClient(tx,config,pending.observation,pending.first.historyAdmission,{jobId})),
        {code:'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED'});
      assert.equal((await review(p)).mode,'review');
    });
    await t.test('omitting the original root from a later progress command cannot advance the ledger',async()=>{
      const p=products[9];await admit(p);await commit(await reviewed(p,{size:'18',en:'Remote EN'}));
      const s=await session(p),prior=(await db.query('SELECT command FROM magento_first_sync_progress WHERE session_id=$1 AND revision=1',[s.id])).rows[0].command;
      const command={...prior,expectedRevision:s.revision,previewHash:c.hash('missing admission root')};delete command.historyAdmissionEventId;
      const before=await snapshot();await assert.rejects(write(tx=>require('../src/services/magento/first-sync-ledger').recordProgressOnClient(tx,command)),{code:'FIRST_SYNC_LEDGER_IDENTITY'});
      assert.equal(await snapshot(),before);
    });
    await t.test('a new retained CSV cancels captured admission for the exact SKU without indexed membership',async()=>{
      const p=products[10],id=randomUUID();
      await admit(p);
      const captured=await service.inspect(config,await observation(p,{size:'18',en:'Remote EN'}),options);
      assert.equal(captured.mode,'first');assert.ok(captured.first.historyAdmission);
      await write(tx=>tx.query(`INSERT INTO export_snapshots(id,idempotency_key,from_sku,to_sku,resolved_to_sku,exported_to_product_id,
        row_count,file_name,csv_content,status) VALUES($1,$1,$2,$2,$2,$3,1,'legacy.csv',$4,'generated')`,
      [id,p.full_sku,p.id,`sku,price_uah\r\n${p.full_sku},42\r\n`]));
      assert.equal((await db.query('SELECT count(*)::int n FROM export_snapshot_products WHERE product_id=$1',[p.id])).rows[0].n,0);
      const before=await snapshot(),plan=await review(p);assert.equal(plan.mode,'review');assert.equal(plan.historyReview,undefined);assert.equal(await snapshot(),before);
      assert.equal(plan.historyReviewAssessment.code,'FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED');
      assert.equal(plan.historyReviewAssessment.legacySnapshotFlag,true);
      await assert.rejects(write(tx=>admission.assertOnClient(tx,config,captured.observation,captured.first.historyAdmission)),
        {code:'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED'});
      assert.equal(await snapshot(),before);
    });
    await t.test('malformed unindexed retained bytes block flag-only admission even with no target membership',async()=>{
      const p=products[12],id=randomUUID();
      await write(tx=>tx.query(`INSERT INTO export_snapshots(id,idempotency_key,from_sku,to_sku,resolved_to_sku,exported_to_product_id,
        row_count,file_name,csv_content,status) VALUES($1,$1,$2,$2,$2,$3,1,'unknown.csv',$4,'generated')`,
      [id,p.full_sku,p.id,'sku,price_uah\r\n"UNKNOWN,42']));
      assert.equal((await db.query('SELECT count(*)::int n FROM export_snapshot_products WHERE product_id=$1',[p.id])).rows[0].n,0);
      const before=await snapshot(),plan=await review(p);assert.equal(plan.mode,'review');assert.equal(plan.historyReview,undefined);
      assert.equal(plan.historyReviewAssessment.code,'FIRST_SYNC_RETAINED_FILES_UNRESOLVED');
      assert.equal(plan.historyReviewAssessment.legacySnapshotFlag,true);assert.equal(await snapshot(),before);
    });
    await t.test('a duplicate approval or incomplete canonical chain cannot offer a history admission',async()=>{
      const approval=(await db.query("SELECT * FROM audit_events WHERE event_key='full_product_cutover.approved'")).rows[0];
      await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id,details)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[approval.event_key,actor,approval.actor_snapshot,approval.subject_type,approval.subject_id,randomUUID(),approval.details]);
      const p=products[7],before=await snapshot(),plan=await review(p);assert.equal(plan.mode,'review');assert.equal(plan.historyReview,undefined);assert.equal(await snapshot(),before);
    });
    assert.ok(calls.every(c=>c.method==='GET'));
  } finally {
    if(db)await db.end();
    if(created)await control.query('DROP DATABASE '+name);
    await control.end();
  }
});
