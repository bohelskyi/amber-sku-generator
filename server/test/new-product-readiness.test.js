const { test } = require('node:test');
const assert = require('node:assert/strict');
const { subjects } = require('../src/services/product/new-product-readiness');
const { getProductPreviewToken } = require('../src/services/product/product-signatures');
test('new SV name subjects follow the exact target route, with no defaults or partial pairs', () => {
  for (const souvenir of [1,5]) {
    assert.throws(()=>subjects('SV',{ answers:{souvenir} }),{statusCode:422});
    assert.throws(()=>subjects('SV',{ answers:{souvenir},magento_name_subject_ua:'Сокіл' }),{statusCode:422});
    assert.deepEqual(subjects('SV',{answers:{souvenir},magento_name_subject_ua:' Сокіл ',magento_name_subject_en:' falcon '}),{ua:'Сокіл',en:'falcon'});
  }
  assert.deepEqual(subjects('SV',{answers:{souvenir:6}}),{ua:null,en:null});
  assert.equal(subjects('KL',{}),null);
  assert.throws(()=>subjects('SV',{answers:{souvenir:6},magento_name_subject_ua:'one'}),{statusCode:422});
});
test('creation subjects bind preview tokens without changing generic recount preview tokens', () => {
  const p={weightVal:1,skuSchemaVersionId:1};
  const a={...p,newProductInput:{version:1,names:{ua:'Сокіл',en:'falcon'}}};
  const b={...a,newProductInput:{version:1,names:{ua:'Орел',en:'eagle'}}};
  assert.notEqual(getProductPreviewToken(a,'SV',{},null),getProductPreviewToken(b,'SV',{},null));
  assert.notEqual(getProductPreviewToken(a,'SV',{},null),getProductPreviewToken(p,'SV',{},null));
});
