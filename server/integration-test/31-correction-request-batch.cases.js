const suite = require('./suite-context');
const { assert, test, Pool, TEST_DATABASE_URL, fs, os, path } = suite;
const gate = require('../src/services/full-product-cutover-gate');
// Synthetic drift/setup writes retain the lifecycle writer contract when the
// preceding serialized cases have already activated it. Runtime calls still use
// their real primitives and locks; independent race clients remain independent.
const pool = {
  connect: () => suite.pool.connect(),
  async query(sql, args) {
    if (!/^\s*(INSERT|UPDATE|DELETE|ALTER)\b/i.test(sql)) return suite.pool.query(sql,args);
    const client = await suite.pool.connect();
    try { await gate.begin(client); const result=await client.query(sql,args); await gate.commit(client); return result; }
    catch(cause) { await gate.rollback(client); throw cause; }
    finally { await gate.release(client); client.release(); }
  },
};
const service = require('../src/services/correction-request-batch.service');
const requests = require('../src/services/correction-request.service');
const products = require('../src/services/product.service');
const price = require('../src/services/product-price-change.service');
const e = require('../src/services/correction-request-batch-evidence');
const receipts = require('../src/services/correction-request-batch-receipts');
const cli = require('../scripts/correction-request-batch');
const { createReceiptWriter } = require('../scripts/exposure-bulk-receipt');

test('migration 058 upgrades immutable audit history, rolls back, and repeats with a checksum',async()=>{
  const name='amber_batch_receipt_upgrade_test',url=await suite.recreateTestDatabase(name),db=new Pool({connectionString:url});
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'amber-batch-checkpoint-'));
  try{
    for(const file of (await fs.readdir(path.join(suite.serverRoot,'migrations'))).filter(f=>f.endsWith('.sql')&&f<'058'))
      await fs.copyFile(path.join(suite.serverRoot,'migrations',file),path.join(directory,file));
    await suite.runNodeInDatabase(url,`require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}});`);
    const actor=(await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Migration actor') RETURNING id")).rows[0].id;
    const sql="INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,details) VALUES($1,$2,'{\"displayName\":\"Migration actor\",\"preferredUsername\":null}','correction_batch_step',$3,$4::jsonb)";
    await db.query(sql,['fixture.created',actor,'historical','{}']);
    const before=(await db.query('SELECT * FROM audit_events')).rows;
    const migration=await fs.readFile(path.join(suite.serverRoot,'migrations/058_correction_batch_phase_receipts.sql'),'utf8'),client=await db.connect();
    try{await client.query('BEGIN');await client.query(migration);await client.query('ROLLBACK');}finally{client.release();}
    assert.equal((await db.query("SELECT to_regclass('correction_batch_step_identity_idx') idx")).rows[0].idx,null);
    await suite.runNodeInDatabase(url,"(async()=>{const m=require('./src/db/run-migrations');await m.runMigrations();await m.runMigrations();})().catch(e=>{console.error(e);process.exitCode=1;});");
    assert.deepEqual((await db.query('SELECT * FROM audit_events')).rows,before);
    const migrationRow=(await db.query("SELECT checksum FROM schema_migrations WHERE name='058_correction_batch_phase_receipts.sql'")).rows;
    assert.equal(migrationRow.length,1);assert.match(migrationRow[0].checksum,/^[a-f0-9]{64}$/);
    await assert.rejects(db.query(sql,[receipts.EVENT,actor,`${e.hash('invalid')}:claimed`,JSON.stringify({phase:null})]),{code:'23514'});
    await assert.rejects(db.query("UPDATE audit_events SET details='{}' WHERE subject_id='historical'"),/immutable/);
  }finally{
    assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});await db.end();await suite.dropTestDatabase(name);
  }
});

test('correction bulk processor: reviewed primitives, unique receipts and crash recovery', async t => {
  const expectedDatabase = (await pool.query('SELECT current_database() name')).rows[0].name;
  const actor = Number((await pool.query("INSERT INTO application_users(status,display_name) VALUES('active','Batch actor') RETURNING id")).rows[0].id);
  const other = Number((await pool.query("INSERT INTO application_users(status,display_name) VALUES('active','Other batch actor') RETURNING id")).rows[0].id);
  for (const id of [actor,other]) await pool.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'",[id]);
  if (!(await pool.query('SELECT enabled FROM public_sku_activation WHERE singleton')).rows[0].enabled) {
    const client=await suite.pool.connect();
    try {
      await gate.begin(client,'BEGIN');
      const event=async key=>(await client.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id)
        VALUES($1,$2,'{"displayName":"Batch actor","preferredUsername":null}','fixture','fixture') RETURNING id`,[key,actor])).rows[0].id;
      const activation=await event('public_sku.activated'),cutover=await event('magento_delivery.cutover');
      await client.query("SET LOCAL amber.public_sku_activation='on'; SET LOCAL amber.magento_delivery_cutover='on'");
      await client.query(`UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton`,[actor,activation]);
      await client.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='native-batch-fixture',actor_user_id=$1,legacy_product_csv_enabled=FALSE,
        cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`,[actor,cutover]);
      await gate.commit(client);
    } catch(error){await gate.rollback(client);throw error;}
    finally{await gate.release(client);client.release();}
  }
  await pool.query("INSERT INTO categories(code,name,requires_weight,marketing_rounding_enabled) VALUES('BT','Batch fixture',1,1)");
  const q = (await pool.query("INSERT INTO questions(category_code,key,label,sku_index,display_order,required,include_in_sku,input_type) VALUES('BT','kind','Kind',1,1,1,1,'options') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,1,'1','One'),($1,2,'2','Two')",[q]);
  const extraQuestion=(await pool.query("INSERT INTO questions(category_code,key,label,sku_index,display_order,required,include_in_sku,input_type,visible_if_json) VALUES('BT','extra','Extra',2,2,0,1,'options','{\"kind\":1}') RETURNING id")).rows[0].id;
  await pool.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,7,'7','Inherited')",[extraQuestion]);
  const scenario = (await pool.query("INSERT INTO price_scenarios(category_code,name,match_json,axis_x_key,price_mode,status) VALUES('BT','Batch fixed','{}','kind','fixed_uah','active') RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO price_matrix(scenario_id,x_val,y_val,price) VALUES($1,1,0,1000),($1,2,0,1500)',[scenario]);
  await require('../src/services/sku-schema.service').ensureLegacySkuSchemas();
  const schema = await require('../src/services/sku-schema.service').getActiveSchema('BT');
  const mutationContext = { actorUserId:actor,requestId:'batch-integration' };
  const observation = {rateInfo:{rate:40,rateDate:new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Kyiv'}),
    fetchedAt:new Date().toISOString(),source:'nbu',stale:false,ageMs:0,error:null},rateError:null};
  const connectionTargetHash = cli.connectionTarget(TEST_DATABASE_URL);
  const buildId=await cli.buildIdentity();
  const base = { databasePool:pool,expectedDatabase,actorUserId:actor,connectionTargetHash,buildId,observeRate:async()=>observation };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'amber-correction-batch-'));
  let outputNumber=0, sourceWeight=5;
  const source = async () => {
    const weight=++sourceWeight;
    const preview = await products.buildNewProductPreview({categoryCode:'BT',answers:{kind:1,extra:7},weight,skuSchemaVersionId:schema.id});
    return products.saveProduct({category:'BT',answers:{kind:1,extra:7},weight,skuSchemaVersionId:schema.id,characteristicConfigHash:preview.characteristicConfigHash,previewToken:preview.previewToken},{mutationContext});
  };
  const recount = async (mode='system_auto') => {
    const p=await source(),payload={sourceSku:(p.fullSku || p.publicSku),answers:{kind:2},pricingDecision:mode==='manual_uah'
      ? {mode,manualPriceUah:1511.25} : mode==='usd_per_gram' ? {mode,usdPerGram:9.25,marketingRoundingEnabled:false} : {mode}};
    const preview=await requests.previewCorrectionRequest(payload,{canOverride:true});
    const created=await requests.createCorrectionRequest({...payload,previewSignature:preview.previewSignature},{mutationContext,canOverride:true});
    return {id:created.request.id,productId:p.id,sku:(p.fullSku || p.publicSku)};
  };
  const pricing = async (decision={mode:'manual_uah',manualPriceUah:1234.56,marketingRoundingEnabled:false}) => {
    const p=await source(),payload={requestType:'price_change',productId:p.id,pricingDecision:decision};
    if(decision.mode==='system_auto')await pool.query('UPDATE products SET total_price_uah=900 WHERE id=$1',[p.id]);
    const preview=await requests.previewCorrectionRequest(payload,{canOverride:true});
    const created=await requests.createCorrectionRequest({...payload,characteristicConfigHash:preview.characteristicConfigHash,previewToken:preview.previewToken},{mutationContext,canOverride:true});
    return {id:created.request.id,productId:p.id,sku:(p.fullSku || p.publicSku)};
  };
  const preview = async candidates => service.preflight({...base,requestIds:candidates.map(x=>x.id)});
  const apply = async (plan, selected=plan.entries.filter(e.eligible).map(x=>x.requestId), extra={}) => {
    const selection=service.select(plan,plan.planHash,selected,plan.entries.filter(x=>selected.includes(x.requestId)&&x.postDeliveryReviewRequired).map(x=>x.requestId));
    const checkpoint=await createReceiptWriter(path.join(directory,String(++outputNumber)));
    return service.apply(plan,selection,{...base,expectedHash:plan.planHash,expectedSelectionHash:selection.selectionHash,checkpoint,...extra});
  };
  const state=async()=> (await pool.query(`SELECT
    (SELECT jsonb_agg(p ORDER BY id) FROM products p) products,
    (SELECT jsonb_agg(r ORDER BY id) FROM correction_requests r) requests,
    (SELECT jsonb_agg(c ORDER BY id) FROM product_corrections c) corrections,
    (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) lifecycle,
    (SELECT jsonb_agg(r ORDER BY product_id) FROM product_export_revisions r) price_revisions,
    (SELECT jsonb_agg(r ORDER BY public_product_identity_id) FROM magento_product_sync_requests r) sync,
    (SELECT jsonb_agg(r ORDER BY currency_pair) FROM exchange_rate_cache r) rates,
    (SELECT jsonb_agg(r ORDER BY full_sku) FROM sku_registry r) reservations,
    (SELECT count(*) FROM audit_events) audits,(SELECT count(*) FROM magento_sync_jobs) jobs,
    (SELECT count(*) FROM magento_binding_handoffs) handoffs`)).rows[0];
  let completedPlan;
  await t.test('preflight is read-only and freezes exact all-active bounded scope',async()=>{
    const r=await recount(),before=await state();
    const plan=await preview([r]);
    assert.equal(plan.entries[0].classification,'SAFE_TO_COMPLETE',JSON.stringify(plan.entries[0]));
    assert.deepEqual(await state(),before);
    const all=await service.preflight({...base,allActive:true,limit:1000});
    assert.ok(all.requestIds.includes(r.id));
    await pricing();
    await assert.rejects(service.preflight({...base,allActive:true,limit:1}),{code:'CORRECTION_BATCH_SCOPE_OVERFLOW'});
    completedPlan=plan;
  });
  await t.test('pending recount commits through normal history/audits and same-plan resume does not repeat',async()=>{
    const report=await apply(completedPlan);assert.equal(report.counts.completed,1,JSON.stringify(report));
    const before=await state(),retry=await apply(completedPlan);
    assert.equal(retry.counts.skipped,1);assert.equal(retry.outcomes[0].reason,'ALREADY_APPLIED');assert.deepEqual(await state(),before);
    const key=receipts.key(service.reviewContext(completedPlan,service.select(completedPlan,completedPlan.planHash,completedPlan.requestIds,
      completedPlan.entries.filter(x=>x.postDeliveryReviewRequired).map(x=>x.requestId)),completedPlan.entries[0],actor));
    const phases=(await pool.query("SELECT details->>'phase' phase,actor_user_id FROM audit_events WHERE event_key=$1 AND subject_id LIKE $2 ORDER BY id",[receipts.EVENT,`${key}:%`])).rows;
    assert.deepEqual(phases.map(x=>x.phase),['claimed','refreshed','completed']);assert.ok(phases.every(x=>Number(x.actor_user_id)===actor));
  });
  await t.test('native successor remains the sole current owner and supports another reviewed recount and price change',async()=>{
    const first=completedPlan.entries[0],article=first.publicArticle;
    const active=(await pool.query("SELECT * FROM products WHERE public_product_identity_id=$1 AND status='active' AND corrected_to_product_id IS NULL",[first.publicIdentityId])).rows[0];
    assert.notEqual(active.id,first.sourceProductId);assert.equal(active.full_sku,null);
    const input={sourceSku:article,answers:{kind:1},pricingDecision:{mode:'system_auto'}};
    const checked=await requests.previewCorrectionRequest(input,{canOverride:true});
    const created=await requests.createCorrectionRequest({...input,previewSignature:checked.previewSignature},{mutationContext,canOverride:true});
    const candidate={id:created.request.id,productId:active.id,sku:article},plan=await preview([candidate]);
    assert.equal(plan.entries[0].classification,'SAFE_TO_COMPLETE',JSON.stringify(plan.entries[0].reasons));
    assert.equal((await apply(plan)).counts.completed,1);
    const next=(await pool.query("SELECT * FROM products WHERE public_product_identity_id=$1 AND status='active' AND corrected_to_product_id IS NULL",[first.publicIdentityId])).rows[0];
    assert.equal(next.corrected_from_product_id,active.id);assert.equal(next.full_sku,null);
    assert.equal((await products.decodeSku(article)).product.id,next.id);
    const priceInput={requestType:'price_change',productId:next.id,pricingDecision:{mode:'manual_uah',manualPriceUah:1299,marketingRoundingEnabled:false}};
    const priceChecked=await requests.previewCorrectionRequest(priceInput,{canOverride:true});
    const priceRequest=await requests.createCorrectionRequest({...priceInput,previewToken:priceChecked.previewToken},{mutationContext,canOverride:true});
    assert.equal((await apply(await preview([{id:priceRequest.request.id}]))).counts.completed,1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM products WHERE public_product_identity_id=$1',[first.publicIdentityId])).rows[0].n,3);
    assert.equal((await pool.query('SELECT count(*)::int n FROM sku_registry WHERE first_product_id=ANY($1::int[])',[[first.sourceProductId,active.id,next.id]])).rows[0].n,0);
  });
  await t.test('version-4 evidence with proven same intent refreshes; missing history requires individual review',async()=>{
    const r=await recount();await pool.query("UPDATE correction_requests SET proposed_payload=jsonb_set(proposed_payload,'{recountEvidence,version}','4') WHERE id=$1",[r.id]);
    const plan=await preview([r]);assert.equal(plan.entries[0].classification,'REFRESH_SAME_INTENT',JSON.stringify(plan.entries[0]));
    assert.equal((await apply(plan)).counts.completed,1);
    const old=await recount();await pool.query("UPDATE correction_requests SET proposed_payload=proposed_payload-'recountEvidence' WHERE id=$1",[old.id]);
    assert.equal((await preview([old])).entries[0].classification,'REVIEW_REQUIRED');
  });
  await t.test('actor ownership is preserved, other/token-only claims are excluded, legacy tokenless rows claim normally',async()=>{
    const own=await pricing();await requests.claimCorrectionRequest(own.id,{mutationContext});
    const mine=await preview([own]);assert.equal((await apply(mine)).counts.completed,1);
    const another=await pricing();await requests.claimCorrectionRequest(another.id,{mutationContext:{actorUserId:other}});
    assert.equal((await preview([another])).entries[0].classification,'OWNERSHIP_BLOCKED');
    const token=await pricing();await pool.query("UPDATE correction_requests SET status='in_progress',claimed_at=CURRENT_TIMESTAMP,claim_token_hash=$2 WHERE id=$1",[token.id,requests.getClaimTokenHash('x'.repeat(40))]);
    assert.equal((await preview([token])).entries[0].reasons[0],'LEGACY_TOKEN_ONLY');
    // Reproduce a NOT VALID historical row without weakening current constraints.
    const legacy=await pricing();await pool.query("ALTER TABLE correction_requests DROP CONSTRAINT correction_requests_in_progress_has_owner");
    try {await pool.query("UPDATE correction_requests SET status='in_progress' WHERE id=$1",[legacy.id]);}
    finally {await pool.query(`ALTER TABLE correction_requests ADD CONSTRAINT correction_requests_in_progress_has_owner
      CHECK(status<>'in_progress' OR (claimed_at IS NOT NULL AND (claimed_by_user_id IS NOT NULL OR claim_token_hash IS NOT NULL))) NOT VALID`);}
    assert.equal((await apply(await preview([legacy]))).counts.completed,1);
  });
  await t.test('price-only manual/rounded/USD/automatic decisions complete in place with exact stored decision',async()=>{
    for(const decision of [{mode:'manual_uah',manualPriceUah:1234.56,marketingRoundingEnabled:false},
      {mode:'manual_uah',manualPriceUah:1234.56,marketingRoundingEnabled:true},
      {mode:'usd_per_gram',usdPerGram:7.125,marketingRoundingEnabled:false},{mode:'system_auto'}]){
      const r=await pricing(decision);
      const before=(await pool.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[r.productId])).rows[0];
      const report=await apply(await preview([r]));assert.equal(report.counts.completed,1,JSON.stringify(report));
      const row=(await pool.query('SELECT * FROM correction_requests WHERE id=$1',[r.id])).rows[0];
      assert.equal(row.corrected_product_id,null);assert.deepEqual(row.final_payload.pricingDecision,decision);
      assert.deepEqual((await pool.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[r.productId])).rows[0],before);
      assert.equal((await pool.query('SELECT count(*) FROM product_corrections WHERE source_product_id=$1',[r.productId])).rows[0].count,'0');
    }
  });
  await t.test('manual baseline, semantic target and target validation changes do not become safe',async()=>{
    const manual=await recount('manual_uah');await pool.query('UPDATE price_matrix SET price=1600 WHERE scenario_id=$1 AND x_val=2',[scenario]);
    assert.equal((await preview([manual])).entries[0].classification,'REVIEW_REQUIRED');
    await pool.query('UPDATE price_matrix SET price=1500 WHERE scenario_id=$1 AND x_val=2',[scenario]);
    const invalid=await recount();await pool.query("UPDATE correction_requests SET proposed_payload=jsonb_set(proposed_payload,'{answers,kind}','999') WHERE id=$1",[invalid.id]);
    assert.equal((await preview([invalid])).entries[0].classification,'INVALID_OR_BLOCKED');
  });
  await t.test('request/claim-version drift after preview conflicts without completion',async()=>{
    const r=await pricing(),plan=await preview([r]);
    await requests.claimCorrectionRequest(r.id,{mutationContext:{actorUserId:other}});
    const report=await apply(plan);assert.equal(report.counts.conflicted,1);assert.equal(report.outcomes[0].currentClaim.status,'in_progress');
    const changed=await pricing(),p=await preview([changed]);await pool.query("UPDATE correction_requests SET comment='changed after review',updated_at=CURRENT_TIMESTAMP WHERE id=$1",[changed.id]);
    assert.equal((await apply(p)).counts.conflicted,1);
  });
  await t.test('claim-version race on independent connections conflicts after the lock wait',async()=>{
    const r=await pricing(),plan=await preview([r]),holder=await pool.connect();
    const runner=new Pool({connectionString:TEST_DATABASE_URL,max:1});let pending;
    try{
      const pid=(await runner.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      await gate.begin(holder);await holder.query('SELECT id FROM correction_requests WHERE id=$1 FOR UPDATE',[r.id]);
      pending=apply(plan,undefined,{databasePool:runner});pending.catch(()=>{});let blocked=false;
      for(let i=0;i<600&&!blocked;i++){blocked=(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked;if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));}
      assert.equal(blocked,true);await holder.query('UPDATE correction_requests SET claim_version=claim_version+1 WHERE id=$1',[r.id]);await holder.query('COMMIT');
      const report=await pending;assert.equal(report.counts.conflicted,1);assert.equal(report.outcomes[0].currentClaim.status,'pending');
    }finally{await gate.rollback(holder);await gate.release(holder);holder.release();if(pending)await Promise.allSettled([pending]);await runner.end();}
  });
  await t.test('unrelated creation preserves native recount identity while legacy allocation drift requires review',async()=>{
    const r=await recount(),plan=await preview([r]),weight=plan.entries[0].refreshedResult.corrected.weight;
    const input={categoryCode:'BT',answers:{kind:2},weight,skuSchemaVersionId:schema.id};
    const p=await products.buildNewProductPreview(input);
    await products.saveProduct({category:'BT',answers:input.answers,weight,skuSchemaVersionId:schema.id,characteristicConfigHash:p.characteristicConfigHash,previewToken:p.previewToken},{mutationContext});
    const report=await apply(plan);
    if (plan.entries[0].refreshedResult.corrected.mode === 'public_identity') {
      assert.equal(report.counts.completed,1,JSON.stringify(report));
      const successor=(await pool.query(`SELECT p.full_sku,i.public_sku FROM products p JOIN public_product_identities i
        ON i.id=p.public_product_identity_id WHERE p.corrected_from_product_id=$1`,[r.productId])).rows[0];
      assert.equal(successor.full_sku,null); assert.equal(successor.public_sku,r.sku);
    } else {
      assert.equal(report.counts.conflicted,1);assert.equal(report.outcomes[0].currentClaim.status,'pending');
      assert.equal((await preview([r])).entries[0].classification,'REVIEW_REQUIRED');
    }
  });
  await t.test('completed/rejected between preview and apply are not credited to this batch',async()=>{
    const r=await pricing(),plan=await preview([r]);const claim=await requests.claimCorrectionRequest(r.id,{mutationContext});
    await requests.completeCorrectionRequest(r.id,claim.request.claimVersion,null,{mutationContext});
    assert.equal((await apply(plan)).counts.conflicted,1);
    const rejected=await pricing(),p=await preview([rejected]);await requests.updateCorrectionRequestStatus(rejected.id,'rejected',null,null,{mutationContext});
    assert.equal((await apply(p)).counts.conflicted,1);
  });
  await t.test('earlier successful rows survive later conflicts and infrastructure stop leaves pending IDs',async()=>{
    const a=await pricing(),b=await pricing(),plan=await preview([a,b]);
    await pool.query("UPDATE correction_requests SET comment='drift' WHERE id=$1",[b.id]);
    const report=await apply(plan);assert.equal(report.counts.completed,1);assert.equal(report.counts.conflicted,1);
    const c=await pricing(),d=await pricing(),p=await preview([c,d]);
    await pool.query("UPDATE application_users SET status='disabled' WHERE id=$1",[actor]);
    try {const stopped=await apply(p);assert.equal(stopped.counts.failed,1);assert.equal(stopped.counts.pending,1);assert.equal(stopped.stoppedReason,'ADMIN_PERMISSION_REVOKED');}
    finally {await pool.query("UPDATE application_users SET status='active' WHERE id=$1",[actor]);}
  });
  await t.test('database-enforced phase uniqueness serializes independent inserts and duplicate rolls back',async()=>{
    const a=await pool.connect(),b=await pool.connect(),step=`${e.hash({proof:'uniqueness'})}:claimed`;
    const sql=`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,details)
      VALUES($1,$2,'{"displayName":"Batch actor","preferredUsername":null}','correction_batch_step',$3,$4::jsonb)`;
    const details={entryKey:step.split(':')[0],entryHash:e.hash('entry'),planHash:e.hash('plan'),selectionHash:e.hash('selection'),requestId:999,
      phase:'claimed',afterRequestHash:e.hash('after')};let pending;
    try{
      await a.query('BEGIN');await b.query('BEGIN');await a.query(sql,[receipts.EVENT,actor,step,JSON.stringify(details)]);
      const pid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      pending=b.query(sql,[receipts.EVENT,actor,step,JSON.stringify(details)]);pending.catch(()=>{});
      let blocked=false;
      for(let i=0;i<600&&!blocked;i++){blocked=(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 blocked',[pid])).rows[0].blocked;if(!blocked)await new Promise(r=>setTimeout(r,10));}
      assert.equal(blocked,true);await a.query('COMMIT');await assert.rejects(pending,{code:'23505'});await b.query('ROLLBACK');
      assert.equal((await pool.query('SELECT count(*) FROM audit_events WHERE subject_id=$1',[step])).rows[0].count,'1');
    }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
  });
  await t.test('crash after claim resumes from authoritative phase receipt in a fresh process',async()=>{
    const r=await pricing(),plan=await preview([r]),selection=service.select(plan,plan.planHash,[r.id]);
    const planPath=path.join(directory,'crash-plan.json'),selectionPath=path.join(directory,'crash-selection.json');
    await fs.writeFile(planPath,JSON.stringify(plan));await fs.writeFile(selectionPath,JSON.stringify(selection));
    const crash=`const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(${JSON.stringify(planPath)},'utf8'));const s=JSON.parse(fs.readFileSync(${JSON.stringify(selectionPath)},'utf8'));
      const svc=require('./src/services/correction-request-batch.service'),req=require('./src/services/correction-request.service'),db=require('./src/db/pool');
      const review=svc.reviewContext(p,s,p.entries[0],${actor});
      const borrowedPool={connect:async()=>{const c=await db.connect();return{query:async(sql,args)=>{const result=await c.query(sql,args);
        if(sql==='COMMIT')process.exit(0);return result;},release:()=>c.release()};}};
      req.claimCorrectionRequest(${r.id},{databasePool:borrowedPool,batchReview:review,rateObservation:p.rateObservation,mutationContext:{actorUserId:${actor}}}).catch(e=>{console.error(e);process.exit(1);});`;
    await suite.runNodeInDatabase(TEST_DATABASE_URL,crash);
    assert.equal((await pool.query('SELECT status FROM correction_requests WHERE id=$1',[r.id])).rows[0].status,'in_progress');
    const result=await suite.execFileAsync(process.execPath,['scripts/correction-request-batch.js','apply','--expected-database',expectedDatabase,
      '--actor-user-id',String(actor),'--plan',planPath,'--expected-hash',plan.planHash,'--selection',selectionPath,
      '--expected-selection-hash',selection.selectionHash,'--output',path.join(directory,'fresh-process')],
    {cwd:suite.serverRoot,env:{...process.env,DATABASE_URL:TEST_DATABASE_URL,NBU_RATE_OVERRIDE:'40'}});
    assert.match(result.stdout,/'completed'|"completed":1/);
  });
  await t.test('lost post-commit disk receipt recovers without another completion',async()=>{
    const r=await pricing(),plan=await preview([r]),selection=service.select(plan,plan.planHash,[r.id]);let calls=0;
    await assert.rejects(service.apply(plan,selection,{...base,expectedHash:plan.planHash,expectedSelectionHash:selection.selectionHash,
      checkpoint:async()=>{if(++calls===2)throw Error('synthetic disk failure');}}),/synthetic disk failure/);
    const before=await state();assert.equal((await apply(plan)).counts.skipped,1);assert.deepEqual(await state(),before);
  });
  await t.test('simultaneous same-plan runners never double-complete',async()=>{
    const r=await pricing(),plan=await preview([r]);const independent=new Pool({connectionString:TEST_DATABASE_URL,max:2});
    try{
      const [a,b]=await Promise.all([apply(plan),apply(plan,undefined,{databasePool:independent})]);
      assert.equal(a.counts.completed+b.counts.completed,1);
      assert.equal((await pool.query("SELECT count(*) FROM audit_events WHERE event_key='correction_request.completed' AND subject_id=$1",[String(r.id)])).rows[0].count,'1');
    }finally{await independent.end();}
  });
  await t.test('completion receipt failure rolls back product/history/lifecycle and normal audits together',async()=>{
    for(const create of [pricing,recount]){
      const r=await create(),claim=await requests.claimCorrectionRequest(r.id,{mutationContext}),plan=await preview([r]);
      const selection=service.select(plan,plan.planHash,[r.id],plan.entries.filter(x=>x.postDeliveryReviewRequired).map(x=>x.requestId));
      const review=service.reviewContext(plan,selection,plan.entries[0],actor);
      await requests.refreshCorrectionRequest(r.id,claim.request.claimVersion,null,
        {mutationContext,batchReview:review,databasePool:pool,rateObservation:observation});
      const before=await state();
      const failing={query:(...args)=>pool.query(...args),connect:async()=>{
        const client=await pool.connect();return{release:()=>client.release(),query:(sql,args)=>{
          if(/INSERT INTO audit_events/.test(sql)&&args[0]===receipts.EVENT&&args[4].endsWith(':completed')) throw Error('synthetic receipt failure');
          return client.query(sql,args);
        }};
      }};
      const report=await apply(plan,undefined,{databasePool:failing});
      assert.equal(report.counts.failed,1);assert.deepEqual(await state(),before);
      assert.equal((await apply(plan)).counts.completed,1);
    }
  });
  await t.test('observed rate HTTP finishes outside transactions and preflight never writes the cache',async()=>{
    const r=await pricing(),observedPool=new Pool({connectionString:TEST_DATABASE_URL,max:2,application_name:'amber_batch_rate_proof'});
    const {observeUsdRate}=require('../src/services/currency.service');let fetches=0;
    const observeRate=()=>observeUsdRate({databasePool:observedPool,fetchLive:async()=>{
      fetches++;
      const active=(await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='amber_batch_rate_proof' AND state LIKE '%transaction%'")).rows[0].n;
      assert.equal(active,0,'HTTP must finish before BEGIN');return observation.rateInfo;
    }});
    const cache=async()=>(await pool.query('SELECT * FROM exchange_rate_cache ORDER BY currency_pair')).rows;
    const savedFetch=globalThis.fetch;globalThis.fetch=()=>assert.fail('batch must never dispatch Magento or another HTTP call');
    try{
      const before=await cache(),plan=await service.preflight({...base,databasePool:observedPool,observeRate,requestIds:[r.id]});
      assert.deepEqual(await cache(),before);assert.deepEqual(e.stableResult(plan.rateObservation.rateInfo),e.stableResult(observation.rateInfo));
      assert.equal((await apply(plan,undefined,{databasePool:observedPool,observeRate})).counts.completed,1);
      assert.equal(fetches,2);assert.deepEqual(await cache(),before);
    }finally{globalThis.fetch=savedFetch;await observedPool.end();}
  });
  await t.test('CLI preflight/select/apply use exact files, read-only connection and resumable persistent summaries',async()=>{
    const r=await pricing(),planPath=path.join(directory,'cli-plan.json'),idsPath=path.join(directory,'cli-ids.json'),selectionPath=path.join(directory,'cli-selection.json');
    await fs.writeFile(idsPath,JSON.stringify([r.id]));
    const run=async(args,env={})=>suite.execFileAsync(process.execPath,['scripts/correction-request-batch.js',...args],
      {cwd:suite.serverRoot,env:{...process.env,DATABASE_URL:TEST_DATABASE_URL,NBU_RATE_OVERRIDE:'40',...env}});
    const before=await state();
    await run(['preflight','--expected-database',expectedDatabase,'--actor-user-id',String(actor),'--ids-file',idsPath,'--output',planPath]);
    assert.deepEqual(await state(),before);
    const plan=JSON.parse(await fs.readFile(planPath,'utf8'));
    await run(['select','--plan',planPath,'--expected-hash',plan.planHash,'--ids-file',idsPath,'--output',selectionPath],{DATABASE_URL:''});
    const selection=JSON.parse(await fs.readFile(selectionPath,'utf8'));
    const args=['apply','--expected-database',expectedDatabase,'--actor-user-id',String(actor),'--plan',planPath,'--expected-hash',plan.planHash,
      '--selection',selectionPath,'--expected-selection-hash',selection.selectionHash,'--output'];
    const output=path.join(directory,'cli-apply');await run([...args,output]);
    assert.equal(JSON.parse(await fs.readFile(path.join(output,'summary.json'),'utf8')).counts.completed,1);
    const retry=path.join(directory,'cli-retry'),after=await state();await run([...args,retry]);
    assert.equal(JSON.parse(await fs.readFile(path.join(retry,'summary.json'),'utf8')).counts.skipped,1);assert.deepEqual(await state(),after);
    await assert.rejects(run([...args,output]),{code:1});assert.deepEqual(await state(),after);
  });
  await t.test('rate/configuration drift after review conflicts before acquiring a claim',async()=>{
    const r=await pricing({mode:'usd_per_gram',usdPerGram:8,marketingRoundingEnabled:false}),plan=await preview([r]);
    const report=await apply(plan,undefined,{observeRate:async()=>({rateInfo:{...observation.rateInfo,rate:41},rateError:null})});
    assert.equal(report.counts.conflicted,1);assert.equal(report.outcomes[0].currentClaim.status,'pending');
    const automatic=await pricing({mode:'system_auto'}),autoPlan=await preview([automatic]);
    await pool.query('UPDATE price_matrix SET price=1100 WHERE scenario_id=$1 AND x_val=1',[scenario]);
    try{assert.equal((await preview([automatic])).entries[0].classification,'REVIEW_REQUIRED');assert.equal((await apply(autoPlan)).counts.conflicted,1);}
    finally{await pool.query('UPDATE price_matrix SET price=1000 WHERE scenario_id=$1 AND x_val=1',[scenario]);}
  });
  await t.test('ordinary recount hidden/inactive cleanup remains safe only for inherited answers',async()=>{
    const p=await source();
    const input={sourceSku:(p.fullSku || p.publicSku),answers:{kind:2},pricingDecision:{mode:'system_auto'}};
    const checked=await requests.previewCorrectionRequest(input,{canOverride:true});
    const r=await requests.createCorrectionRequest({...input,previewSignature:checked.previewSignature},{mutationContext,canOverride:true});
    // A legacy stored request retained an inherited answer for a hidden target question.
    await pool.query("UPDATE correction_requests SET proposed_payload=jsonb_set(jsonb_set(proposed_payload,'{answers,extra}','7'),'{recountEvidence,version}','4') WHERE id=$1",[r.request.id]);
      const plan=await preview([{id:r.request.id}]);assert.equal(plan.entries[0].classification,'REFRESH_SAME_INTENT',JSON.stringify(plan.entries[0].reasons));
      assert.equal((await apply(plan)).counts.completed,1);
      const row=(await pool.query('SELECT final_payload FROM correction_requests WHERE id=$1',[r.request.id])).rows[0];
      assert.equal(Object.hasOwn(row.final_payload.answers,'extra'),false);
      await assert.rejects(products.buildNewProductPreview({categoryCode:'BT',answers:{kind:1,extra:999},weight:++sourceWeight,skuSchemaVersionId:schema.id}),{statusCode:422});
  });
  await t.test('a historical stale source is excluded rather than redirected to its successor',async()=>{
    const r=await recount();await requests.updateCorrectionRequestStatus(r.id,'rejected',null,null,{mutationContext});
    const input={sourceSku:r.sku,answers:{kind:2}},p=await products.buildProductRecountPreview(input);
    await products.applyProductRecount({...input,sourceStateSignature:p.source.stateSignature},{mutationContext});
    await pool.query("UPDATE correction_requests SET status='pending',rejected_at=NULL WHERE id=$1",[r.id]);
    assert.equal((await preview([r])).entries[0].classification,'STALE_OR_OBSOLETE');
  });
  await t.test('stable public article and historical ambiguity are recorded without hold release or Magento work',async()=>{
    const enabled=(await pool.query('SELECT enabled FROM public_sku_activation WHERE singleton')).rows[0].enabled;
    if(!enabled){const client=await pool.connect();try{
      await client.query('BEGIN');await client.query("SET LOCAL amber.public_sku_activation='on'; SET LOCAL amber.magento_delivery_cutover='on'");
      const event=(await client.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id)
        VALUES('public_sku.activated',$1,'{"displayName":"Batch actor","preferredUsername":null}','fixture','singleton') RETURNING id`,[actor])).rows[0].id;
      await client.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton',[actor,event]);
      const cutover=(await client.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id)
        VALUES('magento_delivery.cutover',$1,'{"displayName":"Batch actor","preferredUsername":null}','fixture','singleton') RETURNING id`,[actor])).rows[0].id;
      await client.query("UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='batch-fixture',actor_user_id=$1,legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton",[actor,cutover]);
      await client.query('COMMIT');
    }finally{await client.query('ROLLBACK');client.release();}}
    const p=await source();await pool.query("UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',evidence='{\"origin\":\"historical\"}',delivery_version=delivery_version+1 WHERE product_id=$1",[p.id]);
    const input={sourceSku:(p.fullSku || p.publicSku),answers:{kind:2},pricingDecision:{mode:'system_auto'}};
    const checked=await requests.previewCorrectionRequest(input,{canOverride:true}),r=await requests.createCorrectionRequest({...input,previewSignature:checked.previewSignature},{mutationContext,canOverride:true});
    const plan=await preview([{id:r.request.id}]),entry=plan.entries[0],before=await state();
    assert.equal(entry.classification,'SAFE_TO_COMPLETE');assert.equal(entry.postDeliveryReviewRequired,true);
    assert.throws(()=>service.select(plan,plan.planHash,[r.request.id]),{code:'CORRECTION_BATCH_SELECTION_INVALID'});
    const report=await apply(plan);assert.equal(report.counts.completed,1,JSON.stringify(report));
    const outcome=report.outcomes[0].result;
    assert.equal(outcome.publicSku,entry.publicArticle);assert.equal(outcome.publicIdentityId,entry.publicIdentityId);
    assert.equal(outcome.lifecycle.route,'hold');assert.equal(outcome.lifecycle.hold_reason,'historical_ambiguity');
    assert.equal(report.postDeliveryReviewCandidates[0].stableRecountReviewCandidate,true);
    const after=await state();assert.equal(after.jobs,before.jobs);assert.equal(after.handoffs,before.handoffs);
  });
  const observeAt=rate=>async()=>({rateInfo:{...observation.rateInfo,rate},rateError:null});
  const usdDecisionFor=rawUah=>({mode:'usd_per_gram',
    usdPerGram:Number((rawUah/40/(sourceWeight+1)).toFixed(4)),marketingRoundingEnabled:true});
  const freshAt=async(r,rate)=>{
    const before=await state(),savedFetch=globalThis.fetch;
    globalThis.fetch=()=>assert.fail('preflight must not perform real external calls');
    try {
      const plan=await service.preflight({...base,requestIds:[r.id],observeRate:observeAt(rate)});
      assert.deepEqual(await state(),before,'preflight cannot write requests, products, audits, lifecycle or rate cache');
      assert.equal(plan.policyVersion,2);assert.equal(plan.toolContract,'correction-batch-v2');
      assert.equal(plan.format,'amber-correction-batch-plan-v2');assert.equal(plan.rateObservation.rateInfo.rate,rate);
      return plan;
    }finally{globalThis.fetch=savedFetch;}
  };
  await t.test('v2 USD price preflight accepts rate-only drift with final 650 and completes using the fresh quote',async()=>{
    const r=await pricing(usdDecisionFor(650)),plan=await freshAt(r,40.1),entry=plan.entries[0];
    assert.equal(entry.classification,'REFRESH_SAME_INTENT',JSON.stringify(entry.reasons));
    assert.equal(entry.storedIntent.proposedPayload.totalPriceUah,650);assert.equal(entry.refreshedResult.resultingPriceUah,650);
    assert.notEqual(entry.storedIntent.proposedPayload.pricing.calculatedPriceUah,entry.refreshedResult.resultingPricing.calculatedPriceUah);
    assert.equal(entry.storedIntent.oldPayload.stateSignature,entry.refreshedResult.productStateSignature);
    const cache=(await pool.query('SELECT * FROM exchange_rate_cache ORDER BY currency_pair')).rows;
    const report=await apply(plan,undefined,{observeRate:observeAt(40.1)});
    assert.equal(report.counts.completed,1,JSON.stringify(report));
    const row=(await pool.query('SELECT * FROM correction_requests WHERE id=$1',[r.id])).rows[0];
    assert.equal(row.corrected_product_id,null);assert.equal(row.final_payload.resultingPricing.uahRate,40.1);
    assert.equal(row.final_payload.resultingPriceUah,650);assert.deepEqual(row.final_payload.pricingDecision,entry.storedIntent.proposedPayload.pricingDecision);
    assert.deepEqual((await pool.query('SELECT * FROM exchange_rate_cache ORDER BY currency_pair')).rows,cache);
  });
  for(const [before,after,rate] of [[260,270,41],[550,600,44]]) await t.test(`v2 rounding boundary ${before} to ${after} remains excluded from selection`,async()=>{
    const r=await pricing(usdDecisionFor(before)),plan=await freshAt(r,rate),entry=plan.entries[0];
    assert.equal(entry.storedIntent.proposedPayload.totalPriceUah,before);
    assert.equal(entry.refreshedResult.resultingPriceUah,after);
    assert.equal(entry.classification,'REVIEW_REQUIRED');
    assert.throws(()=>service.select(plan,plan.planHash,[r.id]),{code:'CORRECTION_BATCH_SELECTION_INVALID'});
    assert.equal((await pool.query('SELECT status FROM correction_requests WHERE id=$1',[r.id])).rows[0].status,'pending');
  });
  await t.test('v2 fresh-price equivalence excludes decision/source input changes, manual and automatic modes',async()=>{
    const decision=await pricing(usdDecisionFor(650));
    await pool.query('UPDATE correction_requests SET pricing_usd_per_gram=pricing_usd_per_gram+0.0001 WHERE id=$1',[decision.id]);
    assert.equal((await freshAt(decision,40.1)).entries[0].classification,'REVIEW_REQUIRED');
    const weight=await pricing(usdDecisionFor(650));
    await pool.query('UPDATE products SET weight=weight+1 WHERE id=$1',[weight.productId]);
    assert.equal((await freshAt(weight,40.1)).entries[0].classification,'REVIEW_REQUIRED');
    const manual=await pricing(),automatic=await pricing({mode:'system_auto'});
    for(const r of [manual,automatic]) {
      // A non-USD result difference cannot use the conversion exception.
      await pool.query("UPDATE correction_requests SET proposed_payload=jsonb_set(proposed_payload,'{pricing,calculatedPriceUah}','999') WHERE id=$1",[r.id]);
      assert.equal((await freshAt(r,40.1)).entries[0].classification,'REVIEW_REQUIRED');
    }
  });
  const heldUsdRecount=async()=>{
    const pricingDecision=usdDecisionFor(650),p=await source();
    await pool.query("UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',evidence='{\"origin\":\"historical\"}',delivery_version=delivery_version+1 WHERE product_id=$1",[p.id]);
    const input={sourceSku:(p.fullSku || p.publicSku),answers:{kind:2},pricingDecision};
    const checked=await requests.previewCorrectionRequest(input,{canOverride:true});
    const created=await requests.createCorrectionRequest({...input,previewSignature:checked.previewSignature},{mutationContext,canOverride:true});
    return{id:created.request.id,productId:p.id};
  };
  await t.test('v2 held USD recount preserves exact 650/target/article and rejects post-plan rate drift before completion',async()=>{
    const r=await heldUsdRecount(),plan=await freshAt(r,40.1),entry=plan.entries[0];
    assert.equal(entry.classification,'REFRESH_SAME_INTENT',JSON.stringify(entry.reasons));
    assert.equal(entry.postDeliveryReviewRequired,true);assert.equal(entry.storedIntent.proposedPayload.totalPriceUah,650);
    assert.equal(entry.refreshedResult.corrected.totalPriceUah,650);
    assert.deepEqual(entry.refreshedResult.corrected.answers,entry.storedIntent.proposedPayload.answers);
    assert.equal(entry.refreshedResult.corrected.publicSku,entry.publicArticle);
    assert.equal(entry.refreshedResult.corrected.delivery.holdReason,'historical_ambiguity');
    assert.throws(()=>service.select(plan,plan.planHash,[r.id]),{code:'CORRECTION_BATCH_SELECTION_INVALID'});
    const before=await state(),conflict=await apply(plan,undefined,{observeRate:observeAt(40.2)});
    assert.equal(conflict.counts.conflicted,1);assert.equal(conflict.outcomes[0].reason,'CORRECTION_BATCH_DRIFT');
    assert.equal(conflict.outcomes[0].currentClaim.status,'pending');assert.deepEqual(await state(),before);
    const report=await apply(plan,undefined,{observeRate:observeAt(40.1)});
    assert.equal(report.counts.completed,1,JSON.stringify(report));assert.equal(report.postDeliveryReviewCandidates.length,1);
    const result=report.outcomes[0].result;
    assert.equal(result.publicSku,entry.publicArticle);assert.equal(result.postDeliveryReviewRequired,true);
    assert.equal(result.lifecycle.route,'hold');assert.equal(result.lifecycle.hold_reason,'historical_ambiguity');
    const after=await state();assert.equal(after.jobs,before.jobs);assert.equal(after.handoffs,before.handoffs);
  });
  await t.test('v2 USD recount semantic target and provisional successor allocation changes still require review',async()=>{
    const target=await heldUsdRecount();
    await pool.query("UPDATE correction_requests SET proposed_payload=jsonb_set(proposed_payload,'{answers,extra}','7') WHERE id=$1",[target.id]);
    // Explicitly changed hidden intent (source inherited value was 7) must not be
    // mistaken for the ordinary inherited cleanup exception.
    await pool.query("UPDATE correction_requests SET proposed_payload=jsonb_set(proposed_payload,'{answers,extra}','8') WHERE id=$1",[target.id]);
    assert.equal((await freshAt(target,40.1)).entries[0].classification,'REVIEW_REQUIRED');
    const allocation=await heldUsdRecount(),plan=await freshAt(allocation,40.1),c=plan.entries[0].refreshedResult.corrected;
    assert.equal(plan.entries[0].classification,'REFRESH_SAME_INTENT');
    const input={categoryCode:'BT',answers:{kind:2},weight:c.weight,skuSchemaVersionId:schema.id};
    const checked=await products.buildNewProductPreview(input);
    await products.saveProduct({category:'BT',answers:input.answers,weight:input.weight,skuSchemaVersionId:schema.id,characteristicConfigHash:checked.characteristicConfigHash,previewToken:checked.previewToken},{mutationContext});
    const drift=await freshAt(allocation,40.1);
    if (c.mode === 'public_identity') {
      assert.equal(drift.entries[0].refreshedResult.corrected.fullSku,null);
      assert.equal(drift.entries[0].refreshedResult.corrected.publicSku,c.publicSku);
      assert.equal(drift.entries[0].refreshedResult.corrected.characteristicConfigHash,c.characteristicConfigHash);
      assert.equal(drift.entries[0].classification,'REFRESH_SAME_INTENT');
    } else {
      assert.notEqual(drift.entries[0].refreshedResult.corrected.fullSku,c.fullSku);
      assert.equal(drift.entries[0].classification,'REVIEW_REQUIRED');
    }
  });
  await t.test('v2 sealed price plan requires a fresh preflight for later NBU drift even when final remains 650',async()=>{
    const r=await pricing(usdDecisionFor(650)),plan=await freshAt(r,40.1),before=await state();
    assert.equal(plan.entries[0].classification,'REFRESH_SAME_INTENT');
    const report=await apply(plan,undefined,{observeRate:observeAt(40.2)});
    assert.equal(report.counts.conflicted,1);assert.equal(report.outcomes[0].reason,'CORRECTION_BATCH_DRIFT');
    assert.deepEqual(await state(),before);
    const fresh=await freshAt(r,40.2);assert.equal(fresh.entries[0].refreshedResult.resultingPriceUah,650);
    assert.equal(fresh.entries[0].classification,'REFRESH_SAME_INTENT');assert.notEqual(fresh.planHash,plan.planHash);
    assert.equal((await apply(fresh,undefined,{observeRate:observeAt(40.2)})).counts.completed,1);
  });
  // Receipt artifacts contain synthetic IDs only and live outside the repository.
});
