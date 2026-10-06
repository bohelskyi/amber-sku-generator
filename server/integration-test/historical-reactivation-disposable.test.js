const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client, Pool } = require('pg');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

test('historical NEW intents preserve unknown history and use an exact atomic UPDATE-only lane', async t => {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = `amber_historical_reactivation_${process.pid}_${randomBytes(6).toString('hex')}_test`;
  const marker = process.env.CODEX_FINAL_DB_MARKER || `historical-owned-${randomUUID()}`;
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
    for (let i=0;i<9;i++) products.push((await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah,weight,status,exclude_from_export,details)
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
      for(const table of ['historical_reactivation_batches','historical_reactivation_intents'])assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
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
      row.cells = Object.fromEntries(Object.entries(row.cells).filter(([key])=>['sku','store_view_code','name','attribute_set_code','product_type','price'].includes(key)));
      row.cells.price = row.id==='base'?{op:'text',input:{op:'source',id:'price'},trim:false,format:'scalar-v1',onAbsent:'empty'}:{op:'literal',value:''};
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
    const native={attribute_set_code:'attribute_set_id',product_type:'type_id',store_view_code:'store_view_code'};
    decisions.attributes.forEach(a=>{if(a.strategy==='transport_control')a.transportTarget=`product.${native[a.target]}`;});
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
    const atomic=require('../src/services/magento/historical-update-transport');
    const rawBySku=new Map(products.map(p=>[p.full_sku,{id:p.id+10000,sku:p.full_sku,attribute_set_id:8001,name:'Fixture name',price:200,status:1,visibility:4,type_id:'simple',
      custom_attributes:[],extension_attributes:{category_links:[],website_ids:[801]}}]));
    let adapter=true, loseHide=false, hideInvisible=false;
    const writes=[];
    options.discover=async()=>schema;
    options.fetchImpl=async(url,input={})=>{
      const u=new URL(url); const method=input.method||'GET';
      if(method==='GET'&&u.pathname.endsWith('/existing-update-capability')) return new Response(JSON.stringify(adapter?atomic.CAPABILITY:{}),{headers:{'content-type':'application/json'}});
      if(method==='GET'&&u.pathname.endsWith('/categories')) return new Response(JSON.stringify({id:803,parent_id:1,name:'Default',children_data:[]}),{headers:{'content-type':'application/json'}});
      if(method==='GET'&&u.pathname.endsWith('/products')) {
        const sku=[...u.searchParams].find(([key])=>key.includes('[value]'))?.[1]; const raw=rawBySku.get(sku);
        return new Response(JSON.stringify({items:raw?[raw]:[],total_count:raw?1:0}),{headers:{'content-type':'application/json'}});
      }
      if(method==='PUT'&&/^\/rest\/(all|en)\/V1\/amber\/products\/[^/]+\/existing\/[1-9][0-9]*$/.test(u.pathname)) {
        const body=JSON.parse(input.body), raw=rawBySku.get(body.product.sku); writes.push({url,body});
        assert.equal(body.contract,atomic.CAPABILITY.contract); assert.equal(Number(raw?.id),body.product.id,'Adapter mock atomically rejects missing/replaced identities');
        if(!hideInvisible)Object.assign(raw,body.product);
        if(loseHide)throw new Error('synthetic lost response');
        return new Response(JSON.stringify(raw),{headers:{'content-type':'application/json'}});
      }
      assert.fail(`No unbounded/real transport allowed: ${method} ${u.pathname}`);
    };
    const service=require('../src/services/historical-reactivation.service');
    const worker=require('../src/services/magento/historical-reactivation-worker');
    const mutate=(sql,values)=>require('../src/services/access-admin-transaction').runAccessAdminMutation({databasePool:db,actorUserId:actor,requiredPermission:'products.archive',createError:c.error,
      operation:client=>client.query(sql,values)});
    const command=(review,selectedSkus)=>({skus:review.skus,selectedSkus,reviewNonce:review.reviewNonce,reviewHash:review.reviewHash,reviewToken:review.reviewToken,
      reviewExpiresAt:review.reviewExpiresAt,idempotencyKey:randomUUID(),confirmCurrentFactsAndHiddenUpdate:true});
    const snapshot=async()=> (await db.query(`SELECT (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,
      (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) lifecycle,
      (SELECT jsonb_agg(r ORDER BY public_product_identity_id) FROM magento_product_sync_requests r) requests,
      (SELECT count(*)::int FROM audit_events) audits`)).rows[0];
    await t.test(process.env.HISTORICAL_MANUAL_REPRO_ONLY==='true'?'066 draft reproduces ordinary manual ledger product-lock timeout'
      :'ordinary manual enqueue can insert through its separate ledger connection without a historical trigger deadlock',async()=>{
      const ordinary=await require('../src/services/access-admin-transaction').runAccessAdminMutation({databasePool:db,actorUserId:actor,requiredPermission:'products.create',createError:c.error,
        operation:async client=>{
          const row=(await insertProductFixture(client,`INSERT INTO products(full_sku,category,total_price_uah,weight,status,exclude_from_export,details)
            VALUES($1,'BR',240,12.7,'active',0,'{"answers":{}}') RETURNING *`,[`BR3/ORDINARY-${randomUUID()}`])).rows[0];
          await client.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1",[row.id]);return row;
        }});
      rawBySku.set(ordinary.full_sku,{id:ordinary.id+10000,sku:ordinary.full_sku,attribute_set_id:8001,name:'Fixture name',price:200,status:1,visibility:4,type_id:'simple',
        custom_attributes:[],extension_attributes:{category_links:[],website_ids:[801]}});
      const bounded=new Pool({connectionString:process.env.DATABASE_URL,max:4,statement_timeout:750,query_timeout:1500});
      try {
        const attempt=()=>require('../src/services/magento/sync-job.service').enqueue(config,{sku:ordinary.full_sku,bindingRevisionId:published.id},
          {...options,databasePool:bounded,preview:(cfg,args)=>require('../src/services/magento/sync-preview').previewProduct(cfg,{...args,discover:options.discover})});
        if(process.env.HISTORICAL_MANUAL_REPRO_ONLY==='true')await assert.rejects(attempt(),cause=>{
          assert.equal(cause.code,'57014');assert.match(cause.where,/require_historical_update_job/);
          console.log('Exact original trigger timeout proof:',JSON.stringify({code:cause.code,where:cause.where}));return true;
        },'The uncorrected 066 draft must reproduce the nested ledger product-lock timeout');
        else{const job=await attempt();assert.equal(job.state,'queued');assert.equal(job.product_id,ordinary.id);assert.equal(job.intent.mode,'update');}
      }finally{await bounded.end();}
    });
    await t.test('fresh preview is read-only, adapter absent fails closed, missing local/remote never selects CREATE',async()=>{
      const before=await snapshot(); adapter=false;
      const oldRestore=await require('../src/services/product-lifecycle.service').preview({skus:[products[0].full_sku]},options);
      assert.equal(oldRestore.items[0].reasonCode,'PRODUCT_ARCHIVE_PROOF_MISSING','The new protocol never bypasses ordinary restore proof');
      const blocked=await service.preview({skus:[products[0].full_sku.toLowerCase(),products[0].full_sku,'NOT-LOCAL']},options);
      assert.equal(blocked.items.length,2); assert.equal(blocked.items[0].reasonCode,'HISTORICAL_UPDATE_ONLY_ADAPTER_REQUIRED');
      assert.equal(blocked.items[1].reasonCode,'HISTORICAL_PRODUCT_NOT_FOUND'); assert.deepEqual(await snapshot(),before); assert.equal(writes.length,0);
      adapter=true;
      const raw=rawBySku.get(products[1].full_sku); rawBySku.delete(products[1].full_sku);
      const missing=await service.preview({skus:[products[1].full_sku]},options); assert.equal(missing.items[0].reasonCode,'HISTORICAL_REMOTE_COUNTERPART_MISSING');
      rawBySku.set(products[1].full_sku,raw); assert.deepEqual(await snapshot(),before);
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
    await t.test('the five capabilities on a custom role cannot substitute for actual immutable Administrator',async()=>{
      const user=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Custom historical actor') RETURNING id")).rows[0].id);
      const role=(await db.query("INSERT INTO roles(role_key,display_name,description) VALUES('historical_custom','Historical custom','Fixture custom authority') RETURNING id")).rows[0].id;
      for(const permission of require('../src/services/historical-reactivation-state').PERMISSIONS)await db.query('INSERT INTO role_permissions(role_id,permission_key) VALUES($1,$2)',[role,permission]);
      await db.query('INSERT INTO user_role_assignments(application_user_id,role_id) VALUES($1,$2)',[user,role]);
      const before=writes.length;await assert.rejects(service.preview({skus:[products[0].full_sku]},{...options,actorUserId:user,mutationContext:{actorUserId:user}}),{code:'HISTORICAL_ADMINISTRATOR_REQUIRED'});
      assert.equal(writes.length,before);
    });
    await t.test('same UUID independent transactions recover one immutable batch; changed/stale input is rejected',async()=>{
      const review=await service.preview({skus:[products[0].full_sku,'NOT-LOCAL']},options);
      assert.equal(review.items[0].disposition,'eligible',JSON.stringify(review.items[0]));
      const input=command(review,[products[0].full_sku]); const before=await snapshot();
      const [a,b]=await Promise.all([service.confirm(input,options),service.confirm(input,options)]);
      assert.deepEqual(a,b); assert.equal(a.batchId,input.idempotencyKey); assert.equal(a.items.length,1); assert.equal(a.items[0].state,'queued');
      assert.equal((await db.query('SELECT count(*)::int n FROM historical_reactivation_batches')).rows[0].n,1);
      assert.deepEqual((await snapshot()).products,before.products); assert.deepEqual((await snapshot()).requests,before.requests);
      await assert.rejects(service.confirm({...input,selectedSkus:[products[1].full_sku]},options),{code:'HISTORICAL_IDEMPOTENCY_CONFLICT'});
      assert.deepEqual(await service.confirm(input,{...options,now:()=>Date.now()+600000}),a,'Original accepted receipt recovers after expiry');
      await assert.rejects(mutate('UPDATE products SET total_price_uah=241 WHERE id=$1',[products[0].id]),/HISTORICAL_REACTIVATION_PENDING/);
      await assert.rejects(mutate('DELETE FROM product_full_export_state WHERE product_id=$1',[products[0].id]),/HISTORICAL_REACTIVATION_PENDING/);
      await assert.rejects(db.query('DELETE FROM historical_reactivation_batches WHERE id=$1',[a.batchId]),/permanent/);
      await assert.rejects(db.query('UPDATE historical_reactivation_intents SET remote_product_id=1 WHERE id=$1',[a.items[0].intentId]),/cannot be rewritten/);
      const result=await worker.runIntent(config,a.items[0].intentId,options);
      assert.equal(result.state,'awaiting_native',JSON.stringify(result)); assert.ok(result.hidden_verified_at); assert.ok(result.local_activated_at); assert.equal(result.native_confirmed_at,null);
      const current=(await db.query('SELECT to_jsonb(p) product FROM products p WHERE id=$1',[products[0].id])).rows[0].product;
      const old=before.products.find(p=>p.id===products[0].id);
      for(const key of ['full_sku','sku_schema_version_id','total_price_uah','weight','details','name_subject_ua','name_subject_en'])assert.deepEqual(current[key],old[key],key);
      assert.equal(String(current.public_product_identity_id),String(old.public_product_identity_id));
      assert.equal(current.status,'active'); assert.equal(rawBySku.get(current.full_sku).status,2);
      assert.equal((await db.query('SELECT current_facts FROM historical_reactivation_intents WHERE id=$1',[result.id])).rows[0].current_facts.priorFacts,'unknown');
      await assert.rejects(db.query('UPDATE magento_product_sync_requests SET desired_generation=desired_generation+1 WHERE product_id=$1',[current.id]),/HISTORICAL_REACTIVATION_PENDING/);
      await assert.rejects(db.query(`INSERT INTO product_media_jobs(id,product_id,public_product_identity_id,version,photo_ids,enable_when_verified,
        actor_user_id,request_key,required_permission,intent_hash) VALUES($1,$2,$3,1,'{}',FALSE,$4,$5,'products.create',$6)`,
      [randomUUID(),current.id,current.public_product_identity_id,actor,randomUUID(),c.hash('forbidden media')]),/HISTORICAL_REACTIVATION_PENDING/);
      await assert.rejects(db.query('TRUNCATE historical_reactivation_intents CASCADE'),/permanent/);
      const automatic=require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(config,{databasePool:db,
        jobOptions:{fetchImpl:options.fetchImpl,preview:(cfg,args)=>require('../src/services/magento/sync-preview').previewProduct(cfg,{...args,discover:options.discover})}});
      await automatic.runProduct(current.public_product_identity_id); await automatic.stop();
      const request=(await db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1',[current.id])).rows[0];
      assert.equal(request.state,'synced',JSON.stringify(request));
      await require('../src/services/magento/historical-update-boundary').confirmCompleted(config,options);
      const complete=(await service.readBatch(a.batchId,options)).items[0];assert.equal(complete.state,'completed',JSON.stringify(complete));
      assert.ok(complete.nativeConfirmedAt);assert.equal(rawBySku.get(current.full_sku).price,240);assert.equal(rawBySku.get(current.full_sku).status,2);
      assert.ok(writes.every(w=>w.url.includes('/V1/amber/products/')&&w.url.includes('/existing/')));
      await assert.rejects(db.query(`INSERT INTO magento_sync_jobs(id,product_id,sku,installation_key,origin_hash,binding_revision_id,binding_hash,
        amber_hash,plan_hash,intent,baseline,state,created_by_user_id,public_product_identity_id)
        VALUES($1,$2,$3,'historical-fixture',$4,$5,$6,$6,$6,'{"mode":"create"}','{}','queued',$7,$8)`,
      [randomUUID(),current.id,current.full_sku,origin,published.id,c.hash('forbidden create'),actor,current.public_product_identity_id]),/Historical identity requires exact pinned UPDATE job/);
      await assert.rejects(db.query("UPDATE historical_reactivation_intents SET native_confirmed_at=NULL WHERE id=$1",[result.id]),/cannot be rewritten/);
    });
    await t.test('lost hide response remains sticky; GET-only explicit reconciliation preserves original dispatch',async()=>{
      const review=await service.preview({skus:[products[1].full_sku]},options); const accepted=await service.confirm(command(review,[products[1].full_sku]),options);
      loseHide=true; hideInvisible=true;
      const failed=await worker.runIntent(config,accepted.items[0].intentId,options); assert.equal(failed.state,'dispatched'); assert.ok(failed.dispatched_at);
      const count=writes.length; await worker.runIntent(config,failed.id,options); assert.equal(writes.length,count);
      rawBySku.get(products[1].full_sku).status=2; loseHide=false; hideInvisible=false;
      const inspect=await worker.inspect(config,failed.id,options); assert.equal(inspect.canConfirm,true);
      const receipt=await worker.reconcile(config,{intentId:failed.id,reviewHash:inspect.reviewHash,confirmObservedHiddenResult:true},options);
      assert.equal(receipt.state,'awaiting_native'); assert.equal(writes.length,count,'Reconciliation never writes Magento');
      assert.deepEqual(await worker.reconcile(config,{intentId:failed.id,reviewHash:inspect.reviewHash,confirmObservedHiddenResult:true},options),receipt);
      assert.deepEqual((await db.query('SELECT dispatched_at FROM historical_reactivation_intents WHERE id=$1',[failed.id])).rows[0].dispatched_at,failed.dispatched_at);
      await assert.rejects(db.query("UPDATE historical_reactivation_intents SET state='queued',dispatched_at=NULL WHERE id=$1",[failed.id]),/cannot be rewritten/);
    });
    await t.test('fresh local change and missing adapter after confirm block without dispatch or activation',async()=>{
      const review=await service.preview({skus:[products[2].full_sku]},options);
      await mutate('UPDATE products SET total_price_uah=241 WHERE id=$1',[products[2].id]);
      await assert.rejects(service.confirm(command(review,[products[2].full_sku]),options),{code:'HISTORICAL_REVIEW_STALE'});
      const fresh=await service.preview({skus:[products[2].full_sku]},options);const accepted=await service.confirm(command(fresh,[products[2].full_sku]),options);
      adapter=false; const count=writes.length;
      const row=await worker.runIntent(config,accepted.items[0].intentId,options);
      assert.equal(row.state,'blocked');assert.equal(row.reason_code,'HISTORICAL_UPDATE_ONLY_ADAPTER_REQUIRED');assert.equal(row.dispatched_at,null);assert.equal(writes.length,count);
      assert.equal((await db.query('SELECT status FROM products WHERE id=$1',[products[2].id])).rows[0].status,'archived'); adapter=true;
    });
    await t.test('fresh exact remote disappearance/replacement and actual administrator revocation preserve local archive without PUT',async()=>{
      for(const [i,kind,expected] of [[3,'missing','HISTORICAL_REMOTE_COUNTERPART_MISSING'],[4,'replacement','HISTORICAL_REMOTE_IDENTITY_MISMATCH'],[5,'revoked','ADMIN_PERMISSION_REVOKED']]){
        const product=products[i],review=await service.preview({skus:[product.full_sku]},options);
        const accepted=await service.confirm(command(review,[product.full_sku]),options);const before=writes.length;
        if(kind==='missing')rawBySku.delete(product.full_sku);
        if(kind==='replacement')rawBySku.get(product.full_sku).id+=1;
        if(kind==='revoked')await db.query("UPDATE application_users SET status='disabled',deactivated_at=CURRENT_TIMESTAMP WHERE id=$1",[actor]);
        const result=await worker.runIntent(config,accepted.items[0].intentId,options);
        assert.equal(result.state,'blocked');assert.equal(result.reason_code,expected);assert.equal(result.dispatched_at,null);assert.equal(writes.length,before);
        assert.equal((await db.query('SELECT status FROM products WHERE id=$1',[product.id])).rows[0].status,'archived');
        if(kind==='revoked')await db.query("UPDATE application_users SET status='active',deactivated_at=NULL WHERE id=$1",[actor]);
      }
    });
    await t.test('independent uncommitted price mutation after remote review is fenced by final transaction revalidation',async()=>{
      const product=products[6],review=await service.preview({skus:[product.full_sku]},options);
      const editing=await db.connect();let committed=false;
      try {
        await require('../src/services/full-product-cutover-gate').begin(editing);
        await editing.query('UPDATE products SET total_price_uah=242 WHERE id=$1',[product.id]);
        const actual=require('../src/services/magento/sync-preview').previewProduct;
        const racing={...options,previewProduct:async(cfg,args)=>{const report=await actual(cfg,args);await require('../src/services/full-product-cutover-gate').commit(editing);committed=true;return report;}};
        await assert.rejects(service.confirm(command(review,[product.full_sku]),racing),{code:'HISTORICAL_REVIEW_STALE'});
        assert.equal((await db.query('SELECT count(*)::int n FROM historical_reactivation_intents WHERE product_id=$1',[product.id])).rows[0].n,0);
        assert.equal((await db.query('SELECT status FROM products WHERE id=$1',[product.id])).rows[0].status,'archived');
      } finally {if(!committed)await require('../src/services/full-product-cutover-gate').rollback(editing);await require('../src/services/full-product-cutover-gate').release(editing);editing.release();}
    });
    if(process.env.HISTORICAL_MANUAL_REPRO_ONLY!=='true')await t.test('a racing bare job INSERT waits for the enrolled intent and cannot bypass its fresh UPDATE-only fence',async()=>{
      const product=products[8],review=await service.preview({skus:[product.full_sku]},options);
      let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),released=new Promise(resolve=>{release=resolve;});
      const paused={query:db.query.bind(db),connect:async()=>{
        const client=await db.connect(),originalQuery=client.query,originalRelease=client.release;
        client.query=async(...args)=>{const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
          if(sql?.includes('INSERT INTO historical_reactivation_batches')){enter();await released;}return originalQuery.apply(client,args);};
        client.release=(...args)=>{client.query=originalQuery;client.release=originalRelease;return originalRelease.apply(client,args);};return client;
      }};
      const confirming=service.confirm(command(review,[product.full_sku]),{...options,databasePool:paused});
      await entered;
      const jobId=randomUUID();
      const raced=db.query(`INSERT INTO magento_sync_jobs(id,product_id,sku,installation_key,origin_hash,binding_revision_id,binding_hash,
        amber_hash,plan_hash,intent,baseline,state,created_by_user_id,public_product_identity_id)
        VALUES($1,$2,$3,'historical-fixture',$4,$5,$6,$6,$6,'{"mode":"create"}','{}','queued',$7,$8)`,
      [jobId,product.id,product.full_sku,origin,published.id,c.hash('race create'),actor,product.public_product_identity_id]).then(()=>({success:true}),cause=>({cause}));
      try {
        let waiting=false;for(let i=0;i<100&&!waiting;i++){
          waiting=(await db.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO magento_sync_jobs%'")).rowCount>0;
          if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.equal(waiting,true,'Independent job connection must wait at the product-key barrier');
      }finally{release();}
      const accepted=await confirming;assert.equal(accepted.items[0].state,'queued');
      const result=await raced;assert.match(result.cause?.message||'',/HISTORICAL_REACTIVATION_PENDING/);
      assert.equal((await db.query('SELECT 1 FROM magento_sync_jobs WHERE id=$1',[jobId])).rowCount,0);
    });
    await t.test('new publication blocks an older intent and a literal price contract cannot silently override reviewed current Manager price',async()=>{
      const product=products[6],review=await service.preview({skus:[product.full_sku]},options);
      const accepted=await service.confirm(command(review,[product.full_sku]),options);
      const wrong=structuredClone(definition);for(const group of wrong.groups)group.rows.find(r=>r.id==='base').cells.price={op:'literal',value:'42'};
      const family=await templates.createTemplate({key:'historical-literal-price',displayName:'Historical literal price',definition:wrong},options);
      const version=await templates.publishTemplate(family.id,{expectedRevision:family.draft.revision,expectedDefinitionHash:family.draft.definitionHash},options);
      let successor=await bindings.createDraft({installationKey:'historical-fixture',origin:config.baseUrl,templateVersionId:version.id,observedAt:new Date().toISOString(),schema},options);
      successor=await bindings.updateDraft(successor.id,{expectedRevision:successor.revision,bindings:decisions},options);
      await bindings.publishDraft(successor.id,{expectedRevision:successor.revision,expectedCurrentId:published.id},options);
      const before=writes.length,result=await worker.runIntent(config,accepted.items[0].intentId,options);
      assert.equal(result.state,'blocked');assert.equal(result.reason_code,'HISTORICAL_BINDING_CHANGED');assert.equal(writes.length,before);
      const fresh=await service.preview({skus:[products[7].full_sku]},options);
      assert.equal(fresh.items[0].reasonCode,'HISTORICAL_DELIVERY_PLAN_BLOCKED');assert.ok(fresh.items[0].deliveryBlockerCodes.includes('HISTORICAL_CURRENT_PRICE_NOT_AUTHORITATIVE'));
    });
    assert.equal((await db.query('SELECT count(*)::int n FROM product_visibility_intents')).rows[0].n,0,'NEW protocol never invents an old hide proof');
    assert.equal(published.state,'published');
  } finally {
    try {
    if(db)await db.end();if(appPool)await appPool.end();
    if(created){assert.equal((await control.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=$1",[name])).rows[0]?.marker,marker);
      // Pool.end() closes local sockets; PostgreSQL can briefly retain the closing
      // backend in pg_stat_activity. Wait only for this owned disposable database,
      // then retain the strict zero-client assertion before DROP (no FORCE).
      for(let attempt=0;attempt<100;attempt++) {
        if((await control.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1',[name])).rowCount===0)break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.equal((await control.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1',[name])).rowCount,0);await control.query(`DROP DATABASE ${name}`);}
    if(checkpoint){assert.equal(path.dirname(checkpoint),path.resolve(os.tmpdir()));assert.ok(path.basename(checkpoint).startsWith('historical-checkpoint-'));for(const file of await fs.readdir(checkpoint)){assert.match(file,/^\d{3}_.*\.sql$/);await fs.unlink(path.join(checkpoint,file));}await fs.rmdir(checkpoint);}
    assert.deepEqual((await control.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r=>r.datname),expectedDatabases);
    } finally { await control.end(); }
  }
});
