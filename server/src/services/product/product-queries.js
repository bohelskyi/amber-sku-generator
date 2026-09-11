async function getProductBySku(queryable, fullSku) {
  const result = await queryable.query(
    'SELECT id, full_sku, created_at FROM products WHERE full_sku = $1 ORDER BY id ASC LIMIT 1',
    [String(fullSku || '').trim().toUpperCase()]
  );

  return result.rows[0] || null;
}

async function getRecentProducts(queryable) {
  const result = await queryable.query(
    `SELECT *
     FROM products
     WHERE COALESCE(status, 'active') <> 'archived'
     ORDER BY created_at DESC
     LIMIT 15`,
    []
  );

  return result.rows;
}

module.exports = {
  getProductBySku,
  getRecentProducts,
};
