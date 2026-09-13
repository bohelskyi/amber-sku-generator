function normalizeHistoryFilters(filters = {}) {
  const categoryCode = String(filters.category || '').trim().toUpperCase().slice(0, 12);
  const search = String(filters.search || '').trim().slice(0, 120);
  const from = String(filters.from || '').trim();
  const to = String(filters.to || '').trim();
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (from && !datePattern.test(from)) {
    const error = new Error('Некоректна початкова дата.');
    error.statusCode = 400;
    throw error;
  }
  if (to && !datePattern.test(to)) {
    const error = new Error('Некоректна кінцева дата.');
    error.statusCode = 400;
    throw error;
  }
  if (from && to && from > to) {
    const error = new Error('Початкова дата не може бути пізніше кінцевої.');
    error.statusCode = 400;
    throw error;
  }
  return { categoryCode, search, from, to };
}

function buildHistoryWhere(filters) {
  const values = [];
  const where = [];
  const categoryExpression = `COALESCE(
    NULLIF(pc.new_payload ->> 'categoryCode', ''),
    cp.category,
    sp.category,
    ''
  )`;

  if (filters.categoryCode) {
    values.push(filters.categoryCode);
    where.push(`${categoryExpression} = $${values.length}`);
  }
  if (filters.search) {
    values.push(`%${filters.search}%`);
    where.push(`(
      pc.source_sku ILIKE $${values.length}
      OR pc.corrected_sku ILIKE $${values.length}
      OR COALESCE(pc.reason, '') ILIKE $${values.length}
    )`);
  }
  if (filters.from) {
    values.push(filters.from);
    where.push(`pc.created_at >= $${values.length}::date`);
  }
  if (filters.to) {
    values.push(filters.to);
    where.push(`pc.created_at < ($${values.length}::date + INTERVAL '1 day')`);
  }

  return {
    categoryExpression,
    values,
    sql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
  };
}

module.exports = {
  buildHistoryWhere,
  normalizeHistoryFilters,
};
