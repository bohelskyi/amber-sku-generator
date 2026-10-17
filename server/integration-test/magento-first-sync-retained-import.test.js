// Real frozen/catalog/publication shapes in the canonical disposable PG only.
// Opaque legacy SKU rule: retained values are imported missing-only after first sync.
require('../test/setup-env');
const test=require('node:test'),assert=require('node:assert/strict');
const {Client,Pool}=require('pg'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const path=require('node:path'),{randomUUID}=require('node:crypto');
const fixture=require('../test/fixtures/legacy-sv-schema6');
test('082 closes legacy SV remote retention; retained values and legacy material/colour import missing-only',async t=>{
  const source=new URL(process.env.TEST_DATABASE_URL||'');assert.equal(source.hostname,'127.0.0.1');assert.equal(source.port,'55432');assert.ok(source.pathname.endsWith('_test'));
  const name='amber_retained_'+process.pid+'_test',control=new Client({connectionString:source.toString()});await control.connect();let created=false,db;
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
    const p=fixture.publication();p.definition=require('../scripts/sv-optional-characteristics').patchDefinition(p.definition);const templates=require('../src/services/export-templates/template.service'),bindings=require('../src/services/magento/binding.service');
    const baseOptions={databasePool:db,mutationContext:{actorUserId:actor}};
    const family=await templates.createTemplate({key:'retain-'+randomUUID(),displayName:'Schema6 optional characteristics copy',definition:p.definition},baseOptions);
    // Restore the already published fixture, rather than republish its unrelated
    // category sources against an intentionally SV-only test catalog.
    const compiled=require('../src/services/export-templates/definition').compileDefinition(p.definition);
    const version={id:randomUUID()};
    await db.query(`INSERT INTO export_template_versions(id,template_id,version_number,source_draft_revision,definition,definition_hash,format_version,evaluator_version,output_contract,published_by_user_id)
      VALUES($1,$2,2,1,$3::jsonb,$4,$5,$6,$7,$8)`,[version.id,family.id,JSON.stringify(compiled.definition),compiled.hash,compiled.definition.formatVersion,compiled.definition.evaluatorVersion,compiled.definition.outputContract,actor]);
    let binding=await bindings.createDraft({installationKey:'schema6-fixture',origin:'https://schema6.invalid',templateVersionId:version.id,observedAt:'2026-10-09T07:10:37Z',schema:p.schema},baseOptions);
    // The optional-characteristics patch changes evaluated domain keys; carry the
    // reviewed option decisions forward by binding key, as the successor does.
    const expectedAttributes=require('../src/services/magento/binding-validation').requirements(compiled.definition,p.schema).flatMap(route=>route.attributes);
    for(const option of p.bindings.options.filter(o=>o.sourceKind==='evaluated')){
      const attribute=expectedAttributes.find(a=>a.bindingKey===option.bindingKey);
      if(attribute?.domainKey)option.domainKey=attribute.domainKey;
    }
    binding=await bindings.updateDraft(binding.id,{expectedRevision:binding.revision,bindings:p.bindings},baseOptions);
    await db.query("UPDATE magento_binding_revisions SET state='published',revision=revision+1,version_number=2,published_by_user_id=$2,published_at=CURRENT_TIMESTAMP WHERE id=$1",[binding.id,actor]);
    binding=await bindings.getRevision(binding.id,baseOptions);

    const config={baseUrl:'https://schema6.invalid',configured:true,consumerKey:'fixture-key',consumerSecret:'fixture-secret',accessToken:'fixture-token',accessTokenSecret:'fixture-token-secret'};
    const previews=require('../src/services/magento/sync-preview-db'),gate=require('../src/services/full-product-cutover-gate');
    const firstSync=require('../src/services/magento/first-sync.service');
    const actual=async id=>(await db.query('SELECT * FROM products WHERE id=$1',[id])).rows[0];
    const rateObservation={rateInfo:{rate:40,rateDate:new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Kyiv'}),
      fetchedAt:new Date().toISOString(),source:'fixture',stale:false,ageMs:0,error:null},rateError:null};
    const storeConfigs=async(url,init)=>{assert.equal(init?.method||'GET','GET');assert.ok(new URL(url).pathname.endsWith('/store/storeConfigs'));
      return new Response(JSON.stringify([{id:1,code:'ua',website_id:1,locale:'uk_UA',base_currency_code:'UAH'},
        {id:3,code:'en',website_id:1,locale:'en_US',base_currency_code:'UAH'}]),{status:200,headers:{'content-type':'application/json'}});};
    const canonical=async()=> (await db.query(`SELECT (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,
      (SELECT jsonb_agg(r ORDER BY public_product_identity_id) FROM magento_product_sync_requests r) requests,
      (SELECT jsonb_agg(j ORDER BY id) FROM magento_sync_jobs j) jobs`)).rows[0];
    // Controlled copy of a legacy statuette whose historical SKU encodes no
    // material/colour; Magento holds both values. Not a live observation.
    const fixtureProduct=fixture.product(783);
    const x=(await require('./product-fixture').insertProductFixture(db,`INSERT INTO products(id,full_sku,base_sku,sequence_number,category,weight,sku_schema_version_id,total_price,total_price_uah,price_per_gram,uah_rate,details,legacy_uah_price_unset,magento_name_subject_ua,magento_name_subject_en)
      VALUES($1,$2,$3,$4,'SV',205.1,6,$5,$6,$7,$8,$9::jsonb,FALSE,'Дерево з бурштину','Amber tree') RETURNING *`,
    [fixtureProduct.id,fixtureProduct.full_sku,fixtureProduct.base_sku,fixtureProduct.sequence_number,fixtureProduct.total_price,
      fixtureProduct.total_price_uah,fixtureProduct.price_per_gram,fixtureProduct.uah_rate,JSON.stringify({...fixtureProduct.details,answers:{...fixtureProduct.details.answers,size:'7.5/7.5/7'}})])).rows[0];
    await db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1",[x.id]);
    const evaluated=require('../src/services/export-templates/evaluate').evaluateProduct(compiled,(await previews.readPreviewProduct(db,{productId:x.id,bindingRevisionId:binding.id})).product);
    assert.deepEqual(evaluated.errors,[]);assert.equal(evaluated.base.kolir,'');assert.equal(evaluated.base.typy_obrobky_burshtynu,'');
    const remoteOption=target=>{const attribute=binding.bindings.attributes.find(a=>a.target===target&&a.rowId==='base'&&a.routeKey==='SV.souvenir!=value_id:5');
      return binding.bindings.options.find(o=>o.bindingKey===attribute.bindingKey&&o.reviewState==='approved'&&o.sourceKind==='semantic').optionId;};
    const remoteValues={kolir:remoteOption('kolir'),typy_obrobky_burshtynu:remoteOption('typy_obrobky_burshtynu')};
    async function observation(){
      const amber=await previews.readPreviewProduct(db,{productId:x.id,bindingRevisionId:binding.id});
      const out=require('../src/services/export-templates/evaluate').evaluateProduct(compiled,amber.product);
      const route=require('../src/services/magento/first-sync-route').productRoutePlans(
        require('../src/services/magento/binding-validation').requirements(compiled.definition,binding.schema),amber.product)[0];
      const custom_attributes=binding.bindings.attributes.filter(a=>a.routeKey===route.routeKey&&a.rowId==='base'
        &&a.strategy!=='transport_control'&&!['sku','name','price'].includes(a.target)).map(a=>{
        if(remoteValues[a.target])return {attribute_code:a.attributeCode,value:remoteValues[a.target]};
        const output=out.base[a.target]??'';
        const mapped=binding.bindings.options.find(o=>o.bindingKey===a.bindingKey&&o.evaluatedOutput===output&&o.reviewState==='approved');
        return {attribute_code:a.attributeCode,value:mapped?.optionId??output};
      });
      const raw={id:10000+x.id,sku:amber.product.public_sku,attribute_set_id:151,name:out.base.name,price:String(x.total_price_uah),custom_attributes};
      return {amber,raw,schema:binding.schema,domainEvidence:{english:{id:raw.id,sku:raw.sku,fields:{name:out.english.name}},failures:[]}};
    }
    const options={...baseOptions,actorUserId:actor,observeRate:async()=>rateObservation,fetchImpl:storeConfigs,
      preview:async(_config,input)=>{input.onObservation(await observation());return {};}};
    const selection={sku:x.full_sku,bindingRevisionId:binding.id};

    const ledgerCounts=async()=>(await db.query(`SELECT (SELECT count(*)::int FROM magento_first_sync_fields) fields,
      (SELECT count(*)::int FROM magento_first_sync_progress) progress`)).rows[0];
    const answers=async()=>(await actual(x.id)).details.answers;

    await t.test('082 closes the legacy state for new rows; 080/081 history and repeated startup keep checksums',async()=>{
      const runner=require('../src/db/run-migrations'),fs=require('node:fs/promises');
      for(const file of ['080_first_sync_remote_retained.sql','081_first_sync_magento_managed_seo.sql','082_first_sync_remote_retention_closed.sql']){
        const sql=await fs.readFile(path.resolve(__dirname,'../migrations',file),'utf8');
        assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE name=$1',[file])).rows[0].checksum,runner.getMigrationChecksum(sql));
      }
      const before=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
      await promisify(execFile)(process.execPath,['-e',"require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});"],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DATABASE_URL:target.toString()}});
      assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,before);
      assert.match((await db.query("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='magento_first_sync_fields_state_check'")).rows[0].def,/remote_retained/);
      assert.equal((await db.query("SELECT count(*)::int n FROM pg_trigger WHERE tgname='first_sync_field_closed_retention' AND tgenabled='O'")).rows[0].n,1);
      // Only the legacy semantic retention is closed; the automatic magento_managed SEO receipt stays admitted.
      assert.match((await db.query("SELECT pg_get_triggerdef(oid) def FROM pg_trigger WHERE tgname='first_sync_field_closed_retention'")).rows[0].def,
        /remote_retained.*retention.*IS DISTINCT FROM 'magento_managed_seo'/);
    });
    await t.test('first sync now offers legacy colour as a missing-only import; retain_remote is refused',async()=>{
      const before=await canonical(),review=await firstSync.review(config,selection,options);
      assert.equal(review.mode,'first');
      // kolir = color, typy_obrobky_burshtynu = material: both pinned legacy SKU questions.
      for(const target of ['kolir','typy_obrobky_burshtynu']){
        const row=review.fields.find(f=>f.target===target&&f.scope==='all');
        assert.equal(row.status,'imported',JSON.stringify(row));assert.equal(Object.hasOwn(row,'canRetainRemote'),false);
      }
      assert.deepEqual(await canonical(),before);
      await assert.rejects(firstSync.apply(config,{...selection,previewToken:review.previewToken,target:'kolir',scope:'all',choice:'retain_remote'},options),
        e=>e.statusCode===422||/INVALID/.test(e.code));
      assert.equal((await ledgerCounts()).fields,0);
    });
    let retained;
    await t.test('historical retained receipts (recorded before 082) remain terminal and complete the session',async()=>{
      // Reproduce the pre-082 ledger exactly as the removed decision recorded it.
      const obs=await observation(),inspection=await firstSync.inspect(config,obs,options);
      assert.equal(inspection.mode,'first');
      // The removed decision recorded the planner rows before canonical validation.
      const plan=require('../src/services/magento/first-sync-progress-plan').prepareProgress(inspection.projection,null);
      const fields=plan.rows.map(row=>{
        const record=Object.fromEntries(['target','scope','state','before','remote','after','source','mappingHash'].map(k=>[k,row.record[k]]));
        if(!['kolir','typy_obrobky_burshtynu'].includes(row.target)||row.scope!=='all')return record;
        return {...record,state:'remote_retained',after:null,source:{...record.source,decision:'retain_remote'}};
      });
      assert.ok(fields.every(f=>['equal','optional_empty','name_received','remote_retained'].includes(f.state)),JSON.stringify(fields.map(f=>[f.target,f.state])));
      const ledger=require('../src/services/magento/first-sync-ledger'),client=await db.connect();
      try{
        await client.query('BEGIN');await client.query('ALTER TABLE magento_first_sync_fields DISABLE TRIGGER first_sync_field_closed_retention');
        await ledger.recordProgressOnClient(client,{key:inspection.first.key,identity:{installationKey:binding.installationKey,publicSku:x.public_sku||x.full_sku,
          remoteProductId:String(10000+x.id),contractVersion:'first-sync-v1',initialProductId:x.id,initialBindingRevisionId:binding.id},
          expectedRevision:'0',previewHash:'c'.repeat(64),fields:fields.map(f=>({...f,source:{...f.source,productId:x.id}})),actorUserId:actor,
          requiredScopes:plan.manifest,complete:true,readyForOutbound:true});
        await client.query('ALTER TABLE magento_first_sync_fields ENABLE TRIGGER first_sync_field_closed_retention');await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
      retained=(await db.query("SELECT target,evidence FROM magento_first_sync_fields WHERE state='remote_retained' ORDER BY target")).rows;
      assert.deepEqual(retained.map(r=>r.target),['kolir','typy_obrobky_burshtynu']);
      assert.equal((await firstSync.review(config,selection,options)).mode,'ordinary');
      assert.equal((await answers()).color,undefined);
    });
    const importer=require('../src/services/magento/retained-remote-import');
    await t.test('retained import preview classifies fields and writes nothing',async()=>{
      const before=await canonical(),counts=await ledgerCounts(),review=await importer.review(config,selection,options);
      assert.equal(review.status,'importable',JSON.stringify(review));
      for(const target of ['kolir','typy_obrobky_burshtynu']){
        const row=review.fields.find(f=>f.target===target);
        assert.equal(row.status,'importable');assert.equal(row.retainedRemote,remoteValues[target]);assert.match(String(row.after),/^[0-9]+$/);
      }
      assert.deepEqual(await canonical(),before);assert.deepEqual(await ledgerCounts(),counts);
    });
    await t.test('operator script preview runs on the ordinary pool and records nothing',async()=>{
      const script=require('../scripts/first-sync-retained-import'),fs=require('node:fs/promises'),os=require('node:os');
      const directory=await fs.mkdtemp(path.join(os.tmpdir(),'retained-import-')),input=path.join(directory,'input.json');
      await fs.writeFile(input,JSON.stringify({bindingRevisionId:binding.id,items:[{sku:x.full_sku}]}));
      const service={review:(cfg,selected,run)=>importer.review(cfg,selected,{...run,preview:options.preview,observeRate:options.observeRate}),
        apply:()=>assert.fail('Preview never applies')};
      const before=await canonical(),lines=[];
      const code=await script.main(['--mode','preview','--server-root',path.resolve(__dirname,'..'),'--input',input,'--output',path.join(directory,'out.jsonl'),
        '--expected-database',name,'--actor-id',String(actor),'--installation-key','schema6-fixture'],
      {service,pool:db,config,fetchImpl:storeConfigs,print:line=>lines.push(JSON.parse(line)),printError:line=>lines.push({error:line})});
      assert.equal(code,0,JSON.stringify(lines));
      assert.deepEqual(lines[0],{sku:x.full_sku,status:'importable',fields:['all/kolir','all/typy_obrobky_burshtynu']});
      assert.deepEqual(await canonical(),before);
    });
    await t.test('apply imports the retained colour missing-only; SKU, ledger and Magento stay unchanged; replay is idempotent',async()=>{
      const counts=await ledgerCounts(),review=await importer.review(config,selection,options);
      const saved=await importer.apply(config,{...selection,previewToken:review.previewToken},options);
      assert.deepEqual(saved.imported.map(f=>f.target),['kolir','typy_obrobky_burshtynu']);assert.equal(saved.remoteWrites,0);assert.equal(saved.alreadyApplied,false);
      const product=await actual(x.id);
      assert.equal(String(product.details.answers.color),String(review.fields.find(f=>f.target==='kolir').after));
      assert.equal(String(product.details.answers.material),String(review.fields.find(f=>f.target==='typy_obrobky_burshtynu').after));
      assert.equal(product.full_sku,fixtureProduct.full_sku);
      assert.equal((await db.query('SELECT count(*)::int n FROM sku_registry WHERE full_sku=$1',[fixtureProduct.full_sku])).rows[0].n,1);
      assert.deepEqual(await ledgerCounts(),counts,'the completed first-sync ledger is immutable history');
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n,0);
      const audit=(await db.query("SELECT details FROM audit_events WHERE event_key='product.magento_retained_values_imported'")).rows;
      assert.equal(audit.length,1);assert.equal(audit[0].details.evidence.proofKind,'opaque_legacy_sku_retained_import');
      const retry=await importer.apply(config,{...selection,previewToken:review.previewToken},{...options,preview:()=>assert.fail('Retry cannot reread Magento')});
      assert.equal(retry.alreadyApplied,true);
      const again=await importer.review(config,selection,options);
      assert.deepEqual(again.fields.map(f=>f.status),['already_imported','already_imported']);assert.equal(again.status,'already_imported');
      await assert.rejects(importer.apply(config,{...selection,previewToken:again.previewToken},options),{code:'MAGENTO_RETAINED_IMPORT_NOTHING_TO_IMPORT'});
      // The ordinary product now evaluates the imported values to Magento's options.
      const evaluated=require('../src/services/export-templates/evaluate').evaluateProduct(compiled,(await previews.readPreviewProduct(db,{productId:x.id,bindingRevisionId:binding.id})).product);
      assert.deepEqual(evaluated.errors,[]);
      for(const target of ['kolir','typy_obrobky_burshtynu']){
        const attribute=binding.bindings.attributes.find(a=>a.target===target&&a.rowId==='base'&&a.routeKey==='SV.souvenir!=value_id:5');
        assert.equal(binding.bindings.options.find(o=>o.bindingKey===attribute.bindingKey&&o.evaluatedOutput===evaluated.base[target]&&o.reviewState==='approved').optionId,remoteValues[target]);
      }
    });
    await t.test('the database refuses any new legacy retained receipt even inside the ledger transaction',async()=>{
      const session=(await db.query('SELECT * FROM magento_first_sync_sessions LIMIT 1')).rows[0];
      await assert.rejects(db.query(`INSERT INTO magento_first_sync_fields(session_id,revision,target,scope,state,evidence)
        VALUES($1,$2,'kolir','all','remote_retained',$3::jsonb)`,[session.id,Number(session.revision)+1,JSON.stringify(retained[0].evidence)]),
      /FIRST_SYNC_REMOTE_RETENTION_CLOSED/);
    });
    await t.test('081 admits the magento_managed SEO retained shape and keeps the 080 shape strict',async()=>{
      const runner=require('../src/db/run-migrations'),fs=require('node:fs/promises');
      const sql=await fs.readFile(path.resolve(__dirname,'../migrations/081_first_sync_magento_managed_seo.sql'),'utf8');
      assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE name='081_first_sync_magento_managed_seo.sql'")).rows[0].checksum,runner.getMigrationChecksum(sql));
      const client=await db.connect();
      try{
        await client.query('BEGIN');
        // The CHECK constraint alone, without the ledger triggers and foreign keys.
        await client.query('CREATE TEMP TABLE shape_probe (LIKE magento_first_sync_fields INCLUDING CONSTRAINTS INCLUDING DEFAULTS) ON COMMIT DROP');
        const seo={target:'meta_title',scope:'all',state:'remote_retained',before:{known:true,present:true,value:'Amber title'},
          remote:{known:true,present:true,value:'Magento title'},after:null,
          source:{kind:'derived',field:'meta_title',routeKey:'CH:all',decision:'retain_remote',retention:'magento_managed_seo'}};
        let probe=0;
        const insert=async evidence=>{
          await client.query(`SAVEPOINT p${++probe}`);
          try{
            await client.query(`INSERT INTO shape_probe(session_id,revision,target,scope,state,evidence) SELECT session_id,revision+1000+$4,$1,$2,$3,$5::jsonb FROM magento_first_sync_fields LIMIT 1`,
              [evidence.target,evidence.scope,evidence.state,probe,JSON.stringify(evidence)]);
            await client.query(`RELEASE SAVEPOINT p${probe}`);return true;
          }catch(error){await client.query(`ROLLBACK TO SAVEPOINT p${probe}`);assert.equal(error.constraint,'first_sync_remote_retained_shape',error.message);return false;}
        };
        assert.equal(await insert(seo),true);
        assert.equal(await insert({...seo,target:'meta_description',scope:'en',source:{...seo.source,field:'meta_description'}}),true);
        assert.equal(await insert({...seo,remote:{known:true,present:false,value:''}}),true,'an empty Magento SEO value is retained as read');
        for(const malformed of [
          {...seo,after:'Amber title'},
          {...seo,remote:{known:false}},
          {...seo,source:{...seo.source,field:'meta_description'}},
          {...seo,target:'name',source:{...seo.source,field:'name'}},
          {...seo,scope:'uk'},
          {...seo,source:{...seo.source,kind:'semantic'}},
          {...seo,source:{...seo.source,retention:undefined}},
          {...seo,state:'equal'},
          {target:'kolir',scope:'all',state:'remote_retained',before:{known:true,present:false},remote:{known:true,present:true,value:'1'},after:null,
            source:{kind:'semantic',decision:'retain_remote',retention:'magento_managed_seo'}},
        ])assert.equal(await insert(malformed),false,JSON.stringify(malformed));
        await client.query('ROLLBACK');
      }finally{client.release();}
      const guard=(await db.query("SELECT prosrc FROM pg_proc WHERE proname='guard_first_sync_evidence'")).rows[0].prosrc;
      assert.match(guard,/magento_managed_seo/);assert.match(guard,/FIRST_SYNC_REMOTE_RETENTION_UNPROVEN/);
    });
  }finally{if(db)await db.end();if(created)await control.query('DROP DATABASE '+name);await control.end();}
});
