async function getProductBySku(queryable, fullSku) {
  return (await require('./public-identity').resolveProductLookup(queryable, fullSku)).product;
}

async function getRecentProducts(queryable) {
  const result = await queryable.query(
    `SELECT p.*, i.public_sku
     FROM products p
     JOIN public_product_identities i ON i.id=p.public_product_identity_id
     WHERE COALESCE(status, 'active') NOT IN ('archived','voided')
     ORDER BY p.created_at DESC
     LIMIT 15`,
    []
  );

  return result.rows;
}

module.exports = {
  getProductBySku,
  getRecentProducts,
};
