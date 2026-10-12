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
const name='amber_nm_first_sync_seo_test';
async function setup(){
  const url=await recreateTestDatabase(name),db=new Pool({connectionString:url});
  try{
    const prior=await fs.mkdtemp(path.join(os.tmpdir(),'amber-nm-pre075-'));
    try{
      for(const file of await fs.readdir(path.resolve(__dirname,'../migrations')))if(file.endsWith('.sql')&&file<'075')
        await fs.copyFile(path.resolve(__dirname,'../migrations',file),path.join(prior,file));
      await runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations({directory:process.env.NM_SEO_PRIOR_MIGRATIONS}).then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});",{NM_SEO_PRIOR_MIGRATIONS:prior});
    }finally{await fs.rm(prior,{recursive:true});}
    const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','NM fixture Administrator') RETURNING id")).rows[0].id);
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
        [sample.sku,sample.localWeight,sample.price,JSON.stringify({answers:{},manualPriceUah:sample.price})])).rows[0];
      await db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1",[p.id]);
      const values={all:Object.fromEntries(targets.map(t=>[t,sample.baseSeoEqual?template(t,'all'):'Magento NM all '+t+' '+sample.sku])),
        en:Object.fromEntries(targets.map(t=>[t,'Magento NM en '+t+' '+sample.sku]))};
      remotes.set(sample.sku,{id:sample.remoteId,sku:sample.sku,attribute_set_id:8001,type_id:'simple',name:'Fixture name',price:sample.price,status:1,visibility:4,
        custom_attributes:[{attribute_code:'decor_weight',value:sample.remoteWeight},...targets.map(t=>({attribute_code:t,value:values.all[t]}))],extension_attributes:{website_ids:[801],category_links:[]},en:{name:'Fixture name',...values.en}});
      products.push({...sample,id:p.id,publicIdentityId:p.public_product_identity_id,values});return products.at(-1);
    }
    for(const sample of cases)await create(sample);
    let loseNextWrite=false,failReadback=false;
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
          else {const old=r.custom_attributes.find(x=>x.attribute_code===a.attribute_code);if(old)old.value=a.value;else r.custom_attributes.push(a);}
        }
        if(loseNextWrite){loseNextWrite=false;failReadback=true;throw Error('synthetic lost POST response');}
        return new Response(JSON.stringify(r),{headers:{'content-type':'application/json'}});
      }};
    async function fingerprint(){
      const data={};for(const {tablename}of(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
        assert.match(tablename,/^[a-z_]+$/);data[tablename]=(await db.query(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) rows FROM (SELECT to_jsonb(t) j FROM public."${tablename}" t) entries`)).rows[0].rows;
      }return c.hash(data);
    }
    return {db,url,actor,binding,config,run,products,remotes,calls,create,fingerprint,loseWrite:()=>{loseNextWrite=true;}};
  }catch(e){await db.end();throw e;}
}
const request=(f,p)=>({sku:p.sku,bindingRevisionId:f.binding.id});
const currentFields=async(f,p)=>ledger.readOnClient(f.db,{originHash:c.originHash(f.config.baseUrl),publicIdentityId:String(p.publicIdentityId)});
async function kept(f,p){
  const result=await service.review(f.config,request(f,p),f.run),weight=result.fields.find(x=>x.target==='decor_weight');
  const choices=result.fields.filter(x=>targets.includes(x.target)&&x.canAcceptRemote)
    .map(({target,scope})=>({target,scope,choice:'accept_remote'}));
  if(weight.status==='conflict')choices.push({target:'decor_weight',scope:'all',choice:'keep_local'});
  if(choices.length)return service.apply(f.config,{...request(f,p),previewToken:result.previewToken,choices},f.run);
  return result;
}
const cleanField=f=>Object.fromEntries(['target','scope','state','before','remote','after','source','mappingHash'].map(k=>[k,f[k]]));
async function transaction(f,operation){
  const client=await f.db.connect();try{await client.query('BEGIN');const result=await operation(client);await client.query('COMMIT');return result;}
  catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
async function seedPre075(f,p){
  const {observation}=await jobs.recoveryBoundary.observe(f.config,request(f,p),f.run);
  const inspection=await service.inspect(f.config,observation,f.run);
  const fields=inspection.prepared.rows.map(row=>{
    const field=cleanField(row.record);
    if(targets.includes(field.target)){
      field.state=field.scope==='all'&&p.baseSeoEqual?'equal':'review_required';field.after=row.local.value;
      field.source={...field.source,kind:'derived'};delete field.source.seoContract;delete field.source.category;
    }return field;
  });
  await transaction(f,client=>ledger.recordProgressOnClient(client,{key:inspection.first.key,
    identity:{installationKey:f.binding.installationKey,publicSku:p.sku,remoteProductId:String(p.remoteId),contractVersion:'first-sync-v1',initialProductId:p.id,initialBindingRevisionId:f.binding.id},
    expectedRevision:'0',previewHash:c.hash({fixture:'pre-075',sku:p.sku}),fields,actorUserId:f.actor,
    requiredScopes:inspection.prepared.manifest,complete:false,readyForOutbound:false}));
}
const reconcileInput=checked=>({review:checked.review,reviewHash:checked.reviewHash,reason:'Verified fixture delivery after lost response'});
const migrationStart=url=>runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});");

test('observed NM10 SEO adoption is a receipt-backed first delivery with ordinary templates retained',async t=>{
  let f;try{
    f=await setup();t.mock.method(globalThis,'fetch',()=>assert.fail('No live Magento/NBU transport'));
    await t.test('all ten native previews remain read-only and keep nine physical weight decisions',async()=>{
      const before=await f.fingerprint();let conflicts=0;
      for(const p of f.products){const r=await service.review(f.config,request(f,p),f.run);assert.equal(r.mode,'first');
        const weight=r.fields.find(x=>x.target==='decor_weight');assert.equal(weight.local.value,p.localWeight);
        if(weight.status==='conflict'){conflicts++;assert.equal(weight.canKeepLocal,true);assert.equal(weight.canAcceptRemote,false);}
        assert.equal(r.fields.filter(x=>targets.includes(x.target)&&x.status==='conflict').length,p.baseSeoEqual?2:4);assert.equal(r.complete,false);
      }
      assert.equal(conflicts,9);assert.equal(await f.fingerprint(),before);assert.ok(f.calls.every(x=>x.method==='GET'));
    });
    await t.test('existing immutable pre-075 rows retain six equal SEO receipts and admit all 34 reviewed SEO rows',async()=>{
      for(const p of f.products)await seedPre075(f,p);
      assert.equal((await f.db.query("SELECT count(*)::int n FROM magento_first_sync_fields WHERE state='review_required' AND target=ANY($1)",[targets])).rows[0].n,34);
      assert.equal((await f.db.query("SELECT count(*)::int n FROM magento_first_sync_fields WHERE state='equal' AND target=ANY($1)",[targets])).rows[0].n,6);
    });
    await t.test('075 upgrades saved evidence without backfill, rolls back DDL and is inert on repeated startup',async()=>{
      const before=await f.fingerprint(),sql=await fs.readFile(path.resolve(__dirname,'../migrations/075_nm_first_sync_seo_receipts.sql'),'utf8');
      await assert.rejects(transaction(f,async client=>{await client.query(sql);throw Error('fixture migration rollback');}),/fixture migration rollback/);
      assert.equal(await f.fingerprint(),before);
      const check=(await f.db.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='magento_first_sync_fields_state_check'")).rows[0].definition;
      assert.equal(check.includes(seo.PENDING),false);
      const evidence=(await f.db.query('SELECT * FROM magento_first_sync_fields ORDER BY session_id,revision,target,scope')).rows;
      const checksums=(await f.db.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
      await migrationStart(f.url);
      assert.deepEqual((await f.db.query('SELECT * FROM magento_first_sync_fields ORDER BY session_id,revision,target,scope')).rows,evidence);
      assert.deepEqual((await f.db.query("SELECT * FROM schema_migrations WHERE name<'075' ORDER BY name")).rows,checksums);
      const migrated=await f.fingerprint();await migrationStart(f.url);assert.equal(await f.fingerprint(),migrated);
    });
    await t.test('real first jobs suppress SEO for both scopes, ack atomically, preserve inputs and immutable templates',async()=>{
      const definitions=(await f.db.query('SELECT id,definition,definition_hash FROM export_template_versions ORDER BY id')).rows;
      for(const p of f.products){
        const before=(await f.db.query('SELECT * FROM products WHERE id=$1',[p.id])).rows[0];await kept(f,p);
        const checked=await service.review(f.config,request(f,p),f.run);assert.equal(checked.readyForOutbound,true,JSON.stringify(checked.blockers));
        const normal=await jobs.recoveryBoundary.observe(f.config,request(f,p),f.run);assert.equal(normal.report.sendable,true,JSON.stringify(normal.report.blockers));
        let job=await jobs.enqueue(f.config,request(f,p),f.run);assert.ok(job.baseline.firstSyncSeo);
        assert.ok(job.intent.operations.every(op=>!(op.payload?.product?.custom_attributes||[]).some(a=>targets.includes(a.attribute_code))));
        assert.ok(targets.every(target=>!Object.hasOwn(job.intent.englishValues,target)));
        const progress=await currentFields(f,p);assert.equal(progress.session.completed_at,null);assert.equal(progress.fields.filter(x=>x.state===seo.PENDING).length,p.baseSeoEqual?2:4);
        const equalReceipts=progress.fields.filter(x=>x.state==='equal'&&targets.includes(x.target));
        const writes=f.calls.filter(x=>x.method==='POST').length;
        job=await jobs.applyJob(f.config,job.id,{...f.run,apply:true});assert.equal(job.state,'succeeded',JSON.stringify(job.failure));
        const final=await currentFields(f,p);assert.ok(final.session.completed_at);assert.equal(final.fields.filter(x=>x.state===seo.RECEIVED).length,p.baseSeoEqual?2:4);
        assert.deepEqual(final.fields.filter(x=>x.state==='equal'&&targets.includes(x.target)),equalReceipts);
        if(p.sku==='NM111112110022')assert.equal(f.calls.filter(x=>x.method==='POST').length,writes,'all-equal weight still waits for verified ack without any remote mutation');
        const r=f.remotes.get(p.sku);for(const target of targets){assert.equal(r.custom_attributes.find(a=>a.attribute_code===target).value,p.values.all[target]);assert.equal(r.en[target],p.values.en[target]);}
        const after=(await f.db.query('SELECT * FROM products WHERE id=$1',[p.id])).rows[0];
        for(const key of ['weight','total_price_uah','full_sku','public_product_identity_id','details','magento_name_override'])assert.deepEqual(after[key],before[key],key);
        const count=(await f.db.query("SELECT count(*)::int n FROM magento_first_sync_fields WHERE session_id=$1 AND state='seo_received'",[final.session.id])).rows[0].n;
        await jobs.applyJob(f.config,job.id,{...f.run,apply:true});assert.equal((await f.db.query("SELECT count(*)::int n FROM magento_first_sync_fields WHERE session_id=$1 AND state='seo_received'",[final.session.id])).rows[0].n,count);
      }
      assert.deepEqual((await f.db.query('SELECT id,definition,definition_hash FROM export_template_versions ORDER BY id')).rows,definitions);
      assert.equal(f.calls.filter(x=>x.method==='POST').some(x=>(x.body.product.custom_attributes||[]).some(a=>targets.includes(a.attribute_code))),false);
    });
    await t.test('the next distinct ordinary generation uses active SEO templates',async()=>{
      const p=f.products[0];await f.db.query("UPDATE products SET details=details||'{\"ordinaryGenerationFixture\":true}'::jsonb WHERE id=$1",[p.id]);
      const r=await service.review(f.config,request(f,p),f.run);assert.equal(r.mode,'ordinary');
      const job=await jobs.enqueue(f.config,request(f,p),f.run);assert.equal(job.baseline.firstSyncSeo,undefined);
      assert.ok(job.intent.operations.some(op=>(op.payload?.product?.custom_attributes||[]).some(a=>a.attribute_code==='meta_title')));
      const done=await jobs.applyJob(f.config,job.id,{...f.run,apply:true});assert.equal(done.state,'succeeded',JSON.stringify(done.failure));
      for(const target of targets){assert.equal(f.remotes.get(p.sku).custom_attributes.find(a=>a.attribute_code===target).value,template(target,'all'));assert.equal(f.remotes.get(p.sku).en[target],template(target,'en'));}
    });
    await t.test('pending SEO cannot reset, become terminal before ack or hide changed and unavailable remote fields',async()=>{
      const p=await f.create({sku:'NM99001001',localWeight:'5.000',remoteWeight:6,price:900,remoteId:99001,baseSeoEqual:false});
      await kept(f,p);const job=await jobs.enqueue(f.config,request(f,p),f.run),progress=await currentFields(f,p);
      const command=(await f.db.query('SELECT command FROM magento_first_sync_progress WHERE session_id=$1 AND revision=$2',[progress.session.id,progress.session.revision])).rows[0].command;
      const next=fields=>({...command,expectedRevision:progress.session.revision,previewHash:c.hash({fixture:randomUUID()}),fields});
      await assert.rejects(transaction(f,client=>ledger.recordProgressOnClient(client,next(progress.fields.map(f=>targets.includes(f.target)?{...cleanField(f),state:'review_required'}:cleanField(f))))),{code:'FIRST_SYNC_LEDGER_SEO_RECEIPT'});
      await assert.rejects(transaction(f,client=>ledger.recordProgressOnClient(client,next(progress.fields.map(f=>targets.includes(f.target)?{...cleanField(f),state:seo.RECEIVED,source:{...f.source,seoDelivery:{jobId:job.id,planHash:job.plan_hash}}}:cleanField(f))))),/FIRST_SYNC_SEO_DELIVERY_UNPROVEN/);
      assert.deepEqual(await currentFields(f,p),progress);
      const remote=f.remotes.get(p.sku),field=remote.custom_attributes.find(a=>a.attribute_code==='meta_title'),old=field.value;
      for(const value of ['Changed remote title','']){
        field.value=value;const before=await f.fingerprint(),{observation}=await jobs.recoveryBoundary.observe(f.config,request(f,p),f.run),r=await service.inspect(f.config,observation,f.run,{jobId:job.id});
        assert.equal(r.readyForOutbound,false);assert.equal(r.fields.find(f=>f.target==='meta_title'&&f.scope==='all').status,'review_required');
        assert.equal(await f.fingerprint(),before);const checked=await recovery.inspect(f.config,job.id,f.run);
        assert.equal(checked.canReconcile,false);assert.ok(checked.blockers.some(b=>b.code==='MAGENTO_FIRST_SYNC_SEO_RECEIPT_CHANGED'));
      }
      field.value=old;delete remote.en.meta_description;
      const fresh=await jobs.recoveryBoundary.observe(f.config,request(f,p),f.run),r=await service.inspect(f.config,fresh.observation,f.run,{jobId:job.id});assert.equal(r.readyForOutbound,false);
      assert.equal(r.fields.find(f=>f.target==='meta_description'&&f.scope==='en').status,'review_required','confirmed empty is a changed accepted snapshot');
      remote.en.meta_description=p.values.en.meta_description;
      const {observation}=await jobs.recoveryBoundary.observe(f.config,request(f,p),f.run);
      assert.ok(await runtime.readSeoProof(f.db,job,observation),'new request reconstructs proof from immutable ledger');
      observation.domainEvidence.english.id++;
      const unavailable=await service.inspect(f.config,observation,f.run,{jobId:job.id});
      assert.equal(unavailable.readyForOutbound,false);assert.equal(unavailable.fields.find(f=>f.target==='meta_description'&&f.scope==='en').status,'unknown');
      assert.equal(await runtime.readSeoProof(f.db,job,observation),null);
      assert.deepEqual(await currentFields(f,p),progress);
    });
    await t.test('lost response and readback recover using GET observations without repeating a remote mutation',async()=>{
      const p=await f.create({sku:'NM99001002',localWeight:'7.000',remoteWeight:8,price:1200,remoteId:99002,baseSeoEqual:false});
      await kept(f,p);const job=await jobs.enqueue(f.config,request(f,p),f.run);f.loseWrite();
      const uncertain=await jobs.applyJob(f.config,job.id,{...f.run,apply:true});assert.equal(uncertain.state,'uncertain');
      const pending=await currentFields(f,p);assert.equal(pending.session.completed_at,null);assert.equal(pending.fields.filter(f=>f.state===seo.PENDING).length,4);
      const writes=f.calls.filter(x=>x.method==='POST').length,before=await f.fingerprint();
      const checked=await recovery.inspect(f.config,job.id,f.run);assert.equal(checked.canReconcile,true,JSON.stringify(checked.blockers));
      assert.equal(await f.fingerprint(),before);assert.equal(checked.review.complete,true);
      const result=await recovery.reconcile(f.config,job.id,reconcileInput(checked),f.run);assert.equal(result.remoteWrites,0);assert.equal(result.job.state,'succeeded');
      const done=await currentFields(f,p);assert.ok(done.session.completed_at);assert.equal(done.fields.filter(f=>f.state===seo.RECEIVED).length,4);
      assert.equal(f.calls.filter(x=>x.method==='POST').length,writes);
      const terminal=(await f.db.query("SELECT count(*)::int n FROM magento_first_sync_fields WHERE session_id=$1 AND state='seo_received'",[done.session.id])).rows[0].n;
      assert.equal((await recovery.reconcile(f.config,job.id,reconcileInput(checked),f.run)).alreadyApplied,true);
      assert.equal((await f.db.query("SELECT count(*)::int n FROM magento_first_sync_fields WHERE session_id=$1 AND state='seo_received'",[done.session.id])).rows[0].n,terminal);
    });
    await t.test('SEO audit failure rolls back final ack and completion, then verified reconciliation completes exactly once',async()=>{
      const p=await f.create({sku:'NM99001003',localWeight:'9.000',remoteWeight:10,price:1700,remoteId:99003,baseSeoEqual:false});
      await kept(f,p);const job=await jobs.enqueue(f.config,request(f,p),f.run);
      await f.db.query(`CREATE FUNCTION fail_seo_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_key='magento.first_sync_progress_recorded' AND NEW.details->'result'->>'completed'='true' THEN RAISE EXCEPTION 'fixture SEO audit failure'; END IF;RETURN NEW;END $$`);
      await f.db.query('CREATE TRIGGER fail_seo_fixture_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_seo_fixture_audit()');
      try{
        const failed=await jobs.applyJob(f.config,job.id,{...f.run,apply:true});assert.notEqual(failed.state,'succeeded');assert.equal(failed.acknowledged_at,null);
        const pending=await currentFields(f,p);assert.equal(pending.session.completed_at,null);assert.equal(pending.fields.filter(f=>f.state===seo.PENDING).length,4);
        assert.equal((await f.db.query("SELECT count(*)::int n FROM magento_first_sync_fields WHERE session_id=$1 AND state='seo_received'",[pending.session.id])).rows[0].n,0);
      }finally{await f.db.query('DROP TRIGGER fail_seo_fixture_audit ON audit_events');await f.db.query('DROP FUNCTION fail_seo_fixture_audit()');}
      const writes=f.calls.filter(x=>x.method==='POST').length,checked=await recovery.inspect(f.config,job.id,f.run);
      assert.equal(checked.canReconcile,true,JSON.stringify(checked.blockers));
      const result=await recovery.reconcile(f.config,job.id,reconcileInput(checked),f.run);assert.equal(result.job.state,'succeeded');
      const done=await currentFields(f,p);assert.ok(done.session.completed_at);assert.equal(done.fields.filter(f=>f.state===seo.RECEIVED).length,4);
      assert.equal(f.calls.filter(x=>x.method==='POST').length,writes);
    });
  }finally{if(f)await f.db.end();await dropTestDatabase(name);await harness.pool.end();}
});
