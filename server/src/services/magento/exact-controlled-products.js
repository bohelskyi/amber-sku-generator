const c = require('./binding-contract');

const HARD_BLOCKERS = new Set(['PRODUCT_NOT_CURRENT_OR_EXCLUDED', 'PRODUCT_NOT_UNIQUE',
  'RECONCILIATION_REQUIRED', 'CATEGORY_SCOPE_MISMATCH']);

function parseSkus(query) {
  if (['after', 'search', 'productId'].some(key => query[key] !== undefined)
    || typeof query.skus !== 'string' || query.skus.length > 11000) c.invalid();
  let skus;
  try { skus = JSON.parse(query.skus); } catch { c.invalid(); }
  if (!Array.isArray(skus) || !skus.length || skus.length > 100
    || skus.some(sku => typeof sku !== 'string' || !sku.trim() || sku.length > 100
      || /[\u0000-\u001f\u007f]/.test(sku))) c.invalid();
  return skus.map(sku => sku.trim());
}

// Exact public identities only. A substring page cannot prove an SKU is absent.
// Aggregate each identity in SQL so even long correction histories are bounded.
async function resolve(client, revision, query, inspect, config) {
  const skus = parseSkus(query), unique = [...new Set(skus)];
  const rows = (await client.query(`SELECT i.public_sku AS sku,
    count(p.id) FILTER (WHERE p.status='active' AND p.corrected_to_product_id IS NULL)::int AS current_count,
    min(p.id) FILTER (WHERE p.status='active' AND p.corrected_to_product_id IS NULL) AS product_id,
    bool_or(p.exclude_from_export<>0) FILTER (WHERE p.status='active' AND p.corrected_to_product_id IS NULL) AS excluded,
    min(p.category) FILTER (WHERE p.status='active' AND p.corrected_to_product_id IS NULL) AS category,
    EXISTS(SELECT 1 FROM magento_test_deletions d WHERE d.public_product_identity_id=i.id) AS deleted
    FROM public_product_identities i LEFT JOIN products p ON p.public_product_identity_id=i.id
    WHERE i.public_sku=ANY($1::text[]) GROUP BY i.id,i.public_sku ORDER BY i.public_sku`, [unique])).rows;
  const identities = new Map(rows.map(row => [row.sku, row]));
  const candidates = rows.filter(row => row.current_count === 1 && !row.excluded && !row.deleted
    && (!query.categoryCode || row.category === query.categoryCode));
  const report = { products: [], blockers: [] };
  for (const row of candidates) {
    try {
      const item = await inspect(client, config, { bindingRevisionId: revision.id,
        expectedRevision: revision.revision, kind: 'name_rule', productIds: [row.product_id] });
      report.products.push(...item.products); report.blockers.push(...item.blockers);
    } catch (cause) {
      if (cause.code !== 'MAGENTO_PREVIEW_PRODUCT_NOT_UNIQUE') throw cause;
      report.blockers.push({productId: row.product_id, code: 'PRODUCT_NOT_UNIQUE'});
    }
  }
  const products = report.products.map(product => ({ productId: product.productId, article: product.article,
    before: product.before, after: product.after, changed: product.changed,
    blockers: report.blockers.filter(item => item.productId === product.productId).map(item => item.code) }));
  const bySku = new Map(products.map(product => [product.article, product]));
  const seen = new Set();
  const results = skus.map(sku => {
    if (seen.has(sku)) return { sku, state: 'duplicate', blockers: ['DUPLICATE_SKU_INPUT'] };
    seen.add(sku);
    const row = identities.get(sku);
    if (!row) return { sku, state: 'missing', blockers: [] };
    if (row.current_count !== 1) return { sku, state: 'blocked', blockers: [row.current_count > 1
      ? 'PRODUCT_NOT_UNIQUE' : 'PRODUCT_NOT_CURRENT_OR_EXCLUDED'] };
    const productId = row.product_id;
    if (row.excluded || row.deleted) return { sku, productId, state: 'blocked', blockers: ['PRODUCT_NOT_CURRENT_OR_EXCLUDED'] };
    if (query.categoryCode && row.category !== query.categoryCode) return { sku, productId, state: 'blocked', blockers: ['CATEGORY_SCOPE_MISMATCH'] };
    const candidate = bySku.get(sku);
    if (!candidate) return { sku, productId, state: 'blocked', blockers: report.blockers.filter(item => item.productId === productId).map(item => item.code) };
    return { sku, productId, state: candidate.blockers.some(code => HARD_BLOCKERS.has(code)) ? 'blocked' : 'eligible',
      blockers: candidate.blockers };
  });
  return { products, results, nextCursor: null };
}

module.exports = { parseSkus, resolve };
