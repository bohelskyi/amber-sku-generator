const test=require('node:test');const assert=require('node:assert/strict');
const c=require('../src/services/product-integration-task-contract');
const id='11111111-1111-4111-8111-111111111111';
const product={categoryCode:'NM',answers:{extra:1},weight:1,pricingDecision:{mode:'manual_uah',manualPriceUah:100},photoIds:[]};
test('integration task commands are closed, bounded and bind the complete exact creation attempt',()=>{
  const command={clientRequestId:id,expectedPreviewToken:'a'.repeat(64),product};
  const captured=c.creationCommand(command);product.answers.extra=2;
  assert.equal(captured.product.answers.extra,1);
  assert.notEqual(c.creationCommand(command).requestHash,captured.requestHash);
  for(const invalid of [{...command,proof:'fake'},{...command,product:{...product,password:'secret'}},
    {...command,product:{...product,answers:{extra:{id:2}}}},{...command,expectedPreviewToken:'fake'},
    {...command,product:{...product,photoIds:[id,id]}}])assert.throws(()=>c.creationCommand(invalid),{code:'VALIDATION_ERROR'});
});
test('dedupe binds exact defect identity while text changes and publication revision do not spam new tasks',()=>{
  const readiness={scope:'native_characteristic_source_support',status:'configuration_required',categoryCode:'AR',questionKey:'size',
    valueId:'29',code:'SOURCE_SUPPORT_DEFERRED_VALUE',message:'review value'};
  const defect=c.defectOf(readiness);
  assert.equal(c.fingerprint(defect),c.fingerprint({...defect,message:'fresh labels'}));
  assert.notEqual(c.fingerprint(defect),c.fingerprint({...defect,valueId:'30'}));
  assert.throws(()=>c.defectOf({...readiness,status:'not_checked'}),{code:'INTEGRATION_TASK_NOT_REQUIRED'});
  const row={id,category_code:'AR',defect};
  const href=new URL(c.links(row,true).repairHref,'http://local.invalid');
  assert.equal(href.pathname,'/admin/magento/prepare');assert.equal(href.searchParams.get('category'),'AR');
  assert.equal(href.searchParams.get('value'),'29');assert.equal(href.searchParams.get('returnTo'),'/attention?integrationTask='+id);
  assert.equal(c.links(row,false).resumeHref,null);
});

test('TEST task serialization preserves strict namespace, binds request identity and rejects malformed/unvalidated flags',()=>{
  const normal={categoryCode:'SV',answers:{shape:33},weight:1};
  const command={clientRequestId:id,expectedPreviewToken:'b'.repeat(64),product:normal};
  const production=c.creationCommand(command);
  const testAttempt=c.creationCommand({...command,product:{...normal,isTestProduct:true}});
  assert.equal(testAttempt.product.isTestProduct,true);
  assert.equal(c.productPayload(JSON.parse(JSON.stringify(testAttempt.product))).isTestProduct,true);
  assert.notEqual(production.requestHash,testAttempt.requestHash);
  for(const flag of ['true','false',1,0,null,[],{}])assert.throws(()=>c.productPayload({...normal,isTestProduct:flag}),{code:'TEST_PRODUCT_FLAG_INVALID'});
  assert.throws(()=>c.productPayload({...normal,isTestProduct:true,enableWhenPhotosVerified:true}),{code:'TEST_PRODUCT_ENABLE_FORBIDDEN'});
  assert.equal(c.productPayload({...normal,isTestProduct:false}).isTestProduct,false);
});
