const {test}=require('node:test');
const assert=require('node:assert/strict');
const c=require('../src/services/magento/binding-contract');
const native=require('../src/services/magento/first-sync-native-create');
const photos=require('../src/services/product-photos.service');
const {compileDefinition}=require('../src/services/export-templates/definition');
const clean=value=>JSON.parse(JSON.stringify(value));

function fixture({media=true}={}) {
  const config={baseUrl:'https://native-create.invalid'};
  const definition=require('./fixtures/magento-v4').definition(['NM']);
  definition.sources={sku:definition.sources.sku,price:definition.sources.price};definition.tables={};definition.questionContracts={};
  const compiled=compileDefinition(definition);
  const date='2026-10-11T10:00:00.000Z',cutover='2026-10-10T10:00:00.000Z';
  const p={id:7,public_product_identity_id:17,category:'NM',full_sku:null,sku_schema_version_id:null,
    characteristic_version_id:23,status:'active',exclude_from_export:0,corrected_from_product_id:null,
    corrected_to_product_id:null,created_by_user_id:3,created_at:date,total_price_uah:100,weight:5};
  const i={id:17,public_sku:'AG-000017',origin:'allocated',is_test_product:false,created_at:date};
  const f={product_id:7,route:'normal',hold_reason:null,source_correction_id:null,business_exclusion_state:'none',
    recount_compatibility_excluded:false,revision:1,csv_retired_revision:1,delivery_version:1,
    confirmed_revision:0,cutover_baseline_revision:0,externally_delivered_revision:0,
    cutover_baseline_event_id:null,externally_delivered_event_id:null,repair_manifest_hash:null,
    last_resolution_key:null,resolved_at:null,resolved_by_user_id:null,evidence:{origin:'ordinary_save'}};
  const snapshot={contract:'product-characteristics-v1',category_code:'NM',questions:[]};
  const v={id:23,category_code:'NM',snapshot,config_hash:c.hash(snapshot)};
  const revision={id:'binding-a',state:'published',originHash:c.originHash(config.baseUrl),definitionHash:compiled.hash,
    templateVersionId:'template-a',installationKey:'installation-a'};
  const b={id:revision.id,state:'published',origin_hash:revision.originHash,installation_key:revision.installationKey,
    template_definition_hash:compiled.hash,version_number:1};
  const a={id:31,event_key:'magento_delivery.cutover',subject_type:'magento_delivery',subject_id:b.installation_key,
    actor_user_id:3,occurred_at:cutover,details:{planHash:'a'.repeat(64),bindingRevisionId:b.id,bindingVersionNumber:1}};
  const facts={product:p,identity:i,lifecycle:f,characteristic:v,binding:b,cutover:a,cutover_binding:b,
    activation:{legacy_product_csv_enabled:false,cutover_at:cutover,cutover_by_user_id:3}};
  const creation={id:'41',event_key:'product.created',actor_user_id:'3',occurred_at:new Date(date),
    request_id:'creation-request',details:{fullSku:null,publicSku:i.public_sku,categoryCode:p.category}};
  const request={product_id:p.id,desired_generation:'1',synced_generation:'0',state:'pending',reason_code:null,
    active_job_id:null,active_generation:null};
  const assetId='00000000-0000-4000-8000-000000000001';
  const m={id:'media-a',product_id:'7',public_product_identity_id:'17',version:'1',state:'pending',
    required_permission:'products.create',actor_user_id:'3',photo_ids:[assetId],enable_when_verified:true};
  for(const key of ['origin_hash','binding_revision_id','remote_product_id','native_generation','preservation','verified_at',
    'inherited_from_product_id','inherited_from_job_id','superseded_by_job_id','failure_code'])m[key]=null;
  m.intent_hash=photos.mediaIntent(p,m.version,m.photo_ids,m.enable_when_verified);
  const set={product_id:'7',version:'1',photo_ids:[assetId],enable_when_verified:true};
  const assets=[{id:assetId,product_id:'7',actor_user_id:'3',content_hash:'b'.repeat(64)}];
  const receipt={id:'42',actor_user_id:'3',occurred_at:new Date(date),request_id:creation.request_id,
    details:{jobId:m.id,version:'1',photoIds:[assetId],enableWhenVerified:true}};
  const absence={revisions:1,corrections:false,sessions:false,snapshots:false,legacy_exports:false,price_exports:false,
    visibility:false,historical_reactivation:false,historical_standard:false,deletion:false};
  const nativeProduct={...p,public_product_identity_id:'17',characteristic_version_id:'23',created_by_user_id:'3',
    total_price_uah:'100.00',weight:'5.000',created_at:new Date(date),public_sku:i.public_sku};
  const nativeLifecycle={...f};for(const key of ['revision','csv_retired_revision','delivery_version','confirmed_revision',
    'cutover_baseline_revision','externally_delivered_revision'])nativeLifecycle[key]=String(f[key]);
  const observation={raw:null,amber:{product:nativeProduct,revision,compiled,template:{kind:'published',versionId:revision.templateVersionId}}};
  const data={facts,nativeProduct,nativeLifecycle,creation:[creation],request,media:media?[m]:[],set:media?set:null,
    assets,receipts:[receipt],absence,jobs:[],steps:[],mediaSteps:[],enqueued:[]};
  const calls=[];
  const client={async query(sql,args) {
    calls.push({sql,args});assert.match(sql,/^SELECT\b/,'Birth proof must never mutate or lock a row');
    let rows;
    if(sql.includes('to_jsonb(p) product'))rows=[data.facts];
    else if(sql.includes('SELECT p.*,i.public_sku'))rows=[data.nativeProduct];
    else if(sql.includes('SELECT * FROM product_full_export_state'))rows=[data.nativeLifecycle];
    else if(sql.includes('AS revisions'))rows=[data.absence];
    else if(sql.includes("event_key='product.created'"))rows=data.creation;
    else if(sql.includes('FROM magento_product_sync_requests'))rows=[data.request];
    else if(sql.includes('FROM product_media_jobs'))rows=data.media;
    else if(sql.includes('FROM product_media_steps'))rows=data.mediaSteps;
    else if(sql.includes('FROM product_photo_sets'))rows=data.set?[data.set]:[];
    else if(sql.includes('FROM product_photo_assets'))rows=data.assets;
    else if(sql.includes("event_key='product.photos_saved'"))rows=data.receipts;
    else if(sql.includes('FROM magento_sync_jobs'))rows=data.jobs;
    else if(sql.includes('FROM magento_sync_steps'))rows=data.steps;
    else if(sql.includes("event_key='magento_sync.enqueued'"))rows=data.enqueued;
    else assert.fail(sql);
    return {rows,rowCount:rows.length};
  }};
  return {data,config,observation,client,calls};
}
async function attach(f) {
  const proof=await native.readOnClient(f.client,f.config,f.observation);
  assert.ok(proof);
  const reference=native.baselineReference(proof);
  const intent={mode:'create',operations:[{domain:'coreProduct',payload:{product:{sku:f.data.facts.identity.public_sku,status:2}}}]};
  const job={id:'job-a',product_id:7,public_product_identity_id:'17',sku:f.data.facts.identity.public_sku,
    origin_hash:f.observation.amber.revision.originHash,installation_key:'installation-a',binding_revision_id:'binding-a',
    automatic_generation:'1',state:'queued',remote_product_id:null,created_by_user_id:'3',intent,plan_hash:c.hash(intent),
    amber_hash:c.hash(clean({product:f.data.nativeProduct,lifecycle:f.data.nativeLifecycle})),
    binding_hash:c.hash(clean(f.observation.amber.revision)),baseline:{raw:null,allocatedFirstCreate:reference}};
  f.data.jobs=[job];Object.assign(f.data.request,{active_job_id:job.id,active_generation:'1',state:'syncing'});
  f.data.enqueued=[{actor_user_id:'3',details:{planHash:job.plan_hash}}];return job;
}

test('ordinary birth proof supports current evaluator 4 and preserves native PG hash after attachment',async()=>{
  for(const media of [true,false]) {
    const f=fixture({media}),before=clean(f.data);
    const proof=await native.readOnClient(f.client,f.config,f.observation);assert.ok(proof);assert.deepEqual(proof,{});
    assert.ok(Object.isFrozen(proof));await native.assertOnClient(f.client,proof);assert.deepEqual(clean(f.data),before);
    const job=await attach(f);const owned=await native.readOnClient(f.client,f.config,f.observation,{jobId:job.id});
    assert.ok(owned);await native.assertOnClient(f.client,owned);
    const queries=f.calls.map(call=>call.sql).join('\n');assert.match(queries,/product_id=\$2 OR sku=\$3/);
    assert.match(queries,/initial_product_id=\$1 OR public_sku=\$3/);
  }
});
test('forged or serialized capability cannot authorize dispatch',async()=>{
  const f=fixture(),proof=await native.readOnClient(f.client,f.config,f.observation);
  for(const fake of [{},structuredClone(proof),native.baselineReference(proof)]) {
    await assert.rejects(native.assertOnClient(f.client,fake),{code:'MAGENTO_FIRST_SYNC_NATIVE_CREATE_CHANGED'});
    assert.throws(()=>native.baselineReference(fake),{code:'MAGENTO_FIRST_SYNC_NATIVE_CREATE_CHANGED'});
  }
});
const denyChanges=[
  ['unknown remote',f=>{f.observation.raw=undefined;}],['existing remote',f=>{f.observation.raw={id:80,sku:'AG-000017'};}],
  ['legacy identity',f=>{f.data.facts.identity.origin='legacy';}],['test product',f=>{f.data.facts.identity.is_test_product=true;}],
  ['archived',f=>{f.data.facts.product.status='archived';}],['excluded',f=>{f.data.facts.product.exclude_from_export=1;}],
  ['lineage',f=>{f.data.facts.product.corrected_from_product_id=1;}],['schema encoding',f=>{f.data.facts.product.full_sku='NM1';}],
  ['revision',f=>{f.data.facts.lifecycle.revision=2;}],['CSV floor',f=>{f.data.facts.lifecycle.csv_retired_revision=2;}],
  ['delivery version',f=>{f.data.facts.lifecycle.delivery_version=2;}],['confirmed',f=>{f.data.facts.lifecycle.confirmed_revision=1;}],
  ['external delivery',f=>{f.data.facts.lifecycle.externally_delivered_revision=1;}],
  ['prior lifecycle resolution',f=>{f.data.facts.lifecycle.last_resolution_key='old';}],
  ['repair evidence',f=>{f.data.facts.lifecycle.evidence.repair=true;}],['old birth',f=>{f.data.facts.product.created_at='2026-10-01';}],
  ['cutover receipt',f=>{f.data.facts.cutover.details.planHash=null;}],['binding drift',f=>{f.data.facts.binding.id='next';}],
  ['characteristic hash',f=>{f.data.facts.characteristic.snapshot.questions.push({key:'changed'});}],
  ['missing creation',f=>{f.data.creation=[];}],['wrong actor',f=>{f.data.creation[0].actor_user_id='4';}],
  ['reconciliation',f=>{f.data.request.reason_code='reconciliation_required';}],['delivered generation',f=>{f.data.request.synced_generation='1';}],
  ['extra media',f=>{f.data.media.push({...f.data.media[0],id:'other'});}],['blocked media',f=>{f.data.media[0].state='blocked';}],
  ['bound media',f=>{f.data.media[0].origin_hash='other';}],['media native generation',f=>{f.data.media[0].native_generation='1';}],
  ['media preservation',f=>{f.data.media[0].preservation={};}],['media inheritance',f=>{f.data.media[0].inherited_from_job_id='old';}],
  ['media mismatched identity',f=>{f.data.media[0].public_product_identity_id='18';}],
  ['ANY media step including verified',f=>{f.data.mediaSteps=[{verified_at:new Date()}];}],
  ['photo order',f=>{f.data.set.photo_ids=[];}],['enable drift',f=>{f.data.set.enable_when_verified=false;}],
  ['asset ownership',f=>{f.data.assets[0].product_id='8';}],['photo receipt drift',f=>{delete f.data.receipts[0].details.photoIds;}],
  ['photo mutation context',f=>{f.data.receipts[0].request_id='other';}],['old native job',f=>{f.data.jobs=[{id:'old',state:'succeeded'}];}],
];
for(const key of ['corrections','sessions','snapshots','legacy_exports','price_exports','visibility','historical_reactivation','historical_standard','deletion'])
  denyChanges.push([key,f=>{f.data.absence[key]=true;}]);
for(const [label,change]of denyChanges)test('birth proof fails closed for '+label,async()=>{
  const f=fixture();change(f);assert.equal(await native.readOnClient(f.client,f.config,f.observation),null);
});
test('private capability rechecks media and immutable generation immediately before dispatch',async()=>{
  for(const change of [f=>{f.data.mediaSteps=[{}];},f=>{f.data.request.desired_generation='2';},f=>{f.data.set.enable_when_verified=false;}]) {
    const f=fixture(),proof=await native.readOnClient(f.client,f.config,f.observation);change(f);
    await assert.rejects(native.assertOnClient(f.client,proof),{code:'MAGENTO_FIRST_SYNC_NATIVE_CREATE_CHANGED'});
  }
});
test('only exact automatic attached zero-step CREATE may redeem a durable birth reference',async()=>{
  for(const change of [f=>{f.data.jobs[0].automatic_generation=null;},f=>{f.data.request.active_job_id=null;},
    f=>{delete f.data.jobs[0].baseline.allocatedFirstCreate;},f=>{f.data.jobs[0].intent.operations[0].payload.product.status=1;},
    f=>{f.data.steps=[{ordinal:0,state:'verified'}];},f=>{f.data.jobs[0].state='uncertain';},
    f=>{f.data.jobs[0].amber_hash=c.hash({product:f.data.facts.product,lifecycle:f.data.facts.lifecycle});},
    f=>{f.data.jobs.push({id:'old',state:'superseded'});},f=>{f.data.enqueued=[];}]) {
    const f=fixture(),job=await attach(f);change(f);
    assert.equal(await native.readOnClient(f.client,f.config,f.observation,{jobId:job.id}),null);
  }
});
test('reference validation supports exact present-object reconciliation but never unknown absence',async()=>{
  const f=fixture(),job=await attach(f);f.data.jobs[0].state='uncertain';f.data.steps=[{ordinal:0,state:'dispatched'}];
  f.data.request.reason_code='reconciliation_required';f.observation.raw={id:80,sku:job.sku};
  assert.ok(await native.readOnClient(f.client,f.config,f.observation,{jobId:job.id,referenceOnly:true}));
  for(const raw of [null,undefined,{}, {id:80,sku:'other'}]) {
    f.observation.raw=raw;assert.equal(await native.readOnClient(f.client,f.config,f.observation,{jobId:job.id,referenceOnly:true}),null);
  }
});
