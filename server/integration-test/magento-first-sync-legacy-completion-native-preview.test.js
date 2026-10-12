'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createRequire}=require('node:module'),{randomUUID}=require('node:crypto');
const SERVER=require('node:path').resolve(__dirname,'..'),app=createRequire(SERVER+'/package.json');
app('./test/setup-env');
if(!process.env.TEST_DATABASE_URL||!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test'))throw Error('Disposable *_test database required');
const harness=app('./integration-test/harness'),{Pool,recreateTestDatabase,dropTestDatabase,runNodeInDatabase}=harness;
const SKUS=Object.freeze(['SV5011001','SV5111001']),fixture=app('./test/fixtures/legacy-sv-schema6');
const name='amber_legacy_completion_native_preview_test';
async function setup(){const url=await recreateTestDatabase(name),db=new Pool({connectionString:url});try{
 await runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});");
 const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','SV2 synthetic Administrator') RETURNING id")).rows[0].id);
 await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
 for(const category of ['NM','KL','CH','AR','BR'])await db.query('INSERT INTO categories(code,name) VALUES($1,$1)',[category]);
 const f=fixture.data;
 await db.query('INSERT INTO categories(code,name,requires_weight,skip_hidden_sku_questions,marketing_rounding_enabled) VALUES($1,$2,$3,$4,$5)',[f.category.code,f.category.name,f.category.requires_weight,f.category.skip_hidden_sku_questions,f.category.marketing_rounding_enabled]);
 for(const q of f.currentQuestions)await db.query(`INSERT INTO questions(id,category_code,key,label,input_type,required,include_in_sku,sku_index,display_order,sku_separator,visible_if_json,archived,numeric_validation)
 VALUES($1,'SV',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb)`,[q.id,q.key,q.label,q.input_type,q.required,q.include_in_sku,q.sku_index,q.display_order,q.sku_separator,q.visible_if_json===null?null:JSON.stringify(q.visible_if_json),q.archived,q.numeric_validation===null?null:JSON.stringify(q.numeric_validation)]);
 for(const o of f.currentOptions)await db.query(`INSERT INTO options(id,question_id,value_id,sku_code,label,label_en,visible_if_json,hidden_if_json,archived) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,[o.id,o.question_id,o.value_id,o.sku_code,o.label,o.label_en,JSON.stringify(o.visible_if_json),JSON.stringify(o.hidden_if_json),o.archived]);
 await db.query("INSERT INTO sku_schema_versions(id,category_code,version,marker,status,config_hash) VALUES(6,'SV',1,'','active',$1)",[f.schema.config_hash]);
 for(const q of f.questions)await db.query('INSERT INTO sku_schema_questions(id,schema_version_id,question_key,label,sku_index,display_order,required,sku_separator,visible_if_json) VALUES($1,6,$2,$3,$4,$5,$6,$7,$8::jsonb)',[q.id,q.question_key,q.label,q.sku_index,q.display_order,q.required,q.sku_separator,JSON.stringify(q.visible_if_json)]);
 for(const o of f.options)await db.query('INSERT INTO sku_schema_options(id,schema_question_id,value_id,sku_code,label,visible_if_json,hidden_if_json,archived) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',[o.id,o.schema_question_id,o.value_id,o.sku_code,o.label,JSON.stringify(o.visible_if_json),JSON.stringify(o.hidden_if_json),o.archived]);
 const p=fixture.publication(),definition=structuredClone(p.definition),size=definition.bindings.find(b=>b.id==='SV.rozmir_suveniriv');
 size.value={op:'when',if:{op:'eq',left:{op:'semanticKey',input:{op:'source',id:'SV.souvenir'}},right:{op:'literal',value:'6'}},then:{op:'text',input:{op:'source',id:'SV.size'},trim:true,format:'scalar-v1',onAbsent:'empty'},else:size.value};
 const compiled=app('./src/services/export-templates/definition').compileDefinition(definition),requirements=app('./src/services/magento/binding-validation').requirements(compiled.definition,p.schema);
 const approved={...p.bindings,options:p.bindings.options.map(o=>o.sourceKind==='semantic'?o:{...o,domainKey:requirements.flatMap(r=>r.attributes).find(a=>a.bindingKey===o.bindingKey).domainKey})};
 const options={databasePool:db,mutationContext:{actorUserId:actor}},templates=app('./src/services/export-templates/template.service'),bindings=app('./src/services/magento/binding.service');
 const family=await templates.createTemplate({key:'sv2-helper-fixture',displayName:'SV2 controlled fixture',definition:compiled.definition},options),version=randomUUID();
 await db.query(`INSERT INTO export_template_versions(id,template_id,version_number,source_draft_revision,definition,definition_hash,format_version,evaluator_version,output_contract,published_by_user_id) VALUES($1,$2,2,1,$3::jsonb,$4,$5,$6,$7,$8)`,[version,family.id,JSON.stringify(compiled.definition),compiled.hash,compiled.definition.formatVersion,compiled.definition.evaluatorVersion,compiled.definition.outputContract,actor]);
 let binding=await bindings.createDraft({installationKey:'sv2-helper-fixture',origin:'https://schema6.invalid',templateVersionId:version,observedAt:'2026-10-12T00:00:00Z',schema:p.schema},options);
 binding=await bindings.updateDraft(binding.id,{expectedRevision:binding.revision,bindings:approved},options);
 await db.query("UPDATE magento_binding_revisions SET state='published',revision=revision+1,version_number=2,published_by_user_id=$2,published_at=CURRENT_TIMESTAMP WHERE id=$1",[binding.id,actor]);
 await db.query("UPDATE magento_auto_sync_activation SET installation_key='sv2-helper-fixture' WHERE singleton");
 for(let n=0;n<2;n++){const x=fixture.product(1359);x.id+=n*10000;x.full_sku=SKUS[n];x.base_sku=n===0?'SV5011':'SV5111';
  await app('./integration-test/product-fixture').insertProductFixture(db,`INSERT INTO products(id,full_sku,base_sku,sequence_number,category,weight,sku_schema_version_id,total_price,total_price_uah,price_per_gram,uah_rate,details,legacy_uah_price_unset,created_at,magento_name_subject_ua,magento_name_subject_en)
   VALUES($1,$2,$3,$4,'SV',$5,6,$6,$7,$8,$9,$10::jsonb,$11,'2000-01-01T00:00:00Z','Тестовий сувенір','Test souvenir') RETURNING *`,[x.id,x.full_sku,x.base_sku,x.sequence_number,x.weight,x.total_price,x.total_price_uah,x.price_per_gram,x.uah_rate,JSON.stringify(x.details),x.legacy_uah_price_unset]);
  await db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1",[x.id]);}
 return {url,db,actor,bindingId:binding.id,schema:p.schema};
 }catch(e){await db.end();throw e;}}
async function fingerprint(db){const out={};
 for(const {tablename}of(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){assert.match(tablename,/^[a-z_]+$/);out[tablename]=(await db.query(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) rows FROM (SELECT to_jsonb(t) j FROM public."${tablename}" t) entries`)).rows[0].rows;}
 for(const {sequencename}of(await db.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows){assert.match(sequencename,/^[a-z_]+$/);out[sequencename]=(await db.query(`SELECT last_value,is_called FROM public."${sequencename}"`)).rows[0];}return out;}
function fakeFetch(schema){return async(url,init)=>{if(init.method!=='GET'||init.redirect!=='manual'||init.body!==undefined)throw Error('Forbidden fixture transport');
 const u=new URL(url),route=u.pathname.split('/V1/')[1];let value;
 if(route==='store/websites')value=schema.storeTopology.websites;
 else if(route==='store/storeGroups')value=schema.storeTopology.storeGroups;
 else if(route==='store/storeViews')value=schema.storeTopology.storeViews;
 else if(route==='store/storeConfigs')value=schema.storeTopology.storeViews.map(s=>({id:s.id,code:s.code,website_id:s.website_id,locale:s.code==='en'?'en_US':'uk_UA',base_currency_code:'UAH'}));
 else if(route==='products/attribute-sets/sets/list'){const page=Number(u.searchParams.get('searchCriteria[currentPage]')||1);value={total_count:schema.attributeSets.length,items:schema.attributeSets.slice((page-1)*100,page*100)};}
 else if(/^products\/attribute-sets\/\d+\/attributes$/.test(route)){const set=schema.attributeSets.find(s=>s.attribute_set_id===Number(route.split('/')[2]));value=schema.attributes.filter(a=>set.attributeCodes.includes(a.attribute_code));}
 else if(route==='products/attributes'){const page=Number(u.searchParams.get('searchCriteria[currentPage]')||1);value={total_count:schema.attributes.length,items:schema.attributes.slice((page-1)*100,page*100)};}
 else if(/^products\/attributes\/[^/]+\/options$/.test(route))value=schema.attributes.find(a=>a.attribute_code===route.split('/')[2]).options;
 else if(route==='products'){const sku=u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');value={total_count:1,items:[{id:1488,sku,attribute_set_id:151,name:u.pathname.includes('/en/')?'Fixture EN':'Fixture UA',price:2500,custom_attributes:[{attribute_code:'rozmir_suveniriv',value:'9.5/3.5'},{attribute_code:'kamin_obrobka',value:sku==='SV5011001'?'6039':''}],extension_attributes:{website_ids:[1]}}]};}
 else if(route==='categories')value={id:Number(u.searchParams.get('rootCategoryId')),parent_id:1,name:'Fixture root',children_data:[]};
 else if(route==='inventory/stock-resolver/website/base')value={stock_id:1,extension_attributes:{sales_channels:[{type:'website',code:'base'}]}};
 else if(route==='inventory/get-sources-assigned-to-stock-ordered-by-priority/1')value=[{source_code:'default',enabled:true}];
 else if(route==='inventory/source-items')value={items:[],total_count:0};
 else throw Error('Unknown fixture GET '+route);
 return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});};}

test('legacy completion uses actual native observations with category diagnostics for review and atomic post-apply projection',async t=>{let f;try{
 f=await setup();const config={configured:true,baseUrl:'https://schema6.invalid',consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
 const completion=app('./src/services/magento/first-sync-legacy-completion'),editor=app('./src/services/magento/integration-editor.service');
 const reads=[],transport=fakeFetch(f.schema),runtime={databasePool:f.db,actorUserId:f.actor,mutationContext:{actorUserId:f.actor},logger:{error:()=>{}},
  fetchImpl:async(url,init)=>{reads.push({url,method:init.method});return transport(url,init);}};
 const input=sku=>({sku,bindingRevisionId:f.bindingId,processingValueId:'1',attestation:'processing_not_encoded_in_historical_sku',reason:'Administrator confirms polished processing outside historical article; native fixture only'});
 // Existing received names remain authority when inputs change. This synthetic
 // override matches the real generated baseline rather than inventing one.
 for(const sku of SKUS){const amber=await app('./src/services/magento/sync-preview-db').readPreviewProduct(f.db,{sku,bindingRevisionId:f.bindingId});
  const generated=app('./src/services/magento/binding-evidence-products').evaluate(amber,amber.product).generatedNames;
  await f.db.query('UPDATE products SET magento_name_override=$2::jsonb WHERE id=$1',[amber.product.id,JSON.stringify({generated,values:{all:'Accepted fixture UA',en:'Accepted fixture EN'}})]);}
 await t.test('real previewProduct category metadata is retained; fresh editor binding and both readonly native reviews preserve every table and sequence',async()=>{
  const before=await fingerprint(f.db),overview=await editor.overview(config,{}, {databasePool:f.db});assert.equal(overview.currentPublishedId,f.bindingId);
  const observation=(await app('./src/services/magento/sync-job.service').recoveryBoundary.observe(config,{sku:SKUS[0],bindingRevisionId:f.bindingId},runtime)).observation;
  assert.ok(Object.hasOwn(observation,'categoryNodes'));assert.ok(Object.hasOwn(observation,'categoryFailures'));
  for(const sku of SKUS){const review=await completion.review(config,input(sku),runtime);assert.equal(review.sku,sku);assert.equal(review.proofKind,'administrator_attested_historical_characteristic');
   assert.equal(review.processing.remoteOptionId,'6039');assert.equal(review.remoteWrites,0);assert.equal(review.syncJobEnqueued,false);assert.equal(review.readyForOutbound,false);}
  assert.deepEqual(await fingerprint(f.db),before);assert.ok(reads.length>0);assert.ok(reads.every(r=>r.method==='GET'));
 });
 await t.test('actual native apply projects its fresh poststate atomically without receiving manual facts or changing protected data, then replays without GET',async()=>{
  const sku=SKUS[1],review=await completion.review(config,input(sku),runtime),command={...input(sku),previewToken:review.previewToken};
  const before=(await f.db.query('SELECT * FROM products WHERE full_sku=$1',[sku])).rows[0];
  const fullBefore=(await f.db.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[before.id])).rows[0];
  const applied=await completion.apply(config,command,runtime);assert.equal(applied.alreadyApplied,false);assert.equal(applied.readyForOutbound,false);assert.equal(applied.remoteWrites,0);assert.equal(applied.syncJobEnqueued,false);
  const after=(await f.db.query('SELECT * FROM products WHERE id=$1',[before.id])).rows[0];
  for(const key of ['full_sku','base_sku','sequence_number','public_product_identity_id','sku_schema_version_id','weight','total_price_uah','price_per_gram','uah_rate'])assert.deepEqual(after[key],before[key],key);
  assert.deepEqual(after.details,{...before.details,answers:{...before.details.answers,size:'9.5/3.5',stone_processing:'1'}});assert.deepEqual(after.magento_name_override.values,before.magento_name_override.values);
  const fullAfter=(await f.db.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[before.id])).rows[0];
  for(const key of ['confirmed_revision','cutover_baseline_revision','csv_retired_revision','externally_delivered_revision'])assert.equal(fullAfter[key],fullBefore[key],key);
  const fields=(await f.db.query('SELECT f.state FROM magento_first_sync_fields f JOIN magento_first_sync_sessions s ON s.id=f.session_id WHERE s.public_product_identity_id=$1',[before.public_product_identity_id])).rows;
  assert.ok(fields.length>0);assert.ok(fields.every(f=>f.state==='review_required'));assert.equal((await f.db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n,0);
  const committed=await fingerprint(f.db),readCount=reads.length,replay=await completion.apply(config,command,runtime);
  assert.equal(replay.alreadyApplied,true);assert.equal(reads.length,readCount);assert.deepEqual(await fingerprint(f.db),committed);
 });
 }finally{if(f)await f.db.end();await dropTestDatabase(name);await harness.pool.end();}});
