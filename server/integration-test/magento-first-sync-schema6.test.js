// Real frozen/catalog/publication shapes in the canonical disposable PG only.
require('../test/setup-env');
const test=require('node:test'),assert=require('node:assert/strict');
const {Client,Pool}=require('pg'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const path=require('node:path'),{randomUUID}=require('node:crypto');
const fixture=require('../test/fixtures/legacy-sv-schema6');
test('actual schema6 first-sync size adoption uses the published conditional routes and exact trimmed text',async t=>{
  const source=new URL(process.env.TEST_DATABASE_URL||'');assert.equal(source.hostname,'127.0.0.1');assert.equal(source.port,'55432');assert.ok(source.pathname.endsWith('_test'));
  const name='amber_schema6_'+process.pid+'_test',control=new Client({connectionString:source.toString()});await control.connect();let created=false,db;
  try{
    await control.query('CREATE DATABASE '+name);created=true;const target=new URL(source);target.pathname='/'+name;
    await promisify(execFile)(process.execPath,['-e',"require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});"],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DATABASE_URL:target.toString()}});
    db=new Pool({connectionString:target.toString(),max:4});t.mock.method(globalThis,'fetch',()=>assert.fail('No remote HTTP permitted'));
    const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Schema6 fixture administrator') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
    for(const category of ['NM','KL','CH','AR','BR'])await db.query('INSERT INTO categories(code,name) VALUES($1,$1)',[category]);
    const f=fixture.data;
    await db.query('INSERT INTO categories(code,name,requires_weight,skip_hidden_sku_questions,marketing_rounding_enabled) VALUES($1,$2,$3,$4,$5)',[f.category.code,f.category.name,f.category.requires_weight,f.category.skip_hidden_sku_questions,f.category.marketing_rounding_enabled]);
    for(const q of f.currentQuestions)await db.query(`INSERT INTO questions(id,category_code,key,label,input_type,required,include_in_sku,sku_index,display_order,sku_separator,visible_if_json,archived,numeric_validation)
      VALUES($1,'SV',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb)`,[q.id,q.key,q.label,q.input_type,q.required,q.include_in_sku,q.sku_index,q.display_order,q.sku_separator,q.visible_if_json===null?null:JSON.stringify(q.visible_if_json),q.archived,q.numeric_validation===null?null:JSON.stringify(q.numeric_validation)]);
    for(const o of f.currentOptions)await db.query(`INSERT INTO options(id,question_id,value_id,sku_code,label,label_en,visible_if_json,hidden_if_json,archived)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,[o.id,o.question_id,o.value_id,o.sku_code,o.label,o.label_en,JSON.stringify(o.visible_if_json),JSON.stringify(o.hidden_if_json),o.archived]);
    await db.query("INSERT INTO sku_schema_versions(id,category_code,version,marker,status,config_hash) VALUES(6,'SV',1,'','active',$1)",[f.schema.config_hash]);
    for(const q of f.questions)await db.query('INSERT INTO sku_schema_questions(id,schema_version_id,question_key,label,sku_index,display_order,required,sku_separator,visible_if_json) VALUES($1,6,$2,$3,$4,$5,$6,$7,$8::jsonb)',[q.id,q.question_key,q.label,q.sku_index,q.display_order,q.required,q.sku_separator,JSON.stringify(q.visible_if_json)]);
    for(const o of f.options)await db.query('INSERT INTO sku_schema_options(id,schema_question_id,value_id,sku_code,label,visible_if_json,hidden_if_json,archived) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',[o.id,o.schema_question_id,o.value_id,o.sku_code,o.label,JSON.stringify(o.visible_if_json),JSON.stringify(o.hidden_if_json),o.archived]);
    const p=fixture.publication(),templates=require('../src/services/export-templates/template.service'),bindings=require('../src/services/magento/binding.service');
    const options={databasePool:db,mutationContext:{actorUserId:actor}};
    const family=await templates.createTemplate({key:'schema6-'+randomUUID(),displayName:'Exact schema6 publication copy',definition:p.definition},options);
    // Restore the already published fixture, rather than republish its unrelated
    // category sources against an intentionally SV-only test catalog.
    const compiled=require('../src/services/export-templates/definition').compileDefinition(p.definition);
    const version={id:randomUUID()};
    await db.query(`INSERT INTO export_template_versions(id,template_id,version_number,source_draft_revision,definition,definition_hash,format_version,evaluator_version,output_contract,published_by_user_id)
      VALUES($1,$2,2,1,$3::jsonb,$4,$5,$6,$7,$8)`,[version.id,family.id,JSON.stringify(compiled.definition),compiled.hash,compiled.definition.formatVersion,compiled.definition.evaluatorVersion,compiled.definition.outputContract,actor]);
    let binding=await bindings.createDraft({installationKey:'schema6-fixture',origin:'https://schema6.invalid',templateVersionId:version.id,observedAt:'2026-10-09T07:10:37Z',schema:p.schema},options);
    binding=await bindings.updateDraft(binding.id,{expectedRevision:binding.revision,bindings:p.bindings},options);
    await db.query("UPDATE magento_binding_revisions SET state='published',revision=revision+1,version_number=2,published_by_user_id=$2,published_at=CURRENT_TIMESTAMP WHERE id=$1",[binding.id,actor]);
    binding=await bindings.getRevision(binding.id,options);
    const config={baseUrl:'https://schema6.invalid'},previews=require('../src/services/magento/sync-preview-db'),project=require('../src/services/magento/first-sync-projection').projectFirstSyncFields;
    const helper=require('../src/services/magento/first-sync-local-apply'),ledger=require('../src/services/magento/first-sync-ledger'),gate=require('../src/services/full-product-cutover-gate'),c=require('../src/services/magento/binding-contract');
    async function copy(id,missingWeightVariant=false){const x=fixture.product(id);
      if(missingWeightVariant){x.weight=null;delete x.details.answers.weight;}
      return (await require('./product-fixture').insertProductFixture(db,`INSERT INTO products(id,full_sku,base_sku,sequence_number,category,weight,sku_schema_version_id,total_price,total_price_uah,price_per_gram,uah_rate,details,legacy_uah_price_unset)
      VALUES($1,$2,$3,$4,'SV',$5,6,$6,$7,$8,$9,$10::jsonb,$11) RETURNING *`,[x.id,x.full_sku,x.base_sku,x.sequence_number,x.weight,x.total_price,x.total_price_uah,x.price_per_gram,x.uah_rate,JSON.stringify(x.details),x.legacy_uah_price_unset])).rows[0];}
    const actual=async id=>(await db.query('SELECT * FROM products WHERE id=$1',[id])).rows[0];
    const rateObservation=await require('../src/services/currency.service').observeUsdRate({databasePool:db,fetchLive:async()=>({rate:40,rateDate:new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Kyiv'}),fetchedAt:new Date().toISOString()})});
    async function prepare(x,value='12/5/3',targetField='rozmir_suveniriv'){
      const amber=await previews.readPreviewProduct(db,{productId:x.id,bindingRevisionId:binding.id});
      const raw={id:10000+x.id,sku:amber.product.public_sku,attribute_set_id:151,name:'Fixture remote UA',price:String(x.total_price_uah),custom_attributes:[{attribute_code:targetField,value}]};
      const observation={amber,raw,schema:binding.schema,domainEvidence:{english:{id:raw.id,sku:raw.sku,fields:{name:'Fixture remote EN'}},failures:[]}};
      const projection=project({observation,currencyEvidence:{verified:true,currency:'UAH'}});
      assert.equal(projection.route?.routeKey,x.details.answers.souvenir===5?'SV.souvenir=value_id:5':'SV.souvenir!=value_id:5');
      const meta=projection.projection.find(m=>m.target===targetField&&m.scope==='all');
      assert.equal(meta.persistence,targetField==='decor_weight'?'weight':'information');
      const field=projection.fields.find(m=>m.target===targetField&&m.scope==='all'),decision=projection.plan.fields.find(m=>m.target===targetField&&m.scope==='all');
      const acceptedFields=decision.status==='imported'?[{target:field.target,scope:'all',state:'imported',before:field.local,remote:field.remote,after:decision.importValue,source:{...meta.source,productId:x.id},mappingHash:meta.mappingHash}]:[];
      const args={config,observation,projection,acceptedFields,actorUserId:actor,rateObservation},validation=await helper.prepareFirstSyncLocal(db,args);
      return {...args,decision,validation,expectedCanonicalHash:validation.canonicalHash};
    }
    async function record(x,args,interrupt=false){const tx=await db.connect();try{await gate.begin(tx,'BEGIN');await tx.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[x.id]);
      const result=await ledger.recordProgressOnClient(tx,{key:{originHash:binding.originHash,publicIdentityId:String(x.public_product_identity_id)},identity:{installationKey:binding.installationKey,publicSku:args.observation.raw.sku,remoteProductId:String(args.observation.raw.id),contractVersion:'first-sync-v1',initialProductId:x.id,initialBindingRevisionId:binding.id},expectedRevision:'0',previewHash:c.hash({id:x.id}),fields:args.acceptedFields,actorUserId:actor,complete:false,readyForOutbound:false,
        applyLocal:async(client,acceptedFields)=>{await helper.applyFirstSyncLocal(client,{...args,acceptedFields});if(interrupt)throw new Error('fixture interrupt before commit');}});await gate.commit(tx);return result;
    }catch(e){await gate.rollback(tx);throw e;}finally{await gate.release(tx);tx.release();}}
    const inactiveTargets=['fraction','kamin_obrobka','kamin_suvenirnyi'];
    const firstSync=require('../src/services/magento/first-sync.service');
    const conditionalConfig={...config,configured:true,consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
    const httpMethods=[];
    const conditionalOptions={...options,actorUserId:actor,observeRate:async()=>rateObservation,
      fetchImpl:async(_url,init)=>{
        httpMethods.push(init?.method||'GET');assert.equal(init?.method||'GET','GET');
        assert.ok(new URL(_url).pathname.endsWith('/store/storeConfigs'));
        return new Response(JSON.stringify([{id:1,code:'ua',website_id:1,locale:'uk_UA',base_currency_code:'UAH'},
          {id:3,code:'en',website_id:1,locale:'en_US',base_currency_code:'UAH'}]),{status:200,headers:{'content-type':'application/json'}});
      }};
    // These are complete synthetic variants of frozen historical copies. The
    // supplied names, size and decimal mirror are not claims about live stock.
    async function conditionalCopy(id){const x=await copy(id),details=structuredClone(x.details);
      Object.assign(details.answers,{size:'7.5/7.5/7',weight:String(Number(x.weight)),stone_processing:1});
      await db.query(`UPDATE products SET details=$2::jsonb,magento_name_subject_ua='Тестовий сувенір',
        magento_name_subject_en='Test souvenir' WHERE id=$1`,[id,JSON.stringify(details)]);
      await db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1",[id]);
      return actual(id);
    }
    async function conditionalObservation(x,value=''){
      const amber=await previews.readPreviewProduct(db,{productId:x.id,bindingRevisionId:binding.id});
      const raw={id:10000+x.id,sku:amber.product.public_sku,attribute_set_id:151,name:'',price:String(x.total_price_uah),
        custom_attributes:inactiveTargets.map(attribute_code=>({attribute_code,value}))};
      return {amber,raw,schema:binding.schema,domainEvidence:{english:{id:raw.id,sku:raw.sku,fields:{name:''}},failures:[]}};
    }
    async function conditionalState(x){const client=await db.connect();try{
      await client.query('BEGIN');const state=await require('../src/services/magento/sync-job-transaction').readState(client,conditionalConfig,{bindingRevisionId:binding.id},conditionalOptions,x.full_sku);
      await gate.commit(client);return state;
    }catch(error){await gate.rollback(client);throw error;}finally{await gate.release(client);client.release();}}
    const durableSnapshot=async()=> (await db.query(`SELECT
      (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,
      (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) lifecycle,
      (SELECT jsonb_agg(s ORDER BY origin_hash,public_product_identity_id) FROM magento_name_sync_states s) names,
      (SELECT jsonb_agg(s ORDER BY id) FROM magento_first_sync_sessions s) sessions,
      (SELECT jsonb_agg(r ORDER BY session_id,revision) FROM magento_first_sync_progress r) progress,
      (SELECT jsonb_agg(f ORDER BY session_id,revision,target,scope) FROM magento_first_sync_fields f) fields,
      (SELECT jsonb_agg(r ORDER BY public_product_identity_id) FROM magento_product_sync_requests r) requests,
      (SELECT jsonb_agg(j ORDER BY id) FROM magento_sync_jobs j) jobs,
      (SELECT jsonb_agg(s ORDER BY job_id,ordinal) FROM magento_sync_steps s) steps,
      (SELECT jsonb_agg(i ORDER BY id) FROM public_product_identities i) identities,
      (SELECT jsonb_agg(r ORDER BY full_sku) FROM sku_registry r) reservations,
      (SELECT jsonb_agg(r ORDER BY currency_pair) FROM exchange_rate_cache r) rates,
      (SELECT jsonb_agg(a ORDER BY id) FROM audit_events a) audits`)).rows[0];
    const canonicalSnapshot=async()=>Object.fromEntries(Object.entries(await durableSnapshot()).filter(([key])=>!['sessions','progress','fields','audits'].includes(key)));
    function assertInactive(inspection){assert.equal(inspection.mode,'first');
      for(const target of inactiveTargets){const field=inspection.fields.find(f=>f.target===target&&f.scope==='all');
        assert.equal(field?.status,'optional_empty',JSON.stringify({target,field,blockers:inspection.blockers}));
        assert.deepEqual(field.local,{known:true,present:false,value:''});assert.equal(field.canAcceptRemote,false);assert.equal(field.canKeepLocal,false);
        assert.ok(inspection.coverage.fields.some(f=>f.target===target&&f.scope==='all'&&f.persistence==='derived'));
      }
    }
    await t.test('actual positive-weight SV116007 adopts missing size through exact published trim and shared set route',async()=>{
      const x=await copy(1919),before=await actual(x.id),args=await prepare(x);assert.equal(args.decision.status,'imported');assert.deepEqual(args.validation.blockedFields,[]);
      assert.equal((await record(x,args)).alreadyApplied,false);const after=await actual(x.id);
      const expected=structuredClone(before);expected.details.answers.size='12/5/3';assert.deepEqual(after,expected);
      assert.equal((await record(x,args)).alreadyApplied,true);assert.deepEqual(await actual(x.id),after);
      assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product_information.updated' AND subject_id=$1",[String(x.id)])).rows[0].n,1);
      assert.equal((await db.query('SELECT revision FROM product_full_export_state WHERE product_id=$1',[x.id])).rows[0].revision,'2');
      const fresh=await prepare(await actual(x.id));assert.equal(fresh.decision.status,'equal');
    });
    await t.test('actual zero-weight copy progresses size only; rollback and retry preserve all old SKU answers and history',async()=>{
      const x=await copy(782),before=await actual(x.id),args=await prepare(x);assert.deepEqual(args.validation.blockedFields,[]);
      await assert.rejects(record(x,args,true),/fixture interrupt/);assert.deepEqual(await actual(x.id),before);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_first_sync_sessions WHERE public_product_identity_id=$1',[x.public_product_identity_id])).rows[0].n,0);
      await record(x,args);const after=await actual(x.id),expected=structuredClone(before);expected.details.answers.size='12/5/3';assert.deepEqual(after,expected);assert.equal(after.weight,'0.000');
      assert.equal(args.projection.complete,false);assert.ok(args.projection.plan.fields.some(f=>['review_required','unknown','conflict'].includes(f.status)));
    });
    await t.test('trimmed remote text and unknown branch evidence never create an import receipt',async()=>{
      const x=await copy(1920),before=await actual(x.id),args=await prepare(x,' 12/5/3 ');assert.equal(args.decision.status,'review_required');assert.equal(args.projection.projection.find(m=>m.target==='rozmir_suveniriv').reason,'CANONICAL_INFORMATION_VALUE_NORMALIZED');assert.deepEqual(args.acceptedFields,[]);assert.deepEqual(await actual(x.id),before);
      const product=args.observation.amber.product,old=product.details.answers.souvenir;delete product.details.answers.souvenir;
      const blocked=project({observation:args.observation,currencyEvidence:{verified:true,currency:'UAH'}});product.details.answers.souvenir=old;
      assert.equal(blocked.mode,'review_required');assert.equal(blocked.blockers[0].code,'CATEGORY_REMOTE_ROUTE_NOT_APPROVED');
    });
    await t.test('explicit missing-weight variant of coherent actual stone schema preserves Manual UAH and does not infer other SKU answers',async()=>{
      const x=await copy(4042,true),before=await actual(x.id),args=await prepare(x,'58.125','decor_weight');
      assert.equal(args.decision.status,'imported');assert.deepEqual(args.validation.blockedFields,[]);assert.ok(args.validation.canonicalHash);
      assert.equal(before.legacy_uah_price_unset,fixture.product(4042).legacy_uah_price_unset);
      await record(x,args);const after=await actual(x.id);assert.equal(after.weight,'58.125');assert.equal(after.details.answers.weight,'58.125');
      assert.deepEqual({...after.details.answers,weight:undefined},{...before.details.answers,weight:undefined});
      assert.equal(after.total_price_uah,before.total_price_uah);assert.equal(after.details.manualPriceUah,before.details.manualPriceUah);
      for(const key of ['full_sku','base_sku','sequence_number','sku_schema_version_id','public_product_identity_id','characteristic_version_id','status'])assert.equal(after[key],before[key]);
      const audit=(await db.query("SELECT details FROM audit_events WHERE event_key='product.first_sync_canonical_adopted' AND subject_id=$1",[String(x.id)])).rows;
      assert.equal(audit.length,1);assert.equal(audit[0].details.evidence.legacyProof.schemaHash,fixture.data.provenance.frozenHash);
      assert.equal(audit[0].details.evidence.legacyProof.interpretation.sequenceNumber,58);
      assert.equal((await record(x,args)).alreadyApplied,true);assert.deepEqual(await actual(x.id),after);
    });
    await t.test('legacy price-authority flag is copied exactly and blocks canonical adoption in the1835 variant',async()=>{
      const x=await copy(1835,true),before=await actual(x.id),args=await prepare(x,'16.125','decor_weight');
      assert.equal(before.legacy_uah_price_unset,true);assert.equal(args.validation.blockedFields.length,1);
      assert.equal(args.validation.blockedFields[0].code,'FIRST_SYNC_CANONICAL_PRICE_MODE_UNPROVEN');
      await assert.rejects(record(x,args),/PRICE_MODE_UNPROVEN/);assert.deepEqual(await actual(x.id),before);
    });
    await t.test('raw nullable size authority and concurrent inserted SKU/price dependencies cannot write size or receipts',async()=>{
      const x=await actual(1920),before=structuredClone(x);
      try{await db.query("UPDATE questions SET include_in_sku=NULL WHERE category_code='SV' AND key='size'");const args=await prepare(x);
        assert.equal(args.validation.blockedFields.length,1);await assert.rejects(record(x,args),/безпечним/);assert.deepEqual(await actual(x.id),before);
      }finally{await db.query("UPDATE questions SET include_in_sku=0 WHERE category_code='SV' AND key='size'");}
      for(const kind of ['sku','pricing']){
        const args=await prepare(x),writer=await db.connect();assert.deepEqual(args.validation.blockedFields,[]);
        try{await writer.query('BEGIN');
          if(kind==='sku')await writer.query(`INSERT INTO questions(category_code,key,label,input_type,required,include_in_sku,sku_index,visible_if_json)
            VALUES('SV','first_sync_race','Concurrent dependency','options',0,1,20,'{"size":"12/5/3"}')`);
          else await writer.query(`INSERT INTO price_scenarios(category_code,name,group_name,match_json,axis_x_key,axis_y_key,priority,status,price_mode,apply_modifiers)
            VALUES('SV','Concurrent size price','Fixture','{}','size','',1,'active','fixed_uah',false)`);
          await assert.rejects(record(x,args),/lock|validation/i);assert.deepEqual(await actual(x.id),before);
          assert.equal((await db.query('SELECT count(*)::int n FROM magento_first_sync_sessions WHERE public_product_identity_id=$1',[x.public_product_identity_id])).rows[0].n,0);
        }finally{await writer.query('ROLLBACK');writer.release();}
      }
    });
    await t.test('published souvenir4 and6 inactive fields stay visible in a read-only public preview',async()=>{
      for(const id of [5009,3086]){
        const x=await conditionalCopy(id),observation=await conditionalObservation(x),methods=[];
        assert.deepEqual(require('../src/services/export-templates/evaluate').evaluateProduct(compiled,observation.amber.product).errors,[]);
        const previewOptions={...conditionalOptions,
          preview:async(config,input)=>require('../src/services/magento/sync-preview').previewProduct(config,{...input,
            discover:async()=>binding.schema,categoryObservation:{trees:[],categoryFailures:[]}}),
          fetchImpl:async(url,init)=>{const parsed=new URL(url),pathname=parsed.pathname;
            methods.push(init?.method||'GET');assert.equal(init?.method||'GET','GET','No remote write is permitted during preview');
            if(pathname.endsWith('/store/storeConfigs'))return conditionalOptions.fetchImpl(url,init);
            let body;
            if(pathname.endsWith('/products')){assert.equal(parsed.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'),observation.raw.sku);body={items:[observation.raw],total_count:1};}
            else if(pathname.includes('/inventory/stock-resolver/'))body={stock_id:1,extension_attributes:{sales_channels:[{type:'website',code:'base'}]}};
            else if(pathname.includes('/inventory/get-sources-assigned-to-stock-ordered-by-priority/'))body=[{source_code:'default',enabled:true}];
            else if(pathname.endsWith('/inventory/source-items'))body={items:[{sku:observation.raw.sku,source_code:'default',quantity:1,status:1}],total_count:1};
            else assert.fail('Unexpected fixture GET: '+pathname);
            return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
          }};
        const before=await durableSnapshot(),request={sku:observation.raw.sku,bindingRevisionId:binding.id};
        const first=await firstSync.review(conditionalConfig,request,previewOptions);assertInactive(first);
        assert.equal(first.blockers.some(b=>inactiveTargets.includes(b.target)&&b.reason==='FIELD_BINDING_NOT_APPROVED'),false);
        assert.deepEqual(await durableSnapshot(),before,'Preview cannot create receipts, audit, queue, rate cache or canonical writes');
        const repeated=await firstSync.review(conditionalConfig,request,previewOptions);assertInactive(repeated);
        assert.equal(repeated.previewToken,first.previewToken);assert.deepEqual(await durableSnapshot(),before);
        assert.ok(methods.length>0);assert.ok(methods.every(method=>method==='GET'));
      }
    });
    await t.test('inactive receipts persist without canonical or remote writes and cannot reopen after a later remote change',async()=>{
      const x=await actual(5009),observation=await conditionalObservation(x),state=await conditionalState(x);
      const inspection=await firstSync.inspect(conditionalConfig,observation,conditionalOptions);assertInactive(inspection);
      for(const target of inactiveTargets)assert.ok(inspection.prepared.manifest.some(f=>f.target===target&&f.scope==='all'));
      const before=await canonicalSnapshot(),requests=httpMethods.length;
      const result=await firstSync.commit(conditionalConfig,inspection,state,conditionalOptions);
      assert.equal(result.localChanged,false);assert.deepEqual(await canonicalSnapshot(),before);assert.equal(httpMethods.length,requests);
      const receipts=async()=> (await db.query(`SELECT f.target,f.scope,f.state,f.evidence FROM magento_first_sync_fields f
        JOIN magento_first_sync_sessions s ON s.id=f.session_id WHERE s.public_product_identity_id=$1 AND f.target=ANY($2::text[])
        ORDER BY f.revision,f.target,f.scope`,[x.public_product_identity_id,inactiveTargets])).rows;
      const received=await receipts();assert.equal(received.length,3);assert.ok(received.every(f=>f.state==='optional_empty'));
      const durable=await durableSnapshot();
      const changed=await firstSync.inspect(conditionalConfig,await conditionalObservation(x,'new remote value'),conditionalOptions);
      assert.equal(changed.mode,'first',JSON.stringify(changed.blockers));
      for(const target of inactiveTargets){const field=changed.fields.find(f=>f.target===target);assert.equal(field.received,true);assert.equal(field.canAcceptRemote,false);assert.equal(field.canKeepLocal,false);
        const row=changed.prepared.rows.find(f=>f.target===target);assert.equal(row.record.state,'optional_empty');assert.equal(row.terminal,true);}
      assert.deepEqual(await receipts(),received);assert.deepEqual(await durableSnapshot(),durable);
    });
    await t.test('actual stone route and malformed inactive observations retain their blockers without side effects',async()=>{
      const stone=await conditionalCopy(2198),stoneObservation=await conditionalObservation(stone);
      const before=await durableSnapshot(),active=await firstSync.inspect(conditionalConfig,stoneObservation,conditionalOptions);
      assert.equal(active.projection.route.routeKey,'SV.souvenir=value_id:5');
      assert.equal(active.projection.projection.find(f=>f.target==='kamin_obrobka').persistence,'characteristic');
      for(const target of inactiveTargets)assert.equal(active.projection.fields.find(f=>f.target===target).mapping.proven,true);
      assert.notEqual(active.fields.find(f=>f.target==='kamin_obrobka').status,'optional_empty');
      const x=await actual(3086);
      for(const value of [false,0,{unexpected:'value'},'populated']){
        const rejected=await firstSync.inspect(conditionalConfig,await conditionalObservation(x,value),conditionalOptions);
        for(const target of inactiveTargets)assert.notEqual(rejected.fields.find(f=>f.target===target).status,'optional_empty');
      }
      const malformed=await conditionalObservation(x);malformed.raw.custom_attributes={not:'an attribute list'};
      await assert.rejects(firstSync.inspect(conditionalConfig,malformed,conditionalOptions),{code:'FIRST_SYNC_PROJECTION_INPUT_INVALID'});
      assert.deepEqual(await durableSnapshot(),before);assert.ok(httpMethods.every(method=>method==='GET'));
    });
    await t.test('all six legal historical empty fields recover same-revision before proof in read-only audit, including completed history',async()=>{
      const savedProof=require('../test/fixtures/first-sync-original-revision.json');
      for(const [id,complete] of [[1018,false],[955,true]]){
        const x=await conditionalCopy(id),observed=await conditionalObservation(x);
        const projection=project({observation:observed,currencyEvidence:{verified:true,currency:'UAH'}});
        const manifestHash=require('../src/services/magento/first-sync-progress-plan').prepareProgress(projection,null).manifestHash;
        // Explicit old snapshot copied from the production proof slice. Current
        // fixture answers differ: they cannot establish the original conditions.
        const fields=savedProof.records.map(saved=>{
          const {key:_key,originalMappingHash:_originalHash,...record}=structuredClone(saved);
          const meta=projection.projection.find(p=>p.target===record.target&&p.scope===record.scope);
          const source={...meta.source,productId:id,manifestHash};delete source.requirednessEvidence;
          return {...record,source,mappingHash:meta.mappingHash};
        });
        const tx=await db.connect();let receipt;
        try{await gate.begin(tx,'BEGIN');receipt=await ledger.recordProgressOnClient(tx,{
          key:{originHash:binding.originHash,publicIdentityId:String(x.public_product_identity_id)},
          identity:{installationKey:binding.installationKey,publicSku:observed.raw.sku,remoteProductId:String(observed.raw.id),
            contractVersion:'first-sync-v1',initialProductId:id,initialBindingRevisionId:binding.id},
          expectedRevision:'0',previewHash:c.hash({fixture:'legal-original-empty',id}),fields,actorUserId:actor,
          requiredScopes:fields.map(({target,scope})=>({target,scope})),complete,readyForOutbound:complete});await gate.commit(tx);
        }catch(e){await gate.rollback(tx);throw e;}finally{await gate.release(tx);tx.release();}
        const before=await durableSnapshot(),requests=httpMethods.length;
        const report=await require('../scripts/magento-first-sync-optional-audit').runAudit(db,{session:receipt.sessionId});
        assert.equal(report.readOnly,true);assert.equal(report.blockedSessionCount,0,JSON.stringify(report));
        assert.equal(report.sessions[0].evidence.length,6);assert.ok(report.sessions[0].evidence.every(f=>f.state==='inactive'));
        assert.deepEqual(await durableSnapshot(),before,'Original receipts, product, audit, jobs and cache stay unchanged');
        assert.equal(httpMethods.length,requests,'Audit cannot call Magento');
      }
    });
    await t.test('old required-field optional receipts block incomplete and completed sessions before enqueue or dispatch without rewriting history',async()=>{
      const jobs=require('../src/services/magento/sync-job.service');
      const blocker='FIRST_SYNC_OPTIONAL_EMPTY_RECEIPT_REVIEW_REQUIRED';
      const ledgerSnapshot=async()=>{const state=await durableSnapshot();return {sessions:state.sessions,progress:state.progress,fields:state.fields};};
      for(const [id,complete] of [[4043,false],[1359,true]]){
        // Reproduce a historical bad receipt under the real published stone
        // route. This is explicit synthetic history, not a repair of live stock.
        let x=await conditionalCopy(id),details=structuredClone(x.details);
        delete details.answers.stone_processing;details.answers.weight='1';
        await db.query('UPDATE products SET weight=1,details=$2::jsonb WHERE id=$1',[id,JSON.stringify(details)]);
        x=await actual(id);let observed=await conditionalObservation(x);
        const projection=project({observation:observed,currencyEvidence:{verified:true,currency:'UAH'}});
        const meta=projection.projection.find(f=>f.target==='kamin_obrobka'&&f.scope==='all');
        assert.equal(meta.source.key,'stone_processing');assert.equal(meta.source.routeKey,'SV.souvenir=value_id:5');
        const empty={known:true,present:false,value:''};
        const old={target:'kamin_obrobka',scope:'all',state:'optional_empty',before:empty,remote:empty,after:null,
          source:{...meta.source,productId:id,manifestHash:require('../src/services/magento/first-sync-progress-plan').prepareProgress(projection,null).manifestHash},mappingHash:meta.mappingHash};
        delete old.source.requirednessEvidence; // Pre-fix historical receipts did not capture this proof.
        // The same old command accepted a price conflict. Its canonical result
        // is already present in this fixture; retrying that receipt is not new authority.
        const priceMeta=projection.projection.find(f=>f.target==='price'&&f.scope==='all');
        const priceReceipt={target:'price',scope:'all',state:'imported',before:{known:true,present:true,value:'1',unit:'UAH'},
          remote:{known:true,present:true,value:String(x.total_price_uah),unit:'UAH'},after:String(x.total_price_uah),
          source:{...priceMeta.source,productId:id,manifestHash:old.source.manifestHash,decision:'accept_remote'},mappingHash:priceMeta.mappingHash};
        const oldPreviewToken=c.hash({fixture:'old-required-optional',id}),oldDecision={target:'price',scope:'all',choice:'accept_remote'};
        const tx=await db.connect();try{await gate.begin(tx,'BEGIN');
          await ledger.recordProgressOnClient(tx,{key:{originHash:binding.originHash,publicIdentityId:String(x.public_product_identity_id)},
            identity:{installationKey:binding.installationKey,publicSku:observed.raw.sku,remoteProductId:String(observed.raw.id),contractVersion:'first-sync-v1',initialProductId:id,initialBindingRevisionId:binding.id},
            expectedRevision:'0',previewHash:c.hash({previewToken:oldPreviewToken,decision:oldDecision}),fields:[old,priceReceipt],actorUserId:actor,
            requiredScopes:[{target:old.target,scope:old.scope},{target:'price',scope:'all'}],complete,readyForOutbound:complete});
          await gate.commit(tx);
        }catch(error){await gate.rollback(tx);throw error;}finally{await gate.release(tx);tx.release();}
        const originalLedger=await ledgerSnapshot();let dispatches=0;
        const beforeAudit=await durableSnapshot();
        const sessionId=originalLedger.sessions.find(value=>String(value.public_product_identity_id)===String(x.public_product_identity_id)).id;
        const report=await require('../scripts/magento-first-sync-optional-audit').runAudit(db,{session:sessionId});
        assert.equal(report.readOnly,true);assert.equal(report.scopeComplete,true);assert.equal(report.truncated,false);
        assert.equal(report.sessionCount,1);assert.equal(report.blockedSessionCount,1);
        const audit=report.sessions[0];assert.equal(audit.sessionId,sessionId);assert.equal(Boolean(audit.completedAt),complete);
        assert.ok(audit.blockers.some(value=>value.code===blocker));
        assert.equal(audit.evidence.find(value=>value.target==='kamin_obrobka').state,'required',JSON.stringify(audit));
        assert.deepEqual(await durableSnapshot(),beforeAudit,'Receipt audit is SELECT-only even inside a read-only transaction');
        const runtimeOptions={...conditionalOptions,apply:true,preview:async(_config,input)=>{input.onObservation(observed);return {};},
          dispatch:async()=>{dispatches++;assert.fail('Historical required-field optional receipt must never authorize Magento writes');}};
        const request={sku:observed.raw.sku,bindingRevisionId:binding.id};
        const beforeReplay=await durableSnapshot();
        const replay=await firstSync.apply(conditionalConfig,{...request,previewToken:oldPreviewToken,...oldDecision},runtimeOptions);
        assert.equal(replay.receipt.alreadyApplied,true);assert.equal(replay.receipt.state,'imported');
        assert.deepEqual(await durableSnapshot(),beforeReplay,'An old decision replay returns its immutable receipt without granting fresh authority');
        for(const phase of ['empty','remote_filled','local_filled_different']){
          if(phase==='remote_filled')observed.raw.custom_attributes=[{attribute_code:'kamin_obrobka',value:'6040'}];
          if(phase==='local_filled_different'){
            details.answers.stone_processing=1;
            await db.query('UPDATE products SET details=$2::jsonb WHERE id=$1',[id,JSON.stringify(details)]);
            x=await actual(id);observed=await conditionalObservation(x);
            observed.raw.custom_attributes=[{attribute_code:'kamin_obrobka',value:'6040'}];
            const fresh=project({observation:observed,currencyEvidence:{verified:true,currency:'UAH'}});
            assert.equal(fresh.fields.find(f=>f.target==='kamin_obrobka').local.forwardOptionId,'6039');
          }
          const before=await durableSnapshot();
          const preview=await firstSync.review(conditionalConfig,request,runtimeOptions);
          assert.equal(preview.mode,'review',phase);assert.equal(preview.readyForOutbound,false,phase);
          assert.ok(preview.blockers.some(value=>value.code===blocker),phase+': '+JSON.stringify(preview.blockers));
          assert.deepEqual(await durableSnapshot(),before,'Historical review must be read-only: '+phase);
          await assert.rejects(jobs.enqueue(conditionalConfig,request,runtimeOptions),{code:'MAGENTO_'+blocker});
          assert.deepEqual(await durableSnapshot(),before,'Refused enqueue cannot mutate durable state: '+phase);
          assert.deepEqual(await ledgerSnapshot(),originalLedger);
        }
        // A job written by an older worker cannot bypass the same protection
        // through the existing-job enqueue shortcut or the apply boundary.
        const state=await conditionalState(x),jobId=randomUUID();
        const intent={mode:'update',operations:[{domain:'coreProduct',payload:{product:{sku:observed.raw.sku,
          custom_attributes:[{attribute_code:'kamin_obrobka',value:'6039'}]}}}],websiteIds:[],englishValues:{}};
        await db.query(`INSERT INTO magento_sync_jobs(id,product_id,public_product_identity_id,sku,installation_key,origin_hash,
          binding_revision_id,binding_hash,amber_hash,plan_hash,intent,baseline,created_by_user_id,remote_product_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)`,
        [jobId,id,x.public_product_identity_id,observed.raw.sku,binding.installationKey,binding.originHash,binding.id,
          state.bindingHash,state.amberHash,c.hash(intent),JSON.stringify(intent),JSON.stringify({raw:observed.raw,domainEvidence:observed.domainEvidence,preservation:{}}),actor,observed.raw.id]);
        const beforeFastPath=await durableSnapshot();
        await assert.rejects(jobs.enqueue(conditionalConfig,request,runtimeOptions),{code:'MAGENTO_'+blocker});
        assert.deepEqual(await durableSnapshot(),beforeFastPath);
        const applied=await jobs.applyJob(conditionalConfig,jobId,runtimeOptions);
        assert.equal(applied.state,'blocked');assert.equal(applied.failure.code,'MAGENTO_'+blocker);
        assert.equal(dispatches,0);assert.deepEqual(await ledgerSnapshot(),originalLedger);
        assert.deepEqual(await actual(id),x,'Refusing a historical receipt cannot import or overwrite current values');
        assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_steps WHERE job_id=$1',[jobId])).rows[0].n,0);
      }
    });
    await t.test('unchanged actual1835 can complete reviewed recount with explicit weight and unchanged Manual950 without clearing original history',async()=>{
      // Restore the exact captured source after the deliberately missing-weight
      // negative variant. The entered12.5g is an explicit fixture Admin decision,
      // not a measurement claimed for the real product or an inferred suffix.
      // Same audited disposable activation protocol as the native integration
      // fixtures; all old legacy copies were inserted before activation.
      const activation=await db.connect();
      try { await activation.query('BEGIN');
        const event=(await activation.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id)
          VALUES('public_sku.activated',$1,'{"displayName":"Schema6 fixture administrator","preferredUsername":null}','public_sku_activation','singleton') RETURNING id`,[actor])).rows[0].id;
        await activation.query("SET LOCAL amber.public_sku_activation='on'");
        await activation.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton',[actor,event]);
        const cutover=(await activation.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id)
          VALUES('magento_delivery.cutover',$1,'{"displayName":"Schema6 fixture administrator","preferredUsername":null}','magento_auto_sync_activation','singleton') RETURNING id`,[actor])).rows[0].id;
        await activation.query("SET LOCAL amber.magento_delivery_cutover='on'");
        await activation.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,
          legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton`,[binding.installationKey,actor,cutover]);
        await activation.query('COMMIT');
      } catch(error) { await activation.query('ROLLBACK');throw error; }
      finally { activation.release(); }
      const captured=fixture.product(1835);
      await db.query('UPDATE products SET weight=$2,details=$3::jsonb WHERE id=$1',[captured.id,captured.weight,JSON.stringify(captured.details)]);
      const before=await actual(captured.id),products=require('../src/services/product.service');
      assert.equal(before.weight,'0.000');assert.equal(before.details.answers.weight,'8,7');
      assert.equal(before.total_price_uah,'950.00');assert.equal(before.legacy_uah_price_unset,true);
      const input={sourceSku:before.full_sku,answers:{...before.details.answers},weight:12.5,
        pricingDecision:{mode:'manual_uah',manualPriceUah:950},reason:'Fixture explicitly reviewed weight'};
      const opts={databasePool:db,mutationContext:{actorUserId:actor},rateObservation,magentoConfig:config};
      await assert.rejects(products.buildProductRecountPreview(input,opts),{code:'WEIGHT_CONFLICT'});
      input.answers.weight='12.5'; // Explicit same confirmed weight for physical and mirror.
      await assert.rejects(products.buildProductRecountPreview(input,opts),error=>error.statusCode===422&&/Додатково камінь/.test(error.message));
      await assert.rejects(products.buildProductRecountPreview({...input,answers:{...input.answers,additional_stone:0}},opts),error=>error.statusCode===422&&/Додатково камінь/.test(error.message));
      assert.deepEqual(await actual(before.id),before);
      // Admin explicitly leaves the optional field blank using the existing
      // UI's «Не обрано» null, instead of inheriting a decoded zero placeholder.
      input.answers.additional_stone=null;
      const preview=await products.buildProductRecountPreview(input,opts);
      const payload={...input,previewToken:preview.previewToken,sourceStateSignature:preview.source.stateSignature};
      await assert.rejects(products.applyProductRecount(payload,opts),{statusCode:403});
      assert.deepEqual(await actual(before.id),before);
      await assert.rejects(products.applyProductRecount({...payload,pricingDecision:{mode:'manual_uah',manualPriceUah:1}},
        {...opts,authorizedDirectDecision:true}),{publicCode:'RECOUNT_PREVIEW_STALE'});
      assert.deepEqual(await actual(before.id),before);
      const result=await products.applyProductRecount(payload,{...opts,authorizedDirectDecision:true});
      const successor=await actual(result.correctedProductId),original=await actual(before.id);
      assert.equal(successor.status,'active');assert.equal(successor.legacy_uah_price_unset,false);
      assert.equal(successor.total_price_uah,'950.00');assert.equal(successor.details.manualPriceUah,950);
      assert.equal(successor.weight,'12.500');assert.equal(successor.details.answers.additional_stone,undefined);
      assert.equal(successor.public_product_identity_id,before.public_product_identity_id);
      assert.equal(successor.full_sku,null);assert.ok(successor.characteristic_version_id);
      assert.equal(original.status,'corrected');assert.equal(original.corrected_to_product_id,successor.id);
      assert.equal(original.legacy_uah_price_unset,true);assert.deepEqual(original.details,before.details);
      assert.equal(original.weight,before.weight);assert.equal(original.total_price_uah,before.total_price_uah);
      assert.equal((await db.query("SELECT count(*)::int n FROM product_corrections WHERE source_product_id=$1 AND corrected_product_id=$2",[before.id,successor.id])).rows[0].n,1);
    });
    const frozen=await require('../src/services/sku-schema.service').getSchemaVersionById(6,db);
    assert.equal(frozen.config_hash,fixture.data.provenance.frozenHash);assert.deepEqual(frozen.questions.map(q=>q.display_order),fixture.schema().questions.map(q=>q.display_order));
  }finally{if(db)await db.end();if(created)await control.query('DROP DATABASE '+name);await control.end();}
});
