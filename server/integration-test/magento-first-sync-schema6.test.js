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
