const { test } = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/catalog/catalog-deletion.service');
const transport = require('../src/services/magento/catalog-delete-transport');
const { mentions } = require('../src/services/catalog/catalog-deletion-impact');
const c = require('../src/services/magento/binding-contract');

const config = {configured:true,baseUrl:'https://fixture.invalid',consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
const request = {bindingRevisionId:'00000000-0000-0000-0000-000000000001',expectedRevision:'1',type:'option',questionId:'10',optionId:'20',attributeCode:'shade',attributeId:6001,remoteOptionId:'701'};
const attribute = {attribute_id:6001,attribute_code:'shade',frontend_input:'select',is_user_defined:true,is_required:false,source_model:'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table',backend_model:null,default_value:'',default_frontend_label:'Shade'};
const result = rows => ({rows,rowCount:rows.length});
class Database {
  constructor() {
    this.admin=true; this.active=true; this.question={id:10,category_code:'AA',key:'shade',label:'Shade',input_type:'options'};
    this.options=[{id:20,question_id:10,value_id:0,label:'Blue',sku_code:'0',archived:false},{id:21,question_id:10,value_id:1,label:'Red',sku_code:'1',archived:false}];
    this.products=[]; this.actions=[]; this.completions=[]; this.queries=[]; this.rules=[]; this.schemas=[{id:1,version:1,question_key:'shade'}];
  }
  async connect() { return this; }
  release() {}
  async query(sql,values=[]) {
    this.queries.push(sql);
    if(sql.includes('SELECT u.status')) return result([{status:this.active?'active':'disabled',has_permission:this.active}]);
    if(sql.includes("r.role_key='administrator'")) return result(this.admin ? [{one:1}] : []);
    if(sql.includes('SELECT display_name')) return result([{display_name:'Fixture Admin',preferred_username:'admin'}]);
    if(sql.includes("to_regclass('full_product_export_activation')")) return result([{present:false}]);
    if(sql.includes('SELECT id,revision,origin_hash,installation_key FROM magento_binding_revisions')) return result([{id:request.bindingRevisionId,revision:'1',origin_hash:c.originHash(config.baseUrl),installation_key:'fixture'}]);
    if(sql.includes('SELECT attribute_id FROM magento_binding_schema_attributes')) return result([{attribute_id:6001}]);
    if(sql.startsWith('SELECT * FROM questions')) return result(this.question ? [this.question] : []);
    if(sql.startsWith('SELECT * FROM options')) return result(this.options);
    if(sql.includes('SELECT id,full_sku,status,details FROM products')) return result(this.products);
    if(sql.includes("SELECT 'scenario' AS type")) return result([]);
    if(sql.includes("SELECT 'question' AS type")) return result(this.rules);
    if(sql.includes('SELECT template_id AS id')) return result([]);
    if(sql.includes('SELECT DISTINCT r.id')) return result([]);
    if(sql.includes('SELECT revision_id,binding_key')) return result([]);
    if(sql.includes('SELECT v.id,v.version')) return result(this.schemas);
    if(sql.includes('FROM catalog_deletion_completions WHERE')) return result(this.completions.filter(item=>item.action_id===values[0]));
    if(sql.includes('SELECT id FROM magento_configuration_actions')) return result(this.actions.filter(row=>['sealed','dispatched','returned'].includes(row.state)).map(row=>({id:row.id})));
    if(sql.startsWith('SELECT * FROM magento_configuration_actions')) {
      if(sql.includes('WHERE id=$1')) return result(this.actions.filter(row=>row.id===values[0]));
      if(sql.includes('resource_key=$3')) return result(this.actions.filter(row=>row.origin_hash===values[0] && row.kind===values[1] && row.resource_key===values[2]));
      return result(this.actions);
    }
    if(sql.includes('INSERT INTO magento_configuration_actions')) {
      const row={id:values[0],kind:values[1],origin_hash:values[2],resource_key:values[3],binding_revision_id:values[4],binding_revision:values[5],actor_user_id:values[6],preview_hash:values[7],intent:JSON.parse(values[8]),state:'sealed',created_at:'2026-10-05T00:00:00Z'};
      this.actions.push(row); return result([row]);
    }
    if(sql.startsWith('UPDATE magento_configuration_actions')) {
      const row=this.actions.find(item=>item.id===values[0]); row.state=sql.match(/SET state='([^']+)'/)[1];
      if(row.state==='returned') row.remote_id=values[1];
      if(row.state==='verified') row.verification=JSON.parse(values[1]);
      return result([row]);
    }
    if(sql.startsWith('DELETE FROM options')) { const found=this.options.filter(item=>String(item.id)===values[0]); this.options=this.options.filter(item=>String(item.id)!==values[0]); return result(found); }
    if(sql.startsWith('DELETE FROM questions')) { const found=this.question ? [this.question] : []; this.question=null; this.options=[]; return result(found); }
    if(sql.includes('INSERT INTO catalog_deletion_completions')) { const completion={action_id:values[0],actor_user_id:values[1],completed_at:'2026-10-05T00:00:01Z'}; this.completions.push(completion); return result([completion]); }
    if(sql.includes('INSERT INTO audit_events')) return result([{id:1,occurred_at:'2026-10-05T00:00:00Z'}]);
    if(/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|LOCK TABLE|SELECT pg_advisory|SELECT set_config)/.test(sql)) return result([]);
    throw new Error(`Unexpected mocked query: ${sql}`);
  }
}
function fixture({loss='none',productScope=null,sets=1,changed=false,response=true,omitBackendModel=false}={}) {
  const remoteAttribute={...attribute}; if(omitBackendModel) delete remoteAttribute.backend_model;
  const db=new Database(); const calls=[]; let removed=false; let attributeRemoved=false;
  const fetchImpl=async(url,options)=>{
    const parsed=new URL(url); calls.push({url:parsed,method:options.method,redirect:options.redirect});
    assert.equal(parsed.origin,config.baseUrl); assert.equal(options.redirect,'manual');
    assert.match(options.headers.Authorization,/^OAuth /);
    if(options.method==='DELETE') {
      if(loss!=='before') { removed=true; if(!parsed.pathname.includes('/options/')) attributeRemoved=true; }
      assert.ok(db.actions.length===1 && db.actions[0].state==='dispatched','committed dispatch marker precedes remote DELETE');
      if(loss!=='none') throw new Error('Fixture lost network response');
      return Response.json(response);
    }
    assert.equal(options.method,'GET');
    if(parsed.pathname.endsWith('/store/storeViews')) return Response.json([{id:1,code:'ua',is_active:true},{id:2,code:'en',is_active:true}]);
    if(parsed.pathname.endsWith('/products/attributes')) return Response.json({items:attributeRemoved?[]:[remoteAttribute],total_count:attributeRemoved?0:1});
    if(parsed.pathname.endsWith('/shade/options')) return Response.json([{value:'',label:''},...(!removed?[{value:'701',label:'Blue'}]:[]),{value:'702',label:changed && removed ? 'Changed' : 'Red'}]);
    if(parsed.pathname.endsWith('/products')) {
      const present=productScope && parsed.pathname.includes(`/rest/${productScope}/`);
      return Response.json({items:present?[{id:901,sku:'AG-000901'}]:[],total_count:present?1:0});
    }
    if(parsed.pathname.endsWith('/products/attribute-sets/sets/list')) return Response.json({items:Array.from({length:sets},(_,i)=>({attribute_set_id:i+1,attribute_set_name:`Set ${i+1}`})),total_count:sets});
    if(/\/products\/attribute-sets\/\d+\/attributes$/.test(parsed.pathname)) return Response.json(attributeRemoved?[]:[remoteAttribute]);
    throw new Error(`Unexpected remote request: ${parsed.pathname}`);
  };
  return {db,calls,options:{databasePool:db,mutationContext:{actorUserId:1},fetchImpl}};
}
function approval(review,overrides={}) {
  return {...request,previewToken:review.previewToken,confirmationText:review.confirmationText,reason:'Unused reviewed fixture',
    ackBothCatalogs:true,ackHistoryPreserved:true,ackExternalDependenciesReviewed:true,ackMagentoMaintenanceWindow:true,ackOrdinaryAttribute:true,...overrides};
}
test('exact option preview preserves semantic zero and exposes immutable history plus every active store scope',async()=>{
  const f=fixture(); const review=await service.preview(config,request,f.options);
  assert.deepEqual(review.blockers,[]); assert.equal(review.localTarget.valueId,0);
  assert.equal(review.futureSkuPublicationRequired,true); assert.equal(review.externalDependenciesAutomaticallyVerified,false);
  assert.match(review.confirmationText,/value_id:0/); assert.deepEqual(review.remote.scopes.map(item=>item.code),['all','ua','en']);
  assert.equal(f.calls.every(item=>item.method==='GET'),true); assert.equal(f.db.actions.length,0);
});
test('one option DELETE is signed, dispatched once, verified in all stores and deletes only the exact local option',async()=>{
  const f=fixture(); const review=await service.preview(config,request,f.options); const input=approval(review);
  const done=await service.apply(config,input,f.options);
  assert.equal(done.state,'completed'); assert.equal(done.localDeleted,true); assert.equal(done.remoteAbsent,true);
  assert.ok(f.db.question); assert.deepEqual(f.db.options.map(item=>item.id),[21]); assert.deepEqual(f.db.schemas,[{id:1,version:1,question_key:'shade'}]);
  assert.equal(f.calls.filter(item=>item.method==='DELETE').length,1);
  assert.equal(f.calls.find(item=>item.method==='DELETE').url.pathname,'/rest/all/V1/products/attributes/shade/options/701');
  const before=f.calls.length; assert.equal((await service.apply(config,input,f.options)).state,'completed'); assert.equal(f.calls.length,before,'identical replay does not issue any network request');
  assert.equal(f.db.completions.length,1);
});
test('lost DELETE response records uncertainty; restart reconciles using GET only before exact local completion',async()=>{
  const f=fixture({loss:'after'}); const review=await service.preview(config,request,f.options);
  const uncertain=await service.apply(config,approval(review),f.options);
  assert.equal(uncertain.state,'dispatched'); assert.equal(uncertain.localDeleted,false); assert.equal(f.db.options.length,2);
  assert.equal(uncertain.reconciliationRequired,true);
  const done=await service.reconcile(config,{actionId:uncertain.id},f.options);
  assert.equal(done.state,'completed'); assert.equal(f.calls.filter(item=>item.method==='DELETE').length,1);
});
test('lost request before remote delete never deletes locally or resends during reconcile',async()=>{
  const f=fixture({loss:'before'}); const review=await service.preview(config,request,f.options);
  const uncertain=await service.apply(config,approval(review),f.options);
  await assert.rejects(service.reconcile(config,{actionId:uncertain.id},f.options),{code:'CATALOG_DELETE_REMOTE_STILL_PRESENT'});
  assert.equal(f.db.options.length,2); assert.equal(f.calls.filter(item=>item.method==='DELETE').length,1);
});
test('changed remaining option labels cause honest partial-success receipt and retain local value',async()=>{
  const f=fixture({changed:true}); const review=await service.preview(config,request,f.options);
  const receipt=await service.apply(config,approval(review),f.options);
  assert.equal(receipt.localDeleted,false); assert.equal(receipt.reconciliationRequired,true); assert.equal(f.db.options.length,2);
  assert.equal(receipt.blockerCode,'CATALOG_DELETE_REMOTE_STILL_PRESENT');
});
test('historical category products and shared sets block before any dispatch',async()=>{
  const f=fixture({sets:2}); f.db.products=[{id:2,full_sku:'AA0',status:'archived',details:{answers:{shade:0}}}];
  const review=await service.preview(config,request,f.options);
  assert.ok(review.blockers.includes('LOCAL_PRODUCTS_DEPEND_ON_CATEGORY')); assert.ok(review.blockers.includes('SHARED_ATTRIBUTE_SETS'));
  await assert.rejects(service.apply(config,approval(review),f.options),{code:'CATALOG_DELETE_BLOCKED'});
  assert.equal(f.db.actions.length,0); assert.equal(f.calls.some(item=>item.method==='DELETE'),false);
});
test('store-specific Magento assignments block option removal even when global scope is empty',async()=>{
  const f=fixture({productScope:'en'}); const review=await service.preview(config,request,f.options);
  assert.ok(review.blockers.includes('MAGENTO_PRODUCTS_DEPEND_ON_TARGET'));
  assert.deepEqual(review.remote.products,[{id:901,sku:'AG-000901',storeCode:'en'}]);
});
test('actual Administrator is rechecked after preview, with no permission grant to Manager',async()=>{
  const f=fixture(); const review=await service.preview(config,request,f.options); f.db.admin=false;
  await assert.rejects(service.apply(config,approval(review),f.options),{statusCode:403,code:'CATALOG_DELETE_ADMINISTRATOR_REQUIRED'});
  assert.equal(f.db.actions.length,0); assert.equal(f.calls.some(item=>item.method==='DELETE'),false);
});
test('every per-action attestation and exact typed confirmation are mandatory',async()=>{
  const f=fixture(); const review=await service.preview(config,request,f.options);
  for(const patch of [{ackBothCatalogs:false},{ackHistoryPreserved:false},{ackExternalDependenciesReviewed:false},{ackMagentoMaintenanceWindow:false},{ackOrdinaryAttribute:false},{confirmationText:'Blue'},{reason:''}]) {
    await assert.rejects(service.apply(config,approval(review,patch),f.options),{code:'CATALOG_DELETE_CONFIRMATION_REQUIRED'});
  }
  assert.equal(f.db.actions.length,0);
});
test('full question scope requires null option IDs and selects the attribute DELETE path',async()=>{
  assert.throws(()=>service.normalize({...request,type:'question'},config));
  const input={...request,type:'question',optionId:null,remoteOptionId:null}; const f=fixture();
  const review=await service.preview(config,input,f.options);
  const done=await service.apply(config,approval(review,input),f.options);
  assert.equal(done.state,'completed'); assert.equal(f.db.question,null); assert.equal(f.db.options.length,0);
  assert.equal(f.calls.find(item=>item.method==='DELETE').url.pathname,'/rest/all/V1/products/attributes/shade');
});
test('Magento omitted null backend_model supports the complete reviewed whole-attribute delete path',async()=>{
  const f=fixture({omitBackendModel:true});
  const input={...request,type:'question',optionId:null,remoteOptionId:null};
  const review=await service.preview(config,input,f.options);
  assert.deepEqual(review.blockers,[]);
  assert.equal(f.calls.some(item=>item.method==='DELETE'),false);
  const done=await service.apply(config,approval(review,input),f.options);
  assert.equal(done.state,'completed'); assert.equal(done.remoteAbsent,true);
  assert.equal(f.calls.filter(item=>item.method==='DELETE').length,1);
  assert.equal(f.calls.find(item=>item.method==='DELETE').url.pathname,'/rest/all/V1/products/attributes/shade');
});

test('omitted backend representation does not authorize malformed or custom backend models',()=>{
  for(const backend_model of [false,0,[],{},' ','Custom\\Backend']) {
    assert.throws(()=>service.ordinary({...attribute,backend_model},{attributeCode:'shade',attributeId:6001,optionId:null},'question'),{code:'CATALOG_DELETE_ATTRIBUTE_UNSUPPORTED'});
  }
});

test('system, required, default-option, custom source and swatch attributes fail closed',()=>{
  for(const patch of [{is_user_defined:false},{is_required:true},{default_value:'701'},{source_model:'Custom\\Source'},{backend_model:'Custom\\Backend'},{extension_attributes:{swatch_data:{}}}]) {
    assert.throws(()=>service.ordinary({...attribute,...patch},{attributeCode:'shade',attributeId:6001,optionId:'701'},'option'));
  }
});

test('normal admin store zero maps to global scope; invalid zero IDs and malformed topology still fail closed',async()=>{
  const transport=require('../src/services/magento/catalog-delete-transport');
  const scopes=await transport.createCatalogDeleteTransport(config,{fetchImpl:async()=>Response.json([
    {id:0,code:'admin',is_active:true},{id:1,code:'ua',is_active:true},{id:2,code:'ru',is_active:false},{id:3,code:'en',is_active:1},
  ])}).stores();
  assert.deepEqual(scopes,[{id:0,code:'all'},{id:1,code:'ua'},{id:3,code:'en'}]);
  for(const views of [[{id:0,code:'ua',is_active:true}],[{id:1,code:'admin',is_active:true}],[{id:-1,code:'ua',is_active:true}],
    [{id:0,code:'admin',is_active:true},{id:0,code:'admin',is_active:true}]]){
    await assert.rejects(transport.createCatalogDeleteTransport(config,{fetchImpl:async()=>Response.json(views)}).stores());
  }
});
test('closed signer refuses arbitrary paths, queries, other origins, EN deletion and traversal',()=>{
  assert.match(transport.signCatalogDeleteRequest('https://fixture.invalid/rest/all/V1/products/attributes/shade/options/701',config),/^OAuth /);
  for(const url of ['https://fixture.invalid/rest/all/V1/products/AG-000001','https://fixture.invalid/rest/en/V1/products/attributes/shade','https://other.invalid/rest/all/V1/products/attributes/shade',
    'https://fixture.invalid/rest/all/V1/products/attributes/shade?x=1','https://fixture.invalid/rest/all/V1/products/attributes/shade/options/0','https://fixture.invalid/rest/all/V1/products/attributes/shade/../../products']) assert.throws(()=>transport.signCatalogDeleteRequest(url,config));
});
test('incomplete Magento results and malformed responses never prove absence',async()=>{
  for(const body of [{items:[],total_count:1},{items:[],total_count:101},{items:[{attribute_code:'wrong'}],total_count:1}]) {
    const remote=transport.createCatalogDeleteTransport(config,{fetchImpl:async()=>Response.json(body)});
    await assert.rejects(remote.attribute({attributeCode:'shade',attributeId:6001,optionId:null}));
  }
});
test('literal zero IDs and rules are checked without label matching or boolean coercion',()=>{
  assert.equal(mentions({hidden_if_json:{questionKey:'shade',valueId:0}},'shade'),true);
  assert.equal(mentions({expression:'answers.shade'},'shade'),true);
  assert.equal(mentions({label:'Blue'},'shade'),false);
  assert.throws(()=>service.normalize({...request,remoteOptionId:'0'},config));
  assert.throws(()=>service.normalize({...request,extra:'DELETE'},config));
});
test('shared configuration receipts never present deletion as resource creation or allow generic creation review',()=>{
  const shared=require('../src/services/magento/configuration-actions');
  const row={id:'00000000-0000-0000-0000-000000000002',kind:'option_delete',state:'dispatched',created_at:'2026-10-05T00:00:00Z',
    intent:{localTarget:{questionId:'10',optionId:'20'},command:{target:{attributeCode:'shade',attributeId:6001,optionId:'701'}}}};
  const uncertain=shared.receipt(row); assert.equal(uncertain.workflow,'catalog_deletion'); assert.equal(uncertain.localDeleted,false); assert.equal(uncertain.canReview,false);
  assert.equal(uncertain.canReconcile,true); assert.doesNotMatch(uncertain.message,/Створено/);
  const complete=shared.receipt({...row,state:'verified',verified_at:'2026-10-05T00:00:01Z'});
  assert.equal(complete.state,'completed'); assert.equal(complete.localDeleted,true); assert.equal(complete.remoteAbsent,true); assert.doesNotMatch(complete.message,/Створено/);
});
