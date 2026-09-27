const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const f=require('./phase3-fixture');
const names=require('../src/services/product-magento-name.service');
const information=require('../src/services/product-information.service');
test.before(f.setup);
test.after(()=>f.pool.end());
const entry=(m,id)=>m.repairEntries.find((e)=>e.productId===id);
const stale=(e)=>e.code==='REPAIR_MANIFEST_STALE';
async function historical(p) {
  const id=crypto.randomUUID();
  await f.pool.query(`INSERT INTO export_snapshots(id,idempotency_key,from_sku,to_sku,resolved_to_sku,exported_to_product_id,row_count,file_name,csv_content)
    VALUES($1,$1,$2,$2,$2,$3,1,'historical.csv',$4)`,[id,p.full_sku,p.id,`sku,price_uah\r\n${p.full_sku},21700\r\n`]);
  return id;
}
function failing(pattern) {
  return {connect:async()=>{const c=await f.pool.connect();return {release:()=>c.release(),query:async(...args)=>{
    if(pattern.test(args[0]))throw Error('Injected phase3 failure');return c.query(...args);
  }};}};
}
test('phase3 historical indexing exact manifest apply and identical replay preserve immutable bytes and confirmation counters',async()=>{
  const p=await f.save();const id=await historical(p);const before=await f.footprint();const m=await f.manifest();
  assert.equal(m.indexing.proposed.length,1);const first=await f.apply(m,[],true);
  assert.equal(first.indexedMemberships,1);assert.equal(first.alreadyApplied,false);
  const members=(await f.pool.query('SELECT * FROM export_snapshot_products WHERE snapshot_id=$1',[id])).rows;
  assert.equal(members.length,1);assert.equal(members[0].full_revision,null);assert.equal(members[0].delivery_version,null);
  assert.equal(members[0].capture_kind,'legacy_compatibility');assert.equal(members[0].evidence_origin,'verified_stored_csv');
  const once=await f.footprint();assert.equal((await f.apply(m,[],true)).alreadyApplied,true);assert.deepEqual(await f.footprint(),once);
  assert.deepEqual(once.export_snapshots,before.export_snapshots);assert.deepEqual(once.magento_export_artifacts,before.magento_export_artifacts);
  assert.deepEqual(once.product_full_export_state,before.product_full_export_state);
  await f.confirm({id});assert.equal((await f.state(p.id)).confirmed_revision,'0');
  assert.equal((await f.manifest()).indexing.proposed.length,0);
});
test('phase3 dry run uses a read-only transaction and malicious rehashed proposals cannot authorize writes',async()=>{
  const {successor}=await f.pair();const before=await f.footprint();let readOnly;
  const observed={connect:async()=>{const c=await f.pool.connect();return {release:()=>c.release(),query:async(...args)=>{
    const result=await c.query(...args);
    if(args[0].startsWith('BEGIN'))readOnly=(await c.query("SELECT current_setting('transaction_read_only') setting")).rows[0].setting;
    return result;
  }};}};
  const m=await f.manifest(observed);assert.equal(readOnly,'on');assert.deepEqual(await f.footprint(),before);
  const bad=structuredClone(m);entry(bad,successor.id).expectedAfter.confirmed_revision='1';
  const {contentSha256,...payload}=bad;void contentSha256;
  bad.contentSha256=require('../src/services/export-exposure/repair-manifest').digest(payload);
  await assert.rejects(f.apply(bad,[successor.id]),stale);assert.deepEqual(await f.footprint(),before);
});
test('phase3 release is prohibited before selector activation even with proven recount provenance',async()=>{
  const {successor}=await f.pair({lostNames:true,weightRepair:true});
  const m=await f.manifest();const before=await f.footprint();
  await assert.rejects(f.apply(m,[successor.id]),{code:'LIFECYCLE_ACTIVATION_REQUIRED'});
  await assert.rejects(f.reconcile(await f.resolution(successor.id)),{code:'LIFECYCLE_ACTIVATION_REQUIRED'});
  assert.deepEqual(await f.footprint(),before);
});
for(const cause of ['product','delivery_version','names','lineage','snapshot','exclusion'])test(`phase3 stale ${cause} aborts with no partial writes`,async()=>{
  const {successor}=await f.pair();const m=await f.manifest();
  if(cause==='product')await f.pool.query('UPDATE products SET weight=weight+1 WHERE id=$1',[successor.id]);
  if(cause==='delivery_version')await f.pool.query('UPDATE product_full_export_state SET delivery_version=delivery_version+1 WHERE product_id=$1',[successor.id]);
  if(cause==='names')await f.pool.query("UPDATE products SET magento_name_subject_en='Changed fixture' WHERE id=$1",[successor.id]);
  if(cause==='lineage')await f.recount(await f.recountInput(successor));
  if(cause==='snapshot')await historical(successor);
  if(cause==='exclusion')await f.pool.query('UPDATE products SET exclude_from_export=0 WHERE id=$1',[successor.id]);
  const before=await f.footprint();await assert.rejects(f.apply(m,[successor.id]),stale);assert.deepEqual(await f.footprint(),before);
});
for(const boundary of ['audit','lifecycle'])test(`phase3 ${boundary} failure rolls back product, index and audit atomically`,async()=>{
  const {successor}=await f.pair({exposed:'generated'});await historical(await f.save());const m=await f.manifest();const before=await f.footprint();
  const pattern=boundary==='audit'?/INSERT INTO audit_events/:/UPDATE product_full_export_state/;
  await assert.rejects(f.apply(m,[successor.id],true,failing(pattern)),/Injected phase3 failure/);
  assert.deepEqual(await f.footprint(),before);
});
test('phase3 v2 batches must use the canonical gate-bound cutover command',async()=>{
  const a=await f.pair(),b=await f.pair();const m=await f.manifest();const before=await f.footprint();
  await assert.rejects(f.apply(m,[a.successor.id,b.successor.id]),{code:'CUTOVER_BATCH_COMMAND_REQUIRED'});
  assert.deepEqual(await f.footprint(),before);
});
for(const exposure of ['generated','confirmed','ambiguous','independent','unknown'])test(`phase3 ${exposure} remains an explicit hold`,async()=>{
  const {successor}=await f.pair({exposed:['generated','confirmed'].includes(exposure)?exposure:undefined,legacy:exposure==='unknown'});
  if(exposure==='ambiguous')await f.pool.query(`INSERT INTO product_export_revisions(product_id,has_product_snapshot) VALUES($1,true)`,[successor.id]);
  if(exposure==='independent')await f.pool.query("UPDATE product_full_export_state SET route='hold',hold_reason='intentional_exclusion',delivery_version=delivery_version+1 WHERE product_id=$1",[successor.id]);
  const m=await f.manifest();assert.equal(entry(m,successor.id).action,'hold');await f.apply(m,[successor.id]);
  assert.equal((await f.state(successor.id)).route,'hold');assert.equal((await f.product(successor.id)).exclude_from_export,1);
});
// Independent backends and deterministic acquired-lock barriers, not sleeps
// that merely hope to overlap. pg_blocking_pids proves actual contention.
async function worker(){const db=new f.Pool({connectionString:process.env.DATABASE_URL,max:1});return {db,pid:(await db.query('SELECT pg_backend_pid() pid')).rows[0].pid};}
function gate(db,pattern){let arrive,release,once=false;const reached=new Promise(r=>{arrive=r;});const held=new Promise(r=>{release=r;});
  return {reached,release,db:{query:(...args)=>db.query(...args),connect:async()=>{const c=await db.connect();return {release:()=>c.release(),query:async(...args)=>{const result=await c.query(...args);
    if(!once&&pattern.test(args[0])){once=true;arrive();await held;}return result;}};}}};}
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Race barrier timeout')),10000);})]);}finally{clearTimeout(timer);}}
async function blocked(pid,by){const end=Date.now()+10000;while(Date.now()<end){if((await f.pool.query('SELECT $2::int=ANY(pg_blocking_pids($1)) yes',[pid,by])).rows[0].yes)return;await new Promise(r=>setTimeout(r,10));}throw Error('No actual backend lock contention');}
const settled=p=>p.then(value=>({value}),error=>({error}));
async function race(pattern,first,second,verify){const a=await worker(),b=await worker();assert.notEqual(a.pid,b.pid);const g=gate(a.db,pattern);let one,two;
  try{one=settled(first(g.db));await bounded(g.reached);two=settled(second(b.db));await blocked(b.pid,a.pid);g.release();await verify(...await Promise.all([one,two]));}
  finally{g.release();await Promise.all([one,two]);await a.db.end();await b.db.end();}}
const productLock=/FROM products[\s\S]*FOR UPDATE/;
const stateLock=/SELECT \* FROM product_full_export_state[\s\S]*FOR UPDATE/;
for(const kind of ['recount','names','information','confirmation'])for(const repairFirst of [true,false])test(`phase3 real race repair vs ${kind}, ${repairFirst?'repair':'other'} first`,async()=>{
  const pair=await f.pair({exposed:'generated'});let p=pair.successor;
  if(kind==='capture'){await f.pool.query('UPDATE products SET exclude_from_export=0 WHERE id=$1',[p.id]);p=await f.product(p.id);}
  let other;
  if(kind==='recount'){const cmd=await f.recountInput(p);other=db=>f.recount(cmd,db);}
  if(kind==='names'){const cmd={productId:p.id,subjectUa:'Нова назва',subjectEn:'New name'};cmd.previewToken=(await names.previewProductMagentoName(cmd)).previewToken;other=db=>names.applyProductMagentoName(cmd,f.opts(db));}
  if(kind==='information'){const cmd={productId:p.id,answersPatch:{size:'25/6/30'}};cmd.previewToken=(await information.previewProductInformation(cmd)).previewToken;other=db=>information.applyProductInformation(cmd,f.opts(db));}
  if(kind==='capture')other=db=>f.capture(p,db);
  if(kind==='confirmation')other=db=>f.confirm(pair.snapshot,db);
  const m=await f.manifest();const repair=db=>f.apply(m,[p.id],false,db);
  const before=await f.footprint();const pattern=kind==='confirmation'?stateLock:!repairFirst&&kind==='capture'?/FOR SHARE OF p/:productLock;
  await race(pattern,repairFirst?repair:other,repairFirst?other:repair,async(one,two)=>{
    assert.ifError(one.error);const applied=repairFirst?one:two;const changed=repairFirst?two:one;
    if(!repairFirst)assert.equal(applied.error?.code,'REPAIR_MANIFEST_STALE');
    else if(['names','information','recount','capture'].includes(kind))assert.equal(changed.error?.statusCode,409);
    else assert.ifError(changed.error);
    const rows=await f.audits('product.full_export_repaired');assert.equal(rows.filter(r=>r.subject_id===String(p.id)).length,repairFirst?1:0);
    const current=await f.product(p.id);const state=await f.state(p.id);
    if(kind==='recount'&&!repairFirst){assert.equal(current.status,'corrected');assert.equal(state.route,'retired');assert.ok(current.corrected_to_product_id);}
    else{assert.equal(current.status,'active');assert.equal(state.revision,!repairFirst&&['names','information'].includes(kind)?'2':'1');}
    if(kind==='confirmation'){assert.equal((await f.state(pair.source.id)).confirmed_revision,'1');assert.equal(state.confirmed_revision,'0');assert.equal(state.route,'hold');}
    if(kind==='capture')assert.equal((await f.pool.query('SELECT * FROM export_snapshot_products WHERE product_id=$1',[p.id])).rows.length,repairFirst?0:1);
    const after=await f.footprint();for(const old of before.magento_export_artifacts)assert.ok(after.magento_export_artifacts.some(a=>JSON.stringify(a)===JSON.stringify(old)));
  });
});
// Active reconciliation races are exercised by 15-cutover.cases / cutover-isolated.cases.
