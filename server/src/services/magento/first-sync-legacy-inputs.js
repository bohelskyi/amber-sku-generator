// Missing-only legacy SV inputs. Does not infer historical category flags,
// rewrite a frozen publication or confer first-sync/remote dispatch authority.
const c = require('./binding-contract');
const schemas = require('../sku-schema.service');
const { getRuleDependencies } = require('../../utils/rules');
const { normalizeDecimal } = require('./first-sync-field-plan');
const { parseVariationSku, parseVersionedSkuPart, buildSkuSuffixDecodeAttempts,
  decodeStoredSkuAnswers, decodeSkuAnswers, decodeVisibleSkuAnswers, appendSkuSuffix } = require('../../utils/sku');
const fail = code => { throw c.error(409, code, code); };
const present = value => value !== undefined && value !== null && String(value).trim() !== '';
const isLegacySv = product => product.category === 'SV' && Boolean(product.full_sku)
  && product.sku_schema_version_id != null && product.characteristic_version_id == null;
function snapshotQuestions(questions) {
  return questions.map(q => Object.fromEntries(['key','label','sku_index','display_order','required','sku_separator','visible_if_json']
    .map(key => [key,q[key]]))).map((q,index) => ({...q,options:questions[index].options.map(o => ({
      value_id:Number(o.value_id),sku_code:String(o.sku_code),label:o.label,
      visible_if_json:o.visible_if_json || null,hidden_if_json:o.hidden_if_json || null,archived:Boolean(o.archived),
    }))}));
}
function assertIndependent(schema,current,keys) {
  const questions=[...schema.questions,...current.questions], affected=new Set(keys);
  let changed=true;
  while(changed){changed=false;for(const q of questions){
    const rules=[q.visible_if_json,...(q.options || []).flatMap(o => [o.visible_if_json,o.hidden_if_json])];
    if(rules.some(rule => getRuleDependencies(rule).some(key => affected.has(key))) && !affected.has(q.key)){
      affected.add(q.key);changed=true;
    }
  }}
  if(schema.questions.some(q => affected.has(q.key))
    || current.questions.some(q => q.include_in_sku!==0 && affected.has(q.key))) {
    fail('FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED');
  }
}
// Existing recursive decoders return their first successful parse. Do not
// mistake agreement between those first results for exhaustive uniqueness.
// The missing-only lane admits only an intrinsically unambiguous grammar.
function assertUnambiguousGrammar(schema) {
  if(new Set(schema.questions.map(q=>q.key)).size!==schema.questions.length)fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  for(const q of schema.questions){
    const codes=q.options.map(o=>String(o.sku_code));
    if(Number(q.required)!==1 || getRuleDependencies(q.visible_if_json).length
      || q.visible_if_json && Object.keys(q.visible_if_json).length || !codes.length
      || codes.some(code=>!/^\d+$/.test(code)) || new Set(codes).size!==codes.length
      || new Set(codes.map(code=>code.length)).size!==1)fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  }
}
function interpretations(product,schema,answers) {
  const variation=parseVariationSku(product.full_sku);
  if(variation.normalizedSku!==product.full_sku || !variation.baseFullSku.startsWith(product.category)) fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  const parsed=parseVersionedSkuPart(variation.baseFullSku.slice(product.category.length));
  if(parsed.version!==Number(schema.version)) fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  const results=new Map();
  for(const attempt of buildSkuSuffixDecodeAttempts(parsed.encodedWithSuffix)){
    for(const decoded of [decodeStoredSkuAnswers(schema.questions,attempt.encodedPart,answers),
      decodeSkuAnswers(schema.questions,attempt.encodedPart),decodeVisibleSkuAnswers(schema.questions,attempt.encodedPart)]){
      if(!decoded)continue;
      const semantics=decoded.map(a=>({key:a.key,valueId:a.value_id,placeholder:a.is_placeholder}));
      // Stored answers must agree with every supported interpretation, including
      // hidden omission. An absent stored answer cannot manufacture semantic zero.
      if(semantics.some(a=>present(answers[a.key]) && (a.placeholder
        ? String(answers[a.key])!=='0' : String(answers[a.key])!==String(a.valueId)))) {
        fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
      }
      const result={encodedPart:attempt.encodedPart,suffixRaw:attempt.suffixRaw,semantics};
      results.set(c.hash(result),result);
    }
  }
  if(results.size!==1)fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  return {...[...results.values()][0],prefix:product.category+parsed.marker,variationNumber:variation.variationNumber};
}
function inspectLegacyInputs({product,schema,current,patch,weight,hasWeight}) {
  if(!isLegacySv(product) || product.status!=='active' || product.corrected_to_product_id
    || !schema || schema.category_code!==product.category || String(schema.id)!==String(product.sku_schema_version_id)
    || !Array.isArray(schema.questions) || !schema.questions.length || current?.category_code!==product.category
    || !Array.isArray(current.questions) || schemas.hashSnapshot(snapshotQuestions(schema.questions))!==schema.config_hash) {
    fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  }
  const previous=product.details?.answers || {}, keys=Object.keys(patch);
  for(const key of keys){
    const targets=current.questions.filter(q=>q.key===key);
    if(schema.questions.some(q=>q.key===key) || targets.some(q=>q.include_in_sku!==0)) fail('FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED');
    if(targets.length!==1)fail('FIRST_SYNC_CANONICAL_TARGET_UNAVAILABLE');
    if(present(previous[key]))fail('FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED');
  }
  assertIndependent(schema,current,keys);
  assertUnambiguousGrammar(schema);
  const before=interpretations(product,schema,previous),after=interpretations(product,schema,{...previous,...patch});
  if(c.hash(before)!==c.hash(after))fail('FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED');
  if(hasWeight){
    if(present(product.weight) || present(previous.weight))fail('FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED');
    const decimal=normalizeDecimal(weight,3);
    if(!decimal || Number(decimal)<=0 || Number(decimal)>=100000000000
      || normalizeDecimal(Number(decimal),3)!==decimal)fail('FIRST_SYNC_CANONICAL_WEIGHT_INVALID');
    const base=before.prefix+before.encodedPart;
    let reconstructed=appendSkuSuffix(base,Math.round(Number(decimal)));
    if(before.variationNumber!==null)reconstructed+='-'+String(before.variationNumber).padStart(3,'0');
    if(!before.suffixRaw || product.base_sku!==base || reconstructed!==product.full_sku) {
      fail('FIRST_SYNC_LEGACY_WEIGHT_IDENTITY_REVIEW_REQUIRED');
    }
  }
  return {proof:{version:1,sku:product.full_sku,schemaVersionId:schema.id,schemaHash:schema.config_hash,
    interpretation:before,currentSkuFlags:current.questions.map(q=>({key:q.key,includeInSku:q.include_in_sku})),...(hasWeight?{weightCompatibility:'sequence-or-rounded-weight'}:{})}};
}
module.exports={isLegacySv,inspectLegacyInputs};
