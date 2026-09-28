// Deliberately separate from both normal export streams: only authoritative stored facts.
// The caller owns a coherent read-only transaction. No eligibility, repair or pricing logic.
async function loadDraftPreviewProducts(client, productIds) {
  const result = await client.query(`
    SELECT p.id, p.full_sku, i.public_sku, p.category, p.weight, p.total_price_uah, p.details,
           magento_name_subject_ua, magento_name_subject_en, magento_name_review_required, sku_schema_version_id
    FROM products p JOIN public_product_identities i ON i.id=p.public_product_identity_id
    WHERE p.id = ANY($1::integer[]) ORDER BY p.id`, [productIds]);
  const found = new Set(result.rows.map((row) => Number(row.id)));
  return { products: result.rows, missingProductIds: productIds.filter((id) => !found.has(id)) };
}

module.exports = { loadDraftPreviewProducts };
