// Explicit admission to field review, never an export acknowledgement or enqueue.
// Proofs are opaque and rechecked at every local/dispatch boundary.
const c = require('./binding-contract');
const { digest } = require('../export-exposure/repair-manifest');
const { BATCH_SIZE } = require('../full-product-cutover.service');
const repair = require('../export-exposure/repair-loader');
const { buildHistoricalIndex } = require('../export-exposure/historical-index');
const ledger = require('./first-sync-ledger');
const { writeAuditEvent } = require('../../audit/audit-events');
const EVENT = 'product.magento_first_sync_cutover_reviewed';
const FORMAT = 'magento-first-sync-cutover-admission-v1';
const SCOPE = 'first_sync_review_only';
const proofs = new WeakMap();
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
const changed = () => c.error(409, 'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED', 'Історія змінилася. Повторіть її перевірку перед отриманням полів.');
const identity = o => ({ productId:o.amber.product.id, publicIdentityId:String(o.amber.product.public_product_identity_id),
  sku:o.amber.product.public_sku, originHash:o.amber.revision.originHash, installationKey:o.amber.revision.installationKey,
  bindingRevisionId:o.amber.revision.id, remoteId:o.raw?.id });
const sameIdentity = (a,b) => a !== undefined && b !== undefined && c.hash(a) === c.hash(b);
const historyShape = (history,i) => history?.complete === true && history.productId === i.productId
  && history.hasRecount === false && history.identityChanged === false && !history.issues.length
  && history.products.length === 1 && !history.corrections.length
  && history.products[0].productId === i.productId && history.products[0].article === i.sku
  && history.products[0].internalSku === i.sku && history.products[0].status === 'active'
  && history.products[0].previousProductId === null && history.products[0].nextProductId === null
  && history.products[0].route === 'normal' && history.products[0].holdReason === null
  && history.products[0].businessExclusion === 'none' && !history.products[0].compatibilityExcluded
  && !history.products[0].independentExclusion && !history.products[0].legacyExportExcluded
  && history.products[0].sourceCorrectionId === null;
const stateView = f => ({ revision:f.revision, csvRetiredRevision:f.csv_retired_revision });
async function captureState(client,productId) {
  const f=(await client.query('SELECT revision::text,csv_retired_revision::text FROM product_full_export_state WHERE product_id=$1',[productId])).rows[0];
  if(!f) throw changed();
  return stateView(f);
}
async function baseline(client,i,history) {
  if(!historyShape(history,i)) return null;
  if((await client.query('SELECT phase FROM full_product_export_activation WHERE singleton')).rows[0]?.phase!=='active') return null;
  const row=(await client.query(`SELECT f.*,a.event_key,a.subject_type,a.subject_id,a.details,
    p.status,p.exclude_from_export,p.corrected_from_product_id,p.corrected_to_product_id,pi.origin,
    current_database() database FROM product_full_export_state f JOIN products p ON p.id=f.product_id
    JOIN public_product_identities pi ON pi.id=p.public_product_identity_id
    JOIN audit_events a ON a.id=f.cutover_baseline_event_id WHERE f.product_id=$1`,[i.productId])).rows[0];
  if(!row || row.origin!=='legacy' || row.status!=='active' || row.exclude_from_export!==0
    || row.corrected_from_product_id!==null || row.corrected_to_product_id!==null
    || row.route!=='normal' || row.hold_reason!==null || row.source_correction_id!==null
    || row.business_exclusion_state!=='none' || row.recount_compatibility_excluded
    || row.confirmed_revision!=='0' || row.cutover_baseline_revision!=='1'
    || row.externally_delivered_revision!=='0' || row.externally_delivered_event_id!==null
    || !hex(row.repair_manifest_hash) || row.evidence?.origin!=='cutover' || row.evidence.decision!=='legacy_baseline'
    || row.event_key!=='product.full_export_baselined' || row.subject_type!=='product' || row.subject_id!==String(i.productId)
    || row.details?.manifestHash!==row.repair_manifest_hash || row.details.baselineRevision!=='1'
    || row.details.deliveryNotProven!==true || row.details.assertion!=='current_inventory_accepted_as_legacy_external_baseline') return null;
  const approvals=(await client.query(`SELECT id,details FROM audit_events WHERE event_key='full_product_cutover.approved'
    AND subject_type='cutover_manifest' AND subject_id=$1 ORDER BY id LIMIT 2`,[row.repair_manifest_hash])).rows;
  if(approvals.length!==1) return null;
  const {contentSha256,...manifest}=approvals[0].details?.manifest || {};
  if(contentSha256!==row.repair_manifest_hash || digest(manifest)!==contentSha256
    || manifest.format!=='amber-full-product-cutover-v1' || manifest.kind!=='cutover'
    || manifest.database!==row.database || manifest.policy?.batchSize!==BATCH_SIZE || !Array.isArray(manifest.entries)
    || !manifest.entries.every(e=>e && Object.getPrototypeOf(e)===Object.prototype && Number.isSafeInteger(e.productId)
      && e.productId>0 && ['preserve','hold','legacy_baseline','first_delivery'].includes(e.action))
    || new Set(manifest.entries.map(e=>e.productId)).size!==manifest.entries.length) return null;
  const entries=manifest.entries.filter(e=>e.productId===i.productId), entry=entries[0];
  if(entries.length!==1 || entry.action!=='legacy_baseline' || entry.sku!==i.sku
    || !Array.isArray(entry.lineageProductIds) || digest(entry.lineageProductIds)!==digest([i.productId]) || !hex(entry.payloadHash)
    || !['confirmed_exact','historical_ambiguous'].includes(entry.classification)
    || row.details.factualEvidence!==entry.classification
    || entry.before?.evidence?.origin!=='migration_039' || entry.before.revision!=='1'
    || entry.before.confirmed_revision!=='0' || entry.before.cutover_baseline_revision!=='0'
    || entry.before.source_correction_id!==null || entry.before.recount_compatibility_excluded!==false
    || entry.before.evidence.independentExclusion===true || entry.before.evidence.exclusionProvenance==='independent_exclusion'
    || entry.after?.route!=='normal' || entry.after.hold_reason!==null || entry.after.business_exclusion_state!=='none'
    || entry.after.recount_compatibility_excluded!==false || entry.after.source_correction_id!==null
    || entry.after.revision!=='1' || entry.after.confirmed_revision!=='0' || entry.after.cutover_baseline_revision!=='1'
    || entry.after.delivery_version!==row.delivery_version || !sameIdentity(entry.after.evidence,row.evidence)) return null;
  const changedEntries=manifest.entries.filter(e=>e.action!=='preserve'), number=Math.floor(changedEntries.indexOf(entry)/BATCH_SIZE);
  const batch=changedEntries.slice(number*BATCH_SIZE,(number+1)*BATCH_SIZE);
  const receipts=(await client.query(`SELECT id,details FROM audit_events WHERE event_key='full_product_cutover.batch_applied'
    AND subject_type='cutover_batch' AND subject_id=$1 ORDER BY id LIMIT 2`,[contentSha256+':'+number])).rows;
  const receipt=receipts[0];
  if(receipts.length!==1 || BigInt(approvals[0].id)>=BigInt(row.cutover_baseline_event_id)
    || BigInt(row.cutover_baseline_event_id)>=BigInt(receipt.id)
    || receipt.details?.result?.manifestHash!==contentSha256 || receipt.details.result.batchNumber!==number
    || !Array.isArray(receipt.details.result.productIds) || digest(receipt.details.result.productIds)!==digest(batch.map(e=>e.productId))
    || receipt.details.beforeAfterHash!==digest(batch)) return null;
  return {row, proof:{manifestHash:contentSha256,entryHash:digest(entry),approvalEventId:String(approvals[0].id),
    batchEventId:String(receipt.id),baselineEventId:row.cutover_baseline_event_id,deliveryVersion:row.delivery_version,evidenceHash:digest(row.evidence)}};
}
async function capture(client,observation,history,progress) {
  const i=identity(observation);
  if(!observation.raw || observation.raw.sku!==i.sku || !Number.isSafeInteger(i.remoteId) || i.remoteId<1) return null;
  const base=await baseline(client,i,history);
  if(!base) return null;
  const {row}=base;
  if(progress) {
    const p=progress.admissionProgress, root=progress.historyAdmissionEventId;
    if(!id(root) || p?.command?.historyAdmissionEventId!==root || p.command_hash!==c.hash(p.command)
      || p.result?.sessionId!==progress.session.id || String(p.result.revision)!==progress.session.revision
      || !sameIdentity(p.result.historyAdmissionState,stateView(row))) return null;
    const audit=(await client.query('SELECT event_key,subject_type,subject_id,details FROM audit_events WHERE id=$1',[p.audit_event_id])).rows[0];
    if(audit?.event_key!=='magento.first_sync_progress_recorded' || audit.subject_type!=='magento_first_sync'
      || audit.subject_id!==progress.session.id || audit.details?.commandHash!==p.command_hash
      || !sameIdentity(audit.details.result,p.result)) return null;
  } else if(row.csv_retired_revision!=='0' || row.externally_delivered_revision!=='0') return null;
  const input=await repair.readRepairInput(client), retained=buildHistoricalIndex(input);
  if(input.members.some(m=>Number(m.product_id)===i.productId)
    || retained.snapshots.some(s=>s.memberIds.includes(i.productId))
    || retained.proposed.some(m=>Number(m.product_id)===i.productId)
    || input.revisions.some(r=>Number(r.product_id)===i.productId && r.has_product_snapshot)) return null;
  return {format:FORMAT,scope:SCOPE,doesNotAcknowledgeExport:true,identity:i,baseline:base.proof,reviewState:stateView(row),
    historyHash:c.hash(history), retainedHash:c.hash({snapshots:retained.snapshots.map(s=>({id:s.snapshotId,fingerprint:s.beforeFingerprint})),
      diagnostics:retained.diagnostics,events:input.events,cursor:input.state}),
    rootAdmissionEventId:progress?.historyAdmissionEventId || null};
}
async function proposal(client,config,observation,{history,progress,facts,evidence}) {
  if(evidence.ownershipIssue || evidence.lifecycleBlockers.length || facts.protected_work || facts.other_origin
    || (!progress && (facts.previous_delivery || facts.acknowledged_remote_id || facts.external_delivery_receipts.length))
    || progress?.session.completed_at || progress && !progress.historyAdmissionEventId) return null;
  const envelope=await capture(client,observation,history,progress);
  if(!envelope || envelope.identity.originHash!==c.originHash(config.baseUrl)) return null;
  // A renewal cannot replace the immutable original provenance or remote identity.
  if(progress && !await rootMatches(client,progress.historyAdmissionEventId,envelope)) return null;
  return envelope;
}
async function rootMatches(client,root,envelope) {
  const event=(await client.query('SELECT event_key,subject_type,details FROM audit_events WHERE id=$1',[root])).rows[0];
  const e=event?.details?.admission;
  return event?.event_key===EVENT && event.subject_type==='magento_first_sync_cutover_admission'
    && e?.format===FORMAT && e.scope===SCOPE && e.doesNotAcknowledgeExport===true && e.rootAdmissionEventId===null
    && sameIdentity({...e.identity,bindingRevisionId:envelope.identity.bindingRevisionId},envelope.identity)
    && sameIdentity(e.baseline,envelope.baseline) && e.historyHash===envelope.historyHash && e.retainedHash===envelope.retainedHash;
}
async function readOnClient(client,config,observation,{history,progress}={}) {
  history=history || await require('./recovery-history').read(client,observation.amber.product.id);
  progress=progress===undefined ? await ledger.readOnClient(client,{originHash:c.originHash(config.baseUrl),publicIdentityId:String(observation.amber.product.public_product_identity_id)}) : progress;
  const envelope=await capture(client,observation,history,progress);
  if(!envelope || progress && !await rootMatches(client,progress.historyAdmissionEventId,envelope)) return {admission:null,evidenceHash:null};
  const rows=(await client.query(`SELECT id,details FROM audit_events WHERE event_key=$1 AND subject_type='magento_first_sync_cutover_admission'
    AND details->'admission'->'identity'->>'publicIdentityId'=$2 AND details->'admission'->'identity'->>'originHash'=$3
    AND details->'admission'->'identity'->>'bindingRevisionId'=$4 ORDER BY id DESC LIMIT 1`,
  [EVENT,envelope.identity.publicIdentityId,envelope.identity.originHash,envelope.identity.bindingRevisionId])).rows;
  const receipt=rows[0], stored=receipt?.details?.admission;
  // The first session records the root receipt; later publications may renew it.
  if(!stored || !sameIdentity({...stored,rootAdmissionEventId:envelope.rootAdmissionEventId,
    ...(progress ? {reviewState:envelope.reviewState} : {})},envelope)
    || stored.rootAdmissionEventId!==null && stored.rootAdmissionEventId!==progress?.historyAdmissionEventId
    || progress && stored.rootAdmissionEventId===null && String(receipt.id)!==progress.historyAdmissionEventId) return {admission:null,evidenceHash:null};
  const admission=Object.freeze({}), evidenceHash=c.hash({stored,auditId:String(receipt.id)});
  proofs.set(admission,{envelope,evidenceHash,product:observation.amber.product,root:String(progress?.historyAdmissionEventId || receipt.id)});
  return {admission,evidenceHash};
}
function allows(o,admission) {const p=proofs.get(admission);return !!p && p.product===o.amber.product && sameIdentity(p.envelope.identity,identity(o));}
function rootId(admission) {return proofs.get(admission)?.root;}
async function assertOnClient(client,config,observation,admission,{jobId=null,reviewedRecovery=false}={}) {
  const p=proofs.get(admission);if(!p || !allows(observation,admission)) throw changed();
  await require('./first-sync-history-admission').lockOnClient(client,{productIds:[p.envelope.identity.productId],skus:[p.envelope.identity.sku]});
  const eligibility=await require('./first-sync-eligibility').readFirstSyncEligibility(client,config,observation,{jobId,reviewedRecovery});
  if(!['first','ordinary'].includes(eligibility.mode) || eligibility.admissionGuards.protectedWork || eligibility.admissionGuards.otherOrigin) throw changed();
  const fresh=await readOnClient(client,config,observation);
  if(!fresh.admission || fresh.evidenceHash!==p.evidenceHash) throw changed();
  return fresh;
}
function descriptor(envelope,observation) {
  return {scope:SCOPE,sku:envelope.identity.sku,remoteProductId:envelope.identity.remoteId,doesNotAcknowledgeExport:true,
    previewToken:c.hash({envelope,local:c.hash(observation.amber.product),binding:c.hash(observation.amber.revision),
      remote:c.hash({raw:observation.raw,domainEvidence:observation.domainEvidence})})};
}
async function apply(config,input,options={}) {
  c.command(input,['sku','bindingRevisionId','previewToken']);c.identity(input.bindingRevisionId);
  if(typeof input.sku!=='string' || !input.sku.trim() || input.sku.length>255 || /[\u0000-\u001f\u007f]/.test(input.sku) || !hex(input.previewToken)) c.invalid();
  options={...options,databasePool:options.databasePool || require('../../db/pool'),actorUserId:options.mutationContext?.actorUserId || options.actorUserId};
  const boundary=require('./sync-job.service').recoveryBoundary;
  return boundary.guard(config,input,options,async state=>{
    const auth=await options.databasePool.connect();
    try{await require('./binding-publication').administrator(auth,options.actorUserId);}finally{auth.release();}
    const {observation}=await boundary.observe(config,{...input,sku:state.publicSku},options);
    const inspected=await require('./first-sync.service').inspect(config,observation,options);
    const client=await options.databasePool.connect(), result=receipt=>({sku:state.publicSku,scope:SCOPE,doesNotAcknowledgeExport:true,
      receipt:{auditEventId:String(receipt.id),alreadyApplied:receipt.alreadyApplied===true}});
    const gate=require('../full-product-cutover-gate');
    try {
      await client.query('BEGIN');await require('./sync-job-transaction').revalidate(client,config,state,options);
      await require('./binding-publication').administrator(client,options.actorUserId);
      await require('./first-sync-history-admission').lockOnClient(client,{productIds:[state.productId],skus:[state.publicSku]});
      const prior=(await client.query('SELECT id,details FROM audit_events WHERE event_key=$1 AND subject_type=$2 AND subject_id=$3 ORDER BY id LIMIT 2',
        [EVENT,'magento_first_sync_cutover_admission',input.previewToken])).rows;
      if(prior.length===1 && sameIdentity(prior[0].details?.admission?.identity,identity(observation))) {
        await gate.commit(client);return result({...prior[0],alreadyApplied:true});
      }
      if(inspected.historyReview?.previewToken!==input.previewToken) throw changed();
      const fresh=await require('./first-sync-eligibility').readFirstSyncEligibility(client,config,observation);
      if(!fresh.historyReview || !sameIdentity(fresh.historyReview,inspected.first.historyReview)) throw changed();
      const audit=await writeAuditEvent(client,{mutationContext:{actorUserId:options.actorUserId},eventKey:EVENT,
        subjectType:'magento_first_sync_cutover_admission',subjectId:input.previewToken,
        details:{admission:fresh.historyReview,previewToken:input.previewToken,remoteWrites:0,enqueued:false}});
      await gate.commit(client);return result(audit);
    } catch(cause){await gate.rollback(client).catch(()=>{});throw cause;}
    finally{await gate.release(client).catch(()=>{});client.release();}
  });
}
module.exports={proposal,readOnClient,allows,assertOnClient,rootId,captureState,descriptor,apply};
