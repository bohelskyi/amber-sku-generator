const access = require('../access-admin-transaction');
const { PublicHttpError } = require('../../http/errors');
const failure = (statusCode, code, message) => new PublicHttpError(statusCode, message, { code });
function normalizeFlag(payload = {}) {
  if (payload.isTestProduct !== undefined && typeof payload.isTestProduct !== 'boolean') {
    throw failure(422, 'TEST_PRODUCT_FLAG_INVALID', 'Ознака TEST має бути логічним значенням.');
  }
  if (payload.isTestProduct === true && payload.enableWhenPhotosVerified === true) {
    throw failure(422, 'TEST_PRODUCT_ENABLE_FORBIDDEN', 'TEST товар залишається вимкненим у Magento.');
  }
  return payload.isTestProduct === true;
}
async function assertAdministrator(client, actorUserId, { readOnly = false } = {}) {
  if (!Number.isSafeInteger(actorUserId) || actorUserId <= 0) throw failure(403, 'TEST_PRODUCT_ADMINISTRATOR_REQUIRED', 'TEST товари створює тільки Адміністратор.');
  await access.assertActorStillAuthorized(client, actorUserId, 'products.create', failure, { readOnly });
  const admin = (await client.query(`SELECT 1 FROM application_users u
    JOIN user_role_assignments a ON a.application_user_id=u.id JOIN roles r ON r.id=a.role_id
    WHERE u.id=$1 AND u.status='active' AND a.revoked_at IS NULL
      AND r.status='active' AND r.role_key='administrator' AND r.is_system=TRUE`, [actorUserId])).rowCount;
  if (!admin) throw failure(403, 'TEST_PRODUCT_ADMINISTRATOR_REQUIRED', 'TEST товари створює тільки Адміністратор.');
}
async function assertNamespaceAvailable(client) {
  const available = (await client.query(`SELECT
    to_regclass('test_product_sku_sequence') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public_product_identities')
      AND attname='is_test_product' AND NOT attisdropped)
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public_product_identities')
      AND attname='test_allocation_number' AND NOT attisdropped) AS available`)).rows[0]?.available;
  if (available !== true) throw failure(409, 'TEST_PRODUCT_NAMESPACE_UNAVAILABLE',
    'TEST товари ще недоступні. Адміністратор має завершити оновлення застосунку.');
}
function assertDisabled(product, raw, enable = false) {
  if (product?.is_test_product !== true) return;
  if (enable === true) throw failure(422, 'TEST_PRODUCT_ENABLE_FORBIDDEN', 'TEST товар залишається вимкненим у Magento.');
  if (raw && raw.status !== 2) throw failure(409, 'TEST_PRODUCT_REMOTE_ENABLED', 'TEST товар увімкнено поза Amber. Передавання заблоковано; потрібна окрема перевірка.');
}
function projection(product) {
  return { isTestProduct: product?.is_test_product === true,
    ...(product?.is_test_product === true ? { testTargetStatus: 2 } : {}) };
}
module.exports = { normalizeFlag, assertAdministrator, assertNamespaceAvailable, assertDisabled, projection };
