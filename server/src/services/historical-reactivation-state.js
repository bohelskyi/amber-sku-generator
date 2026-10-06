const { createHmac, timingSafeEqual } = require('node:crypto');
const c = require('./magento/binding-contract');
const lifecycle = require('./product-lifecycle-state');
const { assertActorStillAuthorized } = require('./access-admin-transaction');
const PERMISSIONS = ['products.view', 'products.archive', 'history.view', 'export_templates.manage', 'export_templates.publish'];
const FORMAT = 'historical-reactivation-v1';
const TTL = 5 * 60 * 1000;
const fail = (code, status = 409) => { throw c.error(status, code, code); };
async function authority(client, actor, readOnly = false) {
  if (!Number.isSafeInteger(actor) || actor <= 0) fail('HISTORICAL_ADMINISTRATOR_REQUIRED', 403);
  for (const permission of PERMISSIONS) await assertActorStillAuthorized(client, actor, permission, c.error, { readOnly });
  const admin = (await client.query(`SELECT 1 FROM application_users u JOIN user_role_assignments a ON a.application_user_id=u.id
    JOIN roles r ON r.id=a.role_id WHERE u.id=$1 AND u.status='active' AND a.revoked_at IS NULL
    AND r.status='active' AND r.role_key='administrator' AND r.is_system=TRUE`, [actor])).rowCount;
  if (!admin) fail('HISTORICAL_ADMINISTRATOR_REQUIRED', 403);
}
function normalizeSkus(skus) {
  try { return lifecycle.inputSkus({ skus }); } catch { fail('HISTORICAL_SELECTION_INVALID', 422); }
}
function remoteFingerprint(raw) {
  if (!raw) return null;
  const copy = lifecycle.clean(raw); delete copy.updated_at; delete copy.status;
  return c.hash(copy);
}
function remoteMatches(intent, raw, hidden = false) {
  return !!raw && raw.sku === intent.public_sku && Number(raw.id) === Number(intent.remote_product_id)
    && Number.isSafeInteger(Number(raw.id)) && Number(raw.id) > 0
    && (!hidden || Number(raw.status) === 2) && remoteFingerprint(raw) === intent.remote_fingerprint;
}
function localIssue({ product, lifecycle: life, facts }) {
  if (product.status === 'active') return 'HISTORICAL_PRODUCT_ALREADY_ACTIVE';
  if (product.status !== 'archived' || life?.route !== 'retired') return 'HISTORICAL_PRODUCT_NOT_ARCHIVED';
  if (product.corrected_to_product_id != null || product.corrected_from_product_id != null
    || facts.newerRevision || facts.activeSuccessor || facts.correctionSource || facts.correctionHistory) return 'HISTORICAL_LINEAGE_BLOCKED';
  if (facts.testDeletion) return 'HISTORICAL_TEST_DELETION';
  if (facts.unfinishedMedia) return 'HISTORICAL_MEDIA_UNRESOLVED';
  if (facts.unfinishedJob || facts.unresolvedStep || facts.unresolvedVisibility) return 'HISTORICAL_SYNC_UNRESOLVED';
  if (life?.business_exclusion_state === 'excluded' || life?.hold_reason === 'intentional_exclusion'
    || life?.recount_compatibility_excluded || life?.evidence?.independentExclusion === true) return 'HISTORICAL_BUSINESS_EXCLUSION_REVIEW_REQUIRED';
  if (!Number.isFinite(Number(product.total_price_uah)) || Number(product.total_price_uah) <= 0) return 'HISTORICAL_PRICE_INVALID';
  return null;
}
async function currentBinding(client, config) {
  if (!config.configured) fail('HISTORICAL_AUTO_DELIVERY_REQUIRED');
  const activation = (await client.query('SELECT * FROM magento_auto_sync_activation WHERE singleton')).rows[0];
  if (!activation?.enabled || activation.legacy_product_csv_enabled !== false) fail('HISTORICAL_AUTO_DELIVERY_REQUIRED');
  const row = (await client.query(`SELECT * FROM magento_binding_revisions WHERE installation_key=$1 AND state='published'
    ORDER BY version_number DESC LIMIT 1`, [activation.installation_key])).rows[0];
  if (!row || row.origin_hash !== c.originHash(config.baseUrl)) fail('HISTORICAL_BINDING_REQUIRED');
  await assertActorStillAuthorized(client, Number(activation.actor_user_id), 'export_templates.publish', c.error, { readOnly: true });
  return { activation, row, fingerprint: c.hash(lifecycle.clean(row)) };
}
function signReview(actor, review, secret) {
  return createHmac('sha256', secret).update(`${FORMAT}:${actor}:${c.hash(review)}`).digest('hex');
}
function verifyReview(actor, review, token, secret, now = Date.now()) {
  const expires = Date.parse(review.reviewExpiresAt);
  if (!Number.isFinite(expires) || expires <= now || expires > now + TTL || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail('HISTORICAL_REVIEW_STALE');
  if (!timingSafeEqual(Buffer.from(signReview(actor, review, secret)), Buffer.from(token))) fail('HISTORICAL_REVIEW_STALE');
}
function receipt(row) {
  return { intentId: row.id, productId: Number(row.product_id), article: row.public_sku,
    state: row.state, reasonCode: row.reason_code || null, targetStatus: 2,
    hiddenVerifiedAt: row.hidden_verified_at || null, localActivatedAt: row.local_activated_at || null,
    nativeConfirmedAt: row.native_confirmed_at || null };
}
module.exports = { FORMAT, TTL, PERMISSIONS, fail, authority, normalizeSkus, remoteFingerprint, remoteMatches, localIssue, currentBinding,
  signReview, verifyReview, receipt, fingerprint: lifecycle.fingerprint, clean: lifecycle.clean };
