// Native immutable cutover and local completion on a disposable schema6 copy. No live HTTP.
require('../test/setup-env');
const test=require('node:test'),assert=require('node:assert/strict');
const {Client,Pool}=require('pg');
const {randomUUID}=require('node:crypto');
const fixture=require('../test/fixtures/legacy-sv-schema6');
test('attested legacy SV completion preserves both admitted and changed-delivery-history cutover boundaries',async t=>{
  const source=new URL(process.env.TEST_DATABASE_URL||'');assert.equal(source.hostname,'127.0.0.1');assert.equal(source.port,'55432');assert.ok(source.pathname.endsWith('_test'));
  const name='amber_completion_cutover_'+process.pid+'_test',control=new Client({connectionString:source.toString()});await control.connect();let created=false,db;
  try{
    await require('./harness').createTestDatabase(name);created=true;const target=new URL(source);target.pathname='/'+name;

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
    // Exact reversible optional/required size branches from the controlled
    // successor contract; this publication is isolated test evidence only.
    const size=p.definition.bindings.find(b=>b.id==='SV.rozmir_suveniriv');
    size.value={op:'when',if:{op:'eq',left:{op:'semanticKey',input:{op:'source',id:'SV.souvenir'}},right:{op:'literal',value:'6'}},
      then:{op:'text',input:{op:'source',id:'SV.size'},trim:true,format:'scalar-v1',onAbsent:'empty'},else:size.value};
    const requirements=require('../src/services/magento/binding-validation').requirements(p.definition,p.schema);
    p.bindings.options=p.bindings.options.map(option=>{
      if(option.sourceKind==='semantic')return option;
      const attributes=requirements.flatMap(plan=>plan.attributes).filter(a=>a.bindingKey===option.bindingKey);
      assert.equal(attributes.length,1);return {...option,domainKey:attributes[0].domainKey};
    });
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
    const admission=require('../src/services/magento/first-sync-cutover-admission');
    const runtimeConfig={...config,configured:true,consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
    const previews=require('../src/services/magento/sync-preview-db'),completion=require('../src/services/magento/first-sync-legacy-completion');
    const lifecycle=require('../src/services/full-product-export.service');
    const products=[];
    for(const [id,sku,sequence] of [[1359,'SV5111001',1],[1360,'SV5111002',2]]){
      const x=fixture.product(1359),details=structuredClone(x.details);
      const product=(await require('./product-fixture').insertProductFixture(db,`INSERT INTO products
        (id,full_sku,base_sku,sequence_number,category,weight,sku_schema_version_id,total_price,total_price_uah,
        price_per_gram,uah_rate,details,legacy_uah_price_unset,created_at,magento_name_subject_ua,magento_name_subject_en)
        VALUES($1,$2,'SV5111',$3,'SV',46.3,6,$4,$5,$6,$7,$8::jsonb,FALSE,'2000-01-01T00:00:00Z','Тестовий камінь','Test stone') RETURNING *`,
      [id,sku,sequence,x.total_price,x.total_price_uah,x.price_per_gram,x.uah_rate,JSON.stringify(details)])).rows[0];
      const initial=await previews.readPreviewProduct(db,{productId:id,bindingRevisionId:binding.id});
      const generated=require('../src/services/magento/binding-evidence-products').evaluate(initial,initial.product).generatedNames;
      await db.query('UPDATE products SET magento_name_override=$2::jsonb WHERE id=$1',
        [id,JSON.stringify({generated,values:{all:'Accepted UA '+id,en:'Accepted EN '+id}})]);
      await db.query(`UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',business_exclusion_state='none',
        delivery_version=delivery_version+1,evidence='{"origin":"migration_039","coverage":"unresolved_historical"}' WHERE product_id=$1`,[id]);
      await db.query('INSERT INTO product_export_revisions(product_id,has_product_snapshot) VALUES($1,TRUE)',[id]);
      products.push(product);
    }
    await db.query('UPDATE export_state SET exported_to_product_id=1360');
    const cutover=require('../src/services/full-product-cutover.service');
    const maintenance={...options,expectedDatabase:name,deploymentEvidence:'Disposable historical completion fixture; no older writer'};
    await cutover.prepare(maintenance);const index=await cutover.generate('index',maintenance);
    assert.deepEqual(index.indexing.diagnostics,[]);await cutover.indexHistorical(index,index.contentSha256,maintenance);
    const manifest=await cutover.generate('cutover',maintenance);
    assert.deepEqual(manifest.entries.map(entry=>[entry.productId,entry.action,entry.classification]),
      [[1359,'legacy_baseline','historical_ambiguous'],[1360,'legacy_baseline','historical_ambiguous']]);
    await cutover.approve(manifest,manifest.contentSha256,'Explicit fixture legacy inventory baseline',maintenance);
    await cutover.applyBatch(manifest.contentSha256,0,maintenance);await cutover.activate(manifest.contentSha256,maintenance);
    async function write(operation){const client=await db.connect();try{await gate.begin(client,'BEGIN');
      const result=await operation(client);await gate.commit(client);return result;
    }catch(error){await gate.rollback(client);throw error;}finally{await gate.release(client);client.release();}}
    const event=(await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('magento_delivery.cutover',$1,'{"displayName":"Fixture","preferredUsername":null}','fixture','csv-disabled',$2) RETURNING id`,
    [actor,randomUUID()])).rows[0].id;
    await write(async client=>{await client.query("SET LOCAL amber.magento_delivery_cutover='on'");
      await client.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,
        legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton`,
      [binding.installationKey,actor,event]);});
    for(const product of products)await db.query(`INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id,state,reason_code,diagnostics)
      VALUES($1,$2,'needs_attention','data_or_binding','[{"code":"PRODUCT_EVALUATION_NOT_READY"}]')`,[product.public_product_identity_id,product.id]);
    const reads=[],fetchImpl=async(url,init)=>{
      const method=init?.method || 'GET';reads.push(method);assert.equal(method,'GET','Completion cannot mutate Magento');
      assert.ok(new URL(url).pathname.endsWith('/store/storeConfigs'));
      return new Response(JSON.stringify([{id:1,code:'ua',website_id:1,locale:'uk_UA',base_currency_code:'UAH'},
        {id:3,code:'en',website_id:1,locale:'en_US',base_currency_code:'UAH'}]),{headers:{'content-type':'application/json'}});
    };
    const observe=async product=>{
      const amber=await previews.readPreviewProduct(db,{productId:product.id,bindingRevisionId:binding.id});
      const raw={id:900000+product.id,sku:amber.product.public_sku,attribute_set_id:151,name:'Remote UA',price:'88000',
        custom_attributes:[{attribute_code:'rozmir_suveniriv',value:'9.5/3.5'},{attribute_code:'kamin_obrobka',value:''},
          {attribute_code:'decor_weight',value:'46.3'}]};
      return {amber,raw,schema:binding.schema,domainEvidence:{english:{id:raw.id,sku:raw.sku,fields:{name:'Remote EN'}},failures:[]}};
    };
    const runtimeFor=product=>({...options,actorUserId:actor,fetchImpl,
      observeRate:async()=>({rateInfo:{rate:40,rateDate:'2026-10-11',source:'fixture',stale:false}}),
      preview:async(_config,input)=>{input.onObservation(await observe(product));return {};}});
    const inputFor=product=>({sku:product.full_sku,bindingRevisionId:binding.id,processingValueId:'1',
      attestation:'processing_not_encoded_in_historical_sku',reason:'Administrator verified polished processing without historical SKU encoding'});
    const actual=async product=>(await db.query('SELECT * FROM products WHERE id=$1',[product.id])).rows[0];
    const full=async product=>(await db.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[product.id])).rows[0];
    const snapshot=async()=>{
      const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
      const data={};
      for(const {tablename} of tables){assert.match(tablename,/^[a-z][a-z0-9_]*$/);
        data[tablename]=(await db.query('SELECT to_jsonb(row) value FROM "'+tablename+'" row')).rows.map(row=>row.value)
          .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));}
      data.sequences=(await db.query('SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename',['public'])).rows;
      return c.hash(data);
    };
    const immutable=async product=>{
      const row=await full(product);
      return {cutover_baseline_revision:row.cutover_baseline_revision,cutover_baseline_event_id:row.cutover_baseline_event_id,
        confirmed_revision:row.confirmed_revision,externally_delivered_revision:row.externally_delivered_revision,
        externally_delivered_event_id:row.externally_delivered_event_id,repair_manifest_hash:row.repair_manifest_hash,
        delivery_version:row.delivery_version,evidence:row.evidence,
        audits:(await db.query(`SELECT * FROM audit_events WHERE event_key IN
          ('full_product_cutover.approved','full_product_cutover.batch_applied','product.full_export_baselined') ORDER BY id`)).rows};
    };
    const noJobs=async()=>assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n,0);

    await t.test('valid admitted cutover root survives local completion with new review-required post-state progress',async()=>{
      const product=products[0],runtime=runtimeFor(product),selection={sku:product.full_sku,bindingRevisionId:binding.id};
      const unchanged=await snapshot(),proposal=await firstSync.review(runtimeConfig,selection,runtime);
      assert.equal(proposal.mode,'review');assert.ok(proposal.historyReview);
      assert.equal(await snapshot(),unchanged,'Native admission preview preserves all tables and sequences');
      const admitted=await admission.apply(runtimeConfig,{...selection,previewToken:proposal.historyReview.previewToken},runtime);
      const root=admitted.receipt.auditEventId;
      const rootBefore=(await db.query('SELECT * FROM audit_events WHERE id=$1',[root])).rows[0];
      const initial=await firstSync.review(runtimeConfig,selection,runtime);assert.equal(initial.mode,'first');
      // Establish an existing incomplete review session through the native
      // ledger, retaining one genuinely equal physical-weight observation.
      // No import/decision is recorded; both missing inputs remain absent.
      const inspection=await firstSync.inspect(runtimeConfig,await observe(product),runtime);
      const reviewed=require('../src/services/magento/first-sync-progress-plan').prepareProgress(inspection.projection,null);
      const equalWeight=reviewed.rows.find(row=>row.record.target==='decor_weight');
      assert.equal(equalWeight.record.state,'equal');assert.equal(equalWeight.record.before.value,'46.300');
      assert.equal(equalWeight.record.remote.value,'46.3');
      await write(async client=>{await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[product.id]);
        await require('../src/services/magento/first-sync-ledger').recordProgressOnClient(client,{
          key:inspection.first.key,
          identity:{installationKey:binding.installationKey,publicSku:product.full_sku,remoteProductId:String(900000+product.id),
            contractVersion:'first-sync-v1',initialProductId:product.id,initialBindingRevisionId:binding.id},
          expectedRevision:'0',previewHash:c.hash({fixture:'initial-incomplete-review',productId:product.id}),
          fields:reviewed.rows.map(row=>({...row.record,...(row===equalWeight?{}:{state:'review_required',after:row.local.value ?? null}),
            source:{...row.record.source,productId:product.id}})),requiredScopes:reviewed.manifest,
          actorUserId:actor,complete:false,readyForOutbound:false,historyAdmissionEventId:root,
          captureAdmissionState:tx=>admission.captureState(tx,product.id),
        });});
      const progressBefore=(await db.query('SELECT * FROM magento_first_sync_progress ORDER BY revision')).rows;
      assert.equal(progressBefore.length,1);
      const originalFields=(await db.query('SELECT * FROM magento_first_sync_fields WHERE revision=1 ORDER BY target,scope')).rows;
      const original=await actual(product),baseline=await immutable(product),state=await full(product);
      assert.equal(original.details.answers.size,undefined);assert.equal(original.details.answers.stone_processing,undefined);
      const input=inputFor(product),before=await snapshot(),review=await completion.review(runtimeConfig,input,runtime);
      assert.equal(review.historyMode,'first');assert.equal(await snapshot(),before,'Completion preview is fully read-only');
      const command={...input,previewToken:review.previewToken},result=await completion.apply(runtimeConfig,command,runtime);
      assert.equal(result.historyMode,'first');assert.ok(result.progress);assert.equal(result.readyForOutbound,false);
      assert.equal(result.remoteWrites,0);assert.equal(result.syncJobEnqueued,false);
      const after=await actual(product),post=await full(product);
      assert.deepEqual(after.details,{...original.details,answers:{...original.details.answers,stone_processing:'1',size:'9.5/3.5'}});
      for(const key of ['full_sku','base_sku','sequence_number','public_product_identity_id','sku_schema_version_id','weight','total_price_uah'])assert.equal(after[key],original[key]);
      assert.deepEqual(after.magento_name_override.values,original.magento_name_override.values);
      assert.equal(post.revision,String(BigInt(state.revision)+1n));assert.equal(post.csv_retired_revision,post.revision);
      assert.deepEqual(await immutable(product),baseline);
      assert.deepEqual((await db.query('SELECT * FROM audit_events WHERE id=$1',[root])).rows[0],rootBefore);
      const progress=(await db.query('SELECT * FROM magento_first_sync_progress ORDER BY revision')).rows;
      assert.equal(progress.length,2);assert.deepEqual(progress[0],progressBefore[0]);
      assert.equal(progress[1].session_id,progress[0].session_id);assert.equal(progress[1].command.historyAdmissionEventId,root);
      assert.deepEqual(progress[1].result.historyAdmissionState,{revision:post.revision,csvRetiredRevision:post.csv_retired_revision});
      assert.deepEqual((await db.query('SELECT * FROM magento_first_sync_fields WHERE revision=1 ORDER BY target,scope')).rows,originalFields);
      const fields=(await db.query('SELECT * FROM magento_first_sync_fields')).rows;
      assert.ok(fields.length>0);assert.ok(fields.filter(field=>field.target!=='decor_weight').every(field=>field.state==='review_required'));
      const weightRows=fields.filter(field=>field.target==='decor_weight');assert.equal(weightRows.length,1);
      assert.equal(weightRows[0].state,'equal');assert.deepEqual(weightRows[0],originalFields.find(field=>field.target==='decor_weight'));
      const retained=await require('../src/services/magento/first-sync-ledger').readOnClient(db,
        {originHash:binding.originHash,publicIdentityId:String(product.public_product_identity_id)});
      const weight=retained.fields.find(field=>field.target==='decor_weight');assert.equal(weight.state,'equal');assert.equal(weight.revision,'1');
      const processing=fields.find(field=>field.target==='kamin_obrobka'&&field.revision==='2');assert.equal(processing.evidence.before.value,'1');
      const fresh=await firstSync.review(runtimeConfig,selection,runtime);assert.equal(fresh.mode,'first');
      await noJobs();const committed=await snapshot();
      const replay=await completion.apply(runtimeConfig,command,{...runtime,preview:()=>assert.fail('Replay cannot reread remote fields')});
      assert.equal(replay.alreadyApplied,true);assert.equal(await snapshot(),committed);
    });

    await t.test('real retired-CSV mutation keeps admission available; local-only completion creates no admission or session',async()=>{
      const product=products[1],runtime=runtimeFor(product),selection={sku:product.full_sku,bindingRevisionId:binding.id};
      await write(async client=>{await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[product.id]);
        const state=(await lifecycle.readFullProductStates(client,[product.id],{lock:true}))[0];
        await lifecycle.advanceFullProductRevision(client,product.id,state.revision);});
      const diagnosis=await firstSync.review(runtimeConfig,selection,runtime);
      assert.equal(diagnosis.mode,'review');assert.equal(diagnosis.historyReviewAssessment.status,'available');
      const baseline=await immutable(product),original=await actual(product),state=await full(product),input=inputFor(product);
      const before=await snapshot(),review=await completion.review(runtimeConfig,input,runtime);
      assert.equal(review.historyMode,'review');assert.equal(await snapshot(),before);
      const result=await completion.apply(runtimeConfig,{...input,previewToken:review.previewToken},runtime);
      assert.equal(result.historyMode,'review');assert.equal(result.progress,null);assert.equal(result.readyForOutbound,false);
      assert.equal(result.remoteWrites,0);assert.equal(result.syncJobEnqueued,false);
      const after=await actual(product),post=await full(product);
      assert.deepEqual(after.details,{...original.details,answers:{...original.details.answers,stone_processing:'1',size:'9.5/3.5'}});
      assert.equal(post.revision,String(BigInt(state.revision)+1n));assert.equal(post.csv_retired_revision,post.revision);
      assert.deepEqual(await immutable(product),baseline);
      const fresh=await firstSync.review(runtimeConfig,selection,runtime);
      assert.equal(fresh.mode,'review');assert.equal(fresh.historyReviewAssessment.status,'available');
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_first_sync_sessions WHERE public_product_identity_id=$1',[product.public_product_identity_id])).rows[0].n,0);
      assert.equal((await db.query(`SELECT count(*)::int n FROM audit_events WHERE event_key='product.magento_first_sync_cutover_reviewed'
        AND details->'admission'->'identity'->>'publicIdentityId'=$1`,[String(product.public_product_identity_id)])).rows[0].n,0);
      await noJobs();
    });
    assert.ok(reads.length>0);assert.ok(reads.every(method=>method==='GET'));
  }finally{if(db)await db.end();if(created)await control.query('DROP DATABASE '+name);await control.end();}
});
