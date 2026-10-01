const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const f = require('./phase3-fixture');
const cutover = require('../src/services/full-product-cutover.service');
const gate = require('../src/services/full-product-cutover-gate');
const selection = require('../src/services/full-product-selection');
const exportsService = require('../src/services/export.service');
const information = require('../src/services/product-information.service');
const { reconcileFullProduct, setBusinessExclusion } = require('../src/services/full-product-reconciliation.service');
let baseline, legacy, generated, pending, unexposed, exposed, index, manifest;
const stale = { code:'REPAIR_MANIFEST_STALE' };
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Race barrier timeout')),5000);})]);}finally{clearTimeout(timer);}}
async function historical(p,status) {
  const id=crypto.randomUUID();
  await f.pool.query(`INSERT INTO export_snapshots(id,idempotency_key,from_sku,to_sku,resolved_to_sku,
    exported_to_product_id,row_count,file_name,csv_content,status,confirmed_at)
    VALUES($1,$1,$2,$2,$2,$3,1,'historical.csv',$4,$5,CASE WHEN $5='confirmed' THEN CURRENT_TIMESTAMP ELSE NULL END)`, [id,p.full_sku,p.id,`sku,price_uah\r\n${p.full_sku},21700\r\n`,status]);
  return id;
}
async function fixtureMutation(fn) {
  const c=await f.pool.connect();
  try { await gate.begin(c,'BEGIN',{maintenance:true}); const result=await fn(c);await gate.commit(c);return result; }
  catch(e){await gate.rollback(c);throw e;}finally{c.release();}
}
async function capture(p, extra={}, db=f.pool) {
  const input={fromSku:p.full_sku,toSku:p.full_sku,...extra};
  const preview=await exportsService.previewExport(input,f.opts(db));
  return exportsService.createExportSnapshot({...input,previewExpectation:preview.previewExpectation,idempotencyKey:crypto.randomUUID()},f.opts(db));
}
async function waitBlocked(pid,by) {
  const end=Date.now()+5000;
  while(Date.now()<end){if((await f.pool.query('SELECT $2::int=ANY(pg_blocking_pids($1)) yes',[pid,by])).rows[0].yes)return;await new Promise(r=>setTimeout(r,10));}
  assert.fail('Expected real independent backend contention');
}
test.before(async()=>{
  await f.setup(); baseline=await f.save();legacy=await f.save();generated=await f.save();
  await historical(baseline,'confirmed');await historical(generated,'generated');
  await f.pool.query('INSERT INTO product_export_revisions(product_id,has_product_snapshot) VALUES($1,true)',[legacy.id]);
  for(let n=0;n<102;n++)pending=await f.save();
  unexposed=await f.pair({lostNames:true,weightRepair:true});exposed=await f.pair({exposed:'generated'});
  // Reproduce migration-origin rows at the contract boundary. Full restored-038
  // evidence is separately rehearsed by the guarded command-line script.
  await f.pool.query(`UPDATE product_full_export_state f SET route=CASE WHEN p.status='active' THEN 'hold' ELSE 'retired' END,
    hold_reason=CASE WHEN p.status='active' THEN 'historical_ambiguity' ELSE NULL END,
    business_exclusion_state=CASE WHEN p.exclude_from_export=1 THEN 'unknown' ELSE 'none' END,
    recount_compatibility_excluded=false,delivery_version=delivery_version+1,
    evidence='{"origin":"migration_039","coverage":"unresolved_historical"}' FROM products p WHERE p.id=f.product_id`);
});
test.after(()=>f.pool.end());
test('canonical preparation drains a live writer; late unaware SQL and captures fail closed',async()=>{
  await assert.rejects(cutover.generate('index',f.opts()),stale);
  await assert.rejects(f.reconcile(await f.resolution(unexposed.successor.id)),{code:'LIFECYCLE_ACTIVATION_REQUIRED'});
  const a=await f.pool.connect();const b=new f.Pool({connectionString:process.env.DATABASE_URL,max:1});
  const pa=(await a.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const pb=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;assert.notEqual(pa,pb);
  let work;
  try {
    await gate.begin(a);await a.query('UPDATE products SET weight=weight WHERE id=$1',[pending.id]);
    work=cutover.prepare({...f.opts(b),deploymentEvidence:'Isolated fixture; old instances absent; writes frozen'});await waitBlocked(pb,pa);await gate.commit(a);await work;
  }finally{await gate.rollback(a);a.release();await work;await b.end();}
  await assert.rejects(f.pool.query('UPDATE products SET weight=weight WHERE id=$1',[pending.id]),{code:'55000'});
  await assert.rejects(capture(pending),{code:'EXPORT_CUTOVER_PREPARING'});
  await assert.rejects(cutover.generate('cutover',f.opts()),stale);
  index=await cutover.generate('index',f.opts());assert.equal(index.indexing.proposed.length,2);
  assert.equal((await cutover.indexHistorical(index,index.contentSha256,f.opts())).indexedMemberships,2);
  assert.equal((await cutover.indexHistorical(index,index.contentSha256,f.opts())).alreadyApplied,true);
  manifest=await cutover.generate('cutover',f.opts());
  assert.deepEqual(Object.fromEntries(['legacy_baseline','first_delivery','hold','preserve'].map(a=>[a,manifest.entries.filter(e=>e.action===a).length])),
    {legacy_baseline:2,first_delivery:102,hold:3,preserve:2});
  const bad=structuredClone(manifest);bad.entries[0].action='first_delivery';
  await assert.rejects(cutover.approve(bad,manifest.contentSha256,'tampered',f.opts()),{code:'CUTOVER_MANIFEST_INVALID'});
  await cutover.approve(manifest,manifest.contentSha256,'Explicit fixture baseline acceptance',f.opts());
});
test('bounded apply rolls back the current batch, replays receipts and blocks final activation on any stale entry',async()=>{
  let hash=manifest.contentSha256;
  const before=await f.footprint();let writes=0;
  const failing={connect:async()=>{const c=await f.pool.connect();return{release:()=>c.release(),query:async(...args)=>{
    const result=await c.query(...args);if(/UPDATE product_full_export_state SET route/.test(args[0])&&++writes===2)throw Error('Injected mid-batch failure');return result;
  }};}};
  await assert.rejects(cutover.applyBatch(hash,0,f.opts(failing)),/Injected/);assert.deepEqual(await f.footprint(),before);
  await cutover.applyBatch(hash,0,f.opts());const once=await f.footprint();
  assert.equal((await cutover.applyBatch(hash,0,f.opts())).alreadyApplied,true);assert.deepEqual(await f.footprint(),once);
  await assert.rejects(cutover.activate(hash,f.opts()),stale);
  await fixtureMutation(c=>c.query('UPDATE products SET weight=weight+1 WHERE id=$1',[pending.id]));
  const drift=await f.footprint();await assert.rejects(cutover.applyBatch(hash,1,f.opts()),stale);assert.deepEqual(await f.footprint(),drift);
  await fixtureMutation(c=>c.query('UPDATE products SET weight=weight-1 WHERE id=$1',[pending.id]));
  await fixtureMutation(c=>c.query('UPDATE products SET weight=weight+1 WHERE id=$1',[baseline.id]));
  await assert.rejects(cutover.generate('amendment',f.opts()),/Completed product .* payload changed/);
  await fixtureMutation(c=>c.query('UPDATE products SET weight=weight-1 WHERE id=$1',[baseline.id]));
  await fixtureMutation(c=>c.query("UPDATE products SET magento_name_subject_en='Reviewed amendment' WHERE id=$1",[pending.id]));
  const amendment=await cutover.generate('amendment',f.opts());assert.equal(amendment.parentManifestHash,hash);
  await cutover.approve(amendment,amendment.contentSha256,'Explicit review of changed unprocessed payload; keep completed decisions',f.opts());
  await assert.rejects(cutover.applyBatch(hash,1,f.opts()),stale);
  manifest=amendment;hash=amendment.contentSha256;
  await cutover.applyBatch(hash,0,f.opts());await cutover.validate(hash,f.opts());
  assert.equal((await f.product(unexposed.successor.id)).exclude_from_export,1);
  assert.equal((await f.state(baseline.id)).confirmed_revision,'0');assert.equal((await f.state(baseline.id)).cutover_baseline_revision,'1');
  await cutover.activate(hash,f.opts());assert.equal((await cutover.activate(hash,f.opts())).alreadyActive,true);
  assert.equal((await cutover.applyBatch(hash,0,f.opts())).alreadyApplied,true);
  assert.equal((await cutover.indexHistorical(index,index.contentSha256,f.opts())).alreadyApplied,true);
  assert.equal((await cutover.status(f.opts())).gate.phase,'active');
  assert.equal((await f.product(unexposed.successor.id)).exclude_from_export,1);
  assert.deepEqual((await selection.queues(f.pool)).counts,{firstDelivery:102,fullUpdate:0,replacementReady:0,held:3});
  await assert.rejects(f.pool.query('UPDATE products SET exclude_from_export=0 WHERE id=$1',[unexposed.successor.id]),{code:'55000'});
  await assert.rejects(fixtureMutation(c=>c.query('UPDATE products SET exclude_from_export=0 WHERE id=$1',[unexposed.successor.id])),/durable policy/);
});
test('unexposed attestation restores exact names with review; generated-only work requires explicit file resolution and stays first delivery',async()=>{
  let cmd=await f.resolution(unexposed.successor.id);
  cmd={...cmd,action:'unexposed_first_delivery'};
  await assert.rejects(f.reconcile(cmd),{code:'RECONCILIATION_UNRESOLVED'});
  cmd.exclusionResolution={disposition:'recount_only_attested',evidence:'Operator attests no later business exclusion'};
  await f.reconcile(cmd);assert.equal((await f.reconcile(cmd)).alreadyResolved,true);
  const p=await f.product(unexposed.successor.id);assert.equal(p.exclude_from_export,0);
  assert.equal(p.magento_name_subject_ua,unexposed.source.magento_name_subject_ua);assert.equal(p.magento_name_review_required,true);
  assert.equal((await f.state(p.id)).route,'normal');
  const e=(await f.manifest()).repairEntries.find(e=>e.productId===generated.id);
  const ordinary={action:'generated_first_delivery',successorId:generated.id,deliveryVersion:e.lifecycle.delivery_version,beforeFingerprint:e.beforeFingerprint,
    reason:'Reviewed generated file',resolutionKey:crypto.randomUUID(),ancestorSkus:[],oldSkus:[{sku:generated.full_sku,disposition:'verified_absent',evidence:'Checked target'}],
    files:e.generatedMemberships.map(m=>({snapshotId:m.snapshotId,disposition:'quarantined_do_not_import',evidence:'Stored file quarantined'}))};
  await assert.rejects(reconcileFullProduct(ordinary,f.opts()),{code:'RECONCILIATION_UNRESOLVED'});
  ordinary.redeliveryAuthorization={disposition:'authorized',evidence:'One controlled first full delivery authorized'};
  await reconcileFullProduct(ordinary,f.opts());assert.equal((await f.state(generated.id)).route,'normal');
  assert.equal((await f.state(generated.id)).confirmed_revision,'0');
});
test('held manual ranges cannot bypass reconciliation; replacement is one reviewed product and becomes same-SKU Update after confirmation',async()=>{
  const p=await f.product(exposed.successor.id);
  const held=await exportsService.previewExport({fromSku:p.full_sku,toSku:p.full_sku},f.opts());assert.equal(held.representedCount,0);
  const cmd=await f.resolution(p.id);const bad={...cmd,files:[]};await assert.rejects(f.reconcile(bad),{code:'RECONCILIATION_UNRESOLVED'});
  await f.reconcile(cmd);const state=await f.state(p.id);
  await assert.rejects(capture(p,{mode:'replacement',productId:p.id,deliveryVersion:'1'}),{code:'REPLACEMENT_SELECTION_STALE'});
  const snap=await capture(p,{mode:'replacement',productId:p.id,deliveryVersion:state.delivery_version});
  const beforeCursor=(await f.pool.query('SELECT exported_to_product_id FROM export_state')).rows[0].exported_to_product_id;
  await f.confirm(snap);assert.equal((await f.state(p.id)).route,'normal');assert.equal((await f.state(p.id)).confirmed_revision,'1');
  assert.ok((await f.pool.query('SELECT exported_to_product_id FROM export_state')).rows[0].exported_to_product_id>=beforeCursor);
  const info={productId:p.id,answersPatch:{size:'changed after replacement'}};
  info.previewToken=(await information.previewProductInformation(info)).previewToken;await information.applyProductInformation(info,f.opts());
  assert.ok((await selection.list(f.pool,{queue:'update'})).items.some(e=>e.id===p.id));
  const newPreview=await exportsService.previewExport({mode:'new'},f.opts());
  assert.equal(newPreview.representedCount,104); // below-cursor pending items survive confirmation of a high ID
  await f.confirm(snap);assert.equal((await f.state(p.id)).confirmed_revision,'1');
});
test('baseline informational edits create Update; typed business exclusion preserves the pending obligation',async()=>{
  const info={productId:baseline.id,answersPatch:{size:'changed baseline payload'}};
  info.previewToken=(await information.previewProductInformation(info)).previewToken;await information.applyProductInformation(info,f.opts());
  assert.ok((await selection.list(f.pool,{queue:'update'})).items.some(e=>e.id===baseline.id));
  let s=await f.state(baseline.id);assert.equal(s.confirmed_revision,'0');assert.equal(s.cutover_baseline_revision,'1');assert.equal(s.revision,'2');
  await setBusinessExclusion({productId:baseline.id,deliveryVersion:s.delivery_version,excluded:true,reason:'Independent business decision',resolutionKey:crypto.randomUUID()},f.opts());
  assert.equal((await f.product(baseline.id)).exclude_from_export,1);
  assert.ok(!(await selection.list(f.pool,{queue:'update'})).items.some(e=>e.id===baseline.id));
  s=await f.state(baseline.id);await setBusinessExclusion({productId:baseline.id,deliveryVersion:s.delivery_version,excluded:false,reason:'Business decision withdrawn',resolutionKey:crypto.randomUUID()},f.opts());
  assert.ok((await selection.list(f.pool,{queue:'update'})).items.some(e=>e.id===baseline.id));
});

test('active template and shared-session New capture use the same ledger and require exact replacement identity on retries',async()=>{
  const names=require('../src/services/product-magento-name.service');
  const reviewed=await names.previewProductMagentoName({productId:unexposed.successor.id});
  await names.applyProductMagentoName({productId:unexposed.successor.id,subjectUa:reviewed.subjectUa,subjectEn:reviewed.subjectEn,
    confirmUnchanged:true,previewToken:reviewed.previewToken},f.opts());
  const templates=require('../src/services/export-templates/template.service');
  const sessions=require('../src/services/export-sessions.service');
  await fixtureMutation(c=>c.query(`INSERT INTO categories(code,name) SELECT code,code FROM unnest(ARRAY['BR','NM','KL','CH','AR']) code`));
  const definition=require('../src/services/export-templates/magento-v1-definition').materializeMagentoV1(
    await require('../src/services/magento-products-v1').loadMagentoCatalog(f.pool));
  definition.sources={sku:{kind:'product',field:'full_sku',type:'text'},price:{kind:'product',field:'total_price_uah',type:'scalar'}};
  definition.tables={};definition.questionContracts={};definition.bindings=[];
  const literal=value=>({op:'literal',value});
  for(const group of definition.groups){group.evaluate=[];for(const row of group.rows){
    row.cells={sku:{op:'text',input:{op:'source',id:'sku'},trim:false,format:'string-only-v1',onAbsent:'empty'},
      store_view_code:literal(row.id==='base'?'':'en'),name:literal('Cutover full product'),attribute_set_code:literal(group.name),product_type:literal('simple')};
    if(row.id==='base')row.cells.price={op:'numberText',input:{op:'source',id:'price'},format:'js-number-positive-v1',error:{op:'error',field:'price',message:literal('Price required')}};
  }}
  const family=await templates.createTemplate({key:`cutover-${crypto.randomUUID()}`,displayName:'Cutover parity',definition},f.opts());
  const v=await templates.publishTemplate(family.id,{expectedRevision:family.draft.revision,expectedDefinitionHash:family.draft.definitionHash},f.opts());
  const settings={requestContract:'template-v1',mode:'new',selection:{mode:'explicit',templateId:v.templateId,versionId:v.id}};
  const direct=await exportsService.previewExport({mode:'new'},f.opts());
  const controlled=await exportsService.previewExport(settings,f.opts());
  assert.equal(controlled.representedCount,direct.representedCount);assert.equal(controlled.readyCount,controlled.representedCount);
  const session=await sessions.createSession({title:'Active lifecycle shared session',settings,creationKey:crypto.randomUUID()},f.opts());
  const prepared=await sessions.prepare(session.id,{expectedRevision:session.configurationRevision,expectedAccessEpoch:'owner'},f.opts());
  const snapshot=await sessions.generate(session.id,{expectedRevision:session.configurationRevision,expectedAccessEpoch:'owner',attemptId:prepared.id},f.opts());
  assert.equal(Number(snapshot.row_count),direct.representedCount);assert.equal(snapshot.full_product_selection.mode,'new');
  assert.equal((await sessions.generate(session.id,{expectedRevision:session.configurationRevision,expectedAccessEpoch:'owner',attemptId:prepared.id},f.opts())).id,snapshot.id);
  assert.equal((await f.state(pending.id)).confirmed_revision,'0');
  await exportsService.confirmExportSnapshot(snapshot.id,{...f.opts(),expectedAccessEpoch:'owner'});assert.equal((await f.state(pending.id)).confirmed_revision,'1');
  assert.equal((await selection.queues(f.pool)).counts.firstDelivery,0);
});

for(const sameKey of [true,false])test(`active reconciliation serializes two independent writers (${sameKey?'same':'different'} resolution key)`,async()=>{
  const source=await f.product(pending.id);
  const created=await f.recount(await f.recountInput(source));pending=await f.product(created.correctedProductId);
  const command=await f.resolution(pending.id);
  const a=new f.Pool({connectionString:process.env.DATABASE_URL,max:1});const b=new f.Pool({connectionString:process.env.DATABASE_URL,max:1});
  const pa=(await a.query('SELECT pg_backend_pid() pid')).rows[0].pid,pb=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  let arrived,release;const reached=new Promise(r=>{arrived=r;});const held=new Promise(r=>{release=r;});
  let once=false;const gated={connect:async()=>{const c=await a.connect();return{release:()=>c.release(),query:async(...args)=>{
    const value=await c.query(...args);if(!once&&/FROM products[\s\S]*FOR UPDATE/.test(args[0])){once=true;arrived();await held;}return value;
  }};}};
  const settled=p=>p.then(value=>({value}),error=>({error}));let first,second;
  try{
    first=settled(f.reconcile(command,gated));await bounded(reached);
    second=settled(f.reconcile(sameKey?command:{...command,resolutionKey:crypto.randomUUID()},b));
    await waitBlocked(pb,pa);release();const [one,two]=await Promise.all([first,second]);assert.ifError(one.error);
    if(sameKey){assert.ifError(two.error);assert.equal(two.value.alreadyResolved,true);}else assert.equal(two.error?.code,'REPAIR_MANIFEST_STALE');
    assert.equal((await f.state(pending.id)).route,'replacement');
    const input={mode:'replacement',productId:pending.id,deliveryVersion:(await f.state(pending.id)).delivery_version};
    const preview=await exportsService.previewExport(input,f.opts());
    const captureInput={...input,previewExpectation:preview.previewExpectation,idempotencyKey:crypto.randomUUID()};
    // Recount changed informational text only; inherited names are already approved.
    const snapshot=await exportsService.createExportSnapshot(captureInput,f.opts());
    assert.equal((await exportsService.createExportSnapshot(captureInput,f.opts())).id,snapshot.id);
    await assert.rejects(exportsService.createExportSnapshot({...captureInput,productId:baseline.id},f.opts()),{code:'EXPORT_IDEMPOTENCY_CONFLICT'});
    await f.confirm(snapshot);
  }finally{release();await Promise.all([first,second]);await a.end();await b.end();}
});

test('active recount first delivery and a real capture-before-recount race preserve the successor obligation',async()=>{
  const products=require('../src/services/product.service');const sample=await f.product(generated.id);
  const names={magento_name_subject_ua:sample.magento_name_subject_ua,magento_name_subject_en:sample.magento_name_subject_en};
  const preview=await products.buildNewProductPreview({categoryCode:'SV',answers:sample.details.answers,weight:1260,...names});
  const created=await products.saveProduct({category:'SV',answers:sample.details.answers,weight:1260,manualPriceUah:21700,...names,
    skuSchemaVersionId:preview.skuSchemaVersionId,previewToken:preview.previewToken},f.opts());
  await fixtureMutation(c=>c.query("UPDATE products SET magento_name_subject_ua='Фігура',magento_name_subject_en='Figurine' WHERE id=$1",[created.id]));
  const first=await f.recount(await f.recountInput(await f.product(created.id)));const p=await f.product(first.correctedProductId);
  assert.equal(p.exclude_from_export,0);assert.equal((await f.state(p.id)).route,'normal');
  assert.ok((await selection.list(f.pool,{queue:'new'})).items.some(e=>e.id===p.id));
  const cmd=await f.recountInput(p);const reviewed=await exportsService.previewExport({fromSku:p.full_sku,toSku:p.full_sku},f.opts());
  const a=new f.Pool({connectionString:process.env.DATABASE_URL,max:1});const b=new f.Pool({connectionString:process.env.DATABASE_URL,max:1});
  const pa=(await a.query('SELECT pg_backend_pid() pid')).rows[0].pid,pb=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  let arrived,release;const reached=new Promise(r=>{arrived=r;});const held=new Promise(r=>{release=r;});let once=false;
  const gated={query:(...args)=>a.query(...args),connect:async()=>{const c=await a.connect();return{release:()=>c.release(),query:async(...args)=>{
    const result=await c.query(...args);if(!once&&/FOR SHARE OF p/.test(args[0])){once=true;arrived();await held;}return result;
  }};}};
  const settled=p=>p.then(value=>({value}),error=>({error}));let captureWork,recountWork;
  try{
    captureWork=settled(exportsService.createExportSnapshot({fromSku:p.full_sku,toSku:p.full_sku,previewExpectation:reviewed.previewExpectation,idempotencyKey:crypto.randomUUID()},f.opts(gated)));
    await bounded(reached);recountWork=settled(f.recount(cmd,b));await waitBlocked(pb,pa);release();
    const [captured,recounted]=await Promise.all([captureWork,recountWork]);assert.ifError(captured.error);assert.equal(recounted.error?.statusCode,409);
    const corrected=await f.recount(await f.recountInput(await f.product(p.id)));const successor=await f.product(corrected.correctedProductId);
    assert.equal(successor.exclude_from_export,0);assert.equal((await f.state(successor.id)).route,'hold');
    assert.equal((await f.state(successor.id)).hold_reason,'prior_exposure');
    await f.confirm(captured.value);assert.equal((await f.state(successor.id)).confirmed_revision,'0');
    assert.equal((await f.state(p.id)).route,'retired');
    const stored=await exportsService.getExportSnapshot(captured.value.id,f.opts());assert.ok(stored.full_product_warnings.some(w=>w.product_id===p.id));
    assert.ok((await selection.list(f.pool,{queue:'hold'})).items.some(e=>e.id===successor.id));
  }finally{release();await Promise.all([captureWork,recountWork]);await a.end();await b.end();}
});
