const test=require('node:test');
const assert=require('node:assert/strict');
const own=require('../src/services/magento/native-identity-ownership');
const names=require('../src/services/magento/name-state');
const standard=require('../src/services/magento/historical-standard-boundary');
const c=require('../src/services/magento/binding-contract');
const {compileDefinition}=require('../src/services/export-templates/definition');
const fixture=require('./fixtures/magento-bindings');
const {planPreview}=require('../src/services/magento/sync-preview');
const {indexTrees}=require('../src/services/magento/sync-preview-categories');
function amber() {
  const definition=structuredClone(fixture.definition());definition.sources.sku.field='public_sku';definition.evaluatorVersion='magento-declarative-3';definition.sourceContractVersion='public-product-identity-v1';
  return {product:{id:5011,characteristic_version_id:1,public_product_identity_id:4959,public_sku:'AG-000003',
    full_sku:null,base_sku:null,sequence_number:null,sku_schema_version_id:null,category:'BR',status:'active',weight:5,exclude_from_export:0,details:{answers:{binding_test_semantic:7,binding_test_size:'17'}}},
  compiled:compileDefinition(definition),revision:{originHash:'fixture-origin',bindings:{routes:[],attributes:[],options:[],policies:[]},schema:fixture.schema()},nameState:null};
}
async function proof(a,{origin='allocated',remoteId=null}={}) {
  await own.load({async query(sql,values){assert.deepEqual(values,[4959,'fixture-origin','AG-000003']);
    assert.match(sql,/state='succeeded'/);assert.match(sql,/acknowledged_at IS NOT NULL/);assert.match(sql,/j.sku=i.public_sku/);
    assert.match(sql,/j.origin_hash=\$2/);assert.doesNotMatch(sql,/j.product_id=/,'identity-preserving successors retain predecessor ownership');
    return {rows:[{origin,remote_id:remoteId}]};}},a,'fixture-origin');
}
const raw={id:5797,sku:'AG-000003',name:'Fixture name',status:1,visibility:4,attribute_set_id:8001,type_id:'simple',price:9945};
const observation=(a,r=raw)=>({amber:a,raw:r,domainEvidence:{english:{fields:{name:r.name}},failures:[]}});
test('foreign existing native SKU blocks every operation for equal or different names and establishes no baseline',async()=>{
  for(const name of ['Fixture name','Foreign icon']) {
    const a=amber();await proof(a);a.nameState={state:'common',remote_product_id:5797,baseline_names:{all:name,en:name}};
    const o=observation(a,{...raw,name});assert.equal(names.decisionFor(o).action,'foreign_identity');
    const result=await names.reconcileObservation({},o,{databasePool:{connect(){throw new Error('must not establish a baseline');}}});
    assert.equal(result.action,'foreign_identity');
    const report=planPreview(a,fixture.schema(),o.raw,indexTrees([]),{domainEvidence:o.domainEvidence});
    assert.equal(report.blockers.filter(b=>b.code===own.CODE).length,1);assert.equal(report.sendable,false);assert.equal(report.identity.confirmedMagentoId,null);
    for(const operation of Object.values(report.sendability.operations))assert.equal(operation.sendable,false);
    assert.equal(report.blockers.some(b=>b.code==='NAME_CONFLICT'),false);
  }
});
test('acknowledged exact remote identity permits ordinary names and identity-preserving successor revisions',async()=>{
  const a=amber();await proof(a,{remoteId:'5797'});assert.equal(own.issue(a,raw),null);
  assert.equal(names.decisionFor(observation(a)).action,'confirm');
  a.product.id=5012;a.product.corrected_from_product_id=5011;assert.equal(own.issue(a,raw),null);
  assert.equal(own.issue(a,{...raw,id:5798}),own.CODE);
});
test('unowned missing remote permits CREATE, while forged/copied/wrong-origin evidence cannot permit UPDATE',async()=>{
  const a=amber();assert.equal(own.issue(a,null),null);assert.equal(own.issue(a,raw),own.CODE);
  await proof(a,{remoteId:5797});assert.equal(own.issue({...a},raw),own.CODE);
  a.revision.originHash='another-origin';assert.equal(own.issue(a,raw),own.CODE);
});
test('native successors of legacy identities and pre-native cutover records preserve existing behavior',async()=>{
  const a=amber();await proof(a,{origin:'legacy'});assert.equal(own.issue(a,raw),null);
  assert.equal(names.decisionFor(observation(a)).action,'confirm');
  a.product.characteristic_version_id=null;assert.equal(own.issue({...a},raw),null);
});
test('historical prospective projection retains ownership proof and cannot adopt foreign native UPDATE',async()=>{
  const a=amber();await proof(a);a.product.status='archived';const o=observation(standard.project(a));
  const intent={mode:'update',operations:[]};const sealed={public_sku:raw.sku,delivery_mode:'update',remote_product_id:5797,target_status:1,target_visibility:4,
    remote_fingerprint:standard.observationFingerprint(o),plan_hash:c.hash(intent)};
  assert.throws(()=>standard.assertPlan(sealed,intent,o),{code:own.CODE});
  assert.throws(()=>standard.assertIdentity(sealed,o),{code:own.CODE});
  await proof(a,{remoteId:5797});assert.doesNotThrow(()=>standard.assertPlan(sealed,intent,o));
});
test('original durable CREATE receipt reconciliation still accepts only its exact pinned identity',()=>{
  const a=amber(),o=observation(a,{...raw,status:2});
  const sealed={public_sku:raw.sku,delivery_mode:'create',remote_product_id:null,target_status:2,target_visibility:4};
  assert.doesNotThrow(()=>standard.assertIdentity(sealed,o,{remote_product_id:5797}));
  assert.throws(()=>standard.assertIdentity(sealed,{...o,raw:{...o.raw,id:5798}},{remote_product_id:5797}),{code:'HISTORICAL_REMOTE_OBSERVATION_CHANGED'});
});
test('problem detail prioritizes identity collision over stale name conflict and offers no name choice',async()=>{
  const problems=require('../src/services/magento/sync-problems');
  const detail=await problems.problemDetail({configured:false},5011,{query:async()=>({rows:[{productId:5011,article:raw.sku,state:'needs_attention',
    name_state:'conflict',reason_code:'data_or_binding',diagnostics:[{code:own.CODE}]}]})});
  assert.equal(detail.nameConflict,null);assert.equal(detail.problems[0].code,own.CODE);assert.equal(detail.problems[0].resolution,'administrator');assert.match(detail.problems[0].message,/вибір назви/);
});
