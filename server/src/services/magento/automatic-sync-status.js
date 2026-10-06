const reasons = Object.freeze({
  data_or_binding: 'Перевірте дані товару та опубліковані відповідності Magento.',
  reconciliation_required: 'Результат попередньої операції потребує перевірки адміністратором.',
  authorization: 'Потрібно перевірити доступ службового користувача.',
  configuration: 'Потрібно перевірити налаштування синхронізації.',
  product_retired: 'Товар архівовано або замінено. Потрібна перевірка адміністратором.',
  unexpected_failure: 'Синхронізація потребує перевірки адміністратором.',
});
const { presentProblems } = require('./sync-problems');
const { lifecycleProjectionSql } = require('./lifecycle-issue');
function presentStatus(row) {
  if (!row) return { state: 'not_tracked', reason: null };
  if (row.deletion_state && row.deletion_state !== 'finalized') return { state: 'needs_attention',
    reason: 'Тестове видалення очікує підтвердження. Адміністратор може перевірити результат у дії «Видалити тестовий товар».' };
  const problems = row.state === 'needs_attention'
    && !['reconciliation_required', 'TEST_DELETION_PENDING'].includes(row.reason_code)
    && Array.isArray(row.diagnostics)
    ? presentProblems(row.diagnostics, row.lifecycle)
    : [];
  const lifecycleProblem = problems.find((problem) => problem.resolution === 'lifecycle_reconciliation');
  return { state: row.state || 'not_tracked', reason: row.state === 'needs_attention' ? lifecycleProblem?.message || problems[0]?.message || reasons[row.reason_code] || reasons.unexpected_failure : null,
    ...(row.state === 'synced' && row.confirmed_at ? { confirmedAt: row.confirmed_at } : {}),
    ...(problems.length ? { problems } : {}) };
}
async function readStatuses(db, productIds) {
  const rows = (await db.query(`SELECT p.id AS product_id,r.state,r.reason_code,r.diagnostics,d.state AS deletion_state,CASE WHEN r.state='synced' AND r.public_product_identity_id=p.public_product_identity_id THEN (SELECT max(j.acknowledged_at) FROM magento_sync_jobs j
      WHERE j.product_id=p.id AND j.public_product_identity_id=p.public_product_identity_id
        AND j.automatic_generation=r.desired_generation AND j.state='succeeded'
        AND j.origin_hash=(SELECT b.origin_hash FROM magento_binding_revisions b
          JOIN magento_auto_sync_activation a ON a.installation_key=b.installation_key AND a.singleton
          WHERE b.state='published' ORDER BY b.version_number DESC LIMIT 1)) END AS confirmed_at,${lifecycleProjectionSql}
    FROM products p LEFT JOIN magento_product_sync_requests r ON r.product_id=p.id
    LEFT JOIN product_full_export_state f ON f.product_id=p.id
    LEFT JOIN magento_test_deletions d ON d.product_id=p.id
    WHERE p.id=ANY($1::int[])`, [productIds])).rows;
  const byId = new Map(rows.map((r) => [Number(r.product_id), r]));
  return new Map(productIds.map((id) => [id, presentStatus(byId.get(id))]));
}
module.exports = { presentStatus, readStatuses };
