const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/services/magento/binding-contract');
const manual = require('../src/services/magento/first-sync-reviewed-manual');
const standard = require('../src/services/magento/historical-standard-boundary');
const s = require('../src/services/historical-reactivation-state');
const lifecycle = require('../src/services/product-lifecycle-state');
const transaction = require('../src/services/magento/sync-job-transaction');
const history = require('../src/services/magento/recovery-history');
const ownership = require('../src/services/magento/native-identity-ownership');
const UUID = '11111111-1111-1111-1111-111111111111';

function fixture(t, kind = 'standard') {
  const config = {configured:true,baseUrl:'https://fixture-magento.example'};
  const origin = c.originHash(config.baseUrl);
  const revision = {id:UUID,installationKey:'fixture',originHash:origin,state:'published'};
  const product = {id:21,public_product_identity_id:'31',public_sku:'BR-HISTORY',full_sku:'BR-HISTORY',
    category:'BR',status:kind === 'standard' ? 'archived' : 'active',exclude_from_export:kind === 'standard' ? 1 : 0,
    total_price_uah:240,corrected_to_product_id:null,corrected_from_product_id:null};
  const target = {product,lifecycle:{route:kind === 'standard' ? 'retired' : 'normal',business_exclusion_state:'none'},
    facts:{newerRevision:false,activeSuccessor:false,correctionHistory:false,testDeletion:false,
      unfinishedMedia:false,unresolvedVisibility:false}};
  const observation = {amber:{product:structuredClone(product),revision},
    raw:{id:44,sku:product.public_sku,status:kind === 'standard' ? 1 : 2,visibility:4,price:240},
    domainEvidence:{inventory:null,english:null,failures:[]}};
  if (kind === 'standard') standard.project(observation.amber);
  const intent = {version:2,mode:'update',operations:[{domain:'coreProduct',
    payload:{product:{sku:product.public_sku,price:240}}}],websiteIds:[],englishValues:{}};
  const proof = {id:UUID,batch_id:'22222222-2222-2222-2222-222222222222',actor_user_id:'7',
    product_id:21,public_product_identity_id:'31',public_sku:product.public_sku,origin_hash:origin,
    installation_key:'fixture',binding_revision_id:UUID,binding_hash:'a'.repeat(64),
    local_fingerprint:s.fingerprint(product,target.lifecycle),remote_product_id:'44',
    remote_fingerprint:kind === 'standard' ? standard.observationFingerprint(observation) : s.remoteFingerprint(observation.raw),
    request_generation:'3',state:kind === 'standard' ? 'queued' : 'awaiting_native',native_job_id:null,
    target_status:kind === 'standard' ? 1 : 2,target_visibility:4,
    created_at:'2026-10-09T00:00:00Z',
    ...(kind === 'standard' ? {delivery_mode:'update',plan_hash:c.hash(intent),review:{deliveryPlanHash:c.hash(intent)}}
      : {expected_generation:'4',current_facts:{product:structuredClone(product),lifecycle:structuredClone(target.lifecycle),
        priorFacts:'unknown',newDecision:'participate_hidden_update',deliveryPlanHash:c.hash(intent)}})};
  const state = {productId:21,publicIdentityId:'31',publicSku:product.public_sku,amberHash:'b'.repeat(64),
    bindingHash:'c'.repeat(64),revision,
    historicalStandard:kind === 'standard' ? structuredClone(proof) : null,
    historicalUpdate:kind === 'historical' ? structuredClone(proof) : null};
  const options = {actorUserId:7,...(kind === 'historical' ? {automatic:{generation:'4',productId:21,
    publicIdentityId:'31',installationKey:'fixture'}} : {})};
  const f = {config,observation,state,options,intent,proof,target,progress:null,steps:[],queries:[],job:null,
    request:{product_id:21,desired_generation:kind === 'standard' ? '3' : '4'},
    facts:{other_origin:false,identity_changed:false,protected_work:false,external_delivery_receipts:[]},
    component:{complete:true,issues:[],identityChanged:false,hasRecount:false,products:[{productId:21}]},
    binding:{row:{id:UUID,installation_key:'fixture'},fingerprint:proof.binding_hash},authorityCalls:0,revalidations:0};
  t.mock.method(s,'authority',async (client, actor) => {
    assert.equal(client, f.client); assert.equal(actor, 7); f.authorityCalls++;
    if (f.denied) throw c.error(403,'HISTORICAL_ADMINISTRATOR_REQUIRED','Denied');
  });
  t.mock.method(s,'currentBinding',async client => {assert.equal(client,f.client);return f.binding;});
  t.mock.method(lifecycle,'readTarget',async (client,id,input) => {
    assert.equal(client,f.client);assert.equal(id,21);assert.equal(input.origin,origin);return target;
  });
  t.mock.method(history,'read',async (client,id) => {assert.equal(client,f.client);assert.equal(id,21);return f.component;});
  t.mock.method(transaction,'revalidate',async (client, receivedConfig, receivedState, receivedOptions) => {
    assert.equal(client,f.client);assert.equal(receivedConfig.baseUrl,config.baseUrl);
    assert.equal(receivedState.amberHash,state.amberHash);assert.equal(receivedOptions.actorUserId,7);
    f.revalidations++;if (f.changedLocal) throw c.error(409,'MAGENTO_SYNC_AMBER_CHANGED','Changed');
  });
  f.client = {query:async (sql,values = []) => {
    assert.match(sql,/^\s*SELECT\b/); // No receipts, canonical setters, enrollment or history writes.
    f.queries.push({sql,values});
    let rows = [];
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) rows=[{}];
    else if (sql.startsWith('SELECT * FROM historical_')) rows=f.proof ? [structuredClone(f.proof)] : [];
    else if (sql.startsWith('SELECT * FROM magento_sync_jobs')) rows=f.job ? [structuredClone(f.job)] : [];
    else if (sql.startsWith('SELECT 1 FROM magento_sync_steps')) rows=f.steps.map(() => ({}));
    else if (sql.includes('FROM magento_first_sync_sessions\n')) rows=f.progress ? [f.progress.session] : [];
    else if (sql.includes('FROM magento_first_sync_fields')) rows=(f.progress?.fields || []).map(evidence => ({evidence}));
    else if (sql.startsWith('SELECT desired_generation') || sql.startsWith('SELECT product_id,desired_generation')) rows=f.request ? [f.request] : [];
    else if (sql.includes('AS protected_work')) {
      f.factValues=values;const facts=structuredClone(f.facts);
      if (f.foreignClaims) {
        assert.ok(sql.includes('s.origin_hash=$3\n      AND s.remote_product_id=$5 AND s.public_product_identity_id<>$2'));
        facts.identity_changed ||= f.foreignClaims.some(row=>row.origin_hash===values[2]
          && String(row.remote_product_id)===String(values[4]) && String(row.public_product_identity_id)!==values[1]);
      }
      rows=[facts];
    }
    else if (sql.startsWith('SELECT i.origin')) rows=[{origin:f.identityOrigin || 'legacy',remote_id:f.ownedRemoteId ?? null}];
    else throw new Error('Unhandled SQL: ' + sql);
    return {rows,rowCount:rows.length};
  }};
  f.issue = extras => manual.issueOnClient(f.client,config,observation,state,options,{intent,...extras});
  f.attach = () => {
    f.job={id:'33333333-3333-3333-3333-333333333333',product_id:21,public_product_identity_id:'31',
      sku:product.public_sku,installation_key:'fixture',origin_hash:origin,binding_revision_id:UUID,
      binding_hash:state.bindingHash,amber_hash:state.amberHash,plan_hash:c.hash(intent),intent:structuredClone(intent),
      baseline:{raw:structuredClone(observation.raw)},created_by_user_id:'7',
      automatic_generation:kind === 'standard' ? null : '4',remote_product_id:'44',state:'queued'};
    f.proof.native_job_id=f.job.id;
    if (kind === 'standard') f.proof.state='delivering';
    return f.job;
  };
  return f;
}
const rejects = (operation, code) => assert.rejects(operation, {code});

test('confirmed standard UPDATE has only opaque exact-execution authority and writes no first-sync state',async t => {
  const f=fixture(t), token=await f.issue();
  assert.deepEqual(token,{});assert.equal(Object.isFrozen(token),true);
  await manual.assertOnClient(f.client,token);
  assert.equal(f.revalidations,1);assert.equal(f.authorityCalls,2);
  assert.deepEqual(f.factValues.slice(5,8),[null,UUID,null]);
  const lock=f.queries.find(row=>row.values[0]==='amber_magento_first_sync:' + f.state.revision.originHash + ':31');
  assert.ok(lock);assert.ok(f.queries.indexOf(lock)<f.queries.findIndex(row=>row.sql.includes('FROM magento_first_sync_sessions\n')));
});
test('ordinary history, completed intents and reviewed CREATE do not grant this UPDATE lane',async t => {
  const f=fixture(t);
  for (const historicalStandard of [null,{...f.proof,state:'completed'},{...f.proof,state:'cancelled'},
    {...f.proof,delivery_mode:'create',remote_product_id:null}]) {
    assert.equal(await manual.issueOnClient(f.client,f.config,f.observation,{...f.state,historicalStandard},f.options,{intent:f.intent}),null);
  }
  assert.equal(await manual.issueOnClient(f.client,f.config,f.observation,
    {...f.state,historicalStandard:null,historicalUpdate:{...f.proof,state:'completed'}},f.options,{intent:f.intent}),null);
  assert.equal(f.queries.length,0);
});
test('minting requires the exact confirmed plan before enqueue',async t => {
  const f=fixture(t);
  await rejects(()=>manual.issueOnClient(f.client,f.config,f.observation,f.state,f.options),
    'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_PLAN_REQUIRED');
  for (const intent of [{...f.intent,mode:'create'},
    {...f.intent,operations:[{domain:'coreProduct',payload:{product:{sku:f.state.publicSku,price:241}}}]}]) {
    await rejects(()=>manual.issueOnClient(f.client,f.config,f.observation,f.state,f.options,{intent}),
      'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_PLAN_CHANGED');
  }
});
test('fresh original standard remote fingerprint seals values, domains, status and visibility',async t => {
  const f=fixture(t);
  for (const change of [{price:241},{status:2},{visibility:1}]) {
    const observation={...f.observation,raw:{...f.observation.raw,...change}};
    await rejects(()=>manual.issueOnClient(f.client,f.config,observation,f.state,f.options,{intent:f.intent}),
      'HISTORICAL_REMOTE_OBSERVATION_CHANGED');
  }
  await rejects(()=>manual.issueOnClient(f.client,f.config,
    {...f.observation,domainEvidence:{...f.observation.domainEvidence,english:{changed:true}}},f.state,f.options,{intent:f.intent}),
    'HISTORICAL_REMOTE_OBSERVATION_CHANGED');
});
test('missing, wrong, string-valued or unsafe raw identity cannot become manual absence',async t => {
  const f=fixture(t);
  for (const raw of [null,{...f.observation.raw,id:45},{...f.observation.raw,sku:'OTHER'},
    {...f.observation.raw,id:'44'},{...f.observation.raw,id:Number.MAX_SAFE_INTEGER+1}]) {
    await rejects(()=>manual.issueOnClient(f.client,f.config,{...f.observation,raw},f.state,f.options,{intent:f.intent}),
      'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_IDENTITY_CHANGED');
  }
});
test('origin, installation, binding and stable public identity remain exact',async t => {
  const f=fixture(t);
  for (const change of [{origin_hash:'d'.repeat(64)},{installation_key:'another'},
    {binding_revision_id:'22222222-2222-2222-2222-222222222222'},
    {public_product_identity_id:'32'},{product_id:22},{public_sku:'OTHER'}]) {
    f.proof={...f.proof,...change};f.state.historicalStandard=structuredClone(f.proof);
    await rejects(f.issue,'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_IDENTITY_CHANGED');
    f.proof={...f.proof,...Object.fromEntries(Object.keys(change).map(key=>[key,
      {origin_hash:f.state.revision.originHash,installation_key:'fixture',binding_revision_id:UUID,
        public_product_identity_id:'31',product_id:21,public_sku:f.state.publicSku}[key]]))};
  }
});
test('original administrator and current authority are rechecked on dispatch',async t => {
  const f=fixture(t);
  await rejects(()=>manual.issueOnClient(f.client,f.config,f.observation,f.state,{...f.options,actorUserId:8},{intent:f.intent}),
    'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_ORIGINAL_ACTOR_REQUIRED');
  const token=await f.issue();f.denied=true;
  await rejects(()=>manual.assertOnClient(f.client,token),'HISTORICAL_ADMINISTRATOR_REQUIRED');
});
test('standard current facts, lineage, binding and generation keep existing boundary guards',async t => {
  const f=fixture(t), token=await f.issue();
  f.target.product.total_price_uah=241;
  await rejects(()=>manual.assertOnClient(f.client,token),'HISTORICAL_CURRENT_FACTS_CHANGED');
  f.target.product.total_price_uah=240;f.target.facts.unfinishedMedia=true;
  await rejects(()=>manual.assertOnClient(f.client,token),'HISTORICAL_LINEAGE_BLOCKED');
  f.target.facts.unfinishedMedia=false;f.binding.fingerprint='d'.repeat(64);
  await rejects(()=>manual.assertOnClient(f.client,token),'HISTORICAL_BINDING_CHANGED');
  f.binding.fingerprint=f.proof.binding_hash;f.request.desired_generation='4';
  await rejects(()=>manual.assertOnClient(f.client,token),'HISTORICAL_GENERATION_CHANGED');
});
test('dispatch snapshot CAS rejects local drift even if immutable intent is unchanged',async t => {
  const f=fixture(t), token=await f.issue();f.changedLocal=true;
  await rejects(()=>manual.assertOnClient(f.client,token),'MAGENTO_SYNC_AMBER_CHANGED');
  assert.equal(f.revalidations,1);
});
for (const state of ['blocked','cancelled','completed']) {
  test('dispatch re-read rejects ' + state + ' standard intent',async t => {
    const f=fixture(t),token=await f.issue();f.proof.state=state;
    await rejects(()=>manual.assertOnClient(f.client,token),'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_INTENT_CHANGED');
  });
}
test('dispatch re-read catches immutable plan rewrite and deleted intent',async t => {
  const f=fixture(t),token=await f.issue();f.proof.plan_hash='d'.repeat(64);
  await rejects(()=>manual.assertOnClient(f.client,token),'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_INTENT_CHANGED');
  f.proof=null;
  await rejects(()=>manual.assertOnClient(f.client,token),'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_INTENT_CHANGED');
});
test('incomplete first-sync progress always retains its gate, including before ack',async t => {
  const f=fixture(t),token=await f.issue();
  f.progress={session:{remote_product_id:'44',public_sku:f.state.publicSku,installation_key:'fixture',completed_at:null},
    fields:[{target:'name',scope:'all',state:'pending_outward_confirmation'}]};
  await rejects(f.issue,'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_PARTIAL_SESSION');
  await rejects(()=>manual.assertOnClient(f.client,token),'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_PARTIAL_SESSION');
});
test('identity-consistent completed session is preserved, while a wrong remote ID is blocked',async t => {
  const f=fixture(t);
  f.progress={session:{remote_product_id:'44',public_sku:f.state.publicSku,installation_key:'fixture',completed_at:'receipt'},fields:[]};
  await f.issue();assert.equal(f.progress.session.completed_at,'receipt');
  f.progress.session.remote_product_id='45';await rejects(f.issue,'MAGENTO_FIRST_SYNC_IDENTITY_CHANGED');
});
test('all unrelated jobs, media, visibility, other intents, deletion and reconciliation remain protected',async t => {
  const f=fixture(t);f.facts.protected_work=true;
  await rejects(f.issue,'MAGENTO_FIRST_SYNC_UNFINISHED_WORK');
  const sql=f.queries.find(row=>row.sql.includes('AS protected_work')).sql;
  for (const table of ['magento_sync_jobs','product_media_jobs','product_visibility_intents','historical_standard_intents',
    'historical_reactivation_intents','magento_test_deletions','magento_product_sync_requests']) assert.ok(sql.includes(table));
  assert.deepEqual(f.factValues.slice(5),[null,UUID,null,false]);
});
test('another origin, changed remote delivery identity and malformed real-delivery proof remain blockers',async t => {
  const f=fixture(t);f.facts.other_origin=true;
  await rejects(f.issue,'MAGENTO_FIRST_SYNC_ORIGIN_REVIEW_REQUIRED');
  f.facts.other_origin=false;f.facts.identity_changed=true;
  await rejects(f.issue,'MAGENTO_FIRST_SYNC_IDENTITY_CHANGED');
  f.facts.identity_changed=false;f.facts.external_delivery_receipts=[{productId:21,revision:'3'}];
  await rejects(f.issue,'MAGENTO_FIRST_SYNC_HISTORY_REVIEW_REQUIRED');
});
test('reviewing historical facts never manufactures delivery evidence or excuses broken lineage',async t => {
  const f=fixture(t);f.component.hasRecount=true;await f.issue();
  for (const change of [{complete:false},{identityChanged:true},{issues:[{code:'BROKEN_HISTORY'}]}]) {
    Object.assign(f.component,change);await rejects(f.issue,'MAGENTO_FIRST_SYNC_HISTORY_REVIEW_REQUIRED');
    Object.assign(f.component,{complete:true,identityChanged:false,issues:[]});
  }
  assert.deepEqual(f.facts.external_delivery_receipts,[]);
});
test('only original loader-owned native proof can authorize a native counterpart',async t => {
  const f=fixture(t);f.observation.amber.product.characteristic_version_id=9;
  await ownership.load(f.client,f.observation.amber,f.state.revision.originHash);
  await f.issue();
  await rejects(()=>manual.issueOnClient(f.client,f.config,{...f.observation,amber:{...f.observation.amber}},
    f.state,f.options,{intent:f.intent}),'MAGENTO_NATIVE_IDENTITY_COLLISION');
  f.identityOrigin='allocated';f.ownedRemoteId=45;
  await ownership.load(f.client,f.observation.amber,f.state.revision.originHash);
  await rejects(f.issue,'MAGENTO_NATIVE_IDENTITY_COLLISION');
});
test('confirmed hidden reactivation has exact generation and fresh fingerprint without first-sync completion',async t => {
  const f=fixture(t,'historical'),token=await f.issue();
  await manual.assertOnClient(f.client,token);
  assert.deepEqual(f.factValues.slice(5,8),[null,null,UUID]);
  assert.equal(f.proof.state,'awaiting_native');assert.equal(f.progress,null);
  f.request.desired_generation='5';await rejects(f.issue,'HISTORICAL_GENERATION_CHANGED');
});
test('hidden manual restoration cannot use ordinary generation, another plan or changed fresh remote data',async t => {
  const f=fixture(t,'historical');
  await rejects(()=>manual.issueOnClient(f.client,f.config,f.observation,f.state,
    {...f.options,automatic:{...f.options.automatic,generation:'5'}},{intent:f.intent}),
    'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_GENERATION_CHANGED');
  f.observation.raw.status=1;await rejects(f.issue,'HISTORICAL_HIDDEN_STATUS_CHANGED');
  f.observation.raw.status=2;f.observation.raw.price=241;
  await rejects(f.issue,'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_OBSERVATION_CHANGED');
});
test('sealed exact persisted job can continue only its own proven partial standard progress',async t => {
  const f=fixture(t),job=f.attach();f.steps=[{state:'verified'}];f.observation.raw.price=241;
  const token=await f.issue({job});await manual.assertOnClient(f.client,token);
  assert.deepEqual(f.factValues.slice(5,8),[job.id,UUID,null]);
  assert.equal(f.factValues[8],false); // Own request reconciliation is still protected without opaque reviewed recovery.
});
test('passed progress flag or nonpersisted lookalike job cannot relax original observation',async t => {
  const f=fixture(t),job=f.attach();f.observation.raw.price=241;
  await rejects(()=>f.issue({job,hasProgress:true}),'HISTORICAL_REMOTE_OBSERVATION_CHANGED');
  f.job=null;
  await rejects(()=>f.issue({job}),'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_ORIGINAL_JOB_REQUIRED');
});
test('enqueue capability cannot transfer to an attached job; a new job-bound proof is required',async t => {
  const f=fixture(t),token=await f.issue();f.attach();
  await rejects(()=>manual.assertOnClient(f.client,token),'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_ORIGINAL_JOB_REQUIRED');
  assert.ok(await f.issue({job:f.job}));
});
test('job identity, actor, plan, baseline and generation cannot borrow a confirmed restoration',async t => {
  const f=fixture(t),job=f.attach(),original=structuredClone(job);
  for (const change of [{product_id:22},{public_product_identity_id:'32'},{origin_hash:'d'.repeat(64)},
    {sku:'OTHER'},{installation_key:'other'},{binding_revision_id:'other'},{created_by_user_id:'8'},
    {plan_hash:'d'.repeat(64)},{automatic_generation:'4'},
    {baseline:{raw:{id:45,sku:f.state.publicSku}}},{state:'superseded'}]) {
    f.job={...structuredClone(original),...change};
    await rejects(()=>f.issue({job:f.job}),'MAGENTO_FIRST_SYNC_' + (change.automatic_generation
      ? 'REVIEWED_MANUAL_GENERATION_CHANGED' : 'REVIEWED_MANUAL_ORIGINAL_JOB_REQUIRED'));
  }
});
test('ack proof fails after job immutable payload changes or observation is mutated after mint',async t => {
  const f=fixture(t),job=f.attach(),token=await f.issue({job});f.job.intent.operations[0].payload.product.price=241;
  await rejects(()=>manual.assertOnClient(f.client,token),'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_ORIGINAL_JOB_REQUIRED');
  f.job.intent=structuredClone(f.intent);f.observation.raw.price=241;
  await rejects(()=>manual.assertOnClient(f.client,token),'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_OBSERVATION_CHANGED');
});
test('public data cannot forge or clone opaque execution capability',async t => {
  const f=fixture(t),token=await f.issue();
  for (const forged of [{},{...token},null,{mode:'reviewed_manual',intentId:UUID}]) {
    await rejects(()=>manual.assertOnClient(f.client,forged),'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_PROOF_REQUIRED');
  }
});
test('two active manual commands and unknown remote domains fail closed',async t => {
  const f=fixture(t);f.state.historicalUpdate={...f.proof,state:'awaiting_native'};
  await rejects(f.issue,'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_AMBIGUOUS');
  f.state.historicalUpdate=null;f.observation.domainEvidence.failures=[{domain:'english'}];
  await rejects(f.issue,'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_OBSERVATION_UNKNOWN');
});
test('allocated native identity requires the acknowledged same-origin counterpart and original proof',async t => {
  const f=fixture(t);f.observation.amber.product.characteristic_version_id=9;
  f.identityOrigin='allocated';f.ownedRemoteId=44;
  await ownership.load(f.client,f.observation.amber,f.state.revision.originHash);
  assert.ok(await f.issue());
  f.ownedRemoteId=null;await ownership.load(f.client,f.observation.amber,f.state.revision.originHash);
  await rejects(f.issue,'MAGENTO_NATIVE_IDENTITY_COLLISION');
});
test('hidden continuation requires its exact automatic generation and keeps its local snapshot CAS',async t => {
  const f=fixture(t,'historical'),job=f.attach();f.steps=[{state:'verified'}];f.observation.raw.price=241;
  const token=await f.issue({job});await manual.assertOnClient(f.client,token);
  assert.deepEqual(f.factValues.slice(5,8),[job.id,null,UUID]);
  f.job.automatic_generation='5';
  await rejects(()=>f.issue({job:f.job}),'MAGENTO_FIRST_SYNC_REVIEWED_MANUAL_GENERATION_CHANGED');
});
test('plain reviewed-recovery input cannot waive the exact own reconciliation protection',async t => {
  const f=fixture(t),job=f.attach();f.options.firstSyncRecoveryProof={reviewed:true,jobId:job.id};
  f.options.reviewedRecovery=true;f.facts.protected_work=true;
  await rejects(()=>f.issue({job}),'MAGENTO_FIRST_SYNC_UNFINISHED_WORK');
  assert.equal(f.factValues[8],false);
});
test('only validated opaque recovery for the same original job and observation reaches its SQL exception',async t => {
  const f=fixture(t),job=f.attach(),runtime=require('../src/services/magento/first-sync-runtime');
  const opaque=Object.freeze({});f.options.firstSyncRecoveryProof=opaque;
  t.mock.method(runtime,'recoveryIsReviewed',(token,id,observation) => {
    assert.equal(token,opaque);assert.equal(id,job.id);assert.equal(observation,f.observation);return true;
  });
  const token=await f.issue({job});await manual.assertOnClient(f.client,token);
  assert.equal(f.factValues[8],true);
  const sql=f.queries.find(row=>row.sql.includes('AS protected_work')).sql;
  assert.ok(sql.includes('r.active_job_id IS DISTINCT FROM $6'));
});
test('same-origin remote claimed by another first-sync identity cannot borrow a reviewed restoration',async t => {
  const f=fixture(t),own={origin_hash:f.state.revision.originHash,remote_product_id:'44',public_product_identity_id:'31'};
  f.foreignClaims=[{...own,public_product_identity_id:'32'}];
  await rejects(f.issue,'MAGENTO_FIRST_SYNC_IDENTITY_CHANGED');
  const tokenFacts=f.factValues;assert.deepEqual(tokenFacts.slice(1,5),['31',own.origin_hash,f.state.publicSku,44]);
  for (const claim of [own,{...own,remote_product_id:'45',public_product_identity_id:'32'},
    {...own,origin_hash:'d'.repeat(64),public_product_identity_id:'32'}]) {
    f.foreignClaims=[claim];assert.ok(await f.issue());
  }
  const token=await f.issue();f.foreignClaims=[{...own,public_product_identity_id:'32'}];
  await rejects(()=>manual.assertOnClient(f.client,token),'MAGENTO_FIRST_SYNC_IDENTITY_CHANGED');
});
