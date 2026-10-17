const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectLegacyInputs,inspectBootstrapEncoding } = require('../src/services/magento/first-sync-legacy-inputs');
const schemaService = require('../src/services/sku-schema.service');
const skuQuestion = (key='souvenir', code='5') => ({key,label:key,sku_index:0,display_order:0,required:1,sku_separator:'',visible_if_json:null,options:[{value_id:5,sku_code:code,label:'Stone',visible_if_json:null,hidden_if_json:null,archived:false}]});
function fixture() {
  const question=skuQuestion(), schema={id:9,category_code:'SV',version:1,marker:'',questions:[question]};
  schema.config_hash=schemaService.hashSnapshot(schema.questions);
  const product={id:7,category:'SV',status:'active',full_sku:'SV5004',base_sku:'SV5',sequence_number:4,sku_schema_version_id:9,characteristic_version_id:null,weight:null,details:{answers:{souvenir:5}}};
  const current={category_code:'SV',requires_weight:0,questions:[{...structuredClone(question),include_in_sku:1,input_type:'options'},{key:'color',include_in_sku:0,input_type:'options',options:[{value_id:0}]},{key:'weight',include_in_sku:0,input_type:'text',options:[]}]};
  return {product,schema,current,patch:{color:'0'},weight:null,hasWeight:false};
}
test('missing non-SKU semantic zero is accepted under the opaque legacy SKU rule; the product is not touched',()=>{
  const f=fixture(),before=structuredClone(f.product),result=inspectLegacyInputs(f);
  assert.deepEqual(f.product,before);assert.equal(result.proof.version,3);assert.equal(result.proof.skuPolicy,'opaque-legacy-sku-v1');
  assert.equal(result.proof.sku,'SV5004');assert.deepEqual(result.proof.skuAnswers,[]);
});
test('missing grams are imported without SKU agreement; the historical SKU is never rebuilt',()=>{
  for(const weight of ['4.125','5','8455']){
    const f=fixture(),before=structuredClone(f.product);Object.assign(f,{patch:{weight},weight,hasWeight:true});
    const result=inspectLegacyInputs(f);assert.equal(result.proof.weightPolicy,'missing-only-without-sku-agreement');
    assert.equal(result.proof.sku,'SV5004');assert.deepEqual(f.product,before);
  }
  const f=fixture();f.product.full_sku='SV2/-5-0004-003';Object.assign(f,{patch:{weight:'4.125'},weight:'4.125',hasWeight:true});
  assert.equal(inspectLegacyInputs(f).proof.sku,'SV2/-5-0004-003');
});
test('real zero, populated and malformed sources never count as missing legacy weight',()=>{
  for(const kind of ['physicalZero','mirrorZero','physical','mirror','malformed']){
    const f=fixture();Object.assign(f,{patch:{weight:'4.125'},weight:'4.125',hasWeight:true});
    if(kind==='physicalZero')f.product.weight=0;if(kind==='mirrorZero')f.product.details.answers.weight='0';
    if(kind==='physical')f.product.weight='4.125';if(kind==='mirror')f.product.details.answers.weight='4.125';
    if(kind==='malformed')f.product.details.answers.weight='broken';
    assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED'});
  }
});
test('a missing legacy SKU-question answer is imported only as an active pinned and current option',()=>{
  const f=fixture();f.product.details.answers={};f.patch={souvenir:'5'};
  const before=structuredClone(f.product),proof=inspectLegacyInputs(f).proof;
  assert.deepEqual(proof.skuAnswers,[{key:'souvenir',valueId:5,pinned:true}]);assert.equal(proof.sku,'SV5004');assert.deepEqual(f.product,before);
  for(const kind of ['unknown','text','pinnedArchived','currentArchived','currentMissing','hiddenQuestion','hiddenOption','duplicatePinned']){
    const g=fixture();g.product.details.answers={};g.patch={souvenir:kind==='text'?'stone':kind==='unknown'?6:5};
    if(kind==='pinnedArchived'){g.schema.questions[0].options[0].archived=true;g.schema.config_hash=schemaService.hashSnapshot(g.schema.questions);}
    if(kind==='currentArchived')g.current.questions[0].options[0].archived=true;
    if(kind==='currentMissing')g.current.questions[0].options=[];
    if(kind==='hiddenQuestion')g.current.questions[0].visible_if_json={color:1};
    if(kind==='hiddenOption')g.current.questions[0].options[0].hidden_if_json={color:0};
    if(kind==='hiddenQuestion'||kind==='hiddenOption')g.product.details.answers.color=kind==='hiddenOption'?0:2;
    if(kind==='duplicatePinned'){g.schema.questions.push(structuredClone(g.schema.questions[0]));g.schema.config_hash=schemaService.hashSnapshot(g.schema.questions);}
    assert.throws(()=>inspectLegacyInputs(g),{code:'FIRST_SYNC_LEGACY_SKU_ANSWER_INVALID'},kind);
  }
});
test('populated answers stay missing-only; a current-only SKU question is validated like a pinned one',()=>{
  const f=fixture();f.patch={souvenir:5};assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED'});
  const g=fixture();g.product.details.answers.color=0;assert.throws(()=>inspectLegacyInputs(g),{code:'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED'});
  const h=fixture();h.current.questions[1].include_in_sku=1;
  assert.deepEqual(inspectLegacyInputs(h).proof.skuAnswers,[{key:'color',valueId:0,pinned:false}]);
  h.patch={color:'7'};assert.throws(()=>inspectLegacyInputs(h),{code:'FIRST_SYNC_LEGACY_SKU_ANSWER_INVALID'});
});
test('frozen/current SKU visibility and transitive option dependencies cannot be changed',()=>{
  for(const where of ['schema','current'])for(const kind of ['question','option','transitive']){
    const f=fixture(),q=f[where].questions[0];
    if(kind==='question')q.visible_if_json={color:0};
    if(kind==='option')q.options[0].hidden_if_json={color:0};
    if(kind==='transitive'){q.visible_if_json={middle:1};f.current.questions.push({key:'middle',include_in_sku:0,visible_if_json:{color:0},options:[]});}
    if(where==='schema')f.schema.config_hash=schemaService.hashSnapshot(f.schema.questions);
    assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED'});
  }
  // An imported SKU-question answer must not drive any other SKU question either.
  const f=fixture();f.product.details.answers={};f.patch={souvenir:5};
  f.schema.questions.push({...skuQuestion('kind','7'),sku_index:1,display_order:1,required:0,visible_if_json:{souvenir:5}});
  f.schema.config_hash=schemaService.hashSnapshot(f.schema.questions);
  assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED'});
});
test('forged snapshot and stale identity fail closed',()=>{
  for(const kind of ['hash','category','hybrid','inactive','corrected','noSchema']){
    const f=fixture();
    if(kind==='hash')f.schema.config_hash='bad';if(kind==='category')f.schema.category_code='BR';
    if(kind==='hybrid')f.product.characteristic_version_id=1;if(kind==='inactive')f.product.status='archived';
    if(kind==='corrected')f.product.corrected_to_product_id=8;if(kind==='noSchema')f.schema=null;
    assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN'});
  }
});
test('legacy weight cannot round, overflow NUMERIC(14,3) storage or lose number precision',()=>{
  for(const weight of ['0','-1','4.1251','100000000000','99999999999.9991']){
    const f=fixture();Object.assign(f,{patch:{weight},weight,hasWeight:true});assert.throws(()=>inspectLegacyInputs(f));
  }
});

const real=require('./fixtures/legacy-sv-schema6');
function realFixture(id=1919) {
  return {product:real.product(id),schema:real.schema(),current:real.current(),patch:{size:'12/5/3'},hasWeight:false};
}
test('actual frozen schema6 hash, fractional display order, conditions and real zero remain exact',()=>{
  const f=realFixture();assert.equal(f.schema.questions.length,11);
  const clean=f.schema.questions.map(({id:_id,...q})=>q);
  assert.equal(schemaService.hashSnapshot(clean),real.data.provenance.frozenHash);
  assert.equal(f.schema.questions.find(q=>q.key==='stone_processing').display_order,9.5);
  assert.equal(f.schema.questions.find(q=>q.key==='stone_processing').options[0].value_id,0);
});
test('actual schema6 keychain accepts independent missing information',()=>{
  const f=realFixture(),before=structuredClone(f.product),proof=inspectLegacyInputs(f).proof;
  assert.equal(proof.sku,'SV116007');assert.deepEqual(proof.skuAnswers,[]);assert.deepEqual(f.product,before);
});
test('actual SV121001 statuette whose SKU encodes no material/colour accepts Magento material and colour',()=>{
  const f=realFixture(783);f.patch={material:'1',color:'3'};
  const before=structuredClone(f.product),proof=inspectLegacyInputs(f).proof;
  assert.deepEqual(proof.skuAnswers,[{key:'material',valueId:1,pinned:true},{key:'color',valueId:3,pinned:true}]);
  assert.equal(proof.sku,'SV121001');assert.deepEqual(f.product,before);
  f.patch={material:'9'};assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_SKU_ANSWER_INVALID'});
});
test('schema6 missing weight is accepted without SKU agreement; actual zero and populated inputs stay reviewed',()=>{
  const f=realFixture();f.product.weight=null;delete f.product.details.answers.weight;
  Object.assign(f,{patch:{weight:'8455'},weight:'8455',hasWeight:true});
  assert.equal(inspectLegacyInputs(f).proof.weightPolicy,'missing-only-without-sku-agreement');
  f.product.weight=0;assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED'});
  const g=realFixture(4055);g.patch={color:2};assert.throws(()=>inspectLegacyInputs(g),{code:'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED'});
});
test('conditional legacy SKU questions are importable only where visible for the stored answers',()=>{
  const f=realFixture(1359);f.patch={stone_processing:1};
  assert.equal(f.product.details.answers.stone_processing,undefined);
  assert.deepEqual(inspectLegacyInputs(f).proof.skuAnswers,[{key:'stone_processing',valueId:1,pinned:true}]);
  const g=realFixture(4055);delete g.product.details.answers.size;g.patch={stone_processing:0};
  assert.throws(()=>inspectLegacyInputs(g),{code:'FIRST_SYNC_LEGACY_SKU_ANSWER_INVALID'});
});
test('attestation classification distinguishes a valid non-reconstructable bootstrap from modern encoded layouts and invalid proof',()=>{
  const old=realFixture(1359);assert.equal(inspectBootstrapEncoding(old.product,old.schema).reconstructable,false);
  for(const id of [2198,1919]){
    const modern=realFixture(id);delete modern.product.details.answers.stone_processing;
    assert.equal(inspectBootstrapEncoding(modern.product,modern.schema).reconstructable,true);
  }
  for(const kind of ['hash','duplicate','forward','suffix']){
    const f=realFixture(1359);
    if(kind==='hash')f.schema.config_hash='0'.repeat(64);
    if(kind==='duplicate')f.schema.questions[0].options.push({...f.schema.questions[0].options[0]});
    if(kind==='forward')f.schema.questions[0].visible_if_json={stone_processing:1};
    if(kind==='suffix')f.product.sequence_number=2;
    if(['duplicate','forward'].includes(kind))f.schema.config_hash=schemaService.hashSnapshot(f.schema.questions.map(({id:_id,...q})=>q));
    assert.throws(()=>inspectBootstrapEncoding(f.product,f.schema),{code:'FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN'});
  }
});
test('nullable current include_in_sku never proves non-SKU authority or masks a dependency',()=>{
  for(const kind of ['target','dependent']){
    const f=fixture();if(kind==='target')f.current.questions[1].include_in_sku=null;
    else f.current.questions.push({key:'nullable_sku',include_in_sku:null,visible_if_json:{color:0},options:[]});
    assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED'});
  }
});
