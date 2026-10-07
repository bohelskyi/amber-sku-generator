const c = require('./binding-contract');
const s = require('../historical-reactivation-state');
const lifecycle = require('../product-lifecycle-state');

const stale = () => { throw c.error(409, 'MAGENTO_NAME_PREVIEW_STALE', 'Товар, назви або перевірка змінилися. Перевірте назви ще раз.'); };
const actor = options => Number(options.mutationContext?.actorUserId || options.actorUserId);
function selection(input) {
  c.command(input, ['productId', 'choice', 'intent', 'article', 'remoteProductId', 'bindingRevisionId'], ['previewToken', 'reviewExpiresAt']);
  if (input.choice !== 'magento' || input.intent !== 'historical' || typeof input.article !== 'string' || !input.article.trim()
    || !Number.isSafeInteger(input.remoteProductId) || input.remoteProductId <= 0) {
    throw c.error(422, 'MAGENTO_NAME_SELECTION_INVALID', 'Для архівованого товару можна прийняти лише перевірені назви точного відповідника Magento.');
  }
  c.identity(input.bindingRevisionId);
}
async function context(db, amber, input, config, options, { lock = false } = {}) {
  await require('../access-admin-transaction').assertActorStillAuthorized(db, actor(options), 'exports.create', c.error, { readOnly: !lock });
  await s.authority(db, actor(options), !lock);
  const published = await s.currentBinding(db, config);
  if (published.row.id !== input.bindingRevisionId || amber.revision?.id !== input.bindingRevisionId
    || amber.product.public_sku !== input.article) {
    throw c.error(409, 'MAGENTO_NAME_HISTORICAL_CONTEXT_CHANGED', 'Артикул або чинні правила змінилися. Повторіть перевірку відновлення.');
  }
  const target = await lifecycle.readTarget(db, Number(amber.product.id), { origin: c.originHash(config.baseUrl), lock });
  const issue = s.localIssue(target);
  if (issue) throw c.error(409, issue, 'Архівований товар має іншу версію, незавершену доставку або інше блокування. Повторіть перевірку відновлення.');
  if (c.hash(target.product) !== c.hash(Object.fromEntries(Object.keys(target.product).map(key => [key, amber.product[key]])))) stale();
  const pending = (await db.query(`SELECT
    EXISTS(SELECT 1 FROM historical_reactivation_intents WHERE public_product_identity_id=$1) OR
    EXISTS(SELECT 1 FROM historical_standard_intents WHERE public_product_identity_id=$1 AND state NOT IN ('completed','cancelled')) AS pending`,
  [target.product.public_product_identity_id])).rows[0].pending;
  if (pending) throw c.error(409, 'HISTORICAL_INTENT_EXISTS', 'Спочатку завершіть перевірку вже зареєстрованого відновлення.');
  const request = (await db.query(`SELECT product_id,desired_generation,active_job_id,active_generation,reason_code
    FROM magento_product_sync_requests WHERE public_product_identity_id=$1${lock ? ' FOR UPDATE' : ''}`,
  [target.product.public_product_identity_id])).rows[0] || null;
  if (request?.reason_code === 'reconciliation_required') {
    throw c.error(409, 'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED', 'Попередню надіслану зміну ще не підтверджено. Прийняття назви не скасовує перевірку доставки.');
  }
  if (request && Number(request.product_id) !== Number(target.product.id)) stale();
  return { fingerprint: c.hash({ local: lifecycle.fingerprint(target.product, target.lifecycle), facts: target.facts,
    binding: published.fingerprint, request }), confirmedRemoteId: target.facts.confirmedRemoteId };
}
function assertRemote(input, current, raw) {
  if (raw?.sku !== input.article || raw?.id !== input.remoteProductId
    || current.confirmedRemoteId != null && Number(current.confirmedRemoteId) !== raw.id) {
    throw c.error(409, 'MAGENTO_NAME_IDENTITY_CHANGED', 'Артикул або Magento ID не збігається з перевіреним відповідником.');
  }
}
function applyOptions(input, options) {
  const now = (options.now || Date.now)(), expires = Date.parse(input.reviewExpiresAt);
  if (!Number.isFinite(expires) || expires <= now || expires > now + s.TTL) stale();
  return { ...options, historicalExpiresAt: input.reviewExpiresAt };
}
function review(evidence, current, options) {
  if (options.historicalExpiresAt) applyOptions({ reviewExpiresAt: options.historicalExpiresAt }, options);
  const reviewExpiresAt = options.historicalExpiresAt || new Date((options.now || Date.now)() + s.TTL).toISOString();
  const secret = options.reviewSecret || require('../../config/env').sessionSecret;
  return { reviewExpiresAt, previewToken: s.signReview(actor(options), { ...evidence, intent: 'historical',
    historicalFingerprint: current.fingerprint, reviewExpiresAt }, secret) };
}
async function keepRetired(client, product) {
  // The normal input trigger may record this local name generation. It must not
  // become pending ordinary delivery while participation remains archived.
  await client.query(`UPDATE magento_product_sync_requests SET state='needs_attention',reason_code='product_retired'
    WHERE public_product_identity_id=$1 AND product_id=$2 AND reason_code IS DISTINCT FROM 'reconciliation_required'`,
  [product.public_product_identity_id, product.id]);
}
module.exports = { actor, selection, context, assertRemote, applyOptions, review, keepRetired };
