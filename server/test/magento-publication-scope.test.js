const test=require('node:test');
const assert=require('node:assert/strict');
const {scan,LIMITS,checkEvidence,translateLimit}=require('../src/services/magento/publication-scope');
const local={draft:{originHash:'fixture'},current:null,next:{compiled:{definition:{}}},evidence:{}};
function database(count,{changeLast=false,overBytes=false}={}){
  let fetched=0,maxPage=0;
  return {get fetched(){return fetched;},get maxPage(){return maxPage;},query:async(sql,args)=>{
    if(sql.startsWith('WITH page'))return {rows:[{bytes:overBytes?LIMITS.inputPageBytes+1:100}]};
    if(sql.startsWith('SELECT COALESCE(sum(bytes)'))return {rows:[{bytes:0}]};
    if(sql.includes('SELECT p.*,i.public_sku')){
      const [last,limit]=args,rows=Array.from({length:Math.min(limit,Math.max(0,count-last))},(_,n)=>({
        id:last+n+1,public_product_identity_id:String(last+n+1),public_sku:`AG-${last+n+1}`,
        identity_evidence:{id:String(last+n+1)},export_state:{revision:changeLast && last+n+1===count?'2':'1'}}));
      fetched+=rows.length;maxPage=Math.max(maxPage,rows.length);return {rows};
    }
    return {rows:[]};
  }};
}
test('full-scope digest is ordered, repeatable and includes final-page lifecycle evidence; memory pages stay bounded',async()=>{
  const db=database(3323),a=await scan(db,local),b=await scan(database(3323),local);
  assert.equal(a.totalProducts,3323);assert.equal(db.fetched,3323);assert.equal(db.maxPage,128);assert.equal(a.localHash,b.localHash);
  assert.notEqual(a.localHash,(await scan(database(3323,{changeLast:true}),local)).localHash);
  assert.notEqual(a.localHash,(await scan(database(3324),local)).localHash);
});
test('release limits reject complete-scope overflow, oversized input before transfer, output bytes and elapsed runtime',async()=>{
  await assert.rejects(scan(database(4097),local),e=>e.code==='MAGENTO_PUBLICATION_LIMIT' && e.details.bound==='product_count');
  const db=database(1,{overBytes:true});await assert.rejects(scan(db,local),e=>e.details.bound==='input_page_bytes');assert.equal(db.fetched,0);
  assert.throws(()=>checkEvidence({text:'x'.repeat(LIMITS.evidenceBytes)}),e=>e.details.bound==='review_evidence_bytes');
  await assert.rejects(scan(database(1),local,{deadline:Date.now()-1}),e=>e.details.bound==='runtime');
  assert.throws(()=>translateLimit({code:'55P03'}),e=>e.details.bound==='lock_wait');
  assert.throws(()=>translateLimit({code:'57014'}),e=>e.details.bound==='runtime');
});
