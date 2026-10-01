const reasons = Object.freeze({
  data_or_binding: 'Перевірте дані товару та опубліковані відповідності Magento.',
  reconciliation_required: 'Результат попередньої операції потребує перевірки адміністратором.',
  authorization: 'Потрібно перевірити доступ службового користувача.',
  configuration: 'Потрібно перевірити налаштування синхронізації.',
  product_retired: 'Товар архівовано або замінено. Потрібна перевірка адміністратором.',
  unexpected_failure: 'Синхронізація потребує перевірки адміністратором.',
});
function presentStatus(row) {
  if (!row) return { state: 'not_tracked', reason: null };
  return { state: row.state, reason: row.state === 'needs_attention' ? reasons[row.reason_code] || reasons.unexpected_failure : null };
}
async function readStatuses(db, productIds) {
  const rows = (await db.query('SELECT product_id,state,reason_code FROM magento_product_sync_requests WHERE product_id=ANY($1::int[])', [productIds])).rows;
  const byId = new Map(rows.map((r) => [Number(r.product_id), r]));
  return new Map(productIds.map((id) => [id, presentStatus(byId.get(id))]));
}
module.exports = { presentStatus, readStatuses };
