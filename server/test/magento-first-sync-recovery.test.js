
const test=require('node:test');
const assert=require('node:assert/strict');
const c=require('../src/services/magento/binding-contract');
const recovery=require('../src/services/magento/sync-job-recovery');
const runtime=require('../src/services/magento/first-sync-runtime');
function fixture(state='verified') {
  const raw={id:81,sku:'BR-recovery',name:'Accepted',extension_attributes:{website_ids:[]}};
  const observation={amber:{product:{id:7,public_sku:raw.sku,public_product_identity_id:9},
    revision:{id:'11111111-1111-4111-8111-111111111111',originHash:'a'.repeat(64),installationKey:'recovery-fixture'}},
    raw,schema:{attributes:[]},categoryNodes:[],categoryFailures:[],domainEvidence:{english:null,inventory:[],failures:[]}};
  const intent={mode:'update',operations:[{domain:'coreProduct',payload:{product:{sku:raw.sku,name:'Accepted'}}}],websiteIds:[],englishValues:{}};
  const job={id:'22222222-2222-4222-8222-222222222222',sku:raw.sku,product_id:7,public_product_identity_id:9,
    binding_revision_id:observation.amber.revision.id,origin_hash:'a'.repeat(64),installation_key:'recovery-fixture',
    intent,plan_hash:c.hash(intent),state:'uncertain',remote_product_id:81,
    baseline:{raw:structuredClone(raw),preservation:{},domainEvidence:structuredClone(observation.domainEvidence)}};
  const steps=[{job_id:job.id,ordinal:0,state}];
  const review={format:recovery.FORMAT,jobId:job.id,planHash:job.plan_hash,jobFingerprint:recovery.fingerprint(job,steps),
    remoteFingerprint:recovery.remoteFingerprint(observation),steps:[{ordinal:0,domain:'coreProduct',state,matches:true}],complete:true,blockers:[]};
  return {job,steps,observation,review};
}
test('reviewed recovery proof is request-owned and serialized or lookalike values confer no authority',()=>{
  const f=fixture(), proof=runtime.reviewedRecovery(f.job,f.steps,f.observation,f.review);
  assert.equal(runtime.recoveryIsReviewed(proof,f.job.id,f.observation),true);
  for(const forged of [{},structuredClone(proof),JSON.parse(JSON.stringify(proof)),f.review,{...f.job}])
    assert.equal(runtime.recoveryIsReviewed(forged,f.job.id,f.observation),false);
  assert.equal(runtime.recoveryIsReviewed(proof,'33333333-3333-4333-8333-333333333333',f.observation),false);
  for(const alter of [
    o=>{o.amber.product.id++;},o=>{o.amber.product.public_product_identity_id++;},
    o=>{o.amber.product.public_sku='OTHER';},o=>{o.amber.revision.id='other';},
    o=>{o.amber.revision.originHash='b'.repeat(64);},o=>{o.amber.revision.installationKey='other';},o=>{o.raw.id++;},
  ]){const changed=structuredClone(f.observation);alter(changed);assert.equal(runtime.recoveryIsReviewed(proof,f.job.id,changed),false);}
});
test('stale job, step, remote field or blocked review cannot issue a recovery proof',()=>{
  for(const alter of [
    f=>{f.job.state='running';},f=>{f.job.plan_hash='b'.repeat(64);},
    f=>{f.steps[0].state='dispatched';},f=>{f.observation.raw.name='New remote';},
    f=>{f.observation.categoryFailures.push({code:'READ_FAILED'});},f=>{f.review.blockers.push({code:'BLOCKED'});},
  ]){
    const f=fixture();alter(f);
    assert.throws(()=>runtime.reviewedRecovery(f.job,f.steps,f.observation,f.review),{code:'MAGENTO_FIRST_SYNC_RECOVERY_REVIEW_CHANGED'});
  }
});
test('dispatched reconciliation requires actual complete plan readback, not a matching review hash alone',()=>{
  const f=fixture('dispatched');
  assert.throws(()=>runtime.reviewedRecovery(f.job,f.steps,f.observation,f.review),{code:'MAGENTO_FIRST_SYNC_RECOVERY_REVIEW_CHANGED'});
  const proof=runtime.reviewedRecovery(f.job,f.steps,f.observation,f.review,{allowDispatched:true});
  assert.equal(runtime.recoveryIsReviewed(proof,f.job.id,f.observation),true);
  f.observation.raw.name='Wrong value';
  f.review.remoteFingerprint=recovery.remoteFingerprint(f.observation);
  assert.throws(()=>runtime.reviewedRecovery(f.job,f.steps,f.observation,f.review,{allowDispatched:true}),
    {code:'MAGENTO_SYNC_VERIFICATION_MISMATCH'});
});
test('service forwards only a genuine exact-context recovery proof to eligibility without HTTP',async t=>{
  const f=fixture(),proof=runtime.reviewedRecovery(f.job,f.steps,f.observation,f.review),seen=[];
  const client={query:async()=>({rows:[]}),release(){}};
  t.mock.method(require('../src/services/magento/first-sync-eligibility'),'readFirstSyncEligibility',
    async(_client,_config,_observation,input)=>{seen.push(input);return{mode:'review',blockers:[{code:'FIXTURE_STOP'}]};});
  t.mock.method(globalThis,'fetch',()=>assert.fail('Recovery proof checks must not use HTTP'));
  const service=require('../src/services/magento/first-sync.service'),options={databasePool:{connect:async()=>client}};
  for(const token of [{},structuredClone(proof),proof])
    await service.inspect({},f.observation,{...options,firstSyncRecoveryProof:token},{jobId:f.job.id});
  await service.inspect({},f.observation,{...options,firstSyncRecoveryProof:proof},{jobId:'other'});
  assert.deepEqual(seen.map(input=>input.reviewedRecovery),[false,false,true,false]);
});
