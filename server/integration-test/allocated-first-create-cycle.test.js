const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Client,Pool}=require('pg');

test('allocated first CREATE breaks only the proven birth-photo dependency on owned disposable PostgreSQL',{timeout:30000},async t=>{
  const source=new URL(process.env.TEST_DATABASE_URL||'');
  assert.equal(source.hostname,'127.0.0.1');assert.equal(source.port,'55432');assert.ok(source.pathname.endsWith('_test'));
  const maintenance=new URL(source);maintenance.pathname='/postgres';
  const name=`amber_allocated_create_${process.pid}_test`,control=new Client({connectionString:maintenance.toString()});
  await control.connect();let created=false,db,appPool;
  const previousFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('Live HTTP is forbidden');
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1',[name])).rows[0].n,0);
    await control.query(`CREATE DATABASE ${name}`);created=true;
    const target=new URL(source);target.pathname='/'+name;
    process.env.DATABASE_URL=target.toString();process.env.NBU_RATE_OVERRIDE='40';process.env.MAGENTO_BASE_URL='';
    require('../test/setup-env');appPool=require('../src/db/pool');
    await require('../src/db/run-migrations').runMigrations();db=new Pool({connectionString:target.toString(),max:8});
    const actor=Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Allocated birth fixture') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[actor]);
    await db.query("INSERT INTO categories(code,name,requires_weight) VALUES('NM','Native fixture',0)");
    await db.query("INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required) VALUES('NM','neckle_size','Exact necklace length','text',0,0)");
    const fixture=require('../test/fixtures/magento-v4'),c=require('../src/services/magento/binding-contract');
    const config=require('../src/config/magento').parseMagentoConfig({MAGENTO_BASE_URL:'https://allocated-fixture.invalid',
      MAGENTO_CONSUMER_KEY:'fixture-key',MAGENTO_CONSUMER_SECRET:'fixture-secret',MAGENTO_ACCESS_TOKEN:'fixture-token',MAGENTO_ACCESS_TOKEN_SECRET:'fixture-secret'});
    const definition=fixture.definition(['NM']);definition.sources={sku:definition.sources.sku,price:definition.sources.price};definition.tables={};definition.questionContracts={};
    const lengthTarget='dovzhyna_namysta_tochna';
    definition.sources.nmLength={kind:'information',category:'NM',key:'neckle_size',type:'scalar',provenance:'supplied-stored-answers-v1',aliases:[]};
    definition.groups[0].columns=[...new Set([...definition.groups[0].columns,'product_online','visibility',lengthTarget])];
    for(const row of definition.groups[0].rows) {
      if(row.id==='base') {
        row.cells.product_online={op:'literal',value:'2'};row.cells.visibility={op:'literal',value:'Catalog, Search'};
        row.cells[lengthTarget]={op:'text',input:{op:'source',id:'nmLength'},trim:false,format:'scalar-v1',onAbsent:'empty'};
      }else row.cells.price={op:'literal',value:''};
    }
    const schema=fixture.observation();schema.attributes.find(a=>a.attribute_code==='name').scope='store';
    schema.attributes.push({attribute_id:960,attribute_code:lengthTarget,frontend_input:'text',backend_type:'varchar',scope:'global',options:[]});
    schema.attributeSets[0].attributeCodes.push(lengthTarget);
    const context={actorUserId:actor,requestId:randomUUID()},options={databasePool:db,mutationContext:context};
    const templates=require('../src/services/export-templates/template.service'),bindings=require('../src/services/magento/binding.service');
    const template=await templates.createTemplate({key:'allocated-fixture',displayName:'Allocated birth fixture',definition},options);
    const version=await templates.publishTemplate(template.id,{expectedRevision:template.draft.revision,expectedDefinitionHash:template.draft.definitionHash},options);
    let draft=await bindings.createDraft({installationKey:'allocated-fixture',origin:config.baseUrl,templateVersionId:version.id,observedAt:new Date().toISOString(),schema},options);
    const approved=fixture.approvedBindings(version.definition,schema);
    for(const attribute of approved.attributes)if(attribute.transportTarget)attribute.transportTarget='product.'+
      ({attribute_set_code:'attribute_set_id',product_type:'type_id',product_online:'status'}[attribute.target]||attribute.target);
    for(const policy of approved.policies) {
      const attribute=approved.attributes.find(a=>a.bindingKey===policy.bindingKey);
      policy.policy=['name','price',lengthTarget].includes(attribute.target)?'authoritative_create_update':attribute.rowId==='english'?'magento_managed':'initialize_create_only';
      if(attribute.target==='product_online'&&attribute.rowId==='base')policy.evidence={createValue:2};
    }
    draft=await bindings.updateDraft(draft.id,{expectedRevision:draft.revision,bindings:approved},options);
    const binding=await bindings.publishDraft(draft.id,{expectedRevision:draft.revision,expectedCurrentId:null},options);
    const gate=require('../src/services/full-product-cutover-gate'),audit=require('../src/audit/audit-events');
    const activation=await db.connect();
    try {
      await gate.begin(activation);
      const publicReceipt=await audit.writeAuditEvent(activation,{mutationContext:context,eventKey:'public_sku.activated',subjectType:'public_sku_activation',subjectId:'singleton'});
      await activation.query("SET LOCAL amber.public_sku_activation='on'");
      await activation.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton',[actor,publicReceipt.id]);
      const receipt=await audit.writeAuditEvent(activation,{mutationContext:context,eventKey:'magento_delivery.cutover',subjectType:'magento_delivery',subjectId:binding.installationKey,
        details:{planHash:c.hash({fixture:true}),bindingRevisionId:binding.id,bindingVersionNumber:binding.versionNumber,heldLegacyCount:0}});
      await activation.query("SET LOCAL amber.magento_delivery_cutover='on'");
      await activation.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2,
        legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$2,cutover_event_id=$3 WHERE singleton`,[binding.installationKey,actor,receipt.id]);
      await gate.commit(activation);
    }catch(e){await gate.rollback(activation).catch(()=>{});throw e;}
    finally{await gate.release(activation).catch(()=>{});activation.release();}
    const photos=require('../src/services/product-photos.service'),native=require('../src/services/magento/first-sync-native-create');
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE5sAAAAASUVORK5CYII=','base64');
    async function make({withPhotos=true,receipt=true}={}) {
      const mutationContext={actorUserId:actor,requestId:randomUUID()};
      const asset=withPhotos?await photos.stage({idempotencyKey:randomUUID(),name:'native.png',mimeType:'image/png',base64:bytes.toString('base64')},{databasePool:db,mutationContext}):null;
      const client=await db.connect();
      try {
        await gate.begin(client);
        const product=(await require('./product-fixture').insertNativeProductFixture(client,{category:'NM',weight:1,totalPriceUah:100,actorUserId:actor,details:{answers:{neckle_size:'77.5'},manualPriceUah:100}})).rows[0];
        const sku=(await client.query('SELECT public_sku FROM public_product_identities WHERE id=$1',[product.public_product_identity_id])).rows[0].public_sku;
        const media=asset?await photos.attachCreatedProduct(client,product.id,{photoIds:[asset.id],enableWhenVerified:true},mutationContext):null;
        if(receipt)await audit.writeAuditEvent(client,{mutationContext,eventKey:'product.created',subjectType:'product',subjectId:product.id,details:{fullSku:null,publicSku:sku,categoryCode:'NM'}});
        await gate.commit(client);return {...product,public_sku:sku,media,asset};
      }catch(e){await gate.rollback(client).catch(()=>{});throw e;}
      finally{await gate.release(client).catch(()=>{});client.release();}
    }
    let raw=null,english=null,beforeCreateResponse=null;const writes=[];
    const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    const fetchImpl=async(url,init)=>{
      const u=new URL(url),route=u.pathname.split('/V1/')[1];assert.equal(u.hostname,'allocated-fixture.invalid');
      if(init.method==='GET'&&route==='products') {
        const value=u.pathname.includes('/en/')?english:raw;return response({items:value?[value]:[],total_count:value?1:0});
      }
      if(init.method==='GET'&&route==='categories')return response({id:803,parent_id:1,name:'Fixture root',children_data:[]});
      assert.equal(init.method,'POST');assert.equal(route,'products');
      const payload=JSON.parse(init.body).product;writes.push(structuredClone(payload));
      const base=raw||{id:8001,sku:payload.sku,attribute_set_id:8001,type_id:'simple',status:2,visibility:4,
        custom_attributes:[],extension_attributes:{category_links:[]}};
      const old=u.pathname.includes('/en/')?(english||base):base;
      const attributes=new Map((old.custom_attributes||[]).map(a=>[a.attribute_code,a]));
      for(const a of payload.custom_attributes||[])attributes.set(a.attribute_code,a);
      const next={...old,...payload,custom_attributes:[...attributes.values()]};
      if(u.pathname.includes('/en/'))english=next;else {raw=next;english ||= structuredClone(raw);}
      if(beforeCreateResponse){const check=beforeCreateResponse;beforeCreateResponse=null;await check();}
      return response(true);
    };
    const {previewProduct}=require('../src/services/magento/sync-preview'),jobs=require('../src/services/magento/sync-job.service');
    const preview=(cfg,opts)=>previewProduct(cfg,{...opts,discover:async()=>schema});
    const observation=async product=>{let observed;await preview(config,{databasePool:db,fetchImpl,sku:product.public_sku,bindingRevisionId:binding.id,onObservation:value=>{observed=value;}});return observed;};
    const readRequest=async product=>(await db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1',[product.id])).rows[0];
    const automatic=async product=>({databasePool:db,actorUserId:actor,apply:true,fetchImpl,preview,
      automatic:{publicIdentityId:product.public_product_identity_id,productId:product.id,generation:(await readRequest(product)).desired_generation,installationKey:binding.installationKey}});
    const footprint=async product=>({product:(await db.query('SELECT * FROM products WHERE id=$1',[product.id])).rows,
      state:(await db.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[product.id])).rows,
      media:(await db.query('SELECT * FROM product_media_jobs WHERE product_id=$1',[product.id])).rows,
      sessions:(await db.query('SELECT * FROM magento_first_sync_sessions WHERE public_product_identity_id=$1',[product.public_product_identity_id])).rows});
    const product=await make();let queued;
    await t.test('fresh native preview is SELECT-only and manual enqueue cannot strand a new exceptional job',async()=>{
      const before=await footprint(product),observed=await observation(product);
      const client=await db.connect();try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const proof=await native.readOnClient(client,config,observed);assert.ok(proof);
        const eligibility=await require('../src/services/magento/first-sync-eligibility').readFirstSyncEligibility(client,config,observed);
        assert.equal(eligibility.mode,'create');assert.ok(eligibility.nativeCreate);await native.assertOnClient(client,proof);
        await client.query('ROLLBACK');
      }finally{await client.query('ROLLBACK').catch(()=>{});client.release();}
      assert.deepEqual(await footprint(product),before);assert.equal(writes.length,0);
      await assert.rejects(jobs.enqueue(config,{sku:product.public_sku,bindingRevisionId:binding.id},{databasePool:db,actorUserId:actor,preview,fetchImpl}),{code:'MAGENTO_FIRST_SYNC_NATIVE_CREATE_AUTOMATIC_REQUIRED'});
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n,0);
    });
    await t.test('atomic automatic enqueue preserves lifecycle, initial media and history then survives restart',async()=>{
      const before=await footprint(product);
      const report=await preview(config,{databasePool:db,fetchImpl,sku:product.public_sku,bindingRevisionId:binding.id});
      assert.equal(report.sendable,true,JSON.stringify(report.blockers));
      queued=await jobs.enqueue(config,{sku:product.public_sku,bindingRevisionId:binding.id},await automatic(product));
      assert.ok(queued.baseline.allocatedFirstCreate);assert.equal(queued.intent.mode,'create');assert.equal(queued.intent.operations[0].payload.product.status,2);
      assert.deepEqual(await footprint(product),before);assert.equal(writes.length,0);
      const proof=await native.readOnClient(db,config,await observation(product),{jobId:queued.id});assert.ok(proof);
      assert.equal((await readRequest(product)).active_job_id,queued.id);
      const media=require('../src/services/magento/product-media-delivery');
      const waiting=await media.processJob(config,product.media.jobId,{databasePool:db,transport:{product:()=>assert.fail('Media cannot read or write before native acknowledgement')}});
      assert.equal(waiting.waitingForProduct,true);assert.deepEqual(await footprint(product),before);
      assert.equal(queued.intent.operations[0].payload.product.custom_attributes.find(a=>a.attribute_code===lengthTarget).value,'77.5');
      let checkedBeforeAcknowledgement=false;
      beforeCreateResponse=async()=>{
        const observed=await observation(product);
        assert.equal(observed.raw.custom_attributes.find(a=>a.attribute_code===lengthTarget).value,'77.5');
        assert.equal(require('../src/services/magento/first-sync-projection').getExactLengthComparison(observed),null,
          'Allocated CREATE has no adopted remote ownership proof before acknowledgement');
        assert.equal((await db.query('SELECT acknowledged_at FROM magento_sync_jobs WHERE id=$1',[queued.id])).rows[0].acknowledged_at,null);
        checkedBeforeAcknowledgement=true;
      };
      const done=await jobs.applyJob(config,queued.id,await automatic(product));assert.equal(done.state,'succeeded',JSON.stringify(done.failure));
      assert.equal(checkedBeforeAcknowledgement,true);assert.equal(raw.custom_attributes.find(a=>a.attribute_code===lengthTarget).value,'77.5');
      assert.deepEqual((await footprint(product)).product,before.product);
      assert.equal(raw.status,2);assert.ok(writes.length>=1);assert.ok(writes.every(p=>!Object.hasOwn(p,'status')||p.status===2));
      const after=await footprint(product);assert.deepEqual(after.state,before.state);assert.deepEqual(after.media,before.media);assert.deepEqual(after.sessions,[]);
      await require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(config,{databasePool:db,jobOptions:{preview,fetchImpl}}).runProduct(product.public_product_identity_id);
      assert.equal((await readRequest(product)).state,'synced');
    });
    await t.test('media enables only after full bytes/metadata/order readback and preserves catalog acknowledgement',async()=>{
      const media=require('../src/services/magento/product-media-delivery');let verifiedReads=0;const entries=[];
      const transport={product:async()=>structuredClone({...raw,media_gallery_entries:entries}),
        entry:async(_sku,id)=>{verifiedReads++;return structuredClone(entries.find(e=>e.id===id));},
        upload:async(_sku,asset,position)=>{assert.equal(raw.status,2);entries.push({id:9001,...media.metadata(asset,position),content:{type:asset.mime_type,base64_encoded_data:asset.content.toString('base64')}});},
        update:()=>assert.fail('Initial photo job has no inherited or removed images'),
        status:async(_sku,status)=>{assert.equal(status,1);assert.ok(verifiedReads>=3);assert.equal((await db.query('SELECT count(*)::int n FROM product_media_steps WHERE job_id=$1 AND verified_at IS NULL',[product.media.jobId])).rows[0].n,1,'Only the exact enable marker is unverified');raw.status=status;}};
      const result=await media.processJob(config,product.media.jobId,{databasePool:db,transport});assert.equal(result.state,'succeeded',JSON.stringify(result));
      assert.equal(raw.status,1);assert.ok(verifiedReads>=4);
      assert.equal((await db.query('SELECT csv_retired_revision::text FROM product_full_export_state WHERE product_id=$1',[product.id])).rows[0].csv_retired_revision,'1');
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_first_sync_sessions')).rows[0].n,0);
    });
    raw=null;english=null;
    await t.test('independent committed media receipt invalidates a previously issued proof; no reset or write follows',async()=>{
      const item=await make(),observed=await observation(item);const proof=await native.readOnClient(db,config,observed);assert.ok(proof);
      const writer=await db.connect(),reader=await db.connect();
      try {
        const a=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid,b=(await reader.query('SELECT pg_backend_pid() pid')).rows[0].pid;assert.notEqual(a,b);
        await writer.query('BEGIN');await writer.query('INSERT INTO product_media_steps(job_id,step_key,operation_hash,verified_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP)',[item.media.jobId,'verified:retained','a'.repeat(64)]);
        await writer.query('COMMIT');const before=await footprint(item),count=writes.length;
        await reader.query('BEGIN');await assert.rejects(native.assertOnClient(reader,proof),{code:'MAGENTO_FIRST_SYNC_NATIVE_CREATE_CHANGED'});await reader.query('ROLLBACK');
        await assert.rejects(jobs.enqueue(config,{sku:item.public_sku,bindingRevisionId:binding.id},await automatic(item)),{code:'MAGENTO_FIRST_SYNC_FIELDS_UNRESOLVED'});
        assert.deepEqual(await footprint(item),before);assert.equal(writes.length,count);
        assert.equal((await db.query('SELECT count(*)::int n FROM product_media_steps WHERE job_id=$1',[item.media.jobId])).rows[0].n,1);
      }finally{await writer.query('ROLLBACK').catch(()=>{});await reader.query('ROLLBACK').catch(()=>{});writer.release();reader.release();}
    });
    await t.test('missing immutable ordinary creation receipt never qualifies through numeric floors',async()=>{
      const item=await make({withPhotos:false,receipt:false});assert.equal(await native.readOnClient(db,config,await observation(item)),null);
      await assert.rejects(jobs.enqueue(config,{sku:item.public_sku,bindingRevisionId:binding.id},await automatic(item)),{code:'MAGENTO_FIRST_SYNC_FIELDS_UNRESOLVED'});
    });
    await t.test('inflight enqueue GET and an independent retained media receipt cannot create a job or send POST',async()=>{
      const item=await make(),writer=await db.connect();let releaseRead,readStarted;
      const waiting=new Promise(resolve=>{readStarted=resolve;}),resume=new Promise(resolve=>{releaseRead=resolve;});
      const pids=new Set(),racePool={query:db.query.bind(db),connect:async()=>{
        const client=await db.connect();pids.add((await client.query('SELECT pg_backend_pid() pid')).rows[0].pid);return client;
      }};
      const writerPid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid,count=writes.length;
      const read=async(url,init)=>{
        if(init.method==='GET'&&new URL(url).pathname.endsWith('/V1/products')){readStarted();await resume;}
        return fetchImpl(url,init);
      };
      const pending=jobs.enqueue(config,{sku:item.public_sku,bindingRevisionId:binding.id},{...await automatic(item),databasePool:racePool,fetchImpl:read});
      // Attach a rejection handler while the HTTP read is still in flight.
      const rejected=assert.rejects(pending,{code:'MAGENTO_FIRST_SYNC_FIELDS_UNRESOLVED'});
      try {
        await waiting;assert.ok(pids.size);assert.ok(!pids.has(writerPid));
        await writer.query('BEGIN');await writer.query('INSERT INTO product_media_steps(job_id,step_key,operation_hash) VALUES($1,$2,$3)',[item.media.jobId,'inflight:retained','b'.repeat(64)]);await writer.query('COMMIT');
        const before=await footprint(item);releaseRead();await rejected;
        assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs WHERE product_id=$1',[item.id])).rows[0].n,0);
        assert.equal(writes.length,count);assert.deepEqual(await footprint(item),before);
        assert.equal((await db.query('SELECT count(*)::int n FROM product_media_steps WHERE job_id=$1',[item.media.jobId])).rows[0].n,1);
      }finally{releaseRead();await writer.query('ROLLBACK').catch(()=>{});writer.release();}
    });
    await t.test('lost final write readback reconciles through exact original proof without any repeated Magento mutation',async()=>{
      const item=await make(),input={sku:item.public_sku,bindingRevisionId:binding.id};
      const original=await jobs.enqueue(config,input,await automatic(item));let loseRead=false,lost=false;
      const lossyFetch=async(url,init)=>{
        if(loseRead&&!lost&&init.method==='GET'&&new URL(url).pathname.endsWith('/V1/products')) {
          lost=true;throw Object.assign(new Error('Synthetic readback loss'),{code:'MAGENTO_NETWORK_ERROR'});
        }
        const result=await fetchImpl(url,init);
        if(init.method==='POST'&&new URL(url).pathname.includes('/en/'))loseRead=true;
        return result;
      };
      const outcome=await jobs.applyJob(config,original.id,{...await automatic(item),fetchImpl:lossyFetch});
      assert.equal(outcome.state,'uncertain',JSON.stringify(outcome.failure));assert.ok(lost);assert.equal(raw.status,2);
      await db.query("UPDATE magento_product_sync_requests SET state='needs_attention',reason_code='reconciliation_required' WHERE product_id=$1",[item.id]);
      const recovery=require('../src/services/magento/sync-job-recovery'),opts={databasePool:db,actorUserId:actor,fetchImpl,preview};
      const reviewed=await recovery.inspect(config,original.id,opts);assert.equal(reviewed.canReconcile,true,JSON.stringify(reviewed.blockers));assert.equal(reviewed.review.complete,true);
      const count=writes.length,result=await recovery.reconcile(config,original.id,{review:reviewed.review,reviewHash:reviewed.reviewHash,reason:'Exact lost-response readback'},opts);
      assert.equal(result.job.state,'succeeded');assert.equal(result.remoteWrites,0);assert.equal(writes.length,count);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_first_sync_sessions WHERE public_product_identity_id=$1',[item.public_product_identity_id])).rows[0].n,0);
      assert.equal((await db.query('SELECT state FROM product_media_jobs WHERE id=$1',[item.media.jobId])).rows[0].state,'pending');
      raw=null;english=null;
    });
    await t.test('exact reviewed broader resync can re-enroll a parked birth without changing its initial lifecycle or photos',async()=>{
      const item=await make(),before=await footprint(item),count=writes.length;
      await db.query("UPDATE magento_product_sync_requests SET state='needs_attention',reason_code='data_or_binding' WHERE product_id=$1",[item.id]);
      const controlled=require('../src/services/magento/binding-controlled-actions');
      const input={bindingRevisionId:binding.id,expectedRevision:binding.revision,kind:'broader_resync',productIds:[item.id],reason:'Exact reviewed parked birth fixture'};
      const reviewed=await controlled.preview(config,input,options);assert.deepEqual(reviewed.blockers,[]);
      assert.deepEqual(reviewed.products.map(p=>p.productId),[item.id]);
      await controlled.apply(config,{...input,previewToken:reviewed.previewToken},options);
      await require('../src/services/magento/binding-handoff').processHandoffs(config,{databasePool:db});
      const request=await readRequest(item);assert.equal(request.state,'pending');assert.equal(request.desired_generation,'2');
      assert.ok(await native.readOnClient(db,config,await observation(item)));
      assert.equal(writes.length,count);assert.deepEqual(await footprint(item),before);
    });
    async function assertUndispatchedBlocked(item,job){
      const count=writes.length,before=await footprint(item);
      const outcome=await jobs.applyJob(config,job.id,await automatic(item)).then(value=>({value}),error=>({error}));
      if(outcome.error){assert.equal(outcome.error.statusCode,409);assert.match(outcome.error.code,/^MAGENTO_/);}
      else{assert.equal(outcome.value.state,'blocked',JSON.stringify(outcome.value.failure));assert.match(outcome.value.failure.code,/^MAGENTO_/);}
      assert.equal(writes.length,count);assert.deepEqual(await footprint(item),before);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_steps WHERE job_id=$1',[job.id])).rows[0].n,0);
    }
    for(const kind of ['identity','source','lifecycle'])await t.test('exact native NM length does not bypass '+kind+' drift before CREATE',async()=>{
      raw=null;english=null;const item=await make(),job=await jobs.enqueue(config,{sku:item.public_sku,bindingRevisionId:binding.id},await automatic(item));
      if(kind==='identity')raw={id:8999,sku:item.public_sku,attribute_set_id:8001,type_id:'simple',name:'Foreign',status:2,visibility:4,
        price:100,custom_attributes:[{attribute_code:lengthTarget,value:'77.5'}],extension_attributes:{category_links:[]}};
      else{
        const writer=new Client({connectionString:target.toString()});await writer.connect();
        try{
          if(kind==='source')await writer.query("UPDATE products SET details=jsonb_set(details,'{answers,neckle_size}','\"78\"'::jsonb) WHERE id=$1",[item.id]);
          else await writer.query("UPDATE product_full_export_state SET business_exclusion_state='excluded',delivery_version=delivery_version+1 WHERE product_id=$1",[item.id]);
        }finally{await writer.end();}
      }
      await assertUndispatchedBlocked(item,job);raw=null;english=null;
    });
    await t.test('exact native NM length does not authorize a queued CREATE under a replaced publication',async()=>{
      const item=await make(),job=await jobs.enqueue(config,{sku:item.public_sku,bindingRevisionId:binding.id},await automatic(item));
      const next=await bindings.clonePublished(binding.id,{expectedRevision:binding.revision},options);
      const published=await bindings.publishDraft(next.id,{expectedRevision:next.revision,expectedCurrentId:binding.id},options);
      assert.notEqual(published.id,binding.id);await assertUndispatchedBlocked(item,job);
    });
  }finally {
    globalThis.fetch=previousFetch;if(db)await db.end();if(appPool)await appPool.end();
    if(created) {
      // pg-pool removes a client before its socket's graceful end has reached
      // PostgreSQL. Wait for those owned sockets, instead of force-killing them.
      let remaining;
      for(let attempt=0;attempt<100;attempt++) {
        remaining=(await control.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1',[name])).rows[0].n;
        if(!remaining)break;await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(remaining,0,'Every fixture pool/connection must close before dropping the owned database');
      await control.query(`DROP DATABASE ${name}`);
    }
    await control.end();
  }
});
