const MAX_SKU_LENGTH = 256;

function normalizeLookup(value) {
  const sku = String(value || '').trim().toUpperCase();
  if (!sku || sku.length > MAX_SKU_LENGTH) {
    throw Object.assign(new Error('Invalid product article'), { statusCode: 400, code: 'INVALID_SKU' });
  }
  return sku;
}

function ambiguous() {
  return Object.assign(new Error('Product article is ambiguous'), {
    statusCode: 409,
    code: 'AMBIGUOUS_PRODUCT_ARTICLE',
  });
}

function clean(row) {
  if (!row) return null;
  const product = { ...row };
  delete product.public_match;
  delete product.internal_match;
  return product;
}

async function resolveProductLookup(queryable, value) {
  const sku = normalizeLookup(value);
  const rows = (await queryable.query(
    `SELECT p.*, i.public_sku,
            (i.public_sku = $1 AND p.status = 'active' AND p.corrected_to_product_id IS NULL) AS public_match,
            (p.full_sku = $1) AS internal_match
     FROM products p
     JOIN public_product_identities i ON i.id = p.public_product_identity_id
     WHERE (i.public_sku = $1 AND p.status = 'active' AND p.corrected_to_product_id IS NULL)
        OR (p.full_sku = $1 AND p.status <> 'voided')
     ORDER BY p.id`,
    [sku]
  )).rows;
  const publicRows = rows.filter((row) => row.public_match === true);
  if (publicRows.length > 1) throw ambiguous();
  if (publicRows.length === 1) {
    const selected = publicRows[0];
    return { product: clean(selected), lookupKind: selected.full_sku === sku ? 'public_and_internal' : 'public', querySku: sku };
  }
  const internalRows = rows.filter((row) => row.internal_match === true);
  return { product: clean(internalRows[0]), lookupKind: internalRows.length ? 'internal' : 'none', querySku: sku,
    internalMatchCount: internalRows.length };
}

function externalSku(product) {
  return String(product?.public_sku || product?.full_sku || '');
}

module.exports = { MAX_SKU_LENGTH, ambiguous, externalSku, normalizeLookup, resolveProductLookup };
