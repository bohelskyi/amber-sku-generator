const c = require('./binding-contract');
const service = require('./first-sync.service');
const ledger = require('./first-sync-ledger');
const { TERMINAL, fieldKey } = require('./first-sync-progress-plan');
const fail = code => {throw c.error(409,'MAGENTO_FIRST_SYNC_' + code,'Передавання потребує актуального рішення щодо полів першої синхронізації.');};
const lanes = new WeakMap();
const recoveryProofs = new WeakMap();
const record = field => Object.fromEntries(['target','scope','state','before','remote','after','source','mappingHash'].map(key=>[key,field[key]]));

async function needsExistingReview(db,state) {
  // This fast path grants no new dispatch authority. APPLY still observes and
  // checks exact remote identity. An incomplete session always retains its gate.
  const row=(await db.query(`SELECT
    EXISTS(SELECT 1 FROM magento_first_sync_sessions s WHERE s.origin_hash=$1
      AND s.public_product_identity_id=$2 AND s.completed_at IS NULL)
    OR (NOT EXISTS(SELECT 1 FROM magento_first_sync_sessions s WHERE s.origin_hash=$1
      AND s.public_product_identity_id=$2 AND s.completed_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM magento_sync_jobs j WHERE j.origin_hash=$1
      AND j.public_product_identity_id=$2 AND j.sku=$3 AND j.state='succeeded'
      AND j.acknowledged_at IS NOT NULL AND j.remote_product_id IS NOT NULL)) AS required`,
  [state.revision.originHash,state.publicIdentityId,state.publicSku])).rows[0];
  return row.required;
}
async function ownedCreateContinuation(db,job,observation) {
  if(job?.intent?.mode!=='create' || job.baseline?.raw!==null || !observation.raw
    || observation.raw.sku!==job.sku || Number(job.remote_product_id)!==observation.raw.id
    || String(job.public_product_identity_id)!==String(observation.amber.product.public_product_identity_id)
    || job.origin_hash!==observation.amber.revision.originHash) return false;
  const ordinal=job.intent.operations.findIndex(operation=>operation.domain==='coreProduct');
  if(ordinal!==0 || job.intent.operations[0].payload?.product?.sku!==job.sku) return false;
  return (await db.query("SELECT 1 FROM magento_sync_steps WHERE job_id=$1 AND ordinal=0 AND state='verified'",[job.id])).rowCount===1;
}
function hasProgressChange(inspection) {
  if(!inspection.first.progress) return true;
  if(inspection.prepared.complete && !inspection.first.progress.session.completed_at) return true;
  const previous=new Map(inspection.first.progress.fields.map(field=>[fieldKey(field),record(field)]));
  return inspection.prepared.rows.some(row=>!previous.has(fieldKey(row))
    || c.hash(record(row.record))!==c.hash(previous.get(fieldKey(row))));
}
async function enforce(config,observation,state,options,{job=null,createLane=null,intent=null}={}) {
  let inspection;
  if(createLane) {
    const proof=lanes.get(createLane);
    if(!proof || proof.mode!=='create' || !job || proof.jobId!==job.id
      || proof.productId!==state.productId || proof.bindingId!==state.revision.id
      || proof.sku!==state.publicSku || proof.originHash!==state.revision.originHash
      || proof.installationKey!==state.revision.installationKey
      || proof.identityId!==String(state.publicIdentityId) || job.intent?.mode!=='create'
      || job.product_id!==state.productId || job.binding_revision_id!==state.revision.id
      || job.installation_key!==state.revision.installationKey
      || job.sku!==state.publicSku || job.origin_hash!==state.revision.originHash
      || String(job.public_product_identity_id)!==String(state.publicIdentityId)) fail('CREATE_CONTEXT_CHANGED');
    if(observation.raw && !await ownedCreateContinuation(options.databasePool,job,observation)) fail('CREATE_IDENTITY_CHANGED');
    return createLane;
  }
  let manualProof=null;
  if(state.historicalUpdate?.state==='awaiting_native'
    || (state.historicalStandard && !['completed','cancelled'].includes(state.historicalStandard.state)
      && state.historicalStandard.delivery_mode==='update')) {
    const manualClient=await options.databasePool.connect();
    try {
      await manualClient.query('BEGIN');
      await require('./sync-job-transaction').revalidate(manualClient,config,state,options);
      manualProof=await require('./first-sync-reviewed-manual').issueOnClient(manualClient,config,observation,state,options,{intent,job});
      await manualClient.query('COMMIT');
    } catch(cause) {await manualClient.query('ROLLBACK').catch(()=>{});throw cause;}
    finally {await require('../full-product-cutover-gate').release(manualClient).catch(()=>{});manualClient.release();}
  }
  if(manualProof) {
    const token=Object.freeze({});
    lanes.set(token,{mode:'reviewed_manual',manualProof,nameProof:null});
    return token;
  }
  if((job?.intent?.mode==='create' && recoveryIsReviewed(options.firstSyncRecoveryProof,job.id,observation))
    || await ownedCreateContinuation(options.databasePool,job,observation)) inspection={mode:'create',readyForOutbound:true};
  else inspection=await service.inspect(config,observation,options,{jobId:job?.id || null});
  let receiptRevision=inspection.first?.progress?.session.revision;
  let sessionId=inspection.first?.progress?.session.id;
  let changed=false;
  if(inspection.mode==='first' && hasProgressChange(inspection)) {
    let result;
    try {result=await service.commit(config,inspection,state,options,{jobId:job?.id || null});}
    catch(cause) {
      if(/^FIRST_SYNC_[A-Z_]+$/.test(cause.code || '')) cause.code='MAGENTO_' + cause.code;
      throw cause;
    }
    receiptRevision=result.revision;sessionId=result.sessionId;changed=result.localChanged;
  }
  if(options.automatic && inspection.blockers?.length) await require('./sync-problems').saveDiagnostics(
    options.databasePool,options.automatic,inspection.blockers);
  if(changed) throw c.error(409,'MAGENTO_SYNC_AMBER_CHANGED','Підтверджені дані прийнято. Потрібен новий snapshot перед передаванням.');
  if(!inspection.readyForOutbound) fail('FIELDS_UNRESOLVED');
  const names=require('./first-sync-name-proof');
  let fieldNameProof=inspection.mode==='first' ? names.issue({observation,prepared:inspection.prepared,projection:inspection.projection,job}) : null;
  if(job?.baseline?.firstSyncNames) {
    fieldNameProof=await readNameProof(options.databasePool,job,observation);
    if(!fieldNameProof) fail('NAME_RECEIPT_CHANGED');
  }
  const token=Object.freeze({});
  lanes.set(token,{mode:inspection.mode,key:inspection.first?.key,receiptRevision,sessionId,
    jobId:job?.id,productId:state.productId,bindingId:state.revision.id,
    originHash:state.revision.originHash,identityId:String(state.publicIdentityId),
    remoteId:observation.raw?.id,sku:observation.amber.product.public_sku,
    installationKey:observation.amber.revision.installationKey,
    historyAdmission:inspection.first?.historyAdmission,config,observation,
    manifest:inspection.prepared?.manifest,
    nameProof:fieldNameProof});
  return token;
}
function reviewedRecovery(job,steps,observation,review,{allowDispatched=false}={}) {
  const recovery=require('./sync-job-recovery');
  if(review.jobId!==job.id || review.planHash!==job.plan_hash
    || review.jobFingerprint!==recovery.fingerprint(job,steps)
    || review.remoteFingerprint!==recovery.remoteFingerprint(observation)
    || review.blockers.length || (steps.some(step=>step.state==='dispatched') && !allowDispatched)) fail('RECOVERY_REVIEW_CHANGED');
  if(allowDispatched) require('./sync-job-plan').verifyAll(job,observation);
  const token=Object.freeze({});
  recoveryProofs.set(token,{jobId:job.id,identityId:String(job.public_product_identity_id),
    sku:job.sku,originHash:job.origin_hash,installationKey:job.installation_key,
    productId:job.product_id,bindingId:job.binding_revision_id,remoteId:observation.raw?.id});
  return token;
}
function recoveryIsReviewed(token,jobId,observation) {
  const proof=recoveryProofs.get(token),amber=observation.amber;
  return !!proof && proof.jobId===jobId && proof.productId===amber.product.id
    && proof.bindingId===amber.revision.id && proof.sku===amber.product.public_sku
    && proof.identityId===String(amber.product.public_product_identity_id)
    && proof.originHash===amber.revision.originHash && proof.installationKey===amber.revision.installationKey
    && proof.remoteId===observation.raw?.id;
}
async function nameBaselineOnClient(client,token,observation) {
  const proof=lanes.get(token);if(!proof?.nameProof || !proof.key || !proof.sessionId) return null;
  const current=await ledger.readOnClient(client,proof.key);
  if(!current || current.session.id!==proof.sessionId || current.session.revision!==proof.receiptRevision) fail('DISPATCH_RECEIPT_CHANGED');
  return require('./first-sync-name-proof').baselineReceipt(observation,proof.nameProof,
    {sessionId:proof.sessionId,revision:proof.receiptRevision});
}
async function readNameProof(db,job,observation) {
  const ref=job?.baseline?.firstSyncNames;if(!ref) return null;
  if(typeof ref.sessionId!=='string' || !/^[a-f0-9-]{36}$/.test(ref.sessionId)
    || typeof ref.revision!=='string' || !/^[1-9][0-9]{0,18}$/.test(ref.revision)) return null;
  const client=await db.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const progress=await ledger.readOnClient(client,{originHash:job.origin_hash,publicIdentityId:String(job.public_product_identity_id)});
    const row=(await client.query('SELECT command FROM magento_first_sync_progress WHERE session_id=$1 AND revision=$2',[ref.sessionId,ref.revision])).rows[0];
    let history=null,provenanceValid=false;
    if(row && progress) {
      history=await require('./recovery-history').read(client,job.product_id);
      const nameFields=[...(Array.isArray(row.command.fields)?row.command.fields:[]),...progress.fields]
        .filter(field=>field.target==='name');
      const bindingIds=[...new Set(nameFields.map(field=>field.source?.bindingRevisionId))];
      if(bindingIds.length && bindingIds.length<=4 && bindingIds.every(id=>typeof id==='string'&&id.length<=80)) {
        const revisions=(await client.query('SELECT id,origin_hash,installation_key,template_definition_hash FROM magento_binding_revisions WHERE id=ANY($1::text[])',[bindingIds])).rows;
        provenanceValid=nameFields.every(field=>revisions.some(revision=>revision.id===field.source.bindingRevisionId
          && revision.origin_hash===job.origin_hash && revision.installation_key===job.installation_key
          && revision.template_definition_hash===field.source.definitionHash));
      }
    }
    await client.query('COMMIT');
    return row && progress && provenanceValid ? require('./first-sync-name-proof').issueFromLedger({observation,job,
      session:progress.session,command:row.command,progress,history}) : null;
  } catch(cause) {await client.query('ROLLBACK').catch(()=>{});throw cause;}
  finally {client.release();}
}
function nameProof(token) {return lanes.get(token)?.nameProof || null;}
function isCreateLane(token) {return lanes.get(token)?.mode==='create';}
async function assertDispatchOnClient(client,token) {
  const proof=lanes.get(token);if(!proof) fail('DISPATCH_REVIEW_REQUIRED');
  if(proof.mode==='reviewed_manual') {
    await require('./first-sync-reviewed-manual').assertOnClient(client,proof.manualProof);
    return;
  }
  if(proof.mode==='create' || proof.mode==='ordinary') return;
  if(proof.historyAdmission) await require('./first-sync-history-admission').assertOnClient(client,proof.config,proof.observation,proof.historyAdmission);
  if(!proof.key || !proof.receiptRevision || !proof.manifest?.length) fail('DISPATCH_REVIEW_REQUIRED');
  const current=await ledger.readOnClient(client,proof.key);
  if(!current || current.session.revision!==proof.receiptRevision
    || current.session.public_sku!==proof.sku || Number(current.session.remote_product_id)!==proof.remoteId
    || current.session.installation_key!==proof.installationKey) fail('DISPATCH_RECEIPT_CHANGED');
  const acceptable=field=>TERMINAL.has(field.state)||field.state==='pending_outward_confirmation';
  const fields=new Map(current.fields.map(field=>[fieldKey(field),field]));
  if(current.fields.some(field=>!acceptable(field)) || proof.manifest.some(scope=>!acceptable(fields.get(fieldKey(scope)) || {})))
    fail('FIELDS_UNRESOLVED');
}
module.exports={needsExistingReview,enforce,isCreateLane,nameProof,nameBaselineOnClient,readNameProof,assertDispatchOnClient,reviewedRecovery,recoveryIsReviewed};
