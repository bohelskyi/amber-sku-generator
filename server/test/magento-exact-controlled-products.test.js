const test = require('node:test');
const assert = require('node:assert/strict');
const exact = require('../src/services/magento/exact-controlled-products');

test('exact SKU input is bounded and never mixes pagination or fuzzy search', () => {
  assert.deepEqual(exact.parseSkus({skus: JSON.stringify([' AG-1 ', 'A,%_'])}), ['AG-1', 'A,%_']);
  for (const query of [{skus:'[]'}, {skus:'null'}, {skus:'['}, {skus:JSON.stringify([''])},
    {skus:JSON.stringify(['a\n'])}, {skus:JSON.stringify(Array(101).fill('AG-1'))},
    {skus:JSON.stringify(['a'.repeat(101)])}, {skus:'["AG-1"]',search:''},
    {skus:'["AG-1"]',after:'0'}, {skus:'["AG-1"]',productId:'1'}]) {
    assert.throws(() => exact.parseSkus(query));
  }
});

test('exact resolver preserves independent missing, duplicate, scope and dispatch results', async () => {
  const calls=[];
  const rows=[{sku:'AG-1',current_count:1,product_id:1,category:'BR'},
    {sku:'AG-2',current_count:1,product_id:2,category:'BR'},
    {sku:'ARCHIVED',current_count:0,product_id:null,category:null},
    {sku:'FOREIGN',current_count:1,product_id:3,category:'NM'},
    {sku:'EXCLUDED',current_count:1,product_id:4,category:'BR',excluded:true},
    {sku:'AMBIGUOUS',current_count:2,category:'BR'}];
  const skus=['AG-1','AG-2','AG-1','AG','ARCHIVED','FOREIGN','EXCLUDED','AMBIGUOUS',"'; SELECT 1 --"];
  const client={query:async(sql,params)=>{calls.push({sql,params});return {rows};}};
  const inspect=async(_client,_config,input)=>{
    assert.ok(input.productIds.length===1 && [1,2].includes(input.productIds[0]));
    return {products:input.productIds.map(productId=>({productId,article:`AG-${productId}`,before:{},after:{},changed:false})),
      blockers:input.productIds.map(productId=>({productId,code:productId===1?'NAME_CONFLICT_OR_BASELINE_REQUIRED':'RECONCILIATION_REQUIRED'}))};
  };
  const result=await exact.resolve(client,{id:'binding',revision:2},{skus:JSON.stringify(skus),categoryCode:'BR'},inspect,{});
  assert.deepEqual(result.results.map(row=>row.state),['eligible','blocked','duplicate','missing','blocked','blocked','blocked','blocked','missing']);
  assert.deepEqual(result.results[0].blockers,['NAME_CONFLICT_OR_BASELINE_REQUIRED']);
  assert.deepEqual(result.results[5].blockers,['CATEGORY_SCOPE_MISMATCH']);
  assert.deepEqual(result.results[7].blockers,['PRODUCT_NOT_UNIQUE']);
  assert.equal(result.nextCursor,null);
  assert.equal(calls.length,1);
  assert.match(calls[0].sql,/i\.public_sku=ANY\(\$1::text\[\]\)/);
  assert.ok(!calls[0].sql.includes(skus.at(-1)));
  assert.deepEqual(calls[0].params,[[...new Set(skus)]]);
});

test('history-only exact identity remains blocked rather than falsely absent; no inspection is run', async () => {
  const result=await exact.resolve({query:async()=>({rows:[{sku:'RETIRED',current_count:0}]})},
    {id:'binding',revision:1},{skus:'["RETIRED","NEW"]'},()=>assert.fail('No eligible product'),{});
  assert.deepEqual(result,{products:[],results:[{sku:'RETIRED',state:'blocked',blockers:['PRODUCT_NOT_CURRENT_OR_EXCLUDED']},
    {sku:'NEW',state:'missing',blockers:[]}],nextCursor:null});
});
