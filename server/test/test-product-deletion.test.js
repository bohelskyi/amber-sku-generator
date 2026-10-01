const test = require('node:test');
const assert = require('node:assert/strict');
const { signTestDeleteRequest, signSyncRequest } = require('../src/services/magento/oauth');
const { deleteSealedProduct } = require('../src/services/magento/test-deletion-transport');
const { originHash } = require('../src/services/magento/binding-contract');
const config = { baseUrl: 'https://delete.example.invalid', configured: true,
  consumerKey: 'fake-key', consumerSecret: 'fake-secret', accessToken: 'fake-access', accessTokenSecret: 'fake-access-secret' };
test('test deletion signer has a closed allocated-public-SKU route; ordinary sync cannot delete products', () => {
  assert.match(signTestDeleteRequest(`${config.baseUrl}/rest/all/V1/products/AG-000012`,config),/^OAuth /);
  for (const path of ['/rest/all/V1/products/LEGACY','/rest/en/V1/products/AG-000012',
    '/rest/all/V1/products/AG-000012?force=true','/rest/all/V1/products/AG-000012/other',
    '/rest/all/V1/products/AG-000012%2Fother']) {
    assert.throws(()=>signTestDeleteRequest(config.baseUrl+path,config),{code:'MAGENTO_INPUT_INVALID'});
  }
  assert.throws(()=>signSyncRequest(`${config.baseUrl}/rest/all/V1/products/AG-000012`,config,'DELETE'),{code:'MAGENTO_INPUT_INVALID'});
});
test('test deletion transport requires dispatch evidence, rejects redirects and never retries', async () => {
  let calls=0;
  const row={id:'sealed-id',state:'dispatched',dispatched_at:new Date(),public_sku:'AG-000012',
    remote_product_id:'812',origin_hash:originHash(config.baseUrl)};
  const fetchImpl=async(url,init)=>{calls++;assert.equal(url,`${config.baseUrl}/rest/all/V1/products/AG-000012`);
    assert.equal(init.redirect,'manual');assert.equal(init.method,'DELETE');assert.equal(init.body,undefined);
    return new Response(null,{status:302,headers:{location:'https://elsewhere.example.invalid'}});};
  await assert.rejects(deleteSealedProduct(config,{...row,state:'sealed'},{fetchImpl}),{code:'TEST_DELETE_INTENT_REQUIRED'});
  assert.equal(calls,0);
  await assert.rejects(deleteSealedProduct(config,row,{fetchImpl}),{code:'TEST_DELETE_UNCERTAIN'});
  assert.equal(calls,1);
});
