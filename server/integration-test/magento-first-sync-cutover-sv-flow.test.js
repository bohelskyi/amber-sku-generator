// Entire acceptance flow on frozen schema6 and a local in-memory Magento. No live HTTP.
require('../test/setup-env');
const test=require('node:test'),assert=require('node:assert/strict');
const {Client,Pool}=require('pg'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const path=require('node:path'),{randomUUID}=require('node:crypto');
const fixture=require('../test/fixtures/legacy-sv-schema6');
test('SV11500004 canonical cutover flag-only admission reaches guarded2950 delivery and verified first-sync completion',async t=>{
  const source=new URL(process.env.TEST_DATABASE_URL||'');assert.equal(source.hostname,'127.0.0.1');assert.equal(source.port,'55432');assert.ok(source.pathname.endsWith('_test'));
  const name='amber_cutover_sv_flow_'+process.pid+'_test',control=new Client({connectionString:source.toString()});await control.connect();let created=false,db;
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
    // The retained publication copy contains field rows, not their category
    // evidence or a live Magento tree. Complete this isolated transport fixture
    // with explicitly approved local category identities; never claim these IDs
    // or remote observations are production evidence.
    const category=p.bindings.attributes.find(a=>a.routeKey==='SV.souvenir=value_id:5'&&a.rowId==='base'&&a.target==='categories');
    category.evidence={categories:[['Default/Камінь','100'],['Default/Камінь/Камінь сувенірний','101'],['Default/Камінь/Полірований','102']]
      .map(([normalizedPath,categoryId])=>({requestedPath:normalizedPath,normalizedPath,categoryId,
        candidates:[{categoryId,path:normalizedPath}],reviewState:'approved'}))};
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
    const config={baseUrl:'https://schema6.invalid'},gate=require('../src/services/full-product-cutover-gate');
    const c=require('../src/services/magento/binding-contract'),firstSync=require('../src/services/magento/first-sync.service');
    const admission=require('../src/services/magento/first-sync-cutover-admission'),jobs=require('../src/services/magento/sync-job.service');
    const runtimeConfig={...config,configured:true,consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
    const x=fixture.product(2198),details=structuredClone(x.details);
    Object.assign(details.answers,{weight:'132,3',souvenir:5,size:'7.5/7.5/7'});details.manualPriceUah=2950;
    const product=(await require('./product-fixture').insertProductFixture(db,`INSERT INTO products(id,full_sku,base_sku,sequence_number,category,weight,sku_schema_version_id,total_price,total_price_uah,price_per_gram,uah_rate,details,legacy_uah_price_unset,magento_name_subject_ua,magento_name_subject_en)
      VALUES(1488,'SV11500004',$1,$2,'SV',132.300,6,$3,2950,$4,$5,$6::jsonb,FALSE,'Existing Amber UA','Existing Amber EN') RETURNING *`,
    [x.base_sku,x.sequence_number,x.total_price,x.price_per_gram,x.uah_rate,JSON.stringify(details)])).rows[0];
    await db.query(`UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',business_exclusion_state='none',delivery_version=delivery_version+1,
      evidence='{"origin":"migration_039","coverage":"unresolved_historical"}' WHERE product_id=1488`);
    await db.query('INSERT INTO product_export_revisions(product_id,has_product_snapshot) VALUES(1488,TRUE)');
    await db.query('UPDATE export_state SET exported_to_product_id=1488');
    const cutover=require('../src/services/full-product-cutover.service'),maintenance={...options,expectedDatabase:name,deploymentEvidence:'Disposable canonical SV fixture; no older writer'};
    await cutover.prepare(maintenance);const index=await cutover.generate('index',maintenance);
    assert.deepEqual(index.indexing.diagnostics,[]);await cutover.indexHistorical(index,index.contentSha256,maintenance);
    const manifest=await cutover.generate('cutover',maintenance);assert.equal(manifest.entries[0].action,'legacy_baseline');
    assert.equal(manifest.entries[0].classification,'historical_ambiguous');
    await cutover.approve(manifest,manifest.contentSha256,'Explicit fixture legacy baseline acceptance',maintenance);
    await cutover.applyBatch(manifest.contentSha256,0,maintenance);await cutover.activate(manifest.contentSha256,maintenance);
    async function write(operation){const client=await db.connect();try{await gate.begin(client,'BEGIN');const r=await operation(client);await gate.commit(client);return r;}
      catch(e){await gate.rollback(client);throw e;}finally{await gate.release(client);client.release();}}
    const event=(await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('magento_delivery.cutover',$1,'{"displayName":"Fixture","preferredUsername":null}','fixture','csv-disabled',$2) RETURNING id`,[actor,randomUUID()])).rows[0].id;
    await write(async client=>{await client.query("SET LOCAL amber.magento_delivery_cutover='on'");
      await client.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,
        legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton`,[binding.installationKey,actor,event]);});
    await db.query(`INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id,state,reason_code,diagnostics)
      VALUES($1,1488,'needs_attention','data_or_binding','[{"code":"PRODUCT_EVALUATION_NOT_READY","issueFields":["decor_weight"]}]')`,[product.public_product_identity_id]);
    const original=(await db.query('SELECT * FROM products WHERE id=1488')).rows[0];
    const evaluated=require('../src/services/export-templates/evaluate').evaluateProduct(compiled,original);assert.deepEqual(evaluated.errors,[]);
    const custom_attributes=binding.bindings.attributes.filter(a=>a.routeKey==='SV.souvenir=value_id:5'&&a.rowId==='base'
      &&a.strategy!=='transport_control'&&!['sku','name','price'].includes(a.target)).map(a=>{
      const value=evaluated.base[a.target]??'',mapped=binding.bindings.options.find(o=>o.bindingKey===a.bindingKey&&o.evaluatedOutput===value&&o.reviewState==='approved');
      return {attribute_code:a.attributeCode,value:mapped?.optionId??value};});
    let remote={id:3732,sku:'SV11500004',attribute_set_id:151,type_id:'simple',status:1,visibility:4,name:'Existing Magento UA',price:10000,
      created_at:'2026-01-01 00:00:00',updated_at:'2026-01-01 00:00:00',custom_attributes,
      extension_attributes:{website_ids:[1],category_links:[100,101,102].map(category_id=>({category_id:String(category_id),position:0}))}},englishName='Existing Magento EN';
    const traffic=[],writes=[];let allowWrites=false;
    const fetchImpl=async(url,init)=>{const u=new URL(url),method=init?.method||'GET',route=u.pathname.split('/V1/')[1];
      assert.equal(u.hostname,'schema6.invalid');traffic.push({method,route});const response=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
      if(method==='GET'){
        if(route==='products')return response({items:[{...remote,name:u.pathname.includes('/rest/en/')?englishName:remote.name}],total_count:1});
        if(route==='categories')return response({id:2,parent_id:1,name:'Default',children_data:[{id:100,parent_id:2,name:'Камінь',children_data:[
          {id:101,parent_id:100,name:'Камінь сувенірний',children_data:[]},{id:102,parent_id:100,name:'Полірований',children_data:[]}]}]});
        if(route==='store/storeConfigs')return response([{id:1,code:'ua',website_id:1,locale:'uk_UA',base_currency_code:'UAH'},
          {id:3,code:'en',website_id:1,locale:'en_US',base_currency_code:'UAH'}]);
        if(route==='inventory/stock-resolver/website/base')return response({stock_id:1,extension_attributes:{sales_channels:[{type:'website',code:'base'}]}});
        if(route==='inventory/get-sources-assigned-to-stock-ordered-by-priority/1')return response([{source_code:'default',enabled:true}]);
        if(route==='inventory/source-items')return response({items:[{sku:'SV11500004',source_code:'default',quantity:1,status:1}],total_count:1});
        assert.fail('Unexpected local GET '+route);
      }
      assert.equal(allowWrites,true,'Admission/field comparison/keep-local/enqueue must not dispatch');
      assert.equal(method,'POST');assert.equal(route,'products');const body=JSON.parse(init.body).product;
      assert.equal(body.sku,'SV11500004');writes.push(body);
      if(Object.hasOwn(body,'weight'))assert.equal(Number(body.weight),132.3);
      for(const a of body.custom_attributes||[])if(a.attribute_code==='decor_weight')assert.equal(Number(a.value),132.3,
        'Ordinary UPDATE may serialize equal grams but cannot change the populated physical value');
      if(u.pathname.includes('/rest/en/')){if(body.name!==undefined)englishName=body.name;}
      else{const attributes=new Map(remote.custom_attributes.map(a=>[a.attribute_code,a]));for(const a of body.custom_attributes||[])attributes.set(a.attribute_code,a);
        remote={...remote,...body,custom_attributes:[...attributes.values()]};}
      return response(true);
    };
    let lastReport;
    const runtimeOptions={...options,actorUserId:actor,fetchImpl,observeRate:async()=>({rateInfo:{rate:40,rateDate:'2026-10-11',source:'fixture',stale:false}}),
      preview:async(cfg,input)=>{lastReport=await require('../src/services/magento/sync-preview').previewProduct(cfg,{...input,discover:async()=>binding.schema});return lastReport;}};
    const selection={sku:'SV11500004',bindingRevisionId:binding.id};
    const snapshot=async()=>c.hash((await db.query(`SELECT
      (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,(SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) lifecycle,
      (SELECT jsonb_agg(r ORDER BY product_id) FROM product_export_revisions r) priceRevisions,
      (SELECT jsonb_agg(s ORDER BY id) FROM export_snapshots s) snapshots,(SELECT jsonb_agg(m ORDER BY snapshot_id,product_id) FROM export_snapshot_products m) memberships,
      (SELECT jsonb_agg(s ORDER BY id) FROM magento_first_sync_sessions s) sessions,(SELECT jsonb_agg(p ORDER BY session_id,revision) FROM magento_first_sync_progress p) progress,
      (SELECT jsonb_agg(f ORDER BY session_id,revision,target,scope) FROM magento_first_sync_fields f) fields,
      (SELECT jsonb_agg(s ORDER BY origin_hash,public_product_identity_id) FROM magento_name_sync_states s) names,
      (SELECT jsonb_agg(j ORDER BY id) FROM magento_sync_jobs j) jobs,(SELECT jsonb_agg(s ORDER BY job_id,ordinal) FROM magento_sync_steps s) steps,
      (SELECT jsonb_agg(r ORDER BY public_product_identity_id) FROM magento_product_sync_requests r) requests,
      (SELECT jsonb_agg(a ORDER BY id) FROM audit_events a) audits,(SELECT jsonb_agg(r ORDER BY full_sku) FROM sku_registry r) reservations`)).rows[0]);
    const before=await snapshot(),proposal=await firstSync.review(runtimeConfig,selection,runtimeOptions);
    assert.equal(proposal.mode,'review');assert.equal(proposal.historyReview.legacySnapshotFlag,true);assert.equal(await snapshot(),before);
    await assert.rejects(jobs.enqueue(runtimeConfig,selection,runtimeOptions),{code:'MAGENTO_FIRST_SYNC_FIELDS_UNRESOLVED'});
    assert.equal(await snapshot(),before);assert.equal(writes.length,0);
    const admissionCommand={...selection,previewToken:proposal.historyReview.previewToken};
    const accepted=await admission.apply(runtimeConfig,admissionCommand,runtimeOptions);assert.equal(accepted.doesNotAcknowledgeExport,true);
    const admitted=await snapshot();assert.equal((await admission.apply(runtimeConfig,admissionCommand,runtimeOptions)).receipt.alreadyApplied,true);assert.equal(await snapshot(),admitted);
    const compared=await firstSync.review(runtimeConfig,selection,runtimeOptions),weight=compared.fields.find(f=>f.target==='decor_weight');
    assert.equal(compared.mode,'first');assert.equal(weight.local.value,'132.300');assert.equal(weight.status,'equal');assert.equal(weight.canAcceptRemote,false);
    const price=compared.fields.find(f=>f.target==='price');assert.equal(price.local.value,'2950.00');assert.equal(price.remote.value,10000);assert.equal(price.canKeepLocal,true);
    assert.equal(await snapshot(),admitted);assert.equal(writes.length,0);
    const choice={...selection,previewToken:compared.previewToken,target:'price',scope:'all',choice:'keep_local'};
    const kept=await firstSync.apply(runtimeConfig,choice,runtimeOptions);assert.equal(kept.receipt.state,'pending_outward_confirmation');assert.equal(kept.readyForOutbound,true);assert.equal(kept.complete,false);
    assert.equal(writes.length,0);const pending=await snapshot();assert.equal((await firstSync.apply(runtimeConfig,choice,runtimeOptions)).receipt.alreadyApplied,true);assert.equal(await snapshot(),pending);
    const request=(await db.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[product.public_product_identity_id])).rows[0];
    const automaticOptions={...runtimeOptions,automatic:{publicIdentityId:product.public_product_identity_id,productId:1488,
      generation:request.desired_generation,installationKey:binding.installationKey}};
    let queued;try{queued=await jobs.enqueue(runtimeConfig,selection,automaticOptions);}catch(e){e.message+=' '+JSON.stringify(lastReport?.blockers);throw e;}
    assert.equal(queued.state,'queued');assert.equal(writes.length,0);
    const retry=await jobs.enqueue(runtimeConfig,selection,automaticOptions);assert.equal(retry.id,queued.id);
    const worker=require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(runtimeConfig,{databasePool:db,jobOptions:runtimeOptions});
    allowWrites=true;await worker.runProduct(product.public_product_identity_id);
    const delivered=(await db.query('SELECT * FROM magento_sync_jobs WHERE id=$1',[queued.id])).rows[0];
    assert.equal(delivered.state,'succeeded',JSON.stringify(delivered.failure));assert.equal(String(delivered.remote_product_id),'3732');assert.ok(delivered.acknowledged_at);
    assert.ok(writes.some(w=>Number(w.price)===2950));assert.equal(remote.price,2950);
    const steps=(await db.query('SELECT * FROM magento_sync_steps WHERE job_id=$1 ORDER BY ordinal',[queued.id])).rows;
    assert.ok(steps.length>0);assert.ok(steps.every(s=>s.state==='verified'&&s.dispatched_at&&s.verified_at));
    const final=(await db.query('SELECT * FROM products WHERE id=1488')).rows[0];assert.equal(final.weight,'132.300');assert.equal(final.details.answers.weight,'132,3');
    assert.equal(final.total_price_uah,'2950.00');assert.equal(final.full_sku,'SV11500004');assert.equal(final.public_product_identity_id,original.public_product_identity_id);
    assert.equal(final.magento_name_subject_ua,original.magento_name_subject_ua);assert.equal(final.magento_name_subject_en,original.magento_name_subject_en);
    assert.equal(final.magento_name_override.values.all,'Existing Magento UA');assert.equal(final.magento_name_override.values.en,'Existing Magento EN');
    assert.equal((await db.query('SELECT has_product_snapshot FROM product_export_revisions WHERE product_id=1488')).rows[0].has_product_snapshot,true);
    assert.equal((await db.query('SELECT confirmed_revision FROM product_full_export_state WHERE product_id=1488')).rows[0].confirmed_revision,'0');
    const completed=(await db.query('SELECT * FROM magento_first_sync_sessions WHERE public_product_identity_id=$1',[product.public_product_identity_id])).rows[0];assert.ok(completed.completed_at);
    const synced=(await db.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[product.public_product_identity_id])).rows[0];
    assert.equal(synced.state,'synced');assert.equal(synced.synced_generation,synced.desired_generation);
    assert.equal(synced.reason_code,null);assert.deepEqual(synced.diagnostics,[]);assert.equal(synced.active_job_id,null);
    const floor=(await db.query(`SELECT state FROM magento_first_sync_fields WHERE session_id=$1 AND target='price' ORDER BY revision DESC LIMIT 1`,[completed.id])).rows[0];assert.equal(floor.state,'outward_verified');
    const done=await snapshot(),ordinary=await firstSync.review(runtimeConfig,selection,runtimeOptions);assert.equal(ordinary.mode,'ordinary');assert.equal(await snapshot(),done);
    const writeCount=writes.length;await worker.runProduct(product.public_product_identity_id);assert.equal(writes.length,writeCount);assert.equal(await snapshot(),done);
    assert.ok(traffic.some(t=>t.method==='POST'));assert.ok(traffic.filter(t=>t.method==='POST').every(t=>t.route==='products'));
  }finally{if(db)await db.end();if(created)await control.query('DROP DATABASE '+name);await control.end();}
});
