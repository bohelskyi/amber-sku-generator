// Disposable PostgreSQL only: reviewed Magento decor_weight readback into canonical weight
// on the actual frozen legacy SV catalog/publication copies. Magento is a GET-only fake.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {Client}=require('pg');
const {seedCurrentSvCatalog,seedFrozenSvSchema}=require('./legacy-sv-schema6-seed');
test('083 Magento readback copies decor_weight into zero canonical weight with exact receipts, stale guards and inverse',async t=>{
  const source=new URL(process.env.TEST_DATABASE_URL);
  assert.equal(source.hostname,'127.0.0.1'); assert.equal(source.port,'55432'); assert.ok(source.pathname.endsWith('_test'));
  const name=`amber_weight_readback_${process.pid}_test`,control=new Client({connectionString:source.toString()});
  await control.connect(); let db,pool,created=false,external=0;
  const oldFetch=global.fetch; global.fetch=async()=>{external++;throw new Error('READBACK_EXTERNAL_FETCH_FORBIDDEN');};
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1',[name])).rows[0].n,0);
    await control.query(`CREATE DATABASE ${name}`); created=true;
    const target=new URL(source); target.pathname=`/${name}`;
    process.env.DATABASE_URL=target.toString(); process.env.MAGENTO_BASE_URL=''; process.env.NBU_RATE_OVERRIDE='40';
    require('../test/setup-env'); pool=require('../src/db/pool'); db=new Client({connectionString:target.toString()}); await db.connect();
    const directory=path.resolve(__dirname,'../migrations'),runner=require('../src/db/run-migrations');
    const migration=await fs.readFile(path.join(directory,'083_canonical_weight_magento_readback.sql'),'utf8');
    let legacyReceipt;
    await t.test('082 checkpoint rolls back all 083 DDL; startup applies once, keeps checksums and old receipts immutable',async()=>{
      await db.query('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,checksum TEXT,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');
      for(const file of (await fs.readdir(directory)).filter(file=>file.endsWith('.sql')&&file<'083_').sort()) {
        const sql=await fs.readFile(path.join(directory,file),'utf8');
        await db.query('BEGIN'); await db.query(sql);
        await db.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[file,runner.getMigrationChecksum(sql)]); await db.query('COMMIT');
      }
      // A synthetic pre-083 receipt row (guards bypassed only for this disposable fixture).
      const user=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Legacy receipt fixture') RETURNING id")).rows[0].id);
      const manifestText=JSON.stringify({format:'sv-canonical-weight-repair-v1',fixture:true}),planHash=crypto.createHash('sha256').update(manifestText).digest('hex');
      legacyReceipt=crypto.randomUUID();
      await db.query('BEGIN'); await db.query('SET LOCAL session_replication_role=replica');
      await db.query('INSERT INTO product_weight_repair_plans(plan_hash,manifest_text,actor_user_id) VALUES($1,$2,$3)',[planHash,manifestText,user]);
      await db.query(`INSERT INTO product_weight_repair_receipts(id,plan_hash,product_id,actor_user_id,direction,before_state,after_state,source_answer,weight_question_id,target_weight)
        VALUES($1,$2,999999,$3,'apply','{}','{}','"1"',999999,1)`,[legacyReceipt,planHash,user]);
      await db.query('COMMIT');
      const before=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
      await db.query('BEGIN');
      try { await db.query(migration); }
      catch (cause) { cause.message += ` [083 SQL position ${cause.position || cause.internalPosition || '?'}]`; throw cause; }
      finally { await db.query('ROLLBACK'); }
      assert.equal((await db.query("SELECT to_regprocedure('sv_weight_magento_candidate(products,boolean)') name")).rows[0].name,null);
      assert.equal((await db.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='product_weight_repair_receipts' AND column_name IN ('source_kind','target_answer','remote_evidence')")).rows[0].n,0);
      assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,before);
      await runner.runMigrations(); await runner.runMigrations();
      assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE name='083_canonical_weight_magento_readback.sql'")).rows[0].checksum,runner.getMigrationChecksum(migration));
      assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name<'083_' ORDER BY name")).rows,before);
      const old=(await db.query('SELECT source_kind,target_answer,remote_evidence FROM product_weight_repair_receipts WHERE id=$1',[legacyReceipt])).rows[0];
      assert.deepEqual(old,{source_kind:'recorded_answer',target_answer:null,remote_evidence:null});
      for(const sql of ["UPDATE product_weight_repair_receipts SET source_kind='magento_readback' WHERE id=$1","UPDATE product_weight_repair_receipts SET target_weight=2 WHERE id=$1",'DELETE FROM product_weight_repair_receipts WHERE id=$1']) {
        await db.query('BEGIN'); await db.query("SELECT set_config('amber.canonical_weight_repair',$1,TRUE),set_config('amber.canonical_weight_repair_plan',$2,TRUE)",[legacyReceipt,planHash]);
        await assert.rejects(db.query(sql,[legacyReceipt]),/immutable|permanent|CONTEXT/); await db.query('ROLLBACK');
      }
      await db.query('BEGIN'); await db.query('SET LOCAL session_replication_role=replica');
      await db.query('DELETE FROM product_weight_repair_receipts WHERE id=$1',[legacyReceipt]); await db.query('DELETE FROM product_weight_repair_plans WHERE plan_hash=$1',[planHash]);
      await db.query('COMMIT');
    });
    assert.ok((await db.query("SELECT to_regprocedure('sv_weight_magento_candidate(products,boolean)') name")).rows[0].name,'Checkpoint must install 083');
    const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Readback fixture administrator') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
    const fixture=require('../test/fixtures/legacy-sv-schema6'),f=fixture.data;
    for(const category of ['NM','KL','CH','AR','BR'])await db.query('INSERT INTO categories(code,name) VALUES($1,$1)',[category]);
    await db.query('INSERT INTO categories(code,name,requires_weight,skip_hidden_sku_questions,marketing_rounding_enabled) VALUES($1,$2,$3,$4,$5)',[f.category.code,f.category.name,f.category.requires_weight,f.category.skip_hidden_sku_questions,f.category.marketing_rounding_enabled]);
    await seedCurrentSvCatalog(db,f);
    await db.query("INSERT INTO sku_schema_versions(id,category_code,version,marker,status,config_hash) VALUES(6,'SV',1,'','active',$1)",[f.schema.config_hash]);
    await seedFrozenSvSchema(db,f);
    const p=fixture.publication(),templates=require('../src/services/export-templates/template.service'),bindings=require('../src/services/magento/binding.service');
    const actorOptions={databasePool:pool,mutationContext:{actorUserId:actor}};
    const family=await templates.createTemplate({key:'readback-'+crypto.randomUUID(),displayName:'Exact schema6 publication copy',definition:p.definition},actorOptions);
    const compiled=require('../src/services/export-templates/definition').compileDefinition(p.definition),version={id:crypto.randomUUID()};
    await db.query(`INSERT INTO export_template_versions(id,template_id,version_number,source_draft_revision,definition,definition_hash,format_version,evaluator_version,output_contract,published_by_user_id)
      VALUES($1,$2,2,1,$3::jsonb,$4,$5,$6,$7,$8)`,[version.id,family.id,JSON.stringify(compiled.definition),compiled.hash,compiled.definition.formatVersion,compiled.definition.evaluatorVersion,compiled.definition.outputContract,actor]);
    let binding=await bindings.createDraft({installationKey:'readback-fixture',origin:'https://readback.invalid',templateVersionId:version.id,observedAt:'2026-10-09T07:10:37Z',schema:p.schema},actorOptions);
    binding=await bindings.updateDraft(binding.id,{expectedRevision:binding.revision,bindings:p.bindings},actorOptions);
    await db.query("UPDATE magento_binding_revisions SET state='published',revision=revision+1,version_number=2,published_by_user_id=$2,published_at=CURRENT_TIMESTAMP WHERE id=$1",[binding.id,actor]);
    binding=await bindings.getRevision(binding.id,actorOptions);
    let variant=0;
    async function copy(id,answer,weight=0) {
      const x=fixture.product(id); x.id+=100000*(++variant); x.full_sku+='-'+String(variant).padStart(3,'0');
      if(answer===undefined) delete x.details.answers.weight; else x.details.answers.weight=answer;
      const row=(await require('./product-fixture').insertProductFixture(db,`INSERT INTO products(id,full_sku,base_sku,sequence_number,category,weight,sku_schema_version_id,total_price,total_price_uah,price_per_gram,uah_rate,details,legacy_uah_price_unset)
        VALUES($1,$2,$3,$4,'SV',$5,6,$6,$7,$8,$9,$10::jsonb,$11) RETURNING *`,[x.id,x.full_sku,x.base_sku,x.sequence_number,weight,x.total_price,x.total_price_uah,x.price_per_gram,x.uah_rate,JSON.stringify(x.details),x.legacy_uah_price_unset])).rows[0];
      await db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1",[row.id]);
      return row;
    }
    const absent=await copy(782),zero=await copy(838,'0'),jsonNull=await copy(1018,null),stone=await copy(1835),other=await copy(1481);
    const recorded=await copy(779,'123'),weighed=await copy(1919,'16.2',16.2),invalid=await copy(793,'abc'),pending=await copy(782);
    const noRemote=await copy(793),zeroRemote=await copy(1481),preciseRemote=await copy(1481),history=await copy(1481),limited=await copy(1481);
    const stale=await copy(782),forged=await copy(782),auditFailure=await copy(782),race=await copy(782);
    await db.query("UPDATE product_full_export_state SET confirmed_revision=revision WHERE product_id=$1",[history.id]);
    await db.query("UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='readback-fixture',actor_user_id=$1 WHERE singleton",[actor]);
    await db.query('INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id) VALUES($1,$2)',[pending.public_product_identity_id,pending.id]);
    const remote=new Map([[absent.id,'12.5'],[zero.id,'7'],[jsonNull.id,'30.250'],[stone.id,'46,3'],[other.id,'101.125'],[recorded.id,'99'],[weighed.id,'16.2'],
      [invalid.id,'5'],[pending.id,'5'],[zeroRemote.id,'0'],[preciseRemote.id,'12.3456'],[history.id,'5'],[limited.id,'2000'],
      [stale.id,'8'],[forged.id,'9'],[auditFailure.id,'10'],[race.id,'11']]);
    const previews=require('../src/services/magento/sync-preview-db');
    const methods=[],observed=[];
    const rateObservation={rateInfo:{rate:40,rateDate:new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Kyiv'}),
      fetchedAt:new Date().toISOString(),source:'fixture',stale:false,ageMs:0,error:null},rateError:null};
    // Product/schema reads are the injected observation; store-config currency reads go through the GET-only fetch.
    const magento={observeRate:async()=>rateObservation,
      preview:async(_config,input)=>{
        const id=Number((await db.query('SELECT p.id FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE i.public_sku=$1',[input.sku])).rows[0].id);
        observed.push(id);
        const amber=await previews.readPreviewProduct(pool,{productId:id,bindingRevisionId:binding.id});
        const evaluated=require('../src/services/export-templates/evaluate').evaluateProduct(compiled,amber.product);
        const route=require('../src/services/magento/first-sync-route').productRoutePlans(
          require('../src/services/magento/binding-validation').requirements(compiled.definition,binding.schema),amber.product)[0];
        const custom_attributes=binding.bindings.attributes.filter(a=>a.routeKey===route.routeKey&&a.rowId==='base'&&a.strategy!=='transport_control'
          &&!['sku','name','price'].includes(a.target)).map(a=>{
          if(a.target==='decor_weight') return {attribute_code:a.attributeCode,value:remote.get(id) ?? null};
          const output=evaluated.base[a.target]??'';
          const mapped=binding.bindings.options.find(o=>o.bindingKey===a.bindingKey&&o.evaluatedOutput===output&&o.reviewState==='approved');
          return {attribute_code:a.attributeCode,value:mapped?.optionId??output};
        }).filter(a=>a.value!==null);
        const raw={id:10000+(id%1000000),sku:amber.product.public_sku,attribute_set_id:151,name:evaluated.base.name,price:String(amber.product.total_price_uah),
          custom_attributes:[...custom_attributes,{attribute_code:'weight',value:'999'}]};
        input.onObservation({amber,raw,schema:binding.schema,domainEvidence:{english:{id:raw.id,sku:raw.sku,fields:{name:evaluated.english.name}},failures:[]}});
        return {};
      },
      fetchImpl:async(url,init={})=>{
        methods.push(init.method||'GET'); assert.equal(init.method||'GET','GET'); assert.equal(init.body,undefined);
        assert.ok(new URL(url).pathname.endsWith('/store/storeConfigs'));
        return new Response(JSON.stringify([{id:1,code:'ua',website_id:1,locale:'uk_UA',base_currency_code:'UAH'},{id:3,code:'en',website_id:1,locale:'en_US',base_currency_code:'UAH'}]),
          {status:200,headers:{'content-type':'application/json'}});
      }};
    const config={configured:true,baseUrl:'https://readback.invalid',consumerKey:'fixture',consumerSecret:'fixture',accessToken:'fixture',accessTokenSecret:'fixture'};
    const options={...actorOptions,...magento,config,expectedDatabase:name,installationKey:'readback-fixture',bindingRevisionId:binding.id};
    const service=require('../src/services/canonical-weight-repair');
    const preview=(extra={})=>service.preview({...options,source:'magento-readback',...extra});
    const apply=async(plan,ids,extra={})=>service.apply(plan,{...options,expectedHash:plan.planHash,productIds:ids,...extra});
    const snapshot=async id=>(await db.query('SELECT sv_weight_repair_state($1)::text value',[id])).rows[0].value;
    const row=async id=>(await db.query('SELECT to_jsonb(p) value FROM products p WHERE id=$1',[id])).rows[0].value;
    const durable=async()=>(await db.query(`SELECT (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,
      (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) lifecycle,
      (SELECT jsonb_agg(r ORDER BY public_product_identity_id) FROM magento_product_sync_requests r) requests,
      (SELECT jsonb_agg(s ORDER BY id) FROM magento_first_sync_sessions s) sessions,
      (SELECT count(*) FROM product_weight_repair_receipts) receipts,(SELECT count(*) FROM audit_events) audits`)).rows[0];
    const entryOf=(plan,x)=>plan.entries.find(e=>e.productId===x.id);
    let plan;
    await t.test('preview records nothing and admits only zero-weight rows whose answer is absent, JSON null or zero',async()=>{
      await db.query("UPDATE questions SET numeric_validation='{\"kind\":\"decimal\",\"unit\":\"g\",\"min\":0,\"max\":1000,\"minInclusive\":false,\"maxInclusive\":true,\"maxFractionDigits\":3}' WHERE id=69");
      const before=await durable(); plan=await preview(); assert.deepEqual(await durable(),before);
      assert.equal(plan.format,'sv-canonical-weight-magento-v1');
      for(const x of [absent,zero,jsonNull,stone,other,stale,forged,auditFailure,race]) assert.equal(entryOf(plan,x).eligible,true,JSON.stringify(entryOf(plan,x)));
      const reasons=x=>entryOf(plan,x).reasonCodes;
      assert.deepEqual(reasons(recorded),['RECORDED_ANSWER_LANE']); assert.ok(reasons(weighed).includes('CANONICAL_WEIGHT_NOT_ZERO'));
      assert.deepEqual(reasons(invalid),['ANSWER_NOT_MISSING_OR_ZERO']); assert.deepEqual(reasons(pending),['UNFINISHED_DELIVERY_WORK']);
      assert.deepEqual(reasons(zeroRemote),['READBACK_REASON_UNEXPECTED'],JSON.stringify(entryOf(plan,zeroRemote))); assert.equal(entryOf(plan,preciseRemote).readbackReason,'REMOTE_DECIMAL_INVALID_OR_SCALE_EXCEEDED');
      assert.deepEqual(reasons(noRemote),['REMOTE_WEIGHT_NOT_POSITIVE_DECIMAL']); assert.deepEqual(reasons(history),['READBACK_MODE_NOT_FIRST']);
      assert.deepEqual(reasons(limited),['REMOTE_WEIGHT_RULES']);
      assert.deepEqual([entryOf(plan,absent).targetWeight,entryOf(plan,absent).targetAnswer],['12.500','12.5']);
      assert.deepEqual([entryOf(plan,stone).targetWeight,entryOf(plan,stone).targetAnswer,entryOf(plan,stone).remoteEvidence.value],['46.300','46.3','46,3']);
      assert.deepEqual([entryOf(plan,jsonNull).targetAnswer,entryOf(plan,jsonNull).sourceAnswer,entryOf(plan,jsonNull).sourceAnswerPresent],['30.25',null,true]);
      assert.equal(entryOf(plan,absent).sourceAnswerPresent,false); assert.equal(entryOf(plan,zero).sourceAnswer,'0');
      assert.equal(entryOf(plan,absent).remoteEvidence.target,'decor_weight');
      for(const x of [recorded,weighed,invalid,pending]) assert.equal(observed.includes(x.id),false,'DB-ineligible rows are never read from Magento');
      assert.ok(methods.length>0); assert.ok(methods.every(m=>m==='GET'));
      await db.query("UPDATE categories SET requires_weight=1 WHERE code='SV'");
      try { const encoded=await preview(); assert.ok(entryOf(encoded,absent).reasonCodes.includes('WEIGHT_ENCODED_SKU')); assert.equal(encoded.summary.eligible,0); }
      finally { await db.query("UPDATE categories SET requires_weight=0 WHERE code='SV'"); }
      plan=await preview();
    });
    const receipts={};
    await t.test('apply writes only weight and the answer, keeps prices/SKU/identity, creates no sync request and retries once',async()=>{
      const chosen=[absent,zero,jsonNull,stone,other],before=Object.fromEntries(await Promise.all(chosen.map(async x=>[x.id,await row(x.id)])));
      const requests=(await db.query('SELECT count(*)::int n FROM magento_product_sync_requests')).rows[0].n;
      const lifecycle=async()=>(await db.query('SELECT jsonb_agg(f ORDER BY product_id) value FROM product_full_export_state f WHERE product_id=ANY($1::int[])',[chosen.map(x=>x.id)])).rows[0].value;
      const states=await lifecycle();
      const result=await apply(plan,chosen.map(x=>x.id)); assert.equal(result.counts.applied,5,JSON.stringify(result));
      for(const outcome of result.outcomes) receipts[outcome.productId]=outcome.receiptId;
      for(const x of chosen) {
        const after=await row(x.id),entry=entryOf(plan,x),expected=structuredClone(before[x.id]);
        expected.weight=Number(entry.targetWeight); expected.details.answers.weight=entry.targetAnswer;
        assert.deepEqual(after,expected); assert.equal(await snapshot(x.id),entry.afterEvidence);
        for(const key of ['total_price','total_price_uah','price_per_gram','uah_rate','full_sku','public_product_identity_id','legacy_uah_price_unset'])
          assert.equal(JSON.stringify(after[key]),JSON.stringify(before[x.id][key]));
        const receipt=(await db.query('SELECT source_kind,target_answer,remote_evidence,source_answer,target_weight::text FROM product_weight_repair_receipts WHERE id=$1',[receipts[x.id]])).rows[0];
        assert.deepEqual(receipt,{source_kind:'magento_readback',target_answer:entry.targetAnswer,remote_evidence:entry.remoteEvidence,source_answer:entry.sourceAnswer,target_weight:entry.targetWeight});
        const audit=(await db.query("SELECT details FROM audit_events WHERE subject_type='canonical_weight_repair' AND subject_id=$1",[receipts[x.id]])).rows[0].details;
        assert.equal(audit.sourceKind,'magento_readback'); assert.deepEqual(audit.remoteEvidence,entry.remoteEvidence); assert.equal(audit.targetAnswer,entry.targetAnswer);
      }
      assert.equal((await db.query("SELECT details#>>'{answers,weight}' value FROM products WHERE id=$1",[stone.id])).rows[0].value,'46.3');
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_product_sync_requests')).rows[0].n,requests);
      assert.deepEqual(await lifecycle(),states,'The full-product revision and delivery state are not advanced');
      const calls=observed.length,retry=await apply(plan,chosen.map(x=>x.id)); assert.equal(retry.counts.already_applied,5);
      assert.equal(observed.length,calls,'Committed receipts are recovered without another Magento read');
      assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.canonical_weight_repaired'")).rows[0].n,5);
      await assert.rejects(db.query("UPDATE product_weight_repair_receipts SET remote_evidence='{}' WHERE id=$1",[receipts[absent.id]]),/CONTEXT|immutable/);
      // The repaired local weight now equals Magento: no MISSING_ONLY decision remains.
      assert.deepEqual(entryOf(await preview(),absent).reasonCodes,['CANONICAL_WEIGHT_NOT_ZERO','RECORDED_ANSWER_LANE']);
    });
    await t.test('the recorded-answer lane is unchanged and receipts its own source kind',async()=>{
      const recordedPlan=await service.preview(options),entry=entryOf(recordedPlan,recorded);
      assert.equal(recordedPlan.format,'sv-canonical-weight-repair-v1'); assert.equal(entry.eligible,true,JSON.stringify(entry)); assert.equal(entry.targetWeight,'123.000');
      assert.equal(entryOf(recordedPlan,absent).eligible,false); assert.equal(entryOf(recordedPlan,zero).eligible,false);
      const result=await apply(recordedPlan,[recorded.id]); assert.equal(result.counts.applied,1); receipts.recorded=result.outcomes[0].receiptId;
      assert.deepEqual((await db.query('SELECT source_kind,target_answer,remote_evidence FROM product_weight_repair_receipts WHERE id=$1',[receipts.recorded])).rows[0],
        {source_kind:'recorded_answer',target_answer:null,remote_evidence:null});
      assert.equal((await db.query("SELECT details->>'sourceKind' kind FROM audit_events WHERE subject_id=$1",[receipts.recorded])).rows[0].kind,'recorded_answer');
      const after=await row(recorded.id); assert.equal(after.weight,123); assert.equal(after.details.answers.weight,'123');
    });
    await t.test('a changed Magento value after review is stale before any lock or write',async()=>{
      const before=await snapshot(stale.id); remote.set(stale.id,'8.5');
      const result=await apply(plan,[stale.id]); assert.equal(result.counts.conflicted,1); assert.equal(result.outcomes[0].code,'SV_CANONICAL_WEIGHT_STALE');
      assert.equal(await snapshot(stale.id),before); remote.set(stale.id,'8');
      assert.equal((await db.query('SELECT count(*)::int n FROM product_weight_repair_receipts WHERE product_id=$1',[stale.id])).rows[0].n,0);
    });
    await t.test('forged receipts and product deltas are rejected by PostgreSQL',async()=>{
      const entry=entryOf(plan,forged),manifestText=service.verify(plan,plan.planHash,name,'readback-fixture');
      const attempt=async(mutate,write)=>{
        const id=crypto.randomUUID(),values={after:entry.afterEvidence,remote:JSON.stringify(entry.remoteEvidence),answer:JSON.stringify(entry.targetAnswer),...mutate};
        await db.query('BEGIN');
        try {
          await db.query("SELECT set_config('amber.canonical_weight_repair_plan',$1,TRUE),set_config('amber.canonical_weight_repair',$2,TRUE)",[plan.planHash,id]);
          await db.query('INSERT INTO product_weight_repair_plans(plan_hash,manifest_text,actor_user_id) VALUES($1,$2,$3) ON CONFLICT(plan_hash) DO NOTHING',[plan.planHash,manifestText,actor]);
          await db.query(`INSERT INTO product_weight_repair_receipts(id,plan_hash,product_id,actor_user_id,direction,before_state,after_state,source_answer,weight_question_id,target_weight,source_kind,target_answer,remote_evidence)
            VALUES($1,$2,$3,$4,'apply',$5::jsonb,$6::jsonb,'null',$7,$8,'magento_readback',$9::jsonb,$10::jsonb)`,[id,plan.planHash,forged.id,actor,entry.beforeEvidence,values.after,entry.weightQuestionId,entry.targetWeight,values.answer,values.remote]);
          if(write) await db.query(write,[forged.id]);
        } finally { await db.query('ROLLBACK'); }
      };
      const priced=JSON.parse(entry.afterEvidence); priced.product.total_price_uah=1;
      await assert.rejects(attempt({after:JSON.stringify(priced)}),/SV_WEIGHT_REPAIR_SOURCE/);
      await assert.rejects(attempt({remote:JSON.stringify({...entry.remoteEvidence,target:'weight'})}),/SV_WEIGHT_REPAIR_STALE/);
      await assert.rejects(attempt({answer:JSON.stringify('9.000')}),/SV_WEIGHT_REPAIR_STALE/);
      await assert.rejects(attempt({},`UPDATE products SET weight=9,details=jsonb_set(details,'{answers,weight}','"9"'),total_price_uah=1 WHERE id=$1`),/SV_WEIGHT_REPAIR_DELTA/);
      await assert.rejects(attempt({},`UPDATE products SET weight=9,details=jsonb_set(jsonb_set(details,'{answers,weight}','"9"'),'{manualPriceUah}','1') WHERE id=$1`),/SV_WEIGHT_REPAIR_DELTA/);
      await db.query('BEGIN'); await db.query("SELECT set_config('amber.canonical_weight_repair',$1,TRUE)",[crypto.randomUUID()]);
      await assert.rejects(db.query(`UPDATE products SET details=jsonb_set(details,'{answers,weight}','"9"') WHERE id=$1`,[forged.id]),/SV_WEIGHT_REPAIR_DELTA/);
      await db.query('ROLLBACK');
      assert.equal(entryOf(await preview(),forged).eligible,true);
    });
    await t.test('final audit failure rolls back product, receipt and plan atomically',async()=>{
      const fresh=await preview(),before=await snapshot(auditFailure.id);
      await db.query(`CREATE FUNCTION reject_readback_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_key='product.canonical_weight_repaired' THEN RAISE EXCEPTION 'FIXTURE_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_readback_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_readback_audit()`);
      try { const result=await apply(fresh,[auditFailure.id]); assert.equal(result.counts.failed,1); assert.equal(await snapshot(auditFailure.id),before);
        assert.equal((await db.query('SELECT count(*)::int n FROM product_weight_repair_receipts WHERE plan_hash=$1',[fresh.planHash])).rows[0].n,0);
        assert.equal((await db.query('SELECT count(*)::int n FROM product_weight_repair_plans WHERE plan_hash=$1',[fresh.planHash])).rows[0].n,0);
      } finally { await db.query('DROP TRIGGER reject_readback_audit ON audit_events; DROP FUNCTION reject_readback_audit()'); }
    });
    await t.test('simultaneous independent applies commit exactly one receipt',async()=>{
      const fresh=await preview();
      const results=await Promise.all([apply(fresh,[race.id]),apply(fresh,[race.id])]);
      assert.equal(results.reduce((n,r)=>n+r.counts.applied,0),1,JSON.stringify(results));
      assert.equal((await db.query('SELECT count(*)::int n FROM product_weight_repair_receipts WHERE product_id=$1',[race.id])).rows[0].n,1);
      assert.equal((await row(race.id)).details.answers.weight,'11');
    });
    await t.test('explicit inverse restores the exact absent, zero and JSON-null answers and zero weight',async()=>{
      const chosen=[absent,zero,jsonNull],originals=Object.fromEntries(chosen.map(x=>[x.id,JSON.parse(entryOf(plan,x).beforeEvidence).product]));
      const rollback=await service.preview({...options,rollbackReceiptIds:chosen.map(x=>receipts[x.id])});
      assert.equal(rollback.format,'sv-canonical-weight-magento-v1'); assert.equal(rollback.direction,'rollback');
      assert.ok(rollback.entries.every(e=>e.eligible),JSON.stringify(rollback.entries.map(e=>e.reasonCodes)));
      await assert.rejects(service.preview({...options,rollbackReceiptIds:[receipts[absent.id],receipts.recorded]}),{code:'SV_CANONICAL_WEIGHT_SCOPE_INVALID'});
      const calls=observed.length,result=await apply(rollback,chosen.map(x=>x.id)); assert.equal(result.counts.applied,3);
      assert.equal(observed.length,calls,'Rollback needs no Magento read');
      for(const x of chosen) {
        const current=await row(x.id); assert.deepEqual(current,originals[x.id]); assert.equal(await snapshot(x.id),entryOf(plan,x).beforeEvidence);
      }
      assert.equal(Object.hasOwn((await row(absent.id)).details.answers,'weight'),false);
      assert.equal((await row(zero.id)).details.answers.weight,'0'); assert.equal((await row(jsonNull.id)).details.answers.weight,null);
      const inverse=(await db.query("SELECT source_kind,target_weight::text,inverse_of FROM product_weight_repair_receipts WHERE inverse_of=$1",[receipts[zero.id]])).rows[0];
      assert.deepEqual(inverse,{source_kind:'magento_readback',target_weight:'0.000',inverse_of:receipts[zero.id]});
      assert.equal((await service.preview({...options,rollbackReceiptIds:[receipts[absent.id]]})).entries[0].eligible,false);
      assert.equal((await apply(plan,[absent.id])).counts.conflicted,1,'An old apply plan never silently reapplies after rollback');
    });
    assert.equal(external,0);
  } finally {
    global.fetch=oldFetch; if(pool)await pool.end(); if(db)await db.end();
    if(created)await control.query(`DROP DATABASE ${name}`); await control.end();
  }
});
