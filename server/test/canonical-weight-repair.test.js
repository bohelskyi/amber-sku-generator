const test=require('node:test');
const assert=require('node:assert/strict');
const m=require('../src/services/canonical-weight-manifest');
const {parseArguments}=require('../scripts/canonical-weight-repair');
const binding='11111111-1111-4111-8111-111111111111';
function fixture() {
  const before=JSON.stringify({product:{id:1,weight:0,total_price_uah:123.45},identity:{public_sku:'SV5-000001'}});
  const after=JSON.stringify({product:{id:1,weight:25.5,total_price_uah:123.45},identity:{public_sku:'SV5-000001'}});
  return m.seal({format:m.FORMAT,direction:'apply',database:'fixture_test',installationKey:'fixture',bindingRevisionId:binding,
    originHash:'a'.repeat(64),configurationText:JSON.stringify({activation:{installation_key:'fixture'},currentBinding:binding,binding:{id:binding,origin_hash:'a'.repeat(64)}}),
    entries:[{productId:1,eligible:true,reasonCodes:[],publicSku:'SV5-000001',beforeEvidence:before,afterEvidence:after,
      beforeFingerprint:m.digest(before),afterFingerprint:m.digest(after),targetWeight:'25.500',weightQuestionId:2,publishedResultHash:'b'.repeat(64)}]});
}
test('canonical weight plans seal exact evidence bytes and reject stale hashes, context and implicit selection',()=>{
  const plan=fixture(); assert.ok(m.verify(plan,plan.planHash,'fixture_test','fixture'));
  for(const [value,database,installation] of [[{...plan,direction:'rollback'},'fixture_test','fixture'],[plan,'wrong_test','fixture'],[plan,'fixture_test','other']]) {
    assert.throws(()=>m.verify(value,plan.planHash,database,installation),{code:'SV_CANONICAL_WEIGHT_PLAN_INVALID'});
  }
  assert.throws(()=>m.selection(plan,[]),{code:'SV_CANONICAL_WEIGHT_SCOPE_INVALID'});
  assert.throws(()=>m.selection(plan,[1,1]),{code:'SV_CANONICAL_WEIGHT_SCOPE_INVALID'});
  assert.throws(()=>m.selection(plan,[2]),{code:'SV_CANONICAL_WEIGHT_SCOPE_INVALID'});
  assert.deepEqual(m.selection(plan,[1]),plan.entries);
  const corrupted=m.seal({...m.seal({...plan,planHash:undefined}),entries:[{...plan.entries[0],beforeEvidence:plan.entries[0].beforeEvidence+' '}]});
  assert.throws(()=>m.verify(corrupted,corrupted.planHash,'fixture_test','fixture'),{code:'SV_CANONICAL_WEIGHT_PLAN_INVALID'});
});
test('canonical weight plan bounds and rollback require an exact original receipt and zero target',()=>{
  const plan=fixture();
  assert.throws(()=>m.seal({x:'x'.repeat(m.MAX_PLAN_BYTES)}),{code:'SV_CANONICAL_WEIGHT_PLAN_LIMIT'});
  const rollback=m.seal({...plan,planHash:undefined,direction:'rollback',entries:[{...plan.entries[0],targetWeight:'0.000'}]});
  assert.throws(()=>m.verify(rollback,rollback.planHash,'fixture_test','fixture'),{code:'SV_CANONICAL_WEIGHT_PLAN_INVALID'});
});
test('canonical weight CLI defaults to preview and requires exact explicit apply scope and confirmation',()=>{
  const base=['--expected-database','fixture_test','--installation-key','fixture','--binding-revision',binding,'--actor-user-id','1','--output','output'];
  assert.equal(parseArguments(base).mode,'preview');
  assert.throws(()=>parseArguments([...base,'--mode','apply']),{code:'SV_CANONICAL_WEIGHT_ARGUMENTS'});
  assert.throws(()=>parseArguments([...base,'--product-ids','1']),{code:'SV_CANONICAL_WEIGHT_ARGUMENTS'});
  const apply=[...base,'--mode','apply','--plan','plan.json','--confirm-plan-hash','a'.repeat(64),'--product-ids','1,2'];
  assert.deepEqual(parseArguments(apply).productIds,[1,2]);
  assert.throws(()=>parseArguments([...apply.slice(0,-1),'all']),{code:'SV_CANONICAL_WEIGHT_ARGUMENTS'});
  assert.throws(()=>parseArguments([...apply.slice(0,-1),'1,1']),{code:'SV_CANONICAL_WEIGHT_ARGUMENTS'});
  assert.throws(()=>parseArguments([...base,'--mode','rollback-preview','--receipt-ids','all']),{code:'SV_CANONICAL_WEIGHT_ARGUMENTS'});
});
