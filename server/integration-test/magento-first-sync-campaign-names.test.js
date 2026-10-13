'use strict';
require('../test/setup-env');
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {promisify}=require('node:util'),{execFile}=require('node:child_process');
const {Pool,Client}=require('pg');
const fixture=require('../test/fixtures/magento-bindings');
const c=require('../src/services/magento/binding-contract');
const {insertProductFixture}=require('./product-fixture');
const first=require('../src/services/magento/first-sync.service');
const jobs=require('../src/services/magento/sync-job.service');
const ledger=require('../src/services/magento/first-sync-ledger');
const preview=require('../src/services/magento/sync-preview');
const targets=['meta_title','meta_description'],template=(target,scope)=>'Active NM '+scope+' '+target;
const serverRoot=path.resolve(__dirname,'..'),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const record=row=>Object.fromEntries(['target','scope','state','before','remote','after','source','mappingHash'].map(key=>[key,row[key]]));
async function snapshot(db){
 const data={};for(const {tablename}of(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  assert.match(tablename,/^[a-z_]+$/);data[tablename]=(await db.query(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) rows FROM (SELECT to_jsonb(t) j FROM public."${tablename}" t) entries`)).rows[0].rows;
 }return data;
}
async function setup(t){
 const source=new URL(process.env.TEST_DATABASE_URL||'');assert.equal(source.hostname,'127.0.0.1');assert.equal(source.port,'55432');assert.ok(source.pathname.endsWith('_test'));
 const name='amber_campaign_names_'+process.pid+'_test',control=new Client({connectionString:source.toString()});await control.connect();
 let db,created=false;const dir=await fs.mkdtemp(path.join(os.tmpdir(),'amber-campaign-names-'));
 t.after(async()=>{if(db)await db.end();if(created)await control.query('DROP DATABASE '+name);await control.end();await fs.rm(dir,{recursive:true,force:true});});
 assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1',[name])).rows[0].n,0);
 await control.query('CREATE DATABASE '+name);created=true;const target=new URL(source);target.pathname='/'+name;const url=target.toString();
 await promisify(execFile)(process.execPath,['-e',"require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});"],{cwd:serverRoot,env:{...process.env,DATABASE_URL:url}});
 db=new Pool({connectionString:url,max:4});t.mock.method(globalThis,'fetch',()=>assert.fail('Live HTTP forbidden in synthetic names fixture'));
    const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Names fixture Administrator') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
    for(const code of ['BR','NM','KL','CH','AR','SV'])await db.query('INSERT INTO categories(code,name) VALUES($1,$1)',[code]);
    const d=structuredClone(fixture.definition()),literal=value=>({op:'literal',value}),text=id=>({op:'text',input:{op:'source',id},trim:false,format:'scalar-v1',onAbsent:'empty'});
    d.sources={sku:d.sources.sku,weight:d.sources.weight,price:{kind:'product',field:'total_price_uah',type:'scalar'}};d.tables={};
    for(const group of d.groups)for(const row of group.rows){
      delete row.cells.kolir;delete row.cells.decor_weight;delete row.cells.dovzhyna_brasletu_diuimiv;
      row.cells.price=row.id==='base'?text('price'):literal('');
    }
    const nm=d.groups.find(g=>g.route==='NM');nm.rows[0].cells.decor_weight=text('weight');nm.rows[0].cells.product_websites=literal('fixture');
    for(const row of nm.rows)for(const target of targets)row.cells[target]=literal(template(target,row.id==='base'?'all':'en'));
    const raw=structuredClone(fixture.schema());raw.attributes.find(a=>a.attribute_code==='name').scope='store';
    Object.assign(raw.attributes.find(a=>a.attribute_code==='decor_weight'),{frontend_input:'text',options:[]});
    for(const [index,target]of targets.entries()){
      raw.attributes.push({attribute_id:950+index,attribute_code:target,frontend_input:index?'textarea':'text',scope:'store',options:[]});
      raw.attributeSets[0].attributeCodes.push(target);
    }
    raw.storeTopology.websites[0].default_group_id=802;raw.storeTopology.storeGroups[0].default_store_id=805;
    raw.storeTopology.storeViews.push({id:805,code:'default',name:'Ukrainian',website_id:801,store_group_id:802,is_active:true});
    const schema=c.normalizeSchema(raw),config={configured:true,baseUrl:'https://names-fixture.invalid',consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
    const options={databasePool:db,actorUserId:actor,mutationContext:{actorUserId:actor}};
    const family=await require('../src/services/export-templates/template.service').createTemplate({key:'names-' +randomUUID(),displayName:'Names fixture',definition:d},options);
    const version=await require('../src/services/export-templates/template.service').publishTemplate(family.id,{expectedRevision:family.draft.revision,expectedDefinitionHash:family.draft.definitionHash},options);
    const bindings=require('../src/services/magento/binding.service'),approved=fixture.approvedBindings(d,schema,'NM');
    const nativeTargets={attribute_set_code:'product.attribute_set_id',product_type:'product.type_id',product_websites:'product.extension_attributes.website_ids'};
    for(const a of approved.attributes)if(nativeTargets[a.target])a.transportTarget=nativeTargets[a.target];
    for(const p of approved.policies){
      const a=approved.attributes.find(a=>require('../src/services/magento/binding-validation').bindingKey(a.routeKey,a.rowId,a.target)===p.bindingKey);
      p.policy=a?.rowId==='english'&&['sku','product_type','attribute_set_code','store_view_code'].includes(a.target)?'magento_managed':'authoritative_create_update';
    }
    let binding=await bindings.createDraft({installationKey:'names-fixture',origin:config.baseUrl,templateVersionId:version.id,observedAt:'2026-10-12T00:00:00Z',schema},options);
    binding=await bindings.updateDraft(binding.id,{expectedRevision:binding.revision,bindings:approved},options);
    binding=await bindings.publishDraft(binding.id,{expectedRevision:binding.revision,expectedCurrentId:null},options);

 const remotes=new Map(),calls=[];let index=0;
 async function create(){
  const sku='NM-CAMPAIGN-NAMES-'+(++index),remoteId=90000+index;
  const p=(await insertProductFixture(db,"INSERT INTO products(full_sku,category,weight,total_price_uah,details) VALUES($1,'NM',132.300,1700,$2::jsonb) RETURNING *",[sku,JSON.stringify({answers:{},manualPriceUah:1700})])).rows[0];
  await db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1",[p.id]);
  remotes.set(sku,{id:remoteId,sku,attribute_set_id:8001,type_id:'simple',name:'',price:1650,status:1,visibility:4,
   custom_attributes:[{attribute_code:'decor_weight',value:132},...targets.map(target=>({attribute_code:target,value:'Remote all '+target}))],
   extension_attributes:{website_ids:[801],category_links:[]},en:{name:'',...Object.fromEntries(targets.map(target=>[target,'Remote en '+target]))}});
  return {sku,id:p.id,publicIdentityId:p.public_product_identity_id,remoteId};
 }
 const fetchImpl=async(url,init)=>{
  assert.equal(init.method,'GET');const u=new URL(url);calls.push({path:u.pathname,method:init.method});
  if(u.pathname.endsWith('/V1/products')){
   const sku=u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'),r=structuredClone(remotes.get(sku));assert.ok(r);
   if(u.pathname.includes('/rest/en/')){r.name=r.en.name;r.custom_attributes=targets.map(target=>({attribute_code:target,value:r.en[target]}));}
   delete r.en;return new Response(JSON.stringify({items:[r],total_count:1}),{headers:{'content-type':'application/json'}});
  }
  assert.ok(u.pathname.endsWith('/store/storeConfigs'),u.pathname);
  return new Response(JSON.stringify([{id:805,code:'default',website_id:801,locale:'uk_UA',base_currency_code:'UAH'},{id:804,code:'en',website_id:801,locale:'en_US',base_currency_code:'UAH'}]),{headers:{'content-type':'application/json'}});
 };
 const canonicalPreview=(config,input)=>preview.previewProduct(config,{...input,discover:async()=>binding.schema,categoryObservation:{trees:[],categoryFailures:[]}});
 const run={...options,preview:canonicalPreview,fetchImpl};
 // This is ordinary automatic-request activation in a disposable fixture, not a worker.
 // No worker is started, and every Magento transport call is GET-only.
 await db.query('UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2 WHERE singleton',[binding.installationKey,actor]);
 const f={db,url,name,dir,actor,binding,config,run,remotes,calls,create,canonicalPreview,fetchImpl};
 f.fields=async p=>ledger.readOnClient(db,{originHash:c.originHash(config.baseUrl),publicIdentityId:String(p.publicIdentityId)});
 f.readyNames=async p=>{
  const priorNames={all:'Синтетична назва '+p.sku,en:'Synthetic name '+p.sku};
  // A real previously-common name observation exists; the current template now
  // generates different names. Empty transport names during approvals are not
  // permission to overwrite that baseline. Restoring the exact prior remote
  // pair makes ordinary preview send_amber and first-sync adoption reviewable.
  await require('../src/services/magento/name-state').saveObservation(db,c.originHash(config.baseUrl),
   {public_product_identity_id:p.publicIdentityId},p.remoteId,{action:'confirm',amber:priorNames,remote:priorNames},priorNames);
  remotes.get(p.sku).name=priorNames.all;remotes.get(p.sku).en.name=priorNames.en;
 };
 f.publishNext=async()=>{
  let next=await bindings.createDraft({installationKey:binding.installationKey,origin:config.baseUrl,templateVersionId:version.id,observedAt:'2026-10-13T00:00:00Z',schema},options);
  next=await bindings.updateDraft(next.id,{expectedRevision:next.revision,bindings:approved},options);
  binding=await bindings.publishDraft(next.id,{expectedRevision:next.revision,expectedCurrentId:binding.id},options);f.binding=binding;
 };
 f.seed=async()=>{
  const p=await create(),review=await first.review(config,{sku:p.sku,bindingRevisionId:binding.id},run);
  const choices=review.fields.filter(row=>['price','decor_weight',...targets].includes(row.target)&&row.canKeepLocal).map(({target,scope})=>({target,scope,choice:'keep_local'}));
  assert.equal(choices.length,6,JSON.stringify(review));
  await first.apply(config,{sku:p.sku,bindingRevisionId:binding.id,previewToken:review.previewToken,choices},run);
  const current=await f.fields(p);assert.equal(current.fields.filter(row=>row.source?.decision==='keep_local').length,6);
  assert.ok(current.fields.filter(row=>row.target==='name').every(row=>row.state!=='name_received'));
  await f.readyNames(p);
  return p;
 };
 let artifactIndex=0;
 f.review=async products=>{
  const dir=path.join(f.dir,'review-'+(++artifactIndex));await fs.mkdir(dir);
  const input={items:products.map(p=>({sku:p.sku,productId:p.id,category:'NM',remoteProductId:p.remoteId,fields:[
   {target:'price',scope:'all',local:1700,remote:1650,policy:'manager_price'},
   {target:'decor_weight',scope:'all',local:'132.300',remote:132,policy:'manager_weight_rounding'},
   ...['all','en'].flatMap(scope=>targets.map(target=>({target,scope,local:template(target,scope),remote:'Remote '+scope+' '+target,policy:'amber_seo'})))]}))};
  const file=path.join(dir,'scope.json'),bytes=Buffer.from(JSON.stringify(input)+'\n');await fs.writeFile(file,bytes);
  const discovery=require('../scripts/first-sync-local-discovery'),aggregate=require('../scripts/first-sync-campaign-preview');
  const discoveryRuntime=discovery.createRuntime(serverRoot);discoveryRuntime.preview=canonicalPreview;
  const readOnly=new Pool({connectionString:url,max:1,options:'-c default_transaction_read_only=on'}),messages=[];
  const capture=s=>messages.push(JSON.parse(s));
  try{
   const before=await snapshot(db);
   const discoveryCode=await discovery.main(['--input',file,'--output-dir',path.join(dir,'discovery'),'--expected-database',name,'--actor-id',String(actor),'--installation-key',binding.installationKey],
    {runtime:discoveryRuntime,config,pool:readOnly,env:{},fetchImpl,print:capture,printError:capture});
   assert.equal(discoveryCode,0,await fs.readFile(path.join(dir,'discovery/results.jsonl'),'utf8'));
   const aggregateRuntime=aggregate.createRuntime(serverRoot),batch=aggregateRuntime.batch;
   aggregateRuntime.batch={...batch,preflight:(config,request,options)=>batch.preflight(config,request,{...options,preview:canonicalPreview})};
   const output=path.join(dir,'sealed');
   assert.equal(await aggregate.main(['--input',file,'--scope-sha256',sha(bytes),'--discovery-manifest',path.join(dir,'discovery/manifest.json'),'--output-dir',output,
    '--expected-database',name,'--actor-id',String(actor),'--installation-key',binding.installationKey],
    {runtime:aggregateRuntime,config,pool:db,env:{},fetchImpl,print:capture,printError:capture}),2,JSON.stringify(messages));
   const reviewBytes=await fs.readFile(path.join(output,'review.json')),review=JSON.parse(reviewBytes);
   assert.equal(review.nameOnlyPreview.length,products.length,JSON.stringify(review));
   await aggregate.loadReview(output,sha(reviewBytes),aggregateRuntime,{actor,database:name,installation:binding.installationKey,scopeHash:sha(bytes)});
   assert.deepEqual(await snapshot(db),before);
   return {directory:output,hash:sha(reviewBytes),review};
  }finally{await readOnly.end();}
 };
 f.runtime=()=>{
  const runtime=require('../scripts/first-sync-campaign-names').createRuntime(serverRoot);
  runtime.boundary={...runtime.boundary,observe:(config,input,options)=>jobs.recoveryBoundary.observe(config,input,{...options,preview:canonicalPreview})};
  return runtime;
 };
 f.invoke=async(review,mode,{output=path.join(dir,'run-'+(++artifactIndex)),...overrides}={})=>{
  const runner=require('../scripts/first-sync-campaign-names'),messages=[];
  const code=await runner.main(['--mode',mode,'--review',review.directory,'--review-sha256',review.hash,'--output',output,
   '--server-root',serverRoot,'--expected-database',name,'--actor-id',String(actor),'--installation-key',binding.installationKey],
  {runtime:f.runtime(),pool:db,config,env:{},fetchImpl,print:s=>messages.push(JSON.parse(s)),printError:s=>messages.push(JSON.parse(s)),...overrides});
  const journal=await fs.readFile(path.join(output,'results.jsonl'),'utf8').then(s=>s.trim().split('\n').map(JSON.parse)).catch(()=>[]);
  return {code,journal,messages,output};
 };
 return f;
}

function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function ready(promise){
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Synthetic concurrency barrier timeout')),10000);})]);}
 finally{clearTimeout(timer);}
}
async function blocked(db,pid,by){
 const until=Date.now()+5000;while(Date.now()<until){
  if((await db.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) yes',[pid,by])).rows[0].yes)return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }assert.fail('Expected PostgreSQL lock contention '+pid+' → '+by);
}
async function worker(url){
 const pool=new Pool({connectionString:url,max:1,statement_timeout:10000});const pid=(await pool.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 return {pool,pid};
}
async function noLocks(db,worker,key){
 assert.deepEqual((await db.query("SELECT mode,granted FROM pg_locks WHERE pid=$1 AND locktype='advisory'",[worker.pid])).rows,[]);
 assert.equal((await worker.pool.query('SELECT pg_backend_pid() pid')).rows[0].pid,worker.pid);
 const client=await db.connect();try{assert.equal((await client.query('SELECT pg_try_advisory_lock(hashtext($1)) locked',[key])).rows[0].locked,true);
  assert.equal((await client.query('SELECT pg_advisory_unlock(hashtext($1)) unlocked',[key])).rows[0].unlocked,true);
 }finally{client.release();}
}
test('names-only campaign preserves approved fields and uses the canonical name transaction',async t=>{
 const f=await setup(t);
 await t.test('fixture records genuine approved local choices before names become available',async()=>{
  const p=await f.seed();const {observation}=await jobs.recoveryBoundary.observe(f.config,{sku:p.sku,bindingRevisionId:f.binding.id},f.run);
  const base=await first.inspect(f.config,observation,f.run);assert.equal(base.mode,'first');
  assert.equal(base.prepared.rows.filter(row=>row.record.state==='name_received'&&!row.received).length,2,JSON.stringify(base.prepared));
  assert.deepEqual(base.blockers,[]);await f.review([p]);
 });

 await t.test('sealed names preview is read-only; canonical apply changes names, receipts and ordinary request generation only',async()=>{
  const p=await f.seed(),review=await f.review([p]),before=await snapshot(f.db),prior=await f.fields(p);
  const checked=await f.invoke(review,'preview');assert.equal(checked.code,0,JSON.stringify(checked));
  assert.deepEqual(await snapshot(f.db),before);
  const applied=await f.invoke(review,'apply');assert.equal(applied.code,0,JSON.stringify(applied));
  const after=await snapshot(f.db),current=await f.fields(p);
  const allowed=new Set(['products','product_full_export_state','magento_product_sync_requests','magento_name_sync_states',
   'magento_first_sync_sessions','magento_first_sync_fields','magento_first_sync_progress','audit_events']);
  for(const [table,rows]of Object.entries(before))if(!allowed.has(table))assert.deepEqual(after[table],rows,table);
  const oldProduct=before.products.find(row=>row.id===p.id),newProduct=after.products.find(row=>row.id===p.id);
  assert.deepEqual(newProduct.magento_name_override.values,{all:f.remotes.get(p.sku).name,en:f.remotes.get(p.sku).en.name});
  assert.deepEqual({...newProduct,magento_name_override:oldProduct.magento_name_override},oldProduct);
  assert.deepEqual(current.fields.filter(row=>row.target!=='name').map(record),prior.fields.filter(row=>row.target!=='name').map(record));
  assert.equal(current.fields.filter(row=>row.target==='name'&&row.state==='name_received').length,2);
  for(const table of ['magento_first_sync_fields','magento_first_sync_progress','audit_events']){
   const afterKeys=new Map(after[table].map(row=>[c.hash(row),row]));for(const row of before[table])assert.ok(afterKeys.has(c.hash(row)),table+' old immutable row');
  }
  const oldRequest=before.magento_product_sync_requests.find(row=>row.product_id===p.id),newRequest=after.magento_product_sync_requests.find(row=>row.product_id===p.id);
  assert.equal(BigInt(newRequest.desired_generation),BigInt(oldRequest.desired_generation)+1n);
  assert.equal(newRequest.state,'pending');assert.equal(newRequest.active_job_id,null);
  assert.equal(after.magento_sync_jobs.length,before.magento_sync_jobs.length);
  const receipt=applied.journal.find(row=>row.type==='receipt');assert.equal(receipt.status,'recorded');assert.equal(receipt.result.localChanged,true);
  assert.equal(receipt.deliveryEffect.directRemoteWrites,0);assert.equal(receipt.deliveryEffect.directlyEnqueuedJobs,0);
  assert.match(receipt.deliveryEffect.ordinaryAutomaticRequest,/generation/);
  const durable=(await f.db.query('SELECT command_hash,command,actor_user_id,result FROM magento_first_sync_progress WHERE session_id=$1 AND revision=$2',[receipt.result.sessionId,receipt.result.revision])).rows[0];
  assert.equal(durable.command_hash,receipt.proof.commandHash);assert.equal(c.hash(durable.command),receipt.proof.commandHash);
  assert.equal(Number(durable.actor_user_id),f.actor);
  const resumed=await f.invoke(review,'resume',{output:applied.output});assert.equal(resumed.code,0,JSON.stringify(resumed));
  assert.deepEqual(await snapshot(f.db),after);
 });

 await t.test('durable receipt resumes only untouched items after interruption, with no duplicate name write',async()=>{
  const products=[await f.seed(),await f.seed()],review=await f.review(products);let interrupted=false;
  const stopped=await f.invoke(review,'apply',{print:message=>{const row=JSON.parse(message);if(row.status==='recorded'&&!interrupted){interrupted=true;throw Error('Synthetic process interruption after durable receipt');}}});
  assert.equal(stopped.code,1);assert.equal(stopped.journal.filter(row=>row.type==='receipt').length,1);
  const firstProgress=await f.fields(products[0]),firstRequest=(await f.db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1',[products[0].id])).rows[0];
  const resumed=await f.invoke(review,'resume',{output:stopped.output});assert.equal(resumed.code,0,JSON.stringify(resumed));
  assert.deepEqual(await f.fields(products[0]),firstProgress);
  assert.deepEqual((await f.db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1',[products[0].id])).rows[0],firstRequest);
  assert.equal((await f.fields(products[1])).fields.filter(row=>row.state==='name_received').length,2);
 });
 await t.test('unknown result after real COMMIT stops tail and resume without repeating the write',async()=>{
  const products=[await f.seed(),await f.seed()],review=await f.review(products);let commits=0;
  const unknown=await f.invoke(review,'apply',{runNameCommit:async(...args)=>{commits++;await require('../scripts/first-sync-name-commit').runNameCommit(...args);throw Object.assign(Error('Synthetic lost caller acknowledgement'),{unconfirmed:true});}});
  assert.equal(unknown.code,2,JSON.stringify(unknown));assert.equal(commits,1);
  assert.equal(unknown.journal.find(row=>row.type==='receipt').status,'unconfirmed');
  assert.equal((await f.fields(products[0])).fields.filter(row=>row.state==='name_received').length,2);
  assert.equal((await f.fields(products[1])).fields.filter(row=>row.state==='name_received').length,0);
  const after=await snapshot(f.db),gets=f.calls.length,resume=await f.invoke(review,'resume',{output:unknown.output});
  assert.equal(resume.code,1);assert.ok(resume.messages.some(row=>row.code==='CAMPAIGN_NAMES_JOURNAL_UNCONFIRMED'));
  assert.deepEqual(await snapshot(f.db),after);assert.equal(f.calls.length,gets);
 });
 const drifts={
  remote_name:p=>{f.remotes.get(p.sku).en.name+=' changed';},
  remote_identity:p=>{f.remotes.get(p.sku).id+=10000;},
  empty_name:p=>{f.remotes.get(p.sku).name='';},
  approved_price:p=>{f.remotes.get(p.sku).price=1900;},
  local_source:p=>f.db.query('UPDATE products SET weight=133 WHERE id=$1',[p.id]),
  lifecycle:p=>f.db.query("UPDATE product_full_export_state SET business_exclusion_state='excluded',delivery_version=delivery_version+1 WHERE product_id=$1",[p.id]),
  protected_work:p=>f.db.query(`INSERT INTO product_media_jobs(id,product_id,public_product_identity_id,version,photo_ids,enable_when_verified,actor_user_id,request_key,required_permission,intent_hash)
   VALUES($1,$2,$3,1,'{}',FALSE,$4,$5,'products.create',$6)`,[randomUUID(),p.id,p.publicIdentityId,f.actor,randomUUID(),c.hash(p)]),
 };
 for(const [name,change]of Object.entries(drifts))await t.test(name+' drift rejects stale names review atomically',async()=>{
  const p=await f.seed(),review=await f.review([p]);await change(p);const before=await snapshot(f.db),result=await f.invoke(review,'apply');
  assert.equal(result.code,2,JSON.stringify(result));assert.equal(result.journal.find(row=>row.type==='receipt')?.status,'blocked');
  assert.equal(result.journal.some(row=>row.type==='prepared'),false);assert.deepEqual(await snapshot(f.db),before);
 });

 for(const order of ['revocation_first','names_first'])await t.test('Administrator pin serializes '+order+' on the same backend and releases all locks',async()=>{
  const p=await f.seed(),actor=Number((await f.db.query("INSERT INTO application_users(status,display_name) VALUES('active','Concurrent fixture Administrator') RETURNING id")).rows[0].id);
  await f.db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
  const assignment=Number((await f.db.query('SELECT id FROM user_role_assignments WHERE application_user_id=$1 AND revoked_at IS NULL',[actor])).rows[0].id);
  const role=Number((await f.db.query("INSERT INTO roles(role_key,display_name,description) VALUES($1,$1,'Synthetic pin race') RETURNING id",['race_publisher_'+order])).rows[0].id);
  await f.db.query("INSERT INTO role_permissions(role_id,permission_key) VALUES($1,'export_templates.publish')",[role]);
  const names=await worker(f.url),revoker=await worker(f.url),atPin=deferred(),allowNames=deferred(),atRevoke=deferred(),allowRevoke=deferred();
  const trace=[],runtime=f.runtime(),admin=runtime.publication.administrator,run={...f.run,actorUserId:actor};
  const pinPool={connect:async()=>{const client=await names.pool.connect();return {release:error=>client.release(error),query:async(sql,args)=>{
   trace.push({sql,pid:(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid});return client.query(sql,args);
  }};}};
  const revokePool={connect:async()=>{const client=await revoker.pool.connect();return {release:error=>client.release(error),query:async(sql,args)=>{
   if(order==='revocation_first'&&sql==='COMMIT'){atRevoke.resolve();await allowRevoke.promise;}return client.query(sql,args);
  }};}};
  runtime.publication={...runtime.publication,administrator:async(client,id)=>{
   await admin(client,id);assert.equal((await client.query('SELECT pg_backend_pid() pid')).rows[0].pid,names.pid);
   if(order==='names_first'){atPin.resolve();await allowNames.promise;}
  }};
  let revoked,committed;const prior=await f.fields(p);
  try{
   committed=jobs.recoveryBoundary.guard(f.config,{sku:p.sku,bindingRevisionId:f.binding.id},run,async state=>{
    const {observation}=await jobs.recoveryBoundary.observe(f.config,{sku:p.sku,bindingRevisionId:f.binding.id},run);
    const inspection=await first.inspect(f.config,observation,run);
    if(order==='revocation_first'){
     revoked=require('../src/services/application-user-admin.service').changeApplicationUserRole(actor,role,
      {databasePool:revokePool,actorUserId:f.actor,expectedAssignmentId:assignment});
     await ready(atRevoke.promise);
    }
    return require('../scripts/first-sync-name-commit').runNameCommit(runtime,f.config,state,inspection,{...run,databasePool:pinPool});
   }).then(value=>({value}),error=>({error}));
   if(order==='revocation_first'){
    await ready(atRevoke.promise);await blocked(f.db,names.pid,revoker.pid);allowRevoke.resolve();
   }else{
    await ready(atPin.promise);
    revoked=require('../src/services/application-user-admin.service').changeApplicationUserRole(actor,role,
     {databasePool:revokePool,actorUserId:f.actor,expectedAssignmentId:assignment});
    await blocked(f.db,revoker.pid,names.pid);allowNames.resolve();
   }
   const outcome=await committed;await revoked;
   // The demoted actor remains active and keeps the canonical publish permission.
   // Rejection therefore proves the stronger Administrator requirement.
   await runtime.access.assertActorStillAuthorized(f.db,actor,'export_templates.publish',c.error,{readOnly:true});
   if(order==='revocation_first'){
    assert.equal(outcome.error?.code,'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED');assert.equal(outcome.error.nameCommitNotStarted,true);
    assert.deepEqual(await f.fields(p),prior);assert.equal(trace.some(row=>row.sql==='BEGIN'),false);
   }else{
    assert.equal(outcome.error,undefined);assert.equal(outcome.value.localChanged,true);
    assert.equal((await f.fields(p)).fields.filter(row=>row.state==='name_received').length,2);
    for(const pattern of [/pg_advisory_lock\(/,/^BEGIN$/,/pg_advisory_xact_lock\(/,/^COMMIT$/])assert.ok(trace.some(row=>pattern.test(row.sql)),String(pattern));
   }
   assert.ok(trace.length);assert.ok(trace.every(row=>row.pid===names.pid));
   await noLocks(f.db,names,runtime.access.APPLICATION_USER_ADMIN_LOCK_KEY);
   await noLocks(f.db,revoker,runtime.access.APPLICATION_USER_ADMIN_LOCK_KEY);
  }finally{allowNames.resolve();allowRevoke.resolve();await Promise.allSettled([committed,revoked]);await names.pool.end();await revoker.pool.end();}
 });

 await t.test('real canonical rollback after source race releases pinned Administrator and lifecycle locks',async()=>{
  const p=await f.seed(),names=await worker(f.url),runtime=f.runtime(),admin=runtime.publication.administrator;
  let afterRace;
  runtime.publication={...runtime.publication,administrator:async(client,id)=>{
   await admin(client,id);await f.db.query('UPDATE products SET weight=133 WHERE id=$1',[p.id]);afterRace=await snapshot(f.db);
  }};
  try{
   await assert.rejects(jobs.recoveryBoundary.guard(f.config,{sku:p.sku,bindingRevisionId:f.binding.id},f.run,async state=>{
    const {observation}=await jobs.recoveryBoundary.observe(f.config,{sku:p.sku,bindingRevisionId:f.binding.id},f.run),inspection=await first.inspect(f.config,observation,f.run);
    return require('../scripts/first-sync-name-commit').runNameCommit(runtime,f.config,state,inspection,{...f.run,databasePool:names.pool});
   }),error=>{assert.equal(error.code,'MAGENTO_SYNC_AMBER_CHANGED');assert.equal(error.nameCommitRolledBack,true);return true;});
   assert.deepEqual(await snapshot(f.db),afterRace);await noLocks(f.db,names,runtime.access.APPLICATION_USER_ADMIN_LOCK_KEY);
  }finally{await names.pool.end();}
 });
 await t.test('new publication rejects a sealed old names review without any new mutation',async()=>{
  const p=await f.seed(),review=await f.review([p]);await f.publishNext();const before=await snapshot(f.db),result=await f.invoke(review,'apply');
  assert.equal(result.code,1);assert.ok(result.messages.some(row=>row.code==='CAMPAIGN_NAMES_PUBLICATION_CHANGED'));
  assert.deepEqual(await snapshot(f.db),before);
 });
});

test('fresh canonical history admission is retained in the first names receipt and its durable resume proof',async t=>{
 const f=await setup(t),p=await f.create();await f.readyNames(p);
 await f.db.query('INSERT INTO product_export_revisions(product_id,has_product_snapshot) VALUES($1,TRUE)',[p.id]);
 await f.db.query(`UPDATE product_full_export_state SET evidence='{"origin":"migration_039","coverage":"unresolved_historical"}',business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1`,[p.id]);
 await f.db.query('UPDATE export_state SET exported_to_product_id=$1',[p.id]);
 const cutover=require('../src/services/full-product-cutover.service'),maintenance={databasePool:f.db,actorUserId:f.actor,expectedDatabase:f.name,
  mutationContext:{actorUserId:f.actor},deploymentEvidence:'Synthetic disposable names integration; no old writer'};
 await cutover.prepare(maintenance);const index=await cutover.generate('index',maintenance);await cutover.indexHistorical(index,index.contentSha256,maintenance);
 const manifest=await cutover.generate('cutover',maintenance);assert.ok(manifest.entries.every(row=>row.action==='legacy_baseline'));
 await cutover.approve(manifest,manifest.contentSha256,'Synthetic fixture baseline only',maintenance);await cutover.applyBatch(manifest.contentSha256,0,maintenance);await cutover.activate(manifest.contentSha256,maintenance);
 const request={sku:p.sku,bindingRevisionId:f.binding.id},review=await first.review(f.config,request,f.run);
 assert.equal(review.historyReviewAssessment?.status,'available',JSON.stringify(review));
 const admission=await require('../src/services/magento/first-sync-cutover-admission').apply(f.config,{...request,previewToken:review.historyReview.previewToken},f.run);
 assert.equal(await f.fields(p),null);
 const sealed=await f.review([p]),before=await snapshot(f.db),applied=await f.invoke(sealed,'apply');assert.equal(applied.code,0,JSON.stringify(applied));
 const receipt=applied.journal.find(row=>row.type==='receipt'),current=await f.fields(p);
 assert.equal(current.historyAdmissionEventId,admission.receipt.auditEventId);
 assert.equal(current.session.revision,'1');assert.equal(current.fields.filter(row=>row.state==='name_received').length,2);
 assert.ok(current.fields.filter(row=>row.target!=='name').every(row=>row.state==='conflict'&&!row.source.decision));
 const durable=(await f.db.query('SELECT command,command_hash FROM magento_first_sync_progress WHERE session_id=$1',[current.session.id])).rows[0];
 assert.equal(durable.command.historyAdmissionEventId,admission.receipt.auditEventId);assert.equal(durable.command_hash,receipt.proof.commandHash);assert.equal(c.hash(durable.command),receipt.proof.commandHash);
 const after=await snapshot(f.db);for(const table of ['export_state','product_export_revisions','export_snapshots','magento_sync_jobs','magento_sync_steps'])assert.deepEqual(after[table],before[table],table);
 const resumed=await f.invoke(sealed,'resume',{output:applied.output});assert.equal(resumed.code,0,JSON.stringify(resumed));assert.deepEqual(await snapshot(f.db),after);
});
