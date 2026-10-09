const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectLegacyInputs } = require('../src/services/magento/first-sync-legacy-inputs');
const schemaService = require('../src/services/sku-schema.service');
const skuQuestion = (key='souvenir', code='5') => ({key,label:key,sku_index:0,display_order:0,required:1,sku_separator:'',visible_if_json:null,options:[{value_id:5,sku_code:code,label:'Stone',visible_if_json:null,hidden_if_json:null,archived:false}]});
function fixture() {
  const question=skuQuestion(), schema={id:9,category_code:'SV',version:1,marker:'',questions:[question]};
  schema.config_hash=schemaService.hashSnapshot(schema.questions);
  const product={id:7,category:'SV',status:'active',full_sku:'SV5004',base_sku:'SV5',sequence_number:4,sku_schema_version_id:9,characteristic_version_id:null,weight:null,details:{answers:{souvenir:5}}};
  const current={category_code:'SV',requires_weight:0,questions:[{...structuredClone(question),include_in_sku:1},{key:'color',include_in_sku:0,input_type:'options',options:[{value_id:0}]},{key:'weight',include_in_sku:0,input_type:'text',options:[]}]};
  return {product,schema,current,patch:{color:'0'},weight:null,hasWeight:false};
}
test('missing non-SKU semantic zero is safe without relabeling encoded identity',()=>{
  const f=fixture(),before=structuredClone(f.product),result=inspectLegacyInputs(f);
  assert.deepEqual(f.product,before);assert.equal(result.proof.version,2);assert.equal(result.proof.sku,'SV5004');
});
test('missing grams must reproduce the complete legacy SKU under either suffix interpretation',()=>{
  const f=fixture();Object.assign(f,{patch:{weight:'4.125'},weight:'4.125',hasWeight:true});
  const result=inspectLegacyInputs(f);assert.equal(result.proof.weightCompatibility,'sequence-or-rounded-weight');
  f.current.requires_weight=1;assert.deepEqual(inspectLegacyInputs(f).proof,result.proof);
  f.weight='5';f.patch.weight='5';assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_WEIGHT_IDENTITY_REVIEW_REQUIRED'});
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
test('SKU-driving and populated answers require an explicit reviewed correction',()=>{
  for(const kind of ['frozen','current','existing']){
    const f=fixture();if(kind==='frozen')f.patch={souvenir:5};if(kind==='current')f.current.questions[1].include_in_sku=1;
    if(kind==='existing')f.product.details.answers.color=0;
    assert.throws(()=>inspectLegacyInputs(f),{code:kind==='existing'?'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED':'FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED'});
  }
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
});
test('marker, separators and variation are reproduced exactly; numeric suffix equality is insufficient',()=>{
  const f=fixture();f.schema.version=2;f.schema.marker='2/';f.schema.questions[0].sku_separator='-';f.schema.config_hash=schemaService.hashSnapshot(f.schema.questions);
  f.product.full_sku='SV2/-5-004-003';f.product.base_sku='SV2/-5-';Object.assign(f,{patch:{weight:'4.125'},weight:'4.125',hasWeight:true});
  assert.equal(inspectLegacyInputs(f).proof.sku,f.product.full_sku);
  f.product.full_sku='SV2/-5-0004-003';assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN'});
});
test('hidden omission disagreement, forged snapshot and stale identity fail closed',()=>{
  for(const kind of ['hidden','hash','version','category','hybrid','inactive']){
    const f=fixture();if(kind==='hidden'){f.schema.questions.push({...skuQuestion('hidden','6'),required:0,visible_if_json:{souvenir:6}});f.schema.config_hash=schemaService.hashSnapshot(f.schema.questions);f.product.full_sku='SV50004';}
    if(kind==='hash')f.schema.config_hash='bad';if(kind==='version')f.schema.version=2;
    if(kind==='category')f.schema.category_code='BR';if(kind==='hybrid')f.product.characteristic_version_id=1;if(kind==='inactive')f.product.status='archived';
    assert.throws(()=>inspectLegacyInputs(f));
  }
});
test('legacy weight cannot round, overflow NUMERIC(14,3) storage or lose number precision',()=>{
  for(const weight of ['0','-1','4.1251','100000000000','99999999999.9991']){
    const f=fixture();Object.assign(f,{patch:{weight},weight,hasWeight:true});assert.throws(()=>inspectLegacyInputs(f));
  }
});

test('first-result decoders cannot conceal an alternative variable-width semantic parse',()=>{
  const f=fixture();f.schema.questions=[
    {...skuQuestion('first'),options:[{value_id:12,sku_code:'12',label:'12',visible_if_json:null,hidden_if_json:null,archived:false},{value_id:1,sku_code:'1',label:'1',visible_if_json:null,hidden_if_json:null,archived:false}]},
    {...skuQuestion('second'),sku_index:1,display_order:1,options:[{value_id:23,sku_code:'23',label:'23',visible_if_json:null,hidden_if_json:null,archived:false},{value_id:3,sku_code:'3',label:'3',visible_if_json:null,hidden_if_json:null,archived:false}]},
  ];f.schema.config_hash=schemaService.hashSnapshot(f.schema.questions);f.product.full_sku='SV123004';f.product.base_sku='SV123';f.product.details.answers={first:12,second:3};
  assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN'});
});
test('optional separated placeholder never disguises a contradictory populated encoded answer',()=>{
  const f=fixture();f.schema.questions[0].required=0;f.schema.questions[0].sku_separator='-';f.schema.config_hash=schemaService.hashSnapshot(f.schema.questions);
  f.product.full_sku='SV-0-004';f.product.base_sku='SV-0-';f.product.details.answers.souvenir=5;
  assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN'});
});
test('self-referential conditions, duplicate or non-digit codes require explicit historical review',()=>{
  for(const kind of ['conditional','duplicate','separatorCode']){
    const f=fixture(),q=f.schema.questions[0];if(kind==='conditional')q.visible_if_json={souvenir:5};if(kind==='optional')q.required=0;
    if(kind==='duplicate')q.options.push({...q.options[0]});if(kind==='separatorCode')q.options[0].sku_code='-5-';
    f.schema.config_hash=schemaService.hashSnapshot(f.schema.questions);assert.throws(()=>inspectLegacyInputs(f));
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
test('actual schema6 keychain accepts independent missing information without omitting the frozen schema',()=>{
  const f=realFixture(),before=structuredClone(f.product),proof=inspectLegacyInputs(f).proof;
  assert.deepEqual(proof.interpretation.semantics.map(x=>x.key),['material','color','souvenir']);
  assert.equal(proof.interpretation.baseSku,'SV116');assert.equal(proof.interpretation.sequenceNumber,7);
  assert.deepEqual(f.product,before);
});
test('actual conditional stone and bird branches retain real option zero versus absent optional placeholders',()=>{
  for(const id of [2198,4055]){
    const f=realFixture(id);delete f.product.details.answers.size;
    const proof=inspectLegacyInputs(f).proof;
    const key=id===2198?'additional_stone':'bird';
    assert.deepEqual(proof.interpretation.semantics.find(a=>a.key===key),{key,valueId:null,placeholder:true});
  }
  const f=realFixture(2198);f.product.base_sku='SV13500';f.product.full_sku='SV13500001';
  f.product.details.answers.stone_processing=0;delete f.product.details.answers.size;
  assert.deepEqual(inspectLegacyInputs(f).proof.interpretation.semantics.find(a=>a.key==='stone_processing'),{key:'stone_processing',valueId:0,placeholder:false});
});
test('schema6 controlled missing-weight variant proves only exact compatibility; actual zero and SKU inputs stay reviewed',()=>{
  const f=realFixture();f.product.weight=null;delete f.product.details.answers.weight;
  Object.assign(f,{patch:{weight:'7.125'},weight:'7.125',hasWeight:true});
  assert.equal(inspectLegacyInputs(f).proof.weightCompatibility,'sequence-or-rounded-weight');
  f.product.weight=0;assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED'});
  for(const key of ['stone_processing','bird','additional_stone']){
    const g=realFixture();g.patch={[key]:0};assert.throws(()=>inspectLegacyInputs(g),{code:'FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED'});
  }
});
test('conditional grammar rejects unknown/forward/malformed rules and populated hidden contradictions',()=>{
  for(const rule of [{unknown:1},{souvenir:1},{'$or':[]},{'$and':[null]},{unknown:'invalid'},'invalid']){
    const f=fixture();f.schema.questions[0].visible_if_json=rule;f.schema.config_hash=schemaService.hashSnapshot(f.schema.questions);
    assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN'});
  }
  const f=realFixture(4055);delete f.product.details.answers.size;f.product.details.answers.bird=1;
  assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN'});
  const hidden=realFixture();hidden.product.details.answers.stone_processing=0;
  assert.throws(()=>inspectLegacyInputs(hidden),{code:'FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN'});
});
test('bounded proof never treats exhausted optional parsing as unique',()=>{
  const f=fixture();f.schema.questions=Array.from({length:20},(_,i)=>({...skuQuestion('q'+i,'1'),required:0,sku_index:i,display_order:i}));
  f.schema.config_hash=schemaService.hashSnapshot(f.schema.questions);f.product.base_sku='SV'+'1'.repeat(10);f.product.full_sku=f.product.base_sku+'004';f.product.details.answers={};
  assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN'});
});

test('nullable current include_in_sku never proves non-SKU authority or masks a dependency',()=>{
  for(const kind of ['target','dependent']){
    const f=fixture();if(kind==='target')f.current.questions[1].include_in_sku=null;
    else f.current.questions.push({key:'nullable_sku',include_in_sku:null,visible_if_json:{color:0},options:[]});
    assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED'});
  }
});
