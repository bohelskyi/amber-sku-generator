'use strict';

const fail = code => { throw Object.assign(Error(code), { code, statusCode: 422 }); };
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const productId = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const compare = (a, b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0;

function validateSkus(skus, { limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Array.isArray(skus)
    || !skus.length || skus.length > limit || Object.keys(skus).length !== skus.length
    || skus.some(sku => typeof sku !== 'string' || !sku.length || sku.length > 255
      || sku.trim() !== sku || /[\u0000-\u001f\u007f]/.test(sku))) fail('OPERATOR_SCOPE_INVALID');
  if (new Set(skus).size !== skus.length) fail('OPERATOR_SCOPE_DUPLICATE_SKU');
  return [...skus];
}

function validateItems(items, options) {
  if (!Array.isArray(items) || items.some(item => !plain(item)
    || Object.keys(item).length !== 2 || !Object.hasOwn(item, 'sku') || !Object.hasOwn(item, 'productId')
    || !productId(item.productId))) fail('OPERATOR_SCOPE_INVALID');
  validateSkus(items.map(item => item.sku), options);
  if (new Set(items.map(item => item.productId)).size !== items.length) fail('OPERATOR_SCOPE_DUPLICATE_PRODUCT');
  return items.map(item => ({ sku: item.sku, productId: item.productId })).sort(compare);
}

async function resolveSkus(databasePool, skus, options) {
  const requested = validateSkus(skus, options);
  const { rows } = await databasePool.query(`SELECT i.public_sku AS sku,
    count(p.id) FILTER (WHERE p.status='active' AND p.corrected_to_product_id IS NULL)::int AS current_count,
    min(p.id) FILTER (WHERE p.status='active' AND p.corrected_to_product_id IS NULL) AS product_id
    FROM public_product_identities i LEFT JOIN products p ON p.public_product_identity_id=i.id
    WHERE i.public_sku=ANY($1::text[]) GROUP BY i.id,i.public_sku ORDER BY i.public_sku`, [requested]);
  const bySku = new Map();
  for (const row of rows) {
    if (bySku.has(row.sku)) fail('OPERATOR_SCOPE_PRODUCT_AMBIGUOUS');
    bySku.set(row.sku, row);
  }
  const items = requested.map(sku => {
    const row = bySku.get(sku);
    if (!row) fail('OPERATOR_SCOPE_MISSING_SKU');
    if (row.current_count === 0) fail('OPERATOR_SCOPE_PRODUCT_NOT_CURRENT');
    if (row.current_count > 1) fail('OPERATOR_SCOPE_PRODUCT_AMBIGUOUS');
    if (row.current_count !== 1 || !productId(row.product_id)) fail('OPERATOR_SCOPE_INVALID');
    return { sku, productId: row.product_id };
  });
  return validateItems(items, options);
}

async function assertItems(databasePool, items, options) {
  const expected = validateItems(items, options);
  const current = await resolveSkus(databasePool, expected.map(item => item.sku), options);
  if (current.some((item, index) => item.productId !== expected[index].productId)) fail('OPERATOR_SCOPE_ITEM_MISMATCH');
  return current;
}

module.exports = { validateSkus, validateItems, resolveSkus, assertItems };
