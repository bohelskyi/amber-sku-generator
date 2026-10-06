const test=require('node:test');
const assert=require('node:assert/strict');
const photos=require('../src/services/product-photos.service');
const media=require('../src/services/magento/product-media-delivery');
const {originHash}=require('../src/services/magento/binding-contract');

const config={configured:true,baseUrl:'https://magento.example.invalid',consumerKey:'mock-key',consumerSecret:'mock-secret',accessToken:'mock-token',accessTokenSecret:'mock-token-secret'};
const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
const bindingId='00000000-0000-4000-8000-000000000010';
const jobId='00000000-0000-4000-8000-000000000020';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE5sAAAAASUVORK5CYII=','base64');
function fixture(count=2, original=png) {
  const assets=Array.from({length:count},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`).map((id)=>({id,actor_user_id:7,product_id:1,content_hash:photos.sha(original),mime_type:'image/png',display_name:'photo.png',content:original}));
  const job={id:jobId,product_id:'1',public_product_identity_id:'11',version:'1',photo_ids:assets.map((a)=>a.id),enable_when_verified:count>0,
    actor_user_id:'7',required_permission:'products.create',state:'pending',origin_hash:null,binding_revision_id:null,remote_product_id:null,preservation:null,native_generation:null};
  job.intent_hash=photos.mediaIntent({id:1,public_product_identity_id:11},1,job.photo_ids,job.enable_when_verified);
  const product={id:1,public_product_identity_id:11,status:'active',corrected_to_product_id:null,public_sku:'AG-000001'};
  const state={job,assets,steps:new Map(),events:[],sql:[],native:{product_id:1,state:'synced',desired_generation:'1',synced_generation:'1'},
    nativeProof:{remote_product_id:101,origin_hash:originHash(config.baseUrl),acknowledged_at:'2026-10-04T12:00:00Z'},actorAllowed:true,activation:{enabled:true,installation_key:'test',actor_user_id:99},product,
    raw:{id:101,sku:'AG-000001',status:2,visibility:4,name:'Test',price:100,type_id:'simple',attribute_set_id:4,weight:5,
      custom_attributes:[{attribute_code:'example',value:'keep'}],extension_attributes:{website_ids:[1]},media_gallery_entries:[]},contents:new Map(),writes:[]};
  const db={async connect(){return {query:db.query,release(){}};},async query(sql,values=[]) {
    state.sql.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return {rows:[],rowCount:0};
    if (sql.includes('pg_try_advisory_lock'))return {rows:[{held:true}],rowCount:1};
    if (sql.includes('pg_advisory'))return {rows:[{}],rowCount:1};
    if (sql.includes("to_regclass('full_product_export_activation')"))return {rows:[{present:true}],rowCount:1};
    if (sql.includes('FROM full_product_export_activation'))return {rows:[{phase:'active',required_writer_version:1}],rowCount:1};
    if (sql.includes('SELECT u.status'))return {rows:[{status:'active',has_permission:state.actorAllowed}],rowCount:1};
    if (sql.includes('SELECT display_name'))return {rows:[{display_name:'Tester',preferred_username:'test'}],rowCount:1};
    if (sql.includes('INSERT INTO audit_events')){state.events.push(values[0]);return {rows:[{id:state.events.length}],rowCount:1};}
    if (sql.includes('FROM magento_auto_sync_activation'))return {rows:[state.activation],rowCount:1};
    if (sql.includes('FROM magento_binding_revisions'))return {rows:[{id:bindingId,origin_hash:originHash(config.baseUrl)}],rowCount:1};
    if (sql.includes('FROM products p'))return {rows:[state.product],rowCount:1};
    if (sql.includes('FROM product_visibility_intents')) {
      assert.equal(values[0],11);assert.match(sql,/state IN \('queued','dispatched'\)/);assert.match(sql,/FOR SHARE/);
      return {rows:state.visibilityPending ? [{}] : [],rowCount:state.visibilityPending ? 1 : 0};
    }
    if (sql.includes('FROM product_full_export_state'))return {rows:[{route:'normal',business_exclusion_state:'none',recount_compatibility_excluded:false}],rowCount:1};
    if (sql.includes('FROM magento_test_deletions'))return {rows:[],rowCount:0};
    if (sql.includes('FROM product_photo_sets'))return {rows:[{version:job.version,photo_ids:job.photo_ids,enable_when_verified:job.enable_when_verified}],rowCount:1};
    if (sql.includes('FROM magento_product_sync_requests'))return {rows:[state.native],rowCount:1};
    if (sql.includes('FROM magento_sync_jobs')) {
      assert.match(sql,/origin_hash=\$4/);assert.match(sql,/acknowledged_at IS NOT NULL/);assert.equal(values[3],originHash(config.baseUrl));
      const rows=state.nativeProof.origin_hash===values[3] && state.nativeProof.acknowledged_at ? [state.nativeProof] : [];
      return {rows,rowCount:rows.length};
    }
    if (sql.includes('SELECT * FROM product_media_jobs'))return {rows:[job],rowCount:1};
    if (sql.includes('FROM product_photo_assets')){
      if(sql.includes('JOIN products p')) {
        assert.match(sql,/p.public_product_identity_id=/);
        if(sql.includes('a.id=ANY'))assert.equal(String(values[1]),String(state.product.public_product_identity_id));
        else assert.equal(String(values[0]),String(state.product.public_product_identity_id));
      }
      const selected=sql.includes('a.id=ANY') ? assets.filter((asset)=>values[0].includes(asset.id)) : assets;
      return {rows:selected,rowCount:selected.length};
    }
    if (sql.includes('SELECT 1 FROM product_media_steps') && sql.includes('verified_at IS NULL'))return {rows:[...state.steps.values()].filter((s)=>!s.verified_at),rowCount:[...state.steps.values()].filter((s)=>!s.verified_at).length};
    if (sql.includes('FROM product_media_steps')){const found=state.steps.get(values[1] || (sql.includes("step_key='enable'") ? 'enable' : ''));return {rows:found ? [found]:[],rowCount:found ? 1:0};}
    if (sql.includes('INSERT INTO product_media_steps')) {
      assert.equal(state.steps.has(values[1]),false,'dispatch may never be repeated');
      state.steps.set(values[1],{job_id:values[0],step_key:values[1],operation_hash:values[2],dispatched_at:new Date().toISOString()});
      return {rows:[],rowCount:1};
    }
    if (sql.includes('UPDATE product_media_steps')){const step=state.steps.get(values[1]);step.verified_at=new Date().toISOString();step.remote_entry_id=values[2];return {rows:[],rowCount:1};}
    if (sql.includes('UPDATE product_media_jobs SET origin_hash')){Object.assign(job,{origin_hash:values[1],binding_revision_id:values[2],remote_product_id:values[3],native_generation:values[4],preservation:JSON.parse(values[5]),state:'running'});return {rows:[],rowCount:1};}
    if (sql.includes("UPDATE product_media_jobs SET state='succeeded'")){job.state='succeeded';job.verified_at=new Date().toISOString();job.failure_code=null;return {rows:[],rowCount:1};}
    if (sql.includes("UPDATE product_media_jobs SET state='pending'")){job.state='pending';job.failure_code=null;return {rows:[],rowCount:1};}
    if (sql.includes('UPDATE product_media_jobs SET state=$2')){job.state=values[1];job.failure_code=values[2];return {rows:[],rowCount:1};}
    throw new Error(`Unexpected mocked SQL: ${sql}`);
  }};
  const transport={
    async product(){return structuredClone(state.raw);},
    async entry(_sku,id){const entry=state.raw.media_gallery_entries.find((e)=>e.id===id);return {...structuredClone(entry),content:{type:'image/png',base64_encoded_data:state.contents.get(id)}};},
    async upload(_sku,asset,position){
      assert.equal(state.raw.status,2,'photos may only upload while disabled');
      assert.ok(state.steps.has(`upload:${asset.id}`),'dispatch must commit before HTTP');
      state.writes.push(`upload:${asset.id}`);
      if (state.failBeforeUpload===asset.id)throw new Error('Network uncertainty');
      const entryId=201+state.raw.media_gallery_entries.length;
      state.raw.media_gallery_entries.push({id:entryId,...media.metadata(asset,position),file:`/a/m/${asset.id}.png`});
      state.contents.set(entryId,asset.content.toString('base64'));
      if (state.failAfterUpload===asset.id)throw new Error('Lost POST response');
      return entryId;
    },
    async update(_sku,id,expected){state.writes.push(`update:${id}`);Object.assign(state.raw.media_gallery_entries.find((e)=>e.id===id),expected);},
    async status(_sku,status){assert.ok(state.steps.has(status===1 ? 'enable':'hide'));state.writes.push(`status:${status}`);state.raw.status=status;},
  };
  return {state,db,transport,run:(readOnly=false)=>media.processJob(config,job.id,{databasePool:db,transport,readOnly})};
}
test('validates canonical base64, PNG magic, dimensions and declared type',()=>{
  assert.equal(photos.imageType(png),'image/png');
  assert.equal(photos.validateUpload({idempotencyKey:ids[0],name:'фото.png',mimeType:'image/png',base64:png.toString('base64')}).hash,photos.sha(png));
  assert.throws(()=>photos.validateUpload({idempotencyKey:ids[0],name:'x.jpg',mimeType:'image/jpeg',base64:png.toString('base64')}),{code:'PHOTO_TYPE_MISMATCH'});
  assert.throws(()=>photos.decodeBase64(png.toString('base64')+'\n'));
  assert.throws(()=>photos.imageType(Buffer.from('<svg onload="alert(1)">malicious</svg>')),{code:'PHOTO_FORMAT_INVALID'});
  const huge=Buffer.from(png);huge.writeUInt32BE(12001,16);assert.throws(()=>photos.imageType(huge),{code:'PHOTO_FORMAT_INVALID'});
});
test('raw and encoded limits reject oversized content before decoding',()=>{
  assert.throws(()=>photos.decodeBase64('A'.repeat(4*Math.ceil(photos.MAX_PHOTO_BYTES/3)+4)),{code:'PHOTO_SIZE_LIMIT_EXCEEDED',statusCode:413});
  assert.throws(()=>photos.decodeBase64(Buffer.alloc(photos.MAX_PHOTO_BYTES+1).toString('base64')),{code:'PHOTO_SIZE_LIMIT_EXCEEDED',statusCode:413});
});
test('creation intent binds exact order and explicit enable',()=>{
  assert.deepEqual(photos.normalizeCreationPhotos({photoIds:ids}),{photoIds:ids,enableWhenVerified:false});
  assert.equal(photos.normalizeCreationPhotos({photoIds:ids,enableWhenPhotosVerified:true}).enableWhenVerified,true);
  assert.throws(()=>photos.normalizeCreationPhotos({photoIds:[ids[0],ids[0]]}),{code:'PHOTO_SELECTION_INVALID'});
  assert.throws(()=>photos.normalizeCreationPhotos({photoIds:ids,enableWhenPhotosVerified:'true'}),{code:'PHOTO_ENABLE_INVALID'});
});
test('multiple originals upload once, verify SHA/order/roles, then enable',async()=>{
  const f=fixture();assert.equal((await f.run()).state,'succeeded');
  assert.deepEqual(f.state.writes,[`upload:${ids[0]}`,`upload:${ids[1]}`,'status:1']);
  assert.equal(f.state.raw.visibility,4);assert.equal(f.state.raw.price,100);
  assert.deepEqual(f.state.raw.media_gallery_entries[0].types,['image','small_image','thumbnail']);
  assert.deepEqual(f.state.raw.media_gallery_entries[1].types,[]);
  assert.equal((await f.run()).state,'succeeded');assert.equal(f.state.writes.length,3);
});
test('without photos, explicit workflow keeps remote status disabled',async()=>{
  const f=fixture(0);f.state.raw.status=1;assert.equal((await f.run()).state,'succeeded');
  assert.deepEqual(f.state.writes,['status:2']);assert.equal(f.state.raw.status,2);
});
test('lost upload response is recovered through exact GET without duplicate POST',async()=>{
  const f=fixture(1);f.state.failAfterUpload=ids[0];assert.equal((await f.run()).state,'succeeded');
  assert.equal(f.state.writes.filter((w)=>w.startsWith('upload:')).length,1);
});
test('uncertain upload stays hidden and retries never issue a second POST',async()=>{
  const f=fixture(1);f.state.failBeforeUpload=ids[0];assert.equal((await f.run()).state,'uncertain');
  assert.equal(f.state.raw.status,2);assert.equal((await f.run(true)).state,'uncertain');
  assert.deepEqual(f.state.writes,[`upload:${ids[0]}`]);
});
test('partial upload recovery verifies original and resumes only remaining photos',async()=>{
  const f=fixture();f.state.failBeforeUpload=ids[1];assert.equal((await f.run()).state,'uncertain');
  const asset=f.state.assets[1];const entryId=202;
  f.state.raw.media_gallery_entries.push({id:entryId,...media.metadata(asset,2)});f.state.contents.set(entryId,png.toString('base64'));
  const result=await f.run(true);
  assert.equal(result.readOnly,true);assert.equal(f.state.job.state,'pending');assert.equal(f.state.raw.status,2);
  assert.equal((await f.run()).state,'succeeded');
  assert.equal(f.state.writes.filter((w)=>w===`upload:${ids[1]}`).length,1);
});
test('mismatched readback bytes cannot enable or acknowledge an upload',async()=>{
  const f=fixture(1);const upload=f.transport.upload;
  f.transport.upload=async(...args)=>{const id=await upload(...args);const wrong=Buffer.from(png);wrong[30]^=1;f.state.contents.set(id,wrong.toString('base64'));return id;};
  assert.equal((await f.run()).state,'uncertain');assert.equal(f.state.raw.status,2);assert.ok(!f.state.writes.includes('status:1'));
});
test('revocation, retired products and stale native generations block remote writes',async()=>{
  for (const change of [(state)=>{state.actorAllowed=false;},(state)=>{state.product.status='archived';},(state)=>{state.native.state='pending';}]) {
    const f=fixture(1);change(f.state);await f.run();assert.equal(f.state.writes.length,0);
  }
});
test('changed unrelated remote fields are held instead of overwritten',async()=>{
  const f=fixture(1);f.state.failBeforeUpload=ids[0];await f.run();f.state.raw.price=999;
  const result=await f.run(true);assert.equal(result.code,'PHOTO_REMOTE_CHANGED');assert.equal(f.state.raw.price,999);assert.equal(f.state.writes.length,1);
});
test('HTTP transport uses closed signed media API and verifies redirected failures',async()=>{
  const requests=[];const transport=media.createMediaTransport(config,{fetchImpl:async(url,options)=>{
    requests.push({url,options});return new Response(JSON.stringify(3418),{status:200,headers:{'content-type':'application/json'}});
  }});
  const f=fixture(1);await transport.upload('AG-000001',f.state.assets[0],1);
  assert.ok(requests[0].url.endsWith('/rest/all/V1/products/AG-000001/media'));assert.equal(requests[0].options.method,'POST');
  assert.equal(requests[0].options.redirect,'manual');assert.match(requests[0].options.headers.Authorization,/^OAuth /);
  const payload=JSON.parse(requests[0].options.body);assert.equal(payload.entry.content.base64_encoded_data,png.toString('base64'));
  assert.throws(()=>transport.status('AG-000001',4),{code:'PHOTO_STATUS_INVALID'});
  const redirect=media.createMediaTransport(config,{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://unsafe.example.invalid'}})});
  await assert.rejects(()=>redirect.upload('AG-000001',f.state.assets[0],1),{code:'PHOTO_MUTATION_UNCERTAIN'});
});
test('staging retries bind actor, exact bytes and filename to one durable token',async()=>{
  const f=fixture(0);const base=f.db.query;
  f.db.query=async(sql,values)=>{
    if (sql.includes('SELECT id,content_hash,mime_type,display_name FROM product_photo_assets')) {
      const rows=f.state.assets.filter((a)=>a.actor_user_id===values[0] && a.request_key===values[1]);return {rows,rowCount:rows.length};
    }
    if (sql.includes('SELECT count(*)::int AS count'))return {rows:[{count:0,bytes:0}],rowCount:1};
    if (sql.includes('INSERT INTO product_photo_assets')){
      f.state.assets.push({id:values[0],actor_user_id:values[1],request_key:values[2],content_hash:values[3],mime_type:values[4],display_name:values[5],content:values[6],product_id:null});return {rows:[],rowCount:1};
    }
    return base(sql,values);
  };
  const input={idempotencyKey:ids[0],name:'фото.png',mimeType:'image/png',base64:png.toString('base64')};
  const options={databasePool:f.db,mutationContext:{actorUserId:7,requestId:'stage-test'}};
  const first=await photos.stage(input,options);const second=await photos.stage(input,options);
  assert.equal(first.id,second.id);assert.equal(f.state.assets.length,1);assert.equal(f.state.events.filter((e)=>e==='product.photo_staged').length,1);
  await assert.rejects(()=>photos.stage({...input,name:'different.png'},options),{code:'PHOTO_IDEMPOTENCY_CONFLICT'});
  const other=await photos.stage(input,{...options,mutationContext:{actorUserId:8}});
  assert.notEqual(other.id,first.id);assert.equal(f.state.assets.length,2);
  f.state.actorAllowed=false;
  await assert.rejects(()=>photos.stage(input,options),{code:'INSUFFICIENT_PERMISSION'});
});
test('an actor cannot attach another actor unbound photo or another product original',async()=>{
  for (const asset of [{id:ids[0],actor_user_id:8,product_id:null},{id:ids[0],actor_user_id:7,product_id:2}]) {
    const f=fixture(0);const base=f.db.query;
    f.db.query=async(sql,values)=>{
      if(sql.includes('SELECT * FROM product_media_jobs WHERE actor_user_id'))return {rows:[],rowCount:0};
      if(sql.includes('SELECT * FROM product_photo_sets'))return {rows:[],rowCount:0};
      if(sql.includes('SELECT 1 FROM product_media_jobs'))return {rows:[],rowCount:0};
      if(sql.includes('SELECT a.id,a.actor_user_id,a.product_id'))return {rows:[asset],rowCount:1};
      return base(sql,values);
    };
    await assert.rejects(()=>photos.save(1,{idempotencyKey:ids[1],expectedVersion:'0',photoIds:[ids[0]],enableWhenVerified:true},
      {databasePool:f.db,mutationContext:{actorUserId:7}}),{code:'PHOTO_OWNERSHIP'});
    assert.equal(f.state.writes.length,0);
  }
});
test('save response loss recovers original actor/target/version/order intent',async()=>{
  const f=fixture(1);f.state.job.request_key=ids[1];
  const options={databasePool:f.db,mutationContext:{actorUserId:7}};
  const input={idempotencyKey:ids[1],expectedVersion:'0',photoIds:[ids[0]],enableWhenVerified:true};
  const result=await photos.save(1,input,options);
  assert.equal(result.jobId,jobId);assert.equal(result.version,'1');
  for (const changed of [{...input,expectedVersion:'1'},{...input,photoIds:[]},{...input,enableWhenVerified:false}]) {
    await assert.rejects(()=>photos.save(1,changed,options),{code:'PHOTO_IDEMPOTENCY_CONFLICT'});
  }
  await assert.rejects(()=>photos.save(2,input,options),{code:'PHOTO_IDEMPOTENCY_CONFLICT'});
});
test('hide dispatch must be acknowledged before any photo upload',async()=>{
  const f=fixture(1);f.state.raw.status=1;
  await f.run();assert.deepEqual(f.state.writes,['status:2',`upload:${ids[0]}`,'status:1']);
  assert.ok(f.state.steps.get('hide').verified_at);
});
test('successful enable with lost local acknowledgement reconciles without another write',async()=>{
  const f=fixture(1);await f.run();const writes=[...f.state.writes];
  f.state.job.state='uncertain';f.state.job.verified_at=null;f.state.steps.get('enable').verified_at=null;
  assert.equal((await f.run(true)).state,'succeeded');assert.deepEqual(f.state.writes,writes);
});
test('legacy immutable public articles use exactly one encoded segment',async()=>{
  const {signProductMediaRequest,signProductVisibilityRequest}=require('../src/services/magento/oauth');
  const {percentEncode}=require('../src/services/magento/oauth');
  const legacy='KL3/11131351005';const requests=[];
  const transport=media.createMediaTransport(config,{fetchImpl:async(url,options)=>{
    requests.push({url,options});return new Response('3418',{status:200,headers:{'content-type':'application/json'}});
  }});
  await transport.upload(legacy,fixture(1).state.assets[0],1);
  assert.ok(requests[0].url.endsWith(`/products/${percentEncode(legacy)}/media`));
  assert.match(signProductVisibilityRequest(`${config.baseUrl}/rest/all/V1/products/${percentEncode(legacy)}`,config,legacy),/^OAuth /);
  assert.throws(()=>signProductMediaRequest(`${config.baseUrl}/rest/all/V1/products/${legacy}/media`,config,'POST',undefined,legacy),{code:'MAGENTO_INPUT_INVALID'});
  assert.throws(()=>signProductVisibilityRequest(`${config.baseUrl}/rest/all/V1/products/${percentEncode(legacy)}?sku=another`,config,legacy),{code:'MAGENTO_INPUT_INVALID'});
  assert.throws(()=>signProductVisibilityRequest(`${config.baseUrl}/rest/all/V1/products/${percentEncode(legacy)}#fragment`,config,legacy),{code:'MAGENTO_INPUT_INVALID'});
  assert.throws(()=>signProductVisibilityRequest(`${config.baseUrl}/rest/all/V1/products/..`,config,'..'),{code:'MAGENTO_INPUT_INVALID'});
  assert.throws(()=>signProductVisibilityRequest('https://other.example.invalid/rest/all/V1/products/AG-000001',config,'AG-000001'),{code:'MAGENTO_INPUT_INVALID'});
  assert.throws(()=>signProductMediaRequest(`${config.baseUrl}/rest/all/V1/products/AG-000002/media`,config,'POST',undefined,'AG-000001'),{code:'MAGENTO_INPUT_INVALID'});
  for(const sku of ['KL%literal','KL?literal']) {
    assert.match(signProductVisibilityRequest(`${config.baseUrl}/rest/all/V1/products/${percentEncode(sku)}`,config,sku),/^OAuth /);
  }
});
test('Magento 2.4.6 metadata-only GET verifies bounded same-origin original without OAuth headers',async()=>{
  const calls=[];const asset=fixture(1).state.assets[0];
  const entry={id:201,...media.metadata(asset,1),file:'/a/m/amber_original.png'};
  const transport=media.createMediaTransport(config,{fetchImpl:async(url,options)=>{
    calls.push({url,options});
    return url.includes('/media/catalog/product/') ? new Response(png,{status:200,headers:{'content-type':'image/png'}})
      : new Response(JSON.stringify(entry),{status:200,headers:{'content-type':'application/json'}});
  }});
  const result=await transport.entry('AG-000001',201);
  assert.equal(photos.sha(photos.decodeBase64(result.content.base64_encoded_data)),asset.content_hash);
  assert.equal(calls.length,2);assert.match(calls[0].options.headers.Authorization,/^OAuth /);
  assert.equal(calls[1].url,`${config.baseUrl}/media/catalog/product/a/m/amber_original.png`);
  assert.equal(calls[1].options.headers.Authorization,undefined);assert.equal(calls[1].options.redirect,'manual');
  const unsafe=media.createMediaTransport(config,{fetchImpl:async()=>new Response(JSON.stringify({...entry,file:'/../../secret.png'}),{status:200,headers:{'content-type':'application/json'}})});
  await assert.rejects(()=>unsafe.entry('AG-000001',201),{code:'PHOTO_REMOTE_FILE_INVALID'});
  const redirected=media.createMediaTransport(config,{fetchImpl:async(url)=>url.includes('/media/catalog/product/')
    ? new Response(null,{status:302,headers:{location:'https://cdn.example.invalid/a.png'}})
    : new Response(JSON.stringify(entry),{status:200,headers:{'content-type':'application/json'}})});
  await assert.rejects(()=>redirected.entry('AG-000001',201),{code:'PHOTO_REMOTE_READ_FAILED'});
});

test('media delivery rejects cross-origin and unacknowledged native proofs before remote calls',async()=>{
  for(const change of [(proof)=>{proof.origin_hash=originHash('https://other.example.invalid');},(proof)=>{proof.acknowledged_at=null;}]) {
    const f=fixture(1);change(f.state.nativeProof);let reads=0;
    f.transport.product=async()=>{reads++;return structuredClone(f.state.raw);};
    const result=await f.run();assert.equal(result.code,'PHOTO_NATIVE_ACK_REQUIRED');
    assert.equal(reads,0);assert.deepEqual(f.state.writes,[]);assert.equal(f.state.steps.size,0);
  }
});
test('a stop requested during a media pass completes only the current job',async()=>{
  const f=fixture(1);const query=f.db.query;let stopping=false;let nextJobReads=0;
  f.db.query=async(sql,values)=>{
    if(sql.includes('SELECT j.id FROM product_media_jobs'))return {rows:[{id:jobId},{id:'second-job'}],rowCount:2};
    if(sql.includes('SELECT * FROM product_media_jobs') && values[0]==='second-job')nextJobReads++;
    return query(sql,values);
  };
  const status=f.transport.status;
  f.transport.status=async(...args)=>{await status(...args);stopping=true;};
  const results=await media.processPending(config,{databasePool:f.db,transport:f.transport,shouldStop:()=>stopping});
  assert.equal(results.length,1);assert.equal(results[0].state,'succeeded');assert.equal(nextJobReads,0);
  assert.deepEqual(await media.processPending(config,{databasePool:{query(){throw new Error('stopped runtime queried');}},shouldStop:()=>true}),[]);
});

test('photo attachment rejects queued and dispatched visibility authority before any mutation',async()=>{
  for(const visibilityState of ['queued','dispatched']) {
    const f=fixture(1);f.state.visibilityPending=visibilityState;
    await assert.rejects(()=>photos.attachCreatedProduct({query:f.db.query},1,{photoIds:[ids[0]],enableWhenVerified:true},{actorUserId:7}),
      {code:'PHOTO_VISIBILITY_UNRESOLVED',statusCode:409});
    assert.deepEqual(f.state.writes,[]);assert.deepEqual(f.state.events,[]);
    assert.equal(f.state.sql.some((sql)=>sql.includes('INSERT INTO product_media_jobs')),false);
  }
});
test('successor verification reuses predecessor originals without duplicate POST and locks native request before pinning',async()=>{
  const first=fixture();await first.run();
  const next=fixture();next.state.product.id=2;next.state.job.product_id='2';next.state.native.product_id=2;
  next.state.job.intent_hash=photos.mediaIntent(next.state.product,1,next.state.job.photo_ids,true);
  next.state.raw=structuredClone(first.state.raw);next.state.contents=new Map(first.state.contents);
  next.state.job.inherited_from_product_id='1';next.state.job.inherited_from_job_id='original-verified-job';
  const query=next.db.query;let requestLocked=false;
  next.db.query=async(sql,values)=>{
    if(sql.includes('FROM magento_product_sync_requests')){assert.match(sql,/FOR SHARE/);requestLocked=true;}
    if(sql.includes('UPDATE product_media_jobs SET origin_hash'))assert.equal(requestLocked,true);
    return query(sql,values);
  };
  assert.equal((await next.run()).state,'succeeded');
  assert.deepEqual(next.state.assets.map((asset)=>asset.product_id),[1,1]);
  assert.deepEqual(next.state.writes,['status:2','status:1']);
  assert.deepEqual(next.state.raw.media_gallery_entries.map((entry)=>entry.label),first.state.raw.media_gallery_entries.map((entry)=>entry.label));
});

function originalPng(size) {
  const tiny=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE5sAAAAASUVORK5CYII=','base64');
  const chunk=Buffer.alloc(size-tiny.length);
  chunk.writeUInt32BE(chunk.length-12,0);chunk.write('paDd',4,'ascii');
  let crc=0xffffffff;
  for(const byte of chunk.subarray(4,-4)) {
    crc^=byte;
    for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1) ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
  return Buffer.concat([tiny.subarray(0,-12),chunk,tiny.subarray(-12)]);
}

test('exactly 1 MiB original is accepted unchanged and one byte more fails before storage',async()=>{
  assert.equal(photos.MAX_PHOTO_BYTES,1048576);
  const bytes=originalPng(1048576);
  const payload={idempotencyKey:ids[0],name:'original.png',mimeType:'image/png',base64:bytes.toString('base64')};
  const valid=photos.validateUpload(payload);
  assert.deepEqual(valid.bytes,bytes);assert.equal(valid.hash,photos.sha(bytes));
  assert.equal(photos.imageType(originalPng(1048577)),'image/png');
  const tooLarge={...payload,base64:originalPng(1048577).toString('base64')};
  assert.equal(tooLarge.base64.length,payload.base64.length,'padding can hide one extra raw byte');
  let connections=0;
  await assert.rejects(()=>photos.stage(tooLarge,{databasePool:{connect(){connections++;throw new Error('storage must not start');}}}),
    {code:'PHOTO_SIZE_LIMIT_EXCEEDED',statusCode:413});
  assert.equal(connections,0);
});
test('eight 1 MiB originals retain exact bytes, aggregate 8 MiB, order and hashes through media delivery',async()=>{
  const bytes=originalPng(1048576),f=fixture(8,bytes);
  assert.equal(photos.photoIds(f.state.job.photo_ids).length,8);
  assert.throws(()=>photos.photoIds([...f.state.job.photo_ids,'00000000-0000-4000-8000-000000000009']),{code:'PHOTO_SELECTION_INVALID'});
  assert.equal(f.state.assets.reduce((total,a)=>total+a.content.length,0),8*1048576);
  assert.equal((await f.run()).state,'succeeded');
  assert.equal(f.state.writes.filter(w=>w.startsWith('upload:')).length,8);
  for(const [i,a] of f.state.assets.entries()) {
    assert.deepEqual(a.content,bytes);assert.equal(a.content_hash,photos.sha(bytes));
    assert.equal(f.state.contents.get(201+i),bytes.toString('base64'));
    assert.equal(f.state.raw.media_gallery_entries[i].position,i+1);
  }
});
test('previously stored 5 MiB originals still verify without changing bytes or upload admission',async()=>{
  const bytes=originalPng(5*1048576),f=fixture(1,bytes);
  assert.throws(()=>photos.validateUpload({idempotencyKey:ids[0],name:'old.png',mimeType:'image/png',base64:bytes.toString('base64')}),{code:'PHOTO_SIZE_LIMIT_EXCEEDED'});
  assert.equal((await f.run()).state,'succeeded');
  assert.deepEqual(f.state.assets[0].content,bytes);
  assert.equal(f.state.contents.get(201),bytes.toString('base64'));
  const entry={id:201,file:'/a/m/original.png'};
  const transport=media.createMediaTransport(config,{fetchImpl:async(url)=>url.includes('/media/catalog/product/')
    ? new Response(bytes,{status:200,headers:{'content-type':'image/png'}})
    : new Response(JSON.stringify(entry),{status:200,headers:{'content-type':'application/json'}})});
  const actual=await transport.entry('AG-000001',201);
  assert.deepEqual(photos.decodeBase64(actual.content.base64_encoded_data,photos.MAX_STORED_PHOTO_BYTES),bytes);
});

test('staging eight maximum-size photos stores 8 MiB of exact immutable originals',async()=>{
  const f=fixture(0),base=f.db.query,bytes=originalPng(1048576);
  f.db.query=async(sql,values)=>{
    if(sql.includes('SELECT id,content_hash,mime_type,display_name FROM product_photo_assets')) {
      const rows=f.state.assets.filter(a=>a.actor_user_id===values[0] && a.request_key===values[1]);return {rows,rowCount:rows.length};
    }
    if(sql.includes('SELECT count(*)::int AS count'))return {rows:[{count:f.state.assets.length,bytes:f.state.assets.reduce((sum,a)=>sum+a.content.length,0)}],rowCount:1};
    if(sql.includes('INSERT INTO product_photo_assets')) {
      f.state.assets.push({id:values[0],actor_user_id:values[1],request_key:values[2],content_hash:values[3],mime_type:values[4],display_name:values[5],content:values[6],product_id:null});
      return {rows:[],rowCount:1};
    }
    return base(sql,values);
  };
  for(let i=0;i<8;i++)await photos.stage({idempotencyKey:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
    name:`original-${i}.png`,mimeType:'image/png',base64:bytes.toString('base64')},{databasePool:f.db,mutationContext:{actorUserId:7}});
  assert.equal(f.state.assets.length,8);assert.equal(f.state.assets.reduce((sum,a)=>sum+a.content.length,0),8388608);
  for(const a of f.state.assets){assert.deepEqual(a.content,bytes);assert.equal(a.content_hash,photos.sha(bytes));}
  assert.equal(photos.photoIds(f.state.assets.map(a=>a.id)).length,8);
});

// Exact safe wire evidence for the one owned TEST photo. All transport/PG actions
// below are in-memory mocks; fixture files contain no session, secret or headers.
const wire=require('./fixtures/owned-test-media-wire.json');
const originalWireBytes=Buffer.from(wire.original.base64,'base64');
function wireFixture() {
  const f=fixture(1,originalWireBytes);const {state}=f;
  Object.assign(state.product,{id:5012,public_product_identity_id:4960,public_sku:'TEST-000001',is_test_product:true});
  Object.assign(state.assets[0],wire.local.asset,{product_id:5012,display_name:'owned-test.png',content:originalWireBytes});
  Object.assign(state.job,structuredClone(wire.local.job),{actor_user_id:'7',required_permission:'products.recount',
    native_generation:'1',origin_hash:originHash(config.baseUrl),binding_revision_id:bindingId});
  state.job.intent_hash=photos.mediaIntent(state.product,state.job.version,state.job.photo_ids,false);
  state.native.product_id=5012;state.nativeProof.remote_product_id=5816;
  state.raw=structuredClone(wire.remote.product);
  state.steps.clear();for(const step of wire.local.steps)state.steps.set(step.step_key,{...step,job_id:state.job.id});
  state.contents.set(13590,originalWireBytes.toString('base64'));
  return f;
}
const attribute=(raw,code)=>raw.custom_attributes.find((a)=>a.attribute_code===code);
const drop=(raw,codes)=>({...raw,custom_attributes:raw.custom_attributes.filter((a)=>!codes.includes(a.attribute_code))});
const sideEffects=['image_label','small_image_label','thumbnail_label','hover_image','listing_video','content_video'];
const addGalleryEffects=(raw,asset)=>{
  raw.custom_attributes=raw.custom_attributes.filter((a)=>!sideEffects.includes(a.attribute_code));
  raw.custom_attributes.push(...sideEffects.map((code,index)=>({attribute_code:code,value:index<3 ? media.label(asset) : 'no_selection'})));
};
test('actual wire legacy hash has one exact six-field absence proof; read-only reconcile completes without remote writes or rebase',async()=>{
  const f=wireFixture();assert.equal(photos.sha(originalWireBytes),wire.expected.contentHash);
  assert.equal(originalWireBytes.length,10998);assert.equal(media.preserved(f.state.raw),wire.comparison.currentPreservationHash);
  let matches=0;for(let mask=0;mask<64;mask++)if(media.preserved(drop(f.state.raw,sideEffects.filter((_c,i)=>mask&(1<<i))))===f.state.job.preservation.hash)matches++;
  assert.equal(matches,1);const originalPreservation=structuredClone(f.state.job.preservation);
  const stepBefore=structuredClone([...f.state.steps.values()]);let entryReads=0;
  const entry=f.transport.entry;f.transport.entry=async(...args)=>{entryReads++;return entry(...args);};
  assert.equal((await f.run(true)).state,'succeeded');assert.ok(entryReads>0);
  assert.deepEqual(f.state.writes,[]);assert.deepEqual(f.state.job.preservation,originalPreservation);
  assert.equal(f.state.steps.size,1);assert.equal(f.state.steps.values().next().value.operation_hash,stepBefore[0].operation_hash);
  assert.equal(f.state.steps.values().next().value.dispatched_at,stepBefore[0].dispatched_at);
  assert.ok(f.state.steps.values().next().value.verified_at);assert.equal(f.state.raw.status,2);
  assert.equal(f.state.sql.some((sql)=>sql.includes('UPDATE product_media_jobs SET origin_hash')),false);
});
test('legacy media effect proof refuses business, foreign media, metadata, original byte and dispatch drift',async()=>{
  const changes={
    name:f=>{f.state.raw.name+=' foreign';},price:f=>{f.state.raw.price++;},visibility:f=>{f.state.raw.visibility=3;},
    category:f=>{attribute(f.state.raw,'category_ids').value.reverse();},
    categoryPosition:f=>{f.state.raw.extension_attributes.category_links[0].position=9;},
    businessAttribute:f=>{attribute(f.state.raw,'has_enabled').value='1';},
    foreignLabel:f=>{attribute(f.state.raw,'image_label').value='foreign';},
    foreignHover:f=>{attribute(f.state.raw,'hover_image').value='/f/o/foreign.png';},
    foreignListing:f=>{attribute(f.state.raw,'listing_video').value='/f/o/foreign.png';},
    foreignContent:f=>{attribute(f.state.raw,'content_video').value='/f/o/foreign.png';},
    galleryLabel:f=>{f.state.raw.media_gallery_entries[0].label='foreign';},
    role:f=>{f.state.raw.media_gallery_entries[0].types=['image'];},
    position:f=>{f.state.raw.media_gallery_entries[0].position=2;},
    disabled:f=>{f.state.raw.media_gallery_entries[0].disabled=true;},
    mediaType:f=>{f.state.raw.media_gallery_entries[0].media_type='external-video';},
    content:f=>{f.state.contents.set(13590,png.toString('base64'));},
    entryIdentity:f=>{const entry=f.transport.entry;f.transport.entry=async(...args)=>({...await entry(...args),id:13591});},
    noDispatch:f=>{f.state.steps.clear();},
    receiptHash:f=>{f.state.steps.values().next().value.operation_hash='f'.repeat(64);},
    receiptJob:f=>{f.state.steps.values().next().value.job_id=jobId;},
    receiptTime:f=>{f.state.steps.values().next().value.dispatched_at=null;},
    acknowledgedEntryIdentity:f=>{f.state.steps.values().next().value.remote_entry_id=13591;},
  };
  for(const [name,change] of Object.entries(changes)){
    const f=wireFixture();change(f);const preservation=structuredClone(f.state.job.preservation);
    const result=await f.run(true);assert.equal(result.code,'PHOTO_REMOTE_CHANGED',name);
    assert.deepEqual(f.state.job.preservation,preservation,name);assert.deepEqual(f.state.writes,[],name);
    assert.equal([...f.state.steps.values()].some((step)=>step.verified_at),false,name);
  }
});
test('new media jobs seal v2 six-field before-values before upload and retain original full hash',async()=>{
  const f=fixture(2);const before=structuredClone(f.state.raw);
  const upload=f.transport.upload;f.transport.upload=async(...args)=>{
    assert.equal(f.state.job.preservation.version,2);
    assert.equal(f.state.job.preservation.hash,media.preserved(before));
    assert.deepEqual(Object.keys(f.state.job.preservation.mediaSideEffects),sideEffects);
    const result=await upload(...args);addGalleryEffects(f.state.raw,f.state.assets[0]);return result;
  };
  assert.equal((await f.run()).state,'succeeded');assert.equal(f.state.job.preservation.hash,media.preserved(before));
  assert.deepEqual(f.state.writes,[`upload:${ids[0]}`,`upload:${ids[1]}`,'status:1']);
});
test('v2 accepts only expected primary labels and absent-to-no_selection defaults while preserving prior foreign roles',async()=>{
  const f=fixture(1);const oldLabel='previous deliberate primary label';
  f.state.raw.custom_attributes.push({attribute_code:'image_label',value:oldLabel});
  const upload=f.transport.upload;f.transport.upload=async(...args)=>{const result=await upload(...args);addGalleryEffects(f.state.raw,f.state.assets[0]);return result;};
  assert.equal((await f.run()).state,'succeeded');
  assert.deepEqual(f.state.job.preservation.mediaSideEffects.image_label,{present:true,value:oldLabel});
  for(const code of sideEffects.slice(3)){
    const foreign=fixture(1);foreign.state.raw.custom_attributes.push({attribute_code:code,value:'/f/o/foreign.png'});
    const original=structuredClone(foreign.state.raw);const upload=foreign.transport.upload;
    foreign.transport.upload=async(...args)=>{const result=await upload(...args);addGalleryEffects(foreign.state.raw,foreign.state.assets[0]);return result;};
    const result=await foreign.run();assert.equal(result.code,'PHOTO_REMOTE_CHANGED',code);
    assert.equal(foreign.state.job.preservation.hash,media.preserved(original));
    assert.equal(foreign.state.steps.size,0);
    assert.deepEqual(foreign.state.writes,[]);
  }
});
test('unknown/malformed preservation versions and closed snapshots fail even with an unchanged hash',()=>{
  const raw=fixture(0).state.raw;const captured=media.capturePreservation(raw);
  assert.deepEqual(media.preservationCandidate(raw,captured,null),{unchanged:true});
  const variants=[{...captured,version:1},{...captured,version:3},{...captured,extra:true},
    {...captured,mediaSideEffects:{}},{...captured,mediaSideEffects:{...captured.mediaSideEffects,unknown:{present:false}}},
    {...captured,mediaSideEffects:{...captured.mediaSideEffects,image_label:{present:'false'}}},
    {...captured,mediaSideEffects:{...captured.mediaSideEffects,image_label:{present:true}}},
    {hash:captured.hash,extra:true}];
  for(const value of variants)assert.throws(()=>media.preservationCandidate(raw,value,null),{code:'PHOTO_REMOTE_CHANGED'});
});
test('v2 snapshot reconstruction itself must recover original hash and needs matching order/upload dispatch proof',async()=>{
  const f=wireFixture();const baseline=drop(f.state.raw,sideEffects);
  f.state.job.preservation=media.capturePreservation(baseline);
  const before=structuredClone(f.state.job.preservation);assert.equal((await f.run(true)).state,'succeeded');
  assert.deepEqual(f.state.job.preservation,before);assert.deepEqual(f.state.writes,[]);
  const malformed=wireFixture();malformed.state.job.preservation=media.capturePreservation(baseline);
  malformed.state.job.preservation.mediaSideEffects.image_label={present:true,value:'forged baseline'};
  assert.equal((await malformed.run(true)).code,'PHOTO_REMOTE_CHANGED');assert.deepEqual(malformed.state.writes,[]);
  const order=wireFixture();const expected=media.metadata(order.state.assets[0],1);
  order.state.steps.clear();order.state.steps.set(`order:${order.state.assets[0].id}`,{
    job_id:order.state.job.id,step_key:`order:${order.state.assets[0].id}`,dispatched_at:'2026-10-05T14:55:19.908Z',
    operation_hash:require('../src/services/magento/binding-contract').hash({sku:'TEST-000001',entryId:13590,expected}),
  });
  assert.equal((await order.run(true)).state,'succeeded');assert.deepEqual(order.state.writes,[]);
});

test('v2 remove-all clears only labels belonging to an exact disabled owned original and sealed removal operation',async()=>{
  const make=()=>{
    const f=wireFixture();f.state.job.photo_ids=[];f.state.job.enable_when_verified=false;
    f.state.job.intent_hash=photos.mediaIntent(f.state.product,f.state.job.version,[],false);
    f.state.job.preservation=media.capturePreservation(f.state.raw);f.state.job.state='pending';f.state.steps.clear();
    f.transport.update=async(_sku,id,expected)=>{
      f.state.writes.push(`update:${id}`);Object.assign(f.state.raw.media_gallery_entries[0],expected);
      f.state.raw.custom_attributes=f.state.raw.custom_attributes.filter((a)=>!sideEffects.slice(0,3).includes(a.attribute_code));
    };
    return f;
  };
  const f=make();const pinned=structuredClone(f.state.job.preservation);
  assert.equal((await f.run()).state,'succeeded');assert.equal(f.state.raw.status,2);
  assert.deepEqual(f.state.writes,['update:13590']);assert.deepEqual(f.state.job.preservation,pinned);
  assert.deepEqual(f.state.raw.media_gallery_entries[0].types,[]);assert.equal(f.state.raw.media_gallery_entries[0].disabled,true);
  assert.ok(f.state.steps.get(`remove:${f.state.assets[0].id}`).verified_at);
  const cases={
    label:state=>{state.raw.custom_attributes.push({attribute_code:'image_label',value:'foreign'});},
    price:state=>{state.raw.price++;},
    role:state=>{state.raw.media_gallery_entries[0].types=['image'];},
    content:state=>{state.contents.set(13590,png.toString('base64'));},
    receiptHash:state=>{state.steps.values().next().value.operation_hash='f'.repeat(64);},
    receiptAbsent:state=>{state.steps.clear();},
  };
  for(const [name,change] of Object.entries(cases)){
    const current=make();const update=current.transport.update;
    current.transport.update=async(...args)=>{await update(...args);change(current.state);};
    const result=await current.run();assert.equal(result.code,'PHOTO_REMOTE_CHANGED',name);
    assert.deepEqual(current.state.writes,['update:13590'],name);
    assert.equal([...current.state.steps.values()].some((step)=>step.verified_at),false,name);
  }
});
test('v2 reorder preserves original full hash and accepts primary label transition only after exact order dispatch',async()=>{
  const f=fixture(2);const upload=f.transport.upload;
  f.transport.upload=async(...args)=>{const result=await upload(...args);addGalleryEffects(f.state.raw,f.state.assets[0]);return result;};
  assert.equal((await f.run()).state,'succeeded');
  const prior=structuredClone(f.state.raw);f.state.job.id='00000000-0000-4000-8000-000000000021';
  Object.assign(f.state.job,{version:'2',state:'pending',preservation:null,native_generation:null,origin_hash:null,
    binding_revision_id:null,remote_product_id:null,verified_at:null,photo_ids:[ids[1],ids[0]]});
  f.state.job.intent_hash=photos.mediaIntent(f.state.product,2,f.state.job.photo_ids,true);f.state.steps.clear();f.state.writes=[];
  f.transport.update=async(_sku,id,expected)=>{
    f.state.writes.push(`update:${id}`);const target=f.state.raw.media_gallery_entries.find((e)=>e.id===id);
    Object.assign(target,expected);if(expected.types.length){
      for(const e of f.state.raw.media_gallery_entries)if(e!==target)e.types=[];
      addGalleryEffects(f.state.raw,f.state.assets.find((a)=>media.label(a)===expected.label));
    }
  };
  assert.equal((await f.run()).state,'succeeded');assert.equal(f.state.job.preservation.hash,media.preserved(prior));
  assert.deepEqual(f.state.writes,['status:2','update:202','update:201','status:1']);
  assert.equal(attribute(f.state.raw,'image_label').value,media.label(f.state.assets[1]));
});

test('malformed stored v2 jobs and inconsistent primary attribute labels never dispatch or acknowledge',async()=>{
  for(const change of [
    f=>{f.state.job.preservation={...media.capturePreservation(drop(f.state.raw,sideEffects)),version:3};},
    f=>{f.state.job.preservation=media.capturePreservation(drop(f.state.raw,sideEffects));
      f.state.job.preservation.mediaSideEffects.small_image_label={present:true,value:'unchanged foreign label'};
      attribute(f.state.raw,'small_image_label').value='unchanged foreign label';
      const baseline=drop(f.state.raw,sideEffects.filter((code)=>code!=='small_image_label'));
      f.state.job.preservation.hash=media.preserved(baseline);},
  ]){
    const f=wireFixture();change(f);const before=structuredClone(f.state.job.preservation);
    assert.equal((await f.run(true)).code,'PHOTO_REMOTE_CHANGED');assert.deepEqual(f.state.writes,[]);
    assert.deepEqual(f.state.job.preservation,before);assert.equal([...f.state.steps.values()].some((step)=>step.verified_at),false);
  }
});

test('actual wire GET-only reconciliation uses production HTTP metadata/original transport and emits no Magento POST or PUT',async()=>{
  const f=wireFixture();const requests=[];const pinned=structuredClone(f.state.job.preservation);
  const real=media.createMediaTransport(config,{fetchImpl:async(url,options={})=>{
    const parsed=new URL(url);requests.push({method:options.method || 'GET',path:parsed.pathname});
    assert.equal(options.method || 'GET','GET','reconcile may not emit a remote mutation');
    if(parsed.pathname==='/rest/all/V1/products'){
      assert.equal(parsed.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'),'TEST-000001');
      return new Response(JSON.stringify({items:[structuredClone(f.state.raw)],total_count:1}),{status:200,headers:{'Content-Type':'application/json'}});
    }
    if(parsed.pathname==='/rest/all/V1/products/TEST-000001/media/13590')return new Response(JSON.stringify(wire.remote.entry),{status:200,headers:{'Content-Type':'application/json'}});
    if(parsed.pathname==='/media/catalog/product'+wire.remote.entry.file){
      assert.equal(options.headers.Authorization,undefined,'public original must not receive OAuth credentials');
      return new Response(originalWireBytes,{status:200,headers:{'Content-Type':'image/png'}});
    }
    throw new Error('Unexpected mocked HTTP path '+parsed.pathname);
  }});
  Object.assign(f.transport,real);assert.equal((await f.run(true)).state,'succeeded');
  assert.ok(requests.some((r)=>r.path.endsWith('/media/13590')));
  assert.ok(requests.some((r)=>r.path.startsWith('/media/catalog/product/')));
  assert.equal(requests.every((r)=>r.method==='GET'),true);assert.deepEqual(f.state.writes,[]);
  assert.deepEqual(f.state.job.preservation,pinned);assert.equal(f.state.raw.status,2);
});
