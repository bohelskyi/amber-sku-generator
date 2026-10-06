const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createBatchObservation } = require('../src/services/magento/historical-batch-observation');
const operations = require('../src/services/historical-review-operations');
const config = { configured:true,baseUrl:'https://review-fixture.invalid',consumerKey:'fixture',consumerSecret:'fixture',accessToken:'fixture',accessTokenSecret:'fixture' };
const schema = () => ({ storeTopology:{storeGroups:[{root_category_id:2},{root_category_id:2},{root_category_id:3}]} });
const json = data => new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
test('48/70 item batches share only their own fresh schema/category observation and globally cap GET body concurrency at four',async()=>{
  let discoveries=0,roots=0,active=0,max=0;
  const options={discover:async()=>{discoveries++;return schema();},fetchImpl:async(url,init)=>{
    assert.equal(init.method,'GET');active++;max=Math.max(max,active);
    await new Promise(resolve=>setTimeout(resolve,2));active--;
    const u=new URL(url);
    if(u.pathname.endsWith('/categories')){roots++;return json({id:Number(u.searchParams.get('rootCategoryId')),children_data:[]});}
    return json({ok:true});
  }};
  for(const total of [48,70]) {
    const batch=createBatchObservation(config,options),seen=[];
    try {
      await batch.map(Array.from({length:total},(_,i)=>i),async i=>{
        const a=await batch.get(),b=await batch.get();assert.equal(a,b);
        await Promise.all(Array.from({length:4},()=>batch.fetchImpl('https://review-fixture.invalid/read',{method:'GET'})));
        return i;
      },(i,value)=>{assert.equal(i,value);seen.push(i);});
      assert.deepEqual(seen,Array.from({length:total},(_,i)=>i));
    } finally {batch.close();}
  }
  assert.equal(discoveries,2);assert.equal(roots,4);assert.equal(max,4);assert.equal(active,0);
});
test('a failed member settles its concurrent sibling and never consumes a partial selectable result',async()=>{
  const batch=createBatchObservation(config,{});let siblingFinished=false,consumed=0;
  try {
    await assert.rejects(batch.map([1,2,3],async i=>{
      if(i===1)throw Object.assign(new Error('fixture'),{code:'MAGENTO_NETWORK_ERROR'});
      await new Promise(resolve=>setTimeout(resolve,10));siblingFinished=true;
    },()=>consumed++),{code:'MAGENTO_NETWORK_ERROR'});
    assert.equal(siblingFinished,true);assert.equal(consumed,0);
  }finally{batch.close();}
});
test('deadline and stop abort slow GETs; writes and oversized response bodies are rejected',async()=>{
  const keepAlive=setTimeout(()=>{},1000);
  const slow=createBatchObservation(config,{deadlineAt:Date.now()+20,fetchImpl:(_url,init)=>new Promise((resolve,reject)=>{
    init.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),{once:true});
  })});
  try {await assert.rejects(slow.fetchImpl(config.baseUrl,{method:'GET'}));assert.throws(slow.check,{code:'HISTORICAL_OPERATION_DEADLINE'});}
  finally{slow.close();clearTimeout(keepAlive);}
  const batch=createBatchObservation(config,{fetchImpl:async()=>new Response(Buffer.alloc(8*1024*1024+1))});
  try {
    await assert.rejects(batch.fetchImpl(config.baseUrl,{method:'POST'}),{code:'HISTORICAL_PREVIEW_GET_ONLY'});
    await assert.rejects(batch.fetchImpl(config.baseUrl,{method:'GET'}),{code:'MAGENTO_RESPONSE_TOO_LARGE'});
  }finally{batch.close();}
});
test('operation input retains explicit CREATE and immutable confirmation membership and rejects caller-added worker controls',()=>{
  const id=randomUUID();assert.deepEqual(operations.request('preview',{skus:[' TEST-1 '],operationId:id}),{skus:['TEST-1']});
  assert.throws(()=>operations.request('preview',{skus:['TEST-1'],operationId:id,fetchImpl:'unsafe'}),{code:'MAGENTO_BINDING_INVALID'});
  const command={skus:['TEST-1'],selectedSkus:['TEST-1'],selectedCreateSkus:['TEST-1'],reviewNonce:randomUUID(),reviewHash:'a'.repeat(64),
    reviewToken:'b'.repeat(64),reviewExpiresAt:new Date(Date.now()+300000).toISOString(),idempotencyKey:id,confirmCurrentFactsAndStandardDelivery:true};
  assert.deepEqual(operations.request('confirm',command),command);
  assert.throws(()=>operations.request('confirm',{...command,selectedCreateSkus:['OTHER']}),{code:'HISTORICAL_CONFIRMATION_REQUIRED'});
  assert.throws(()=>operations.request('confirm',{...command,selectedSkus:['TEST-1','TEST-1']}),{code:'HISTORICAL_CONFIRMATION_REQUIRED'});
});
