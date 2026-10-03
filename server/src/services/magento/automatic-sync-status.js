const reasons = Object.freeze({
  data_or_binding: 'Перевірте дані товару та опубліковані відповідності Magento.',
  reconciliation_required: 'Результат попередньої операції потребує перевірки адміністратором.',
  authorization: 'Потрібно перевірити доступ службового користувача.',
  configuration: 'Потрібно перевірити налаштування синхронізації.',
  product_retired: 'Товар архівовано або замінено. Потрібна перевірка адміністратором.',
  unexpected_failure: 'Синхронізація потребує перевірки адміністратором.',
});
const { presentProblems } = require('./sync-problems');
function presentStatus(row) {
  if (!row) return { state: 'not_tracked', reason: null };
  if (row.deletion_state && row.deletion_state !== 'finalized') return { state: 'needs_attention',
    reason: 'Тестове видалення очікує підтвердження. Адміністратор може перевірити результат у дії «Видалити тестовий товар».' };
  const problems = row.state === 'needs_attention'
    && !['reconciliation_required', 'TEST_DELETION_PENDING'].includes(row.reason_code)
    && Array.isArray(row.diagnostics)
    ? presentProblems(row.diagnostics)
    : [];
  return { state: row.state || 'not_tracked', reason: row.state === 'needs_attention' ? reasons[row.reason_code] || reasons.unexpected_failure : null,
    ...(problems.length ? { problems } : {}) };
}
async function readStatuses(db, productIds) {
  const rows = (await db.query(`SELECT p.id AS product_id,r.state,r.reason_code,r.diagnostics,d.state AS deletion_state
    FROM products p LEFT JOIN magento_product_sync_requests r ON r.product_id=p.id
    LEFT JOIN magento_test_deletions d ON d.product_id=p.id
    WHERE p.id=ANY($1::int[])`, [productIds])).rows;
  const byId = new Map(rows.map((r) => [Number(r.product_id), r]));
  return new Map(productIds.map((id) => [id, presentStatus(byId.get(id))]));
}
module.exports = { presentStatus, readStatuses };
