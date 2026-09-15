const crypto = require('node:crypto');
const pool = require('../db/pool');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const { buildCsv } = require('../utils/csv');
const { toUahNumber } = require('../utils/money');

function exportError(message, statusCode, code = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.publicCode = code;
  return error;
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!key || key.length > 200) {
    throw exportError('Потрібен коректний Idempotency-Key для price export snapshot.', 400);
  }
  return key;
}

function normalizeCapturedRevisions(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      productId: Number(item?.productId),
      revision: Number(item?.revision),
    }))
    .filter((item) => Number.isSafeInteger(item.productId) && item.productId > 0
      && Number.isSafeInteger(item.revision) && item.revision > 0)
    .sort((first, second) => first.productId - second.productId);
}

async function getPriceExportStatus() {
  const [countsResult, latestResult] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE revisions.has_product_snapshot = TRUE
             AND revisions.confirmed_revision < revisions.revision
             AND COALESCE(products.exclude_from_export, 0) = 0
         )::int AS pending_count,
         COUNT(*) FILTER (
           WHERE revisions.has_product_snapshot = TRUE
             AND revisions.confirmed_revision < revisions.revision
             AND COALESCE(products.exclude_from_export, 0) = 1
         )::int AS excluded_pending_count
       FROM product_export_revisions revisions
       JOIN products ON products.id = revisions.product_id`
    ),
    pool.query(
      `SELECT id, status, row_count, file_name, generated_at, confirmed_at
       FROM price_export_snapshots
       ORDER BY generated_at DESC, id DESC
       LIMIT 1`
    ),
  ]);
  const counts = countsResult.rows[0] || {};
  const latest = latestResult.rows[0] || null;
  return {
    pendingCount: Number(counts.pending_count || 0),
    excludedPendingCount: Number(counts.excluded_pending_count || 0),
    latestSnapshot: latest ? {
      id: latest.id,
      status: latest.status,
      rowCount: Number(latest.row_count),
      fileName: latest.file_name,
      generatedAt: latest.generated_at,
      confirmedAt: latest.confirmed_at,
    } : null,
  };
}

async function createPriceExportSnapshot({ idempotencyKey }, options = {}) {
  const key = normalizeIdempotencyKey(idempotencyKey);
  const mutationContext = createMutationContext(options.mutationContext);
  const existing = await pool.query(
    'SELECT * FROM price_export_snapshots WHERE idempotency_key = $1',
    [key]
  );
  if (existing.rows[0]) return existing.rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidates = await client.query(
      `SELECT revisions.product_id
       FROM product_export_revisions revisions
       JOIN products ON products.id = revisions.product_id
       WHERE revisions.has_product_snapshot = TRUE
         AND revisions.confirmed_revision < revisions.revision
         AND COALESCE(products.exclude_from_export, 0) = 0
       ORDER BY revisions.product_id`
    );
    const productIds = candidates.rows.map((row) => Number(row.product_id));
    if (productIds.length === 0) {
      throw exportError('Немає змін цін, готових до експорту.', 409, 'NO_PENDING_PRICE_EXPORTS');
    }
    await client.query(
      `SELECT id
       FROM products
       WHERE id = ANY($1::int[])
       ORDER BY id
       FOR SHARE`,
      [productIds]
    );
    await client.query(
      `SELECT product_id
       FROM product_export_revisions
       WHERE product_id = ANY($1::int[])
       ORDER BY product_id
       FOR UPDATE`,
      [productIds]
    );
    const rowsResult = await client.query(
      `SELECT products.id, products.full_sku, products.total_price_uah, revisions.revision
       FROM products
       JOIN product_export_revisions revisions ON revisions.product_id = products.id
       WHERE products.id = ANY($1::int[])
         AND revisions.has_product_snapshot = TRUE
         AND revisions.confirmed_revision < revisions.revision
         AND COALESCE(products.exclude_from_export, 0) = 0
       ORDER BY products.id`,
      [productIds]
    );
    if (rowsResult.rows.length === 0) {
      throw exportError('Немає змін цін, готових до експорту.', 409, 'NO_PENDING_PRICE_EXPORTS');
    }
    const capturedRevisions = rowsResult.rows.map((row) => ({
      productId: Number(row.id),
      revision: Number(row.revision),
    }));
    const snapshotId = crypto.randomUUID();
    const fileName = `amber-price-export-${snapshotId}.csv`;
    const csvContent = buildCsv([
      ['sku', 'price'],
      ...rowsResult.rows.map((row) => [row.full_sku, toUahNumber(row.total_price_uah)]),
    ]);
    const inserted = await client.query(
      `INSERT INTO price_export_snapshots
       (id, idempotency_key, row_count, file_name, csv_content, captured_revisions,
        created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING *`,
      [
        snapshotId,
        key,
        rowsResult.rows.length,
        fileName,
        csvContent,
        JSON.stringify(capturedRevisions),
        mutationContext.actorUserId,
      ]
    );
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'price_export_snapshot.created',
      subjectType: 'price_export_snapshot',
      subjectId: snapshotId,
      details: { rowCount: rowsResult.rows.length },
    });
    await client.query('COMMIT');
    return inserted.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code !== '23505') throw error;
    const conflict = await pool.query(
      'SELECT * FROM price_export_snapshots WHERE idempotency_key = $1',
      [key]
    );
    if (!conflict.rows[0]) throw error;
    return conflict.rows[0];
  } finally {
    client.release();
  }
}

async function getPriceExportSnapshot(snapshotId) {
  const result = await pool.query(
    'SELECT * FROM price_export_snapshots WHERE id = $1',
    [String(snapshotId)]
  );
  if (!result.rows[0]) throw exportError('Price export snapshot не знайдено.', 404);
  return result.rows[0];
}

async function confirmPriceExportSnapshot(snapshotId, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const snapshotResult = await client.query(
      'SELECT * FROM price_export_snapshots WHERE id = $1 FOR UPDATE',
      [String(snapshotId)]
    );
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) throw exportError('Price export snapshot не знайдено.', 404);
    const captured = normalizeCapturedRevisions(snapshot.captured_revisions);
    if (captured.length > 0) {
      const productIds = captured.map((item) => item.productId);
      await client.query(
        `SELECT product_id
         FROM product_export_revisions
         WHERE product_id = ANY($1::int[])
         ORDER BY product_id
         FOR UPDATE`,
        [productIds]
      );
      await client.query(
        `UPDATE product_export_revisions revisions
         SET confirmed_revision = GREATEST(revisions.confirmed_revision, captured.revision)
         FROM jsonb_to_recordset($1::jsonb)
           AS captured("productId" integer, revision bigint)
         WHERE revisions.product_id = captured."productId"
           AND captured.revision <= revisions.revision`,
        [JSON.stringify(captured)]
      );
    }
    if (snapshot.status !== 'confirmed') {
      await client.query(
        `UPDATE price_export_snapshots
         SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP,
             confirmed_by_user_id = $2
         WHERE id = $1`,
        [String(snapshotId), mutationContext.actorUserId]
      );
      await writeAuditEvent(client, {
        mutationContext,
        eventKey: 'price_export_snapshot.confirmed',
        subjectType: 'price_export_snapshot',
        subjectId: snapshotId,
        details: { rowCount: Number(snapshot.row_count) },
      });
    }
    await client.query('COMMIT');
    return { success: true, snapshotId: String(snapshotId), status: 'confirmed' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  confirmPriceExportSnapshot,
  createPriceExportSnapshot,
  getPriceExportSnapshot,
  getPriceExportStatus,
};
