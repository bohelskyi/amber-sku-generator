// Missing-only legacy SV inputs. Does not infer historical category flags,
// rewrite a frozen publication or confer first-sync/remote dispatch authority.
const c = require('./binding-contract');
const schemas = require('../sku-schema.service');
const { getRuleDependencies, isRuleMatched } = require('../../utils/rules');
const { normalizeDecimal } = require('./first-sync-field-plan');
const { parseVariationSku, parseVersionedSkuPart, decodeStoredSkuAnswers, appendSkuSuffix } = require('../../utils/sku');
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
// Rule inputs must have a defined historical meaning before they are evaluated.
// Unknown/self/forward references and malformed trees stay with reviewed recount.
function assertRule(rule, available, depth=0) {
  if(rule==null)return;
  if(depth>16 || typeof rule!=='object' || Array.isArray(rule))fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  for(const [key,value] of Object.entries(rule)) {
    if(key==='$and' || key==='$or') {
      if(!Array.isArray(value) || !value.length || value.length>32)fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
      for(const branch of value){if(branch==null)fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');assertRule(branch,available,depth+1);}
    } else if(!available.has(key) || (Array.isArray(value)?!value.length || value.length>256 || value.some(v=>!Number.isSafeInteger(v)):!Number.isSafeInteger(value))) {
      fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
    }
  }
}
function assertSupportedGrammar(schema) {
  if(schema.questions.length>32 || new Set(schema.questions.map(q=>q.key)).size!==schema.questions.length)fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  const available=new Set();
  for(const q of schema.questions){
    const codes=q.options.map(o=>String(o.sku_code));
    if(![0,1].includes(q.required) || !codes.length || codes.length>256
      || codes.some(code=>!/^\d+$/.test(code)) || new Set(codes).size!==codes.length
      || new Set(q.options.map(o=>o.value_id)).size!==codes.length
      || q.options.some(o=>!Number.isSafeInteger(o.value_id))
      || q.sku_separator && !/^[._/-]{1,3}$/.test(q.sku_separator))fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
    assertRule(q.visible_if_json,available);
    // Historical decoders do not apply option display rules. Admit their codes
    // as historical meanings, but do not evaluate an unknown rule context.
    for(const o of q.options){assertRule(o.visible_if_json,available);assertRule(o.hidden_if_json,available);}
    available.add(q.key);
  }
}
// Unlike the public first-success decoder, this proof explores every supported
// full/visible configured and compact path. Budget exhaustion never proves unique.
function enumerate(schema, encodedPart, answers) {
  let work=0;
  const results=new Map(),questions=schema.questions;
  const add=semantics=>results.set(c.hash(semantics),semantics);
  const separators=questions.some(q=>q.sku_separator && encodedPart.includes(q.sku_separator));
  function walk(index,remaining,semantics,context,visible,configured) {
    if(++work>10000)fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
    if(index===questions.length){if(!remaining)add(semantics);return;}
    const q=questions[index];
    if(visible && !isRuleMatched(q.visible_if_json,context)){walk(index+1,remaining,semantics,context,visible,configured);return;}
    const separator=configured?q.sku_separator:'';
    const next=(valueId,placeholder,rest)=>walk(index+1,rest,[...semantics,{key:q.key,valueId,placeholder}],
      {...context,[q.key]:placeholder?0:valueId},visible,configured);
    if(separator){
      if(!remaining.startsWith(separator))return;
      const rest=remaining.slice(separator.length),closing=rest.indexOf(separator);
      if(closing<0)return;
      const code=rest.slice(0,closing),tail=rest.slice(closing+separator.length);
      for(const o of q.options)if(o.sku_code===code)next(o.value_id,false,tail);
      if(q.required!==1 && code==='0' && !q.options.some(o=>o.sku_code==='0'))next(null,true,tail);
      return;
    }
    for(const o of q.options)if(remaining.startsWith(o.sku_code))next(o.value_id,false,remaining.slice(o.sku_code.length));
    if(q.required!==1){
      if(remaining.startsWith('0') && !q.options.some(o=>o.sku_code==='0'))next(null,true,remaining.slice(1));
      next(null,true,remaining);
    }
  }
  for(const visible of [false,true]){
    if(separators)walk(0,encodedPart,[],{},visible,true);
    walk(0,encodedPart.replace(/[._/-]/g,''),[],{},visible,false);
  }
  // Stored legacy layout permits explicit placeholders even for historically
  // required hidden questions. Never manufacture a real zero from such a token.
  const stored=decodeStoredSkuAnswers(questions,encodedPart,answers);
  if(stored)add(stored.map(a=>({key:a.key,valueId:a.value_id,placeholder:a.is_placeholder})));
  return [...results.values()];
}
function interpretations(product,schema,answers) {
  const variation=parseVariationSku(product.full_sku);
  if(variation.normalizedSku!==product.full_sku || !variation.baseFullSku.startsWith(product.category)) fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  const parsed=parseVersionedSkuPart(variation.baseFullSku.slice(product.category.length));
  if(parsed.version!==Number(schema.version)) fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  const prefix=product.category+parsed.marker,sequence=Number(product.sequence_number);
  if(typeof product.base_sku!=='string' || !product.base_sku.startsWith(prefix)
    || product.sequence_number==null || !Number.isSafeInteger(sequence) || sequence<0
    || appendSkuSuffix(product.base_sku,sequence)!==variation.baseFullSku)fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  const encodedPart=product.base_sku.slice(prefix.length),suffixRaw=String(sequence).padStart(3,'0');
  if(!encodedPart || encodedPart.length>256)fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  const results=new Map();
  for(const semantics of enumerate(schema,encodedPart,answers)){
      // Stored answers must agree with every supported interpretation, including
      // hidden omission. An absent stored answer cannot manufacture semantic zero.
      if(schema.questions.some(q=>{
        if(!present(answers[q.key]))return false;
        const a=semantics.find(answer=>answer.key===q.key);
        return !a || (a.placeholder ? String(answers[q.key])!=='0' : String(answers[q.key])!==String(a.valueId));
      })) {
        fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
      }
      const result={encodedPart,suffixRaw,semantics};
      results.set(c.hash(result),result);
  }
  if(results.size!==1)fail('FIRST_SYNC_LEGACY_IDENTITY_UNPROVEN');
  return {...[...results.values()][0],prefix,baseSku:product.base_sku,sequenceNumber:sequence,variationNumber:variation.variationNumber};
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
  assertSupportedGrammar(schema);
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
  return {proof:{version:2,sku:product.full_sku,schemaVersionId:schema.id,schemaHash:schema.config_hash,
    interpretation:before,currentSkuFlags:current.questions.map(q=>({key:q.key,includeInSku:q.include_in_sku})),...(hasWeight?{weightCompatibility:'sequence-or-rounded-weight'}:{})}};
}
module.exports={isLegacySv,inspectLegacyInputs};
