const { test } = require('node:test');
const assert = require('node:assert/strict');
const helper = require('../src/services/magento/first-sync-canonical-inputs');
const configurations = require('../src/services/product/characteristic-config');
const prices = require('../src/services/product-price-change.service');
const currency = require('../src/services/currency.service');
const evaluator = require('../src/services/magento/binding-evidence-products');
const c = require('../src/services/magento/binding-contract');
function fixture() {
  const questions = [
    { key:'weight',input_type:'text',required:1,include_in_sku:0,visible_if_json:null,options:[],numeric_validation:{kind:'decimal',min:0,minInclusive:false,maxFractionDigits:3}},
    { key:'color',input_type:'options',required:0,include_in_sku:0,visible_if_json:null,options:[{value_id:0,label:'Clear'},{value_id:2,label:'Amber'}]},
  ];
  const frozen = { category_code:'SV',requires_weight:1,questions,config_hash:'a'.repeat(64) };
  const current = structuredClone(frozen);
  const key = c.hash({routeKey:'SV:all',rowId:'base',target:'kolir'});
  const product = {id:7,public_sku:'AG-000017',full_sku:null,category:'SV',characteristic_version_id:8,sku_schema_version_id:null,
    weight:null,total_price_uah:'200',details:{answers:{},manualPriceUah:200,keep:'history'}};
  const amber = {product,revision:{bindings:{routes:[],attributes:[{routeKey:'SV:all',rowId:'base',target:'kolir',strategy:'semantic_option',attributeCode:'kolir',transportTarget:null,reviewState:'approved'}],
    options:[{bindingKey:key,sourceKind:'semantic',amberGroup:'SV',questionKey:'color',valueId:'0',evaluatedOutput:'Clear',optionId:'remote-clear',reviewState:'approved'}],policies:[]}}};
  const weight = {field:{target:'vaha_vyrobu',scope:'all',after:'4.125',remote:{value:'4.125'}},meta:{persistence:'weight'}};
  const option = {field:{target:'kolir',scope:'all',after:'0',remote:{value:'remote-clear'}},meta:{persistence:'characteristic',source:{key:'color',routeKey:'SV:all'}}};
  return {product,amber,frozen,current,entries:[weight,option],weight,option};
}
async function run(f, operation, override={}) {
  const sql=[],decisions=[];
  const client={async query(text){sql.push(text);assert.doesNotMatch(text,/^(BEGIN|COMMIT|ROLLBACK|UPDATE|INSERT)/);return {rows:text.includes("a.event_key='product.recounted'") ? override.provenance || [] : []};}};
  const pricingModule = require('../src/services/pricing/pricing-context');
  const changes = [
    [configurations,'getCharacteristicVersion',async()=>f.frozen],
    [configurations,'readCharacteristicConfiguration',async()=>f.current],
    [currency,'assertUsdRateObservationCurrent',()=>{}],
    [pricingModule,'loadPricingContext',async()=>({categoryCode:'SV',category:{requires_weight:1},scenarios:[],matrixByCell:new Map(),weightBandsByScenario:new Map(),modifiers:[]})],
    [prices,'calculatePriceChange',async(product,decision,_,rate)=>{
      decisions.push(decision);assert.equal(product,f.product);
      return {totalPrice:5,totalPriceUah:override.final??200,pricePerGram:1.21212,uahRate:40,
        details:{...product.details,rateMetadata:{source:'override',date:'2026-10-09',stale:false,fetchedAt:rate.rateInfo.fetchedAt},calculatedPriceUah:100,autoPriceUah:100,manualPriceUah:decision.mode==='manual_uah'?200:null,
          ...(decision.mode==='usd_per_gram'?{customUsdPerGramBasis:{...product.details.customUsdPerGramBasis,source:'product_price_change'}}:{})}};
    }],
    [evaluator,'evaluate',(_,product)=>{
      assert.equal(product,f.product);assert.equal(product.weight,'4.125');
      return {base:{vaha_vyrobu:product.weight,kolir:override.output??'Clear'},issueFields:override.issues||[]};
    }],
  ];
  const restores=changes.map(([object,key,value])=>{const old=object[key];object[key]=value;return()=>object[key]=old;});
  // pricing.service reexports the context function by value, so reload the helper after patch.
  const service=require('../src/services/pricing.service'), old=service.loadPricingContext;
  service.loadPricingContext=pricingModule.loadPricingContext;
  const path=require.resolve('../src/services/magento/first-sync-canonical-inputs'); delete require.cache[path];
  const fresh=require(path);
  const args={amber:f.amber,entries:f.entries,answers:f.product.details.answers,rateObservation:{rateInfo:{rate:40}},lockCatalog:true};
  try{return await operation(()=>fresh.prepareCanonicalInputs(client,args),sql,decisions,args);}
  finally{service.loadPricingContext=old;restores.reverse().forEach(fn=>fn());delete require.cache[path];}
}
test('native weight mirror and semantic zero preserve identity and prepare updated manual baseline with exact fingerprint',async()=>{
  const f=fixture(),before=structuredClone(f.product);
  await run(f,async(prepare,sql,decisions)=>{
    const result=await prepare();assert.deepEqual(f.product,before);
    assert.equal(result.weight,'4.125');assert.deepEqual(result.pricing.details.answers,{weight:'4.125',color:'0'});
    assert.equal(result.pricing.details.keep,'history');assert.equal(result.pricing.details.manualPriceUah,200);
    assert.match(result.evidenceHash,/^[a-f0-9]{64}$/);assert.equal((await prepare()).evidenceHash,result.evidenceHash);
    assert.equal(decisions[0].mode,'manual_uah');assert.match(sql[0],/IN SHARE MODE NOWAIT/);
  });
});
test('mirrors and multiple weight targets cannot conflict or silently round',async()=>{
  for(const kind of ['mirror','aliases','scale','zero']){
    const f=fixture();if(kind==='mirror'){f.product.weight='5';f.product.details.answers.weight='6';}
    if(kind==='aliases')f.entries.push({...f.weight,field:{...f.weight.field,target:'decor_weight',after:'4.126'}});
    if(kind==='scale')f.weight.field.after='4.1251';if(kind==='zero')f.weight.field.after='0';
    await run(f,async prepare=>assert.rejects(prepare));
  }
});
test('new archived or hidden targets and options fail immutable and current membership',async()=>{
  for(const where of ['frozen','current'])for(const kind of ['questionArchived','hidden','optionArchived','missing']){
    const f=fixture(),q=f[where].questions[1];
    if(kind==='questionArchived')q.archived=true;if(kind==='hidden')q.visible_if_json={color:2};
    if(kind==='optionArchived')q.options[0].archived=true;if(kind==='missing')q.options=[];
    await run(f,async prepare=>assert.rejects(prepare));
  }
});
test('changing a dependency cannot hide an existing selected answer',async()=>{
  const f=fixture();f.product.details.answers={color:2,dependent:'stored'};
  for(const config of [f.frozen,f.current])config.questions.push({key:'dependent',input_type:'text',required:0,visible_if_json:{color:2},options:[]});
  await run(f,async prepare=>assert.rejects(prepare,{code:'FIRST_SYNC_CANONICAL_DEPENDENT_ANSWER_HIDDEN'}));
});
test('final price change requires explicit review and restores private product state',async()=>{
  const f=fixture(),before=structuredClone(f.product);
  await run(f,async prepare=>{await assert.rejects(prepare,{code:'FIRST_SYNC_CANONICAL_PRICE_REVIEW_REQUIRED'});assert.deepEqual(f.product,before);},{final:201});
});
test('automatic and custom USD modes remain their existing mode; custom provenance survives',async()=>{
  for(const mode of ['system_auto','usd_per_gram']){
    const f=fixture();delete f.product.details.manualPriceUah;
    f.product.price_per_gram=0;f.product.total_price=0;f.product.details.autoPriceUah=200;f.product.details.calculatedPriceUah=198;f.product.details.pricingScenario={price_mode:'fixed_uah'};
    if(mode==='usd_per_gram'){ f.product.weight='5';f.product.details.answers.weight='5';f.product.price_per_gram='1';f.product.uah_rate='40';f.product.total_price='5';
      f.product.details.calculatedPriceUah=200;delete f.product.details.pricingScenario;
      f.product.details.customUsdPerGramBasis={usdPerGram:1,marketingRoundingEnabled:true,source:'correction',requestId:99}; }
    const basis=structuredClone(f.product.details.customUsdPerGramBasis);
    await run(f,async(prepare,_,decisions)=>{const result=await prepare();assert.equal(decisions[0].mode,mode);
      if(basis)assert.deepEqual(result.pricing.details.customUsdPerGramBasis,basis);});
  }
});
test('missing or competing price-mode evidence cannot guess Manual UAH',()=>{
  for(const details of [{},{autoPriceUah:200},{manualPriceUah:199},{manualPriceUah:200,customUsdPerGramBasis:{usdPerGram:1}}])
    assert.throws(()=>helper.existingDecision({total_price_uah:200,details}),{code:'FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN'});
});
test('legacy encoded identity, mismatching frozen category and unproven forward mapping fail closed',async()=>{
  for(const kind of ['legacy','category','forward','issue']){
    const f=fixture();if(kind==='legacy')f.product.full_sku='SV-encoded';if(kind==='category')f.frozen.category_code='BR';
    await run(f,async prepare=>assert.rejects(prepare),{...(kind==='forward'?{output:'Wrong'}:{}),...(kind==='issue'?{issues:['kolir']}:{})});
  }
});
test('missing captured rate never falls back to live rate retrieval',async()=>{
  const f=fixture();await run(f,async(prepare,_,__,args)=>{args.rateObservation=null;await assert.rejects(prepare,{code:'FIRST_SYNC_CANONICAL_RATE_REQUIRED'});});
});

test('custom USD evidence cannot contradict stored historical economics or lack provenance',()=>{
  const f=fixture();f.product.weight='5';f.product.price_per_gram='1';f.product.uah_rate='40';f.product.total_price='5';
  f.product.details={answers:{weight:'5'},autoPriceUah:200,calculatedPriceUah:200,customUsdPerGramBasis:{usdPerGram:1,marketingRoundingEnabled:false,source:'correction'}};
  assert.equal(helper.existingDecision(f.product).mode,'usd_per_gram');
  for(const [key,value] of [['price_per_gram','2'],['weight',null],['total_price','6'],['uah_rate',null]]){
    const product=structuredClone(f.product);product[key]=value;
    assert.throws(()=>helper.existingDecision(product),{code:'FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN'});
  }
  delete f.product.details.customUsdPerGramBasis.source;
  assert.throws(()=>helper.existingDecision(f.product),{code:'FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN'});
});
test('current required physical weight and calibration mirrors require explicit coherent inputs',async()=>{
  const f=fixture();f.entries=[f.option];f.frozen.requires_weight=0;f.current.requires_weight=1;
  for(const configuration of [f.frozen,f.current])configuration.questions[0].required=0;
  await run(f,async prepare=>assert.rejects(prepare,{code:'FIRST_SYNC_CANONICAL_WEIGHT_REQUIRED'}));
  const g=fixture();g.option.meta.source.key='is_calibrated';
  await run(g,async prepare=>assert.rejects(prepare,{code:'FIRST_SYNC_CANONICAL_CALIBRATION_REVIEW_REQUIRED'}));
});

test('fresh rate observation times do not change economically identical canonical evidence',async()=>{
  const f=fixture();await run(f,async(prepare,_,__,args)=>{
    args.rateObservation.rateInfo.fetchedAt='2026-10-09T03:00:00Z';const a=await prepare();
    args.rateObservation.rateInfo.fetchedAt='2026-10-09T03:01:00Z';const b=await prepare();
    assert.notEqual(a.pricing.details.rateMetadata.fetchedAt,b.pricing.details.rateMetadata.fetchedAt);
    assert.equal(a.evidenceHash,b.evidenceHash);
    args.rateObservation.rateInfo.rate=41;
    // Stable comparison excludes observation time only; amounts/context stay bound.
    assert.equal(a.evidence.pricing.details.rateMetadata.source,'override');
  });
});

test('automatic evidence requires coherent historical calculated and selected amounts',()=>{
  const f=fixture();f.product.details={calculatedPriceUah:198,autoPriceUah:200,pricingScenario:{price_mode:'fixed_uah'}};
  f.product.price_per_gram=0;f.product.total_price=0;assert.equal(helper.existingDecision(f.product).mode,'system_auto');
  for(const [key,value]of [['calculatedPriceUah',1],['autoPriceUah',201]]){
    const p=structuredClone(f.product);p.details[key]=value;assert.throws(()=>helper.existingDecision(p),{code:'FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN'});
  }
  f.product.price_per_gram=1;assert.throws(()=>helper.existingDecision(f.product),{code:'FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN'});
});

test('actual recount basis has no fabricated source and requires its immutable lineage audit',async()=>{
  const f=fixture();f.product.weight='5';f.product.details.answers.weight='5';f.product.price_per_gram='1';f.product.uah_rate='40';f.product.total_price='5';
  f.product.corrected_from_product_id=3;
  f.product.details={answers:{weight:'5'},autoPriceUah:200,calculatedPriceUah:200,
    customUsdPerGramBasis:{usdPerGram:1,marketingRoundingEnabled:false,correctionRequestId:9},
    correction:{sourceProductId:3,sourceSku:'SV-old',reason:'Reviewed correction',changes:[]}};
  assert.equal(helper.existingDecision(f.product).mode,'usd_per_gram');
  const basis=structuredClone(f.product.details.customUsdPerGramBasis);
  await run(f,async prepare=>assert.rejects(prepare,{code:'FIRST_SYNC_CANONICAL_CUSTOM_PROVENANCE_UNPROVEN'}));
  await run(f,async prepare=>{const r=await prepare();assert.deepEqual(r.pricing.details.customUsdPerGramBasis,basis);
    assert.equal(r.evidence.provenance.auditId,'18');assert.equal(Object.hasOwn(r.pricing.details.customUsdPerGramBasis,'source'),false);
  },{provenance:[{id:18,status:'corrected',corrected_to_product_id:7,full_sku:'SV-old',details:{sourceSku:'SV-old',correctedProductId:7,correctionRequestId:9}}]});
});
