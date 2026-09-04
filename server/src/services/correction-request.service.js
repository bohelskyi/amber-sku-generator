const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const pool = require('../db/pool');
const {
  applyProductRecount,
  buildProductRecountPreview,
  getProductStateSignature,
} = require('./product.service');
const { syncRepricingDraft } = require('./repricing.service');
const { toUahNumber } = require('../utils/money');

const REQUEST_STATUSES = new Set(['pending', 'in_progress', 'completed', 'rejected']);
const ACTIVE_REQUEST_STATUSES = ['pending', 'in_progress'];
const STATUS_TRANSITIONS = {
  pending: new Set(['in_progress', 'rejected']),
  in_progress: new Set(['pending', 'rejected']),
  rejected: new Set(['pending']),
  completed: new Set(),
};

function stableAnswerEntries(answers = {}) {
  return Object.entries(answers || {})
    .map(([key, value]) => [key, value ?? null])
    .sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey));
}

function getCorrectionPreviewSignature(preview) {
  const snapshot = {
    source: {
      productId: Number(preview?.source?.productId || 0),
      sku: preview?.source?.sku || null,
      totalPriceUah: toUahNumber(preview?.source?.totalPriceUah),
      answers: stableAnswerEntries(preview?.source?.answers),
    },
    corrected: {
      sku: preview?.corrected?.fullSku || null,
      proposedSku: preview?.corrected?.proposedFullSku || null,
      calculatedPriceUah: toUahNumber(preview?.corrected?.calculatedPriceUah),
      autoPriceUah: toUahNumber(preview?.corrected?.autoPriceUah),
      totalPriceUah: toUahNumber(preview?.corrected?.totalPriceUah),
      answers: stableAnswerEntries(preview?.corrected?.answers),
    },
  };

  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function normalizeRequestStatusFilter(status) {
  const normalizedStatus = String(status || 'active').trim().toLowerCase();
  if (normalizedStatus === 'all' || normalizedStatus === 'active') return normalizedStatus;
  return REQUEST_STATUSES.has(normalizedStatus) ? normalizedStatus : 'active';
}

function canTransitionCorrectionRequest(fromStatus, toStatus) {
  return Boolean(STATUS_TRANSITIONS[fromStatus]?.has(toStatus));
}

function normalizeRequestRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    sourceProductId: Number(row.source_product_id),
    correctedProductId: row.corrected_product_id === null
      ? null
      : Number(row.corrected_product_id),
    categoryCode: row.category_code,
    sourceSku: row.source_sku,
    proposedSku: row.proposed_sku,
    oldPayload: row.old_payload || {},
    proposedPayload: row.proposed_payload || {},
    finalPayload: row.final_payload || null,
    changes: Array.isArray(row.changes) ? row.changes : [],
    comment: row.comment || '',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    rejectedAt: row.rejected_at,
  };
}

async function getCorrectionRequestRow(requestId, queryable = pool) {
  const result = await queryable.query(
    'SELECT * FROM correction_requests WHERE id = $1 LIMIT 1',
    [Number(requestId)]
  );
  if (result.rows.length === 0) {
    const error = new Error('Запит на виправлення не знайдено.');
    error.statusCode = 404;
    throw error;
  }
  return result.rows[0];
}

async function getCorrectionRequests({ status, search, limit } = {}) {
  const normalizedStatus = normalizeRequestStatusFilter(status);
  const normalizedSearch = String(search || '').trim().slice(0, 120);
  const normalizedLimit = Math.min(Math.max(Number(limit) || 300, 1), 1000);
  const values = [];
  const where = [];

  if (normalizedStatus === 'active') {
    values.push(ACTIVE_REQUEST_STATUSES);
    where.push(`status = ANY($${values.length}::text[])`);
  } else if (normalizedStatus !== 'all') {
    values.push(normalizedStatus);
    where.push(`status = $${values.length}`);
  }
  if (normalizedSearch) {
    values.push(`%${normalizedSearch}%`);
    where.push(`(source_sku ILIKE $${values.length} OR proposed_sku ILIKE $${values.length})`);
  }
  values.push(normalizedLimit);

  const [itemsResult, summaryResult] = await Promise.all([
    pool.query(
      `SELECT *
       FROM correction_requests
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY
         CASE status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
         updated_at DESC,
         id DESC
       LIMIT $${values.length}`,
      values
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS all_count,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
         COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress_count,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
         COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_count
       FROM correction_requests`
    ),
  ]);
  const counts = summaryResult.rows[0];

  return {
    items: itemsResult.rows.map(normalizeRequestRow),
    summary: {
      all: Number(counts.all_count || 0),
      active: Number(counts.pending_count || 0) + Number(counts.in_progress_count || 0),
      pending: Number(counts.pending_count || 0),
      inProgress: Number(counts.in_progress_count || 0),
      completed: Number(counts.completed_count || 0),
      rejected: Number(counts.rejected_count || 0),
    },
  };
}

async function createCorrectionRequest(payload = {}) {
  const preview = await buildProductRecountPreview(payload);
  const signature = getCorrectionPreviewSignature(preview);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const sourceResult = await client.query(
      `SELECT id, full_sku, status, corrected_to_product_id, details, category, weight,
              total_price, total_price_uah, price_per_gram, uah_rate, sku_schema_version_id
       FROM products
       WHERE id = $1
       FOR UPDATE`,
      [Number(preview.source.productId)]
    );
    const source = sourceResult.rows[0];
    if (!source
        || String(source.status || 'active') !== 'active'
        || source.corrected_to_product_id
        || source.full_sku !== preview.source.sku
        || getProductStateSignature(source) !== preview.source.stateSignature) {
      const error = new Error('Товар змінився після preview. Оновіть дані та повторіть запит.');
      error.statusCode = 409;
      throw error;
    }
    const result = await client.query(
      `INSERT INTO correction_requests
       (source_product_id, category_code, source_sku, proposed_sku, old_payload,
        proposed_payload, changes, comment, preview_signature)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
       RETURNING *`,
      [
        Number(preview.source.productId),
        preview.corrected.categoryCode,
        preview.source.sku,
        preview.corrected.fullSku,
        JSON.stringify(preview.source),
        JSON.stringify(preview.corrected),
        JSON.stringify(preview.changes || []),
        preview.reason || null,
        signature,
      ]
    );
    await client.query('COMMIT');
    return { success: true, request: normalizeRequestRow(result.rows[0]) };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error?.code === '23505') {
      error.statusCode = 409;
      error.message = 'Для цього товару вже існує активний запит на виправлення.';
    }
    throw error;
  } finally {
    client.release();
  }
}

async function refreshCorrectionRequest(requestId) {
  const row = await getCorrectionRequestRow(requestId);
  if (!ACTIVE_REQUEST_STATUSES.includes(row.status)) {
    const error = new Error('Оновити можна тільки активний запит.');
    error.statusCode = 409;
    throw error;
  }

  const preview = await buildProductRecountPreview({
    sourceSku: row.source_sku,
    answers: row.proposed_payload?.answers || {},
    isCalibrated: row.proposed_payload?.answers?.is_calibrated ?? null,
    reason: row.comment || '',
    manualPriceUah: row.proposed_payload?.manualPriceUah ?? null,
  });
  const result = await pool.query(
    `UPDATE correction_requests
     SET proposed_sku = $1,
         old_payload = $2::jsonb,
         proposed_payload = $3::jsonb,
         changes = $4::jsonb,
         preview_signature = $5,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $6 AND status = ANY($7::text[])
     RETURNING *`,
    [
      preview.corrected.fullSku,
      JSON.stringify(preview.source),
      JSON.stringify(preview.corrected),
      JSON.stringify(preview.changes || []),
      getCorrectionPreviewSignature(preview),
      Number(requestId),
      ACTIVE_REQUEST_STATUSES,
    ]
  );
  if (result.rows.length === 0) {
    const error = new Error('Запит змінив статус. Оновіть сторінку.');
    error.statusCode = 409;
    throw error;
  }
  return { success: true, request: normalizeRequestRow(result.rows[0]) };
}

async function updateCorrectionRequestStatus(requestId, nextStatus) {
  const normalizedStatus = String(nextStatus || '').trim().toLowerCase();
  if (!REQUEST_STATUSES.has(normalizedStatus) || normalizedStatus === 'completed') {
    const error = new Error('Некоректний статус запиту.');
    error.statusCode = 400;
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT * FROM correction_requests WHERE id = $1 FOR UPDATE',
      [Number(requestId)]
    );
    if (result.rows.length === 0) {
      const error = new Error('Запит на виправлення не знайдено.');
      error.statusCode = 404;
      throw error;
    }
    const row = result.rows[0];
    if (row.status === normalizedStatus) {
      await client.query('COMMIT');
      return { success: true, request: normalizeRequestRow(row) };
    }
    if (!canTransitionCorrectionRequest(row.status, normalizedStatus)) {
      const error = new Error(`Не можна змінити статус «${row.status}» на «${normalizedStatus}».`);
      error.statusCode = 409;
      throw error;
    }

    const updateResult = await client.query(
      `UPDATE correction_requests
       SET status = $1,
           rejected_at = CASE WHEN $1 = 'rejected' THEN CURRENT_TIMESTAMP ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [normalizedStatus, Number(requestId)]
    );
    await client.query('COMMIT');
    return { success: true, request: normalizeRequestRow(updateResult.rows[0]) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function syncActiveRepricingDrafts() {
  const result = await pool.query(
    "SELECT id FROM repricing_drafts WHERE status = 'draft' ORDER BY id"
  );
  const failures = [];
  for (const row of result.rows) {
    try {
      await syncRepricingDraft(row.id);
    } catch (error) {
      failures.push({ draftId: Number(row.id), message: error.message });
    }
  }
  return failures;
}

async function completeCorrectionRequest(requestId) {
  const row = await getCorrectionRequestRow(requestId);
  if (row.status === 'completed') {
    return { success: true, alreadyCompleted: true, request: normalizeRequestRow(row) };
  }
  if (!ACTIVE_REQUEST_STATUSES.includes(row.status)) {
    const error = new Error('Виконати можна тільки активний запит.');
    error.statusCode = 409;
    throw error;
  }

  const preview = await buildProductRecountPreview({
    sourceSku: row.source_sku,
    answers: row.proposed_payload?.answers || {},
    isCalibrated: row.proposed_payload?.answers?.is_calibrated ?? null,
    reason: row.comment || '',
    manualPriceUah: row.proposed_payload?.manualPriceUah ?? null,
  });
  if (getCorrectionPreviewSignature(preview) !== row.preview_signature) {
    const error = new Error('Товар або розрахунок змінилися після створення запиту. Оновіть запит і звірте дані на сайті.');
    error.statusCode = 409;
    error.details = { type: 'stale_correction_request' };
    throw error;
  }

  const recountResult = await applyProductRecount({
    sourceSku: row.source_sku,
    answers: row.proposed_payload?.answers || {},
    isCalibrated: row.proposed_payload?.answers?.is_calibrated ?? null,
    reason: row.comment || '',
    manualPriceUah: row.proposed_payload?.manualPriceUah ?? null,
    correctionRequestId: Number(requestId),
    correctionRequestSignature: row.preview_signature,
  });
  const completedRow = await getCorrectionRequestRow(requestId);
  const draftSyncFailures = await syncActiveRepricingDrafts();
  return {
    success: true,
    request: normalizeRequestRow(completedRow),
    recount: recountResult,
    draftSyncFailures,
  };
}

function haveSameRequestAnswers(firstAnswers, secondAnswers) {
  return isDeepStrictEqual(stableAnswerEntries(firstAnswers), stableAnswerEntries(secondAnswers));
}

module.exports = {
  canTransitionCorrectionRequest,
  completeCorrectionRequest,
  createCorrectionRequest,
  getCorrectionPreviewSignature,
  getCorrectionRequests,
  haveSameRequestAnswers,
  normalizeRequestStatusFilter,
  refreshCorrectionRequest,
  updateCorrectionRequestStatus,
};
