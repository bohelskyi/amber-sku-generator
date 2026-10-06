const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client, Pool } = require('pg');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('reviewed historical standard REST intents reuse normal outbox and preserve unknown prior facts', async t => {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = `amber_historical_standard_${process.pid}_${randomBytes(6).toString('hex')}_test`;
  const marker = process.env.CODEX_FINAL_DB_MARKER || `historical-standard-owned-${randomUUID()}`;
  assert.match(marker,/^[a-z0-9-]{1,160}$/);
  const expectedDatabases=[...new Set(['amber_test','postgres','template0','template1',source.pathname.slice(1)])].sort();
  const control = new Client({ connectionString: source.toString() }); await control.connect();
  let db, appPool, checkpoint, created = false;
  try {
    assert.deepEqual((await control.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r => r.datname),expectedDatabases);
    assert.equal((await control.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0);
    await control.query(`CREATE DATABASE ${name}`); created = true;
    await control.query(`COMMENT ON DATABASE ${name} IS '${marker}'`);
    const url = new URL(source); url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString(); process.env.MAGENTO_BASE_URL = ''; process.env.NBU_RATE_OVERRIDE = '40';
    require('../test/setup-env');
    appPool = require('../src/db/pool'); db = new Pool({ connectionString: url.toString(), max: 8 });
    const migrations=path.resolve(__dirname,'../migrations');
    checkpoint=await fs.mkdtemp(path.join(os.tmpdir(),'historical-checkpoint-'));
    for(const file of (await fs.readdir(migrations)).filter(f=>/^\d{3}_.*\.sql$/.test(f)&&Number(f.slice(0,3))<=65))await fs.copyFile(path.join(migrations,file),path.join(checkpoint,file));
    await require('../src/db/run-migrations').runMigrations({directory:checkpoint});
    const c = require('../src/services/magento/binding-contract');
    const { insertProductFixture } = require('./product-fixture');
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Historical fixture') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
    await db.query("INSERT INTO categories(code,name,requires_weight) VALUES('BR','Historical fixture',0)");
    for(const category of ['NM','KL','CH','AR','SV'])await db.query('INSERT INTO categories(code,name,requires_weight) VALUES($1,$1,0)',[category]);
    const products = [];
    for (let i=0;i<70;i++) products.push((await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah,weight,status,exclude_from_export,details)
      VALUES($1,'BR',240,12.7,'archived',1,'{"answers":{"weight":12.7},"logMessage":"unknown prior archive"}') RETURNING *`, [`BR3/HISTORY-${i}-${randomUUID()}`])).rows[0]);
    await t.test('066 on existing historical archives and repeated migration startup never enroll or alter prior facts',async()=>{
      const snapshot=async()=>(await db.query(`SELECT (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,
        (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) lifecycle,
        (SELECT jsonb_agg(r ORDER BY public_product_identity_id) FROM magento_product_sync_requests r) requests,
        (SELECT jsonb_agg(j ORDER BY id) FROM magento_sync_jobs j) jobs,
        (SELECT jsonb_agg(i ORDER BY id) FROM public_product_identities i) identities,
        (SELECT jsonb_agg(r ORDER BY full_sku) FROM sku_registry r) registry,(SELECT count(*)::int FROM audit_events) audits`)).rows[0];
      const before=await snapshot();await require('../src/db/run-migrations').runMigrations();await require('../src/db/run-migrations').runMigrations();
      const after=await snapshot();
      assert.equal(before.identities.length,products.length,'nonempty original identities remain part of the history proof');
      after.identities=after.identities.map(identity=>{
        const {is_test_product,test_allocation_number,...original}=identity;
        assert.equal(is_test_product,false,'069 does not classify an existing historical identity as TEST');
        assert.equal(test_allocation_number,null,'069 does not allocate a TEST number for existing history');
        return original;
      });
      // Compare every original column and every ledger; omit only the two
      // independently asserted additive 069 metadata fields.
      assert.deepEqual(after,before);
      for(const table of ['historical_reactivation_batches','historical_reactivation_intents','historical_standard_batches','historical_standard_intents'])assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
    });
    await t.test('without historical intent, request DELETE removes its row and existing permanent lifecycle guards still reject DELETE',async()=>{
      const product=products[0],client=await db.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id) VALUES($1,$2)',[product.public_product_identity_id,product.id]);
        assert.equal((await client.query('DELETE FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[product.public_product_identity_id])).rowCount,1);
        assert.equal((await client.query('SELECT 1 FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[product.public_product_identity_id])).rowCount,0);
        await client.query('INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id) VALUES($1,$2)',[product.public_product_identity_id,product.id]);
      } finally {await client.query('ROLLBACK');client.release();}
      await assert.rejects(db.query('DELETE FROM product_full_export_state WHERE product_id=$1',[product.id]),/full product export state is permanent/);
      assert.equal((await db.query('SELECT 1 FROM product_full_export_state WHERE product_id=$1',[product.id])).rowCount,1);
    });
    const config = { configured:true,baseUrl:'https://historical-fixture.invalid',consumerKey:'synthetic-consumer-unique',consumerSecret:'synthetic-secret-unique',accessToken:'synthetic-access-unique',accessTokenSecret:'synthetic-access-secret-unique' };
    const origin = c.originHash(config.baseUrl);
    const fixture = require('../test/fixtures/magento-bindings');
    const definition = structuredClone(fixture.definition());
    definition.sources = { sku:definition.sources.sku, price:{kind:'product',field:'total_price_uah',type:'scalar'} }; definition.tables = {};
    for(const group of definition.groups) for(const row of group.rows) {
      row.cells = Object.fromEntries(Object.entries(row.cells).filter(([key])=>['sku','store_view_code','name','attribute_set_code','product_type','price','product_online','visibility'].includes(key)));
      row.cells.price = row.id==='base'?{op:'text',input:{op:'source',id:'price'},trim:false,format:'scalar-v1',onAbsent:'empty'}:{op:'literal',value:''};
      row.cells.product_online={op:'literal',value:row.id==='base'?'2':''};
      row.cells.visibility={op:'literal',value:row.id==='base'?'Catalog, Search':''};
    }
    const options = { databasePool:db,config,reviewSecret:'synthetic-historical-review-secret',actorUserId:actor,mutationContext:{actorUserId:actor,requestId:'historical-fixture'} };
    const templates=require('../src/services/export-templates/template.service');
    const family=await templates.createTemplate({key:'historical-fixture',displayName:'Historical fixture',definition},options);
    const version=await templates.publishTemplate(family.id,{expectedRevision:family.draft.revision,expectedDefinitionHash:family.draft.definitionHash},options);
    const bindings=require('../src/services/magento/binding.service');
    const schema=fixture.schema();schema.attributes.find(a=>a.attribute_code==='name').scope='store';
    let draft=await bindings.createDraft({installationKey:'historical-fixture',origin:config.baseUrl,templateVersionId:version.id,observedAt:new Date().toISOString(),schema},options);
    const decisions=fixture.approvedBindings(definition,schema);
    const englishNameKey=require('../src/services/magento/binding-validation').bindingKey(decisions.routes.find(r=>r.enabled).routeKey,'english','name');
    decisions.policies.forEach(p=>{p.policy=p.storeCode==='en'&&p.bindingKey!==englishNameKey?'magento_managed':'authoritative_create_update';});
    const native={attribute_set_code:'attribute_set_id',product_type:'type_id',store_view_code:'store_view_code',product_online:'status',visibility:'visibility'};
    decisions.attributes.forEach(a=>{if(a.strategy==='transport_control')a.transportTarget=`product.${native[a.target]}`;});
    for(const attribute of decisions.attributes){
      const key=require('../src/services/magento/binding-validation').bindingKey(attribute.routeKey,attribute.rowId,attribute.target);
      const policy=decisions.policies.find(p=>p.bindingKey===key);
      if(attribute.target==='product_online'){policy.policy='initialize_create_only';policy.evidence={createValue:2};}
      if(attribute.target==='visibility')policy.policy='initialize_create_only';
    }
    draft=await bindings.updateDraft(draft.id,{expectedRevision:draft.revision,bindings:decisions},options);
    const published=await bindings.publishDraft(draft.id,{expectedRevision:draft.revision,expectedCurrentId:null},options);
    const client=await db.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL amber.lifecycle_maintenance='on'"); await client.query("SET LOCAL amber.magento_delivery_cutover='on'");
      const event=(await client.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
        VALUES('product.fixture',$1,'{"displayName":"Historical fixture","preferredUsername":null}','fixture','historical','fixture') RETURNING id`,[actor])).rows[0].id;
      await client.query(`UPDATE full_product_export_activation SET phase='preparing',generation=generation+1,manifest_hash=$1,approval_event_id=$2 WHERE singleton`,[c.hash('historical'),event]);
      await client.query(`UPDATE full_product_export_activation SET phase='active',selector_version=1,generation=generation+1,activation_event_id=$1 WHERE singleton`,[event]);
      await client.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='historical-fixture',actor_user_id=$1,legacy_product_csv_enabled=FALSE,
        cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`,[actor,event]);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    const rawBySku=new Map(products.map(p=>[p.full_sku,{id:p.id+10000,sku:p.full_sku,attribute_set_id:8001,name:'Fixture name',price:200,status:1,visibility:4,type_id:'simple',
      custom_attributes:[],extension_attributes:{category_links:[],website_ids:[801]}}]));
    const writes=[],requests=[];let invisible=false,loseResponse=false,nextId=20000;
    options.discover=async()=>schema;
    options.preview=(cfg,args)=>require('../src/services/magento/sync-preview').previewProduct(cfg,{...args,discover:options.discover});
    options.fetchImpl=async(url,input={})=>{
      const u=new URL(url),method=input.method || 'GET';requests.push({method,path:u.pathname});
      assert.equal(u.origin,'https://historical-fixture.invalid');assert.ok(!u.pathname.includes('/amber/'),'New standard lane never requests the custom adapter');
      if(method==='GET' && u.pathname.endsWith('/categories'))return new Response(JSON.stringify({id:803,parent_id:1,name:'Default',children_data:[]}),{headers:{'content-type':'application/json'}});
      if(method==='GET' && u.pathname.endsWith('/products')){
        const sku=[...u.searchParams].find(([key])=>key.includes('[value]'))?.[1],raw=rawBySku.get(sku);
        return new Response(JSON.stringify({items:raw?[raw]:[],total_count:raw?1:0}),{headers:{'content-type':'application/json'}});
      }
      if(method==='POST' && /^\/rest\/(all|en)\/V1\/products$/.test(u.pathname)){
        const body=JSON.parse(input.body);writes.push({url,body});
        if(!invisible){const raw=rawBySku.get(body.product.sku) || {id:nextId++,sku:body.product.sku,custom_attributes:[],extension_attributes:{category_links:[],website_ids:[]}};
          Object.assign(raw,body.product);rawBySku.set(raw.sku,raw);}
        if(loseResponse)throw new Error('synthetic lost response');
        return new Response(JSON.stringify(rawBySku.get(body.product.sku) || {}),{headers:{'content-type':'application/json'}});
      }
      assert.fail(`No real/unbounded transport allowed: ${method} ${u.pathname}`);
    };
    const service=require('../src/services/historical-standard-reactivation.service'),worker=require('../src/services/magento/historical-standard-worker');
    const command=(review,selectedSkus,selectedCreateSkus=[])=>({skus:review.skus,selectedSkus,selectedCreateSkus,reviewNonce:review.reviewNonce,
      reviewHash:review.reviewHash,reviewToken:review.reviewToken,reviewExpiresAt:review.reviewExpiresAt,idempotencyKey:randomUUID(),confirmCurrentFactsAndStandardDelivery:true});
    const mutate=(sql,values)=>require('../src/services/access-admin-transaction').runAccessAdminMutation({databasePool:db,actorUserId:actor,requiredPermission:'products.archive',createError:c.error,operation:client=>client.query(sql,values)});
    const local=async p=>(await db.query('SELECT p.*,i.public_sku FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1',[p.id])).rows[0];
    const operations=require('../src/services/historical-review-operations');
    await t.test('durable 48/70 reviews return registration before slow Magento, share fresh metadata once and resume by actor-owned GET',async()=>{
      for(const count of [48,70]) {
        const id=randomUUID(),input={operationId:id,skus:products.slice(0,count).map(p=>p.full_sku)};
        let discoveries=0,categoryReads=0,release,entered;
        const barrier=new Promise(resolve=>{entered=resolve;});
        const wait=new Promise(resolve=>{release=resolve;});
        const opts={...options,discover:async()=>{discoveries++;return schema;},fetchImpl:async(url,init)=>{
          if(new URL(url).pathname.endsWith('/categories'))categoryReads++;
          if(new URL(url).pathname.endsWith('/products')){entered();await wait;}
          return options.fetchImpl(url,init);
        }};
        const ack=await operations.start('preview',input,opts);
        assert.equal(ack.state,'queued');assert.equal(discoveries,0);assert.equal(ack.result,null);
        const pending=operations.run(id,opts);await barrier;
        try {
          const snapshot=await operations.read(id,opts);assert.equal(snapshot.state,'running');assert.equal(snapshot.result,null);
          assert.equal((await operations.start('preview',input,opts)).operationId,id);
          await assert.rejects(operations.start('preview',{...input,skus:['DIFFERENT']},opts),{code:'HISTORICAL_IDEMPOTENCY_CONFLICT'});
          assert.equal(await operations.run(id,opts),undefined,'Independent connection cannot duplicate a claimed operation');
        } finally {release();}
        const ready=await pending;assert.equal(ready.state,'ready');assert.equal(ready.result.items.length,count);
        assert.equal(ready.result.counts.eligible,count);assert.equal(ready.progress.completed,count);assert.equal(discoveries,1);assert.equal(categoryReads,1);
        const recovered=await operations.read(id,opts);assert.deepEqual(recovered.result,ready.result);assert.equal(discoveries,1,'GET recovery does not rediscover Magento');
        assert.deepEqual((await operations.run(id,opts)).result,ready.result,'Terminal work is not executed again');
        const other=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Other fixture') RETURNING id")).rows[0].id);
        await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[other]);
        await assert.rejects(operations.read(id,{...opts,actorUserId:other}),{code:'HISTORICAL_OPERATION_NOT_FOUND'});
        await assert.rejects(db.query('DELETE FROM historical_review_operations WHERE id=$1',[id]),/permanent/);
        await assert.rejects(db.query("UPDATE historical_review_operations SET result='{}' WHERE id=$1",[id]),/cannot be rewritten/);
      }
      assert.equal(writes.length,0);
    });
    await t.test('midway error and deadline have no partial selectable result; stale running work resumes after process loss',async()=>{
      const id=randomUUID(),input={operationId:id,skus:products.slice(20,26).map(p=>p.full_sku)};
      await operations.start('preview',input,options);
      let reads=0;
      const failed=await operations.run(id,{...options,fetchImpl:async(url,init)=>{
        if(new URL(url).pathname.endsWith('/products') && ++reads===3)throw Object.assign(new Error('synthetic midway'),{code:'MAGENTO_NETWORK_ERROR'});
        return options.fetchImpl(url,init);
      }});
      assert.equal(failed.state,'failed');assert.equal(failed.result,null);assert.ok(failed.progress.completed<6);
      const expiredId=randomUUID();await operations.start('preview',{operationId:expiredId,skus:[products[20].full_sku]},{...options,now:()=>Date.now()-600000});
      const expired=await operations.run(expiredId,options);assert.equal(expired.state,'failed');assert.equal(expired.failureCode,'HISTORICAL_OPERATION_DEADLINE');assert.equal(expired.result,null);
      const resumedId=randomUUID();await operations.start('preview',{operationId:resumedId,skus:[products[20].full_sku]},options);
      await db.query("UPDATE historical_review_operations SET state='running',run_token=$2,started_at=CURRENT_TIMESTAMP WHERE id=$1",[resumedId,randomUUID()]);
      assert.equal((await operations.run(resumedId,options)).state,'ready');assert.equal(writes.length,0);
    });
    await t.test('durable confirm accepts repeated exact request once and atomically stores its result with intents; failure rolls back both',async()=>{
      for(const rollback of [false,true]) {
        const product=products[rollback?21:20],review=await service.preview({skus:[product.full_sku]},options),input=command(review,[product.full_sku]);
        const registered=await operations.start('confirm',input,options);assert.equal(registered.state,'queued');
        assert.equal((await db.query('SELECT 1 FROM historical_standard_batches WHERE id=$1',[input.idempotencyKey])).rowCount,0);
        if(rollback) {
          await db.query(`ALTER TABLE historical_review_operations ADD CONSTRAINT synthetic_review_write_failure CHECK (id<>$1 OR state<>'ready')`.replace('$1',"'"+input.idempotencyKey+"'"));
          try {await assert.rejects(operations.run(input.idempotencyKey,options));}
          finally {await db.query('ALTER TABLE historical_review_operations DROP CONSTRAINT synthetic_review_write_failure');}
          assert.equal((await db.query('SELECT 1 FROM historical_standard_batches WHERE id=$1',[input.idempotencyKey])).rowCount,0);
          assert.equal((await db.query('SELECT 1 FROM historical_standard_intents WHERE batch_id=$1',[input.idempotencyKey])).rowCount,0);
          assert.equal((await operations.read(input.idempotencyKey,options)).state,'running');
        }
        const ready=await operations.run(input.idempotencyKey,options);assert.equal(ready.state,'ready');assert.equal(ready.result.items.length,1);
        const repeated=await Promise.all([operations.start('confirm',input,options),operations.start('confirm',input,options)]);
        for(const value of repeated)assert.deepEqual(value.result,ready.result);
        assert.equal((await db.query('SELECT 1 FROM historical_standard_intents WHERE batch_id=$1',[input.idempotencyKey])).rowCount,1);
        await assert.rejects(operations.start('confirm',{...input,selectedSkus:[products[22].full_sku]},options),{code:'HISTORICAL_IDEMPOTENCY_CONFLICT'});
        assert.equal((await local(product)).status,'archived');
      }
      assert.equal(writes.length,0);
    });
    await t.test('durable CREATE still requires explicit consent and revocation after registration prevents worker review',async()=>{
      const product=products[24];rawBySku.delete(product.full_sku);
      const review=await service.preview({skus:[product.full_sku]},options);
      assert.equal(review.items[0].deliveryMode,'create');
      const refused=command(review,[product.full_sku]);await operations.start('confirm',refused,options);
      const denied=await operations.run(refused.idempotencyKey,options);assert.equal(denied.state,'failed');assert.equal(denied.failureCode,'HISTORICAL_SELECTION_INVALID');
      assert.equal((await db.query('SELECT 1 FROM historical_standard_intents WHERE batch_id=$1',[refused.idempotencyKey])).rowCount,0);
      const accepted=command(review,[product.full_sku],[product.full_sku]);await operations.start('confirm',accepted,options);
      const ready=await operations.run(accepted.idempotencyKey,options);assert.equal(ready.state,'ready');assert.equal(ready.result.items[0].targetStatus,2);
      assert.equal(ready.result.items[0].deliveryMode,'create');assert.equal(writes.length,0);assert.equal((await local(product)).status,'archived');
      const other=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Revoked fixture') RETURNING id")).rows[0].id);
      await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[other]);
      const own={...options,actorUserId:other},id=randomUUID();await operations.start('preview',{operationId:id,skus:[products[25].full_sku]},own);
      await db.query("UPDATE application_users SET status='disabled' WHERE id=$1",[other]);
      assert.equal((await operations.run(id,options)).failureCode,'ADMIN_PERMISSION_REVOKED');
      await assert.rejects(operations.read(id,own),{code:'ADMIN_PERMISSION_REVOKED'});
      assert.equal((await db.query('SELECT result FROM historical_review_operations WHERE id=$1',[id])).rows[0].result,null);
    });
    await t.test('expiry during the confirmation transaction rolls back its intents and durable ready result together',async()=>{
      const product=products[23],review=await service.preview({skus:[product.full_sku]},options);
      const expires=new Date(Date.now()+10000).toISOString();review.reviewExpiresAt=expires;
      const {reviewHash:ignoredHash,reviewToken:ignoredToken,counts:ignoredCounts,...proof}=review;void ignoredHash;void ignoredToken;void ignoredCounts;
      review.reviewHash=c.hash(proof);review.reviewToken=require('../src/services/historical-reactivation-state').signReview(actor,proof,options.reviewSecret);
      const input=command(review,[product.full_sku]);await operations.start('confirm',input,options);
      await db.query('CREATE SEQUENCE synthetic_slow_historical_confirmation_counter');
      await db.query(`CREATE FUNCTION synthetic_slow_historical_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('synthetic_slow_historical_confirmation_counter'); PERFORM pg_sleep(11); RETURN NEW; END $$`);
      await db.query('CREATE TRIGGER synthetic_slow_historical_confirmation BEFORE INSERT ON historical_standard_batches FOR EACH ROW EXECUTE FUNCTION synthetic_slow_historical_confirmation()');
      let result;
      try {result=await operations.run(input.idempotencyKey,options);}
      finally {await db.query('DROP TRIGGER synthetic_slow_historical_confirmation ON historical_standard_batches');await db.query('DROP FUNCTION synthetic_slow_historical_confirmation()');}
      const reached=(await db.query('SELECT is_called FROM synthetic_slow_historical_confirmation_counter')).rows[0].is_called;
      await db.query('DROP SEQUENCE synthetic_slow_historical_confirmation_counter');
      assert.equal(reached,true,'Confirmation reached the actual transaction before expiry');
      assert.equal(result.state,'failed');assert.equal(result.failureCode,'HISTORICAL_OPERATION_DEADLINE');
      assert.equal(result.result,null);assert.equal((await db.query('SELECT 1 FROM historical_standard_batches WHERE id=$1',[input.idempotencyKey])).rowCount,0);
      assert.equal((await db.query('SELECT 1 FROM historical_standard_intents WHERE batch_id=$1',[input.idempotencyKey])).rowCount,0);
      assert.equal((await local(product)).status,'archived');assert.equal(writes.length,0);
    });
    await t.test('read-only review distinguishes existing UPDATE from absent CREATE without a custom adapter or old-hide proof',async()=>{
      rawBySku.delete(products[1].full_sku);
      const before=(await db.query('SELECT count(*)::int n FROM audit_events')).rows[0].n;
      const preview=await service.preview({skus:[products[0].full_sku,products[1].full_sku,'NOT-LOCAL']},options);
      assert.equal(preview.items[0].disposition,'eligible',JSON.stringify(preview.items[0]));assert.equal(preview.items[0].deliveryMode,'update');
      assert.equal(preview.items[0].targetStatus,1);assert.equal(preview.items[0].targetVisibility,4);
      assert.equal(preview.items[1].disposition,'eligible',JSON.stringify(preview.items[1]));assert.equal(preview.items[1].deliveryMode,'create');
      assert.equal(preview.items[1].requiresExplicitCreate,true);assert.equal(preview.items[1].targetStatus,2);assert.equal(preview.items[1].targetVisibility,4);
      assert.equal(preview.items[2].reasonCode,'HISTORICAL_PRODUCT_NOT_FOUND');
      assert.equal((await db.query('SELECT count(*)::int n FROM audit_events')).rows[0].n,before);assert.equal(writes.length,0);
      const ordinary=await require('../src/services/product-lifecycle.service').preview({skus:[products[0].full_sku]},options);
      assert.equal(ordinary.items[0].reasonCode,'PRODUCT_ARCHIVE_PROOF_MISSING');
    });
    await t.test('review shows only a checked plan name or the exact observed counterpart, never an invented local title',async()=>{
      const sku=products[0].full_sku;
      const actual=require('../src/services/magento/sync-preview').previewProduct;
      const projected=(name)=>({...options,previewProduct:async(cfg,args)=>{
        const report=await actual(cfg,args);
        report.candidatePayload.product.name=name;
        return report;
      }});
      const before=writes.length;
      const named=await service.preview({skus:[sku]},projected('Перевірена назва товару'));
      assert.equal(named.items[0].currentName,'Перевірена назва товару');
      const observed=await service.preview({skus:[sku]},projected(undefined));
      assert.equal(observed.items[0].currentName,rawBySku.get(sku).name);
      const unknown=await service.preview({skus:[sku]},projected(''));
      assert.equal(unknown.items[0].currentName,null);
      assert.equal(writes.length,before);
      assert.equal((await db.query('SELECT status FROM products WHERE id=$1',[products[0].id])).rows[0].status,'archived');
    });
    await t.test('independent same-UUID confirms enroll one UPDATE; normal verified job preserves status/visibility and immutable product facts',async()=>{
      const product=products[0],before=await local(product),review=await service.preview({skus:[product.full_sku]},options),input=command(review,[product.full_sku]);
      const [a,b]=await Promise.all([service.confirm(input,options),service.confirm(input,options)]);assert.deepEqual(a,b);
      assert.equal((await local(product)).status,'archived','No local reactivation precedes the ordinary delivery receipt');
      const result=await worker.runIntent(config,a.items[0].intentId,options);assert.equal(result.state,'completed',JSON.stringify(result));
      const after=await local(product);assert.equal(after.status,'active');assert.equal(after.full_sku,before.full_sku);assert.equal(after.public_sku,before.public_sku);
      assert.deepEqual(after.details,before.details);assert.equal(after.weight,before.weight);assert.equal(after.total_price_uah,before.total_price_uah);
      assert.equal(rawBySku.get(product.full_sku).status,1);assert.equal(rawBySku.get(product.full_sku).visibility,4);assert.equal(rawBySku.get(product.full_sku).price,240);
      assert.ok(result.delivery_verified_at);assert.ok(result.local_activated_at);const job=(await db.query('SELECT * FROM magento_sync_jobs WHERE id=$1',[result.native_job_id])).rows[0];
      assert.equal(job.intent.mode,'update');assert.equal(job.state,'succeeded');assert.equal(job.automatic_generation,null);
      assert.deepEqual(await service.confirm(input,{...options,now:()=>Date.now()+600000}),await service.readBatch(a.batchId,options));
      await assert.rejects(service.confirm({...input,selectedCreateSkus:[product.full_sku]},options),{code:'HISTORICAL_IDEMPOTENCY_CONFLICT'});
    });
    await t.test('absent counterpart CREATE requires an explicit reviewed create subset and uses the same public identity disabled status2',async()=>{
      const product=products[1],review=await service.preview({skus:[product.full_sku]},options);
      await assert.rejects(service.confirm(command(review,[product.full_sku]),options),{code:'HISTORICAL_SELECTION_INVALID'});
      const accepted=await service.confirm(command(review,[product.full_sku],[product.full_sku]),options);
      const result=await worker.runIntent(config,accepted.items[0].intentId,options);assert.equal(result.state,'completed',JSON.stringify(result));
      const raw=rawBySku.get(product.full_sku);assert.equal(Number(result.confirmed_remote_product_id),raw.id);assert.equal(raw.sku,product.full_sku);assert.equal(raw.status,2);assert.equal(raw.visibility,4);
      assert.equal(raw.price,240);assert.equal((await local(product)).public_product_identity_id,product.public_product_identity_id);
      assert.equal((await db.query("SELECT intent->>'mode' mode FROM magento_sync_jobs WHERE id=$1",[result.native_job_id])).rows[0].mode,'create');
    });
    await t.test('changed existing identity or absent-to-present observation stops before dispatch without activating local archive',async()=>{
      for(const [index,absent] of [[2,false],[3,true]]){
        const product=products[index];if(absent)rawBySku.delete(product.full_sku);
        const review=await service.preview({skus:[product.full_sku]},options),accepted=await service.confirm(command(review,[product.full_sku],absent?[product.full_sku]:[]),options),before=writes.length;
        rawBySku.set(product.full_sku,{...rawBySku.get(products[4].full_sku),sku:product.full_sku,id:30000+index});
        const result=await worker.runIntent(config,accepted.items[0].intentId,options);assert.equal(result.state,'blocked');
        assert.equal(writes.length,before);assert.equal((await local(product)).status,'archived');
      }
    });
    await t.test('stale Manager price rejects confirmation, and pending intent fences local edits plus competing enqueue',async()=>{
      const stale=products[4],review=await service.preview({skus:[stale.full_sku]},options);
      await mutate('UPDATE products SET total_price_uah=241 WHERE id=$1',[stale.id]);
      await assert.rejects(service.confirm(command(review,[stale.full_sku]),options),{code:'HISTORICAL_REVIEW_STALE'});
      const product=products[5],fresh=await service.preview({skus:[product.full_sku]},options),accepted=await service.confirm(command(fresh,[product.full_sku]),options);
      await assert.rejects(mutate('UPDATE products SET total_price_uah=241 WHERE id=$1',[product.id]),/HISTORICAL_STANDARD_PENDING/);
      await assert.rejects(db.query(`INSERT INTO magento_sync_jobs(id,product_id,public_product_identity_id,sku,installation_key,origin_hash,binding_revision_id,binding_hash,amber_hash,plan_hash,intent,baseline,created_by_user_id)
        VALUES($1,$2,$3,$4,'historical-fixture',$5,$6,$7,$7,$7,'{"mode":"create"}','{}',$8)`,[randomUUID(),product.id,product.public_product_identity_id,product.full_sku,origin,published.id,c.hash('competing'),actor]),/HISTORICAL_STANDARD_ORIGINAL_JOB_REQUIRED/);
      assert.equal(accepted.items[0].state,'queued');
    });
    await t.test('lost reply has a sticky ordinary dispatch receipt; restart GET reconciliation never repeats POST',async()=>{
      const product=products[6],review=await service.preview({skus:[product.full_sku]},options),accepted=await service.confirm(command(review,[product.full_sku]),options);
      invisible=true;loseResponse=true;const before=writes.length;
      let result=await worker.runIntent(config,accepted.items[0].intentId,options);assert.equal(result.state,'delivering');assert.equal(writes.length,before+1);
      const job=(await db.query('SELECT * FROM magento_sync_jobs WHERE id=$1',[result.native_job_id])).rows[0];assert.equal(job.state,'uncertain');
      await assert.rejects(worker.cancel({intentId:result.id,confirmNoDispatchCancellation:true},options),{code:'HISTORICAL_DELIVERY_RECONCILIATION_REQUIRED'});
      result=await worker.runIntent(config,result.id,options);assert.equal(writes.length,before+1);assert.equal((await local(product)).status,'archived');
      Object.assign(rawBySku.get(product.full_sku),job.intent.operations[0].payload.product);invisible=false;loseResponse=false;
      result=await worker.runIntent(config,result.id,options);assert.equal(result.state,'completed',JSON.stringify(result));assert.equal(writes.length,before+1);
      assert.equal((await local(product)).status,'active');
    });
    await t.test('explicit predispatch cancellation preserves the old review and allows fresh reviewed enrollment, including a lost enqueue reply',async()=>{
      const blocked=(await db.query('SELECT * FROM historical_standard_intents WHERE product_id=$1',[products[2].id])).rows[0],before=writes.length;
      const cancelled=await worker.cancel({intentId:blocked.id,confirmNoDispatchCancellation:true},options);
      assert.equal(cancelled.state,'cancelled');assert.equal((await local(products[2])).status,'archived');assert.equal(writes.length,before);
      assert.equal((await db.query('SELECT remote_product_id FROM historical_standard_intents WHERE id=$1',[blocked.id])).rows[0].remote_product_id,blocked.remote_product_id);
      const review=await service.preview({skus:[products[2].full_sku]},options);assert.equal(review.items[0].disposition,'eligible');
      const product=products[9],fresh=await service.preview({skus:[product.full_sku]},options),accepted=await service.confirm(command(fresh,[product.full_sku]),options);
      const job=await require('../src/services/magento/sync-job.service').enqueue(config,{sku:product.full_sku,bindingRevisionId:published.id},options);
      assert.equal((await db.query('SELECT native_job_id FROM historical_standard_intents WHERE id=$1',[accepted.items[0].intentId])).rows[0].native_job_id,null,'Simulate response lost before attachment');
      const receipt=await worker.cancel({intentId:accepted.items[0].intentId,confirmNoDispatchCancellation:true},options);
      assert.equal(receipt.nativeJobId,job.id);assert.equal(receipt.state,'cancelled');assert.equal((await db.query('SELECT state FROM magento_sync_jobs WHERE id=$1',[job.id])).rows[0].state,'superseded');
      assert.equal(writes.length,before);
      const completed=(await db.query('SELECT id FROM historical_standard_intents WHERE product_id=$1',[products[0].id])).rows[0];
      await assert.rejects(worker.cancel({intentId:completed.id,confirmNoDispatchCancellation:true},options),{code:'HISTORICAL_DELIVERY_ALREADY_CONFIRMED'});
    });
    await t.test('lineage/ancestor and immutable historical receipts remain closed; restart performs no new enrollment',async()=>{
      const product=products[7];await mutate('UPDATE products SET corrected_from_product_id=$2 WHERE id=$1',[product.id,products[8].id]);
      const review=await service.preview({skus:[product.full_sku]},options);assert.equal(review.items[0].reasonCode,'HISTORICAL_LINEAGE_BLOCKED');
      const before=(await db.query('SELECT count(*)::int n FROM historical_standard_intents')).rows[0].n;
      await require('../src/db/run-migrations').runMigrations();assert.equal((await db.query('SELECT count(*)::int n FROM historical_standard_intents')).rows[0].n,before);
      await assert.rejects(db.query('DELETE FROM historical_standard_batches'),/permanent/);await assert.rejects(db.query('TRUNCATE historical_standard_intents'),/permanent/);
      assert.ok(requests.every(r=>!r.path.includes('/amber/')));assert.ok(writes.every(w=>new URL(w.url).pathname==='/rest/all/V1/products'));
    });
  } finally {
    if(db)await db.end();if(appPool)await appPool.end();
    if(created){assert.equal((await control.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=$1",[name])).rows[0]?.marker,marker);
      assert.equal((await control.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1',[name])).rowCount,0);await control.query(`DROP DATABASE ${name}`);}
    if(checkpoint){assert.equal(path.dirname(checkpoint),path.resolve(os.tmpdir()));assert.ok(path.basename(checkpoint).startsWith('historical-checkpoint-'));for(const file of await fs.readdir(checkpoint)){assert.match(file,/^\d{3}_.*\.sql$/);await fs.unlink(path.join(checkpoint,file));}await fs.rmdir(checkpoint);}
    try { assert.deepEqual((await control.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r=>r.datname),expectedDatabases); }
    finally { await control.end(); }
  }
});
