const test=require('node:test');
const assert=require('node:assert/strict');
const {classifyFirstSyncEvidence:classify}=require('../src/services/magento/first-sync-eligibility');
const base={remote:{id:801,sku:'SV001'},sku:'SV001',installationKey:'main',
  history:{complete:true,issues:[],identityChanged:false},lifecycleBlockers:[],
  previousDelivery:false,protectedWork:false,otherOrigin:false,historicalEvidence:false};
const session={remote_product_id:'801',public_sku:'SV001',installation_key:'main',completed_at:null};
test('known absence follows ordinary CREATE; a received identity cannot be recreated',()=>{
  assert.equal(classify({...base,remote:null}).mode,'create');
  assert.equal(classify({...base,remote:null,session}).blockers[0].code,'FIRST_SYNC_IDENTITY_CHANGED');
});
test('exact remote legacy identity without delivery evidence is first, independent of counters',()=>{
  assert.equal(classify({...base,syncedGeneration:'0'}).mode,'first');
  assert.equal(classify({...base,syncedGeneration:'9'}).mode,'first');
});
test('acknowledged prior or predecessor delivery remains ordinary even with generation zero',()=>{
  assert.equal(classify({...base,previousDelivery:true,syncedGeneration:'0'}).mode,'ordinary');
});
test('weak historical exposure never silently becomes first',()=>{
  assert.equal(classify({...base,historicalEvidence:true}).blockers[0].code,'FIRST_SYNC_HISTORY_REVIEW_REQUIRED');
  for(const history of [{...base.history,complete:false},{...base.history,issues:[{code:'broken'}]},
    {...base.history,identityChanged:true}]) assert.equal(classify({...base,history}).mode,'review');
});
test('native identity ownership, lifecycle and unresolved work win over previous delivery',()=>{
  assert.equal(classify({...base,previousDelivery:true,ownershipIssue:'MAGENTO_NATIVE_IDENTITY_COLLISION'}).blockers[0].code,'MAGENTO_NATIVE_IDENTITY_COLLISION');
  assert.equal(classify({...base,previousDelivery:true,protectedWork:true}).blockers[0].code,'FIRST_SYNC_UNFINISHED_WORK');
  assert.deepEqual(classify({...base,lifecycleBlockers:[{code:'AMBER_PRODUCT_EXCLUDED'}]}).blockers,[{code:'AMBER_PRODUCT_EXCLUDED'}]);
});
test('partial session retains unresolved fields after own job delivery; completion is separate',()=>{
  assert.equal(classify({...base,session,previousDelivery:true}).mode,'first');
  assert.equal(classify({...base,session:{...session,completed_at:'2026-10-09'}}).mode,'ordinary');
});
test('public SKU, remote ID, installation and origin changes do not enable re-adoption',()=>{
  for(const remote of [{id:802,sku:'SV001'},{id:801,sku:'OTHER'}])
    assert.equal(classify({...base,remote,session}).blockers[0].code,'FIRST_SYNC_IDENTITY_CHANGED');
  assert.equal(classify({...base,session,installationKey:'other'}).mode,'review');
  assert.equal(classify({...base,otherOrigin:true}).blockers[0].code,'FIRST_SYNC_ORIGIN_REVIEW_REQUIRED');
});


test('acknowledged identity is checked independently of current same-SKU remote identity',()=>{
  assert.equal(classify({...base,acknowledgedRemoteId:'801',previousDelivery:true}).mode,'ordinary');
  assert.equal(classify({...base,acknowledgedRemoteId:'800'}).blockers[0].code,'FIRST_SYNC_IDENTITY_CHANGED');
  assert.equal(classify({...base,acknowledgedRemoteId:'801',remote:null}).blockers[0].code,'FIRST_SYNC_IDENTITY_CHANGED');
  assert.equal(classify({...base,acknowledgedRemoteId:null}).mode,'first');
});


test('known absence cannot reinitialize prior origin or exposed delivery history',()=>{
  for(const evidence of [{otherOrigin:true},{previousDelivery:true},{historicalEvidence:true}])
    assert.equal(classify({...base,remote:null,...evidence}).mode,'review');
  assert.equal(classify({...base,remote:null,protectedWork:true}).mode,'create');
});

test('exact acknowledged delivery and actual external floor delegate own queued work to ordinary guards',()=>{
  assert.equal(classify({...base,sameOriginAcknowledged:true,protectedWork:true}).mode,'ordinary');
  assert.equal(classify({...base,externalDelivery:true,previousDelivery:true,protectedWork:true}).mode,'ordinary');
  assert.equal(classify({...base,externalDelivery:true,otherOrigin:true}).mode,'review');
  assert.equal(classify({...base,externalDelivery:true,history:{...base.history,complete:false}}).mode,'review');
  assert.equal(classify({...base,sameOriginAcknowledged:true,session,protectedWork:true}).blockers[0].code,'FIRST_SYNC_UNFINISHED_WORK');
  assert.equal(classify({...base,externalDelivery:true,historicalEvidence:true}).mode,'ordinary');
  assert.equal(classify({...base,historicalEvidence:true,protectedWork:false}).mode,'review');
});

const {externalDeliveryEvidence}=require('../src/services/magento/first-sync-eligibility');
const origin='a'.repeat(64), otherOrigin='b'.repeat(64);
const receipt={productId:71,revision:'1',eventKey:'product.external_delivery_acknowledged',
  subjectType:'product',subjectId:'71',details:{fullRevision:'1',externalDeliverySemantic:true,
    planHash:'c'.repeat(64),remote:{originHash:origin,productId:801,sku:'SV001'}}};
const externalContext={originHash:origin,sku:'SV001',remote:base.remote};
test('external delivery requires its linked immutable audit and exact remote origin identity',()=>{
  assert.deepEqual(externalDeliveryEvidence([],externalContext),{externalDelivery:false,issue:null});
  assert.deepEqual(externalDeliveryEvidence([receipt],externalContext),{externalDelivery:true,issue:null});
  const predecessor={...structuredClone(receipt),productId:70,subjectId:'70'};
  assert.equal(externalDeliveryEvidence([receipt,predecessor],externalContext).externalDelivery,true);
});
for(const [label,change] of [
  ['event key',r=>r.eventKey='unrelated.event'],['subject type',r=>r.subjectType='snapshot'],
  ['subject ID',r=>r.subjectId='72'],['floor revision',r=>r.revision='2'],
  ['missing details',r=>delete r.details],['false semantic',r=>r.details.externalDeliverySemantic=false],
  ['missing plan hash',r=>delete r.details.planHash],['missing remote',r=>delete r.details.remote],
  ['malformed origin',r=>r.details.remote.originHash='unknown'],
  ['noninteger ID',r=>r.details.remote.productId=801.5],['string ID',r=>r.details.remote.productId='801'],
  ['zero ID',r=>r.details.remote.productId=0],['empty SKU',r=>r.details.remote.sku=''],
]) test('unusable external receipt stays history review: '+label,()=>{
  const changed=structuredClone(receipt);change(changed);
  const result=externalDeliveryEvidence([changed],externalContext);
  assert.deepEqual(result,{externalDelivery:false,issue:'FIRST_SYNC_HISTORY_REVIEW_REQUIRED'});
  assert.equal(classify({...base,externalDeliveryIssue:result.issue}).mode,'review');
  assert.equal(classify({...base,remote:null,externalDeliveryIssue:result.issue}).mode,'review');
});
test('foreign and mixed external origins stay origin review rather than re-adoption',()=>{
  const foreign=structuredClone(receipt);foreign.details.remote.originHash=otherOrigin;
  for(const rows of [[foreign],[receipt,foreign]])
    assert.deepEqual(externalDeliveryEvidence(rows,externalContext),{externalDelivery:false,issue:'FIRST_SYNC_ORIGIN_REVIEW_REQUIRED'});
});
test('different or absent external remote identity cannot become ordinary or CREATE',()=>{
  const different=structuredClone(receipt);different.details.remote.productId=802;
  const wrongSku=structuredClone(receipt);wrongSku.details.remote.sku='OTHER';
  for(const rows of [[different],[wrongSku],[receipt,different]])
    assert.deepEqual(externalDeliveryEvidence(rows,externalContext),{externalDelivery:false,issue:'FIRST_SYNC_IDENTITY_CHANGED'});
  assert.deepEqual(externalDeliveryEvidence([receipt],{...externalContext,remote:null}),
    {externalDelivery:false,issue:'FIRST_SYNC_IDENTITY_CHANGED'});
  assert.equal(classify({...base,remote:null,externalDeliveryIssue:'FIRST_SYNC_IDENTITY_CHANGED'}).mode,'review');
});
test('unusable external provenance is not hidden by a completed session or successful job',()=>{
  for(const extra of [{sameOriginAcknowledged:true},{session:{...session,completed_at:'2026-10-09'}}])
    assert.equal(classify({...base,...extra,externalDeliveryIssue:'FIRST_SYNC_ORIGIN_REVIEW_REQUIRED'}).mode,'review');
});

test('audited recount admission permits first field review only and never delivery completion',()=>{
  const reviewed={...base,historyAdmission:true,historicalEvidence:true,
    history:{...base.history,issues:['reviewed_mixed_history'],identityChanged:true}};
  assert.equal(classify(reviewed).mode,'first');
  assert.equal(classify({...reviewed,externalDelivery:true,previousDelivery:true}).mode,'first');
  assert.equal(classify({...reviewed,session,previousDelivery:true}).mode,'first');
  assert.equal(classify({...reviewed,history:{...reviewed.history,complete:false}}).mode,'review');
  assert.equal(classify({...reviewed,protectedWork:true}).blockers[0].code,'FIRST_SYNC_UNFINISHED_WORK');
  assert.equal(classify({...reviewed,ownershipIssue:'MAGENTO_NATIVE_IDENTITY_COLLISION'}).mode,'review');
  assert.equal(classify({...reviewed,session,otherOrigin:true}).blockers[0].code,'FIRST_SYNC_ORIGIN_REVIEW_REQUIRED');
  assert.equal(classify({...reviewed,externalDeliveryIssue:'FIRST_SYNC_IDENTITY_CHANGED'}).mode,'review');
  assert.equal(classify({...reviewed,remote:null}).mode,'review');
});
