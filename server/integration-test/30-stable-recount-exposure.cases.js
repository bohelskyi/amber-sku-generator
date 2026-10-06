const suite = require('./suite-context');
const service = require('../src/services/magento/stable-recount-exposure');
const ordinary = require('../src/services/magento/exposure-reconciliation');
suite.test('stable recount exposure: reviewed UPDATE, atomic handoff and fail-closed evidence', async t => {
  const { assert, Pool, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = suite;
  const name = 'amber_stable_exposure_test', url = await recreateTestDatabase(name);
  const db = new Pool({ connectionString: url });
  try {
    await require('./historical-runtime-fixture')(suite,url);
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Exposure test') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
    const { scenario,config,published,installationKey } = await require('./stable-recount-exposure-fixture')(db,actor);
    const s = await scenario(), sourceId = s.product.id;
    const conn = await db.connect(); let product;
    try {
      await conn.query('BEGIN');
      const event = async key => (await conn.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
        VALUES($1,$2,'{"displayName":"Exposure test","preferredUsername":null}','fixture','singleton',$1) RETURNING id`,[key,actor])).rows[0].id;
      const activationEvent = await event('public_sku.activated'), cutoverEvent = await event('magento_delivery.cutover');
      await conn.query("SET LOCAL amber.public_sku_activation='on'; SET LOCAL amber.magento_delivery_cutover='on'");
      await conn.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton',[actor,activationEvent]);
      await conn.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,
        legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton`,[installationKey,actor,cutoverEvent]);
      product = (await conn.query(`INSERT INTO products(full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details,corrected_from_product_id)
        SELECT 'SV11501001','SV11501001',1,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details,id FROM products WHERE id=$1 RETURNING *`,[sourceId])).rows[0];
      await conn.query("UPDATE products SET status='corrected',corrected_to_product_id=$2,exclude_from_export=1 WHERE id=$1",[sourceId,product.id]);
      const correction = (await conn.query(`INSERT INTO product_corrections(source_product_id,corrected_product_id,source_sku,corrected_sku)
        VALUES($1,$2,'SV5111010','SV11501001') RETURNING id`,[sourceId,product.id])).rows[0];
      await conn.query("UPDATE product_full_export_state SET route='retired',hold_reason=NULL,delivery_version=delivery_version+1 WHERE product_id=$1",[sourceId]);
      await conn.query(`INSERT INTO product_full_export_state(product_id,route,hold_reason,source_correction_id,business_exclusion_state,evidence,csv_retired_revision)
        VALUES($1,'hold','historical_ambiguity',$2,'none',
        '{"origin":"recount","classification":"historical_ambiguous","primaryReason":"INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP"}',1)`,[product.id,correction.id]);
      await conn.query('COMMIT');
    } finally { await conn.query('ROLLBACK'); conn.release(); }
    const options = { ...s.options,expectedDatabase: name,bindingRevisionId: published.id,mutationContext: { actorUserId: actor },databasePool: db };
    const worker = require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(config,{databasePool: db,jobOptions: s.options});
    const request = async () => (await db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1',[product.id])).rows[0];
    const lifecycle = async () => (await db.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[product.id])).rows[0];
    const protectedState = async () => (await db.query(`SELECT
      (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,
      (SELECT jsonb_agg(c ORDER BY id) FROM product_corrections c) corrections,
      (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) lifecycle,
      (SELECT jsonb_agg(r ORDER BY product_id) FROM magento_product_sync_requests r) requests,
      (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM magento_sync_jobs) jobs,
      (SELECT count(*) FROM magento_binding_handoffs) handoffs`)).rows[0];
    await worker.runProduct(product.public_product_identity_id);
    assert.equal((await request()).state,'needs_attention'); assert.equal((await request()).attempts,0);
    assert.equal((await protectedState()).jobs,'0');
    assert.equal((await ordinary.preview(config,s.input.sku,options)).blockers.includes('CORRECTION_LINEAGE'),true);
    let plan;
    await t.test('read-only preview proves stable identity and a fresh sendable UPDATE without jobs',async () => {
      const before = await protectedState();
      plan = await service.preview(config,s.input.sku,options);
      assert.equal(plan.eligible,true,JSON.stringify(plan)); assert.equal(plan.sync.sendable,true);
      assert.equal(plan.sku,'SV5111010'); assert.equal(plan.internalSku,'SV11501001');
      assert.deepEqual(await protectedState(),before); assert.equal(s.writes.length,0);
    });
    await t.test('browser lifecycle recovery selects the current stable-public binding and forbids legacy replacement after cutover',async () => {
      const recovery = require('../src/services/magento/lifecycle-recovery');
      const before = await protectedState();
      const exact = await recovery.productRecovery(config,product.id,{...options,canRecoverJobs:true,canReconcileLifecycle:true});
      assert.equal(exact.productId,product.id); assert.equal(exact.article,'SV5111010');
      assert.deepEqual(exact.lifecycle.availableKinds,['stable_recount_exposure']);
      assert.equal(exact.lifecycle.suggestedKind,'stable_recount_exposure'); assert.equal(exact.lifecycle.legacyDeliveryEnabled,false);
      const reviewed = await recovery.preview(config,product.id,{kind:'stable_recount_exposure'},options);
      assert.equal(reviewed.eligible,true,JSON.stringify(reviewed.blockers));
      assert.equal(reviewed.review.payload.bindingRevisionId,published.id);
      assert.equal(reviewed.review.payload.publicIdentityId,String(product.public_product_identity_id));
      const legacy = await recovery.preview(config,product.id,{kind:'replacement'},options);
      assert.equal(legacy.eligible,false); assert.ok(legacy.blockers.includes('LIFECYCLE_LEGACY_DELIVERY_RETIRED'));
      assert.deepEqual(await protectedState(),before); assert.equal(s.writes.length,0);
    });
    await t.test('authorization, missing/replaced counterpart, and stale version fail without side effects',async () => {
      const before = await protectedState();
      await assert.rejects(service.apply(config,plan,plan.planHash,{...options,mutationContext:{actorUserId:999999}}),{code:'ADMIN_PERMISSION_REVOKED'});
      const old = s.remote().id; s.remote().id++;
      assert.equal((await service.preview(config,s.input.sku,options)).eligible,false);
      await assert.rejects(service.apply(config,plan,plan.planHash,options),{code:'EXPOSURE_REMOTE_CHANGED'});
      s.remote().id=old;
      const missing = { ...options,fetchImpl: async (url,init) => {
        if (new URL(url).pathname.endsWith('/products')) return new Response(JSON.stringify({items:[],total_count:0}),{headers:{'content-type':'application/json'}});
        return options.fetchImpl(url,init);
      } };
      assert.equal((await service.preview(config,s.input.sku,missing)).eligible,false);
      await assert.rejects(service.apply(config,plan,plan.planHash,missing),{code:'EXPOSURE_REMOTE_CHANGED'});
      const sku = s.remote().sku; s.remote().sku='WRONG';
      await assert.rejects(service.preview(config,s.input.sku,options)); s.remote().sku=sku;
      assert.deepEqual(await protectedState(),before);
      await db.query('UPDATE product_full_export_state SET delivery_version=delivery_version+1 WHERE product_id=$1',[product.id]);
      await assert.rejects(service.apply(config,plan,plan.planHash,options),{code:'EXPOSURE_RECONCILIATION_CONFLICT'});
      plan = await service.preview(config,s.input.sku,options);
    });
    await t.test('uncertain request is neither reconciled nor enrolled by this workflow',async () => {
      // Synthetic request state only, on this disposable database.
      const original=await request();
      await db.query("UPDATE magento_product_sync_requests SET reason_code='reconciliation_required' WHERE product_id=$1",[product.id]);
      const before=await protectedState();
      assert.ok((await service.preview(config,s.input.sku,options)).blockers.includes('UNFINISHED_SYNC_WORK'));
      await assert.rejects(service.apply(config,plan,plan.planHash,options),{code:'EXPOSURE_RECONCILIATION_CONFLICT'});
      assert.deepEqual(await protectedState(),before);assert.equal(s.writes.length,0);
      await db.query('UPDATE magento_product_sync_requests SET reason_code=$2 WHERE product_id=$1',[product.id,original.reason_code]);
    });
    await t.test('independent writer changes ancestor while apply waits; complete fingerprint conflicts before GET',async () => {
      const writer=new Pool({connectionString:url,max:1}), holder=await db.connect();let pending;
      try {
        const pid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await holder.query('BEGIN');await holder.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[sourceId]);
        pending=service.apply(config,plan,plan.planHash,{...options,databasePool:writer,preview:()=>assert.fail('stale fingerprint must fail before GET')});pending.catch(()=>{});
        let blocked=false;
        for(let i=0;i<600&&!blocked;i++){
          blocked=(await db.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked;
          if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(blocked,true);
        await holder.query('UPDATE products SET weight=weight+1 WHERE id=$1',[sourceId]);await holder.query('COMMIT');
        await assert.rejects(pending,{code:'EXPOSURE_RECONCILIATION_CONFLICT'});
        assert.equal((await lifecycle()).hold_reason,'historical_ambiguity');assert.equal(s.writes.length,0);
      } finally {await holder.query('ROLLBACK');holder.release();if(pending)await Promise.allSettled([pending]);await writer.end();}
      plan=await service.preview(config,s.input.sku,options);
    });
    await t.test('active sync lane prevents reconciliation without waiting or writing',async()=>{
      const holder=await db.connect(), key=`amber_magento_public_identity:${product.public_product_identity_id}`;
      try {
        await holder.query('SELECT pg_advisory_lock(hashtext($1))',[key]);
        const before=await protectedState();
        await assert.rejects(service.apply(config,plan,plan.planHash,options),{code:'EXPOSURE_SYNC_BUSY'});
        assert.deepEqual(await protectedState(),before);
      } finally {await holder.query('SELECT pg_advisory_unlock(hashtext($1))',[key]);holder.release();}
    });
    await t.test('audit failure rolls back lifecycle and the reviewed re-evaluation outbox together',async () => {
      const before = await protectedState();
      const failing = {connect:async()=>{const client=await db.connect();return {release:()=>client.release(),query:(sql,args)=>{
        if (/INSERT INTO audit_events/.test(sql)) throw new Error('synthetic audit failure');return client.query(sql,args);
      }};}};
      await assert.rejects(service.apply(config,plan,plan.planHash,{...options,databasePool:failing}),/synthetic audit failure/);
      assert.deepEqual(await protectedState(),before);
    });
    await t.test('reviewed apply preserves public identity/history/acknowledgements and creates one immutable receipt',async () => {
      const before=await protectedState(), f=await lifecycle(), r=await request();
      const result=await service.apply(config,plan,plan.planHash,options);
      const after=await protectedState(), next=await lifecycle();
      assert.deepEqual(after.products,before.products);assert.deepEqual(after.corrections,before.corrections);
      for (const k of ['revision','confirmed_revision','csv_retired_revision','externally_delivered_revision','source_correction_id']) assert.equal(next[k],f[k],k);
      assert.equal(next.route,'hold');assert.equal(next.hold_reason,'prior_exposure');assert.equal(BigInt(next.delivery_version),BigInt(f.delivery_version)+1n);
      assert.deepEqual(await request(),r,'apply records a durable handoff; enrollment is performed by the existing worker');
      assert.equal(s.writes.length,0);
      assert.equal((await service.apply(config,plan,plan.planHash,{...options,preview:()=>assert.fail('idempotent retry GET')})).alreadyApplied,true);
      await assert.rejects(db.query("UPDATE audit_events SET details='{}' WHERE event_key='product.magento_stable_recount_exposure_reconciled'"));
      assert.equal((await db.query('SELECT state FROM magento_binding_handoff_items WHERE handoff_id=$1',[result.handoffId])).rows[0].state,'pending');
    });
    await t.test('existing reviewed enrollment advances parked generation and automatic delivery updates the same SKU',async () => {
      const before=await request(), remoteId=s.remote().id;
      await require('../src/services/magento/binding-handoff').processHandoffs(config,{databasePool:db});
      const pending=await request();assert.equal(pending.state,'pending');assert.equal(BigInt(pending.desired_generation),BigInt(before.desired_generation)+1n);
      await worker.runProduct(product.public_product_identity_id);
      assert.equal((await request()).state,'synced');assert.equal(s.remote().id,remoteId);assert.equal(s.remote().sku,'SV5111010');
      const job=(await db.query('SELECT * FROM magento_sync_jobs WHERE product_id=$1',[product.id])).rows[0];
      assert.equal(job.sku,'SV5111010');assert.equal(job.intent.mode,'update');
      assert.equal((await lifecycle()).confirmed_revision,'0');
    });
    await t.test('a later uncertain dispatch remains protected even if a reviewed handoff is pending',async()=>{
      const origin=require('../src/services/magento/binding-contract').originHash(config.baseUrl);
      const handoff=require('../src/services/magento/binding-handoff');
      // Construct pending reviewed evidence before uncertainty arrives. Existing
      // enrollment must recheck it; a preview is never a permanent resend grant.
      const id=await handoff.record(db,{actorUserId:actor},published,'broader_resync','f'.repeat(64),{source:'synthetic-race'},
        [{productId:product.id,publicIdentityId:product.public_product_identity_id,reason:'reviewed_resync'}]);
      await db.query(`INSERT INTO magento_sync_jobs(id,product_id,sku,installation_key,origin_hash,binding_revision_id,binding_hash,amber_hash,plan_hash,intent,baseline,state,created_by_user_id,public_product_identity_id)
        VALUES('synthetic-uncertain',$1,'SV5111010',$2,$3,$4,$5,$5,$5,'{}','{}','uncertain',$6,$7)`,
      [product.id,installationKey,origin,published.id,'e'.repeat(64),actor,product.public_product_identity_id]);
      await db.query("INSERT INTO magento_sync_steps(job_id,ordinal,state,dispatched_at) VALUES('synthetic-uncertain',0,'dispatched',CURRENT_TIMESTAMP)");
      const before=await request(),writes=s.writes.length;
      await handoff.processHandoffs(config,{databasePool:db});
      assert.equal((await db.query('SELECT state FROM magento_binding_handoff_items WHERE handoff_id=$1',[id])).rows[0].state,'protected');
      assert.deepEqual(await request(),before);assert.equal(s.writes.length,writes);
      assert.ok((await service.preview(config,s.input.sku,options)).blockers.includes('UNFINISHED_SYNC_WORK'));
    });
  } finally { await db.end(); await dropTestDatabase(name); }
});
