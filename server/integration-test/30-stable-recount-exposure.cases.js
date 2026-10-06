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

suite.test('SV11510016 native stable recount: actual mixed chain, exact ownership and locked apply', async t => {
  const { assert, Pool, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = suite;
  const name = 'amber_stable_exposure_test', url = await recreateTestDatabase(name);
  const db = new Pool({ connectionString: url });
  try {
    await require('./historical-runtime-fixture')(suite,url);
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Native exposure test') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
    const { scenario,config,published,installationKey } = await require('./stable-recount-exposure-fixture')(db,actor,{group:'SV'});
    // Owned disposable replica: preserve the operator's IDs and exact reservations.
    await db.query("SELECT setval(pg_get_serial_sequence('products','id'),1834),setval(pg_get_serial_sequence('public_product_identities','id'),4314)");
    const s = await scenario({ sku: 'SV11510016', category: 'SV' });
    assert.equal(s.product.id,1835); assert.equal(String(s.product.public_product_identity_id),'4315');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const event = async key => (await client.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
        VALUES($1,$2,'{"displayName":"Native exposure test","preferredUsername":null}','fixture','singleton',$1) RETURNING id`,[key,actor])).rows[0].id;
      const activation = await event('public_sku.activated'), cutover = await event('magento_delivery.cutover');
      await client.query("SET LOCAL amber.public_sku_activation='on'; SET LOCAL amber.magento_delivery_cutover='on'");
      await client.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton',[actor,activation]);
      await client.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,
        legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton`,[installationKey,actor,cutover]);
      await client.query(`INSERT INTO products(id,full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details,corrected_from_product_id)
        SELECT 5081,'SV11510024','SV11510024',1,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details,id FROM products WHERE id=1835`);
      await client.query("UPDATE products SET status='corrected',corrected_to_product_id=5081,exclude_from_export=1 WHERE id=1835");
      await client.query("SELECT setval(pg_get_serial_sequence('product_corrections','id'),1556)");
      const correction = (await client.query(`INSERT INTO product_corrections(source_product_id,corrected_product_id,source_sku,corrected_sku)
        VALUES(1835,5081,'SV11510016','SV11510024') RETURNING id`)).rows[0];
      assert.equal(correction.id,1557);
      await client.query("UPDATE product_full_export_state SET route='retired',hold_reason=NULL,delivery_version=delivery_version+1 WHERE product_id=1835");
      await client.query(`INSERT INTO product_full_export_state(product_id,route,hold_reason,source_correction_id,business_exclusion_state,evidence,csv_retired_revision)
        VALUES(5081,'hold','historical_ambiguity',1557,'none','{"origin":"recount","classification":"historical_ambiguous"}',1)`);
      await client.query('COMMIT');
      await runNodeInDatabase(url,"require('./src/db/run-migrations').runMigrations().finally(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});");
      await client.query('BEGIN');
      const characteristics = require('../src/services/product/characteristic-config');
      const version = await characteristics.persistCharacteristicConfiguration(client,await characteristics.readCharacteristicConfiguration(client,'SV'));
      assert.equal(String(version.id),'1');
      await client.query(`INSERT INTO products(id,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details,characteristic_version_id,corrected_from_product_id)
        SELECT 5082,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details,$1,id FROM products WHERE id=5081`,[version.id]);
      await client.query("UPDATE products SET status='corrected',corrected_to_product_id=5082,exclude_from_export=1 WHERE id=5081");
      const nativeCorrection = (await client.query(`INSERT INTO product_corrections(source_product_id,corrected_product_id,source_sku,corrected_sku)
        VALUES(5081,5082,'SV11510024','SV11510016') RETURNING id`)).rows[0];
      assert.equal(nativeCorrection.id,1558);
      await client.query("UPDATE product_full_export_state SET route='retired',hold_reason=NULL,delivery_version=delivery_version+1 WHERE product_id=5081");
      await client.query(`INSERT INTO product_full_export_state(product_id,route,hold_reason,source_correction_id,business_exclusion_state,evidence,csv_retired_revision)
        VALUES(5082,'hold','historical_ambiguity',1558,'none',
        '{"origin":"recount","classification":"historical_ambiguous","primaryReason":"INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP"}',1)`);
      await client.query("SELECT setval(pg_get_serial_sequence('products','id'),5082)");
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    const foreign = (await require('./product-fixture').insertNativeProductFixture(db,{category:'SV',weight:5})).rows[0];
    assert.notEqual(String(foreign.public_product_identity_id),'4315');
    const options = { ...s.options,databasePool:db,expectedDatabase:name,bindingRevisionId:published.id,mutationContext:{actorUserId:actor} };
    const recovery = require('../src/services/magento/lifecycle-recovery');
    const protectedState = async () => (await db.query(`SELECT
      (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,
      (SELECT jsonb_agg(i ORDER BY id) FROM public_product_identities i) identities,
      (SELECT jsonb_agg(r ORDER BY full_sku) FROM sku_registry r) registry,
      (SELECT jsonb_agg(v ORDER BY id) FROM product_characteristic_versions v) characteristics,
      (SELECT jsonb_agg(c ORDER BY id) FROM product_corrections c) corrections,
      (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) lifecycle,
      (SELECT jsonb_agg(r ORDER BY product_id) FROM magento_product_sync_requests r) requests,
      (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM magento_sync_jobs) jobs,
      (SELECT count(*) FROM magento_binding_handoffs) handoffs`)).rows[0];
    let review, plan;
    await t.test('actual DB projection has no terminal reservation and guided preview proves the complete stable identity',async()=>{
      const before = await protectedState(), reader = await db.connect();
      try {
        const { state } = await service.read(reader,config,'SV11510016',published.id);
        assert.equal(state.product.id,5082); assert.equal(state.product.full_sku,null);
        assert.equal(state.product.characteristic_version_id,1); assert.equal(state.reservation,null);
        assert.deepEqual(state.stable.members.map(m=>[m.product.id,m.product.full_sku,m.reservation?.first_product_id??null]),
          [[1835,'SV11510016',1835],[5081,'SV11510024',5081],[5082,null,null]]);
        assert.ok(state.stable.members.every(m=>String(m.product.public_product_identity_id)==='4315'));
        assert.deepEqual(service.blockers(state),[]);
        assert.ok(ordinary.blockers(state).includes('CORRECTION_LINEAGE'));
      } finally { reader.release(); }
      const record = await recovery.productRecovery(config,5082,{...options,canReconcileLifecycle:true});
      assert.equal(record.history.stableRecount,true); assert.deepEqual(record.history.issues,[]);
      assert.deepEqual(record.lifecycle.availableKinds,['stable_recount_exposure']);
      review = await recovery.preview(config,5082,{kind:'stable_recount_exposure'},options); plan = review.review.payload;
      assert.equal(review.eligible,true,JSON.stringify(review.review.payload.sync));
      assert.equal(plan.productId,5082); assert.equal(plan.publicIdentityId,'4315');
      assert.equal(plan.sku,'SV11510016'); assert.equal(plan.internalSku,null);
      assert.deepEqual(plan.lineageProductIds,[1835,5081,5082]); assert.equal(plan.sync.sendable,true);
      assert.deepEqual(await protectedState(),before); assert.equal(s.writes.length,0);
    });
    await t.test('foreign registry owner is rejected by preview and locked apply before Magento reads',async()=>{
      try {
        await db.query("UPDATE sku_registry SET first_product_id=$1 WHERE full_sku='SV11510016'",[foreign.id]);
        const before = await protectedState(), noRead = {...options,preview:()=>assert.fail('ownership failure must precede GET')};
        assert.ok((await service.preview(config,'SV11510016',noRead)).blockers.includes('SKU_RESERVATION_CONFLICT'));
        await assert.rejects(service.apply(config,plan,plan.planHash,noRead),{code:'EXPOSURE_RECONCILIATION_CONFLICT'});
        assert.deepEqual(await protectedState(),before); assert.equal(s.writes.length,0);
      } finally { await db.query("UPDATE sku_registry SET first_product_id=1835 WHERE full_sku='SV11510016'"); }
    });
    await t.test('database prevents replacing native identity, erasing characteristics or manufacturing an encoded SKU',async()=>{
      const before = await protectedState();
      await assert.rejects(db.query('UPDATE products SET public_product_identity_id=$1 WHERE id=5082',[foreign.public_product_identity_id]));
      await assert.rejects(db.query('UPDATE products SET characteristic_version_id=NULL WHERE id=5082'));
      await assert.rejects(db.query("UPDATE products SET full_sku='SYNTHETIC-NATIVE-SKU' WHERE id=5082"));
      assert.deepEqual(await protectedState(),before);
    });
    await t.test('independent ancestor writer invalidates native review after the product lock wait and before GET',async()=>{
      const writer = new Pool({connectionString:url,max:1}), holder = await db.connect(); let pending;
      try {
        const pid = (await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        await holder.query('BEGIN'); await holder.query('SELECT id FROM products WHERE id=1835 FOR UPDATE');
        pending = service.apply(config,plan,plan.planHash,{...options,databasePool:writer,preview:()=>assert.fail('stale native evidence must fail before GET')}); pending.catch(()=>{});
        let blocked = false;
        for(let i=0;i<600&&!blocked;i++) {
          blocked = (await db.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked;
          if(!blocked) await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(blocked,true);
        await holder.query('UPDATE products SET weight=weight+1 WHERE id=1835'); await holder.query('COMMIT');
        await assert.rejects(pending,{code:'EXPOSURE_RECONCILIATION_CONFLICT'});
        assert.equal((await db.query('SELECT hold_reason FROM product_full_export_state WHERE product_id=5082')).rows[0].hold_reason,'historical_ambiguity');
        assert.equal(s.writes.length,0);
      } finally { await holder.query('ROLLBACK'); holder.release(); if(pending) await Promise.allSettled([pending]); await writer.end(); }
      review = await recovery.preview(config,5082,{kind:'stable_recount_exposure'},options); plan = review.review.payload;
      assert.equal(review.eligible,true,JSON.stringify(review.review.payload.sync));
    });
    await t.test('reviewed current UPDATE changes only the exposure hold and records one recoverable handoff',async()=>{
      const before = await protectedState(), prior = before.lifecycle.find(f=>f.product_id===5082);
      const input = {review:review.review,reviewHash:review.reviewHash,reason:'Reviewed native current product and exact immutable ancestry'};
      const result = await recovery.apply(config,5082,input,options), after = await protectedState();
      for(const key of ['products','identities','registry','characteristics','corrections','requests','jobs']) assert.deepEqual(after[key],before[key],key);
      for(const id of [1835,5081,foreign.id]) assert.deepEqual(after.lifecycle.find(f=>f.product_id===id),before.lifecycle.find(f=>f.product_id===id));
      const next = after.lifecycle.find(f=>f.product_id===5082);
      for(const key of ['revision','confirmed_revision','csv_retired_revision','externally_delivered_revision','source_correction_id']) assert.equal(next[key],prior[key],key);
      assert.equal(next.route,'hold'); assert.equal(next.hold_reason,'prior_exposure');
      assert.equal(BigInt(next.delivery_version),BigInt(prior.delivery_version)+1n);
      assert.equal(Number(after.audits),Number(before.audits)+1); assert.equal(Number(after.handoffs),Number(before.handoffs)+1);
      assert.equal(s.writes.length,0); assert.equal(result.nextAction.kind,'await_delivery');
      assert.equal((await recovery.apply(config,5082,input,{...options,preview:()=>assert.fail('idempotent native retry GET')})).alreadyApplied,true);
      assert.deepEqual(await protectedState(),after);
    });
  } finally { await db.end(); await dropTestDatabase(name); }
});
