const pool = require('../db/pool');
const crypto = require('node:crypto');
const { getProductBySku } = require('./product.service');
const { buildCsv } = require('../utils/csv');
const { roundUah } = require('../utils/money');

async function getNonSkuQuestionMaps(categoryCodes) {
  if (!categoryCodes || categoryCodes.length === 0) return new Map();

  const result = await pool.query(
    `
      SELECT
        q.category_code,
        q.key,
        q.label AS q_label,
        q.sku_index,
        q.display_order,
        q.input_type,
        o.value_id,
        o.label AS o_label
      FROM questions q
      LEFT JOIN options o ON o.question_id = q.id
      WHERE q.category_code = ANY($1::text[])
        AND COALESCE(q.include_in_sku, 1) = 0
      ORDER BY q.category_code, COALESCE(q.display_order, q.sku_index), q.sku_index, q.id, o.value_id
    `,
    [categoryCodes]
  );

  const categoryMap = new Map();
  for (const row of result.rows) {
    if (!categoryMap.has(row.category_code)) categoryMap.set(row.category_code, new Map());
    const questionMap = categoryMap.get(row.category_code);
    if (!questionMap.has(row.key)) {
      questionMap.set(row.key, {
        key: row.key,
        label: row.q_label,
        input_type: row.input_type || 'options',
        optionLabels: new Map(),
      });
    }
    if (row.value_id !== null && row.value_id !== undefined) {
      questionMap.get(row.key).optionLabels.set(Number(row.value_id), row.o_label);
    }
  }

  return categoryMap;
}

function getExportTextValues(productRow, nonSkuQuestionMaps) {
  const categoryCode = String(productRow.category || '');
  const details = productRow.details && typeof productRow.details === 'object' ? productRow.details : {};
  const answers = details.answers && typeof details.answers === 'object' ? details.answers : {};
  const questionMap = nonSkuQuestionMaps.get(categoryCode);
  if (!questionMap || questionMap.size === 0) return {};

  const values = {};
  for (const question of questionMap.values()) {
    if (question.input_type !== 'text') continue;
    const rawValue = answers[question.key];
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    values[question.key] = String(rawValue);
  }
  return values;
}

function collectExportTextColumns(rows, nonSkuQuestionMaps) {
  const seen = new Set();
  const columns = [];

  for (const row of rows) {
    const categoryCode = String(row.category || '');
    const questionMap = nonSkuQuestionMaps.get(categoryCode);
    if (!questionMap || questionMap.size === 0) continue;

    for (const question of questionMap.values()) {
      if (question.input_type !== 'text') continue;
      if (seen.has(question.key)) continue;
      seen.add(question.key);
      columns.push({
        key: question.key,
        label: question.label || question.key,
      });
    }
  }

  return columns;
}

function getExportSizeValue(productRow, nonSkuQuestionMaps) {
  const categoryCode = String(productRow.category || '');
  if (!['BR', 'NM'].includes(categoryCode)) return '';

  const details = productRow.details && typeof productRow.details === 'object' ? productRow.details : {};
  const answers = details.answers && typeof details.answers === 'object' ? details.answers : {};
  const questionMap = nonSkuQuestionMaps.get(categoryCode);
  if (!questionMap || questionMap.size === 0) return '';

  const allQuestions = Array.from(questionMap.values());
  const sizeQuestions = allQuestions.filter(
    (question) =>
      /size/i.test(String(question.key || '')) ||
      /розмір/i.test(String(question.label || ''))
  );
  const targetQuestions = sizeQuestions.length > 0 ? sizeQuestions : allQuestions;

  const labels = [];
  for (const question of targetQuestions) {
    const rawValue = answers[question.key];
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    const numericValue = Number(rawValue);
    const valueKey = Number.isNaN(numericValue) ? rawValue : numericValue;
    const optionLabel = question.optionLabels.get(valueKey);
    labels.push(optionLabel || String(rawValue));
  }

  return labels.join(' / ');
}

async function getExportRows(fromSku, toSku) {
  const normalizedFromSku = String(fromSku || '').trim().toUpperCase();
  const normalizedToSku = String(toSku || '').trim().toUpperCase();

  if (!normalizedFromSku) {
    throw new Error('Потрібно вказати артикул, з якого починати експорт');
  }

  const fromProduct = await getProductBySku(normalizedFromSku);
  if (!fromProduct) {
    throw new Error(`Артикул ${normalizedFromSku} не знайдено`);
  }

  let toProduct = null;
  if (normalizedToSku) {
    toProduct = await getProductBySku(normalizedToSku);
    if (!toProduct) {
      throw new Error(`Артикул ${normalizedToSku} не знайдено`);
    }
  }

  const idFrom = Number(fromProduct.id);
  const idTo = toProduct ? Number(toProduct.id) : null;
  const startId = idTo !== null ? Math.min(idFrom, idTo) : idFrom;
  const endId = idTo !== null ? Math.max(idFrom, idTo) : null;

  const params = [startId];
  const whereClauses = ['id >= $1', 'COALESCE(exclude_from_export, 0) = 0'];
  if (endId !== null) {
    params.push(endId);
    whereClauses.push(`id <= $${params.length}`);
  }

  const result = await pool.query(
    `
      SELECT id, full_sku, category, total_price_uah, details, created_at
      FROM products
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY id ASC
    `,
    params
  );

  const categoryCodes = Array.from(
    new Set(result.rows.map((row) => String(row.category || '').trim()).filter((code) => code))
  );
  const nonSkuQuestionMaps = await getNonSkuQuestionMaps(categoryCodes);
  const textColumns = collectExportTextColumns(result.rows, nonSkuQuestionMaps);
  const rowsWithSize = result.rows.map((row) => ({
    ...row,
    export_size: getExportSizeValue(row, nonSkuQuestionMaps),
    export_text_values: getExportTextValues(row, nonSkuQuestionMaps),
  }));

  return {
    rows: rowsWithSize,
    textColumns,
    range: {
      fromSku: fromProduct.full_sku,
      toSku: toProduct ? toProduct.full_sku : null,
      resolvedToSku:
        rowsWithSize.length > 0
          ? rowsWithSize[rowsWithSize.length - 1].full_sku
          : fromProduct.full_sku,
    },
  };
}

function buildExportCsv(exportData) {
  const textHeaders = exportData.textColumns.map((column) => column.key);
  return buildCsv([
    ['sku', 'price_uah', 'size', ...textHeaders],
    ...exportData.rows.map((row) => [
      row.full_sku,
      row.total_price_uah !== null && row.total_price_uah !== undefined
        ? roundUah(row.total_price_uah)
        : '',
      row.export_size || '',
      ...exportData.textColumns.map((column) => row.export_text_values?.[column.key] || ''),
    ]),
  ]);
}

async function createExportSnapshot({ fromSku, toSku, idempotencyKey }) {
  const key = String(idempotencyKey || '').trim();
  if (!key || key.length > 200) {
    const error = new Error('Потрібен коректний Idempotency-Key для створення export snapshot.');
    error.statusCode = 400;
    throw error;
  }
  const existing = await pool.query(
    'SELECT * FROM export_snapshots WHERE idempotency_key = $1',
    [key]
  );
  if (existing.rows[0]) return existing.rows[0];

  const exportData = await getExportRows(fromSku, toSku);
  const suffixPart = exportData.range.toSku ? `-${exportData.range.toSku}` : '-to-latest';
  const fileName = `amber-export-${exportData.range.fromSku}${suffixPart}.csv`;
  const exportedToProductId = exportData.rows.length > 0
    ? Number(exportData.rows[exportData.rows.length - 1].id)
    : 0;
  try {
    const result = await pool.query(
      `INSERT INTO export_snapshots
       (id, idempotency_key, from_sku, to_sku, resolved_to_sku,
        exported_to_product_id, row_count, file_name, csv_content)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        crypto.randomUUID(),
        key,
        exportData.range.fromSku,
        exportData.range.toSku,
        exportData.range.resolvedToSku,
        exportedToProductId,
        exportData.rows.length,
        fileName,
        buildExportCsv(exportData),
      ]
    );
    return result.rows[0];
  } catch (error) {
    if (error?.code !== '23505') throw error;
    return (await pool.query(
      'SELECT * FROM export_snapshots WHERE idempotency_key = $1',
      [key]
    )).rows[0];
  }
}

async function getExportSnapshot(snapshotId) {
  const result = await pool.query('SELECT * FROM export_snapshots WHERE id = $1', [snapshotId]);
  if (!result.rows[0]) {
    const error = new Error('Export snapshot не знайдено.');
    error.statusCode = 404;
    throw error;
  }
  return result.rows[0];
}

async function confirmExportSnapshot(snapshotId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const snapshotResult = await client.query(
      'SELECT * FROM export_snapshots WHERE id = $1 FOR UPDATE',
      [snapshotId]
    );
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) {
      const error = new Error('Export snapshot не знайдено.');
      error.statusCode = 404;
      throw error;
    }
    await client.query(
      `UPDATE export_snapshots
       SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP)
       WHERE id = $1`,
      [snapshotId]
    );
    await client.query(
      `INSERT INTO export_state
       (singleton, exported_to_product_id, last_snapshot_id, updated_at)
       VALUES (TRUE, $1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (singleton) DO UPDATE
       SET exported_to_product_id = GREATEST(
             export_state.exported_to_product_id,
             EXCLUDED.exported_to_product_id
           ),
           last_snapshot_id = CASE
             WHEN EXCLUDED.exported_to_product_id >= export_state.exported_to_product_id
             THEN EXCLUDED.last_snapshot_id
             ELSE export_state.last_snapshot_id
           END,
           updated_at = CURRENT_TIMESTAMP`,
      [Number(snapshot.exported_to_product_id), snapshotId]
    );
    await client.query('COMMIT');
    return { success: true, snapshotId, status: 'confirmed' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getExportStatus() {
  const lastExportResult = await pool.query(
    `
      SELECT COALESCE(s.id, 'legacy-' || e.id::text) AS id,
             COALESCE(s.from_sku, e.from_sku) AS from_sku,
             COALESCE(s.to_sku, e.to_sku) AS to_sku,
             COALESCE(s.resolved_to_sku, e.resolved_to_sku) AS resolved_to_sku,
             st.exported_to_product_id,
             COALESCE(s.row_count, e.row_count, 0) AS row_count,
             COALESCE(s.confirmed_at, e.created_at) AS created_at
      FROM export_state st
      LEFT JOIN export_snapshots s ON s.id = st.last_snapshot_id
      LEFT JOIN LATERAL (
        SELECT * FROM export_events
        WHERE exported_to_product_id <= st.exported_to_product_id
        ORDER BY exported_to_product_id DESC, id DESC
        LIMIT 1
      ) e ON TRUE
      WHERE st.singleton = TRUE AND st.exported_to_product_id > 0
      LIMIT 1
    `
  );
  const totalsResult = await pool.query(
    `SELECT
       count(*)::int AS total_count,
       COALESCE(MAX(id), 0)::int AS max_id,
       count(*) FILTER (WHERE COALESCE(exclude_from_export, 0) = 0)::int AS exportable_count,
       COALESCE(MAX(id) FILTER (WHERE COALESCE(exclude_from_export, 0) = 0), 0)::int AS exportable_max_id
     FROM products`
  );

  const totalCount = Number(totalsResult.rows[0]?.total_count || 0);
  const latestProductId = Number(totalsResult.rows[0]?.max_id || 0);
  const exportableCount = Number(totalsResult.rows[0]?.exportable_count || 0);
  const latestExportableProductId = Number(totalsResult.rows[0]?.exportable_max_id || 0);
  if (lastExportResult.rows.length === 0) {
    return {
      hasExport: false,
      totalProducts: totalCount,
      exportableProducts: exportableCount,
      countSinceLastExport: exportableCount,
      latestProductId,
      latestExportableProductId,
      lastExport: null,
    };
  }

  const lastExport = lastExportResult.rows[0];
  const exportedToId = Number(lastExport.exported_to_product_id || 0);
  const sinceResult = await pool.query(
    'SELECT count(*)::int AS count FROM products WHERE id > $1 AND COALESCE(exclude_from_export, 0) = 0',
    [exportedToId]
  );

  return {
    hasExport: true,
    totalProducts: totalCount,
    exportableProducts: exportableCount,
    countSinceLastExport: Number(sinceResult.rows[0]?.count || 0),
    latestProductId,
    latestExportableProductId,
    lastExport: {
      id: String(lastExport.id),
      fromSku: lastExport.from_sku,
      toSku: lastExport.to_sku,
      resolvedToSku: lastExport.resolved_to_sku,
      exportedToProductId: exportedToId,
      rowCount: Number(lastExport.row_count || 0),
      createdAt: lastExport.created_at,
    },
  };
}

async function recordExportEvent(exportData) {
  const exportedToProductId =
    exportData.rows.length > 0 ? Number(exportData.rows[exportData.rows.length - 1].id) : 0;

  await pool.query(
    `
      INSERT INTO export_events (from_sku, to_sku, resolved_to_sku, exported_to_product_id, row_count)
      VALUES ($1, $2, $3, $4, $5)
    `,
    [
      exportData.range.fromSku,
      exportData.range.toSku,
      exportData.range.resolvedToSku,
      exportedToProductId,
      exportData.rows.length,
    ]
  );
}

module.exports = {
  buildExportCsv,
  confirmExportSnapshot,
  createExportSnapshot,
  getExportSnapshot,
  getExportRows,
  getExportStatus,
  recordExportEvent,
};
