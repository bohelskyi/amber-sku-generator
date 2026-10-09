// Internal execution capability for one already-confirmed historical UPDATE.
// The caller owns the authorized transaction, product/binding locks and remote
// observation. This module performs no network, field imports or ledger writes.
const c = require('./binding-contract');
const standard = require('./historical-standard-boundary');
const historical = require('./historical-update-boundary');
const s = require('../historical-reactivation-state');
const transaction = require('./sync-job-transaction');
const ledger = require('./first-sync-ledger');
const history = require('./recovery-history');
const ownership = require('./native-identity-ownership');
const { externalDeliveryEvidence } = require('./first-sync-eligibility');

const capabilities = new WeakMap();
const fail = (code, status = 409) => {
  throw c.error(status, 'MAGENTO_FIRST_SYNC_' + code,
    'Підтверджений ручний план відновлення потребує актуальної перевірки.');
};
const sameId = (left, right) => left != null && right != null && String(left) === String(right);
const hash = value => c.hash(s.clean(value));
const proofHash = (kind, proof) => {
  const mutable = kind === 'standard'
    ? ['state','reason_code','native_job_id','confirmed_remote_product_id','delivery_verified_at',
      'local_activated_at','last_checked_at','cancelled_at']
    : ['state','reason_code','dispatched_at','hidden_verified_at','local_activated_at',
      'native_job_id','native_confirmed_at','last_checked_at'];
  return hash(Object.fromEntries(Object.entries(proof).filter(([key]) => !mutable.includes(key))));
};
const jobHash = job => hash(Object.fromEntries(['id','product_id','public_product_identity_id','sku',
  'installation_key','origin_hash','binding_revision_id','binding_hash','amber_hash','plan_hash',
  'intent','baseline','created_by_user_id','automatic_generation'].map(key => [key, job[key] ?? null])));

function candidate(state) {
  const activeStandard = state?.historicalStandard
    && !['completed','cancelled'].includes(state.historicalStandard.state);
  const activeHistorical = state?.historicalUpdate?.state === 'awaiting_native';
  if (activeStandard && activeHistorical) fail('REVIEWED_MANUAL_AMBIGUOUS');
  if (activeStandard) return {kind:'standard',proof:state.historicalStandard};
  if (activeHistorical) return {kind:'historical',proof:state.historicalUpdate};
  return null;
}
async function readProof(client, context) {
  // SQL identifiers are a closed internal choice, never command input.
  const sql = context.kind === 'standard'
    ? 'SELECT * FROM historical_standard_intents WHERE id=$1 FOR SHARE'
    : 'SELECT * FROM historical_reactivation_intents WHERE id=$1 FOR SHARE';
  const proof = (await client.query(sql, [context.intentId])).rows[0];
  if (!proof || proofHash(context.kind, proof) !== context.proofHash) fail('REVIEWED_MANUAL_INTENT_CHANGED');
  if (context.kind === 'standard' && !['queued','delivering'].includes(proof.state)
    || context.kind === 'historical' && proof.state !== 'awaiting_native') fail('REVIEWED_MANUAL_INTENT_CHANGED');
  if (proof.cancelled_at != null) fail('REVIEWED_MANUAL_INTENT_CHANGED');
  return proof;
}
function assertIdentity(context, proof) {
  const {config,observation,state,options,intent} = context;
  const amber = observation?.amber, product = amber?.product, revision = amber?.revision, raw = observation?.raw;
  if (!raw || !Number.isSafeInteger(raw.id) || raw.id < 1 || raw.sku !== state.publicSku
    || !sameId(raw.id, proof.remote_product_id) || !product || product.id !== state.productId
    || product.public_sku !== state.publicSku || !sameId(product.public_product_identity_id, state.publicIdentityId)
    || !sameId(proof.product_id, state.productId) || !sameId(proof.public_product_identity_id, state.publicIdentityId)
    || proof.public_sku !== state.publicSku || !revision || revision.id !== state.revision.id
    || proof.binding_revision_id !== state.revision.id || proof.origin_hash !== state.revision.originHash
    || revision.originHash !== state.revision.originHash || c.originHash(config.baseUrl) !== proof.origin_hash
    || proof.installation_key !== state.revision.installationKey || revision.installationKey !== proof.installation_key)
    fail('REVIEWED_MANUAL_IDENTITY_CHANGED');
  if (!Number.isSafeInteger(options.actorUserId) || options.actorUserId < 1
    || !sameId(options.actorUserId, proof.actor_user_id)) fail('REVIEWED_MANUAL_ORIGINAL_ACTOR_REQUIRED', 403);
  if (intent?.mode !== 'update' || !Array.isArray(intent.operations) || !intent.operations.length)
    fail('REVIEWED_MANUAL_PLAN_CHANGED');
  const expected = context.kind === 'standard' ? proof.plan_hash : proof.current_facts?.deliveryPlanHash;
  if (!/^[a-f0-9]{64}$/.test(expected || '') || hash(intent) !== expected) fail('REVIEWED_MANUAL_PLAN_CHANGED');
  if (observation.categoryFailures?.length || observation.domainEvidence?.failures?.length)
    fail('REVIEWED_MANUAL_OBSERVATION_UNKNOWN');
  ownership.assertOwned(amber, raw); // Keep the original loader-owned WeakMap proof.
}
async function readJob(client, context, proof) {
  if (!context.job) {
    if (proof.native_job_id != null) fail('REVIEWED_MANUAL_ORIGINAL_JOB_REQUIRED');
    return {job:null,hasProgress:false};
  }
  const job = (await client.query('SELECT * FROM magento_sync_jobs WHERE id=$1 FOR SHARE', [context.job.id])).rows[0];
  if (!job || jobHash(job) !== context.jobHash || job.intent?.mode !== 'update'
    || job.plan_hash !== hash(context.intent) || hash(job.intent) !== job.plan_hash
    || job.product_id !== context.state.productId || !sameId(job.public_product_identity_id, context.state.publicIdentityId)
    || job.sku !== proof.public_sku || job.origin_hash !== proof.origin_hash
    || job.installation_key !== proof.installation_key || job.binding_revision_id !== proof.binding_revision_id
    || job.amber_hash !== context.state.amberHash || job.binding_hash !== context.state.bindingHash
    || !sameId(job.created_by_user_id, proof.actor_user_id)
    || !sameId(job.baseline?.raw?.id, proof.remote_product_id) || job.baseline?.raw?.sku !== proof.public_sku
    || job.remote_product_id != null && !sameId(job.remote_product_id, proof.remote_product_id)
    || job.state === 'superseded' || proof.native_job_id != null && proof.native_job_id !== job.id)
    fail('REVIEWED_MANUAL_ORIGINAL_JOB_REQUIRED');
  if (context.kind === 'standard' && (job.automatic_generation != null || context.options.automatic)
    || context.kind === 'historical' && !sameId(job.automatic_generation, proof.expected_generation))
    fail('REVIEWED_MANUAL_GENERATION_CHANGED');
  const hasProgress = (await client.query('SELECT 1 FROM magento_sync_steps WHERE job_id=$1 LIMIT 1', [job.id])).rowCount > 0;
  return {job,hasProgress};
}
async function assertProtectedWork(client, context, proof, job) {
  const {state,observation} = context;
  const origin = state.revision.originHash, identity = String(state.publicIdentityId);
  // Same key/order as first-sync-ledger.recordProgressOnClient. The no-session
  // check stays serialized until this dispatch/ack transaction commits.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['amber_magento_first_sync:' + origin + ':' + identity]);
  const progress = await ledger.readOnClient(client, {originHash:origin,publicIdentityId:identity});
  if (progress && (!sameId(progress.session.remote_product_id, observation.raw.id)
    || progress.session.public_sku !== state.publicSku
    || progress.session.installation_key !== state.revision.installationKey)) fail('IDENTITY_CHANGED');
  if (progress && !progress.session.completed_at) fail('REVIEWED_MANUAL_PARTIAL_SESSION');
  const component = await history.read(client, state.productId);
  if (!component.complete || component.issues.length || component.identityChanged
    || !component.products.some(row => row.productId === state.productId)) fail('HISTORY_REVIEW_REQUIRED');
  const ids = component.products.map(row => row.productId);
  const reviewedRecovery = !!(job && context.options.firstSyncRecoveryProof
    && require('./first-sync-runtime').recoveryIsReviewed(context.options.firstSyncRecoveryProof, job.id, observation));
  const facts = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM magento_first_sync_sessions s WHERE s.public_product_identity_id=$2 AND s.origin_hash<>$3)
      OR EXISTS(SELECT 1 FROM magento_sync_jobs j WHERE j.product_id=ANY($1::int[])
        AND j.origin_hash<>$3 AND j.state='succeeded' AND j.acknowledged_at IS NOT NULL) AS other_origin,
    EXISTS(SELECT 1 FROM magento_first_sync_sessions s WHERE s.origin_hash=$3
      AND s.remote_product_id=$5 AND s.public_product_identity_id<>$2)
      OR EXISTS(SELECT 1 FROM magento_sync_jobs j WHERE j.product_id=ANY($1::int[])
      AND j.origin_hash=$3 AND j.state='succeeded' AND j.acknowledged_at IS NOT NULL
      AND j.remote_product_id IS NOT NULL AND (j.sku<>$4 OR j.remote_product_id<>$5)) AS identity_changed,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('productId',f.product_id,
      'revision',f.externally_delivered_revision::text,'eventKey',a.event_key,
      'subjectType',a.subject_type,'subjectId',a.subject_id,'details',a.details) ORDER BY f.product_id),'[]'::jsonb)
      FROM product_full_export_state f LEFT JOIN audit_events a ON a.id=f.externally_delivered_event_id
      WHERE f.product_id=ANY($1::int[]) AND f.externally_delivered_revision>0) AS external_delivery_receipts,
    EXISTS(SELECT 1 FROM magento_sync_jobs j WHERE j.product_id=ANY($1::int[])
      AND j.state NOT IN ('succeeded','superseded') AND ($6::text IS NULL OR j.id<>$6))
      OR EXISTS(SELECT 1 FROM product_media_jobs j WHERE j.product_id=ANY($1::int[]) AND j.state NOT IN ('succeeded','superseded'))
      OR EXISTS(SELECT 1 FROM product_visibility_intents v WHERE v.product_id=ANY($1::int[]) AND v.state NOT IN ('verified','superseded'))
      OR EXISTS(SELECT 1 FROM historical_standard_intents h WHERE h.product_id=ANY($1::int[])
        AND h.state NOT IN ('completed','cancelled') AND ($7::text IS NULL OR h.id<>$7))
      OR EXISTS(SELECT 1 FROM historical_reactivation_intents h WHERE h.product_id=ANY($1::int[])
        AND h.state<>'completed' AND ($8::text IS NULL OR h.id<>$8))
      OR EXISTS(SELECT 1 FROM magento_test_deletions d WHERE d.public_product_identity_id=$2)
      OR EXISTS(SELECT 1 FROM magento_product_sync_requests r WHERE r.public_product_identity_id=$2
        AND r.reason_code='reconciliation_required'
        AND (NOT $9::boolean OR $6::text IS NULL OR r.active_job_id IS DISTINCT FROM $6)) AS protected_work`,
  [ids,identity,origin,state.publicSku,observation.raw.id,job?.id || null,
    context.kind === 'standard' ? proof.id : null,context.kind === 'historical' ? proof.id : null,reviewedRecovery])).rows[0];
  if (!facts || facts.other_origin !== false || facts.identity_changed !== false || facts.protected_work !== false)
    fail(!facts || facts.protected_work !== false ? 'UNFINISHED_WORK'
      : facts.other_origin !== false ? 'ORIGIN_REVIEW_REQUIRED' : 'IDENTITY_CHANGED');
  const external = externalDeliveryEvidence(facts.external_delivery_receipts,
    {originHash:origin,sku:state.publicSku,remote:observation.raw});
  if (external.issue) fail(external.issue.replace(/^FIRST_SYNC_/, ''));
}
async function validateOnClient(client, context, {revalidate = false} = {}) {
  if (revalidate) await transaction.revalidate(client, context.config, context.state, context.options);
  const proof = await readProof(client, context);
  assertIdentity(context, proof);
  if (context.observationHash !== standard.observationFingerprint(context.observation)) fail('REVIEWED_MANUAL_OBSERVATION_CHANGED');
  if (context.kind === 'standard') await standard.assertLocal(client, context.config, proof, context.state, context.options.actorUserId);
  else await historical.assertLocal(client, context.config, proof, context.state);
  const {job,hasProgress} = await readJob(client, context, proof);
  if (context.kind === 'standard') {
    if (context.options.automatic || proof.delivery_mode !== 'update') fail('REVIEWED_MANUAL_PLAN_CHANGED');
    standard.assertPlan(proof, context.intent, context.observation, hasProgress);
  } else {
    if (!sameId(context.options.automatic?.generation, proof.expected_generation)
      || !sameId(context.options.automatic?.productId, proof.product_id)
      || !sameId(context.options.automatic?.publicIdentityId, proof.public_product_identity_id)
      || context.options.automatic?.installationKey !== proof.installation_key) fail('REVIEWED_MANUAL_GENERATION_CHANGED');
    historical.assertPlan(proof, context.intent, context.observation);
    if (!hasProgress && !s.remoteMatches(proof, context.observation.raw, true)) fail('REVIEWED_MANUAL_OBSERVATION_CHANGED');
  }
  await assertProtectedWork(client, context, proof, job);
}
async function issueOnClient(client, config, observation, state, options, {intent,job = null} = {}) {
  const selected = candidate(state);
  if (!selected || selected.kind === 'standard' && selected.proof.delivery_mode === 'create') return null;
  if (!intent && !job?.intent) fail('REVIEWED_MANUAL_PLAN_REQUIRED');
  const context = {kind:selected.kind,intentId:selected.proof.id,proofHash:proofHash(selected.kind, selected.proof),
    config:{configured:config.configured,baseUrl:config.baseUrl},observation,
    state:s.clean(state),options:{actorUserId:options.actorUserId,automatic:options.automatic ? s.clean(options.automatic) : null,
      firstSyncRecoveryProof:options.firstSyncRecoveryProof},
    intent:s.clean(intent || job.intent),job:job ? s.clean(job) : null,jobHash:job ? jobHash(job) : null,
    observationHash:standard.observationFingerprint(observation)};
  if (intent && job && hash(intent) !== hash(job.intent)) fail('REVIEWED_MANUAL_PLAN_CHANGED');
  await validateOnClient(client, context);
  const token = Object.freeze({});
  capabilities.set(token, context);
  return token;
}
async function assertOnClient(client, token) {
  const context = capabilities.get(token);
  if (!context) fail('REVIEWED_MANUAL_PROOF_REQUIRED');
  await validateOnClient(client, context, {revalidate:true});
}
module.exports = {issueOnClient,assertOnClient};
