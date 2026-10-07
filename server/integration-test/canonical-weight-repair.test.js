const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {Client}=require('pg');
test('072 reviewed canonical weight repair preserves pricing, history and delivery with stale/race/retry/inverse guards',async t=>{
  const source=new URL(process.env.TEST_DATABASE_URL);
  assert.equal(source.hostname,'127.0.0.1'); assert.equal(source.port,'55432'); assert.ok(source.pathname.endsWith('_test'));
  const name=`amber_canonical_weight_${process.pid}_test`,control=new Client({connectionString:source.toString()});
  await control.connect(); let db,pool,created=false,external=0;
  const oldFetch=global.fetch; global.fetch=async()=>{external++;throw new Error('WEIGHT_EXTERNAL_FETCH_FORBIDDEN');};
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1',[name])).rows[0].n,0);
    await control.query(`CREATE DATABASE ${name}`); created=true;
    const target=new URL(source); target.pathname=`/${name}`;
    process.env.DATABASE_URL=target.toString(); process.env.MAGENTO_BASE_URL=''; process.env.NBU_RATE_OVERRIDE='40';
    require('../test/setup-env'); pool=require('../src/db/pool'); db=new Client({connectionString:target.toString()}); await db.connect();
    const directory=path.resolve(__dirname,'../migrations'),runner=require('../src/db/run-migrations');
    const migration=await fs.readFile(path.join(directory,'072_reviewed_canonical_weight_repair.sql'),'utf8');
    await t.test('071 checkpoint rolls back all 072 DDL, then normal startup applies and repeats with immutable checksums',async()=>{
      await db.query('CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,checksum TEXT,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');
      for(const file of (await fs.readdir(directory)).filter(file=>file.endsWith('.sql')&&file<'072_').sort()) {
        const sql=await fs.readFile(path.join(directory,file),'utf8');
        await db.query('BEGIN'); await db.query(sql);
        await db.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[file,runner.getMigrationChecksum(sql)]); await db.query('COMMIT');
      }
      const before=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
      await db.query('BEGIN');
      try { await db.query(migration); }
      catch (cause) { cause.message += ` [072 SQL position ${cause.position || cause.internalPosition || '?'}: ${(cause.internalQuery || migration).slice(Math.max(0,Number(cause.position || cause.internalPosition || 1)-140),Number(cause.position || cause.internalPosition || 1)+140)}]`; throw cause; }
      finally { await db.query('ROLLBACK'); }
      assert.equal((await db.query("SELECT to_regclass('product_weight_repair_receipts') name")).rows[0].name,null);
      assert.equal((await db.query("SELECT to_regprocedure('sv_weight_repair_state(integer)') name")).rows[0].name,null);
      assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,before);
      const missingActor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Guard absent fixture') RETURNING id")).rows[0].id);
      await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[missingActor]);
      await assert.rejects(require('../src/services/canonical-weight-repair').preview({databasePool:pool,expectedDatabase:name,
        installationKey:'canonical-weight',bindingRevisionId:'11111111-1111-4111-8111-111111111111',
        config:{configured:true,baseUrl:'https://canonical-weight.invalid'},mutationContext:{actorUserId:missingActor}}),{code:'SV_CANONICAL_WEIGHT_GUARD_NOT_INSTALLED'});
      await runner.runMigrations(); await runner.runMigrations();
      assert.equal((await db.query("SELECT checksum FROM schema_migrations WHERE name='072_reviewed_canonical_weight_repair.sql'")).rows[0].checksum,runner.getMigrationChecksum(migration));
      assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name<'072_' ORDER BY name")).rows,before);
      assert.equal((await db.query('SELECT count(*)::int n FROM product_weight_repair_receipts')).rows[0].n,0);
    });
    assert.ok((await db.query("SELECT to_regclass('product_weight_repair_receipts') name")).rows[0].name,'Checkpoint fixture must install 072 before domain tests');
    const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Canonical weight fixture') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
    const actorOptions={databasePool:pool,mutationContext:{actorUserId:actor}};
    await db.query("INSERT INTO categories(code,name,requires_weight,sku_publication_mode) VALUES('SV','Souvenirs',0,'explicit')");
    const souvenir=(await db.query("INSERT INTO questions(category_code,key,label,sku_index,include_in_sku,required,input_type) VALUES('SV','souvenir','Souvenir',1,1,1,'options') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,5,'5','Stone')",[souvenir]);
    const question=(await db.query(`INSERT INTO questions(category_code,key,label,sku_index,include_in_sku,required,input_type,numeric_validation)
      VALUES('SV','weight','Weight',2,0,1,'text','{"kind":"decimal","unit":"g","min":0,"max":1000000,"minInclusive":false,"maxInclusive":true,"maxFractionDigits":3}') RETURNING id`)).rows[0].id;
    const schema=await require('../src/services/sku-schema.service').publishSkuSchema('SV',actorOptions);
    let sequence=0;
    async function product(answer,weight=0) {
      const index=++sequence; await db.query('BEGIN');
      const row=(await db.query(`INSERT INTO products(full_sku,base_sku,sequence_number,category,weight,total_price_uah,details,sku_schema_version_id,created_by_user_id)
        VALUES($1,'SV5',$2,'SV',$3,123.45,$4::jsonb,$5,$6) RETURNING *`,
      [`SV5-${String(index).padStart(6,'0')}`,index,weight,JSON.stringify({answers:{souvenir:5,weight:answer},manualPriceUah:123.45}),schema.id,actor])).rows[0];
      await require('../src/services/full-product-export.service').initializeNewProduct(db,row.id);
      await db.query('INSERT INTO product_export_revisions(product_id,revision,confirmed_revision) VALUES($1,3,1)',[row.id]);
      await db.query('COMMIT'); return row;
    }
    const base=await product('25.5'),comma=await product(' +25,500 '),numeric=await product(12.345),nonzero=await product('25.5',10);
    const precise=await product('29.5'); await db.query('UPDATE products SET total_price_uah=$2::numeric WHERE id=$1',[precise.id,'1234567890123456.78']);
    const invalid=[];
    for(const value of ['25 g','1e2','-1','0','','1.2345','100000000000','1000001',null,true,{}]) invalid.push(await product(value));
    const reserve=await product('33.3'),history=await product('16.3'),pending=await product('20.5'),stale=await product('21.5'),auditFailure=await product('22.5'),race=await product('23.5');
    const missingAudit=await product('24.5'),sideEffect=await product('26.5'),normal=await product('27.5'),configDrift=await product('28.5');
    await db.query('UPDATE sku_registry SET first_product_id=$2 WHERE full_sku=$1',[reserve.full_sku,base.id]);
    await db.query('UPDATE products SET corrected_from_product_id=$2 WHERE id=$1',[history.id,nonzero.id]);
    const content=Buffer.alloc(32,1),photo=crypto.randomUUID();
    await db.query(`INSERT INTO product_photo_assets(id,actor_user_id,request_key,content_hash,mime_type,display_name,content,product_id)
      VALUES($1,$2,$3,$4,'image/png','Original fixture',$5,$6)`,[photo,actor,crypto.randomUUID(),crypto.createHash('sha256').update(content).digest('hex'),content,base.id]);
    await db.query('INSERT INTO product_photo_sets(product_id,version,photo_ids,enable_when_verified) VALUES($1,1,$2,FALSE)',[base.id,[photo]]);
    const fixture=require('../test/fixtures/magento-v4'),definition=fixture.definition(['SV']);
    delete definition.sources.color; delete definition.sources.note; definition.questionContracts={}; definition.tables={};
    const templates=require('../src/services/export-templates/template.service');
    const family=await templates.createTemplate({key:'canonical-weight',displayName:'Canonical weight fixture',definition},actorOptions);
    const version=await templates.publishTemplate(family.id,{expectedRevision:family.draft.revision,expectedDefinitionHash:family.draft.definitionHash},actorOptions);
    const config={configured:true,baseUrl:'https://canonical-weight.invalid',consumerKey:'fixture',consumerSecret:'fixture',accessToken:'fixture',accessTokenSecret:'fixture'};
    const bindings=require('../src/services/magento/binding.service'),observation=fixture.observation();
    let binding=await bindings.createDraft({installationKey:'canonical-weight',origin:config.baseUrl,templateVersionId:version.id,observedAt:new Date().toISOString(),schema:observation},actorOptions);
    binding=await bindings.updateDraft(binding.id,{expectedRevision:binding.revision,bindings:fixture.approvedBindings(definition,observation)},actorOptions);
    binding=await bindings.publishDraft(binding.id,{expectedRevision:binding.revision,expectedCurrentId:null},actorOptions);
    await db.query("UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='canonical-weight',actor_user_id=$1 WHERE singleton",[actor]);
    await db.query('INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id) VALUES($1,$2)',[pending.public_product_identity_id,pending.id]);
    const options={...actorOptions,config,expectedDatabase:name,installationKey:'canonical-weight',bindingRevisionId:binding.id};
    const service=require('../src/services/canonical-weight-repair');
    const snapshot=async id=>(await db.query('SELECT sv_weight_repair_state($1)::text value',[id])).rows[0].value;
    const apply=async(plan,ids,extra={})=>service.apply(plan,{...options,expectedHash:plan.planHash,productIds:ids,...extra});
    await t.test('preview is read-only; exact decimals are eligible while nonzero, invalid, history, identity and pending work are excluded',async()=>{
      const before=await snapshot(base.id),plan=await service.preview(options);
      for(const row of [base,comma,numeric,precise]) assert.equal(plan.entries.find(e=>e.productId===row.id).eligible,true);
      for(const row of [nonzero,reserve,history,pending,...invalid]) assert.equal(plan.entries.find(e=>e.productId===row.id).eligible,false,row.full_sku);
      assert.equal(plan.entries.find(e=>e.productId===comma.id).targetWeight,'25.500');
      const direct=await require('../src/services/magento/sync-preview-db').readPreviewProductOnClient(db,{productId:precise.id,bindingRevisionId:binding.id});
      const actual=require('../src/services/magento/binding-evidence-products').evaluate(direct,direct.product);
      assert.equal(actual.base.price,'1234567890123456.78');
      assert.equal(plan.entries.find(e=>e.productId===precise.id).publishedResultHash,require('../src/services/magento/binding-contract').hash(actual));
      assert.equal(await snapshot(base.id),before);
      assert.equal((await db.query('SELECT count(*)::int n FROM product_weight_repair_plans')).rows[0].n,0);
      await assert.rejects(apply(plan,[nonzero.id]),{code:'SV_CANONICAL_WEIGHT_SCOPE_INVALID'});
    });
    let original;
    await t.test('exact mass copy preserves answers, originals, prices, lifecycle and every delivery record; retries produce one audited receipt',async()=>{
      const plan=await service.preview(options),chosen=[base.id,comma.id,numeric.id,precise.id];
      const result=await apply(plan,chosen); assert.equal(result.counts.applied,4); assert.equal(result.counts.failed,0);
      original=result.outcomes.find(e=>e.productId===base.id).receiptId;
      for(const id of chosen) assert.equal(await snapshot(id),plan.entries.find(e=>e.productId===id).afterEvidence);
      assert.deepEqual((await db.query('SELECT content FROM product_photo_assets WHERE id=$1',[photo])).rows[0].content,content);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_product_sync_requests WHERE product_id=ANY($1::int[])',[chosen])).rows[0].n,0);
      const retry=await apply(plan,chosen); assert.equal(retry.counts.already_applied,4);
      assert.equal((await db.query('SELECT count(*)::int n FROM product_weight_repair_receipts WHERE plan_hash=$1',[plan.planHash])).rows[0].n,4);
      assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.canonical_weight_repaired'")).rows[0].n,4);
      await assert.rejects(db.query("UPDATE product_weight_repair_receipts SET target_weight=1 WHERE id=$1",[original]),/CONTEXT|immutable/);
      await assert.rejects(db.query('DELETE FROM product_weight_repair_plans WHERE plan_hash=$1',[plan.planHash]),/permanent/);
      const preciseReceipt=result.outcomes.find(e=>e.productId===precise.id).receiptId;
      const inverse=await service.preview({...options,rollbackReceiptIds:[preciseReceipt]});
      assert.equal((await apply(inverse,[precise.id])).counts.applied,1);
      const oldRetry=await apply(plan,[precise.id]); assert.equal(oldRetry.counts.conflicted,1);
      assert.equal(oldRetry.outcomes[0].code,'SV_CANONICAL_WEIGHT_RECEIPT_STALE');
      assert.equal((await db.query('SELECT weight::text,total_price_uah::text FROM products WHERE id=$1',[precise.id])).rows[0].total_price_uah,'1234567890123456.78');
    });
    await t.test('ordinary writes still create requests and a forged repair context cannot bypass the normal trigger',async()=>{
      const before=await snapshot(missingAudit.id);
      await db.query('BEGIN'); await db.query("SELECT set_config('amber.canonical_weight_repair',$1,TRUE)",[crypto.randomUUID()]);
      await assert.rejects(db.query('UPDATE products SET weight=24.5 WHERE id=$1',[missingAudit.id]),/SV_WEIGHT_REPAIR_DELTA/);
      await db.query('ROLLBACK'); assert.equal(await snapshot(missingAudit.id),before);
      await db.query('UPDATE products SET weight=27.5 WHERE id=$1',[normal.id]);
      assert.equal((await db.query('SELECT state,desired_generation FROM magento_product_sync_requests WHERE product_id=$1',[normal.id])).rows[0].state,'pending');
    });
    await t.test('committed independent drift is rejected after waiting for the actual product lock',async()=>{
      const plan=await service.preview(options),writer=new Client({connectionString:target.toString()}); await writer.connect();
      try {
        await writer.query('BEGIN'); await writer.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[stale.id]);
        await writer.query("UPDATE products SET correction_reason='Independent committed change' WHERE id=$1",[stale.id]);
        const attempt=apply(plan,[stale.id]);
        for(let i=0;i<100;i++) {
          if((await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM products%'")).rows[0].n) break;
          if(i===99) assert.fail('Repair did not contend on actual product lock');
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        await writer.query('COMMIT'); const result=await attempt; assert.equal(result.counts.conflicted,1);
        assert.equal((await db.query('SELECT weight::text FROM products WHERE id=$1',[stale.id])).rows[0].weight,'0.000');
      } finally { await writer.query('ROLLBACK'); await writer.end(); }
    });
    await t.test('final audit failure rolls back product, receipt and plan atomically',async()=>{
      const plan=await service.preview(options),before=await snapshot(auditFailure.id);
      await db.query(`CREATE FUNCTION reject_weight_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_key='product.canonical_weight_repaired' THEN RAISE EXCEPTION 'FIXTURE_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_weight_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_weight_audit()`);
      try { const result=await apply(plan,[auditFailure.id]); assert.equal(result.counts.failed,1); assert.equal(await snapshot(auditFailure.id),before);
        assert.equal((await db.query('SELECT count(*)::int n FROM product_weight_repair_receipts WHERE plan_hash=$1',[plan.planHash])).rows[0].n,0);
        assert.equal((await db.query('SELECT count(*)::int n FROM product_weight_repair_plans WHERE plan_hash=$1',[plan.planHash])).rows[0].n,0);
      } finally { await db.query('DROP TRIGGER reject_weight_audit ON audit_events; DROP FUNCTION reject_weight_audit()'); }
    });
    await t.test('an audit-time lifecycle side effect is caught by the deferred completion fence and rolled back',async()=>{
      const plan=await service.preview(options),before=await snapshot(sideEffect.id);
      await db.query(`CREATE FUNCTION weight_audit_side_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_key='product.canonical_weight_repaired' THEN UPDATE product_full_export_state SET revision=revision+1 WHERE product_id=(NEW.details->>'productId')::int; END IF; RETURN NEW; END $$;
        CREATE TRIGGER weight_audit_side_effect BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION weight_audit_side_effect()`);
      try { const result=await apply(plan,[sideEffect.id]); assert.equal(result.counts.failed,1); assert.equal(await snapshot(sideEffect.id),before); }
      finally { await db.query('DROP TRIGGER weight_audit_side_effect ON audit_events; DROP FUNCTION weight_audit_side_effect()'); }
    });
    await t.test('simultaneous writers never repeat the repair; a lost disk checkpoint recovers from the committed PostgreSQL receipt',async()=>{
      const plan=await service.preview(options);
      const results=await Promise.all([apply(plan,[race.id]),apply(plan,[race.id])]);
      assert.equal(results.reduce((n,r)=>n+r.counts.applied,0),1);
      assert.equal((await db.query('SELECT count(*)::int n FROM product_weight_repair_receipts WHERE product_id=$1',[race.id])).rows[0].n,1);
      const fresh=await service.preview(options);
      await assert.rejects(apply(fresh,[missingAudit.id],{checkpoint:async()=>{throw new Error('LOST_DISK_CHECKPOINT');}}),/LOST_DISK_CHECKPOINT/);
      const retry=await apply(fresh,[missingAudit.id]); assert.equal(retry.counts.already_applied,1);
    });
    await t.test('configuration drift and revoked actors stop the reviewed operation before a write',async()=>{
      const plan=await service.preview(options),before=await snapshot(configDrift.id);
      await db.query("UPDATE categories SET name='Changed configuration' WHERE code='SV'");
      const changed=await apply(plan,[configDrift.id]); assert.equal(changed.counts.conflicted,1); assert.equal(await snapshot(configDrift.id),before);
      const fresh=await service.preview(options); await db.query("UPDATE application_users SET status='disabled' WHERE id=$1",[actor]);
      const revoked=await apply(fresh,[configDrift.id]); assert.equal(revoked.counts.failed,1); assert.equal(await snapshot(configDrift.id),before);
      await db.query("UPDATE application_users SET status='active' WHERE id=$1",[actor]);
    });
    await t.test('explicit inverse restores only exact post-repair evidence and preserves both immutable audited receipts',async()=>{
      const rollback=await service.preview({...options,rollbackReceiptIds:[original]});
      assert.equal(rollback.entries[0].eligible,true);
      const result=await apply(rollback,[base.id]); assert.equal(result.counts.applied,1);
      assert.equal(await snapshot(base.id),rollback.entries[0].afterEvidence);
      assert.equal((await db.query('SELECT state FROM product_weight_repair_receipts WHERE id=$1',[original])).rows[0].state,'applied');
      assert.equal((await db.query('SELECT count(*)::int n FROM product_weight_repair_receipts WHERE inverse_of=$1',[original])).rows[0].n,1);
      assert.equal((await apply(rollback,[base.id])).counts.already_applied,1);
      assert.equal((await service.preview({...options,rollbackReceiptIds:[original]})).entries[0].eligible,false);
      const receipt=(await db.query("SELECT id FROM product_weight_repair_receipts WHERE product_id=$1 AND direction='apply'",[numeric.id])).rows[0].id;
      const freshInverse=await service.preview({...options,rollbackReceiptIds:[receipt]});
      assert.equal(freshInverse.entries[0].eligible,true);
      await db.query("UPDATE products SET correction_reason='Later legitimate edit' WHERE id=$1",[numeric.id]);
      const rejected=await apply(freshInverse,[numeric.id]); assert.equal(rejected.counts.conflicted,1);
      assert.equal((await db.query('SELECT weight::text FROM products WHERE id=$1',[numeric.id])).rows[0].weight,'12.345');
      assert.equal((await service.preview({...options,rollbackReceiptIds:[receipt]})).entries[0].eligible,false);
    });
    await t.test('a published template that consumes canonical weight refuses the bookkeeping exception when its result changes',async()=>{
      const physical=structuredClone(definition);
      physical.sources.physical={kind:'product',field:'weight',type:'scalar'};
      for(const row of physical.groups[0].rows) row.cells.price={op:'text',input:{op:'source',id:'physical'},trim:false,format:'scalar-v1',onAbsent:'empty'};
      const nextFamily=await templates.createTemplate({key:'canonical-weight-physical',displayName:'Physical output fixture',definition:physical},actorOptions);
      const nextVersion=await templates.publishTemplate(nextFamily.id,{expectedRevision:nextFamily.draft.revision,expectedDefinitionHash:nextFamily.draft.definitionHash},actorOptions);
      let next=await bindings.createDraft({installationKey:'canonical-weight',origin:config.baseUrl,templateVersionId:nextVersion.id,observedAt:new Date().toISOString(),schema:observation},actorOptions);
      next=await bindings.updateDraft(next.id,{expectedRevision:next.revision,bindings:fixture.approvedBindings(physical,observation)},actorOptions);
      next=await bindings.publishDraft(next.id,{expectedRevision:next.revision,expectedCurrentId:binding.id},actorOptions);
      const before=await snapshot(sideEffect.id);
      await assert.rejects(service.comparePublished(db,sideEffect.id,next.id,before,'26.500'),{code:'SV_CANONICAL_WEIGHT_PUBLISHED_RESULT_CHANGED'});
      const review=await service.preview({...options,bindingRevisionId:next.id});
      assert.ok(review.entries.find(e=>e.productId===sideEffect.id).reasonCodes.includes('PUBLISHED_RESULT_CHANGED'));
      assert.equal(await snapshot(sideEffect.id),before);
    });
    assert.equal(external,0);
  } finally {
    global.fetch=oldFetch; if(pool)await pool.end(); if(db)await db.end();
    if(created)await control.query(`DROP DATABASE ${name}`); await control.end();
  }
});
