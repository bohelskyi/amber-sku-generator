'use strict';
require('../test/setup-env');
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const harness=require('./harness'),{Pool,recreateTestDatabase,dropTestDatabase,runNodeInDatabase}=harness;
const cases=require('../test/fixtures/nm-first-sync-seo-cases');
const fixture=require('../test/fixtures/magento-bindings');
const c=require('../src/services/magento/binding-contract');
const {insertProductFixture}=require('./product-fixture');
const service=require('../src/services/magento/first-sync.service'),jobs=require('../src/services/magento/sync-job.service');
const recovery=require('../src/services/magento/sync-job-recovery'),runtime=require('../src/services/magento/first-sync-runtime');
const seo=require('../src/services/magento/first-sync-seo-proof'),ledger=require('../src/services/magento/first-sync-ledger');
const preview=require('../src/services/magento/sync-preview');
const targets=['meta_title','meta_description'],template=(target,scope)=>'Active NM '+scope+' '+target;
const name='amber_first_sync_local_authority_test';
async function setup({databaseName=name,numericLength=false}={}){
  const url=await recreateTestDatabase(databaseName),db=new Pool({connectionString:url});
  try{
    const prior=await fs.mkdtemp(path.join(os.tmpdir(),'amber-nm-pre075-'));
    try{
      for(const file of await fs.readdir(path.resolve(__dirname,'../migrations')))if(file.endsWith('.sql')&&file<'076')
        await fs.copyFile(path.resolve(__dirname,'../migrations',file),path.join(prior,file));
      await runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations({directory:process.env.NM_SEO_PRIOR_MIGRATIONS}).then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});",{NM_SEO_PRIOR_MIGRATIONS:prior});
    }finally{await fs.rm(prior,{recursive:true});}
    const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','NM fixture Administrator') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
    for(const code of ['BR','NM','KL','CH','AR','SV'])await db.query('INSERT INTO categories(code,name) VALUES($1,$1)',[code]);
    if(numericLength)await db.query("INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required) VALUES('NM','neckle_size','Exact necklace length','text',0,0)");
    const d=structuredClone(fixture.definition()),literal=value=>({op:'literal',value}),text=id=>({op:'text',input:{op:'source',id},trim:false,format:'scalar-v1',onAbsent:'empty'});
    d.sources={sku:d.sources.sku,weight:d.sources.weight,price:{kind:'product',field:'total_price_uah',type:'scalar'}};d.tables={};
    for(const group of d.groups)for(const row of group.rows){
      delete row.cells.kolir;delete row.cells.decor_weight;delete row.cells.dovzhyna_brasletu_diuimiv;
      row.cells.price=row.id==='base'?text('price'):literal('');
    }
    const nm=d.groups.find(g=>g.route==='NM');nm.rows[0].cells.decor_weight=text('weight');nm.rows[0].cells.product_websites=literal('fixture');
    if(numericLength){
      d.sources.nmLength={kind:'information',category:'NM',key:'neckle_size',type:'scalar',provenance:'supplied-stored-answers-v1',aliases:[]};
      nm.rows[0].cells.dovzhyna_namysta_tochna=text('nmLength');
    }
    for(const row of nm.rows)for(const target of targets)row.cells[target]=literal(template(target,row.id==='base'?'all':'en'));
    const raw=structuredClone(fixture.schema());raw.attributes.find(a=>a.attribute_code==='name').scope='store';
    Object.assign(raw.attributes.find(a=>a.attribute_code==='decor_weight'),{frontend_input:'text',options:[]});
    for(const [index,target]of targets.entries()){
      raw.attributes.push({attribute_id:950+index,attribute_code:target,frontend_input:index?'textarea':'text',scope:'store',options:[]});
      raw.attributeSets[0].attributeCodes.push(target);
    }
    if(numericLength){
      raw.attributes.push({attribute_id:960,attribute_code:'dovzhyna_namysta_tochna',frontend_input:'text',backend_type:'varchar',scope:'global',options:[]});
      raw.attributeSets[0].attributeCodes.push('dovzhyna_namysta_tochna');
    }
    raw.storeTopology.websites[0].default_group_id=802;raw.storeTopology.storeGroups[0].default_store_id=805;
    raw.storeTopology.storeViews.push({id:805,code:'default',name:'Ukrainian',website_id:801,store_group_id:802,is_active:true});
    const schema=c.normalizeSchema(raw),config={configured:true,baseUrl:'https://nm-seo.invalid',consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
    const options={databasePool:db,actorUserId:actor,mutationContext:{actorUserId:actor}};
    const family=await require('../src/services/export-templates/template.service').createTemplate({key:'nm-seo-'+randomUUID(),displayName:'NM SEO fixture',definition:d},options);
    const version=await require('../src/services/export-templates/template.service').publishTemplate(family.id,{expectedRevision:family.draft.revision,expectedDefinitionHash:family.draft.definitionHash},options);
    const bindings=require('../src/services/magento/binding.service'),approved=fixture.approvedBindings(d,schema,'NM');
    const nativeTargets={attribute_set_code:'product.attribute_set_id',product_type:'product.type_id',product_websites:'product.extension_attributes.website_ids'};
    for(const a of approved.attributes)if(nativeTargets[a.target])a.transportTarget=nativeTargets[a.target];
    for(const p of approved.policies){
      const a=approved.attributes.find(a=>require('../src/services/magento/binding-validation').bindingKey(a.routeKey,a.rowId,a.target)===p.bindingKey);
      p.policy=a?.rowId==='english'&&['sku','product_type','attribute_set_code','store_view_code'].includes(a.target)?'magento_managed':'authoritative_create_update';
    }
    let binding=await bindings.createDraft({installationKey:'nm-seo-fixture',origin:config.baseUrl,templateVersionId:version.id,observedAt:'2026-10-12T00:00:00Z',schema},options);
    binding=await bindings.updateDraft(binding.id,{expectedRevision:binding.revision,bindings:approved},options);
    binding=await bindings.publishDraft(binding.id,{expectedRevision:binding.revision,expectedCurrentId:null},options);
    const remotes=new Map(),products=[],calls=[];
    async function create(sample){
      const p=(await insertProductFixture(db,"INSERT INTO products(full_sku,category,weight,total_price_uah,details) VALUES($1,'NM',$2,$3,$4::jsonb) RETURNING *",
        [sample.sku,sample.localWeight,sample.price,JSON.stringify({answers:numericLength?{neckle_size:sample.localLength??'77,5'}:{},manualPriceUah:sample.price})])).rows[0];
      await db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1",[p.id]);
      const values={all:Object.fromEntries(targets.map(t=>[t,sample.baseSeoEqual?template(t,'all'):'Magento NM all '+t+' '+sample.sku])),
        en:Object.fromEntries(targets.map(t=>[t,'Magento NM en '+t+' '+sample.sku]))};
      remotes.set(sample.sku,{id:sample.remoteId,sku:sample.sku,attribute_set_id:8001,type_id:'simple',name:'Fixture name',price:sample.price,status:1,visibility:4,
        custom_attributes:[{attribute_code:'decor_weight',value:sample.remoteWeight},...targets.map(t=>({attribute_code:t,value:values.all[t]})),
          ...(numericLength?[{attribute_code:'dovzhyna_namysta_tochna',value:sample.remoteLength??'77.50'}]:[])],extension_attributes:{website_ids:[801],category_links:[]},en:{name:'Fixture name',...values.en}});
      products.push({...sample,id:p.id,publicIdentityId:p.public_product_identity_id,values});return products.at(-1);
    }
    for(const sample of cases)await create(sample);
    let loseNextWrite=false,failReadback=false;const readbackLengths=new Map();
    const run={...options,observeRate:async()=>({rateInfo:{rate:40,rateDate:'2026-10-12',source:'fixture',stale:false}}),
      preview:async(_config,input)=>{
        const amber=await require('../src/services/magento/sync-preview-db').readPreviewProduct(db,{sku:input.sku,bindingRevisionId:input.bindingRevisionId});
        const r=structuredClone(remotes.get(input.sku)),en=r.en;delete r.en;
        const observation={amber,raw:r,schema,domainEvidence:{inventory:null,english:{id:r.id,sku:r.sku,fields:en,preservedFields:[],preservedFieldHashes:{}},failures:[]},categoryNodes:[],categoryFailures:[]};
        input.onObservation(observation);return preview.planPreview(amber,schema,r,[],{domainEvidence:observation.domainEvidence});
      },refresh:async o=>{
        if(failReadback){failReadback=false;throw Object.assign(Error('synthetic unavailable readback'),{code:'MAGENTO_SYNC_READ_FAILED'});}
        const r=structuredClone(remotes.get(o.raw.sku)),en=r.en;delete r.en;
        return {...o,raw:r,domainEvidence:{inventory:null,english:{id:r.id,sku:r.sku,fields:en,preservedFields:[],preservedFieldHashes:{}},failures:[]}};
      },fetchImpl:async(url,init)=>{
        const u=new URL(url);calls.push({url:String(url),method:init.method,body:init.body?JSON.parse(init.body):null});
        if(init.method==='GET'&&u.pathname.endsWith('/store/storeConfigs'))return new Response(JSON.stringify([
          {id:805,code:'default',website_id:801,locale:'uk_UA',base_currency_code:'UAH'},{id:804,code:'en',website_id:801,locale:'en_US',base_currency_code:'UAH'}]),{headers:{'content-type':'application/json'}});
        assert.equal(init.method,'POST');assert.ok(u.pathname.endsWith('/V1/products'));
        const p=JSON.parse(init.body).product,r=remotes.get(p.sku);assert.ok(r);
        const english=u.pathname.includes('/rest/en/');
        for(const [k,v]of Object.entries(p))if(k!=='custom_attributes'&&k!=='sku'){
          if(english)r.en[k]=v;else r[k]=v;
        }
        for(const a of p.custom_attributes||[]){
          if(english)r.en[a.attribute_code]=a.value;
          else {const old=r.custom_attributes.find(x=>x.attribute_code===a.attribute_code);
            const value=a.attribute_code==='dovzhyna_namysta_tochna'&&readbackLengths.has(p.sku)?readbackLengths.get(p.sku):a.value;
            if(old)old.value=value;else r.custom_attributes.push({...a,value});}
        }
        if(loseNextWrite){loseNextWrite=false;failReadback=true;throw Error('synthetic lost POST response');}
        return new Response(JSON.stringify(r),{headers:{'content-type':'application/json'}});
      }};
    async function fingerprint(){
      const data={};for(const {tablename}of(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
        assert.match(tablename,/^[a-z_]+$/);data[tablename]=(await db.query(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) rows FROM (SELECT to_jsonb(t) j FROM public."${tablename}" t) entries`)).rows[0].rows;
      }return c.hash(data);
    }
    return {db,url,actor,binding,schema,config,run,products,remotes,calls,create,fingerprint,readbackLengths,loseWrite:()=>{loseNextWrite=true;}};
  }catch(e){await db.end();throw e;}
}
const request=(f,p)=>({sku:p.sku,bindingRevisionId:f.binding.id});
const currentFields=async(f,p)=>ledger.readOnClient(f.db,{originHash:c.originHash(f.config.baseUrl),publicIdentityId:String(p.publicIdentityId)});
const cleanField=f=>Object.fromEntries(['target','scope','state','before','remote','after','source','mappingHash'].map(k=>[k,f[k]]));
async function transaction(f,operation){
  const client=await f.db.connect();try{await client.query('BEGIN');const result=await operation(client);await client.query('COMMIT');return result;}
  catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
const reconcileInput=checked=>({review:checked.review,reviewHash:checked.reviewHash,reason:'Verified fixture delivery after lost response'});
const migrationStart=url=>runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});");

async function inspectChosen(f,p,choices) {
 const {observation}=await jobs.recoveryBoundary.observe(f.config,request(f,p),f.run);
 return service.inspect(f.config,observation,f.run,{decision:choices});
}
function localChoices(r) {return r.fields.filter(x=>x.canKeepLocal).map(({target,scope})=>({target,scope,choice:'keep_local'}));}
async function seedRemote(f,p) {
 const review=await service.review(f.config,request(f,p),f.run);
 const choices=review.fields.filter(x=>targets.includes(x.target)&&x.canAcceptRemote)
  .map(({target,scope})=>({target,scope,choice:'accept_remote'}));
 const weight=review.fields.find(x=>x.target==='decor_weight');if(weight.canKeepLocal)choices.push({target:'decor_weight',scope:'all',choice:'keep_local'});
 return service.apply(f.config,{...request(f,p),previewToken:review.previewToken,choices},f.run);
}
async function predicate(f,field,prior,progress,session) {
 const row={session_id:session.id,revision:String(BigInt(session.revision)+1n),target:field.target,scope:field.scope,state:field.state,evidence:field};
 const q=await f.db.query(`SELECT first_sync_local_seo_choice_valid(
   jsonb_populate_record(NULL::magento_first_sync_fields,$1::jsonb),$2::jsonb,$3::bigint,
   jsonb_populate_record(NULL::magento_first_sync_progress,$4::jsonb),
   jsonb_populate_record(NULL::magento_first_sync_sessions,$5::jsonb)) AS valid`,
 [JSON.stringify(row),JSON.stringify(cleanField(prior)),prior.revision,JSON.stringify(progress),JSON.stringify(session)]);
 return q.rows[0].valid===true;
}
async function directFieldAttempt(f,p,field,{actor=f.actor,missingAudit=false,complete=false}={}) {
 const old=await currentFields(f,p),s=old.session,revision=String(BigInt(s.revision)+1n),previewHash=c.hash({fixture:randomUUID()}),commandHash=c.hash({field,actor});
 const result={sessionId:s.id,revision,completed:complete,changedFields:[{target:field.target,scope:field.scope,state:field.state}]};
 return transaction(f,async client=>{
  const event=await require('../src/audit/audit-events').writeAuditEvent(client,{mutationContext:{actorUserId:actor},eventKey:'magento.first_sync_progress_recorded',subjectType:'magento_first_sync',subjectId:s.id,
   details:{revision,previewHash,commandHash,result:missingAudit?{...result,revision:'999'}:result}});
  await client.query(`INSERT INTO magento_first_sync_progress(session_id,revision,preview_hash,command_hash,command,result,actor_user_id,audit_event_id,completed,transaction_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,txid_current())`,[s.id,revision,previewHash,commandHash,JSON.stringify({fields:[field],complete,requiredScopes:[{target:field.target,scope:field.scope}]}),JSON.stringify(result),actor,event.id,complete]);
  await client.query('INSERT INTO magento_first_sync_fields(session_id,revision,target,scope,state,evidence) VALUES($1,$2,$3,$4,$5,$6)',[s.id,revision,field.target,field.scope,field.state,JSON.stringify(field)]);
  await client.query('UPDATE magento_first_sync_sessions SET revision=$2 WHERE id=$1',[s.id,revision]);
 });
}
test('canonical local authority and atomic batch decisions',async t=>{
 let f;try {
  f=await setup();t.mock.method(globalThis,'fetch',()=>assert.fail('No live Magento/NBU transport'));
  await seedRemote(f,f.products[9]);
  await t.test('076 DDL rollback, fresh upgrade and repeated startup retain immutable rows/checksums',async()=>{
   const before=await f.fingerprint(),sql=await fs.readFile(path.resolve(__dirname,'../migrations/076_first_sync_local_seo_authority.sql'),'utf8');
   await assert.rejects(transaction(f,async client=>{await client.query(sql);throw Error('fixture DDL rollback');}),/fixture DDL rollback/);
   assert.equal(await f.fingerprint(),before);assert.equal((await f.db.query("SELECT to_regprocedure('first_sync_local_seo_choice_valid(magento_first_sync_fields,jsonb,bigint,magento_first_sync_progress,magento_first_sync_sessions)') AS present")).rows[0].present,null);
   const checks=(await f.db.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
   await migrationStart(f.url);assert.deepEqual((await f.db.query("SELECT * FROM schema_migrations WHERE name<'076' ORDER BY name")).rows,checks);
   const after=await f.fingerprint();await migrationStart(f.url);assert.equal(await f.fingerprint(),after);
  });
  await t.test('single weight choice leaves every unselected populated SEO unresolved with zero Magento writes',async()=>{
   const p=f.products[0],r=await service.review(f.config,request(f,p),f.run);
   const out=await service.apply(f.config,{...request(f,p),previewToken:r.previewToken,target:'decor_weight',scope:'all',choice:'keep_local'},f.run);
   assert.equal(out.readyForOutbound,false);const fields=(await currentFields(f,p)).fields;
   assert.equal(fields.filter(x=>targets.includes(x.target)&&x.state==='conflict').length,4);
   assert.equal(fields.some(x=>x.state==='seo_pending_initial_readback'),false);assert.ok(f.calls.every(x=>x.method==='GET'));
  });
  await t.test('explicit old-remote receipts transition locally in one revision without changing evidence/history/products',async()=>{
   const p=f.products[1];await seedRemote(f,p);const prior=await currentFields(f,p);
   assert.equal(prior.fields.filter(x=>x.state==='seo_pending_initial_readback').length,4);
   const oldRows=(await f.db.query('SELECT * FROM magento_first_sync_fields WHERE session_id=$1 ORDER BY revision,target,scope',[prior.session.id])).rows;
   const beforeProduct=(await f.db.query('SELECT * FROM products WHERE id=$1',[p.id])).rows[0];
   const r=await service.review(f.config,request(f,p),f.run),choices=localChoices(r).filter(x=>targets.includes(x.target));assert.equal(choices.length,4);
   const result=await service.apply(f.config,{...request(f,p),previewToken:r.previewToken,choices},f.run);
   assert.equal(result.readyForOutbound,true);const current=await currentFields(f,p);
   assert.equal(current.session.revision,String(BigInt(prior.session.revision)+1n));
   const selected=current.fields.filter(x=>targets.includes(x.target));assert.equal(selected.length,4);
   assert.ok(selected.every(x=>x.state==='pending_outward_confirmation'&&x.source.decision==='keep_local'&&x.after.startsWith('Active NM ')));
   assert.deepEqual((await f.db.query('SELECT * FROM magento_first_sync_fields WHERE session_id=$1 AND revision<=$2 ORDER BY revision,target,scope',[prior.session.id,prior.session.revision])).rows,oldRows);
   assert.deepEqual((await f.db.query('SELECT * FROM products WHERE id=$1',[p.id])).rows[0],beforeProduct);
   const again=await service.apply(f.config,{...request(f,p),previewToken:r.previewToken,choices:[...choices].reverse()},f.run);assert.equal(again.receipt.alreadyApplied,true);
   assert.equal((await currentFields(f,p)).session.revision,current.session.revision);assert.ok(f.calls.every(x=>x.method==='GET'));
  });
  await t.test('SQL predicate requires current binding, administrator, exact prior evidence and authoritative policy',async()=>{
   const p=f.products[3];await seedRemote(f,p);const prior=await currentFields(f,p),r=await service.review(f.config,request(f,p),f.run),choices=localChoices(r).filter(x=>targets.includes(x.target));
   const inspection=await inspectChosen(f,p,choices),field=cleanField(inspection.prepared.rows.find(x=>x.target==='meta_title'&&x.scope==='all').record),old=prior.fields.find(x=>x.target===field.target&&x.scope===field.scope);
   const progress=(await f.db.query('SELECT * FROM magento_first_sync_progress WHERE session_id=$1 AND revision=$2',[prior.session.id,prior.session.revision])).rows[0];
   assert.equal(await predicate(f,field,old,progress,prior.session),true);
   const nonadmin=Number((await f.db.query("INSERT INTO application_users(status,display_name) VALUES('active','Nonadministrator review fixture') RETURNING id")).rows[0].id);
   assert.equal(await predicate(f,field,old,{...progress,actor_user_id:nonadmin},prior.session),false);
   assert.equal(await predicate(f,field,old,progress,{...prior.session,completed_at:new Date().toISOString()}),false);
   for(const change of [x=>x.source.seoAuthorityChange.revision='999',x=>x.source.seoAuthorityChange.evidence.after='forged',x=>x.source.bindingRevisionId=randomUUID(),x=>x.source.definitionHash='b'.repeat(64),x=>x.mappingHash='a'.repeat(64),x=>x.after='forged',x=>x.before.known=false,x=>x.source.decision='accept_remote']) {
    const forged=structuredClone(field);change(forged);assert.equal(await predicate(f,forged,old,progress,prior.session),false);
   }
   f.sqlFixture={p,prior,field,old,progress,nonadmin};
  });
  await t.test('direct SQL trigger rejects forged prior references, nonadministrator and unlinked audit atomically',async()=>{
   const {p,prior,field,nonadmin}=f.sqlFixture,before=await f.fingerprint();
   const forged=structuredClone(field);forged.source.seoAuthorityChange.revision='999';
   await assert.rejects(directFieldAttempt(f,p,forged),/FIRST_SYNC_LOCAL_SEO_AUTHORITY_UNPROVEN/);
   await assert.rejects(directFieldAttempt(f,p,field,{actor:nonadmin}),/FIRST_SYNC_LOCAL_SEO_AUTHORITY_UNPROVEN/);
   await assert.rejects(directFieldAttempt(f,p,field,{missingAudit:true}),/FIRST_SYNC_PROGRESS_INCOMPLETE/);
   assert.equal(await f.fingerprint(),before);assert.deepEqual(await currentFields(f,p),prior);
  });
  await t.test('terminal equal SEO stays immutable and nonterminal sibling can be explicitly local',async()=>{
   const p=f.products[7];await seedRemote(f,p);const prior=await currentFields(f,p),equal=prior.fields.filter(x=>targets.includes(x.target)&&x.state==='equal');assert.equal(equal.length,2);
   const review=await service.review(f.config,request(f,p),f.run),choices=localChoices(review).filter(x=>targets.includes(x.target));assert.equal(choices.length,2);
   await service.apply(f.config,{...request(f,p),previewToken:review.previewToken,choices},f.run);
   assert.deepEqual((await currentFields(f,p)).fields.filter(x=>targets.includes(x.target)&&x.state==='equal'),equal);
   const forged=cleanField(equal[0]);forged.state='pending_outward_confirmation';forged.source.decision='keep_local';
   await assert.rejects(directFieldAttempt(f,p,forged),/FIRST_SYNC_TERMINAL_PERMANENT/);
  });
  await t.test('SQL authority requires an actually proven remote text/empty cell, never malformed or unavailable',async()=>{
   const {p,field,old,progress,prior}=f.sqlFixture;
   for(const remote of [{known:false,present:false,value:null},{known:true,present:true,value:42},
      {known:true,present:true,value:'bad\nSEO'},{known:true,present:false,value:'not-empty'},
      {known:'true',present:true,value:'String flag'},{known:true,present:'true',value:'String flag'}]) {
    const forged=structuredClone(field);forged.remote=remote;
    assert.equal(await predicate(f,forged,old,progress,prior.session),false,JSON.stringify(remote));
    await assert.rejects(directFieldAttempt(f,p,forged),/FIRST_SYNC_LOCAL_SEO_AUTHORITY_UNPROVEN/);
   }
   for(const remote of [{known:true,present:false},{known:true,present:false,value:null},{known:true,present:false,value:''},{known:true,present:false,value:'   '}]) {
    const empty=structuredClone(field);empty.remote=remote;assert.equal(await predicate(f,empty,old,progress,prior.session),true);
   }
  });
  await t.test('queued catalog work denies old-pending authority transition; no dispatch retry',async()=>{
   const {p,prior,field,old,progress}=f.sqlFixture;
   const r=await service.review(f.config,request(f,p),f.run);assert.equal(r.readyForOutbound,true);
   const job=await jobs.enqueue(f.config,request(f,p),f.run);assert.equal(job.state,'queued');f.protectedJob=job;
   assert.equal(await predicate(f,field,old,progress,prior.session),false);
   const before=await f.fingerprint();await assert.rejects(directFieldAttempt(f,p,field),/FIRST_SYNC_LOCAL_SEO_AUTHORITY_UNPROVEN/);
   assert.equal(await f.fingerprint(),before);assert.ok(f.calls.every(x=>x.method==='GET'));
  });
  await t.test('local SEO supersession delivers through ordinary verified job readback',async()=>{
   const p=f.products[1],beforeProduct=(await f.db.query('SELECT * FROM products WHERE id=$1',[p.id])).rows[0];
   const prior=await currentFields(f,p);assert.equal(prior.session.completed_at,null);
   const job=await jobs.enqueue(f.config,request(f,p),f.run);
   assert.ok(job.intent.operations.some(op=>(op.payload?.product?.custom_attributes||[]).some(a=>targets.includes(a.attribute_code))));
   const done=await jobs.applyJob(f.config,job.id,{...f.run,apply:true});assert.equal(done.state,'succeeded',JSON.stringify(done.failure));
   const after=await currentFields(f,p);assert.ok(after.session.completed_at);
   assert.ok(after.fields.filter(x=>targets.includes(x.target)).every(x=>x.state==='outward_verified'));
   assert.deepEqual((await f.db.query('SELECT * FROM products WHERE id=$1',[p.id])).rows[0],beforeProduct);
   for(const target of targets){assert.equal(f.remotes.get(p.sku).custom_attributes.find(a=>a.attribute_code===target).value,template(target,'all'));assert.equal(f.remotes.get(p.sku).en[target],template(target,'en'));}
  });
  await t.test('actual lost dispatch response freezes remote-pending authority without retry or receipt reset',async()=>{
   const {p,field,old,progress,prior}=f.sqlFixture;f.loseWrite();
   const uncertain=await jobs.applyJob(f.config,f.protectedJob.id,{...f.run,apply:true});assert.equal(uncertain.state,'uncertain');
   const steps=(await f.db.query('SELECT * FROM magento_sync_steps WHERE job_id=$1',[uncertain.id])).rows;
   assert.ok(steps.some(x=>x.state==='dispatched'&&!x.verified_at));
   assert.equal(await predicate(f,field,old,progress,prior.session),false);
   const before=await f.fingerprint(),writes=f.calls.filter(x=>x.method==='POST').length;
   await assert.rejects(directFieldAttempt(f,p,field),/FIRST_SYNC_LOCAL_SEO_AUTHORITY_UNPROVEN/);
   assert.equal(await f.fingerprint(),before);assert.equal(f.calls.filter(x=>x.method==='POST').length,writes);
   assert.ok((await currentFields(f,p)).fields.some(x=>x.state==='seo_pending_initial_readback'));
  });
  await t.test('unfinished media/visibility block local authority and immutable dispatch receipts remain intact',async()=>{
   const p=f.products[9],r=await service.review(f.config,request(f,p),f.run),choices=localChoices(r).filter(x=>targets.includes(x.target));
   const prior=await currentFields(f,p),inspection=await inspectChosen(f,p,choices),field=cleanField(inspection.prepared.rows.find(x=>x.target==='meta_title'&&x.scope==='en').record),old=prior.fields.find(x=>x.target===field.target&&x.scope===field.scope);
   const progress=(await f.db.query('SELECT * FROM magento_first_sync_progress WHERE session_id=$1 AND revision=$2',[prior.session.id,prior.session.revision])).rows[0];
   assert.equal(await predicate(f,field,old,progress,prior.session),true);
   const mediaId=randomUUID();await f.db.query(`INSERT INTO product_media_jobs(id,product_id,public_product_identity_id,version,photo_ids,enable_when_verified,actor_user_id,request_key,required_permission,intent_hash,state)
      VALUES($1,$2,$3,1,ARRAY[]::uuid[],false,$4,$5,'products.create',$6,'uncertain')`,[mediaId,p.id,p.publicIdentityId,f.actor,randomUUID(),'a'.repeat(64)]);
   await f.db.query("INSERT INTO product_media_steps(job_id,step_key,operation_hash) VALUES($1,'fixture-unverified','a'||repeat('0',63))",[mediaId]);
   assert.equal(await predicate(f,field,old,progress,prior.session),false);
   const before=await f.fingerprint();await assert.rejects(directFieldAttempt(f,p,field),/FIRST_SYNC_LOCAL_SEO_AUTHORITY_UNPROVEN/);assert.equal(await f.fingerprint(),before);
   f.bindingFixture={p,prior,field,old,progress,mediaId};
   await f.db.query("UPDATE product_media_jobs SET state='succeeded',verified_at=now() WHERE id=$1",[mediaId]);
   assert.equal(await predicate(f,field,old,progress,prior.session),true);
   const visId=randomUUID();await f.db.query(`INSERT INTO product_visibility_intents(id,product_id,public_product_identity_id,public_sku,origin_hash,kind,actor_user_id,previous_product,previous_lifecycle,local_fingerprint,state)
    VALUES($1,$2,$3,$4,$5,'hide',$6,'{}','{}',$7,'queued')`,[visId,p.id,p.publicIdentityId,p.sku,c.originHash(f.config.baseUrl),f.actor,'a'.repeat(64)]);
   assert.equal(await predicate(f,field,old,progress,prior.session),false);
   await f.db.query("UPDATE product_visibility_intents SET state='superseded' WHERE id=$1",[visId]);
   assert.equal(await predicate(f,field,old,progress,prior.session),true);
  });
  await t.test('batch preview is fully read-only; one local choice set delivers exact weight and SEO through verified readback',async()=>{
   const batch=require('../src/services/magento/first-sync-batch-preflight');
   const p=await f.create({sku:'NM99003001',localWeight:'132.300',remoteWeight:132,price:1700,remoteId:99301,baseSeoEqual:false});
   const observed=await jobs.recoveryBoundary.observe(f.config,request(f,p),f.run),review=await service.inspect(f.config,observed.observation,f.run);
   const fields=review.fields.filter(x=>x.canKeepLocal).map(x=>({target:x.target,scope:x.scope,local:x.local.value,remote:x.remote.value}));
   assert.equal(fields.length,5);
   const input={bindingRevisionId:f.binding.id,expectedDefinitionHash:observed.observation.amber.compiled.hash,
     items:[{sku:p.sku,expectedProduct:batch.source(observed.observation.amber.product),remoteProductId:p.remoteId,fields}]};
   const before=await f.fingerprint(),callsBefore=f.calls.length,out=await batch.preflight(f.config,input,f.run);
   assert.equal(await f.fingerprint(),before);assert.ok(f.calls.slice(callsBefore).every(x=>x.method==='GET'));
   assert.equal(out.counts.readyForApply,1,JSON.stringify(out));assert.equal(out.results[0].readyForOutboundAfterChoices,true);
   const original=(await f.db.query('SELECT * FROM products WHERE id=$1',[p.id])).rows[0],choice=out.results[0].applyInput;
   const packetRun={...f.run,validateFirstSyncDecision:(base,report,choices)=>batch.validatePacketDecision(base,report,input,input.items[0],choices)};
   const applied=await service.apply(f.config,choice,packetRun);assert.equal(applied.readyForOutbound,true);
   const pending=await currentFields(f,p);assert.equal(pending.session.completed_at,null);
   assert.ok(pending.fields.filter(x=>targets.includes(x.target)||x.target==='decor_weight').every(x=>x.state==='pending_outward_confirmation'));
   const auditCount=(await f.db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='magento.first_sync_progress_recorded' AND subject_id=$1",[pending.session.id])).rows[0].n;
   const retry=await service.apply(f.config,{...choice,choices:[...choice.choices].reverse()},packetRun);assert.equal(retry.receipt.alreadyApplied,true);
   assert.equal((await f.db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='magento.first_sync_progress_recorded' AND subject_id=$1",[pending.session.id])).rows[0].n,auditCount);
   const job=await jobs.enqueue(f.config,request(f,p),f.run);assert.equal(job.baseline.firstSyncSeo,undefined);
   const done=await jobs.applyJob(f.config,job.id,{...f.run,apply:true});assert.equal(done.state,'succeeded',JSON.stringify(done.failure));
   const final=await currentFields(f,p);assert.ok(final.session.completed_at);
   assert.ok(final.fields.filter(x=>targets.includes(x.target)||x.target==='decor_weight').every(x=>x.state==='outward_verified'));
   assert.deepEqual((await f.db.query('SELECT * FROM products WHERE id=$1',[p.id])).rows[0],original);
   const r=f.remotes.get(p.sku);assert.equal(Number(r.custom_attributes.find(a=>a.attribute_code==='decor_weight').value),132.3);
   for(const target of targets){assert.equal(r.custom_attributes.find(a=>a.attribute_code===target).value,template(target,'all'));assert.equal(r.en[target],template(target,'en'));}
  });
  await t.test('batch snapshot, fresh malformed values and physical nonrounding differences block without receipts',async()=>{
   const batch=require('../src/services/magento/first-sync-batch-preflight');
   const p=await f.create({sku:'NM99003002',localWeight:'132.300',remoteWeight:140,price:1700,remoteId:99302,baseSeoEqual:false});
   const {observation}=await jobs.recoveryBoundary.observe(f.config,request(f,p),f.run),inspection=await service.inspect(f.config,observation,f.run);
   const input={bindingRevisionId:f.binding.id,expectedDefinitionHash:observation.amber.compiled.hash,items:[{sku:p.sku,
     expectedProduct:batch.source(observation.amber.product),remoteProductId:p.remoteId,
     fields:inspection.fields.filter(x=>x.canKeepLocal).map(x=>({target:x.target,scope:x.scope,local:x.local.value,remote:x.remote.value}))}]};
   let before=await f.fingerprint(),out=await batch.preflight(f.config,input,f.run);assert.equal(out.counts.readyForApply,0);
   assert.ok(out.results[0].blockers.some(b=>b.code==='BATCH_WEIGHT_NOT_ROUNDING_ONLY'));assert.equal(await f.fingerprint(),before);
   const claimed=structuredClone(input);claimed.items[0].fields.find(f=>f.target==='decor_weight').remote=132;
   await assert.rejects(service.apply(f.config,{...request(f,p),previewToken:inspection.previewToken,choices:[{target:'decor_weight',scope:'all',choice:'keep_local'}]},
     {...f.run,validateFirstSyncDecision:(base,report,choices)=>batch.validatePacketDecision(base,report,claimed,claimed.items[0],choices)}),{code:'BATCH_PLAN_CHANGED'});
   assert.equal(await f.fingerprint(),before);assert.equal(await currentFields(f,p),null);
   input.items[0].fields=input.items[0].fields.filter(f=>f.target!=='decor_weight');input.items[0].expectedProduct.answers={changed:1};
   out=await batch.preflight(f.config,input,f.run);assert.ok(out.results[0].blockers.some(b=>b.code==='BATCH_PRODUCT_CHANGED'));assert.equal(await f.fingerprint(),before);
   input.items[0].expectedProduct= batch.source(observation.amber.product);f.remotes.get(p.sku).en.meta_title=42;
   before=await f.fingerprint();out=await batch.preflight(f.config,input,f.run);assert.equal(out.counts.readyForApply,0);
   assert.ok(out.results[0].blockers.some(b=>b.code==='BATCH_FIELD_CHANGED'));assert.equal(await f.fingerprint(),before);assert.equal(await currentFields(f,p),null);
  });
  await t.test('standalone discovery uses canonical ordinary preview and read-only PostgreSQL without adoption',async()=>{
   const discovery=require('../scripts/first-sync-local-discovery'),batch=require('../src/services/magento/first-sync-batch-preflight');
   const dir=await fs.mkdtemp(path.join(os.tmpdir(),'amber-discovery-integration-'));
   const readonly=new Pool({connectionString:f.url,max:1,options:'-c default_transaction_read_only=on'});
   try{
    const p=await f.create({sku:'NM99004001',localWeight:'132.300',remoteWeight:132,price:1700,remoteId:99401,baseSeoEqual:false});
    const blocked=await f.create({sku:'NM99004002',localWeight:'132.300',remoteWeight:140,price:1700,remoteId:99402,baseSeoEqual:false});
    const runtime=discovery.createRuntime(path.resolve(__dirname,'..'));
    // Keep the real ordinary preview, exact GET identity lookup, local reader and first-sync services.
    // Only schema/category network responses and Magento transport are synthetic.
    runtime.preview=(config,options)=>preview.previewProduct(config,{...options,
      discover:async()=>f.binding.schema,categoryObservation:{trees:[],categoryFailures:[]}});
    const first=runtime.first;
    runtime.first={...first,inspect:(config,observation,options)=>first.inspect(config,observation,{...options,observeRate:f.run.observeRate})};
    const calls=[];
    const fetchImpl=async(url,init)=>{
     const u=new URL(url);assert.equal(init.method,'GET');calls.push(u.pathname);
     if(u.pathname.endsWith('/V1/products')){
      const sku=u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');
      const r=structuredClone(f.remotes.get(sku));assert.ok(r);
      if(u.pathname.includes('/rest/en/')){r.name=r.en.name;r.custom_attributes=targets.map(target=>({attribute_code:target,value:r.en[target]}));}
      delete r.en;return new Response(JSON.stringify({items:[r],total_count:1}),{headers:{'content-type':'application/json'}});
     }
     return f.run.fetchImpl(url,init);
    };
    const item=product=>({sku:product.sku,productId:product.id,category:'NM',remoteProductId:null,
     fields:[{target:'decor_weight',scope:'all',local:'132.300',remote:product.remoteWeight,policy:'manager_weight_rounding'},
      ...['all','en'].flatMap(scope=>targets.map(target=>({target,scope,local:template(target,scope),remote:product.values[scope][target],policy:'amber_seo'})))]});
    const input={items:[item(p),item(blocked)]};await fs.writeFile(path.join(dir,'input.json'),JSON.stringify(input));
    const before=await f.fingerprint(),messages=[];
    const args=['--input',path.join(dir,'input.json'),'--output-dir',path.join(dir,'out'),'--expected-database',name,
     '--actor-id',String(f.actor),'--installation-key',f.binding.installationKey];
    assert.equal(await discovery.main(args,{runtime,config:f.config,pool:readonly,env:{},fetchImpl,
     print:s=>messages.push(JSON.parse(s)),printError:s=>messages.push(JSON.parse(s))}),2,JSON.stringify(messages));
    const manifest=JSON.parse(await fs.readFile(path.join(dir,'out/manifest.json'),'utf8'));
    const lines=(await fs.readFile(path.join(dir,'out/results.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(manifest.complete,true,JSON.stringify(lines));assert.equal(manifest.candidates,1,JSON.stringify(lines));assert.equal(manifest.blocked,1);
    assert.ok(lines.find(r=>r.sku===blocked.sku).blockers.some(b=>b.code==='DISCOVERY_WEIGHT_NOT_ROUNDING_ONLY'));
    const packet=JSON.parse(await fs.readFile(path.join(dir,'out/packet-0001.json'),'utf8'));batch.command(packet);
    assert.equal(packet.items[0].remoteProductId,p.remoteId);assert.equal(packet.items[0].fields.length,5);
    assert.equal(packet.items[0].expectedProduct.weight_numeric,'132.300');
    assert.equal(await f.fingerprint(),before);assert.equal(await currentFields(f,p),null);
    assert.ok(calls.includes('/rest/all/V1/products'));assert.ok(calls.includes('/rest/en/V1/products'));
    // The generated packet is directly consumable by the already deployed preview.
    const checked=await batch.preflight(f.config,packet,f.run);assert.equal(checked.counts.readyForApply,1,JSON.stringify(checked));
    assert.equal(await f.fingerprint(),before);
    // Exercise the aggregate file contract with this real discovery journal and canonical PostgreSQL preflight.
    const aggregate=require('../scripts/first-sync-campaign-preview');
    const aggregateRuntime=aggregate.createRuntime(path.resolve(__dirname,'..'));
    aggregateRuntime.batch={...aggregateRuntime.batch,preflight:(config,request,options)=>batch.preflight(config,request,
     {...options,preview:f.run.preview,observeRate:f.run.observeRate,refresh:f.run.refresh})};
    const digest=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const scopeHash=digest(await fs.readFile(path.join(dir,'input.json'))),output=path.join(dir,'campaign'),aggregateMessages=[];
    const aggregateArgs=['--input',path.join(dir,'input.json'),'--scope-sha256',scopeHash,
     '--discovery-manifest',path.join(dir,'out/manifest.json'),'--output-dir',output,'--expected-database',name,
     '--actor-id',String(f.actor),'--installation-key',f.binding.installationKey];
    const callsBefore=f.calls.length;
    assert.equal(await aggregate.main(aggregateArgs,{runtime:aggregateRuntime,config:f.config,pool:f.db,env:{},fetchImpl,
     print:s=>aggregateMessages.push(JSON.parse(s)),printError:s=>aggregateMessages.push(JSON.parse(s))}),2,JSON.stringify(aggregateMessages));
    const reviewBytes=await fs.readFile(path.join(output,'review.json')),review=JSON.parse(reviewBytes);
    assert.equal(review.complete,true,JSON.stringify(review));assert.equal(review.globalFailure,null);
    assert.equal(review.counts.total,2);assert.equal(review.counts.candidates,1);assert.equal(review.counts.checked,1);
    assert.equal(review.counts.selected,0);assert.equal(review.counts.excluded,1);assert.equal(review.counts.discoveryBlocked,1);
    assert.deepEqual(review.exceptions.find(row=>row.code==='CAMPAIGN_NAME_IMPORTS_SEPARATE_PREVIEW')?.skus,[p.sku]);
    assert.deepEqual(review.exceptions.find(row=>row.code==='DISCOVERY_WEIGHT_NOT_ROUNDING_ONLY')?.skus,[blocked.sku]);
    assert.equal(review.directRemoteWrites,0);assert.equal(review.directlyEnqueuedJobs,0);
    const cli={actor:f.actor,database:name,installation:f.binding.installationKey,scopeHash};
    const loaded=await aggregate.loadReview(output,digest(reviewBytes),aggregateRuntime,cli);
    assert.deepEqual(loaded.review,review);assert.equal(loaded.plans.length,1);assert.deepEqual(loaded.plans[0].selections,[]);
    assert.ok(loaded.plans[0].report.results[0].initialImports.length>0);
    assert.deepEqual(review.nameOnlyPreview,[{sku:p.sku,productId:p.id,remoteProductId:packet.items[0].remoteProductId,
     planFile:review.plans[0].file,initialImports:loaded.plans[0].report.results[0].initialImports}]);
    const planPath=path.join(output,review.plans[0].file),planBytes=await fs.readFile(planPath),tampered=JSON.parse(planBytes);
    tampered.request.items[0].remoteProductId+=100;
    await fs.writeFile(planPath,JSON.stringify(tampered));
    await assert.rejects(aggregate.loadReview(output,digest(reviewBytes),aggregateRuntime,cli),{code:'CAMPAIGN_PLAN_CHANGED'});
    await fs.writeFile(planPath,planBytes);
    assert.equal(await f.fingerprint(),before);assert.equal(await currentFields(f,p),null);
    assert.ok(f.calls.slice(callsBefore).every(call=>call.method==='GET'));
   }finally{await readonly.end();await fs.rm(dir,{recursive:true,force:true});}
  });
  const campaign=require('../scripts/first-sync-campaign'),campaignBatch=require('../src/services/magento/first-sync-batch-preflight');
  const campaignRuntime={c,batch:campaignBatch,first:service};
  const campaignRun={...f.run,installation:f.binding.installationKey,
   fetchImpl:require('../scripts/first-sync-local-discovery').getOnly(f.run.fetchImpl)};
  const forbidLiveFetch=subtest=>subtest.mock.method(globalThis,'fetch',async()=>assert.fail('Campaign integration must not use live fetch'));
  async function campaignSelection(p){
   const {observation}=await jobs.recoveryBoundary.observe(f.config,request(f,p),campaignRun);
   const base=await service.inspect(f.config,observation,campaignRun);
   const fields=base.fields.filter(row=>row.canKeepLocal&&[...targets,'price','decor_weight'].includes(row.target))
    .map(({target,scope,local,remote})=>({target,scope,local:local.value,remote:remote.value}));
   const input={bindingRevisionId:f.binding.id,expectedDefinitionHash:observation.amber.compiled.hash,
    items:[{sku:p.sku,expectedProduct:campaignBatch.source(observation.amber.product),remoteProductId:p.remoteId,fields}]};
   const command={...request(f,p),previewToken:base.previewToken,
    choices:service.decisions({choices:fields.map(({target,scope})=>({target,scope,choice:'keep_local'}))})};
   return {request:input,item:input.items[0],command,commandSha256:c.hash(command)};
  }
  async function nonCampaignState(){
   const allowed=new Set(['audit_events','magento_first_sync_sessions','magento_first_sync_fields','magento_first_sync_progress']),data={};
   for(const {tablename}of(await f.db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
    assert.match(tablename,/^[a-z_]+$/);if(allowed.has(tablename))continue;
    data[tablename]=(await f.db.query(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) rows FROM (SELECT to_jsonb(t) j FROM public."${tablename}" t) entries`)).rows[0].rows;
   }
   return data;
  }
  await t.test('campaign canonical callback rejects initial imports outside its write scope with no database changes',async subtest=>{
   forbidLiveFetch(subtest);
   const p=await f.create({sku:'NM99005001',localWeight:'132.300',remoteWeight:132.3,price:1700,remoteId:99501,baseSeoEqual:false});
   const selected=await campaignSelection(p),before=await f.fingerprint(),callsBefore=f.calls.length;
   const checked=await campaignBatch.preflight(f.config,selected.request,campaignRun);
   assert.equal(checked.counts.readyForApply,1,JSON.stringify(checked));
   assert.ok(checked.results[0].initialImports.length>0);assert.deepEqual(checked.results[0].applyInput,selected.command);
   const journal=[];
   const result=await campaign.runItem(campaignRuntime,f.config,selected,campaignRun,
    {append:async value=>journal.push(value),authority:async()=>{}});
   assert.equal(result.status,'blocked',JSON.stringify(result));assert.equal(result.code,'CAMPAIGN_UNAPPROVED_INITIAL_IMPORT');
   assert.deepEqual(journal,[{type:'prepared',sku:p.sku,commandSha256:selected.commandSha256,command:selected.command}]);
   assert.equal(await currentFields(f,p),null);assert.equal(await f.fingerprint(),before);
   assert.ok(f.calls.slice(callsBefore).every(call=>call.method==='GET'));
  });
  await t.test('campaign records only reviewed SEO choices, verifies its receipt read-only and does not blindly replay',async subtest=>{
   forbidLiveFetch(subtest);
   const p=await f.create({sku:'NM99005002',localWeight:'132.300',remoteWeight:132.3,price:1700,remoteId:99502,baseSeoEqual:false});
   await seedRemote(f,p);
   const selected=await campaignSelection(p),checked=await campaignBatch.preflight(f.config,selected.request,campaignRun);
   assert.equal(checked.counts.readyForApply,1,JSON.stringify(checked));assert.deepEqual(checked.results[0].initialImports,[]);
   assert.deepEqual(checked.results[0].applyInput,selected.command);assert.equal(selected.command.choices.length,4);
   assert.ok(selected.command.choices.every(choice=>targets.includes(choice.target)&&choice.choice==='keep_local'));
   const prior=await currentFields(f,p),before=await nonCampaignState(),callsBefore=f.calls.length,journal=[];
   let validated=0;
   const guardedRuntime={...campaignRuntime,first:{...service,prepareDecision:async(...args)=>{
    validated+=1;return service.prepareDecision(...args);
   }}};
   const result=await campaign.runItem(guardedRuntime,f.config,selected,campaignRun,
    {append:async value=>journal.push(value),authority:async()=>{}});
   assert.equal(result.status,'recorded',JSON.stringify(result));assert.equal(validated,1);
   assert.equal(result.result.receipt.alreadyApplied,false);assert.equal(result.result.readyForOutbound,true);
   assert.deepEqual(await nonCampaignState(),before);assert.equal(journal.length,1);
   const current=await currentFields(f,p);
   assert.equal(BigInt(current.session.revision),BigInt(prior.session.revision)+1n);
   assert.ok(current.fields.filter(row=>targets.includes(row.target)).every(row=>row.state==='pending_outward_confirmation'));
   const readonly=new Pool({connectionString:f.url,max:1,options:'-c default_transaction_read_only=on'});
   const recorded=await f.fingerprint();
   try{
    assert.equal((await readonly.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only,'on');
    await campaign.verifyRecorded(campaignRuntime,f.config,selected,result,{...campaignRun,databasePool:readonly});
    assert.equal(await f.fingerprint(),recorded);
   }finally{await readonly.end();}
   validated=0;
   const replay=await campaign.runItem(guardedRuntime,f.config,selected,campaignRun,
    {append:async value=>journal.push(value),authority:async()=>{}});
   assert.equal(replay.status,'unconfirmed',JSON.stringify(replay));assert.equal(validated,0);
   assert.equal(await f.fingerprint(),recorded);assert.equal(journal.length,2);
   assert.ok(f.calls.slice(callsBefore).every(call=>call.method==='GET'));
  });
  await t.test('campaign denies actual source and remote identity drift without a new receipt',async subtest=>{
   forbidLiveFetch(subtest);
   for(const [index,kind]of ['source','identity'].entries()){
    const p=await f.create({sku:'NM9900500'+(3+index),localWeight:'132.300',remoteWeight:132.3,price:1700,remoteId:99503+index,baseSeoEqual:false});
    await seedRemote(f,p);const selected=await campaignSelection(p);
    if(kind==='source')await f.db.query("UPDATE products SET details=jsonb_set(details,'{answers}','{\"campaign_drift\":true}'::jsonb) WHERE id=$1",[p.id]);
    else f.remotes.get(p.sku).id+=100;
    const before=await f.fingerprint(),callsBefore=f.calls.length;
    const result=await campaign.runItem(campaignRuntime,f.config,selected,campaignRun,{append:async()=>{},authority:async()=>{}});
    assert.equal(result.status,'blocked',kind+': '+JSON.stringify(result));
    assert.match(result.code,/^(MAGENTO_|BATCH_|CAMPAIGN_)/);assert.equal(await f.fingerprint(),before);
    assert.ok(f.calls.slice(callsBefore).every(call=>call.method==='GET'));
   }
  });
  await t.test('campaign refuses nonrounding physical weight in the canonical apply callback',async subtest=>{
   forbidLiveFetch(subtest);
   const p=await f.create({sku:'NM99005005',localWeight:'132.300',remoteWeight:140,price:1700,remoteId:99505,baseSeoEqual:false});
   const selected=await campaignSelection(p),before=await f.fingerprint(),callsBefore=f.calls.length;
   const checked=await campaignBatch.preflight(f.config,selected.request,campaignRun);
   assert.equal(checked.counts.readyForApply,0);assert.ok(checked.results[0].blockers.some(row=>row.code==='BATCH_WEIGHT_NOT_ROUNDING_ONLY'));
   const result=await campaign.runItem(campaignRuntime,f.config,selected,campaignRun,{append:async()=>{},authority:async()=>{}});
   assert.equal(result.status,'blocked',JSON.stringify(result));assert.equal(result.code,'BATCH_PLAN_CHANGED');
   assert.equal(await currentFields(f,p),null);assert.equal(await f.fingerprint(),before);
   assert.ok(f.calls.slice(callsBefore).every(call=>call.method==='GET'));
  });
  await t.test('exact numeric NM necklace length keeps raw receipts and ordinary delivery safe',async nested=>{
   const databaseName='amber_first_sync_nm_length_test',target='dovzhyna_namysta_tochna';let n,index=0;
   try{
    n=await setup({databaseName,numericLength:true});await migrationStart(n.url);
    const make=async values=>{
     const p=await n.create({sku:'NM-LENGTH-'+(++index),remoteId:99700+index,localWeight:'132.300',remoteWeight:132,
      price:1700,baseSeoEqual:false,...values});n.remotes.get(p.sku).price=1650;return p;
    };
    const remote=p=>n.remotes.get(p.sku).custom_attributes.find(a=>a.attribute_code===target);
    const local=p=>n.db.query('SELECT * FROM products WHERE id=$1',[p.id]).then(result=>result.rows[0]);
    const lifecycle=p=>n.db.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[p.id]).then(result=>result.rows[0]);
    await nested.test('77,5 and 77.50 receive equal without local rewrite and verify with price, weight and SEO delivery',async()=>{
     const p=await make(),before=await local(p),state=await lifecycle(p),inspection=await inspectChosen(n,p,[]);
     const field=inspection.prepared.rows.find(row=>row.target===target);
     assert.equal(field.status,'equal');assert.equal(field.reason,'NM_EXACT_LENGTH_CM_EQUAL');assert.equal(field.record.state,'equal');
     assert.equal(field.local.value,'77,5');assert.equal(field.remote.value,'77.50');assert.equal(field.record.after,'77,5');
     const choices=localChoices(inspection);assert.equal(choices.length,6);assert.ok(choices.every(choice=>choice.target!==target));
     const applied=await service.apply(n.config,{...request(n,p),previewToken:inspection.previewToken,choices},n.run);
     assert.equal(applied.readyForOutbound,true);
     assert.deepEqual(await local(p),before);assert.deepEqual(await lifecycle(p),state);
     const pending=await currentFields(n,p),length=cleanField(pending.fields.find(row=>row.target===target));
     assert.equal(length.state,'equal');assert.equal(length.before.value,'77,5');assert.equal(length.remote.value,'77.50');
     assert.equal(length.after,'77,5');assert.equal(length.mappingHash,field.record.mappingHash);
     assert.equal(length.source.decision,undefined);
     n.readbackLengths.set(p.sku,'77.50');
     const job=await jobs.enqueue(n.config,request(n,p),n.run);
     assert.ok(job.intent.operations.some(op=>op.payload?.product?.custom_attributes?.some(a=>a.attribute_code===target&&a.value==='77,5')));
     const done=await jobs.applyJob(n.config,job.id,{...n.run,apply:true});assert.equal(done.state,'succeeded',JSON.stringify(done.failure));
     const final=await currentFields(n,p);assert.ok(final.session.completed_at);
     assert.deepEqual(cleanField(final.fields.find(row=>row.target===target)),length);
     assert.ok(final.fields.filter(row=>['price','decor_weight',...targets].includes(row.target)).every(row=>row.state==='outward_verified'));
     assert.equal(remote(p).value,'77.50');assert.deepEqual(await local(p),before);
    });
    for(const [label,localLength,remoteLength]of [
     ['unequal','77,5','78'],['units','77 cm','77 cm'],['range','77-78','77-78'],
     ['malformed decimal','77,5','77,5,0'],['nonfinite','77,5','NaN'],['exponent','77,5','7.75e1'],
     ['empty remote','77,5',''],['absent remote','77,5',null],
     ['precision unequal','77.5000000000000001','77.5000000000000002'],
    ])await nested.test(label+' does not acquire an equal length receipt from numeric normalization',async()=>{
     const p=await make({localLength});remote(p).value=remoteLength;
     const before=await n.fingerprint(),inspection=await inspectChosen(n,p,[]),field=inspection.prepared.rows.find(row=>row.target===target);
     assert.notEqual(field.record.state,'equal');assert.notEqual(field.reason,'NM_EXACT_LENGTH_CM_EQUAL');
     if(remoteLength!==null&&remoteLength!=='')assert.ok(['conflict','review_required','unknown'].includes(field.status),JSON.stringify(field));
     assert.equal(await currentFields(n,p),null);assert.equal(await n.fingerprint(),before);
    });
    await nested.test('unequal high precision readback cannot complete a numerically rounded delivery',async()=>{
     const value='77.5000000000000001',p=await make({localLength:value,remoteLength:value});
     const inspection=await inspectChosen(n,p,[]),choices=localChoices(inspection);
     assert.equal(inspection.prepared.rows.find(row=>row.target===target).record.state,'equal');
     await service.apply(n.config,{...request(n,p),previewToken:inspection.previewToken,choices},n.run);
     const before=await local(p),job=await jobs.enqueue(n.config,request(n,p),n.run);
     n.readbackLengths.set(p.sku,'77.5000000000000002');
     const done=await jobs.applyJob(n.config,job.id,{...n.run,apply:true});assert.notEqual(done.state,'succeeded');
     assert.equal((await currentFields(n,p)).session.completed_at,null);assert.deepEqual(await local(p),before);
     assert.ok((await n.db.query('SELECT * FROM magento_sync_steps WHERE job_id=$1',[job.id])).rows.some(row=>row.dispatched_at&&!row.verified_at));
    });
    await nested.test('independent source drift rejects the old equal preview without writes',async()=>{
     const p=await make(),inspection=await inspectChosen(n,p,[]),writer=new Pool({connectionString:n.url,max:1});
     try{await writer.query("UPDATE products SET details=jsonb_set(details,'{answers,neckle_size}','\"78\"'::jsonb) WHERE id=$1",[p.id]);}
     finally{await writer.end();}
     const before=await n.fingerprint();
     await assert.rejects(service.apply(n.config,{...request(n,p),previewToken:inspection.previewToken,choices:localChoices(inspection)},n.run),
      error=>error.statusCode===409);
     assert.equal(await currentFields(n,p),null);assert.equal(await n.fingerprint(),before);
    });
    for(const [label,change]of [
     ['attribute identity',schema=>{schema.attributes.find(a=>a.attribute_code===target).attribute_id++;}],
     ['attribute type',schema=>{schema.attributes.find(a=>a.attribute_code===target).frontend_input='textarea';}],
     ['set membership',schema=>{schema.attributeSets[0].attributeCodes=schema.attributeSets[0].attributeCodes.filter(code=>code!==target);}],
    ])await nested.test(label+' drift cannot grant scoped equality or consume an old token',async()=>{
     const p=await make(),inspection=await inspectChosen(n,p,[]),schema=structuredClone(n.schema);change(n.schema);
     try{
      const before=await n.fingerprint(),fresh=await inspectChosen(n,p,[]),field=fresh.prepared.rows.find(row=>row.target===target);
      assert.notEqual(field?.record.state,'equal');assert.notEqual(field?.reason,'NM_EXACT_LENGTH_CM_EQUAL');
      await assert.rejects(service.apply(n.config,{...request(n,p),previewToken:inspection.previewToken,choices:localChoices(inspection)},n.run));
      assert.equal(await currentFields(n,p),null);assert.equal(await n.fingerprint(),before);
     }finally{Object.assign(n.schema,schema);}
    });
   }finally{if(n)await n.db.end();await dropTestDatabase(databaseName);}
  });
  await t.test('real current-published rotation denies stale binding before any local authority mutation',async()=>{
   const {p,prior,field,old,progress}=f.bindingFixture,before=await currentFields(f,p),bindings=require('../src/services/magento/binding.service'),options={databasePool:f.db,actorUserId:f.actor,mutationContext:{actorUserId:f.actor}};
   const draft=await bindings.clonePublished(f.binding.id,{expectedRevision:f.binding.revision},options);
   const next=await bindings.publishDraft(draft.id,{expectedRevision:draft.revision,expectedCurrentId:f.binding.id},options);
   assert.notEqual(next.id,f.binding.id);assert.equal(await predicate(f,field,old,progress,prior.session),false);
   await assert.rejects(service.review(f.config,request(f,p),f.run),{code:'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED'});
   await assert.rejects(directFieldAttempt(f,p,field),/FIRST_SYNC_LOCAL_SEO_AUTHORITY_UNPROVEN/);
   assert.deepEqual(await currentFields(f,p),before);
  });
 }finally{if(f)await f.db.end();await dropTestDatabase(name);await harness.pool.end();}
});
