// Offline measurement only: refuses every target except the canonical disposable
// clone. All Magento transport is replaced before loading business services.
const assert=require('node:assert/strict');
const target=new URL(process.env.DATABASE_URL || 'http://invalid');
assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'55432');
assert.equal(target.pathname,'/amber_wave2_scale_test');
globalThis.fetch=async()=>{throw new Error('Real HTTP is forbidden in this benchmark');};
const pool=require('../src/db/pool');
const bindings=require('../src/services/magento/binding.service');
const publication=require('../src/services/magento/binding-publication');
const gate=require('../src/services/full-product-cutover-gate');
const {insertProductFixture}=require('../integration-test/product-fixture');
async function main(){
  const headroom=Number(process.argv[2] || 0);assert.ok([0,4096].includes(headroom));
  const actor=Number((await pool.query("INSERT INTO application_users(status,display_name) VALUES('active','Disposable publication benchmark') RETURNING id")).rows[0].id);
  await pool.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
  const options={databasePool:pool,mutationContext:{actorUserId:actor}};
  const current=await bindings.getCurrentPublished('amber',options);
  const draft=await bindings.clonePublished(current.id,{expectedRevision:current.revision},options);
  if(headroom){
    const count=Number((await pool.query("SELECT count(*) FROM products WHERE status='active' AND corrected_to_product_id IS NULL")).rows[0].count);
    assert.ok(count<=headroom);
    const client=await pool.connect();
    try{
      await gate.begin(client);
      const added=await insertProductFixture(client,`INSERT INTO products(full_sku,category,weight,total_price_uah,details,sku_schema_version_id,
        magento_name_subject_ua,magento_name_subject_en,magento_name_override)
        SELECT 'BENCH-'||n,p.category,p.weight,p.total_price_uah,p.details,p.sku_schema_version_id,
          p.magento_name_subject_ua,p.magento_name_subject_en,p.magento_name_override
        FROM (SELECT * FROM products WHERE status='active' AND corrected_to_product_id IS NULL ORDER BY id LIMIT 1) p,
          generate_series(1,$1::int) n RETURNING id`,[headroom-count]);
      await client.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=ANY($1::int[])",[added.rows.map(p=>p.id)]);
      await gate.commit(client);
    }catch(e){await gate.rollback(client);throw e;}finally{await gate.release(client);client.release();}
  }
  const config={configured:true,baseUrl:'https://ambergalbin.store',consumerKey:'benchmark-key',consumerSecret:'benchmark-secret',accessToken:'benchmark-token',accessTokenSecret:'benchmark-token-secret'};
  const nodes=draft.bindings.attributes.flatMap(a=>a.evidence.categories || []).filter(d=>d.categoryId)
    .map(d=>({categoryId:String(d.categoryId),path:d.requestedPath,normalizedPath:d.normalizedPath,comparable:true}));
  const input={bindingRevisionId:draft.id,expectedRevision:draft.revision,expectedCurrentId:current.id};
  let peakHeap=0,peakRss=0;
  const sample=()=>{const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakRss=Math.max(peakRss,m.rss);};
  const measuredPool={connect:async()=>{
    const client=await pool.connect();return {query:async(...args)=>{sample();const r=await client.query(...args);sample();return r;},release:()=>client.release()};
  },query:(...args)=>pool.query(...args)};
  const measure=async(kind,operation)=>{
    globalThis.gc?.();peakHeap=0;peakRss=0;sample();const start=performance.now();const result=await operation();sample();
    console.log(JSON.stringify({kind,products:result.totalProducts ?? result.internal.local.totalProducts,ms:Math.round(performance.now()-start),
      evidenceBytes:kind==='preview'?Buffer.byteLength(JSON.stringify({...result,internal:undefined})):0,
      inputBytes:(result.internal?.local || result).inputBytes,maxPageBytes:(result.internal?.local || result).maxPageBytes,
      peakHeapMiB:Math.round(peakHeap/1048576),peakRssMiB:Math.round(peakRss/1048576),blockers:result.blockers?.length ?? 0}));return result;
  };
  const proof=await measure('preview',()=>publication.preview(config,input,{...options,databasePool:measuredPool,internal:true,
    discover:async()=>({schema:draft.schema,categories:nodes}),fetchImpl:async(url)=>new Response(JSON.stringify(
      new URL(url).pathname.endsWith('/categories')?{id:2,name:'Default',children_data:[]}:{items:[],total_count:0}),{headers:{'Content-Type':'application/json'}})}));
  await measure('publication_local',async()=>{
    const client=await measuredPool.connect();
    try{await gate.begin(client);await client.query('LOCK TABLE categories,questions,options,sku_schema_versions,products,product_full_export_state,magento_name_sync_states,magento_test_deletions IN SHARE MODE');
      const local=await publication.context(client,config,input);assert.equal(local.localHash,proof.internal.local.localHash);await gate.rollback(client);return local;
    }finally{await gate.release(client);client.release();}
  });
}
main().catch(e=>{console.error(e);if(e.details)console.error(JSON.stringify(e.details));process.exitCode=1;}).finally(()=>pool.end());
