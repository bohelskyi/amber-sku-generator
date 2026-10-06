const c = require('./binding-contract');
const s = require('../historical-reactivation-state');
const lifecycle = require('../product-lifecycle-state');
const { readPreviewProduct } = require('./sync-preview-db');

const PROTOCOL = 'standard-rest-v1';
async function present(client) {
  return !!(await client.query("SELECT to_regclass('historical_standard_intents') AS present")).rows[0]?.present;
}
async function readConstraint(client, identityId, origin) {
  if (!await present(client)) return null;
  return (await client.query(`SELECT * FROM historical_standard_intents WHERE public_product_identity_id=$1
    AND origin_hash=$2 AND state IN ('queued','delivering','blocked') ORDER BY created_at DESC LIMIT 1`, [identityId, origin])).rows[0] || null;
}
function project(amber) {
  // Keep the original mapped object: frozen source-support proof is object-bound.
  amber.product.status = 'active'; amber.product.exclude_from_export = 0;
  amber.product.exportState = { ...amber.product.exportState, route:'normal', hold_reason:null,
    business_exclusion_state:'none', recount_compatibility_excluded:false, independentExclusion:false };
  return amber;
}
const readProspective = async (db, input) => project(await readPreviewProduct(db, input));
function observationFingerprint(observation) {
  const raw = observation.raw ? s.clean(observation.raw) : null;
  if (raw) delete raw.updated_at;
  return c.hash({ raw, domainEvidence:observation.domainEvidence });
}
async function assertLocal(client, config, proof, state, actorUserId) {
  if (!proof) return;
  if (Number(actorUserId)!==Number(proof.actor_user_id)) s.fail('HISTORICAL_ORIGINAL_ACTOR_REQUIRED',403);
  await s.authority(client, Number(proof.actor_user_id));
  const binding = await s.currentBinding(client, config);
  if (binding.row.id!==proof.binding_revision_id || binding.fingerprint!==proof.binding_hash) s.fail('HISTORICAL_BINDING_CHANGED');
  const target = await lifecycle.readTarget(client, Number(proof.product_id), { origin:proof.origin_hash });
  if (Number(state.productId)!==Number(proof.product_id) || state.publicSku!==proof.public_sku
    || s.fingerprint(target.product,target.lifecycle)!==proof.local_fingerprint) s.fail('HISTORICAL_CURRENT_FACTS_CHANGED');
  if (target.product.corrected_to_product_id!=null || target.product.corrected_from_product_id!=null
    || target.facts.newerRevision || target.facts.activeSuccessor || target.facts.correctionHistory || target.facts.testDeletion
    || target.facts.unfinishedMedia || target.facts.unresolvedVisibility) s.fail('HISTORICAL_LINEAGE_BLOCKED');
  const request = (await client.query('SELECT desired_generation FROM magento_product_sync_requests WHERE public_product_identity_id=$1',[proof.public_product_identity_id])).rows[0];
  if ((request?.desired_generation || null)!==proof.request_generation) s.fail('HISTORICAL_GENERATION_CHANGED');
  if (proof.state==='blocked') s.fail('HISTORICAL_STANDARD_REVIEW_REQUIRED');
}
function assertOriginalObservation(proof, observation) {
  if (!proof) return;
  const raw = observation.raw;
  require('../product/test-products').assertDisabled(observation.amber?.product, raw, proof.target_status === 1);
  if (proof.delivery_mode === 'update') require('./native-identity-ownership').assertOwned(observation.amber, raw);
  if (proof.delivery_mode==='create') {
    if (raw) s.fail('HISTORICAL_REMOTE_OBSERVATION_CHANGED');
  } else if (!raw || raw.sku!==proof.public_sku || Number(raw.id)!==Number(proof.remote_product_id)
    || raw.status!==proof.target_status || raw.visibility!==proof.target_visibility) s.fail('HISTORICAL_REMOTE_OBSERVATION_CHANGED');
  if (observationFingerprint(observation)!==proof.remote_fingerprint && proof.delivery_mode==='update') s.fail('HISTORICAL_REMOTE_OBSERVATION_CHANGED');
  if (proof.delivery_mode==='create' && observationFingerprint(observation)!==proof.review.remoteObservationHash) s.fail('HISTORICAL_REMOTE_OBSERVATION_CHANGED');
}
function assertPlan(proof, intent, observation, hasProgress = false) {
  if (!proof) return;
  if (hasProgress) assertIdentity(proof,observation); else assertOriginalObservation(proof, observation);
  if (intent.mode!==proof.delivery_mode || c.hash(intent)!==proof.plan_hash) s.fail('HISTORICAL_DELIVERY_PLAN_CHANGED');
}
function assertIdentity(proof, observation, job) {
  if (!proof || !observation.raw) return;
  if (proof.delivery_mode === 'update') require('./native-identity-ownership').assertOwned(observation.amber, observation.raw);
  const expected = proof.remote_product_id || job?.remote_product_id;
  if (observation.raw.sku!==proof.public_sku || expected && Number(observation.raw.id)!==Number(expected)
    || observation.raw.status!==proof.target_status || observation.raw.visibility!==proof.target_visibility) s.fail('HISTORICAL_REMOTE_OBSERVATION_CHANGED');
}
module.exports = { PROTOCOL, present, readConstraint, project, readProspective, observationFingerprint,
  assertLocal, assertOriginalObservation, assertPlan, assertIdentity };
