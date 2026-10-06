const { test,assert,Pool,runNodeInDatabase,recreateTestDatabase,dropTestDatabase } = require('./suite-context');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');
const successor = require('../src/services/magento/integration-successor');
const review = require('../src/services/magento/integration-binding-review');
const fixture = require('../test/fixtures/magento-v4');
const { REQUIRED } = require('../src/services/export-templates/column-contract');

test('official column upgrade and exact TEST field preserve seven routes through actual successor preparation', async () => {
  const name = 'amber_columns_successor_test', url = await recreateTestDatabase(name), db = new Pool({ connectionString: url });
  try {
    await runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Column successor admin') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const options = { databasePool: db, mutationContext: { actorUserId: actor } };
    const f = require('../test/fixtures/magento-test-field').testFieldFixture();
    const { scopeBaseFieldToProductRoute } = require('../src/services/magento/integration-field-scope');
    const definition = scopeBaseFieldToProductRoute(f.definition, f.schema, f.scope);
    for (const g of definition.groups) await db.query('INSERT INTO categories(code,name) VALUES($1,$1)', [g.route]);
    for (const [id, source] of Object.entries(definition.sources)) {
      if (source.kind === 'product') continue;
      const q = (await db.query(`INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required)
        VALUES($1,$2,$2,$3,0,0) RETURNING id`, [source.category, source.key, source.kind === 'semantic' ? 'options' : 'text'])).rows[0];
      const values = [...new Set(Object.values(definition.questionContracts).filter(q => q.source === id).flatMap(q => q.allowed))];
      for (const value of values) await db.query('INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,$2,$3,$3)', [q.id, value, value]);
    }
    async function publishTemplate(d, key) {
      const family = await templates.createTemplate({ key, displayName: key, definition: d }, options);
      return templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    }
    const oldVersion = await publishTemplate(f.old, 'column-old'), nextVersion = await publishTemplate(definition, 'column-next');
    const config = { configured: true, baseUrl: 'https://successor.invalid' };
    const sourceBindings = structuredClone(f.source.bindings);
    for (const route of sourceBindings.routes.filter(r => r.routeKey.startsWith('SV.'))) route.setId = 151;
    let draft = await bindings.createDraft({ installationKey: 'column-successor', origin: config.baseUrl,
      templateVersionId: oldVersion.id, observedAt: new Date().toISOString(), schema: f.schema }, options);
    draft = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: sourceBindings }, options);
    const published = await bindings.publishDraft(draft.id, { expectedRevision: draft.revision, expectedCurrentId: null }, options);
    const before = await bindings.getRevision(published.id, options);
    const remote = { ...options, discover: async () => ({ schema: f.schema, categories: [], observedAt: new Date().toISOString() }),
      fetchImpl: async () => assert.fail('No real Magento request is permitted') };
    const input = { sourceId: published.id, expectedSourceRevision: published.revision, templateVersionId: nextVersion.id, productIds: [] };
    const prepared = await successor.prepare(config, input, remote);
    assert.deepEqual(prepared.blockers, []);
    assert.equal(prepared.bindings.routes.length, 7);
    for (const route of before.bindings.routes) {
      const carried = prepared.bindings.routes.find(r => r.routeKey === route.routeKey);
      assert.equal(carried.reviewState, 'approved'); assert.equal(carried.setId, route.setId);
    }
    for (const kind of ['attributes', 'options', 'policies']) for (const old of before.bindings[kind]) {
      const next = prepared.bindings[kind].find(n => n.bindingKey === old.bindingKey
        && (kind !== 'options' || n.sourceKind === old.sourceKind
          && (old.sourceKind === 'semantic' ? n.sourceKey === old.sourceKey : n.outputKey === old.outputKey)));
      assert.ok(next); assert.equal(next.reviewState, old.reviewState);
      if (kind === 'options') assert.equal(next.optionId, old.optionId);
      if (kind === 'policies') { assert.equal(next.policy, old.policy); assert.equal(next.evidence.createValue, old.evidence.createValue); }
    }
    const additions = prepared.bindings.attributes.filter(a => a.target === f.target);
    assert.equal(additions.length, 1); assert.equal(additions[0].routeKey, f.generalRoute);
    assert.notEqual(additions[0].reviewState, 'approved');
    assert.ok(prepared.bindings.options.filter(o => o.bindingKey === additions[0].bindingKey).every(o => o.reviewState !== 'approved'));
    const successorDraft = await successor.apply(config, { ...input, previewToken: prepared.previewToken }, remote);
    assert.equal(successorDraft.state, 'draft');
    const validation = await bindings.validateDraft(successorDraft.id, options);
    assert.ok(validation.diagnostics.some(d => d.code === 'BINDING_REVIEW_REQUIRED'));
    const preview = await require('../src/services/magento/binding-publication').preview(config,
      { bindingRevisionId: successorDraft.id, expectedRevision: successorDraft.revision, expectedCurrentId: published.id }, remote);
    assert.deepEqual(preview.lostRoutes, []);
    assert.equal(preview.blockers.filter(d => d.code === 'BINDING_REVIEW_REQUIRED').length, 3);
    assert.ok(!preview.blockers.some(d => d.code === 'REPRESENTATIVE_CREATE_REQUIRED'),
      'Equivalent column conversion must not turn seven existing routes into new routes');
    assert.deepEqual(await bindings.getRevision(published.id, options), before);
    assert.equal((await bindings.getCurrentPublished('column-successor', options)).id, published.id);
    for (const version of [oldVersion, nextVersion]) assert.deepEqual(
      (await db.query('SELECT definition,definition_hash FROM export_template_versions WHERE id=$1', [version.id])).rows[0],
      { definition: version.definition, definition_hash: version.definitionHash });
    for (const table of ['products','sku_registry','magento_sync_jobs','magento_product_sync_requests']) {
      assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 0);
    }
  } finally { await db.end(); await dropTestDatabase(name); }
});

test('SV narrow requiredness successor retains unrelated reviewed decisions and policies', async (t) => {
  const name = 'amber_sv_successor_test', url = await recreateTestDatabase(name), db = new Pool({ connectionString: url });
  try {
    await runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','SV admin') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const options = { databasePool: db, mutationContext: { actorUserId: actor } };
    const f = require('../test/fixtures/magento-successor').fixture();
    for (const g of f.old.groups) await db.query('INSERT INTO categories(code,name) VALUES($1,$1)', [g.route]);
    for (const [id, s] of Object.entries(f.old.sources)) {
      if (s.kind === 'product') continue;
      const q = (await db.query(`INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required)
        VALUES($1,$2,$2,$3,0,0) RETURNING id`, [s.category, s.key, s.kind === 'semantic' ? 'options' : 'text'])).rows[0];
      const values = [...new Set(Object.values(f.old.questionContracts).filter(q => q.source === id).flatMap(q => q.allowed))];
      for (const value of values) await db.query('INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,$2,$3,$3)', [q.id, value, value]);
    }
    async function publishTemplate(definition, key) {
      const family = await templates.createTemplate({ key, displayName: key, definition }, options);
      return templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    }
    const oldVersion = await publishTemplate(f.old, 'sv-old'), nextVersion = await publishTemplate(f.next, 'sv-next');
    const config = { configured: true, baseUrl: 'https://successor.invalid' };
    let draft = await bindings.createDraft({ installationKey: 'sv-successor', origin: config.baseUrl,
      templateVersionId: oldVersion.id, observedAt: new Date().toISOString(), schema: f.schema }, options);
    draft = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: f.source.bindings }, options);
    const published = await bindings.publishDraft(draft.id, { expectedRevision: draft.revision, expectedCurrentId: null }, options);
    const before = await bindings.getRevision(published.id, options);
    const remote = { ...options, discover: async () => ({ schema: f.schema, categories: [], observedAt: new Date().toISOString() }),
      fetchImpl: async () => assert.fail('This fixture must never call Magento') };
    const input = { sourceId: published.id, expectedSourceRevision: published.revision, templateVersionId: nextVersion.id, productIds: [] };
    const prepared = await successor.prepare(config, input, remote);
    const count = rows => rows.reduce((counts, row) => ({ ...counts, [row.reviewState]: (counts[row.reviewState] || 0) + 1 }), {});
    const counts = Object.fromEntries(Object.entries(prepared.bindings).map(([kind, rows]) => [kind, count(rows)]));
    t.diagnostic(JSON.stringify(counts));
    assert.deepEqual(counts, { routes: { approved: 7 }, attributes: { approved: 206, proposed: 2 },
      options: { approved: 234, blocked: 15 }, policies: { approved: 206, review_required: 2 } });
    assert.deepEqual(prepared.blockers, []);
    for (const r of before.bindings.routes) assert.deepEqual(
      prepared.bindings.routes.find(n => n.routeKey === r.routeKey).setId, r.setId, r.routeKey);
    assert.ok(prepared.bindings.routes.every(r => r.reviewState === 'approved'));
    for (const a of before.bindings.attributes) {
      const next = prepared.bindings.attributes.find(n => n.bindingKey === a.bindingKey);
      if (a.target === 'rozmir_suveniriv') assert.notEqual(next.reviewState, 'approved');
      else assert.equal(next.reviewState, a.reviewState, `${a.routeKey}/${a.rowId}/${a.target}`);
    }
    for (const p of before.bindings.policies) {
      const a = before.bindings.attributes.find(a => a.bindingKey === p.bindingKey);
      const next = prepared.bindings.policies.find(n => n.bindingKey === p.bindingKey && n.storeCode === p.storeCode);
      if (a.target === 'rozmir_suveniriv') assert.notEqual(next.reviewState, 'approved');
      else { assert.equal(next.reviewState, p.reviewState); assert.equal(next.policy, p.policy); assert.equal(next.evidence.createValue, p.evidence.createValue); }
    }
    for (const o of before.bindings.options) {
      const next = prepared.bindings.options.find(n => n.bindingKey === o.bindingKey && n.sourceKind === o.sourceKind
        && (o.sourceKind === 'semantic' ? n.sourceKey === o.sourceKey : n.outputKey === o.outputKey));
      assert.equal(next.reviewState, o.reviewState, o.sourceKey);
      assert.equal(next.optionId, o.optionId);
      if (o.sourceKind === 'evaluated') assert.notEqual(next.domainKey, o.domainKey, 'target retains its own immutable output domain');
    }
    const successorDraft = await successor.apply(config, { ...input, previewToken: prepared.previewToken }, remote);
    assert.equal(successorDraft.state, 'draft'); assert.equal(successorDraft.revision, '1');
    assert.equal(successorDraft.templateVersionId, nextVersion.id);
    const validation = await bindings.validateDraft(successorDraft.id, options);
    const reviews = validation.diagnostics.filter(d => d.code === 'BINDING_REVIEW_REQUIRED');
    t.diagnostic(`remaining binding reviews: ${reviews.length}`);
    assert.equal(reviews.length, 4, JSON.stringify(validation));
    await assert.rejects(bindings.publishDraft(successorDraft.id, { expectedRevision: successorDraft.revision,
      expectedCurrentId: published.id }, options), { code: 'MAGENTO_BINDING_INVALID' });
    const publication = require('../src/services/magento/binding-publication');
    const publicationInput = { bindingRevisionId: successorDraft.id, expectedRevision: successorDraft.revision, expectedCurrentId: published.id };
    const preview = await publication.preview(config, publicationInput, remote);
    assert.equal(preview.blockers.filter(d => d.code === 'BINDING_REVIEW_REQUIRED').length, 4);
    assert.ok(!preview.blockers.some(d => d.code === 'REPRESENTATIVE_CREATE_REQUIRED'), 'size requiredness must not make unchanged SV routes new');
    await assert.rejects(publication.publish(config, { ...publicationInput, previewToken: preview.previewToken }, remote),
      { code: 'MAGENTO_PUBLICATION_STALE' });
    // An abandoned draft neither becomes the carry source nor needs data repair.
    const fresh = await successor.prepare(config, input, remote);
    const regenerated = await successor.apply(config, { ...input, previewToken: fresh.previewToken }, remote);
    assert.notEqual(regenerated.id, successorDraft.id);
    assert.deepEqual(regenerated.bindings, successorDraft.bindings);
    assert.deepEqual(await bindings.getRevision(successorDraft.id, options), successorDraft);
    assert.deepEqual(await bindings.getRevision(published.id, options), before);
    assert.equal((await bindings.getCurrentPublished('sv-successor', options)).id, published.id);
    assert.deepEqual((await db.query('SELECT definition,definition_hash FROM export_template_versions WHERE id=$1', [oldVersion.id])).rows[0],
      { definition: oldVersion.definition, definition_hash: oldVersion.definitionHash });
    assert.deepEqual((await db.query('SELECT definition,definition_hash FROM export_template_versions WHERE id=$1', [nextVersion.id])).rows[0],
      { definition: nextVersion.definition, definition_hash: nextVersion.definitionHash });
  } finally { await db.end(); await dropTestDatabase(name); }
});

async function setup(name) {
  const url = await recreateTestDatabase(name), db = new Pool({connectionString:url});
  await runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
  const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Successor admin') RETURNING id")).rows[0].id);
  await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
  const options={databasePool:db,mutationContext:{actorUserId:actor}};
  await db.query("INSERT INTO categories(code,name,sku_publication_mode) VALUES('XG','New','explicit')");
  const d=fixture.definition();d.sources={sku:d.sources.sku};d.tables={};d.questionContracts={};
  for(const g of d.groups){g.columns=[...REQUIRED];for(const r of g.rows){delete r.cells.kolir;delete r.cells.new_note;r.cells.price={op:'literal',value:'42'};}}
  const f=await templates.createTemplate({key:'successor',displayName:'Successor',definition:d},options);
  const v=await templates.publishTemplate(f.id,{expectedRevision:f.draft.revision,expectedDefinitionHash:f.draft.definitionHash},options);
  const config={configured:true,baseUrl:'https://successor.invalid',consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
  let draft=await bindings.createDraft({installationKey:'successor',origin:config.baseUrl,templateVersionId:v.id,observedAt:'2026-10-02T00:00:00.000Z',schema:fixture.observation()},options);
  draft=await bindings.updateDraft(draft.id,{expectedRevision:draft.revision,bindings:fixture.approvedBindings(d,fixture.observation())},options);
  const published=await bindings.publishDraft(draft.id,{expectedRevision:draft.revision,expectedCurrentId:null},options);
  return {url,db,actor,options,config,d,v,published};
}
test('H3a successor preparation preserves publication, fresh observation, reviewed carry and draft CAS',async()=>{
  const name='amber_successor_preparation_test',f=await setup(name);
  try{
    const observation={schema:fixture.observation(),categories:[],observedAt:'2026-10-02T00:00:00.000Z'};
    const options={...f.options,discover:async()=>observation,fetchImpl:async()=>{throw new Error('Unexpected GET');}};
    const input={sourceId:f.published.id,expectedSourceRevision:f.published.revision,templateVersionId:f.v.id};
    const before=await bindings.getRevision(f.published.id,f.options);
    const prepared=await successor.prepare(f.config,input,options);
    assert.ok(prepared.carried.approvalsCarried>0);
    const next=await successor.apply(f.config,{...input,previewToken:prepared.previewToken},options);
    assert.equal(next.state,'draft');assert.equal(next.schemaFingerprint,before.schemaFingerprint);
    assert.deepEqual(await bindings.getRevision(f.published.id,f.options),before);
    assert.equal((await bindings.getCurrentPublished('successor',f.options)).id,before.id);
    const view=await review.get(f.config,next.id,f.options),route=view.entries.find((e)=>e.kind==='route');
    const chosen=await review.select(f.config,next.id,{expectedRevision:next.revision,binding:route.id,identity:8001},f.options);
    assert.equal(chosen.bindings.routes[0].reviewState,'review_required');
    await assert.rejects(review.decide(f.config,next.id,{expectedRevision:next.revision,binding:route.id,action:'approve',acceptReview:true,reason:'Reviewed set'},f.options),{code:'MAGENTO_BINDING_CONFLICT'});
    const approved=await review.decide(f.config,next.id,{expectedRevision:chosen.revision,binding:route.id,action:'approve',acceptReview:true,reason:'Reviewed set'},f.options);
    assert.equal(approved.bindings.routes[0].reviewState,'approved');
    const other=new Pool({connectionString:f.url});
    try {
      const concurrent=await Promise.allSettled([review.select(f.config,next.id,{expectedRevision:approved.revision,binding:route.id,identity:8001},f.options),
        review.select(f.config,next.id,{expectedRevision:approved.revision,binding:route.id,identity:8001},{...f.options,databasePool:other})]);
      assert.equal(concurrent.filter((r)=>r.status==='fulfilled').length,1);
      assert.equal(concurrent.find((r)=>r.status==='rejected').reason.code,'MAGENTO_BINDING_CONFLICT');
      const final=await bindings.getRevision(next.id,f.options);
      assert.equal(BigInt(final.revision),BigInt(approved.revision)+1n);assert.equal(final.bindings.routes[0].reviewState,'review_required');
    }finally{await other.end();}
    await f.db.query("INSERT INTO categories(code,name,sku_publication_mode) VALUES('ZZ','Changed local evidence','explicit')");
    await assert.rejects(successor.apply(f.config,{...input,previewToken:prepared.previewToken},options),{code:'MAGENTO_SUCCESSOR_PREVIEW_STALE'});
    for(const table of ['products','sku_registry','magento_sync_jobs','magento_product_sync_requests']) assert.equal((await f.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
  }finally{await f.db.end();await dropTestDatabase(name);}
});
test('H3a new Amber category stays draft across startup until explicit SKU publication; legacy bootstrap remains',async()=>{
  const name='amber_successor_catalog_test',f=await setup(name);
  try{
    await runNodeInDatabase(f.url,"require('./src/services/catalog/category-commands').createCategory({code:'XX',name:'Future'},{mutationContext:{actorUserId:"+f.actor+"}}).finally(()=>require('./src/db/pool').end());");
    assert.equal((await f.db.query("SELECT sku_publication_mode FROM categories WHERE code='XX'")).rows[0].sku_publication_mode,'explicit');
    await runNodeInDatabase(f.url,"require('./src/services/catalog/category-commands').updateCategory({code:'XX',next_code:'XZ',name:'Renamed draft'},{mutationContext:{actorUserId:"+f.actor+"}}).finally(()=>require('./src/db/pool').end());");
    assert.equal((await f.db.query("SELECT sku_publication_mode FROM categories WHERE code='XZ'")).rows[0].sku_publication_mode,'explicit','renaming an unused category must retain the explicit publication boundary');
    await runNodeInDatabase(f.url,"require('./src/services/catalog/category-commands').updateCategory({code:'XZ',next_code:'XX',name:'Future'},{mutationContext:{actorUserId:"+f.actor+"}}).finally(()=>require('./src/db/pool').end());");
    await f.db.query("INSERT INTO categories(code,name) VALUES('YY','Legacy')");
    for(const code of ['XX','YY']){
      const q=(await f.db.query("INSERT INTO questions(category_code,key,label,sku_index,input_type,include_in_sku,required) VALUES($1,'kind','Kind',1,'options',1,1) RETURNING id",[code])).rows[0].id;
      await f.db.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,8,'8','New')",[q]);
    }
    await runNodeInDatabase(f.url,"require('./src/services/sku-schema.service').ensureLegacySkuSchemas().finally(()=>require('./src/db/pool').end());");
    assert.equal((await f.db.query("SELECT count(*)::int n FROM sku_schema_versions WHERE category_code='XX'")).rows[0].n,0);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM sku_schema_versions WHERE category_code='YY'")).rows[0].n,1);
    await runNodeInDatabase(f.url,"require('./src/services/sku-schema.service').publishSkuSchema('XX',{mutationContext:{actorUserId:"+f.actor+"}}).finally(()=>require('./src/db/pool').end());");
    assert.equal((await f.db.query("SELECT count(*)::int n FROM sku_schema_versions WHERE category_code='XX'")).rows[0].n,1);
  }finally{await f.db.end();await dropTestDatabase(name);}
});
