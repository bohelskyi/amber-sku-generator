const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/services/magento/binding-contract');
const boundary = require('../src/services/magento/historical-standard-boundary');
const service = require('../src/services/historical-standard-reactivation.service');
const observation = raw => ({raw,domainEvidence:{inventory:null,english:null,failures:[]}});
const raw = {id:44,sku:'BR/IMMUTABLE',status:1,visibility:4,price:240};
function proof(mode='update') {
  const intent={mode,operations:[{domain:'coreProduct',payload:{product:{sku:raw.sku,price:240}}}]};
  const original=observation(mode==='update'?raw:null);
  return {intent,original,proof:{public_sku:raw.sku,delivery_mode:mode,remote_product_id:mode==='update'?44:null,
    target_status:mode==='update'?1:2,target_visibility:4,remote_fingerprint:mode==='update'?boundary.observationFingerprint(original):null,
    review:{remoteObservationHash:boundary.observationFingerprint(original)},plan_hash:c.hash(intent)}};
}
test('standard UPDATE seals exact current SKU/id/status/visibility and does not promise atomic remote endpoint semantics',()=>{
  const p=proof();boundary.assertPlan(p.proof,p.intent,p.original);
  for(const change of [{id:45},{sku:'OTHER'},{status:2},{visibility:1},{price:241}])
    assert.throws(()=>boundary.assertPlan(p.proof,p.intent,observation({...raw,...change})),{code:'HISTORICAL_REMOTE_OBSERVATION_CHANGED'});
  assert.throws(()=>boundary.assertPlan(p.proof,{...p.intent,mode:'create'},p.original),{code:'HISTORICAL_DELIVERY_PLAN_CHANGED'});
});
test('reviewed CREATE is valid only on the sealed absent observation before first dispatch',()=>{
  const p=proof('create');boundary.assertPlan(p.proof,p.intent,p.original);
  assert.throws(()=>boundary.assertPlan(p.proof,p.intent,observation(raw)),{code:'HISTORICAL_REMOTE_OBSERVATION_CHANGED'});
  assert.throws(()=>boundary.assertPlan(p.proof,p.intent,{raw:null,domainEvidence:{inventory:{changed:true}}}),{code:'HISTORICAL_REMOTE_OBSERVATION_CHANGED'});
});
test('normal partial receipts may contain our intended changes while remote identity and reviewed participation fields remain pinned',()=>{
  const p=proof();boundary.assertPlan(p.proof,p.intent,observation({...raw,price:241}),true);
  boundary.assertIdentity(p.proof,observation({...raw,price:241}),{remote_product_id:44});
  assert.throws(()=>boundary.assertIdentity(p.proof,observation({...raw,id:45}),{remote_product_id:44}),{code:'HISTORICAL_REMOTE_OBSERVATION_CHANGED'});
  const created=proof('create');boundary.assertIdentity(created.proof,observation({...raw,status:2}),{remote_product_id:44});
  assert.throws(()=>boundary.assertIdentity(created.proof,observation({...raw,id:45,status:2}),{remote_product_id:44}),{code:'HISTORICAL_REMOTE_OBSERVATION_CHANGED'});
});
test('prospective planner changes only participation on the original source-associated object',()=>{
  const product={status:'archived',exclude_from_export:1,full_sku:'BR/IMMUTABLE',details:{answers:{text:'verbatim'}},exportState:{route:'retired'}};
  const amber={product};assert.equal(boundary.project(amber),amber);assert.equal(amber.product,product);
  assert.equal(product.status,'active');assert.equal(product.exportState.route,'normal');assert.equal(product.full_sku,'BR/IMMUTABLE');
  assert.deepEqual(product.details,{answers:{text:'verbatim'}});
});
test('standard receipt distinguishes delivery verification from local activation and never invents historical hide verification',()=>{
  const row={id:'intent',product_id:4,public_sku:'BR/IMMUTABLE',state:'delivering',delivery_mode:'update',target_status:1,target_visibility:4,native_job_id:'job'};
  const receipt=service.receipt(row);assert.equal(receipt.protocol,'standard-rest-v1');assert.equal(receipt.targetStatus,1);
  assert.equal(receipt.targetVisibility,4);assert.equal(receipt.hiddenVerifiedAt,null);assert.equal(receipt.deliveryVerifiedAt,null);assert.equal(receipt.localActivatedAt,null);
  const completed=service.receipt({...row,state:'completed',delivery_verified_at:'receipt',local_activated_at:'local'});
  assert.equal(completed.nativeConfirmedAt,'receipt');assert.equal(completed.localActivatedAt,'local');assert.equal(completed.hiddenVerifiedAt,null);
});
