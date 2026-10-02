const {test}=require('node:test');
const assert=require('node:assert/strict');
const {adapterEvidence,CONTRACT}=require('../src/services/magento/configuration-option-labels');
const {signScopedOptionLabelRequest}=require('../src/services/magento/oauth');
const target={attributeId:1471,attributeCode:'suveniry',optionId:'5738'};
const raw={contractVersion:CONTRACT,...target,revision:'a'.repeat(64),labels:{all:'Скриньки',en:{storeId:9,label:'Boxes'}}};
test('scoped label adapter evidence binds exact identity, revision and explicit EN store; no stock REST inference',()=>{
  assert.deepEqual(adapterEvidence(raw,target,9),raw);
  for(const change of [{contractVersion:'unknown'},{optionId:'5739'},{attributeId:1472},{revision:''},{labels:{all:'Скриньки',en:null}},
    {labels:{all:'Скриньки',en:{storeId:10,label:'Boxes'}}}]) assert.throws(()=>adapterEvidence({...raw,...change},target,9));
  assert.throws(()=>adapterEvidence(raw,target,null));
});
test('typed scoped-label OAuth PUT cannot sign stock option PUT, arbitrary paths or query parameters',()=>{
  const credentials={consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
  const url='https://fixture.invalid/rest/all/V1/amber/attributes/suveniry/options/5738/labels';
  assert.match(signScopedOptionLabelRequest(url,credentials),/^OAuth /);
  for(const path of ['/rest/all/V1/products/attributes/suveniry/options/5738','/rest/all/V1/amber/attributes/suveniry/options/0/labels',
    '/rest/en/V1/amber/attributes/suveniry/options/5738/labels','/rest/all/V1/amber/attributes/suveniry/options/5738/labels?x=1'])
    assert.throws(()=>signScopedOptionLabelRequest('https://fixture.invalid'+path,credentials));
});
