const pool = require('../src/db/pool');

async function auditDataIntegrity() {
  const summaryResult = await pool.query(`
    SELECT
      count(*)::int AS product_count,
      count(DISTINCT UPPER(TRIM(full_sku)))::int AS distinct_sku_count,
      (
        count(*) FILTER (WHERE full_sku IS NOT NULL AND TRIM(full_sku) <> '')
        - count(DISTINCT UPPER(TRIM(full_sku)))
      )::int AS duplicate_rows,
      count(*) FILTER (WHERE full_sku IS NULL OR TRIM(full_sku) = '')::int AS missing_skus,
      count(*) FILTER (WHERE total_price_uah IS NULL)::int AS missing_uah_prices,
      count(*) FILTER (WHERE COALESCE(status, 'active') = 'archived')::int AS archived_products
    FROM products
  `);
  const duplicateGroupsResult = await pool.query(`
    SELECT
      UPPER(TRIM(full_sku)) AS full_sku,
      count(*)::int AS copies,
      array_agg(id ORDER BY id) AS product_ids,
      array_agg(total_price_uah ORDER BY id) AS prices_uah,
      array_agg(weight ORDER BY id) AS weights
    FROM products
    WHERE full_sku IS NOT NULL AND TRIM(full_sku) <> ''
    GROUP BY UPPER(TRIM(full_sku))
    HAVING count(*) > 1
    ORDER BY copies DESC, full_sku
  `);
  const missingPricesResult = await pool.query(`
    SELECT
      category,
      count(*)::int AS products,
      count(*) FILTER (WHERE uah_rate IS NOT NULL)::int AS with_saved_rate,
      MIN(created_at) AS first_created_at,
      MAX(created_at) AS last_created_at
    FROM products
    WHERE total_price_uah IS NULL
    GROUP BY category
    ORDER BY category
  `);

  return {
    generatedAt: new Date().toISOString(),
    summary: summaryResult.rows[0],
    duplicateGroups: duplicateGroupsResult.rows,
    missingUahPricesByCategory: missingPricesResult.rows,
  };
}

async function main() {
  try {
    const report = await auditDataIntegrity();
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log('Data integrity summary');
    console.table([report.summary]);
    console.log('Duplicate SKU groups');
    console.table(report.duplicateGroups);
    console.log('Products without UAH price');
    console.table(report.missingUahPricesByCategory);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`Data integrity audit failed: ${err.message || err}`);
  process.exitCode = 1;
});
