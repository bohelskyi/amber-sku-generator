// Deliberately separate from both normal export streams: only authoritative stored facts.
// The caller owns a coherent read-only transaction. No eligibility, repair or pricing logic.
async function loadDraftPreviewProducts(client, productIds) {
  const result = await client.query(`
    SELECT id, full_sku, category, weight, total_price_uah, details,
           magento_name_subject_ua, magento_name_subject_en, magento_name_review_required, sku_schema_version_id
    FROM products WHERE id = ANY($1::integer[]) ORDER BY id`, [productIds]);
  const found = new Set(result.rows.map((row) => Number(row.id)));
  return { products: result.rows, missingProductIds: productIds.filter((id) => !found.has(id)) };
}

module.exports = { loadDraftPreviewProducts };
