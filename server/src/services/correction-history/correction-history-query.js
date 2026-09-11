const pool = require('../../db/pool');
const { buildHistoryWhere } = require('./correction-history-filters');

async function loadCorrectionHistoryReport(filters, pagination, database = pool) {
  const { forExport, limit, offset } = pagination;
  const where = buildHistoryWhere(filters);
  const values = [...where.values];
  let paginationSql = '';
  if (!forExport) {
    values.push(limit, offset);
    paginationSql = `LIMIT $${values.length - 1} OFFSET $${values.length}`;
  }

  const [itemsResult, summaryResult, categoriesResult] = await Promise.all([
    database.query(
      `SELECT pc.*, ${where.categoryExpression} AS category_code
       FROM product_corrections pc
       LEFT JOIN products sp ON sp.id = pc.source_product_id
       LEFT JOIN products cp ON cp.id = pc.corrected_product_id
       ${where.sql}
       ORDER BY pc.created_at DESC, pc.id DESC
       ${paginationSql}`,
      values
    ),
    database.query(
      `SELECT
         COUNT(*)::int AS total_count,
         COUNT(*) FILTER (WHERE pc.price_delta_uah > 0)::int AS increased_count,
         COUNT(*) FILTER (WHERE pc.price_delta_uah < 0)::int AS decreased_count,
         COUNT(*) FILTER (WHERE COALESCE(pc.price_delta_uah, 0) = 0)::int AS unchanged_count,
         COALESCE(SUM(pc.price_delta_uah), 0)::numeric AS net_price_delta_uah,
         MIN(pc.created_at) AS first_at,
         MAX(pc.created_at) AS last_at
       FROM product_corrections pc
       LEFT JOIN products sp ON sp.id = pc.source_product_id
       LEFT JOIN products cp ON cp.id = pc.corrected_product_id
       ${where.sql}`,
      where.values
    ),
    database.query(
      `SELECT ${where.categoryExpression} AS category_code, COUNT(*)::int AS count
       FROM product_corrections pc
       LEFT JOIN products sp ON sp.id = pc.source_product_id
       LEFT JOIN products cp ON cp.id = pc.corrected_product_id
       GROUP BY ${where.categoryExpression}
       ORDER BY category_code`
    ),
  ]);

  return {
    itemRows: itemsResult.rows,
    summaryRow: summaryResult.rows[0],
    categoryRows: categoriesResult.rows,
  };
}

module.exports = {
  loadCorrectionHistoryReport,
};
