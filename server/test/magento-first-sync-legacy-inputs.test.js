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
  assert.deepEqual(f.product,before);assert.equal(result.proof.version,1);assert.equal(result.proof.sku,'SV5004');
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
  f.product.full_sku='SV2/-5-0004-003';assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_WEIGHT_IDENTITY_REVIEW_REQUIRED'});
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
test('conditional, optional, duplicate or non-digit fixed codes require explicit historical review',()=>{
  for(const kind of ['conditional','optional','duplicate','separatorCode']){
    const f=fixture(),q=f.schema.questions[0];if(kind==='conditional')q.visible_if_json={souvenir:5};if(kind==='optional')q.required=0;
    if(kind==='duplicate')q.options.push({...q.options[0]});if(kind==='separatorCode')q.options[0].sku_code='-5-';
    f.schema.config_hash=schemaService.hashSnapshot(f.schema.questions);assert.throws(()=>inspectLegacyInputs(f));
  }
});

test('nullable current include_in_sku never proves non-SKU authority or masks a dependency',()=>{
  for(const kind of ['target','dependent']){
    const f=fixture();if(kind==='target')f.current.questions[1].include_in_sku=null;
    else f.current.questions.push({key:'nullable_sku',include_in_sku:null,visible_if_json:{color:0},options:[]});
    assert.throws(()=>inspectLegacyInputs(f),{code:'FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED'});
  }
});
