// Disposable PostgreSQL: real canonical validation, atomic writes, audit and ledger replay.
require('../test/setup-env');
const test=require('node:test'),assert=require('node:assert/strict');
const {Client,Pool}=require('pg');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
test('legacy SV missing-only first-sync inputs preserve identity/history and atomic receipt boundaries',async t=>{
  const source=new URL(process.env.TEST_DATABASE_URL||'');assert.equal(source.hostname,'127.0.0.1');assert.equal(source.port,'55432');assert.ok(source.pathname.endsWith('_test'));
  const name='amber_first_legacy_'+process.pid+'_test',control=new Client({connectionString:source.toString()});await control.connect();let created=false,db;
  try{
    await control.query('CREATE DATABASE '+name);created=true;const target=new URL(source);target.pathname='/'+name;
    await promisify(execFile)(process.execPath,['-e',"require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});"],{cwd:path.resolve(__dirname,'..'),env:{...process.env,DATABASE_URL:target.toString()}});
    db=new Pool({connectionString:target.toString(),max:6});t.mock.method(globalThis,'fetch',()=>assert.fail('No live HTTP permitted'));
    const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Canonical fixture administrator') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
    await db.query("INSERT INTO categories(code,name,requires_weight,marketing_rounding_enabled) VALUES('SV','Canonical fixture',0,0)");
    for(const category of ['NM','KL','CH','AR','BR'])await db.query('INSERT INTO categories(code,name) VALUES($1,$1)',[category]);
    const color=Number((await db.query("INSERT INTO questions(category_code,key,label,input_type,required,include_in_sku,sku_index) VALUES('SV','binding_test_semantic','Color','options',0,0,0) RETURNING id")).rows[0].id);
    await db.query("INSERT INTO options(question_id,value_id,label) VALUES($1,7,'Red output'),($1,8,'Blue output'),($1,9,'Red output')",[color]);
    await db.query(`INSERT INTO questions(category_code,key,label,input_type,required,include_in_sku,sku_index,numeric_validation)
      VALUES('SV','weight','Grams','text',1,0,1,'{"kind":"decimal","unit":"g","min":0,"max":null,"minInclusive":false,"maxInclusive":true,"maxFractionDigits":3}')`);
    const scenario=Number((await db.query("INSERT INTO price_scenarios(category_code,name,group_name,match_json,axis_x_key,axis_y_key,priority,status,price_mode,apply_modifiers) VALUES('SV','Fixed fixture','Fixture','{}','binding_test_semantic','',1,'active','fixed_uah',false) RETURNING id")).rows[0].id);
    await db.query('INSERT INTO price_matrix(scenario_id,x_val,y_val,price) VALUES($1,7,0,100),($1,8,0,150)',[scenario]);
    const fixtures=require('../test/fixtures/magento-bindings'),c=require('../src/services/magento/binding-contract');
    const def=structuredClone(fixtures.definition());delete def.sources.size;def.sources.color.category='SV';
    for(const group of def.groups)for(const row of group.rows){delete row.cells.dovzhyna_brasletu_diuimiv;}
    const svGroup=def.groups.find(g=>g.code==='SV' || g.category==='SV' || g.id==='SV');
    const selectedGroup=svGroup || def.groups[5];
    Object.assign(selectedGroup.rows[0].cells,def.groups[0].rows[0].cells);
    delete def.groups[0].rows[0].cells.kolir;delete def.groups[0].rows[0].cells.decor_weight;
    selectedGroup.rows[0].cells.decor_weight={op:'text',input:{op:'source',id:'weight'},trim:false,format:'scalar-v1',onAbsent:'empty'};
    const schema=structuredClone(fixtures.schema()),attribute=schema.attributes.find(a=>a.attribute_code==='decor_weight');attribute.frontend_input='text';attribute.options=[];
    const templates=require('../src/services/export-templates/template.service'),bindings=require('../src/services/magento/binding.service');
    const options={databasePool:db,mutationContext:{actorUserId:actor}};
    const family=await templates.createTemplate({key:'canonical-'+randomUUID(),displayName:'Canonical fixture',definition:def},options);
    const version=await templates.publishTemplate(family.id,{expectedRevision:family.draft.revision,expectedDefinitionHash:family.draft.definitionHash},options);
    let binding=await bindings.createDraft({installationKey:'canonical-fixture',origin:'https://canonical.invalid',templateVersionId:version.id,observedAt:'2026-10-09T00:00:00Z',schema},options);
    binding=await bindings.updateDraft(binding.id,{expectedRevision:binding.revision,bindings:fixtures.approvedBindings(def,schema,'SV')},options);
    binding=await bindings.publishDraft(binding.id,{expectedRevision:binding.revision,expectedCurrentId:null},options);
    const previews=require('../src/services/magento/sync-preview-db'),helper=require('../src/services/magento/first-sync-local-apply'),canonical=require('../src/services/magento/first-sync-canonical-inputs');
    const ledger=require('../src/services/magento/first-sync-ledger'),gate=require('../src/services/full-product-cutover-gate');
    const schemas=require('../src/services/sku-schema.service');
    const snapshot=[{key:'souvenir',label:'Souvenir',sku_index:0,display_order:0,required:1,sku_separator:'',visible_if_json:null,
      options:[{value_id:5,sku_code:'5',label:'Stone',visible_if_json:null,hidden_if_json:null,archived:false}]}];
    const schemaId=Number((await db.query("INSERT INTO sku_schema_versions(category_code,version,marker,status,config_hash) VALUES('SV',1,'','active',$1) RETURNING id",[schemas.hashSnapshot(snapshot)])).rows[0].id);
    const sqId=Number((await db.query("INSERT INTO sku_schema_questions(schema_version_id,question_key,label,sku_index,display_order,required,sku_separator) VALUES($1,'souvenir','Souvenir',0,0,1,'') RETURNING id",[schemaId])).rows[0].id);
    await db.query("INSERT INTO sku_schema_options(schema_question_id,value_id,sku_code,label) VALUES($1,5,'5','Stone')",[sqId]);
    const legacyProducts=[];
    for(let i=1;i<=12;i++)legacyProducts.push((await require('./product-fixture').insertProductFixture(db,
      "INSERT INTO products(full_sku,base_sku,sequence_number,category,weight,total_price_uah,sku_schema_version_id,details) VALUES($1,'SV5',4,'SV',NULL,200,$2,$3::jsonb) RETURNING *",
      ['SV5004-'+String(i).padStart(3,'0'),schemaId,JSON.stringify({answers:{souvenir:5},manualPriceUah:200,keep:'original history'})])).rows[0]);
    const activationEvent=Number((await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('public_sku.activated',$1,'{"displayName":"Canonical fixture administrator","preferredUsername":null}','public_sku_activation','singleton',$2) RETURNING id`,[actor,randomUUID()])).rows[0].id);
    const cutoverEvent=Number((await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id) VALUES('magento_delivery.cutover',$1,'{"displayName":"Canonical fixture administrator","preferredUsername":null}','public_sku_activation','singleton',$2) RETURNING id`,[actor,randomUUID()])).rows[0].id);
    const activationClient=await db.connect();try{await activationClient.query('BEGIN');await activationClient.query("SET LOCAL amber.public_sku_activation='on'");
      await activationClient.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton',[actor,activationEvent]);
      await activationClient.query("SET LOCAL amber.magento_delivery_cutover='on'");
      await activationClient.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='canonical-fixture',actor_user_id=$1,legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`,[actor,cutoverEvent]);await activationClient.query('COMMIT');
    }catch(e){await activationClient.query('ROLLBACK');throw e;}finally{activationClient.release();}
    const rateObservation=await require('../src/services/currency.service').observeUsdRate({databasePool:db});
    const config={baseUrl:'https://canonical.invalid'};
    const make=async()=>{const p=legacyProducts.shift();assert.ok(p,'enough pre-activation legacy fixtures');return p;};
    const actual=async p=>(await db.query('SELECT * FROM products WHERE id=$1',[p.id])).rows[0];
    async function prepared(p,allowBlocked=false){
      const amber=await previews.readPreviewProduct(db,{productId:p.id,bindingRevisionId:binding.id});
      const projection={fields:[],projection:[],plan:{fields:[]}},fields=[];
      for(const [target,persistence,after,remote,key,before]of [['decor_weight','weight','4.125','4.125',null,'3'],['kolir','characteristic','8','blue-id','binding_test_semantic',7]]){
        const source={kind:key?'semantic':'product',...(key?{key}:{field:'weight'}),bindingRevisionId:binding.id,definitionHash:amber.compiled.hash,routeKey:'SV:all'};
        const canonicalBefore=key?amber.product.details.answers[key]:amber.product.weight;
        const populated=canonicalBefore!==null && canonicalBefore!==undefined && canonicalBefore!=='';
        const input={target,scope:'all',mapping:{proven:true},local:{known:true,present:populated,...(canonicalBefore===undefined?{}:{value:canonicalBefore})},remote:{known:true,present:true,value:remote},...(key?{reverseCandidates:[{value:'8',optionId:'blue-id'}]}:{unit:'g',scale:3})};
        const metadata={target,scope:'all',persistence,source,mappingHash:c.hash({target}),storagePath:key?'details.answers.'+key:'weight'};
        projection.fields.push(input);projection.projection.push(metadata);projection.plan.fields.push({target,scope:'all',status:populated?'conflict':'imported',...(!populated?{importValue:after}:{})});
        fields.push({target,scope:'all',state:'imported',before:input.local,remote:input.remote,after,source:{...source,productId:p.id,...(populated?{decision:'accept_remote'}:{})},mappingHash:metadata.mappingHash});
      }
      const observation={amber,raw:{id:1000+p.id,sku:amber.product.public_sku,name:'Fixture name'},domainEvidence:{english:{fields:{name:'Fixture name'}}}};
      const args={config,observation,projection,acceptedFields:fields,actorUserId:actor,rateObservation};
      const preview=await helper.prepareFirstSyncLocal(db,args);if(!allowBlocked)assert.deepEqual(preview.blockedFields,[]);
      return {...args,validation:preview,expectedCanonicalHash:preview.canonicalHash};
    }
    async function record(p,args,{hash=c.hash({p:p.id}),failAfter=false}={}){
      const client=await db.connect();try{await gate.begin(client,'BEGIN');await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[p.id]);
        const result=await ledger.recordProgressOnClient(client,{key:{originHash:binding.originHash,publicIdentityId:String(p.public_product_identity_id)},
          identity:{installationKey:binding.installationKey,publicSku:args.observation.raw.sku,remoteProductId:String(args.observation.raw.id),contractVersion:'first-sync-v1',initialProductId:p.id,initialBindingRevisionId:binding.id},
          expectedRevision:'0',previewHash:hash,fields:args.acceptedFields,actorUserId:actor,complete:false,readyForOutbound:false,
          applyLocal:async(tx,acceptedFields)=>{await helper.applyFirstSyncLocal(tx,{...args,acceptedFields});if(failAfter)throw new Error('interrupted after canonical write');}});
        await gate.commit(client);return result;
      }catch(e){await gate.rollback(client);throw e;}finally{await gate.release(client);client.release();}
    }
    await t.test('missing-only adoption persists grams, characteristic and updated baseline in one revision; replay does not write',async()=>{
      const p=await make(),before=await actual(p),args=await prepared(p),frozen=(await db.query('SELECT * FROM sku_schema_versions WHERE id=$1',[p.sku_schema_version_id])).rows;
      const historical=await db.query('SELECT (SELECT jsonb_agg(to_jsonb(q) ORDER BY q.id) FROM sku_schema_questions q) AS questions,(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM sku_schema_options o) AS options,(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public_product_identities i) AS identities,(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.full_sku) FROM sku_registry r) AS reservations');
      const result=await record(p,args);assert.equal(result.alreadyApplied,false);const after=await actual(p);
      assert.deepEqual((await db.query('SELECT (SELECT jsonb_agg(to_jsonb(q) ORDER BY q.id) FROM sku_schema_questions q) AS questions,(SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM sku_schema_options o) AS options,(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public_product_identities i) AS identities,(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.full_sku) FROM sku_registry r) AS reservations')).rows,historical.rows);
      assert.equal(after.weight,'4.125');assert.equal(after.details.answers.weight,'4.125');assert.equal(after.details.answers.binding_test_semantic,'8');
      assert.equal(after.total_price_uah,'200.00');assert.equal(after.details.manualPriceUah,200);assert.equal(after.details.autoPriceUah,150);assert.equal(after.details.calculatedPriceUah,150);assert.equal(after.details.keep,'original history');
      for(const key of ['full_sku','public_product_identity_id','characteristic_version_id','sku_schema_version_id'])assert.equal(after[key],before[key]);
      assert.deepEqual((await db.query('SELECT * FROM sku_schema_versions WHERE id=$1',[p.sku_schema_version_id])).rows,frozen);
      const audits=(await db.query('SELECT * FROM audit_events WHERE subject_id=$1 ORDER BY id',[String(p.id)])).rows;
      assert.equal((await record(p,args)).alreadyApplied,true);assert.deepEqual(await actual(p),after);
      assert.deepEqual((await db.query('SELECT * FROM audit_events WHERE subject_id=$1 ORDER BY id',[String(p.id)])).rows,audits);
    });
    await t.test('lost action before commit rolls back inputs, baseline, audit and receipts; exact retry succeeds',async()=>{
      const p=await make(),before=await actual(p),args=await prepared(p);
      await assert.rejects(record(p,args,{failAfter:true}),/interrupted after canonical write/);assert.deepEqual(await actual(p),before);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_first_sync_sessions WHERE public_product_identity_id=$1',[p.public_product_identity_id])).rows[0].n,0);
      assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.first_sync_canonical_adopted' AND subject_id=$1",[String(p.id)])).rows[0].n,0);
      assert.equal((await record(p,args)).alreadyApplied,false);
    });
    await t.test('concurrent catalog insertion blocks NOWAIT preparation and leaves exact original state',async()=>{
      const p=await make(),args=await prepared(p),before=await actual(p),writer=await db.connect();
      try{await writer.query('BEGIN');await writer.query("INSERT INTO questions(category_code,key,label,input_type,required,include_in_sku,sku_index) VALUES('SV','concurrent_new','New','text',0,0,2)");
        await assert.rejects(record(p,args),/lock|validation/i);assert.deepEqual(await actual(p),before);
      }finally{await writer.query('ROLLBACK');writer.release();}
    });
    await t.test('changed catalog or pricing context invalidates reviewed candidate even if final manual UAH is equal',async()=>{
      for(const change of ['catalog','pricing']){const p=await make(),args=await prepared(p),before=await actual(p);
        if(change==='catalog')await db.query("UPDATE questions SET label='Changed label' WHERE key='binding_test_semantic'");
        else await db.query('UPDATE price_matrix SET price=151 WHERE scenario_id=$1 AND x_val=8',[scenario]);
        await assert.rejects(record(p,args),/PREVIEW_STALE/);assert.deepEqual(await actual(p),before);
      }
    });
    await t.test('rate observation timestamps do not stale identical economic evidence',async()=>{
      const p=await make(),args=await prepared(p),a=await helper.prepareFirstSyncLocal(db,args);
      const later=await require('../src/services/currency.service').observeUsdRate({databasePool:db});
      const b=await helper.prepareFirstSyncLocal(db,{...args,rateObservation:later});assert.equal(a.canonicalHash,b.canonicalHash);assert.deepEqual(b.blockedFields,[]);
    });

    await t.test('empty legacy weight and characteristic receive only the proved mapped values',async()=>{
      const p=await make(true),before=await actual(p),args=await prepared(p);await record(p,args);
      const after=await actual(p);assert.equal(after.weight,'4.125');assert.equal(after.details.answers.weight,'4.125');assert.equal(after.details.answers.binding_test_semantic,'8');
      assert.equal(after.characteristic_version_id,before.characteristic_version_id);assert.equal(after.total_price_uah,before.total_price_uah);
    });
    await t.test('real automatic calculations changing final UAH stay reviewed without conversion to Manual UAH',async()=>{
      for(const mode of ['automatic']){
        const p=await make(),tx=await db.connect();try{await gate.begin(tx,'BEGIN');
          const details=mode==='automatic'?{answers:{souvenir:5},calculatedPriceUah:100,autoPriceUah:100,manualPriceUah:null,pricingScenario:{price_mode:'fixed_uah'}}
            :{answers:{weight:'3',binding_test_semantic:7},calculatedPriceUah:240,autoPriceUah:240,manualPriceUah:null,customUsdPerGramBasis:{usdPerGram:2,marketingRoundingEnabled:false,source:'product_price_change'}};
          await tx.query('UPDATE products SET details=$2::jsonb,total_price_uah=$3,total_price=$4,price_per_gram=$5,uah_rate=40 WHERE id=$1',[p.id,JSON.stringify(details),mode==='automatic'?100:240,mode==='automatic'?0:6,mode==='automatic'?0:2]);
          await gate.commit(tx);
        }catch(e){await gate.rollback(tx);throw e;}finally{await gate.release(tx);tx.release();}
        const before=await actual(p),args=await prepared(p,true);
        assert.ok(args.validation.blockedFields.every(f=>f.code==='FIRST_SYNC_CANONICAL_PRICE_REVIEW_REQUIRED'));assert.equal(args.validation.blockedFields.length,2);
        await assert.rejects(record(p,args),/PRICE_REVIEW_REQUIRED/);assert.deepEqual(await actual(p),before);
      }
    });
    await t.test('raw nullable non-SKU flag invalidates prepared import and never writes inputs or receipts',async()=>{
      const p=await make(),args=await prepared(p),before=await actual(p);
      try{
        await db.query('UPDATE questions SET include_in_sku=NULL WHERE id=$1',[color]);
        const validation=await helper.prepareFirstSyncLocal(db,args);
        assert.ok(validation.blockedFields.every(f=>f.code==='FIRST_SYNC_LEGACY_SKU_CORRECTION_REQUIRED'));
        assert.equal(validation.blockedFields.length,2);await assert.rejects(record(p,args),/SKU_CORRECTION_REQUIRED/);
        assert.deepEqual(await actual(p),before);
      }finally{await db.query('UPDATE questions SET include_in_sku=0 WHERE id=$1',[color]);}
    });
    assert.equal(typeof canonical.prepareCanonicalInputs,'function');
  }finally{if(db)await db.end();if(created)await control.query('DROP DATABASE '+name);await control.end();}
});
