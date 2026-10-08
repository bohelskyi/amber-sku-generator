const c = require('./binding-contract');
const plan = require('./sync-job-plan');
const { assertActorStillAuthorized, APPLICATION_USER_ADMIN_LOCK_KEY } = require('../access-admin-transaction');
const lifecycle = require('../full-product-cutover-gate');
const { phase } = require('./sync-local-diagnostics');

async function assertEnabled(client, options) {
  await phase('authority_lock', () => client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [APPLICATION_USER_ADMIN_LOCK_KEY]));
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [lifecycle.LOCK_KEY]);
  if ((await lifecycle.readGate(client)).phase === 'preparing') plan.fail('MAGENTO_AUTO_DISABLED');
  const gate = (await client.query('SELECT * FROM magento_auto_sync_activation WHERE singleton FOR SHARE')).rows[0];
  if (!gate?.enabled) plan.fail('MAGENTO_AUTO_DISABLED');
  if (gate.installation_key !== options.automatic.installationKey || Number(gate.actor_user_id) !== options.actorUserId) {
    plan.fail('MAGENTO_AUTO_CONFIGURATION_CHANGED');
  }
  await phase('actor_check', () => assertActorStillAuthorized(client, options.actorUserId, 'export_templates.publish', c.error));
}

async function assertGeneration(client, options) {
  const row = (await client.query(`SELECT product_id,desired_generation FROM magento_product_sync_requests
    WHERE public_product_identity_id=$1`, [options.automatic.publicIdentityId])).rows[0];
  if (Number(row?.product_id) !== Number(options.automatic.productId)
    || row?.desired_generation !== String(options.automatic.generation)) plan.fail('MAGENTO_SYNC_AMBER_CHANGED');
}

async function assertSnapshot(client, state, options) {
  await assertEnabled(client, options);
  const product = (await client.query(`SELECT p.*,i.public_sku FROM products p
    JOIN public_product_identities i ON i.id=p.public_product_identity_id
    WHERE p.id=$1 FOR NO KEY UPDATE OF p`, [state.productId])).rows[0];
  const lifecycle = (await client.query('SELECT * FROM product_full_export_state WHERE product_id=$1 FOR NO KEY UPDATE', [state.productId])).rows[0];
  if (c.hash(plan.clean({ product, lifecycle })) !== state.amberHash) plan.fail('MAGENTO_SYNC_AMBER_CHANGED');
  await assertGeneration(client, options);
}

async function attachJob(client, job, options) {
  await client.query(`UPDATE magento_product_sync_requests SET active_job_id=$2,active_generation=$3,
    state='syncing',reason_code=NULL,updated_at=CURRENT_TIMESTAMP WHERE public_product_identity_id=$1`,
  [options.automatic.publicIdentityId, job.id, options.automatic.generation]);
}
module.exports = { assertEnabled, assertGeneration, assertSnapshot, attachJob };
