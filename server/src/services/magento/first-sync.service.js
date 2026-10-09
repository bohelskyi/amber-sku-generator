const c = require('./binding-contract');
const gate = require('../full-product-cutover-gate');
const eligibility = require('./first-sync-eligibility');
const ledger = require('./first-sync-ledger');
const { projectFirstSyncFields } = require('./first-sync-projection');
const { prepareProgress, blockImports, deferAfterCanonicalImports, TERMINAL, fieldKey } = require('./first-sync-progress-plan');

const fail = (code,status=409) => {throw c.error(status,'MAGENTO_FIRST_SYNC_' + code,'Потрібна актуальна перевірка полів першої синхронізації.');};
const cleanRecord = row => Object.fromEntries(['target','scope','state','before','remote','after','source','mappingHash'].map(key=>[key,row[key]]));
const acceptedRecords = prepared => prepared.rows.filter(row=>['imported','name_received'].includes(row.record.state)
  && !row.received).map(row=>cleanRecord(row.record));

async function validatePrepared(client,config,observation,projection,prepared,options,currencyEvidence,rateObservation) {
  const records=acceptedRecords(prepared);
  const persistence=field=>projection.projection.find(meta=>fieldKey(meta)===fieldKey(field))?.persistence;
  const local=await require('./first-sync-local-apply').prepareFirstSyncLocal(client,{config,observation,projection,
    actorUserId:options.actorUserId,acceptedFields:records.filter(field=>persistence(field)!=='price'),rateObservation,
    canonicalPriceConflict:records.some(field=>persistence(field)==='price')});
  prepared.canonicalHash=local.canonicalHash || null;
  blockImports(prepared,local.blockedFields);
  const price=await require('./first-sync-price').prepareFirstSyncPrice(client,{observation,projection,rateObservation,currencyEvidence,
    acceptedFields:records.filter(field=>persistence(field)==='price')});
  blockImports(prepared,price.blockedFields);
  deferAfterCanonicalImports(prepared,projection);
}

async function inspect(config, observation, options, {jobId=null,decision=null}={}) {
  const reviewedRecovery=require('./first-sync-runtime').recoveryIsReviewed(options.firstSyncRecoveryProof,jobId,observation);
  const client=await options.databasePool.connect();
  let first;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    first=await eligibility.readFirstSyncEligibility(client,config,observation,{jobId,reviewedRecovery});
    await client.query('COMMIT');
  } catch(cause) {await client.query('ROLLBACK').catch(()=>{});throw cause;}
  finally {client.release();}
  if (first.mode!=='first') return {first,observation,mode:first.mode,blockers:first.blockers,
    readyForOutbound:['ordinary','create'].includes(first.mode),complete:first.mode==='ordinary',fields:[]};
  const price=require('./first-sync-price');
  // All network evidence is obtained before local transaction/product locks.
  const currencyEvidence=await price.readCurrencyEvidence(config,observation,{fetchImpl:options.fetchImpl});
  let rateObservation=null;
  try { rateObservation=await (options.observeRate || require('../currency.service').observeUsdRate)({databasePool:options.databasePool}); }
  catch { /* Price remains unverified; unrelated safe imports are still reviewed. */ }
  // Preview metadata is not a field input. Preserve the original ownership-bearing Amber object.
  const fieldObservation={amber:observation.amber,raw:observation.raw,schema:observation.schema,domainEvidence:observation.domainEvidence};
  const projection=projectFirstSyncFields({observation:fieldObservation,receipts:(first.progress?.fields || [])
    .filter(field=>TERMINAL.has(field.state)).map(({target,scope,state})=>({target,scope,state})),
    ...(currencyEvidence.verified ? {currencyEvidence}: {})});
  if (!projection.fields?.length) return {first,observation,mode:'review',blockers:projection.blockers,
    readyForOutbound:false,complete:false,fields:[],coverage:projection.coverage};
  const prepared=prepareProgress(projection,first.progress,decision);
  for(const row of prepared.rows.filter(field=>!field.received)) row.record={...cleanRecord(row.record),source:{...row.record.source,productId:observation.amber.product.id}};
  const validation=await options.databasePool.connect();
  try {
    await validation.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await validatePrepared(validation,config,observation,projection,prepared,options,currencyEvidence,rateObservation);
    await validation.query('COMMIT');
  } catch(cause) {await validation.query('ROLLBACK').catch(()=>{});throw cause;}
  finally {validation.release();}
  const product=observation.amber.product;
  const previewToken=c.hash({origin:first.key.originHash,identity:first.key.publicIdentityId,sku:product.public_sku,
    remoteId:observation.raw.id,bindingId:observation.amber.revision.id,definitionHash:observation.amber.compiled.hash,
    eligibility:first.evidenceHash,manifestHash:prepared.manifestHash,rows:prepared.rows,canonicalHash:prepared.canonicalHash,
    currencyEvidence,rateEvidence:rateObservation?.rateInfo ? Object.fromEntries(['rate','rateDate','source','stale']
      .map(key=>[key,rateObservation.rateInfo[key]])) : null});
  return {first,observation,projection,prepared,reviewedRecovery,currencyEvidence,rateObservation,previewToken,
    mode:'first',blockers:prepared.blockers,readyForOutbound:prepared.readyForOutbound,
    complete:prepared.complete,coverage:projection.coverage,
    fields:prepared.rows.map(({target,scope,status,reason,local,remote,canAcceptRemote,canKeepLocal,received})=>
      ({target,scope,status,reason,local,remote,canAcceptRemote,canKeepLocal,received}))};
}

async function commit(config, inspection, state, options, {jobId=null}={}) {
  if(inspection.mode!=='first') return {localChanged:false,readyForOutbound:inspection.readyForOutbound};
  const {first,observation,projection,prepared}=inspection;
  if(!prepared) fail('PROJECTION_REQUIRED');
  const product=observation.amber.product, client=await options.databasePool.connect();
  let localResult={changed:false},priceResult={changed:false};
  try {
    await client.query('BEGIN');
    // Existing access/binding/lifecycle/product/generation locks and snapshot CAS.
    await require('./sync-job-transaction').revalidate(client,config,state,options);
    if(options.firstSyncDecision) await require('./binding-publication').administrator(client,options.actorUserId);
    if(first.historyAdmission) await require('./first-sync-history-admission').assertOnClient(client,config,observation,first.historyAdmission);
    const fresh=await eligibility.readFirstSyncEligibility(client,config,observation,{jobId,reviewedRecovery:inspection.reviewedRecovery===true});
    if(fresh.mode!=='first'||fresh.evidenceHash!==first.evidenceHash) fail('EVIDENCE_CHANGED');
    const identity=first.progress?.session;
    const result=await ledger.recordProgressOnClient(client,{
      key:first.key,identity:{installationKey:observation.amber.revision.installationKey,publicSku:product.public_sku,
        remoteProductId:String(observation.raw.id),contractVersion:'first-sync-v1',
        initialProductId:identity?.initial_product_id || product.id,
        initialBindingRevisionId:identity?.initial_binding_revision_id || observation.amber.revision.id},
      expectedRevision:first.progress?.session.revision || '0',previewHash:inspection.previewToken,
      fields:prepared.rows.map(row=>cleanRecord(row.record)),actorUserId:options.actorUserId,
      requiredScopes:prepared.manifest,complete:prepared.complete,readyForOutbound:prepared.readyForOutbound,
      applyLocal:async(tx,acceptedFields)=>{
        const kind=field=>projection.projection.find(meta=>fieldKey(meta)===fieldKey(field))?.persistence;
        // Each helper receives only the ledger's NEW accepted transitions.
        priceResult=await require('./first-sync-price').applyFirstSyncPrice(tx,{observation,projection,
          rateObservation:inspection.rateObservation,currencyEvidence:inspection.currencyEvidence,
          acceptedFields:acceptedFields.filter(field=>kind(field)==='price'),actorUserId:options.actorUserId});
        localResult=await require('./first-sync-local-apply').applyFirstSyncLocal(tx,{config,observation,projection,
          acceptedFields:acceptedFields.filter(field=>kind(field)!=='price'),actorUserId:options.actorUserId,
          reanchorAfterPrice:priceResult.changed===true,rateObservation:inspection.rateObservation,
          canonicalPriceConflict:acceptedFields.some(field=>kind(field)==='price'),expectedCanonicalHash:prepared.canonicalHash});
      }
    });
    await gate.commit(client);
    return {...result,localChanged:localResult.changed || priceResult.changed,
      readyForOutbound:prepared.readyForOutbound,complete:prepared.complete};
  } catch(cause){await gate.rollback(client).catch(()=>{});throw cause;}
  finally{await gate.release(client).catch(()=>{});client.release();}
}

function command(input,applying=false) {
  c.command(input,['sku','bindingRevisionId'],applying?['previewToken','target','scope','choice']:[]);
  c.identity(input.bindingRevisionId);
  if(typeof input.sku!=='string'||!input.sku.trim()||input.sku.length>256||/[\u0000-\u001f\u007f]/.test(input.sku)) c.invalid();
  if(applying && (typeof input.previewToken!=='string'||!/^[a-f0-9]{64}$/.test(input.previewToken)
    || !['keep_local','accept_remote'].includes(input.choice)
    || !['target','scope'].every(key=>typeof input[key]==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(input[key])))) c.invalid();
}
const response=inspection=>({mode:inspection.mode,sku:inspection.observation.amber.product.public_sku,
  ...(inspection.previewToken?{previewToken:inspection.previewToken}:{}),fields:inspection.fields,
  blockers:inspection.blockers,coverage:inspection.coverage,
  readyForOutbound:inspection.readyForOutbound,complete:inspection.complete});
async function review(config,input,options={}) {
  command(input);options={...options,databasePool:options.databasePool||require('../../db/pool'),actorUserId:options.mutationContext?.actorUserId||options.actorUserId};
  const boundary=require('./sync-job.service').recoveryBoundary;
  return boundary.guard(config,input,options,async state=>{
    const {observation}=await boundary.observe(config,{...input,sku:state.publicSku},options);
    return response(await inspect(config,observation,options));
  });
}
async function apply(config,input,options={}) {
  command(input,true);options={...options,databasePool:options.databasePool||require('../../db/pool'),actorUserId:options.mutationContext?.actorUserId||options.actorUserId};
  const boundary=require('./sync-job.service').recoveryBoundary;
  return boundary.guard(config,input,options,async state=>{
    const authority=await options.databasePool.connect();
    try{await require('./binding-publication').administrator(authority,options.actorUserId);}finally{authority.release();}
    const decision={target:input.target,scope:input.scope,choice:input.choice};
    const receiptHash=c.hash({previewToken:input.previewToken,decision});
    const prior=(await options.databasePool.query(`SELECT p.command,p.result,s.public_sku,s.installation_key
      FROM magento_first_sync_progress p JOIN magento_first_sync_sessions s ON s.id=p.session_id
      WHERE s.origin_hash=$1 AND s.public_product_identity_id=$2 AND p.preview_hash=$3`,
    [c.originHash(config.baseUrl),state.publicIdentityId,receiptHash])).rows[0];
    if(prior) {
      const field=prior.command.fields.find(item=>fieldKey(item)===fieldKey(decision));
      if(prior.public_sku!==state.publicSku || prior.installation_key!==state.revision.installationKey
        || field?.source?.decision!==decision.choice) fail('RECEIPT_CONFLICT');
      return {sku:state.publicSku,...decision,receipt:{sessionId:prior.result.sessionId,revision:prior.result.revision,
        state:field.state,alreadyApplied:true},complete:prior.result.completed,
        readyForOutbound:prior.result.readyForOutbound===true};
    }
    const {observation}=await boundary.observe(config,{sku:state.publicSku,bindingRevisionId:input.bindingRevisionId},options);
    const base=await inspect(config,observation,options);
    if(base.mode!=='first'||base.previewToken!==input.previewToken) fail('PREVIEW_STALE');
    // Reuse the fresh observation and captured external evidence for this exact decision.
    const prepared=prepareProgress(base.projection,base.first.progress,decision);
    for(const row of prepared.rows.filter(field=>!field.received)) row.record={...cleanRecord(row.record),source:{...row.record.source,productId:observation.amber.product.id}};
    const validation=await options.databasePool.connect();
    try {
      await validation.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await validatePrepared(validation,config,observation,base.projection,prepared,options,base.currencyEvidence,base.rateObservation);
      await validation.query('COMMIT');
    } catch(cause) {await validation.query('ROLLBACK').catch(()=>{});throw cause;}
    finally {validation.release();}
    const selected=prepared.rows.find(row=>fieldKey(row)===fieldKey(decision));
    if(!selected||!['pending_outward_confirmation','imported','name_received'].includes(selected.record.state)) fail('DECISION_NOT_AVAILABLE');
    const inspection={...base,prepared,previewToken:c.hash({previewToken:base.previewToken,decision})};
    const result=await commit(config,inspection,state,{...options,firstSyncDecision:decision});
    return {sku:state.publicSku,...decision,receipt:{sessionId:result.sessionId,revision:result.revision,
      state:selected.record.state,alreadyApplied:result.alreadyApplied},
      readyForOutbound:result.readyForOutbound,complete:result.complete};
  });
}
module.exports={inspect,commit,review,apply,response};
