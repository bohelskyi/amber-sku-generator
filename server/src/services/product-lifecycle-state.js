const c = require('./magento/binding-contract');

const fail = (code, message = 'Стан товару змінився. Повторіть перевірку відновлення.') => {
  if (code === 'PRODUCT_MEDIA_RECONCILIATION_REQUIRED') {
    message = 'Спочатку завершіть або перевірте передавання фото у товарі. Архівування та відновлення недоступні, доки результат передавання не підтверджено.';
  }
  throw c.error(409, code, message);
};
const clean = (value) => JSON.parse(JSON.stringify(value));
function fingerprint(product, lifecycle) { return c.hash(clean({ product, lifecycle })); }
function inputSkus(input) {
  c.command(input, ['skus']);
  if (!Array.isArray(input.skus) || !input.skus.length || input.skus.length > 100) {
    throw c.error(422, 'PRODUCT_RESTORE_SELECTION_INVALID', 'Вкажіть від 1 до 100 артикулів.');
  }
  const skus = [];
  for (const raw of input.skus) {
    if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 256 || /[\u0000-\u001f\u007f]/.test(raw)) {
      throw c.error(422, 'PRODUCT_RESTORE_SELECTION_INVALID', 'Артикул має бути точним непорожнім текстом.');
    }
    const sku = raw.trim().toUpperCase();
    if (!skus.includes(sku)) skus.push(sku);
  }
  return skus;
}
function currentArchived(product, lifecycle, facts) {
  if (product.status !== 'archived') return product.status === 'active' ? 'PRODUCT_ALREADY_ACTIVE' : 'PRODUCT_NOT_ARCHIVED';
  if (!lifecycle || lifecycle.route !== 'retired') return 'PRODUCT_ARCHIVE_LIFECYCLE_MISSING';
  if (product.corrected_to_product_id != null || facts.newerRevision || facts.activeSuccessor || facts.correctionSource) return 'PRODUCT_RETIRED_ANCESTOR';
  if (facts.testDeletion) return 'PRODUCT_TEST_DELETION_FROZEN';
  if (facts.unfinishedMedia) return 'PRODUCT_MEDIA_RECONCILIATION_REQUIRED';
  if (facts.unfinishedJob || facts.unresolvedStep) return 'PRODUCT_SYNC_RECONCILIATION_REQUIRED';
  return null;
}
function restoreProof(product, lifecycle, facts, hide) {
  const currentIssue = currentArchived(product, lifecycle, facts);
  if (currentIssue) return { eligible: false, reasonCode: currentIssue };
  if (!hide || hide.kind !== 'hide' || Number(hide.product_id) !== Number(product.id)) {
    return { eligible: false, reasonCode: 'PRODUCT_ARCHIVE_PROOF_MISSING' };
  }
  const before = hide.previous_product, old = hide.previous_lifecycle;
  if (!before || !old || before.status !== 'active' || before.corrected_to_product_id != null
    || String(before.public_product_identity_id) !== String(product.public_product_identity_id)) {
    return { eligible: false, reasonCode: 'PRODUCT_ARCHIVE_PROOF_INVALID' };
  }
  if (Number(before.exclude_from_export) !== 0 || old.business_exclusion_state !== 'none'
    || old.recount_compatibility_excluded || old.evidence?.independentExclusion === true) {
    return { eligible: false, reasonCode: 'PRODUCT_OLD_EXCLUSION_RETAINED' };
  }
  if (!['normal', 'replacement'].includes(old.route) || old.hold_reason != null) {
    return { eligible: false, reasonCode: 'PRODUCT_OLD_LIFECYCLE_REVIEW_REQUIRED' };
  }
  if (fingerprint(product, lifecycle) !== hide.local_fingerprint) {
    return { eligible: false, reasonCode: 'PRODUCT_ARCHIVE_CHANGED' };
  }
  if (hide.state === 'dispatched' || facts.unresolvedVisibility) {
    return { eligible: false, reasonCode: 'PRODUCT_VISIBILITY_RECONCILIATION_REQUIRED' };
  }
  if (product.is_test_product === true && hide.previous_remote_status === 1) {
    return { eligible: false, reasonCode: 'TEST_PRODUCT_ENABLE_FORBIDDEN' };
  }
  const remoteId = facts.confirmedRemoteId;
  if (hide.remote_product_id != null && remoteId != null && Number(hide.remote_product_id) !== Number(remoteId)) {
    return { eligible: false, reasonCode: 'PRODUCT_REMOTE_IDENTITY_CHANGED' };
  }
  const ordinaryCreate = old.route === 'normal' && old.evidence?.origin === 'ordinary_save'
    && !old.source_correction_id && !Number(old.confirmed_revision) && !Number(old.cutover_baseline_revision)
    && !Number(old.externally_delivered_revision) && !facts.exported && !facts.correctionHistory && !facts.anyRemoteJob;
  if (remoteId == null && !ordinaryCreate) return { eligible: false, reasonCode: 'PRODUCT_DELIVERY_HISTORY_UNKNOWN' };
  return { eligible: true, reasonCode: null, mode: remoteId == null ? 'create' : 'update',
    visibility: hide.state === 'verified' && [1, 2].includes(hide.previous_remote_status)
      ? { action: 'restore_confirmed_status', status: hide.previous_remote_status, sourceHideId: hide.id }
      : { action: 'preserve', status: null, sourceHideId: null } };
}

async function readTarget(client, productId, { lock = false, origin } = {}) {
  const product = (await client.query(`SELECT p.*,i.public_sku,i.is_test_product FROM products p
    JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1
    ${lock ? 'FOR NO KEY UPDATE OF p' : ''}`, [productId])).rows[0];
  if (!product) fail('PRODUCT_RESTORE_NOT_FOUND');
  // Preserve exact pre-069 lifecycle fingerprints for ordinary historical rows.
  if (product.is_test_product === false) delete product.is_test_product;
  const lifecycle = (await client.query(`SELECT * FROM product_full_export_state WHERE product_id=$1
    ${lock ? 'FOR UPDATE' : ''}`, [productId])).rows[0];
  const facts = (await client.query(`SELECT
    EXISTS(SELECT 1 FROM products p WHERE p.public_product_identity_id=$2 AND p.id>$1) AS "newerRevision",
    EXISTS(SELECT 1 FROM products p WHERE p.public_product_identity_id=$2 AND p.id<>$1 AND p.status='active'
      AND p.corrected_to_product_id IS NULL) AS "activeSuccessor",
    EXISTS(SELECT 1 FROM product_corrections WHERE source_product_id=$1) AS "correctionSource",
    EXISTS(SELECT 1 FROM product_corrections WHERE source_product_id=$1 OR corrected_product_id=$1) AS "correctionHistory",
    EXISTS(SELECT 1 FROM magento_test_deletions WHERE public_product_identity_id=$2) AS "testDeletion",
    EXISTS(SELECT 1 FROM product_media_jobs WHERE public_product_identity_id=$2
      AND state NOT IN ('succeeded','superseded')) AS "unfinishedMedia",
    EXISTS(SELECT 1 FROM magento_sync_jobs WHERE public_product_identity_id=$2 AND origin_hash=$3
      AND state NOT IN ('succeeded','superseded')) AS "unfinishedJob",
    EXISTS(SELECT 1 FROM magento_sync_steps s JOIN magento_sync_jobs j ON j.id=s.job_id
      WHERE j.public_product_identity_id=$2 AND j.origin_hash=$3 AND s.state='dispatched') AS "unresolvedStep",
    EXISTS(SELECT 1 FROM product_visibility_intents WHERE public_product_identity_id=$2 AND origin_hash=$3
      AND state='dispatched') AS "unresolvedVisibility",
    EXISTS(SELECT 1 FROM export_snapshot_products WHERE product_id=$1) AS exported,
    EXISTS(SELECT 1 FROM magento_sync_jobs WHERE public_product_identity_id=$2 AND origin_hash=$3
      AND state<>'superseded') AS "anyRemoteJob",
    (SELECT remote_product_id FROM magento_sync_jobs WHERE public_product_identity_id=$2 AND origin_hash=$3
      AND state='succeeded' AND acknowledged_at IS NOT NULL AND remote_product_id IS NOT NULL
      ORDER BY acknowledged_at DESC,id DESC LIMIT 1) AS "confirmedRemoteId"`,
  [productId, product.public_product_identity_id, origin])).rows[0];
  const hide = (await client.query(`SELECT * FROM product_visibility_intents WHERE product_id=$1 AND kind='hide'
    AND origin_hash=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [productId, origin])).rows[0];
  return { product, lifecycle, facts, hide };
}

module.exports = { clean, fail, fingerprint, inputSkus, currentArchived, restoreProof, readTarget };
