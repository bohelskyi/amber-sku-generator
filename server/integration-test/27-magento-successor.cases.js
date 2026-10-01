const { test,assert,Pool,runNodeInDatabase,recreateTestDatabase,dropTestDatabase } = require('./suite-context');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');
const successor = require('../src/services/magento/integration-successor');
const review = require('../src/services/magento/integration-binding-review');
const fixture = require('../test/fixtures/magento-v4');
const { REQUIRED } = require('../src/services/export-templates/column-contract');
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
