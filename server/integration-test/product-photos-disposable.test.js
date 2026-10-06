const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const {Client,Pool}=require('pg');

test('photo migration and true PostgreSQL races use an owned canonical disposable database',async(t)=>{
  const name=`amber_photos_${Date.now()}_${process.pid}_test`;
  assert.match(name,/^amber_photos_[0-9]+_[0-9]+_test$/);
  const maintenance=new Client({connectionString:'postgresql://amber_test:amber_test_local_only@127.0.0.1:55432/postgres',connectionTimeoutMillis:3000});
  await maintenance.connect();let created=false;let db;let checkpoint;
  try {
    await maintenance.query(`CREATE DATABASE "${name}"`);created=true;
    process.env.DATABASE_URL=`postgresql://amber_test:amber_test_local_only@127.0.0.1:55432/${name}`;
    require('../test/setup-env');
    const {runMigrations}=require('../src/db/run-migrations');
    const directory=path.resolve(__dirname,'../migrations');
    // Apply the known 059 checkpoint separately before 062.
    const tempRoot=path.resolve(process.env.TEMP || process.env.TMP || path.resolve(__dirname,'../'));
    checkpoint=await fs.mkdtemp(path.join(tempRoot,'amber-photo-migrations-'));
    for(const file of (await fs.readdir(directory)).filter((f)=>/^0(?:[0-4][0-9]|5[0-9])_.*\.sql$/.test(f)))await fs.copyFile(path.join(directory,file),path.join(checkpoint,file));
    await runMigrations({directory:checkpoint});
    db=new Pool({connectionString:process.env.DATABASE_URL,max:6,connectionTimeoutMillis:3000});
    const migration=await fs.readFile(path.join(directory,'062_product_photos.sql'),'utf8');
    await t.test('062 DDL rolls back at checkpoint and installs once without changing role grants',async()=>{
      const before=(await db.query('SELECT role_id,permission_key FROM role_permissions ORDER BY role_id,permission_key')).rows;
      const client=await db.connect();try {
        await client.query('BEGIN');await client.query(migration);assert.ok((await client.query("SELECT to_regclass('product_photo_assets') AS table_name")).rows[0].table_name);
        await client.query('ROLLBACK');assert.equal((await client.query("SELECT to_regclass('product_photo_assets') AS table_name")).rows[0].table_name,null);
      }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
      await runMigrations({directory});await runMigrations({directory});
      assert.deepEqual((await db.query('SELECT role_id,permission_key FROM role_permissions ORDER BY role_id,permission_key')).rows,before);
      assert.equal((await db.query("SELECT count(*)::int AS count FROM schema_migrations WHERE name='062_product_photos.sql'")).rows[0].count,1);
    });
    const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Photo race actor') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='storekeeper'",[actor]);
    await db.query("INSERT INTO categories(code,name,requires_weight) VALUES('ZZ','Photo fixtures',1)");
    const photos=require('../src/services/product-photos.service');const gate=require('../src/services/full-product-cutover-gate');
    const access=require('../src/services/access-admin-transaction');
    const context={actorUserId:actor,requestId:'photo-postgres-fixture'};
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE5sAAAAASUVORK5CYII=','base64');
    const upload={idempotencyKey:randomUUID(),name:'race.png',mimeType:'image/png',base64:bytes.toString('base64')};
    let photo;
    async function race(operations) {
      const clients=await Promise.all(operations.map(()=>db.connect()));
      const pids=await Promise.all(clients.map(async(c)=>(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
      assert.equal(new Set(pids).size,operations.length,'race requires independent PostgreSQL connections');
      let index=0;
      const racePool={connect:async()=>clients[index++],query:db.query.bind(db)};
      return Promise.allSettled(operations.map((operation)=>operation(racePool)));
    }
    await t.test('concurrent matching stage requests produce one original and one audit receipt',async()=>{
      const results=await race([0,1].map(()=> (databasePool)=>photos.stage(upload,{databasePool,mutationContext:context})));
      assert.equal(results.filter((r)=>r.status==='fulfilled').length,2);photo=results[0].value;
      assert.equal(results[1].value.id,photo.id);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM product_photo_assets WHERE actor_user_id=$1 AND request_key=$2',[actor,upload.idempotencyKey])).rows[0].count,1);
      assert.equal((await db.query("SELECT count(*)::int AS count FROM audit_events WHERE event_key='product.photo_staged' AND subject_id=$1",[photo.id])).rows[0].count,1);
    });
    async function makeProduct(client,sku) {
      const id=Number((await client.query(`INSERT INTO products(full_sku,base_sku,category,weight,total_price,total_price_uah,details)
        VALUES($1,$1,'ZZ',1,100,100,'{}'::jsonb) RETURNING id`,[sku])).rows[0].id);
      await require('../src/services/full-product-export.service').initializeNewProduct(client,id);return id;
    }
    await t.test('attachment and audit rollback preserve the unbound original and allocate no completed job',async()=>{
      const client=await db.connect();let id;
      try {
        await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[access.APPLICATION_USER_ADMIN_LOCK_KEY]);await gate.enterExisting(client);
        id=await makeProduct(client,'PHOTO-ROLLBACK');
        await photos.attachCreatedProduct(client,id,{photoIds:[photo.id],enableWhenVerified:true},context);
        await gate.rollback(client);
      }catch(cause){await gate.rollback(client).catch(()=>{});throw cause;}
      finally{await gate.release(client).catch(()=>{});client.release();}
      assert.equal((await db.query('SELECT product_id FROM product_photo_assets WHERE id=$1',[photo.id])).rows[0].product_id,null);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM product_media_jobs WHERE product_id=$1',[id])).rows[0].count,0);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM products WHERE id=$1',[id])).rows[0].count,0);
    });
    const productIds=[];
    for(const sku of ['PHOTO-ONE','PHOTO-TWO']){
      const client=await db.connect();try{await gate.begin(client);productIds.push(await makeProduct(client,sku));await gate.commit(client);}
      catch(cause){await gate.rollback(client).catch(()=>{});throw cause;}
      finally{await gate.release(client).catch(()=>{});client.release();}
    }
    await t.test('racing attachment to different products gives one immutable owner',async()=>{
      const results=await race(productIds.map((id)=>async(databasePool)=>{
        const client=await databasePool.connect();try {
          await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[access.APPLICATION_USER_ADMIN_LOCK_KEY]);await gate.enterExisting(client);
          const result=await photos.attachCreatedProduct(client,id,{photoIds:[photo.id],enableWhenVerified:true},context);await gate.commit(client);return result;
        }catch(cause){await gate.rollback(client);throw cause;}finally{await gate.release(client);client.release();}
      }));
      assert.equal(results.filter((r)=>r.status==='fulfilled').length,1);
      assert.equal(results.find((r)=>r.status==='rejected').reason.code,'PHOTO_OWNERSHIP');
      assert.equal((await db.query('SELECT count(*)::int AS count FROM product_media_jobs')).rows[0].count,1);
    });
    const owner=Number((await db.query('SELECT product_id FROM product_photo_assets WHERE id=$1',[photo.id])).rows[0].product_id);
    await t.test('immutable originals and dispatch markers cannot be reset or truncated',async()=>{
      const job=(await db.query('SELECT id FROM product_media_jobs WHERE product_id=$1',[owner])).rows[0];
      await db.query('INSERT INTO product_media_steps(job_id,step_key,operation_hash) VALUES($1,$2,$3)',[job.id,'upload:fixture','a'.repeat(64)]);
      for(const [sql,args] of [
        ['UPDATE product_photo_assets SET content=$2 WHERE id=$1',[photo.id,Buffer.alloc(40)]],
        ['UPDATE product_photo_assets SET product_id=$2 WHERE id=$1',[photo.id,productIds.find((id)=>id!==owner)]],
        ['UPDATE product_media_steps SET operation_hash=$2 WHERE job_id=$1',[job.id,'b'.repeat(64)]],
        ['DELETE FROM product_media_steps WHERE job_id=$1',[job.id]],
        ['TRUNCATE product_media_steps',[]],
      ])await assert.rejects(()=>db.query(sql,args));
      assert.equal((await db.query('SELECT content_hash FROM product_photo_assets WHERE id=$1',[photo.id])).rows[0].content_hash,photos.sha(bytes));
      assert.equal((await db.query('SELECT count(*)::int AS count FROM product_media_steps WHERE job_id=$1',[job.id])).rows[0].count,1);
    });
    await t.test('optimistic concurrent photo changes commit one version and one job',async()=>{
      // Fixture acknowledgement is local only; this test issues no Magento HTTP.
      await db.query("UPDATE product_media_jobs SET state='succeeded',verified_at=CURRENT_TIMESTAMP WHERE product_id=$1",[owner]);
      const results=await race([0,1].map(()=> (databasePool)=>photos.save(owner,{idempotencyKey:randomUUID(),expectedVersion:'1',photoIds:[photo.id],enableWhenVerified:true},{databasePool,mutationContext:context})));
      assert.equal(results.filter((r)=>r.status==='fulfilled').length,1);
      assert.equal(results.find((r)=>r.status==='rejected').reason.code,'PHOTO_VERSION_CONFLICT');
      assert.equal((await db.query('SELECT version FROM product_photo_sets WHERE product_id=$1',[owner])).rows[0].version,'2');
      assert.equal((await db.query('SELECT count(*)::int AS count FROM product_media_jobs WHERE product_id=$1 AND version=2',[owner])).rows[0].count,1);
    });
    await t.test('independent pending restore transaction fences photo save and preserves visibility receipts',async()=>{
      const productClient=await db.connect();let guardedId;
      try {await gate.begin(productClient);guardedId=await makeProduct(productClient,'PHOTO-VISIBILITY');await gate.commit(productClient);}
      finally{await gate.release(productClient);productClient.release();}
      const staged=await photos.stage({...upload,idempotencyKey:randomUUID()},{databasePool:db,mutationContext:context});
      const product=(await db.query('SELECT p.public_product_identity_id,i.public_sku FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1',[guardedId])).rows[0];
      const origin='a'.repeat(64),hideId=randomUUID(),restoreId=randomUUID();
      await db.query(`INSERT INTO product_visibility_intents(id,product_id,public_product_identity_id,public_sku,origin_hash,kind,actor_user_id,
        previous_product,previous_lifecycle,local_fingerprint,remote_product_id,target_status,state,verified_at)
        VALUES($1,$2,$3,$4,$5,'hide',$6,'{}','{}',$5,101,2,'verified',CURRENT_TIMESTAMP)`,
      [hideId,guardedId,product.public_product_identity_id,product.public_sku,origin,actor]);
      const producer=await db.connect(),consumer=await db.connect();let awaitingSave;
      try {
        const producerPid=(await producer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const consumerPid=(await consumer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;assert.notEqual(producerPid,consumerPid);
        await producer.query('BEGIN');await producer.query('SELECT pg_advisory_xact_lock(hashtext($1))',[access.APPLICATION_USER_ADMIN_LOCK_KEY]);await gate.enterExisting(producer);
        await producer.query('SELECT id FROM products WHERE id=$1 FOR NO KEY UPDATE',[guardedId]);
        await producer.query(`INSERT INTO product_visibility_intents(id,product_id,public_product_identity_id,public_sku,origin_hash,kind,source_hide_id,
          actor_user_id,previous_product,previous_lifecycle,local_fingerprint,remote_product_id,target_status,expected_generation,state)
          VALUES($1,$2,$3,$4,$5,'restore',$6,$7,'{}','{}',$5,101,2,1,'queued')`,
        [restoreId,guardedId,product.public_product_identity_id,product.public_sku,origin,hideId,actor]);
        awaitingSave=photos.save(guardedId,{idempotencyKey:randomUUID(),expectedVersion:'0',photoIds:[staged.id],enableWhenVerified:true},
          {databasePool:{connect:async()=>consumer},mutationContext:context}).then((value)=>({value}),(cause)=>({cause}));
        let waited=false;
        for(let attempt=0;attempt<40;attempt++) {
          waited=(await db.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",[consumerPid])).rowCount>0;
          if(waited)break;await new Promise((resolve)=>setTimeout(resolve,20));
        }
        assert.equal(waited,true,'photo save must wait on the independent lifecycle transaction fence');
        await gate.commit(producer);const result=await awaitingSave;assert.equal(result.cause?.code,'PHOTO_VISIBILITY_UNRESOLVED');assert.equal(result.cause.statusCode,409);
      }finally {await gate.rollback(producer).catch(()=>{});await gate.release(producer).catch(()=>{});producer.release();if(!awaitingSave)consumer.release();}
      const snapshot=(await db.query('SELECT * FROM product_visibility_intents WHERE id=$1',[restoreId])).rows[0];
      await assert.rejects(()=>photos.save(guardedId,{idempotencyKey:randomUUID(),expectedVersion:'0',photoIds:[staged.id],enableWhenVerified:true},
        {databasePool:db,mutationContext:context}),{code:'PHOTO_VISIBILITY_UNRESOLVED'});
      assert.deepEqual((await db.query('SELECT * FROM product_visibility_intents WHERE id=$1',[restoreId])).rows[0],snapshot);
      assert.equal((await db.query('SELECT product_id FROM product_photo_assets WHERE id=$1',[staged.id])).rows[0].product_id,null);
      assert.equal((await db.query('SELECT count(*)::int AS count FROM product_media_jobs WHERE product_id=$1',[guardedId])).rows[0].count,0);
      await db.query("UPDATE product_visibility_intents SET state='dispatched',dispatched_at=CURRENT_TIMESTAMP WHERE id=$1",[restoreId]);
      const dispatched=(await db.query('SELECT * FROM product_visibility_intents WHERE id=$1',[restoreId])).rows[0];
      await assert.rejects(()=>photos.save(guardedId,{idempotencyKey:randomUUID(),expectedVersion:'0',photoIds:[staged.id],enableWhenVerified:true},
        {databasePool:db,mutationContext:context}),{code:'PHOTO_VISIBILITY_UNRESOLVED'});
      assert.deepEqual((await db.query('SELECT * FROM product_visibility_intents WHERE id=$1',[restoreId])).rows[0],dispatched);
      await db.query("UPDATE product_visibility_intents SET state='verified',verified_at=CURRENT_TIMESTAMP WHERE id=$1",[restoreId]);
      assert.equal((await photos.save(guardedId,{idempotencyKey:randomUUID(),expectedVersion:'0',photoIds:[staged.id],enableWhenVerified:true},
        {databasePool:db,mutationContext:context})).version,'1');
    });
    await t.test('current permission revocation blocks staging on a previously active actor',async()=>{
      await db.query('UPDATE application_users SET status=$2 WHERE id=$1',[actor,'disabled']);
      await assert.rejects(()=>photos.stage({...upload,idempotencyKey:randomUUID()},{databasePool:db,mutationContext:context}),{code:'INSUFFICIENT_PERMISSION'});
    });
    await t.test('photo reads bind metadata, current version and current delivery to one statement',async()=>{
      const current=await photos.read(owner,{databasePool:db});
      assert.equal(current.productId,owner);assert.equal(current.version,'2');assert.deepEqual(current.photos.map((p)=>p.id),[photo.id]);
      assert.equal(current.delivery.state,'pending');assert.equal(current.delivery.code,'PHOTO_NATIVE_SYNC_REQUIRED');
      const untouched=await photos.read(productIds.find((id)=>id!==owner),{databasePool:db});
      assert.equal(untouched.version,'0');assert.deepEqual(untouched.photos,[]);assert.equal(untouched.delivery,null);
    });
    await require('../src/db/pool').end();
    console.log(`Photo PostgreSQL verification completed in ${name}; only mock/native local fixtures were used.`);
  }finally{
    if(db)await db.end();
    if(created)await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
    if(checkpoint){
      const allowedRoot=path.resolve(process.env.TEMP || process.env.TMP || path.resolve(__dirname,'../'));
      if(!path.resolve(checkpoint).startsWith(`${allowedRoot}${path.sep}`) || !path.basename(checkpoint).startsWith('amber-photo-migrations-'))throw new Error('Unsafe temporary migration path');
      await fs.rm(checkpoint,{recursive:true,force:true});
    }
  }
});
