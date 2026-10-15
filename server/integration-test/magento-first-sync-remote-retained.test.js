// Real frozen/catalog/publication shapes in the canonical disposable PG only.
require('../test/setup-env');
const test=require('node:test'),assert=require('node:assert/strict');
const {Client,Pool}=require('pg'),{execFile}=require('node:child_process'),{promisify}=require('node:util');
const path=require('node:path'),{randomUUID}=require('node:crypto');
const fixture=require('../test/fixtures/legacy-sv-schema6');
test('080 legacy SV remote retention records terminal first-sync receipts without Amber or Magento writes',async t=>{
  const source=new URL(process.env.TEST_DATABASE_URL||'');assert.equal(source.hostname,'127.0.0.1');assert.equal(source.port,'55432');assert.ok(source.pathname.endsWith('_test'));
  const name='amber_retain_'+process.pid+'_test',control=new Client({connectionString:source.toString()});await control.connect();let created=false,db;
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

    await t.test('080 installs the remote_retained state and shape guard; repeated startup keeps checksums',async()=>{
      const runner=require('../src/db/run-migrations'),fs=require('node:fs/promises');
      const sql=await fs.readFile(path.resolve(__dirname,'../migrations/080_first_sync_remote_retained.sql'),'utf8');
      assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE name='080_first_sync_remote_retained.sql'")).rows[0].checksum,runner.getMigrationChecksum(sql));
      const before=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
      await promisify(execFile)(process.execPath,['-e',"require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});"],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DATABASE_URL:target.toString()}});
      assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,before);
      const constraint=(await db.query("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname='magento_first_sync_fields_state_check'")).rows[0].def;
      assert.match(constraint,/remote_retained/);
      assert.equal((await db.query("SELECT count(*)::int n FROM pg_constraint WHERE conname='first_sync_remote_retained_shape'")).rows[0].n,1);
    });
    await t.test('legacy SV empty-answer characteristics are retainable only by explicit choice; review writes nothing',async()=>{
      const before=await canonical(),review=await firstSync.review(config,selection,options);
      assert.equal(review.mode,'first');
      for(const target of ['kolir','typy_obrobky_burshtynu']){
        const row=review.fields.find(f=>f.target===target&&f.scope==='all');
        assert.equal(row.status,'review_required',JSON.stringify(row));assert.equal(row.reason,'FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED');
        assert.equal(row.canRetainRemote,true);assert.equal(row.canAcceptRemote,false);assert.equal(row.local.present,false);
      }
      assert.equal(review.fields.find(f=>f.target==='price').canRetainRemote,false);
      assert.equal(review.complete,false);assert.deepEqual(await canonical(),before);
      await assert.rejects(firstSync.apply(config,{...selection,previewToken:review.previewToken,target:'price',scope:'all',choice:'retain_remote'},options),
        {code:'MAGENTO_FIRST_SYNC_DECISION_NOT_AVAILABLE'});
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_first_sync_fields')).rows[0].n,0);
    });
    await t.test('operator preview runs the canonical review on the ordinary pool and records nothing',async()=>{
      const script=require('../scripts/first-sync-retain-remote'),fs=require('node:fs/promises'),os=require('node:os');
      const directory=await fs.mkdtemp(path.join(os.tmpdir(),'retain-preview-')),input=path.join(directory,'input.json');
      await fs.writeFile(input,JSON.stringify({bindingRevisionId:binding.id,items:[{sku:x.full_sku}]}));
      const runtime=require('../scripts/sv-campaign-stages').createRuntime(path.resolve(__dirname,'..'));
      // Reuse the controlled observation; the real service, locks and pool stay in use.
      runtime.first={...runtime.first,review:(cfg,selected,run)=>firstSync.review(cfg,selected,{...run,preview:options.preview,observeRate:options.observeRate})};
      const before=await canonical(),fieldsBefore=(await db.query('SELECT count(*)::int n FROM magento_first_sync_fields')).rows[0].n,lines=[];
      const code=await script.main(['--mode','preview','--server-root',path.resolve(__dirname,'..'),'--input',input,'--output',path.join(directory,'out.jsonl'),
        '--expected-database',name,'--actor-id',String(actor),'--installation-key','schema6-fixture'],
      {runtime,pool:db,config,fetchImpl:storeConfigs,print:line=>lines.push(JSON.parse(line)),printError:line=>lines.push({error:line})});
      assert.equal(code,0,JSON.stringify(lines));
      assert.deepEqual(lines[0],{sku:x.full_sku,status:'retainable',fields:['all/kolir','all/typy_obrobky_burshtynu'],imports:[]});
      assert.deepEqual(await canonical(),before);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_first_sync_fields')).rows[0].n,fieldsBefore);
    });
    await t.test('retain_remote records a terminal receipt without changing Amber, completes the session and replays once',async()=>{
      const before=await canonical(),review=await firstSync.review(config,selection,options);
      const choices=[{target:'kolir',scope:'all',choice:'retain_remote'},{target:'typy_obrobky_burshtynu',scope:'all',choice:'retain_remote'}];
      const command={...selection,previewToken:review.previewToken,choices};
      const saved=await firstSync.apply(config,command,options);
      assert.deepEqual(saved.receipt.fields.map(f=>f.state),['remote_retained','remote_retained']);
      assert.equal(saved.complete,true,JSON.stringify(saved));assert.equal(saved.readyForOutbound,true);
      assert.deepEqual(await canonical(),before,'Amber product, requests and jobs are unchanged');
      const rows=(await db.query("SELECT target,evidence FROM magento_first_sync_fields WHERE state='remote_retained' ORDER BY target")).rows;
      assert.deepEqual(rows.map(r=>r.target),['kolir','typy_obrobky_burshtynu']);
      for(const row of rows){assert.equal(row.evidence.after,null);assert.equal(row.evidence.source.decision,'retain_remote');
        assert.equal(row.evidence.remote.value,remoteValues[row.target]);}
      const retry=await firstSync.apply(config,command,{...options,preview:()=>assert.fail('Retry cannot reread Magento')});
      assert.equal(retry.receipt.alreadyApplied,true);
      assert.equal((await firstSync.review(config,selection,options)).mode,'ordinary');
      const product=await actual(x.id);
      assert.equal(product.details.answers.color,undefined);assert.equal(product.details.answers.material,undefined);
      assert.equal(product.full_sku,fixtureProduct.full_sku);
    });
    await t.test('Magento summary coverage counts the completed current product for this origin only',async()=>{
      const problems=require('../src/services/magento/sync-problems');
      const summary=await problems.summary(db,config);
      assert.deepEqual(summary.coverage,{total:1,synced:1,categories:[{code:'SV',name:summary.coverage.categories[0].name,total:1,synced:1}]});
      assert.equal((await problems.summary(db,{...config,baseUrl:'https://other-origin.invalid'})).coverage.synced,0);
      assert.equal((await problems.summary(db,{configured:false})).coverage,null);
      await db.query('UPDATE products SET exclude_from_export=1 WHERE id=$1',[x.id]);
      assert.equal((await problems.summary(db,config)).coverage.total,0,'excluded products are not counted');
      await db.query('UPDATE products SET exclude_from_export=0 WHERE id=$1',[x.id]);
    });
    await t.test('the database refuses a malformed retained receipt even inside the ledger transaction',async()=>{
      const session=(await db.query('SELECT * FROM magento_first_sync_sessions LIMIT 1')).rows[0];
      await assert.rejects(db.query(`INSERT INTO magento_first_sync_fields(session_id,revision,target,scope,state,evidence)
        VALUES($1,$2,'kolir','all','remote_retained','{"target":"kolir","scope":"all","state":"remote_retained","after":"1"}'::jsonb)`,
        [session.id,Number(session.revision)+1]),/first_sync_remote_retained_shape|FIRST_SYNC/);
    });
  }finally{if(db)await db.end();if(created)await control.query('DROP DATABASE '+name);await control.end();}
});
