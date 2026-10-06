const c = require('./binding-contract');
const s = require('../historical-reactivation-state');
const lifecycle = require('../product-lifecycle-state');
const { runAccessAdminMutation } = require('../access-admin-transaction');
const { writeAuditEvent } = require('../../audit/audit-events');

async function readConstraint(client, identityId, origin) {
  // Checkpoint fixtures and old installations retain their previous contracts.
  if (!(await client.query("SELECT to_regclass('historical_reactivation_intents') AS present")).rows[0]?.present) return null;
  return (await client.query(`SELECT * FROM historical_reactivation_intents WHERE public_product_identity_id=$1
    AND origin_hash=$2 AND state IN ('awaiting_native','completed') ORDER BY created_at DESC,id DESC LIMIT 1`, [identityId, origin])).rows[0] || null;
}
async function assertLocal(client, config, proof, state) {
  if (!proof) return;
  if (state.publicSku !== proof.public_sku || state.revision.originHash !== proof.origin_hash) s.fail('HISTORICAL_REMOTE_IDENTITY_MISMATCH');
  if (proof.state === 'awaiting_native') {
    await s.authority(client, Number(proof.actor_user_id));
    const binding = await s.currentBinding(client, config);
    if (binding.row.id !== proof.binding_revision_id || binding.fingerprint !== proof.binding_hash) s.fail('HISTORICAL_BINDING_CHANGED');
    const request = (await client.query('SELECT product_id,desired_generation FROM magento_product_sync_requests WHERE public_product_identity_id=$1', [proof.public_product_identity_id])).rows[0];
    if (Number(state.productId) !== Number(proof.product_id) || Number(request?.product_id) !== Number(proof.product_id)
      || String(request?.desired_generation) !== String(proof.expected_generation)) s.fail('HISTORICAL_GENERATION_CHANGED');
  }
}
function assertObservation(proof, observation) {
  if (!proof) return;
  const raw = observation.raw;
  if (!raw || raw.sku !== proof.public_sku || Number(raw.id) !== Number(proof.remote_product_id)) s.fail('HISTORICAL_REMOTE_COUNTERPART_MISSING');
  if (proof.state === 'awaiting_native' && Number(raw.status) !== 2) s.fail('HISTORICAL_HIDDEN_STATUS_CHANGED');
}
function assertPlan(proof, intent, observation) {
  if (!proof) return;
  assertObservation(proof, observation);
  if (intent.mode !== 'update') s.fail('HISTORICAL_CREATE_FORBIDDEN');
  if (proof.state === 'awaiting_native' && c.hash(intent) !== proof.current_facts.deliveryPlanHash) s.fail('HISTORICAL_DELIVERY_PLAN_CHANGED');
}
async function confirmCompleted(config, options) {
  const db = options.databasePool;
  const rows = (await db.query(`SELECT * FROM historical_reactivation_intents WHERE state='awaiting_native' AND origin_hash=$1
    ORDER BY created_at,id LIMIT 25`, [c.originHash(config.baseUrl)])).rows;
  for (const intent of rows) {
    if (options.stopping?.()) return;
    try {
      await runAccessAdminMutation({ databasePool: db, actorUserId: Number(intent.actor_user_id), requiredPermission: 'export_templates.publish', createError: c.error,
        operation: async client => {
          await s.authority(client, Number(intent.actor_user_id));
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${intent.installation_key}`]);
          const binding = await s.currentBinding(client, config);
          if (binding.row.id !== intent.binding_revision_id || binding.fingerprint !== intent.binding_hash) s.fail('HISTORICAL_BINDING_CHANGED');
          const current = await lifecycle.readTarget(client, Number(intent.product_id), { origin: intent.origin_hash, lock: true });
          if (current.product.status !== 'active' || current.product.corrected_to_product_id != null || current.facts.newerRevision
            || current.facts.activeSuccessor || current.facts.testDeletion) s.fail('HISTORICAL_CURRENT_FACTS_CHANGED');
          const request = (await client.query('SELECT * FROM magento_product_sync_requests WHERE public_product_identity_id=$1 FOR UPDATE', [intent.public_product_identity_id])).rows[0];
          if (String(request?.desired_generation) !== String(intent.expected_generation) || Number(request?.product_id) !== Number(intent.product_id)) s.fail('HISTORICAL_GENERATION_CHANGED');
          if (request.state !== 'synced' || String(request.synced_generation) !== String(intent.expected_generation)) return;
          const job = (await client.query(`SELECT * FROM magento_sync_jobs WHERE product_id=$1 AND public_product_identity_id=$2
            AND origin_hash=$3 AND binding_revision_id=$4 AND automatic_generation=$5 AND state='succeeded'
            AND acknowledged_at IS NOT NULL AND remote_product_id=$6 AND sku=$7 AND intent->>'mode'='update'
            ORDER BY acknowledged_at DESC,id DESC LIMIT 1`, [intent.product_id, intent.public_product_identity_id, intent.origin_hash,
            intent.binding_revision_id, intent.expected_generation, intent.remote_product_id, intent.public_sku])).rows[0];
          if (!job) return;
          const updated = await client.query(`UPDATE historical_reactivation_intents SET state='completed',reason_code=NULL,native_job_id=$2,
            native_confirmed_at=(SELECT acknowledged_at FROM magento_sync_jobs WHERE id=$2) WHERE id=$1 AND state='awaiting_native' RETURNING id`, [intent.id,job.id]);
          if (updated.rowCount) await writeAuditEvent(client, { mutationContext: { actorUserId: Number(intent.actor_user_id), requestId:`historical-native-${intent.id}` },
            eventKey:'product.historical_reactivation_completed',subjectType:'product',subjectId:intent.product_id,
            details:{intentId:intent.id,jobId:job.id,generation:String(intent.expected_generation),remoteProductId:String(intent.remote_product_id)} });
        } });
    } catch (cause) {
      const reason = /^(HISTORICAL|ADMIN|MAGENTO)_[A-Z_]+$/.test(cause.code || '') ? cause.code : 'HISTORICAL_NATIVE_REVIEW_REQUIRED';
      await db.query("UPDATE historical_reactivation_intents SET reason_code=$2 WHERE id=$1 AND state='awaiting_native'", [intent.id,reason]);
    }
  }
}
module.exports = { readConstraint, assertLocal, assertObservation, assertPlan, confirmCompleted };
