const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Client,Pool}=require('pg');

test('native mutation and photo lineage integrity on owned PostgreSQL database',async(t)=>{
  const name=`amber_photo_native_${Date.now()}_${process.pid}_test`;
  const maintenance=new Client({connectionString:'postgresql://amber_test:amber_test_local_only@127.0.0.1:55432/postgres',connectionTimeoutMillis:3000});
  await maintenance.connect();let created=false;let db;let checkpoint;
  try {
    await maintenance.query(`CREATE DATABASE "${name}"`);created=true;console.log(`Owned photo native database ${name}`);
    process.env.DATABASE_URL=`postgresql://amber_test:amber_test_local_only@127.0.0.1:55432/${name}`;
    require('../test/setup-env');const {runMigrations}=require('../src/db/run-migrations');
    const directory=path.resolve(__dirname,'../migrations');
    const tempRoot=path.resolve(process.env.TEMP || process.env.TMP || directory);
    checkpoint=await fs.mkdtemp(path.join(tempRoot,'amber-photo-native-migrations-'));
    for(const file of (await fs.readdir(directory)).filter((f)=>/^\d{3}_.*\.sql$/.test(f) && Number(f.slice(0,3))<=64))await fs.copyFile(path.join(directory,file),path.join(checkpoint,file));
    await runMigrations({directory:checkpoint});db=new Pool({connectionString:process.env.DATABASE_URL,max:6,connectionTimeoutMillis:3000});
    const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Photo native actor') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='storekeeper'",[actor]);
    await db.query("INSERT INTO categories(code,name,requires_weight) VALUES('ZZ','Photo native fixtures',1)");
    const version=(await db.query(`INSERT INTO product_characteristic_versions(category_code,version,config_hash,snapshot)
      VALUES('ZZ',1,$1,'{"contract":"product-characteristics-v1","category_code":"ZZ","questions":[]}'::jsonb) RETURNING id`,['a'.repeat(64)])).rows[0].id;
    const audit=(await require('../src/audit/audit-events').writeAuditEvent(db,{mutationContext:{actorUserId:actor},eventKey:'photo.fixture_activated',subjectType:'photo_fixture',subjectId:name})).id;
    const setup=await db.connect();try {
      await setup.query('BEGIN');await setup.query("SET LOCAL amber.public_sku_activation='on'");
      await setup.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2',[actor,audit]);
      await setup.query("SET LOCAL amber.magento_delivery_cutover='on'");
      await setup.query("UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='photo-native-fixture',actor_user_id=$1,legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton",[actor,audit]);
      await setup.query('COMMIT');
    }finally{await setup.query('ROLLBACK').catch(()=>{});setup.release();}
    const photos=require('../src/services/product-photos.service'),gate=require('../src/services/full-product-cutover-gate');
    const context={actorUserId:actor,requestId:'photo-native-fixture'};
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE5sAAAAASUVORK5CYII=','base64');
    async function product(client,source=null) {
      const value=(await client.query(`INSERT INTO products(category,weight,total_price,total_price_uah,details,characteristic_version_id,corrected_from_product_id)
        VALUES('ZZ',1,100,100,'{"answers":{"length":1}}'::jsonb,$1,$2) RETURNING id,public_product_identity_id`,[version,source])).rows[0];
      await require('../src/services/full-product-export.service').initializeNewProduct(client,Number(value.id));return value;
    }
    async function fixture({started=false,succeeded=false}={}) {
      const asset=await photos.stage({idempotencyKey:randomUUID(),name:'native.png',mimeType:'image/png',base64:bytes.toString('base64')},{databasePool:db,mutationContext:context});
      const client=await db.connect();let value;let attached;
      try {await gate.begin(client);value=await product(client);attached=await photos.attachCreatedProduct(client,Number(value.id),{photoIds:[asset.id],enableWhenVerified:true},context);await gate.commit(client);}
      catch(cause){await gate.rollback(client).catch(()=>{});throw cause;}
      finally{await gate.release(client).catch(()=>{});client.release();}
      if(started || succeeded)await db.query(`UPDATE product_media_jobs SET native_generation=1,state=$2,verified_at=CASE WHEN $2='succeeded' THEN CURRENT_TIMESTAMP END WHERE id=$1`,[attached.jobId,succeeded?'succeeded':'running']);
      return {...value,id:Number(value.id),assetId:asset.id,jobId:attached.jobId};
    }
    await t.test('064 reproduction: input mutation invalidates a pinned native generation',async()=>{
      const f=await fixture({started:true});const client=await db.connect();
      try {await gate.begin(client);await client.query('UPDATE products SET total_price_uah=200 WHERE id=$1',[f.id]);
        const request=(await client.query('SELECT desired_generation FROM magento_product_sync_requests WHERE product_id=$1',[f.id])).rows[0];
        const job=(await client.query('SELECT native_generation FROM product_media_jobs WHERE id=$1',[f.jobId])).rows[0];
        assert.equal(request.desired_generation,'2');assert.equal(job.native_generation,'1');
      }finally{await gate.rollback(client);client.release();}
    });
    await t.test('064 reproduction: same-identity recount successor has an empty local gallery',async()=>{
      const f=await fixture();const client=await db.connect();
      try {await gate.begin(client);const successor=await product(client,f.id);
        assert.equal(successor.public_product_identity_id,f.public_product_identity_id);
        assert.deepEqual((await photos.read(Number(successor.id),{databasePool:client})).photos,[]);
        assert.deepEqual((await photos.read(f.id,{databasePool:client})).photos.map((p)=>p.id),[f.assetId]);
      }finally{await gate.rollback(client);client.release();}
    });
    if(process.env.PHOTO_REPRO_ONLY==='true')return;
    await runMigrations({directory});await runMigrations({directory});
    async function rollbackOperation(operation) {
      const client=await db.connect();try {await gate.begin(client);return await operation(client);}
      finally {await gate.rollback(client).catch(()=>{});client.release();}
    }
    const fenced={code:'P0651',constraint:'product_media_native_input_fence'};
    await t.test('065 rejects all stored native input changes and direct queue advances with exact evidence unchanged',async()=>{
      const f=await fixture({started:true});
      await db.query('INSERT INTO product_media_steps(job_id,step_key,operation_hash) VALUES($1,$2,$3)',[f.jobId,'upload:native-fixture','b'.repeat(64)]);
      const before=(await db.query('SELECT row_to_json(p) AS product FROM products p WHERE id=$1',[f.id])).rows[0];
      const request=(await db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1',[f.id])).rows[0];
      const job=(await db.query('SELECT * FROM product_media_jobs WHERE id=$1',[f.jobId])).rows[0];
      const steps=(await db.query('SELECT * FROM product_media_steps WHERE job_id=$1',[f.jobId])).rows;
      for(const expression of ['total_price_uah=200','weight=2',`details='{"answers":{"length":2}}'::jsonb`,
        "magento_name_subject_ua='Новий товар',magento_name_subject_en='New product'",'magento_name_review_required=TRUE',"status='archived'",'exclude_from_export=1']) {
        await assert.rejects(()=>rollbackOperation((client)=>client.query(`UPDATE products SET ${expression} WHERE id=$1`,[f.id])),fenced);
      }
      await assert.rejects(()=>db.query('UPDATE magento_product_sync_requests SET desired_generation=desired_generation+1,state=$2 WHERE product_id=$1',[f.id,'pending']),fenced);
      await assert.rejects(()=>rollbackOperation((client)=>product(client,f.id)),fenced);
      assert.deepEqual((await db.query('SELECT row_to_json(p) AS product FROM products p WHERE id=$1',[f.id])).rows[0],before);
      assert.deepEqual((await db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1',[f.id])).rows[0],request);
      assert.deepEqual((await db.query('SELECT * FROM product_media_jobs WHERE id=$1',[f.jobId])).rows[0],job);
      assert.deepEqual((await db.query('SELECT * FROM product_media_steps WHERE job_id=$1',[f.jobId])).rows,steps);
      await db.query('UPDATE magento_auto_sync_activation SET enabled=FALSE WHERE singleton');
      try {await assert.rejects(()=>rollbackOperation((client)=>client.query('UPDATE products SET weight=2 WHERE id=$1',[f.id])),fenced);}
      finally{await db.query('UPDATE magento_auto_sync_activation SET enabled=TRUE WHERE singleton');}
    });
    await t.test('065 permits in-place data repair before media starts and ignores non-input metadata',async()=>{
      const f=await fixture();await db.query('UPDATE products SET weight=2 WHERE id=$1',[f.id]);
      assert.equal((await db.query('SELECT desired_generation FROM magento_product_sync_requests WHERE product_id=$1',[f.id])).rows[0].desired_generation,'2');
      await db.query("UPDATE product_media_jobs SET native_generation=2,state='running' WHERE id=$1",[f.jobId]);
      await db.query('UPDATE products SET total_price=101 WHERE id=$1',[f.id]);
      assert.equal((await db.query('SELECT desired_generation FROM magento_product_sync_requests WHERE product_id=$1',[f.id])).rows[0].desired_generation,'2');
    });
    await t.test('independent media pin transaction holds request share lock before a generation advance',async()=>{
      const f=await fixture();const pin=await db.connect(),mutator=await db.connect();let mutation;
      try {
        const pinPid=(await pin.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const mutationPid=(await mutator.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;assert.notEqual(pinPid,mutationPid);
        await gate.begin(pin);await pin.query('SELECT id FROM products WHERE id=$1 FOR NO KEY UPDATE',[f.id]);
        await pin.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1 FOR SHARE',[f.id]);
        await pin.query("UPDATE product_media_jobs SET native_generation=1,state='running' WHERE id=$1",[f.jobId]);
        mutation=mutator.query("UPDATE magento_product_sync_requests SET desired_generation=desired_generation+1,state='pending' WHERE product_id=$1",[f.id]).then((value)=>({value}),(cause)=>({cause}));
        let waiting=false;
        for(let attempt=0;attempt<40;attempt++) {
          waiting=(await db.query('SELECT 1 WHERE $1::int=ANY(pg_blocking_pids($2::int))',[pinPid,mutationPid])).rowCount>0;
          if(waiting)break;await new Promise((resolve)=>setTimeout(resolve,20));
        }
        assert.equal(waiting,true,'direct request mutation must wait for the separate media pin transaction');
        await gate.commit(pin);assert.equal((await mutation).cause?.code,'P0651');
        assert.equal((await db.query('SELECT desired_generation FROM magento_product_sync_requests WHERE product_id=$1',[f.id])).rows[0].desired_generation,'1');
        assert.equal((await db.query('SELECT native_generation FROM product_media_jobs WHERE id=$1',[f.jobId])).rows[0].native_generation,'1');
      }finally{await gate.rollback(pin).catch(()=>{});pin.release();mutator.release();}
    });
    async function inherit(source,{requiredPermission='products.recount'}={}) {
      const client=await db.connect();try {
        await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))',[require('../src/services/access-admin-transaction').APPLICATION_USER_ADMIN_LOCK_KEY]);await gate.enterExisting(client);
        await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[source.id]);const successor=await product(client,source.id);
        await client.query("UPDATE products SET status='corrected',corrected_to_product_id=$2 WHERE id=$1",[source.id,successor.id]);
        const inherited=await photos.inheritRecountPhotos(client,source.id,Number(successor.id),context,{requiredPermission});
        await gate.commit(client);return {...successor,id:Number(successor.id),assetId:source.assetId,jobId:inherited.jobId};
      }catch(cause){await gate.rollback(client).catch(()=>{});throw cause;}finally{await gate.release(client).catch(()=>{});client.release();}
    }
    await t.test('unstarted recount carries immutable gallery and has permanent linked supersession across repeated successors',async()=>{
      const f=await fixture();const original=(await db.query('SELECT * FROM product_photo_assets WHERE id=$1',[f.assetId])).rows[0];
      const next=await inherit(f);const latest=await inherit(next);
      assert.deepEqual((await photos.read(latest.id,{databasePool:db})).photos.map((p)=>p.id),[f.assetId]);
      assert.deepEqual((await db.query('SELECT * FROM product_photo_assets WHERE id=$1',[f.assetId])).rows[0],original);
      const predecessor=(await db.query('SELECT * FROM product_media_jobs WHERE id=$1',[f.jobId])).rows[0];
      assert.equal(predecessor.state,'superseded');assert.equal(predecessor.superseded_by_job_id,next.jobId);assert.equal(predecessor.native_generation,null);
      assert.equal((await db.query('SELECT inherited_from_job_id FROM product_media_jobs WHERE id=$1',[latest.jobId])).rows[0].inherited_from_job_id,next.jobId);
      await assert.rejects(()=>db.query("UPDATE product_media_jobs SET state='pending',superseded_by_job_id=NULL WHERE id=$1",[f.jobId]));
      await assert.rejects(()=>db.query('UPDATE product_photo_assets SET product_id=$2 WHERE id=$1',[f.assetId,latest.id]));
      await db.query("UPDATE product_media_jobs SET state='succeeded',verified_at=CURRENT_TIMESTAMP WHERE id=$1",[latest.jobId]);
      const saved=await photos.save(latest.id,{idempotencyKey:randomUUID(),expectedVersion:'1',photoIds:[f.assetId],enableWhenVerified:true},{databasePool:db,mutationContext:context});
      assert.equal(saved.version,'2','a successor can edit/reorder its inherited same-identity original');
      const unrelated=await fixture();
      await assert.rejects(()=>photos.save(unrelated.id,{idempotencyKey:randomUUID(),expectedVersion:'1',photoIds:[f.assetId],enableWhenVerified:true},{databasePool:db,mutationContext:context}),{code:'PHOTO_DELIVERY_UNRESOLVED'});
      await db.query("UPDATE product_media_jobs SET state='succeeded',verified_at=CURRENT_TIMESTAMP WHERE id=$1",[unrelated.jobId]);
      await assert.rejects(()=>photos.save(unrelated.id,{idempotencyKey:randomUUID(),expectedVersion:'1',photoIds:[f.assetId],enableWhenVerified:true},{databasePool:db,mutationContext:context}),{code:'PHOTO_OWNERSHIP'});
    });
    await t.test('succeeded source gallery remains exact while explicit recount queues fresh successor verification',async()=>{
      const f=await fixture({succeeded:true});const before=(await db.query('SELECT * FROM product_media_jobs WHERE id=$1',[f.jobId])).rows[0];
      const next=await inherit(f,{requiredPermission:'corrections.complete'});
      assert.deepEqual((await db.query('SELECT * FROM product_media_jobs WHERE id=$1',[f.jobId])).rows[0],before);
      const job=(await db.query('SELECT * FROM product_media_jobs WHERE id=$1',[next.jobId])).rows[0];
      assert.equal(job.required_permission,'corrections.complete');assert.equal(job.state,'pending');assert.equal(job.native_generation,null);
      assert.deepEqual(job.photo_ids,[f.assetId]);assert.equal(job.enable_when_verified,true);
      await assert.rejects(()=>db.query(`INSERT INTO product_media_jobs(id,product_id,public_product_identity_id,version,photo_ids,enable_when_verified,
        actor_user_id,request_key,required_permission,intent_hash) VALUES($1,$2,$3,2,$4,TRUE,$5,$6,'corrections.complete',$7)`,
      [randomUUID(),next.id,next.public_product_identity_id,[f.assetId],actor,randomUUID(),'c'.repeat(64)]));
    });
    await t.test('pre-dispatch cancellation without the exact linked successor proof is rejected',async()=>{
      const f=await fixture();
      await assert.rejects(()=>db.query("UPDATE product_media_jobs SET state='superseded',superseded_by_job_id=$2 WHERE id=$1",[f.jobId,randomUUID()]));
      const job=(await db.query('SELECT * FROM product_media_jobs WHERE id=$1',[f.jobId])).rows[0];assert.equal(job.state,'pending');assert.equal(job.superseded_by_job_id,null);
    });
    console.log(`Photo native verification used ${name}; no Magento HTTP.`);
  }finally{
    await require('../src/db/pool').end();if(db)await db.end();
    if(created)await maintenance.query(`DROP DATABASE "${name}"`);await maintenance.end();
    if(checkpoint){
      const tempRoot=path.resolve(process.env.TEMP || process.env.TMP || path.resolve(__dirname,'../migrations'));
      if(!path.resolve(checkpoint).startsWith(`${tempRoot}${path.sep}`) || !path.basename(checkpoint).startsWith('amber-photo-native-migrations-'))throw new Error('Unsafe photo native temporary path');
      await fs.rm(checkpoint,{recursive:true,force:true});
    }
  }
});
