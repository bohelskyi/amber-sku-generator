const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const transport=require('../src/services/magento/historical-update-transport');
const {signExistingProductUpdateRequest}=require('../src/services/magento/oauth');
const c=require('../src/services/magento/binding-contract');
const config={configured:true,baseUrl:'https://adapter.invalid',consumerKey:'fixture',consumerSecret:'fixture',accessToken:'fixture',accessTokenSecret:'fixture'};
const proof={id:randomUUID(),public_sku:'BR3/space +&',remote_product_id:'123',origin_hash:c.originHash(config.baseUrl)};
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
test('strict authenticated adapter capability rejects absent, extra and permissive contracts before PUT',async()=>{
  for(const capability of [{},{...transport.CAPABILITY,productCreateAllowed:true},{...transport.CAPABILITY,atomic:false},{...transport.CAPABILITY,extra:true}]){
    let gets=0;
    await assert.rejects(transport.hideExisting(config,proof,{apply:true,fetchImpl:async(url,input)=>{assert.equal(input.method,'GET');assert.equal(input.redirect,'manual');gets++;return json(capability);}}),{code:'HISTORICAL_UPDATE_ONLY_ADAPTER_REQUIRED'});
    assert.equal(gets,1);
  }
});
test('hide and all/en native updates use only the exact-ID atomic endpoint, immutable operation key and closed payload',async()=>{
  const requests=[];const fetchImpl=async(url,input)=>{requests.push({url,input});return json(input.method==='GET'?transport.CAPABILITY:{id:123});};
  await transport.hideExisting(config,proof,{apply:true,fetchImpl});
  const put=requests.find(r=>r.input.method==='PUT');
  assert.equal(put.url,'https://adapter.invalid/rest/all/V1/amber/products/BR3%2Fspace%20%2B%26/existing/123');
  assert.equal(put.input.redirect,'manual');assert.ok(put.input.headers.Authorization.startsWith('OAuth '));
  const body=JSON.parse(put.input.body);assert.deepEqual(body.product,{sku:proof.public_sku,status:2,id:123});assert.equal(body.intentId,proof.id);assert.match(body.operationKey,/^[a-f0-9]{64}$/);
  await transport.dispatchExisting(config,proof,{domain:'storeViews',payload:{product:{sku:proof.public_sku,name:'Reviewed name'}}},{apply:true,fetchImpl,jobId:randomUUID()});
  assert.ok(requests.some(r=>r.url.includes('/rest/en/')&&r.input.method==='PUT'));
  assert.ok(requests.every(r=>r.input.method==='GET'||r.input.method==='PUT'));
});
test('missing/replaced counterparty and lost response never fall back to standard product upsert or retry',async()=>{
  let puts=0;
  await assert.rejects(transport.hideExisting(config,proof,{apply:true,fetchImpl:async(url,input)=>{if(input.method==='GET')return json(transport.CAPABILITY);puts++;return new Response('{}',{status:404});}}),{code:'HISTORICAL_ATOMIC_UPDATE_UNCERTAIN'});
  assert.equal(puts,1);
  await assert.rejects(transport.dispatchExisting(config,proof,{domain:'coreProduct',payload:{product:{sku:'OTHER'}}},{apply:true,fetchImpl:()=>assert.fail('No transport on mismatch')}),{code:'HISTORICAL_ATOMIC_UPDATE_INPUT_INVALID'});
  await assert.rejects(transport.dispatchExisting(config,proof,{domain:'createProduct',payload:{}},{apply:true}),{code:'HISTORICAL_CREATE_FORBIDDEN'});
});
test('dedicated signer refuses origin/scope/SKU/ID changes and every stock Magento product save endpoint',()=>{
  const valid='https://adapter.invalid/rest/all/V1/amber/products/BR3%2Fspace%20%2B%26/existing/123';
  assert.ok(signExistingProductUpdateRequest(valid,config,proof.public_sku,123));
  for(const url of [valid.replace('adapter.invalid','other.invalid'),valid.replace('/all/','/default/'),valid.replace('/123','/124'),valid+'?x=1',valid.replace('/amber/products/','/products/'), 'https://adapter.invalid/rest/all/V1/products'])assert.throws(()=>signExistingProductUpdateRequest(url,config,proof.public_sku,123),{code:'MAGENTO_INPUT_INVALID'});
});
test('referential category/inventory/website writers cannot escape the exact pinned identity',async()=>{
  for(const operation of [{domain:'categoryLinkSave',payload:{productLink:{sku:'OTHER',category_id:'1',position:0}}},
    {domain:'categoryLinkDelete',payload:{sku:'OTHER',categoryId:'1'}},{domain:'inventory',payload:{sourceItems:[{sku:proof.public_sku},{sku:'OTHER'}]}},
    {domain:'websites',payload:{productWebsiteLink:{sku:'OTHER',website_id:1}}}]){
    await assert.rejects(transport.dispatchExisting(config,proof,operation,{apply:true,fetchImpl:()=>assert.fail('No HTTP on identity mismatch'),dispatchOther:()=>assert.fail('No referential write on mismatch')}),{code:'HISTORICAL_REMOTE_IDENTITY_MISMATCH'});
  }
});
