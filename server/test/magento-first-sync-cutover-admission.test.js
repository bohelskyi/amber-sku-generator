const test=require('node:test'),assert=require('node:assert/strict');
const admission=require('../src/services/magento/first-sync-cutover-admission');
const repair=require('../src/services/export-exposure/repair-loader');
const {fixture}=require('./fixtures/first-sync-cutover-admission');
test('canonical cutover proof accepts the complete chain and rejects malformed entries without writes or network',async t=>{
  t.mock.method(globalThis,'fetch',()=>assert.fail('History qualification must never perform HTTP'));
  let retainedReads=0;
  t.mock.method(repair,'readRepairInput',async()=>{retainedReads++;return {
    products:[{id:7,full_sku:'SV7',public_sku:'SV7',category:'SV'}],registry:[{full_sku:'SV7',first_product_id:7}],
    snapshots:[],artifacts:[],members:[],revisions:[],events:[],state:[]};});
  const valid=fixture({malformed:false});assert.ok(await admission.proposal(valid.client,valid.config,valid.observation,valid.options));
  assert.equal(retainedReads,1);
  for(const malformed of [true,e=>[e,'entry'],e=>[e,{...e,productId:8,action:'ordinary_delivery'}],e=>[e,{...e}],e=>[e,{...e,productId:-1}]]) {
    const broken=fixture({malformed});assert.equal(await admission.proposal(broken.client,broken.config,broken.observation,broken.options),null);
    assert.ok(broken.queries.every(sql=>sql.startsWith('SELECT ')));
  }
  assert.equal(retainedReads,1,'malformed proof must fail before retained inventory loading');
});
