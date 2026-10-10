const c = require('./binding-contract');
const { syncEligibility } = require('./sync-eligibility');
const ledger = require('./first-sync-ledger');
const historyAdmission = require('./first-sync-history-admission');
const optionalReceipts = require('./first-sync-optional-receipt-audit');

// A numeric floor proves delivery only through its immutable exact remote receipt.
function externalDeliveryEvidence(receipts, {originHash,sku,remote}) {
  if (!Array.isArray(receipts)) return {externalDelivery:false,issue:'FIRST_SYNC_HISTORY_REVIEW_REQUIRED'};
  if (!receipts.length) return {externalDelivery:false,issue:null};
  for (const receipt of receipts) {
    const details=receipt.details, proof=details?.remote;
    if (receipt.eventKey !== 'product.external_delivery_acknowledged' || receipt.subjectType !== 'product'
      || receipt.subjectId !== String(receipt.productId) || !/^[1-9][0-9]*$/.test(receipt.revision)
      || details?.fullRevision !== receipt.revision || details?.externalDeliverySemantic !== true
      || !/^[a-f0-9]{64}$/.test(details?.planHash || '')
      || !/^[a-f0-9]{64}$/.test(proof?.originHash || '')
      || !Number.isSafeInteger(proof?.productId) || proof.productId < 1
      || typeof proof?.sku !== 'string' || !proof.sku.length)
      return {externalDelivery:false,issue:'FIRST_SYNC_HISTORY_REVIEW_REQUIRED'};
  }
  if (receipts.some(receipt=>receipt.details.remote.originHash !== originHash))
    return {externalDelivery:false,issue:'FIRST_SYNC_ORIGIN_REVIEW_REQUIRED'};
  if (!remote || receipts.some(receipt=>receipt.details.remote.productId !== remote.id
    || receipt.details.remote.sku !== sku || remote.sku !== sku))
    return {externalDelivery:false,issue:'FIRST_SYNC_IDENTITY_CHANGED'};
  return {externalDelivery:true,issue:null};
}

function classifyFirstSyncEvidence(evidence) {
  const block = code => ({mode:'review', blockers:[{code}]});
  if (evidence.session && (!evidence.remote || Number(evidence.session.remote_product_id) !== evidence.remote.id
    || evidence.session.public_sku !== evidence.sku || evidence.session.installation_key !== evidence.installationKey))
    return block('FIRST_SYNC_IDENTITY_CHANGED');
  if (evidence.acknowledgedRemoteId != null && (!evidence.remote
    || String(evidence.acknowledgedRemoteId) !== String(evidence.remote.id)))
    return block('FIRST_SYNC_IDENTITY_CHANGED');
  if (evidence.externalDeliveryIssue) return block(evidence.externalDeliveryIssue);
  // Completion and later delivery cannot validate an earlier unsupported receipt.
  if (evidence.optionalReceiptBlockers?.length) return {mode:'review',blockers:evidence.optionalReceiptBlockers};
  if (!evidence.remote) {
    if(evidence.otherOrigin) return block('FIRST_SYNC_ORIGIN_REVIEW_REQUIRED');
    if(evidence.previousDelivery) return block('FIRST_SYNC_IDENTITY_CHANGED');
    if(evidence.historicalEvidence || !evidence.history.complete || evidence.history.issues.length || evidence.history.identityChanged)
      return block('FIRST_SYNC_HISTORY_REVIEW_REQUIRED');
    return {mode:'create', blockers:[]};
  }
  if (evidence.remote.sku !== evidence.sku || !Number.isSafeInteger(evidence.remote.id) || evidence.remote.id < 1)
    return block('FIRST_SYNC_IDENTITY_CHANGED');
  if (evidence.ownershipIssue) return block(evidence.ownershipIssue);
  if (evidence.lifecycleBlockers?.length) return {mode:'review',blockers:evidence.lifecycleBlockers};
  if (evidence.otherOrigin) return block('FIRST_SYNC_ORIGIN_REVIEW_REQUIRED');
  // An incomplete field session retains its gate after an outward job succeeds.
  if (evidence.session && !evidence.session.completed_at) {
    if (evidence.protectedWork) return block('FIRST_SYNC_UNFINISHED_WORK');
    if (!evidence.history.complete || (!evidence.historyAdmission && (evidence.history.issues.length || evidence.history.identityChanged)))
      return block('FIRST_SYNC_HISTORY_REVIEW_REQUIRED');
    return {mode:'first',blockers:[]};
  }
  // Ordinary delivery retains its existing job/recovery/dispatch protections.
  if (evidence.session?.completed_at || evidence.sameOriginAcknowledged) return {mode:'ordinary',blockers:[]};
  if (!evidence.history.complete || (!evidence.historyAdmission && (evidence.history.issues.length || evidence.history.identityChanged)))
    return block('FIRST_SYNC_HISTORY_REVIEW_REQUIRED');
  if (evidence.otherOrigin) return block('FIRST_SYNC_ORIGIN_REVIEW_REQUIRED');
  // A reviewed recount admits field review only, never ordinary delivery.
  if (evidence.historyAdmission) {
    if (evidence.protectedWork) return block('FIRST_SYNC_UNFINISHED_WORK');
    return {mode:'first',blockers:[]};
  }
  // This floor proves actual operator delivery; confirmed/cutover counters do not.
  if (evidence.externalDelivery) return {mode:'ordinary',blockers:[]};
  if (evidence.protectedWork) return block('FIRST_SYNC_UNFINISHED_WORK');
  if (evidence.previousDelivery) return {mode:'ordinary',blockers:[]};
  if (evidence.historicalEvidence) return block('FIRST_SYNC_HISTORY_REVIEW_REQUIRED');
  return {mode:'first',blockers:[]};
}

async function readFirstSyncEligibility(client, config, observation, {jobId = null,reviewedRecovery=false} = {}) {
  const {amber,raw}=observation, product=amber.product, origin=c.originHash(config.baseUrl);
  const key={originHash:origin,publicIdentityId:String(product.public_product_identity_id)};
  const progress=await ledger.readOnClient(client,key);
  const optionalReceiptAssessment=await optionalReceipts.assessOnClient(client,progress);
  const history=await require('./recovery-history').read(client,product.id);
  const ids=history.products.map(row=>row.productId);
  const facts=(await client.query(`SELECT
    (SELECT j.remote_product_id::text FROM magento_sync_jobs j WHERE j.product_id=ANY($1::int[])
      AND j.origin_hash=$2 AND j.sku=$3 AND j.state='succeeded'
      AND j.acknowledged_at IS NOT NULL AND j.remote_product_id IS NOT NULL
      ORDER BY j.acknowledged_at DESC,j.created_at DESC,j.id DESC LIMIT 1) AS acknowledged_remote_id,
    EXISTS(SELECT 1 FROM magento_sync_jobs j WHERE j.product_id=ANY($1::int[])
      AND j.origin_hash=$2 AND j.sku=$3 AND j.remote_product_id=$4 AND j.state='succeeded'
      AND j.acknowledged_at IS NOT NULL) AS previous_delivery,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('productId',f.product_id,
      'revision',f.externally_delivered_revision::text,'eventKey',a.event_key,
      'subjectType',a.subject_type,'subjectId',a.subject_id,'details',a.details)
      ORDER BY f.product_id),'[]'::jsonb)
      FROM product_full_export_state f LEFT JOIN audit_events a ON a.id=f.externally_delivered_event_id
      WHERE f.product_id=ANY($1::int[]) AND f.externally_delivered_revision>0) AS external_delivery_receipts,
    EXISTS(SELECT 1 FROM product_full_export_state f WHERE f.product_id=ANY($1::int[])
      AND (f.confirmed_revision>0 OR f.cutover_baseline_revision>0 OR f.csv_retired_revision>0)) AS historical_evidence,
    EXISTS(SELECT 1 FROM export_snapshot_products m WHERE m.product_id=ANY($1::int[])) AS snapshot_evidence,
    EXISTS(SELECT 1 FROM magento_sync_jobs j WHERE j.product_id=ANY($1::int[])
      AND j.origin_hash<>$2 AND j.state='succeeded' AND j.acknowledged_at IS NOT NULL)
      OR EXISTS(SELECT 1 FROM magento_first_sync_sessions s WHERE s.public_product_identity_id=$6 AND s.origin_hash<>$2) AS other_origin,
    EXISTS(SELECT 1 FROM magento_sync_jobs j WHERE j.product_id=ANY($1::int[])
      AND j.state NOT IN ('succeeded','superseded') AND ($5::text IS NULL OR j.id<>$5::text))
      OR EXISTS(SELECT 1 FROM product_media_jobs j WHERE j.product_id=ANY($1::int[]) AND j.state NOT IN ('succeeded','superseded'))
      OR EXISTS(SELECT 1 FROM product_visibility_intents v WHERE v.product_id=ANY($1::int[]) AND v.state NOT IN ('verified','superseded'))
      OR EXISTS(SELECT 1 FROM historical_reactivation_intents h WHERE h.product_id=ANY($1::int[]) AND h.state<>'completed')
      OR EXISTS(SELECT 1 FROM historical_standard_intents h WHERE h.product_id=ANY($1::int[]) AND h.state NOT IN ('completed','cancelled'))
      OR EXISTS(SELECT 1 FROM magento_test_deletions d WHERE d.public_product_identity_id=$6)
      OR EXISTS(SELECT 1 FROM magento_product_sync_requests r WHERE r.public_product_identity_id=$6 AND r.reason_code='reconciliation_required'
        AND (NOT $7::boolean OR $5::text IS NULL OR r.active_job_id IS DISTINCT FROM $5::text)) AS protected_work`,
  [ids,origin,product.public_sku,raw?.id ?? null,progress ? jobId : null,product.public_product_identity_id,reviewedRecovery])).rows[0];
  const external=externalDeliveryEvidence(facts.external_delivery_receipts,{originHash:origin,sku:product.public_sku,remote:raw});
  const admitted=raw && history.complete && (history.issues.length || history.identityChanged || history.hasRecount)
    && !(progress?.session.completed_at || (facts.previous_delivery && !progress))
    ? await historyAdmission.readOnClient(client,config,observation,{history})
    : {admission:null,evidenceHash:null};
  const evidence={historyAdmission:historyAdmission.allows(observation,admitted.admission),session:progress?.session,remote:raw,sku:product.public_sku,
    optionalReceiptBlockers:optionalReceiptAssessment.blockers,
    installationKey:amber.revision.installationKey,history,
    ownershipIssue:require('./native-identity-ownership').issue(amber,raw),
    lifecycleBlockers:syncEligibility(product,raw).reasons.map(row=>({code:row.code})),
    acknowledgedRemoteId:facts.acknowledged_remote_id,
    previousDelivery:facts.previous_delivery||external.externalDelivery,
    sameOriginAcknowledged:facts.previous_delivery,externalDelivery:external.externalDelivery,externalDeliveryIssue:external.issue,
    otherOrigin:facts.other_origin,protectedWork:facts.protected_work,
    historicalEvidence:facts.historical_evidence||facts.snapshot_evidence||history.hasRecount};
  return {...classifyFirstSyncEvidence(evidence),progress,key,
    historyAdmission:admitted.admission,historyAdmissionHash:admitted.evidenceHash,
    evidenceHash:c.hash({history,facts,historyAdmission:admitted.evidenceHash,optionalReceipts:optionalReceiptAssessment.evidence,
      identity:[product.public_product_identity_id,product.public_sku,raw?.id ?? null],
      session:progress?.session,fields:progress?.fields})};
}

module.exports={classifyFirstSyncEvidence,readFirstSyncEligibility,externalDeliveryEvidence};
