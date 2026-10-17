const test=require('node:test');
const assert=require('node:assert/strict');
const m=require('../src/services/canonical-weight-manifest');
const service=require('../src/services/canonical-weight-repair');
const {parseArguments}=require('../scripts/canonical-weight-repair');
const {compileDefinition}=require('../src/services/export-templates/definition');
const {evaluate}=require('../src/services/magento/binding-evidence-products');
const publication=require('./fixtures/legacy-sv-publication.json');
const catalog=require('./fixtures/legacy-sv-schema6.json');
const binding='11111111-1111-4111-8111-111111111111';
const remote=(value='12.5')=>({sku:'SV1-000001',remoteProductId:501,target:'decor_weight',scope:'all',value,fieldStatus:'conflict',
  fieldReason:'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED',bindingRevisionId:binding,definitionHash:'c'.repeat(64)});
function entry(overrides={},answers={souvenir:1}) {
  const before=JSON.stringify({product:{id:1,weight:0,total_price_uah:123.45,details:{answers}},identity:{public_sku:'SV1-000001'}});
  const after=JSON.stringify({product:{id:1,weight:12.5,total_price_uah:123.45,details:{answers:{...answers,weight:'12.5'}}},identity:{public_sku:'SV1-000001'}});
  return {productId:1,eligible:true,reasonCodes:[],publicSku:'SV1-000001',beforeEvidence:before,afterEvidence:after,
    beforeFingerprint:m.digest(before),afterFingerprint:m.digest(after),targetWeight:'12.500',weightQuestionId:2,publishedResultHash:'b'.repeat(64),
    sourceKind:'magento_readback',sourceAnswer:Object.hasOwn(answers,'weight')?answers.weight:null,sourceAnswerPresent:Object.hasOwn(answers,'weight'),
    targetAnswer:'12.5',remoteEvidence:remote(),...overrides};
}
const plan=(entries,extra={})=>m.seal({format:m.MAGENTO_FORMAT,direction:'apply',database:'fixture_test',installationKey:'fixture',bindingRevisionId:binding,
  originHash:'a'.repeat(64),configurationText:JSON.stringify({activation:{installation_key:'fixture'},currentBinding:binding,binding:{id:binding,origin_hash:'a'.repeat(64)}}),
  entries,...extra});
const verify=value=>m.verify(value,value.planHash,'fixture_test','fixture');
test('Magento readback plans require strict remote evidence normalizing to the exact target answer',()=>{
  assert.ok(verify(plan([entry()])));
  assert.ok(verify(plan([entry({},{souvenir:1,weight:'0'})])));
  assert.ok(verify(plan([entry({remoteEvidence:remote('12.500')})])));
  const invalid=[{targetAnswer:'12.50'},{targetAnswer:'12.500'},{remoteEvidence:remote('12.6')},{remoteEvidence:{...remote(),extra:1}},
    {remoteEvidence:{...remote(),target:'weight'}},{remoteEvidence:{...remote(),scope:'en'}},{remoteEvidence:{...remote(),sku:'SV1-000002'}},
    {remoteEvidence:{...remote(),fieldReason:'OTHER'}},{remoteEvidence:{...remote(),bindingRevisionId:'22222222-2222-4222-8222-222222222222'}},
    {remoteEvidence:{...remote(),remoteProductId:'501'}},{remoteEvidence:undefined},{sourceKind:'recorded_answer'},{sourceAnswerPresent:true},
    {sourceAnswer:'0'}];
  for(const overrides of invalid) assert.throws(()=>verify(plan([entry(overrides)])),{code:'SV_CANONICAL_WEIGHT_PLAN_INVALID'},JSON.stringify(overrides));
  const recorded=plan([entry()],{format:m.FORMAT});
  assert.throws(()=>verify(recorded),{code:'SV_CANONICAL_WEIGHT_PLAN_INVALID'});
});
test('Magento readback rollback entries restore the exact absent or zero answer with the same source kind',()=>{
  const forward=entry();
  const rollback=answers=>{
    const before=JSON.stringify({product:{id:1,weight:12.5,details:{answers:{...answers,weight:'12.5'}}},identity:{public_sku:'SV1-000001'}});
    const after=JSON.stringify({product:{id:1,weight:0,details:{answers}},identity:{public_sku:'SV1-000001'}});
    return {...forward,beforeEvidence:before,afterEvidence:after,beforeFingerprint:m.digest(before),afterFingerprint:m.digest(after),
      targetWeight:'0.000',originalReceiptId:'33333333-3333-4333-8333-333333333333',
      sourceAnswer:Object.hasOwn(answers,'weight')?answers.weight:null,sourceAnswerPresent:Object.hasOwn(answers,'weight')};
  };
  assert.ok(verify(plan([rollback({souvenir:1})],{direction:'rollback'})));
  assert.ok(verify(plan([rollback({souvenir:1,weight:'0'})],{direction:'rollback'})));
  assert.throws(()=>verify(plan([{...rollback({souvenir:1}),sourceAnswerPresent:true}],{direction:'rollback'})),{code:'SV_CANONICAL_WEIGHT_PLAN_INVALID'});
  assert.throws(()=>verify(plan([{...rollback({souvenir:1}),sourceKind:'recorded_answer'}],{direction:'rollback'})),{code:'SV_CANONICAL_WEIGHT_PLAN_INVALID'});
  const {sourceKind,targetAnswer,remoteEvidence,...legacy}=rollback({souvenir:1}); void sourceKind; void targetAnswer; void remoteEvidence;
  assert.throws(()=>verify(plan([legacy],{direction:'rollback'})),{code:'SV_CANONICAL_WEIGHT_PLAN_INVALID'});
});
test('canonical weight CLI accepts a preview-only source and a bounded schema cache',()=>{
  const base=['--expected-database','fixture_test','--installation-key','fixture','--binding-revision',binding,'--actor-user-id','1','--output','output'];
  assert.equal(parseArguments(base).source,undefined);
  assert.equal(parseArguments([...base,'--source','recorded-answer']).source,undefined);
  const magento=parseArguments([...base,'--source','magento-readback','--schema-cache-seconds','120']);
  assert.equal(magento.source,'magento-readback'); assert.equal(magento.schemaCacheSeconds,120);
  const apply=[...base,'--mode','apply','--plan','plan.json','--confirm-plan-hash','a'.repeat(64),'--product-ids','1'];
  assert.equal(parseArguments([...apply,'--schema-cache-seconds','60']).schemaCacheSeconds,60);
  for(const args of [[...base,'--source','magento'],[...apply,'--source','magento-readback'],[...base,'--schema-cache-seconds','60'],
    [...base,'--source','magento-readback','--schema-cache-seconds','601'],[...base,'--mode','rollback-preview','--receipt-ids','33333333-3333-4333-8333-333333333333','--source','magento-readback'],
    [...base,'--mode','rollback-preview','--receipt-ids','33333333-3333-4333-8333-333333333333','--schema-cache-seconds','5']])
    assert.throws(()=>parseArguments(args),{code:'SV_CANONICAL_WEIGHT_ARGUMENTS'},args.join(' '));
});
const compiled=compileDefinition(publication.definition);
function pair(id,answer,target='12.500',targetAnswer='12.5') {
  const product=structuredClone(catalog.products.find(p=>p.id===id));
  product.weight='0.000'; if(answer===undefined) delete product.details.answers.weight; else product.details.answers.weight=answer;
  const repaired={...structuredClone(product),weight:target}; repaired.details.answers.weight=targetAnswer;
  return {product,repaired,before:evaluate({compiled},structuredClone(product)),after:evaluate({compiled},structuredClone(repaired))};
}
test('published legacy SV evaluation changes only decor_weight (and stone fraction) when the Magento weight is copied',()=>{
  for(const [id,answer] of [[782,undefined],[1481,undefined],[838,'0'],[1018,null]]) {
    const {product,before,after}=pair(id,answer);
    assert.match(service.magentoResult(before,after,'12.5',product.details.answers.souvenir),/^[a-f0-9]{64}$/,String(id));
  }
  const stone=pair(1835,undefined);
  assert.notEqual(stone.before.base.fraction,stone.after.base.fraction);
  assert.ok(service.magentoResult(stone.before,stone.after,'12.5',5));
  assert.throws(()=>service.magentoResult(stone.before,stone.after,'12.5',1),{code:'SV_CANONICAL_WEIGHT_PUBLISHED_RESULT_CHANGED'});
  const plain=pair(782,undefined);
  assert.throws(()=>service.magentoResult(plain.before,plain.after,'12.6',1),{code:'SV_CANONICAL_WEIGHT_PUBLISHED_RESULT_CHANGED'});
  assert.throws(()=>service.magentoResult(plain.after,plain.after,'12.5',1),{code:'SV_CANONICAL_WEIGHT_PUBLISHED_RESULT_CHANGED'});
  for(const forge of [r=>{r.generatedNames={...r.generatedNames,all:'Forged'};},r=>{r.base={...r.base,price:'1'};},
    r=>{r.english={...r.english,name:'Forged'};},r=>{r.evaluationIssues=[...r.evaluationIssues,{field:'kolir',code:'X'}];},r=>{r.failed=true;}]) {
    const forged=structuredClone(plain.after); forge(forged);
    assert.throws(()=>service.magentoResult(plain.before,forged,'12.5',1),{code:'SV_CANONICAL_WEIGHT_PUBLISHED_RESULT_CHANGED'});
  }
});
test('first-sync readback facts require first mode, the exact identity and a positive NUMERIC(14,3) decor_weight',()=>{
  const expected={sku:'SV1-000001',productId:1,bindingRevisionId:binding};
  const observation={amber:{product:{id:1,public_sku:'SV1-000001'},revision:{id:binding},compiled:{hash:'c'.repeat(64)}},raw:{id:501,sku:'SV1-000001'}};
  const field=(remoteValue,reason='FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED')=>({mode:'first',blockers:[],fields:[
    {target:'weight',scope:'all',status:'conflict',reason:'X',remote:{known:true,present:true,value:'99'}},
    {target:'decor_weight',scope:'all',status:'conflict',reason,local:{known:true,present:true,value:'0.000'},remote:{known:true,present:true,value:remoteValue}}]});
  const facts=service.remoteFacts(field('12.50'),observation,expected);
  assert.deepEqual(facts.reasonCodes,[]); assert.equal(facts.targetWeight,'12.500'); assert.equal(facts.targetAnswer,'12.5');
  assert.deepEqual(facts.remoteEvidence,remote('12.50'));
  assert.equal(service.remoteFacts(field('7'),observation,expected).targetWeight,'7.000');
  for(const value of ['0','-1','12.3456','abc','100000000000','']) assert.deepEqual(service.remoteFacts(field(value),observation,expected).reasonCodes,['REMOTE_WEIGHT_NOT_POSITIVE_DECIMAL'],value);
  assert.deepEqual(service.remoteFacts(field('5','OTHER'),observation,expected).reasonCodes,['READBACK_REASON_UNEXPECTED']);
  const incoherent=service.remoteFacts(field('5','CANONICAL_WEIGHT_ANSWER_INCOHERENT'),observation,expected);
  assert.equal(incoherent.reportOnly,true); assert.deepEqual(incoherent.reasonCodes,['CANONICAL_WEIGHT_ANSWER_INCOHERENT']);
  assert.deepEqual(service.remoteFacts({mode:'ordinary',fields:[]},observation,expected).reasonCodes,['READBACK_MODE_NOT_FIRST']);
  assert.deepEqual(service.remoteFacts(field('5'),{...observation,raw:{id:501,sku:'SV1-000002'}},expected).reasonCodes,['READBACK_IDENTITY_MISMATCH']);
  assert.deepEqual(service.remoteFacts({mode:'first',fields:[]},observation,expected).reasonCodes,['READBACK_DECOR_WEIGHT_ABSENT']);
});
