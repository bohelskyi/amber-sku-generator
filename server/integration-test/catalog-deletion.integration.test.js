// Standalone disposable integration test; no shared database reset or live HTTP.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
require('../test/setup-env');
const service = require('../src/services/catalog/catalog-deletion.service');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');
const fixture = require('../test/fixtures/magento-v4');
const { REQUIRED } = require('../src/services/export-templates/column-contract');
const serverRoot = path.resolve(__dirname,'..');
const config = {configured:true,baseUrl:'https://catalog-delete.invalid',consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
const remoteAttribute = {attribute_id:6001,attribute_code:'shade',frontend_input:'select',is_user_defined:true,is_required:false,source_model:'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table',backend_model:null,default_value:'',default_frontend_label:'Shade'};
function remote(db,{lost=false,remoteOnly=false}={}) {
  const observedAttribute = remoteOnly ? {...remoteAttribute,attribute_code:'test_fixture',default_frontend_label:'TEST fixture'} : remoteAttribute;
  let removed=false; let removesAttribute=false; let deletes=0; let pair=false; let waiters=[];
  return {get deletes(){return deletes;},pairReads(){pair=true;},fetch:async(url,init)=>{
    const pathname=new URL(url).pathname;
    if(init.method==='DELETE') {
      const rows=(await db.query(remoteOnly?"SELECT state FROM magento_remote_catalog_deletions WHERE state='dispatched'":
        "SELECT state FROM magento_configuration_actions WHERE kind IN ('attribute_delete','option_delete') AND state='dispatched'")).rows;
      assert.equal(rows.length,1,'dispatch evidence is committed and visible on independent connection');
      removed=true; removesAttribute=!pathname.includes('/options/'); deletes++;
      if(lost) throw new Error('Lost fixture response'); return Response.json(true);
    }
    assert.equal(init.method,'GET');
    if(pathname.endsWith('/store/storeViews')) return Response.json([{id:0,code:'admin',is_active:true},{id:1,code:'en',is_active:true}]);
    if(pathname.endsWith('/products/attributes')) {
      const observed={items:removesAttribute?[]:[observedAttribute],total_count:removesAttribute?0:1};
      if(pair) await new Promise(resolve=>{ waiters.push(resolve); if(waiters.length===2) { pair=false; const current=waiters; waiters=[]; current.forEach(done=>done()); } });
      return Response.json(observed);
    }
    if(pathname.endsWith('/'+observedAttribute.attribute_code+'/options')) return Response.json([...(removed?[]:[{value:'701',label:'Blue'}]),{value:'702',label:'Red'}]);
    if(pathname.endsWith('/products')) return Response.json({items:[],total_count:0});
    if(pathname.endsWith('/products/attribute-sets/sets/list')) return Response.json({items:[{attribute_set_id:8001,attribute_set_name:'Set'}],total_count:1});
    if(pathname.endsWith('/products/attribute-sets/8001/attributes')) return Response.json(removesAttribute?[]:[observedAttribute]);
    throw new Error(`Unexpected fixture path ${pathname}`);
  }};
}
async function context(db,key,remoteOnly=false) {
  const attributeCode=remoteOnly?'test_fixture':'shade',attributeLabel=remoteOnly?'TEST fixture':'Shade';
  const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Catalog deletion test administrator') RETURNING id")).rows[0].id);
  await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
  const options={databasePool:db,mutationContext:{actorUserId:actor}};
  await db.query("INSERT INTO categories(code,name) VALUES($1,'Deletion fixture')",[key]);
  const question=(await db.query("INSERT INTO questions(category_code,key,label,required,include_in_sku) VALUES($1,$2,$3,0,0) RETURNING id",[key,attributeCode,attributeLabel])).rows[0];
  const selected=(await db.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,0,'0','Blue') RETURNING id",[question.id])).rows[0];
  const remaining=(await db.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,1,'1','Red') RETURNING id",[question.id])).rows[0];
  const definition=fixture.definition(); definition.sources={sku:definition.sources.sku}; definition.tables={}; definition.questionContracts={};
  for(const group of definition.groups) { group.columns=[...REQUIRED]; for(const row of group.rows) { delete row.cells.kolir; delete row.cells.new_note; row.cells.price={op:'literal',value:'42'}; } }
  const family=await templates.createTemplate({key:`delete-${key.toLowerCase()}`,displayName:'Deletion fixture',definition},options);
  const published=await templates.publishTemplate(family.id,{expectedRevision:family.draft.revision,expectedDefinitionHash:family.draft.definitionHash},options);
  const schema=fixture.observation(); schema.attributes.push({...remoteAttribute,attribute_code:attributeCode,default_frontend_label:attributeLabel,options:[{value:'701',label:'Blue'},{value:'702',label:'Red'}]});
  const revision=await bindings.createDraft({installationKey:`delete-${key.toLowerCase()}`,origin:config.baseUrl,templateVersionId:published.id,observedAt:'2026-10-05T00:00:00Z',schema},options);
  const request={bindingRevisionId:revision.id,expectedRevision:revision.revision,type:'option',questionId:String(question.id),optionId:String(selected.id),attributeCode,attributeId:6001,remoteOptionId:'701'};
  return {options,request,question,selected,remaining,category:key};
}
function approval(review,request) { return {...request,previewToken:review.previewToken,confirmationText:review.confirmationText,reason:'Reviewed unused fixture',
  ackBothCatalogs:true,ackHistoryPreserved:true,ackExternalDependenciesReviewed:true,ackMagentoMaintenanceWindow:true,ackOrdinaryAttribute:true}; }

test('063 upgrade/restart, durable uncertainty fences, GET-only recovery and exact permanent completion',async()=>{
  const source=process.env.TEST_DATABASE_URL;
  assert.ok(source,'TEST_DATABASE_URL is required for the canonical disposable instance');
  const url=new URL(source); assert.match(url.pathname,/_test$/); assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
  const databaseName='amber_catalog_deletion_workflow_test'; assert.match(databaseName,/^[a-z_]+_test$/);
  const admin=new Client({connectionString:url.toString()}); await admin.connect(); let created=false; let db; let competing;
  try {
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[databaseName])).rowCount,0,'test database must not already exist; never reset shared state');
    await admin.query(`CREATE DATABASE ${databaseName}`); created=true;
    url.pathname=`/${databaseName}`;
    const migrate=()=>{
      const child=spawnSync(process.execPath,['--require','./test/setup-env.js','-e',"require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1})"],
        {cwd:serverRoot,env:{...process.env,DATABASE_URL:url.toString(),NODE_ENV:'test'},encoding:'utf8',timeout:120000,windowsHide:true});
      assert.equal(child.status,0,child.stderr || child.error?.message); return child.stdout;
    };
    assert.match(migrate(),/Applied migration 063_reviewed_catalog_deletion.sql/);
    assert.equal(migrate().includes('Applied migration'),false,'second startup verifies checksums without repeating migration');
    db=new Pool({connectionString:url.toString()});
    const f=await context(db,'XG'); const stub=remote(db,{lost:true}); const options={...f.options,fetchImpl:stub.fetch};
    const review=await service.preview(config,f.request,options); assert.deepEqual(review.blockers,[]);
    competing=new Pool({connectionString:url.toString()}); stub.pairReads();
    const raced=await Promise.allSettled([db,competing].map(databasePool=>service.apply(config,approval(review,f.request),{...options,databasePool})));
    const successful=raced.filter(item=>item.status==='fulfilled'); assert.equal(successful.length,1,'independent callers contend for one resource');
    const uncertain=successful[0].value; assert.equal(uncertain.state,'dispatched');
    assert.equal((await db.query("SELECT 1 FROM magento_configuration_actions WHERE kind='option_delete'")).rowCount,1);
    assert.equal(stub.deletes,1);
    await assert.rejects(db.query('UPDATE options SET label=$1 WHERE id=$2',['Changed',f.remaining.id]),/requires reconciliation/);
    await assert.rejects(db.query('DELETE FROM questions WHERE id=$1',[f.question.id]),/requires reconciliation/);
    await assert.rejects(db.query("INSERT INTO products(full_sku,category,total_price_uah,details) VALUES('XG-test',$1,1,'{\"answers\":{\"shade\":0}}')",[f.category]),/requires reconciliation/);
    await assert.rejects(db.query("UPDATE export_template_drafts SET revision=revision+1"),/pending catalog deletion/);
    const done=await service.reconcile(config,{actionId:uncertain.id},options); assert.equal(done.state,'completed'); assert.equal(stub.deletes,1);
    assert.equal((await db.query('SELECT 1 FROM options WHERE id=$1',[f.selected.id])).rowCount,0);
    assert.equal((await db.query('SELECT 1 FROM options WHERE id=$1',[f.remaining.id])).rowCount,1);
    assert.equal((await db.query('SELECT 1 FROM questions WHERE id=$1',[f.question.id])).rowCount,1);
    await assert.rejects(db.query('DELETE FROM catalog_deletion_completions WHERE action_id=$1',[done.id]),/permanent/);
    await assert.rejects(db.query("UPDATE magento_configuration_actions SET intent='{}' WHERE id=$1",[done.id]),/immutable/);
    await assert.rejects(db.query("INSERT INTO products(full_sku,category,total_price_uah,details) VALUES('XG-reuse',$1,1,'{\"answers\":{\"shade\":0}}')",[f.category]),/permanently removed catalog value/);
    const audit=(await db.query("SELECT event_key FROM audit_events WHERE subject_id=$1 ORDER BY id",[done.id])).rows.map(row=>row.event_key);
    assert.deepEqual(audit,['catalog.full_delete.sealed','catalog.full_delete.dispatched','catalog.full_delete.absence_observed','catalog.full_delete.remote_verified','catalog.full_delete.completed']);
    const completedAgain=await service.apply(config,approval(review,f.request),options); assert.equal(completedAgain.state,'completed'); assert.equal(stub.deletes,1);
    // Independent full-question case proves cascaded option guards allow only the
    // exact verified action, with no mutation of the prior completed evidence.
    const full=await context(db,'YG'); const fullRemote=remote(db); const fullOptions={...full.options,fetchImpl:fullRemote.fetch};
    const fullRequest={...full.request,type:'question',optionId:null,remoteOptionId:null}; const fullReview=await service.preview(config,fullRequest,fullOptions);
    const fullDone=await service.apply(config,approval(fullReview,fullRequest),fullOptions);
    assert.equal(fullDone.state,'completed'); assert.equal(fullRemote.deletes,1);
    assert.equal((await db.query('SELECT 1 FROM questions WHERE id=$1',[full.question.id])).rowCount,0);
    assert.equal((await db.query('SELECT 1 FROM options WHERE question_id=$1',[full.question.id])).rowCount,0);
    assert.equal((await db.query('SELECT 1 FROM catalog_deletion_completions')).rowCount,2);
  } finally {
    if(competing) await competing.end();
    if(db) await db.end();
    if(created) await admin.query(`DROP DATABASE ${databaseName}`);
    await admin.end();
  }
});

test('070 remote-only review distinguishes actual use from category membership and retains archived history after uncertain DELETE',async()=>{
 const source=new URL(process.env.TEST_DATABASE_URL);assert.match(source.pathname,/_test$/);assert.ok(['localhost','127.0.0.1'].includes(source.hostname));
 const name='amber_remote_only_cleanup_test',admin=new Client({connectionString:source.toString()});await admin.connect();let created=false,db,competing;
 try{
  assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0);await admin.query(`CREATE DATABASE ${name}`);created=true;source.pathname='/'+name;
  const migration=spawnSync(process.execPath,['--require','./test/setup-env.js','-e',"require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1})"],{cwd:serverRoot,env:{...process.env,DATABASE_URL:source.toString(),NODE_ENV:'test'},encoding:'utf8',timeout:120000,windowsHide:true});assert.equal(migration.status,0,migration.stderr);
  db=new Pool({connectionString:source.toString()});const f=await context(db,'XG',true),service=require('../src/services/catalog/catalog-remote-deletion.service');
  // Prepare historical references before deletion. The existing migration guard
  // correctly prohibits rebinding a retired ID after verified cleanup.
  const original = await bindings.getRevision(f.request.bindingRevisionId,f.options);
  const unused = await bindings.createDraft({installationKey:original.installationKey,origin:config.baseUrl,
    templateVersionId:original.templateVersionId,observedAt:new Date(original.observedAt).toISOString(),schema:original.schema},f.options);
  const retiredKey = require('../src/services/magento/binding-contract').hash({ fixture: 'retired-resource-publication' });
  assert.equal((await db.query(`UPDATE magento_binding_routes SET enabled=true,review_state='proposed'
    WHERE revision_id=$1 AND route_key='XG:all'`,[original.id])).rowCount,1);
  for(const [row,state] of [['base','proposed'],['english','blocked']]) {
    await db.query(`INSERT INTO magento_binding_attributes (revision_id,binding_key,route_key,row_id,target,strategy,attribute_code,review_state)
      VALUES ($1,$2,'XG:all',$3,'test_fixture','scalar','test_fixture',$4)`,[original.id,row==='base'?retiredKey:require('../src/services/magento/binding-contract').hash({fixture:'blocked-resource'}),row,state]);
  }

  async function createdResource(kind,id,target,extra={}){
   const uuid=require('node:crypto').randomUUID(),c=require('../src/services/magento/binding-contract');
   const intent={kind,target,label:'TEST synthetic fixture',...extra};
   let attestationId = null;
   if (kind === 'option') {
    attestationId = require('node:crypto').randomUUID();
    await db.query(`INSERT INTO magento_option_capability_attestations
      (id,origin_hash,installation_key,attribute_id,attribute_code,metadata_fingerprint,target_hash,target,actor_user_id,evidence)
      VALUES($1,$2,'delete-xg',6001,'test_fixture',$3,$4,$5,$6,'Synthetic ordinary option fixture')`,
      [attestationId,c.originHash(config.baseUrl),c.hash(remoteAttribute),c.hash(target),target,f.options.mutationContext.actorUserId]);
   }
   await db.query(`INSERT INTO magento_configuration_actions(id,kind,origin_hash,resource_key,binding_revision_id,binding_revision,actor_user_id,preview_hash,intent,attestation_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[uuid,kind,c.originHash(config.baseUrl),c.hash({kind,id}),f.request.bindingRevisionId,f.request.expectedRevision,f.options.mutationContext.actorUserId,c.hash(intent),intent,attestationId]);
   await db.query("UPDATE magento_configuration_actions SET state='dispatched',dispatched_at=CURRENT_TIMESTAMP WHERE id=$1",[uuid]);
   await db.query("UPDATE magento_configuration_actions SET state='returned',remote_id=$2,returned_at=CURRENT_TIMESTAMP WHERE id=$1",[uuid,String(id)]);
   await db.query("UPDATE magento_configuration_actions SET state='verified',verification='{}',verified_at=CURRENT_TIMESTAMP WHERE id=$1",[uuid]);return uuid;
  }
  await createdResource('attribute',6001,{attributeCode:'test_fixture'});
  for(const [id,valueId] of [[701,'0'],[702,'1']])await createdResource('option',id,{attributeCode:'test_fixture',amberGroup:'XG',questionKey:'test_fixture',valueId},{attributeId:6001});
  await db.query('UPDATE options SET archived=TRUE WHERE question_id=$1',[f.question.id]);
  await db.query('UPDATE questions SET archived=TRUE WHERE id=$1',[f.question.id]);
  const unrelated=(await require('./product-fixture').insertProductFixture(db,"INSERT INTO products(full_sku,category,total_price_uah,details) VALUES('XG-UNRELATED','XG',100,'{\"answers\":{\"unrelated\":7}}') RETURNING *")).rows[0];
  const stub=remote(db,{lost:true,remoteOnly:true});let remoteUse=false;let foreignScopedOption=false;
  const options={...f.options,fetchImpl:async(url,init)=>foreignScopedOption&&init.method==='GET'&&new URL(url).pathname==='/rest/en/V1/products/attributes/test_fixture/options'
   ?Response.json([{value:'701',label:'Blue'},{value:'702',label:'Red'},{value:'703',label:'Foreign scoped option'}]):remoteUse&&init.method==='GET'&&new URL(url).pathname==='/rest/en/V1/products'
   ?Response.json({items:[{id:9999,sku:'REAL-FIXTURE'}],total_count:1}):stub.fetch(url,init)};
  let review=await service.preview(config,f.request,options);assert.deepEqual(review.blockers,[]);assert.deepEqual(review.affected.products,[]);
  assert.equal(review.localTarget.valueId,0);assert.deepEqual(review.remote.scopes,[{id:0,code:'all'},{id:1,code:'en'}]);
  // Rollback-only fixture states demonstrate real dependency detection without
  // deleting or rewriting any retained product history to make apply pass.
  const connection=await db.connect();
  try{
   await connection.query('BEGIN');
   await connection.query("UPDATE questions SET label='Ordinary business attribute' WHERE id=$1",[f.question.id]);
   assert.ok((await service.preview(config,f.request,{...options,databasePool:connection})).blockers.includes('REMOTE_ONLY_TEST_NAMESPACE_REQUIRED'));
   await connection.query('ROLLBACK');await connection.query('BEGIN');
   await require('./product-fixture').insertProductFixture(connection,"INSERT INTO products(full_sku,category,total_price_uah,details) VALUES('XG-ZERO','XG',100,'{\"answers\":{\"test_fixture\":0}}') RETURNING *");
   const used=await service.preview(config,f.request,{...options,databasePool:connection});assert.ok(used.blockers.includes('LOCAL_PRODUCTS_DEPEND_ON_TARGET'));
   await connection.query('ROLLBACK');await connection.query('BEGIN');
   const familyId=(await connection.query('SELECT template_id FROM magento_binding_revisions WHERE id=$1',[f.request.bindingRevisionId])).rows[0].template_id;
   const definition=(await connection.query('SELECT definition FROM export_template_drafts WHERE template_id=$1',[familyId])).rows[0].definition;
   definition.sources.shade={kind:'semantic',category:'XG',key:'test_fixture',type:'scalar',provenance:'supplied-stored-answers-v1',aliases:[]};
   definition.questionContracts.shade={source:'shade',exists:true,required:false,rule:{},allowed:['0','1']};
   definition.groups[0].rows[0].cells.name={op:'text',input:{op:'source',id:'shade'},trim:false,format:'scalar-v1',onAbsent:'empty'};
   const compiled=require('../src/services/export-templates/definition').compileDefinition(definition);
   await connection.query('UPDATE export_template_drafts SET definition=$2,revision=revision+1 WHERE template_id=$1',[familyId,compiled.definition]);
      // Editing a local-only source in an inert draft cannot authorize delivery;
   // remote-only removal keeps that draft and its immutable version intact.
   assert.equal((await service.preview(config,f.request,{...options,databasePool:connection})).blockers.includes('ACTIVE_TEMPLATE_DEPENDENCY'),false);
   await connection.query('ROLLBACK');
  }finally{await connection.query('ROLLBACK');connection.release();}
  remoteUse=true;const usedRemote=await service.preview(config,f.request,options);assert.ok(usedRemote.blockers.includes('MAGENTO_PRODUCTS_DEPEND_ON_TARGET'));remoteUse=false;
  foreignScopedOption=true;
  const foreignReview=await service.preview(config,{...f.request,type:'question',optionId:null,remoteOptionId:null},options);
  assert.ok(foreignReview.blockers.includes('REMOTE_ONLY_FOREIGN_OPTION'));assert.ok(foreignReview.remote.optionIds.includes('703'));
  foreignScopedOption=false;
  review=await service.preview(config,f.request,options);
  const approved={...f.request,previewToken:review.previewToken,confirmationText:review.confirmationText,reason:'Exact owned fixture only',
   ackRemoteOnly:true,ackHistoryPreserved:true,ackExternalDependenciesReviewed:true,ackMagentoMaintenanceWindow:true,ackOrdinaryAttribute:true};
  for(const ack of ['ackRemoteOnly','ackHistoryPreserved','ackExternalDependenciesReviewed','ackMagentoMaintenanceWindow','ackOrdinaryAttribute']){
   await assert.rejects(service.apply(config,{...approved,[ack]:false},options),{code:'CATALOG_DELETE_CONFIRMATION_REQUIRED'});
  }
  const before=(await db.query('SELECT * FROM options WHERE question_id=$1 ORDER BY id',[f.question.id])).rows;
  competing=new Pool({connectionString:source.toString()});stub.pairReads();
  const race=await Promise.allSettled([db,competing].map(databasePool=>service.apply(config,approved,{...options,databasePool})));
  const successes=race.filter(r=>r.status==='fulfilled');assert.equal(successes.length,1);const uncertain=successes[0].value;
  assert.equal(uncertain.state,'dispatched');assert.equal(stub.deletes,1);
  const pendingWhole={...f.request,type:'question',optionId:null,remoteOptionId:null};
  const pendingWholeReview=await service.preview(config,pendingWhole,options);assert.deepEqual(pendingWholeReview.blockers,[]);
  await assert.rejects(service.apply(config,{...approved,...pendingWhole,previewToken:pendingWholeReview.previewToken,
    confirmationText:pendingWholeReview.confirmationText},options),{code:'CATALOG_DELETE_PENDING_CONFIGURATION'});
  assert.equal(stub.deletes,1,'whole-attribute DELETE cannot follow an unresolved option DELETE');
  const pending=(await db.query('SELECT * FROM magento_remote_catalog_deletions WHERE id=$1',[uncertain.id])).rows[0];
  await assert.rejects(db.query(`INSERT INTO magento_remote_catalog_deletions(id,kind,origin_hash,resource_key,binding_revision_id,binding_revision,actor_user_id,preview_hash,intent,creation_action_id)
    SELECT $1,kind,origin_hash,$2,binding_revision_id,binding_revision,actor_user_id,preview_hash,$3::jsonb,creation_action_id
    FROM magento_remote_catalog_deletions WHERE id=$4`,[require('node:crypto').randomUUID(),'f'.repeat(64),
    JSON.stringify({...pending.intent,command:{...pending.intent.command,target:{...pending.intent.command.target,optionId:'702'}}}),uncertain.id]),
    error=>error.code==='23505'&&error.constraint==='remote_catalog_one_pending_attribute');

  await assert.rejects(db.query('UPDATE options SET label=$2 WHERE id=$1',[f.remaining.id,'Changed']),/requires reconciliation/);
  await assert.rejects(db.query('UPDATE export_template_drafts SET revision=revision+1'),/pending remote deletion/);
  assert.equal((await service.apply(config,approved,options)).id,uncertain.id);assert.equal(stub.deletes,1);
  const done=await service.reconcile(config,{actionId:uncertain.id},options);assert.equal(done.state,'completed');assert.equal(done.localDeleted,false);assert.equal(done.remoteAbsent,true);
  assert.deepEqual((await db.query('SELECT * FROM options WHERE question_id=$1 ORDER BY id',[f.question.id])).rows,before);
  assert.deepEqual((await db.query('SELECT * FROM products WHERE id=$1',[unrelated.id])).rows[0],unrelated);
  await assert.rejects(db.query('DELETE FROM options WHERE id=$1',[f.selected.id]),/retains archived/);
  await assert.rejects(db.query("UPDATE magento_remote_catalog_deletions SET state='sealed' WHERE id=$1",[done.id]),/immutable/);
  await assert.rejects(require('./product-fixture').insertProductFixture(db,"INSERT INTO products(full_sku,category,total_price_uah,details) VALUES('XG-REUSE','XG',100,'{\"answers\":{\"test_fixture\":0}}') RETURNING *"),/invalid for future products/);
  await db.query('UPDATE questions SET archived=TRUE WHERE id=$1',[f.question.id]);await db.query('UPDATE options SET archived=TRUE WHERE id=$1',[f.remaining.id]);
  const whole={...f.request,type:'question',optionId:null,remoteOptionId:null},wholeReview=await service.preview(config,whole,options);assert.deepEqual(wholeReview.blockers,[]);
  const fullResult=await service.apply(config,{...approved,...whole,previewToken:wholeReview.previewToken,confirmationText:wholeReview.confirmationText},options);
  assert.equal(fullResult.state,'dispatched');assert.equal(stub.deletes,2);
  assert.equal((await service.reconcile(config,{actionId:fullResult.id},options)).state,'completed');assert.equal(stub.deletes,2);
    // Cleanup history alone does not poison unrelated frozen observations.
    // Actual enabled bindings to the exact retired attribute must block publication.
    const retired = require('../src/services/magento/retired-catalog-targets');
    const originHash = require('../src/services/magento/binding-contract').originHash(config.baseUrl);
    const draftId = f.request.bindingRevisionId;
    assert.equal((await retired.read(db, originHash, [unused.id])).get(unused.id).publicationBlocked, false);
    const tx = await db.connect(); await tx.query('BEGIN');
    try {
      const found = (await retired.read(tx, originHash, [draftId])).get(draftId);
      assert.equal(found.publicationBlocked, true);
      assert.equal(found.resources.length, 1); assert.equal(found.resources[0].attributeId, '6001');
      assert.equal(found.resources[0].attributeCode, 'test_fixture'); assert.equal(found.resources[0].optionId, null);
      assert.throws(() => retired.assertAvailable({ catalogAvailability: found }), { code: 'MAGENTO_BINDING_RETIRED_RESOURCE' });
      assert.equal((await retired.read(tx, '0'.repeat(64), [draftId])).get(draftId).publicationBlocked, false);
      await tx.query(`UPDATE magento_binding_routes SET enabled=false WHERE revision_id=$1`, [draftId]);
      assert.equal((await retired.read(tx, originHash, [draftId])).get(draftId).publicationBlocked, false);
    } finally { await tx.query('ROLLBACK'); tx.release(); }

  assert.equal((await db.query('SELECT archived FROM questions WHERE id=$1',[f.question.id])).rows[0].archived,true);
  assert.equal((await db.query('SELECT count(*)::int n FROM options WHERE question_id=$1',[f.question.id])).rows[0].n,2);
  // Empty optional answers do not depend on the removed remote target. Other
  // product fields remain writable; semantic zero was separately refused above.
  for(const value of [null,'']){
   const blank=(await require('./product-fixture').insertProductFixture(db,
    `INSERT INTO products(full_sku,category,total_price_uah,details) VALUES($1,'XG',100,$2::jsonb) RETURNING *`,
    ['XG-BLANK-'+(value===null?'NULL':'TEXT'),JSON.stringify({answers:{test_fixture:value}})])).rows[0];
   const edit=await db.connect(),gate=require('../src/services/full-product-cutover-gate');
   try { await gate.begin(edit);await edit.query('UPDATE products SET total_price_uah=101 WHERE id=$1',[blank.id]);await gate.commit(edit); }
   catch(error){await gate.rollback(edit);throw error;}finally{await gate.release(edit);edit.release();}
   assert.equal(Number((await db.query('SELECT total_price_uah FROM products WHERE id=$1',[blank.id])).rows[0].total_price_uah),101);
  }
  await assert.rejects(db.query('DELETE FROM questions WHERE id=$1',[f.question.id]),/retains archived/);
 }finally{if(competing)await competing.end();if(db)await db.end();if(created)await admin.query(`DROP DATABASE ${name}`);await admin.end();}
});
