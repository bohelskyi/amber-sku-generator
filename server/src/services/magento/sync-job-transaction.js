const c = require('./binding-contract');
const plan = require('./sync-job-plan');
const { readRevisionOnClient } = require('./binding.service');
const { resolveProductLookup } = require('../product/public-identity');
const { APPLICATION_USER_ADMIN_LOCK_KEY, assertActorStillAuthorized } = require('../access-admin-transaction');
const gate = require('../full-product-cutover-gate');
const automatic = require('./automatic-sync-boundary');
const historical = require('./historical-update-boundary');
const standard = require('./historical-standard-boundary');
const { phase } = require('./sync-local-diagnostics');

async function readState(client, config, input, options, canonicalSku) {
  await phase('authority_lock', () => client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [APPLICATION_USER_ADMIN_LOCK_KEY]));
  await phase('actor_check', () => assertActorStillAuthorized(client, options.actorUserId, 'export_templates.publish', c.error));
  await phase('lifecycle_gate', () => gate.enterExisting(client));
  if (!(await client.query("SELECT to_regclass('magento_sync_jobs') AS present")).rows[0].present) plan.fail('MAGENTO_SYNC_MIGRATION_REQUIRED');
  const revision = await phase('binding_read', () => readRevisionOnClient(client, input.bindingRevisionId));
  await phase('binding_lock', () => client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`amber_magento_binding:${revision.installationKey}`]));
  const current = (await phase('binding_check', () => client.query(`SELECT id FROM magento_binding_revisions WHERE installation_key=$1
    AND state='published' ORDER BY version_number DESC LIMIT 1`, [revision.installationKey]))).rows[0];
  if (revision.state !== 'published' || current?.id !== revision.id) plan.fail('MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED');
  if (revision.originHash !== c.originHash(config.baseUrl) || revision.schema.storeCode !== 'all') plan.fail('MAGENTO_SYNC_INSTALLATION_MISMATCH');
  const resolved = await phase('product_lookup', () => resolveProductLookup(client, canonicalSku));
  if (!resolved.product || resolved.internalMatchCount > 1) plan.fail('MAGENTO_SYNC_PRODUCT_NOT_UNIQUE');
  const product = (await phase('product_lock', () => client.query(`SELECT p.*,i.public_sku FROM products p
    JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1 FOR NO KEY UPDATE OF p`,
  [resolved.product.id]))).rows[0];
  if ((await client.query('SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=$1',
    [product.public_product_identity_id])).rowCount) plan.fail('MAGENTO_SYNC_TEST_DELETION');
  const lifecycle = (await phase('lifecycle_lock', () => client.query(
    'SELECT * FROM product_full_export_state WHERE product_id=$1 FOR NO KEY UPDATE', [product.id]))).rows[0];
  if (!lifecycle) plan.fail('MAGENTO_SYNC_PRODUCT_STATE_MISSING');
  const state = { productId: product.id, publicIdentityId: product.public_product_identity_id,
    publicSku: product.public_sku, amberHash: c.hash(plan.clean({ product, lifecycle })),
    bindingHash: c.hash(plan.clean(revision)), revision };
  await phase('historical_check', async () => {
    state.historicalUpdate = await historical.readConstraint(client, state.publicIdentityId, revision.originHash);
    await historical.assertLocal(client, config, state.historicalUpdate, state);
    state.historicalStandard = await standard.readConstraint(client, state.publicIdentityId, revision.originHash);
    await standard.assertLocal(client, config, state.historicalStandard, state, options.actorUserId);
  });
  if (options.automatic) await phase('automatic_check', async () => {
    if (state.productId !== options.automatic.productId
      || String(state.publicIdentityId) !== String(options.automatic.publicIdentityId)) plan.fail('MAGENTO_SYNC_AMBER_CHANGED');
    await automatic.assertEnabled(client, options);
    await automatic.assertGeneration(client, options);
  });
  return state;
}
async function revalidate(client, config, state, options) {
  const fresh = await readState(client, config, { bindingRevisionId: state.revision.id }, options, state.publicSku);
  await phase('snapshot_check', async () => {
    if (fresh.productId !== state.productId || String(fresh.publicIdentityId) !== String(state.publicIdentityId)
      || fresh.amberHash !== state.amberHash) plan.fail('MAGENTO_SYNC_AMBER_CHANGED');
    if (fresh.bindingHash !== state.bindingHash) plan.fail('MAGENTO_SYNC_BINDING_CHANGED');
  });
}
module.exports = { readState, revalidate };
