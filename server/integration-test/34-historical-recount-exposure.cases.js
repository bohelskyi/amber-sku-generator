const suite = require('./suite-context');
const service = require('../src/services/magento/historical-recount-exposure');
const recovery = require('../src/services/magento/lifecycle-recovery');
const { insertProductFixture } = require('./product-fixture');
for (const versionCount of [3,5]) suite.test(`historical recount exposure: ${versionCount}-version mixed chain, reviewed current UPDATE and immutable history`, async t => {
  const { assert, Pool, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = suite;
  const name='amber_historical_exposure_test',url=await recreateTestDatabase(name),db=new Pool({connectionString:url,options:'-c amber.lifecycle_writer_version=1'});
  try {
    await runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Historical test') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
    const {scenario,config,published,installationKey}=await require('./stable-recount-exposure-fixture')(db,actor);
    const s=await scenario(), chain=[];
    for (const sku of ['SV-LEGACY-A','SV-LEGACY-B'].slice(0,versionCount===3?1:2)) chain.push((await insertProductFixture(db,
      `INSERT INTO products(full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details)
       VALUES($1,$1,0,'BR',5,10,42,2,40,'{"answers":{}}') RETURNING *`,[sku])).rows[0]);
    chain.push((await db.query('SELECT * FROM products WHERE id=$1',[s.product.id])).rows[0]);
    const cutoverProductId=chain.at(-1).id;
    const conn=await db.connect();
    try {
      await conn.query('BEGIN');
      for (let i=0;i<chain.length-1;i++) {
        await conn.query("UPDATE products SET status='corrected',exclude_from_export=1,corrected_to_product_id=$2 WHERE id=$1",[chain[i].id,chain[i+1].id]);
        await conn.query('UPDATE products SET corrected_from_product_id=$2 WHERE id=$1',[chain[i+1].id,chain[i].id]);
        await conn.query('INSERT INTO product_corrections(source_product_id,corrected_product_id,source_sku,corrected_sku) VALUES($1,$2,$3,$4)',[chain[i].id,chain[i+1].id,chain[i].full_sku,chain[i+1].full_sku]);
      }
      // Exact migration-039 baseline: old pointers remain NULL forever.
      await conn.query(`UPDATE product_full_export_state SET route=CASE WHEN product_id=$2 THEN 'hold' ELSE 'retired' END,
        hold_reason=CASE WHEN product_id=$2 THEN 'historical_ambiguity' ELSE NULL END,business_exclusion_state='unknown',
        evidence='{"origin":"migration_039","coverage":"unresolved_historical"}',delivery_version=delivery_version+1 WHERE product_id=ANY($1::int[])`,[chain.map(p=>p.id),chain.at(-1).id]);
      await conn.query('UPDATE products SET exclude_from_export=1 WHERE id=$1',[chain.at(-1).id]);
      await conn.query('COMMIT');
      // Reproduce the actual canonical transition which replaces migration
      // provenance on the then-current legacy successor, followed by recount.
      const cutoverService=require('../src/services/full-product-cutover.service');
      const cutoverOptions={databasePool:db,expectedDatabase:name,mutationContext:{actorUserId:actor},deploymentEvidence:'Disposable historical recovery fixture'};
      await cutoverService.prepare(cutoverOptions);
      const index=await cutoverService.generate('index',cutoverOptions);
      await cutoverService.indexHistorical(index,index.contentSha256,cutoverOptions);
      const manifest=await cutoverService.generate('cutover',cutoverOptions);
      await cutoverService.approve(manifest,manifest.contentSha256,'Reviewed disposable historical fixture',cutoverOptions);
      await cutoverService.applyBatch(manifest.contentSha256,0,cutoverOptions);
      await cutoverService.activate(manifest.contentSha256,cutoverOptions);
      await conn.query('BEGIN');
      const event=async key=>(await conn.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
        VALUES($1,$2,'{"displayName":"Historical test","preferredUsername":null}','fixture','singleton',$1) RETURNING id`,[key,actor])).rows[0].id;
      const activation=await event('public_sku.activated'),cutover=await event('magento_delivery.cutover');
      await conn.query("SET LOCAL amber.public_sku_activation='on'; SET LOCAL amber.magento_delivery_cutover='on'");
      await conn.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton',[actor,activation]);
      await conn.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,
        legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton`,[installationKey,actor,cutover]);
      for (const sku of ['SV11501001','SV11501001-001'].slice(0,versionCount===3?1:2)) {
        const prev=chain.at(-1),p=(await conn.query(`INSERT INTO products(full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details,corrected_from_product_id)
          SELECT $2,$2,1,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details,id FROM products WHERE id=$1 RETURNING *`,[prev.id,sku])).rows[0];
        await conn.query("UPDATE products SET status='corrected',corrected_to_product_id=$2,exclude_from_export=1 WHERE id=$1",[prev.id,p.id]);
        const correction=(await conn.query('INSERT INTO product_corrections(source_product_id,corrected_product_id,source_sku,corrected_sku) VALUES($1,$2,$3,$4) RETURNING id',[prev.id,p.id,prev.full_sku,p.full_sku])).rows[0];
        await conn.query("UPDATE product_full_export_state SET route='retired',hold_reason=NULL,delivery_version=delivery_version+1 WHERE product_id=$1",[prev.id]);
        await conn.query(`INSERT INTO product_full_export_state(product_id,route,hold_reason,source_correction_id,business_exclusion_state,evidence,csv_retired_revision)
          VALUES($1,'hold','historical_ambiguity',$2,'none','{"origin":"recount","classification":"historical_ambiguous"}',1)`,[p.id,correction.id]);
        chain.push(p);
      }
      await conn.query('COMMIT');
    } finally {await conn.query('ROLLBACK');conn.release();}
    const current=chain.at(-1); let oldPresent=false,oldFailure=false,reads=0;
    const fetchImpl=async(url,init)=>{
      assert.equal(init.method,'GET','review/apply has no Magento writes');reads++;
      const u=new URL(url),sku=u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]');
      if(u.pathname.endsWith('/products') && sku!==s.input.sku) {
        if(oldFailure) throw new Error('synthetic old article lookup unavailable');
        return new Response(JSON.stringify({items:oldPresent?[{id:900000,sku}]:[],total_count:oldPresent?1:0}),{headers:{'content-type':'application/json'}});
      }
      return s.options.fetchImpl(url,init);
    };
    const options={...s.options,fetchImpl,databasePool:db,expectedDatabase:name,bindingRevisionId:published.id,mutationContext:{actorUserId:actor}};
    const state=async()=>(await db.query(`SELECT
      (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,(SELECT jsonb_agg(c ORDER BY id) FROM product_corrections c) corrections,
      (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) lifecycle,(SELECT jsonb_agg(r ORDER BY full_sku) FROM sku_registry r) registry,
      (SELECT jsonb_agg(s ORDER BY id) FROM export_snapshots s) snapshots,(SELECT jsonb_agg(m ORDER BY snapshot_id,product_id) FROM export_snapshot_products m) memberships,
      (SELECT jsonb_agg(r ORDER BY product_id) FROM magento_product_sync_requests r) requests,
      (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM magento_binding_handoffs) handoffs`)).rows[0];
    let review;
    const evidence={files:[],confirmation:{disposition:'current_update_only',evidence:'Old versions retired; no outstanding file imports or independent exclusion of current product'}};
    const apply=()=>recovery.apply(config,current.id,{review:review.review,reviewHash:review.reviewHash,reason:'Reviewed current product only',evidence},options);
    await t.test('read-only guided preview selects historical recipe and preserves all versions',async()=>{
      const before=await state(),record=await recovery.productRecovery(config,current.id,{...options,canReconcileLifecycle:true});
      assert.deepEqual(record.lifecycle.availableKinds,['historical_recount_exposure']);
      assert.equal(record.history.stableRecount,false);assert.equal(record.history.historicalRecount,true);
      assert.deepEqual(record.lifecycle.unavailableReasons,[]);
      assert.equal(record.history.products.length,versionCount);
      const baseline=record.history.products.find(p=>p.productId===cutoverProductId);
      assert.equal(baseline.lifecycleOrigin,'cutover');assert.equal(baseline.lifecycleCoverage,null);
      assert.ok(baseline.cutoverBaseline?.batchEventId);
      review=await recovery.preview(config,current.id,{kind:'historical_recount_exposure'},options);
      assert.equal(review.eligible,true,JSON.stringify(review));assert.equal(review.review.payload.sync.remote.id,s.remote().id);
      assert.ok(review.review.payload.sync.oldArticles.every(r=>r.status==='not_found'));
      assert.equal(review.review.payload.historical.cutoverBaselines.length,1);
      assert.deepEqual(await state(),before);assert.equal(s.writes.length,0);
      assert.equal((await require('../src/services/magento/stable-recount-exposure').preview(config,s.input.sku,options)).eligible,false);
    });
    await t.test('an origin label without the exact applied receipt explains the unavailable action and performs no remote reads',async()=>{
      const id=cutoverProductId,original=(await db.query('SELECT repair_manifest_hash FROM product_full_export_state WHERE product_id=$1',[id])).rows[0].repair_manifest_hash;
      try {
        await db.query('UPDATE product_full_export_state SET repair_manifest_hash=$2,delivery_version=delivery_version+1 WHERE product_id=$1',[id,'f'.repeat(64)]);
        const before=await state(),count=reads,record=await recovery.productRecovery(config,current.id,{...options,canReconcileLifecycle:true});
        assert.deepEqual(record.lifecycle.availableKinds,[]);
        assert.ok(record.lifecycle.unavailableReasons.includes('CUTOVER_BASELINE_UNVERIFIED'));
        const denied=await recovery.preview(config,current.id,{kind:'historical_recount_exposure'},options);
        assert.equal(denied.eligible,false);assert.ok(denied.blockers.includes('CUTOVER_BASELINE_UNVERIFIED'));
        assert.equal(reads,count);assert.deepEqual(await state(),before);
      } finally {await db.query('UPDATE product_full_export_state SET repair_manifest_hash=$2,delivery_version=delivery_version+1 WHERE product_id=$1',[id,original]);}
      review=await recovery.preview(config,current.id,{kind:'historical_recount_exposure'},options);
    });
    await t.test('missing attestations, actor revocation and a present/unreadable old article fail closed',async()=>{
      const before=await state(),plan=review.review.payload;
      await assert.rejects(service.apply(config,plan,plan.planHash,options));
      await assert.rejects(applyWithActor(999999),{code:'ADMIN_PERMISSION_REVOKED'});
      oldPresent=true;assert.ok((await service.preview(config,s.input.sku,options)).blockers.includes('HISTORICAL_ARTICLE_STILL_PRESENT'));
      await assert.rejects(apply(),{code:'EXPOSURE_REMOTE_CHANGED'});oldPresent=false;
      oldFailure=true;assert.ok((await service.preview(config,s.input.sku,options)).blockers.includes('MAGENTO_LOOKUP_ERROR'));
      await assert.rejects(apply(),{code:'EXPOSURE_REMOTE_CHANGED'});oldFailure=false;
      assert.deepEqual(await state(),before);
    });
    function applyWithActor(id){return service.apply(config,review.review.payload,review.review.payload.planHash,{...options,mutationContext:{actorUserId:id},reviewedEvidence:evidence,reason:'Reviewed current product only'});}
    await t.test('a busy former identity or article blocks before authority/product locks and releases all acquired lanes',async()=>{
      const holder=await db.connect(),identity=chain[0].public_product_identity_id;
      const origin=require('../src/services/magento/binding-contract').originHash(config.baseUrl);
      try {
        for(const key of [`amber_magento_public_identity:${identity}`,`amber_magento_sync:${origin}:${chain[0].full_sku}`]) {
          await holder.query('SELECT pg_advisory_lock(hashtext($1))',[key]);
          const before=await state();await assert.rejects(apply(),{code:'EXPOSURE_SYNC_BUSY'});assert.deepEqual(await state(),before);
          await holder.query('SELECT pg_advisory_unlock(hashtext($1))',[key]);
        }
      } finally {await holder.query('SELECT pg_advisory_unlock_all()');holder.release();}
    });
    await t.test('independent ancestor writer wins while apply waits; stale evidence is rejected before Magento reads',async()=>{
      const holder=await db.connect(),writer=new Pool({connectionString:url,max:1});let pending;
      try {
        const pid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await holder.query('BEGIN');await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[cutoverProductId]);
        const count=reads;pending=service.apply(config,review.review.payload,review.review.payload.planHash,{...options,databasePool:writer,reviewedEvidence:evidence,reason:'Reviewed current product only'});
        let blocked=false;
        for(let attempt=0;attempt<100;attempt++) {
          blocked=(await db.query("SELECT wait_event_type='Lock' blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked;
          if(blocked)break;await new Promise(resolve=>setTimeout(resolve,25));
        }
        assert.equal(blocked,true,'independent apply must actually wait on the locked ancestor');
        await holder.query("UPDATE product_full_export_state SET business_exclusion_state='excluded',delivery_version=delivery_version+1 WHERE product_id=$1",[cutoverProductId]);
        await holder.query('COMMIT');await assert.rejects(pending,{code:'EXPOSURE_RECONCILIATION_CONFLICT'});assert.equal(reads,count);
      } finally {await holder.query('ROLLBACK');holder.release();if(pending)await pending.catch(()=>{});await writer.end();}
      await db.query("UPDATE product_full_export_state SET business_exclusion_state='unknown',delivery_version=delivery_version+1 WHERE product_id=$1",[cutoverProductId]);
      review=await recovery.preview(config,current.id,{kind:'historical_recount_exposure'},options);
    });
    await t.test('audit failure rolls back lifecycle and enrollment atomically',async()=>{
      const before=await state(),failing={connect:async()=>{const client=await db.connect();return{release:()=>client.release(),query:(sql,args)=>{
        if(/INSERT INTO audit_events/.test(sql))throw new Error('synthetic audit failure');return client.query(sql,args);}};}};
      await assert.rejects(service.apply(config,review.review.payload,review.review.payload.planHash,{...options,databasePool:failing,reviewedEvidence:evidence,reason:'Reviewed current product only'}),/synthetic audit failure/);
      assert.deepEqual(await state(),before);
    });
    await t.test('a newly retained old file invalidates the preview and requires its exact explicit disposition',async()=>{
      const snapshotId=suite.crypto.randomUUID(),old=chain[0];
      await db.query(`INSERT INTO export_snapshots(id,idempotency_key,from_sku,resolved_to_sku,exported_to_product_id,row_count,file_name,csv_content)
        VALUES($1,$1,$2,$2,$3,1,'historical.csv',$4)`,[snapshotId,old.full_sku,old.id,`sku,price_uah\r\n${old.full_sku},42\r\n`]);
      const before=await state();await assert.rejects(apply(),{code:'EXPOSURE_RECONCILIATION_CONFLICT'});
      review=await recovery.preview(config,current.id,{kind:'historical_recount_exposure'},options);
      assert.equal(review.eligible,true,JSON.stringify(review));assert.deepEqual(review.requiredEvidence.files,[snapshotId]);
      await assert.rejects(apply(),{code:'RECONCILIATION_UNRESOLVED'});assert.deepEqual(await state(),before);
      evidence.files.push({snapshotId,disposition:'quarantined_do_not_import',evidence:'Old downloaded file removed from all pending import workflows'});
    });
    await t.test('explicit apply only resolves current exposure, with one handoff and immutable idempotent receipt',async()=>{
      const before=await state(),result=await apply(),after=await state();
      assert.equal(result.nextAction.kind,'await_delivery');
      for(const key of ['products','corrections','registry','requests','snapshots','memberships'])assert.deepEqual(after[key],before[key],key);
      assert.deepEqual(after.lifecycle.filter(f=>f.product_id!==current.id),before.lifecycle.filter(f=>f.product_id!==current.id));
      const prev=before.lifecycle.find(f=>f.product_id===current.id),next=after.lifecycle.find(f=>f.product_id===current.id);
      for(const key of ['revision','confirmed_revision','csv_retired_revision','source_correction_id','business_exclusion_state','recount_compatibility_excluded'])assert.equal(next[key],prev[key],key);
      assert.equal(next.hold_reason,'prior_exposure');assert.equal(next.route,'hold');assert.equal(BigInt(next.delivery_version),BigInt(prev.delivery_version)+1n);
      const count=reads;assert.equal((await apply()).alreadyApplied,true);assert.equal(reads,count);assert.deepEqual(await state(),after);
      await assert.rejects(service.apply(config,review.review.payload,review.review.payload.planHash,{...options,reviewedEvidence:evidence,reason:'Changed reason'}),{code:'RECONCILIATION_KEY_CONFLICT'});
      assert.equal(s.writes.length,0);assert.equal(Number(after.handoffs),Number(before.handoffs)+1);
      await require('../src/services/magento/binding-handoff').processHandoffs(config,{databasePool:db});
      const request=(await db.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[current.public_product_identity_id])).rows[0];
      assert.equal(request.product_id,current.id);assert.equal(request.state,'pending');
      const remoteId=s.remote().id;
      await require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(config,{databasePool:db,jobOptions:s.options}).runProduct(current.public_product_identity_id);
      assert.equal(s.remote().id,remoteId);assert.equal(s.remote().sku,s.input.sku);assert.equal(s.remote().name,'Amber name');
    });
  } finally {await db.end();await dropTestDatabase(name);}
});
