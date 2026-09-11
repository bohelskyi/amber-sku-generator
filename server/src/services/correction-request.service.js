const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const pool = require('../db/pool');
const {
  applyProductRecount,
  buildProductRecountPreview,
} = require('./product.service');
const { syncRepricingDraft } = require('./repricing.service');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const {
  getCorrectionPreviewSignature,
  getProductStateSignature,
  stableAnswerEntries,
} = require('./product/product-signatures');

const REQUEST_STATUSES = new Set(['pending', 'in_progress', 'completed', 'rejected']);
const ACTIVE_REQUEST_STATUSES = ['pending', 'in_progress'];
const STATUS_TRANSITIONS = {
  pending: new Set(['in_progress', 'rejected']),
  in_progress: new Set(['pending', 'rejected']),
  rejected: new Set(['pending']),
  completed: new Set(),
};
const CLAIM_TOKEN_HEADER = 'X-Correction-Claim-Token';

function getClaimTokenHash(claimToken) {
  const normalizedToken = typeof claimToken === 'string' ? claimToken.trim() : '';
  if (normalizedToken.length < 32 || normalizedToken.length > 512) return null;
  return crypto.createHash('sha256').update(normalizedToken).digest('hex');
}

function getClaimFingerprint(claimTokenHash) {
  return claimTokenHash ? String(claimTokenHash).slice(0, 16) : null;
}

function claimConflict(message = 'Цей запит уже взяв у роботу інший працівник.') {
  const error = new Error(message);
  error.statusCode = 409;
  error.details = { type: 'correction_claim_conflict' };
  return error;
}

function normalizeClaimVersion(value) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  const normalized = text ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw claimConflict('Версія призначення застаріла або відсутня. Оновіть чергу.');
  }
  return normalized;
}

function assertClaimOwnership(row, actorUserId, claimVersion, claimToken) {
  const expectedVersion = normalizeClaimVersion(claimVersion);
  if (row.status !== 'in_progress' || Number(row.claim_version) !== expectedVersion) {
    throw claimConflict('Призначення цього запиту змінилося. Оновіть чергу.');
  }
  if (row.claimed_by_user_id !== null && row.claimed_by_user_id !== undefined) {
    if (Number(row.claimed_by_user_id) !== actorUserId) {
      throw claimConflict('Цей запит належить іншому працівнику. Оновіть чергу.');
    }
    return { claimVersion: expectedVersion, legacyTokenHash: null, legacyAdopted: false };
  }

  const suppliedHash = getClaimTokenHash(claimToken);
  if (!row.claim_token_hash || !suppliedHash || suppliedHash !== row.claim_token_hash) {
    throw claimConflict('Цей запит належить іншому працівнику. Оновіть чергу.');
  }
  return {
    claimVersion: expectedVersion,
    legacyTokenHash: suppliedHash,
    legacyAdopted: true,
  };
}

function normalizeEmployeeReference(id, displayName, preferredUsername) {
  if (id === null || id === undefined) return null;
  return {
    id: Number(id),
    displayName: displayName || null,
    preferredUsername: preferredUsername || null,
  };
}

async function writeCorrectionAuditEvent(client, mutationContext, eventKey, requestId, details) {
  return writeAuditEvent(client, {
    mutationContext,
    eventKey: `correction_request.${eventKey}`,
    subjectType: 'correction_request',
    subjectId: requestId,
    details,
  });
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
    claimedAt: row.claimed_at,
    claimVersion: Number(row.claim_version || 0),
    claimFingerprint: row.claimed_by_user_id === null || row.claimed_by_user_id === undefined
      ? getClaimFingerprint(row.claim_token_hash)
      : null,
    hasUnownedLegacyClaim: row.status === 'in_progress'
      && (row.claimed_by_user_id === null || row.claimed_by_user_id === undefined),
    createdByUser: normalizeEmployeeReference(
      row.created_by_user_id,
      row.created_by_display_name,
      row.created_by_preferred_username
    ),
    claimedByUser: normalizeEmployeeReference(
      row.claimed_by_user_id,
      row.claimed_by_display_name,
      row.claimed_by_preferred_username
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    rejectedAt: row.rejected_at,
  };
}

async function claimCorrectionRequest(requestId, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  let claimedRow;
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
    const isPending = row.status === 'pending'
      && row.claim_token_hash === null
      && row.claimed_by_user_id === null;
    const isLegacyUnowned = row.status === 'in_progress'
      && row.claim_token_hash === null
      && row.claimed_by_user_id === null;
    if (!isPending && !isLegacyUnowned) {
      if (row.status === 'in_progress') throw claimConflict();
      throw claimConflict(`Запит має статус «${row.status}» і не може бути взятий у роботу.`);
    }
    const updated = await client.query(
      `UPDATE correction_requests
       SET status = 'in_progress',
           claimed_by_user_id = $1,
           claim_token_hash = NULL,
           claim_version = claim_version + 1,
           claimed_at = CURRENT_TIMESTAMP,
           rejected_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [mutationContext.actorUserId, Number(requestId)]
    );
    claimedRow = updated.rows[0];
    await writeCorrectionAuditEvent(
      client,
      mutationContext,
      'claimed',
      requestId,
      {
        claimVersion: Number(claimedRow.claim_version),
        ...(isLegacyUnowned ? { legacyUnownedClaimAdopted: true } : {}),
      }
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  // Refresh only after the atomic claim commits, then guard every write with that
  // owner epoch. This keeps preview reads out of the product/request lock order.
  try {
    const refreshedRow = await refreshClaimedCorrectionRequest(
      claimedRow,
      mutationContext.actorUserId,
      Number(claimedRow.claim_version),
      null,
      { mutationContext }
    );
    return {
      success: true,
      request: normalizeRequestRow(refreshedRow),
    };
  } catch (error) {
    try {
      await releaseCorrectionRequest(requestId, Number(claimedRow.claim_version), null, {
        mutationContext,
        reason: 'claim_refresh_failed',
      });
    } catch {
      // A concurrent owner operation already changed the epoch; preserve its result.
    }
    throw error;
  }
}

async function releaseCorrectionRequest(requestId, claimVersion, claimToken, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
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
    const ownership = assertClaimOwnership(
      result.rows[0],
      mutationContext.actorUserId,
      claimVersion,
      claimToken
    );
    const updated = await client.query(
      `UPDATE correction_requests
       SET status = 'pending',
           claimed_by_user_id = NULL,
           claim_token_hash = NULL,
           claim_version = claim_version + 1,
           claimed_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [Number(requestId)]
    );
    await writeCorrectionAuditEvent(client, mutationContext, 'released', requestId, {
      claimVersion: ownership.claimVersion,
      nextClaimVersion: Number(updated.rows[0].claim_version),
      ...(ownership.legacyAdopted ? { legacyClaimAdopted: true } : {}),
      ...(options.reason ? { reason: options.reason } : {}),
    });
    await client.query('COMMIT');
    return { success: true, request: normalizeRequestRow(updated.rows[0]) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function forceReleaseCorrectionRequest(requestId, claimVersion, confirmed = false, options = {}) {
  if (confirmed !== true) {
    const error = new Error('Підтвердьте примусове повернення запиту в чергу.');
    error.statusCode = 400;
    throw error;
  }
  const mutationContext = createMutationContext(options.mutationContext);
  const expectedVersion = normalizeClaimVersion(claimVersion);
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
    if (row.status !== 'in_progress') {
      throw claimConflict(`Запит має статус «${row.status}» і не перебуває в роботі.`);
    }
    if (Number(row.claim_version) !== expectedVersion) {
      throw claimConflict('Призначення цього запиту змінилося. Оновіть чергу.');
    }
    const updated = await client.query(
      `UPDATE correction_requests
       SET status = 'pending',
           claimed_by_user_id = NULL,
           claim_token_hash = NULL,
           claim_version = claim_version + 1,
           claimed_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING *`,
      [Number(requestId)]
    );
    await writeCorrectionAuditEvent(client, mutationContext, 'force_released', requestId, {
      claimVersion: expectedVersion,
      nextClaimVersion: Number(updated.rows[0].claim_version),
      previousOwnerUserId: row.claimed_by_user_id === null
        ? null
        : Number(row.claimed_by_user_id),
      legacyTokenOnlyClaim: row.claimed_by_user_id === null && row.claim_token_hash !== null,
    });
    await client.query('COMMIT');
    return { success: true, request: normalizeRequestRow(updated.rows[0]) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
    where.push(`cr.status = ANY($${values.length}::text[])`);
  } else if (normalizedStatus !== 'all') {
    values.push(normalizedStatus);
    where.push(`cr.status = $${values.length}`);
  }
  if (normalizedSearch) {
    values.push(`%${normalizedSearch}%`);
    where.push(`(cr.source_sku ILIKE $${values.length} OR cr.proposed_sku ILIKE $${values.length})`);
  }
  values.push(normalizedLimit);

  const [itemsResult, summaryResult] = await Promise.all([
    pool.query(
      `SELECT cr.*,
              creator.display_name AS created_by_display_name,
              creator.preferred_username AS created_by_preferred_username,
              owner.display_name AS claimed_by_display_name,
              owner.preferred_username AS claimed_by_preferred_username
       FROM correction_requests cr
       LEFT JOIN application_users creator ON creator.id = cr.created_by_user_id
       LEFT JOIN application_users owner ON owner.id = cr.claimed_by_user_id
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY
         CASE WHEN cr.status IN ('pending', 'in_progress') THEN 0 ELSE 1 END,
         CASE WHEN cr.status IN ('pending', 'in_progress') THEN cr.created_at END ASC NULLS LAST,
         CASE WHEN cr.status IN ('pending', 'in_progress') THEN cr.id END ASC NULLS LAST,
         COALESCE(cr.completed_at, cr.rejected_at, cr.created_at) DESC,
         cr.id DESC
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

async function createCorrectionRequest(payload = {}, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
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
        proposed_payload, changes, comment, preview_signature, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10)
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
        mutationContext.actorUserId,
      ]
    );
    await writeCorrectionAuditEvent(
      client,
      mutationContext,
      'created',
      result.rows[0].id,
      {
        sourceProductId: Number(preview.source.productId),
        sourceSku: preview.source.sku,
        proposedSku: preview.corrected.fullSku,
      }
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

async function refreshClaimedCorrectionRequest(
  row,
  actorUserId,
  claimVersion,
  claimToken,
  options = {}
) {
  const preview = await buildProductRecountPreview({
    sourceSku: row.source_sku,
    answers: row.proposed_payload?.answers || {},
    isCalibrated: row.proposed_payload?.answers?.is_calibrated ?? null,
    reason: row.comment || '',
    manualPriceUah: row.proposed_payload?.manualPriceUah ?? null,
  });
  const mutationContext = createMutationContext(
    options.mutationContext || { actorUserId, requestId: null }
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      'SELECT * FROM correction_requests WHERE id = $1 FOR UPDATE',
      [Number(row.id)]
    );
    if (locked.rows.length === 0) {
      const error = new Error('Запит на виправлення не знайдено.');
      error.statusCode = 404;
      throw error;
    }
    const ownership = assertClaimOwnership(
      locked.rows[0],
      actorUserId,
      claimVersion,
      claimToken
    );
    const result = await client.query(
      `UPDATE correction_requests
       SET proposed_sku = $1,
           old_payload = $2::jsonb,
           proposed_payload = $3::jsonb,
           changes = $4::jsonb,
           preview_signature = $5,
           claimed_by_user_id = $6,
           claim_token_hash = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [
        preview.corrected.fullSku,
        JSON.stringify(preview.source),
        JSON.stringify(preview.corrected),
        JSON.stringify(preview.changes || []),
        getCorrectionPreviewSignature(preview),
        actorUserId,
        Number(row.id),
      ]
    );
    if (ownership.legacyAdopted) {
      await writeCorrectionAuditEvent(client, mutationContext, 'claimed', row.id, {
        claimVersion: ownership.claimVersion,
        legacyClaimAdopted: true,
      });
    }
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function refreshCorrectionRequest(requestId, claimVersion, claimToken, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const row = await getCorrectionRequestRow(requestId);
  assertClaimOwnership(row, mutationContext.actorUserId, claimVersion, claimToken);
  const refreshedRow = await refreshClaimedCorrectionRequest(
    row,
    mutationContext.actorUserId,
    claimVersion,
    claimToken,
    { mutationContext }
  );
  return { success: true, request: normalizeRequestRow(refreshedRow) };
}

async function updateCorrectionRequestStatus(
  requestId,
  nextStatus,
  claimVersion,
  claimToken,
  options = {}
) {
  const mutationContext = createMutationContext(options.mutationContext);
  const normalizedStatus = String(nextStatus || '').trim().toLowerCase();
  if (
    !REQUEST_STATUSES.has(normalizedStatus)
    || normalizedStatus === 'completed'
    || normalizedStatus === 'in_progress'
  ) {
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
    let ownership = null;
    if (row.status === 'in_progress') {
      if (normalizedStatus === 'pending') {
        throw claimConflict('Поверніть запит у чергу через окрему дію звільнення.');
      }
      ownership = assertClaimOwnership(
        row,
        mutationContext.actorUserId,
        claimVersion,
        claimToken
      );
    }

    const updateResult = await client.query(
      `UPDATE correction_requests
       SET status = $1,
           claimed_by_user_id = NULL,
           claim_token_hash = NULL,
           claim_version = claim_version + CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END,
           claimed_at = CASE WHEN $1 = 'pending' THEN NULL ELSE claimed_at END,
           rejected_at = CASE WHEN $1 = 'rejected' THEN CURRENT_TIMESTAMP ELSE NULL END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [normalizedStatus, Number(requestId)]
    );
    await writeCorrectionAuditEvent(
      client,
      mutationContext,
      normalizedStatus === 'rejected' ? 'rejected' : 'reopened',
      requestId,
      {
        fromStatus: row.status,
        toStatus: normalizedStatus,
        claimVersion: Number(row.claim_version),
        nextClaimVersion: Number(updateResult.rows[0].claim_version),
        ...(ownership?.legacyAdopted ? { legacyClaimAdopted: true } : {}),
      }
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

async function syncActiveRepricingDrafts(mutationContext) {
  const result = await pool.query(
    "SELECT id FROM repricing_drafts WHERE status = 'draft' ORDER BY id"
  );
  const failures = [];
  for (const row of result.rows) {
    try {
      await syncRepricingDraft(row.id, { mutationContext });
    } catch (error) {
      failures.push({ draftId: Number(row.id), message: error.message });
    }
  }
  return failures;
}

async function completeCorrectionRequest(
  requestId,
  claimVersion,
  claimToken,
  options = {}
) {
  const mutationContext = createMutationContext(options.mutationContext);
  const row = await getCorrectionRequestRow(requestId);
  if (row.status === 'completed') {
    const completedAudit = await pool.query(
      `SELECT actor_user_id, details
       FROM audit_events
       WHERE event_key = 'correction_request.completed'
         AND subject_type = 'correction_request'
         AND subject_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [String(Number(requestId))]
    );
    // Completed rows predating migration 025 have no lifecycle event or owner epoch;
    // retain their historical idempotent response. New completions are idempotent
    // only for the same user and claim epoch that actually completed the request.
    if (completedAudit.rows.length > 0) {
      const expectedVersion = normalizeClaimVersion(claimVersion);
      const event = completedAudit.rows[0];
      if (
        Number(event.actor_user_id) !== mutationContext.actorUserId
        || Number(event.details?.claimVersion) !== expectedVersion
        || Number(row.claim_version) !== expectedVersion + 1
      ) {
        throw claimConflict('Цей запит завершено іншим призначенням. Оновіть чергу.');
      }
    }
    return { success: true, alreadyCompleted: true, request: normalizeRequestRow(row) };
  }
  const ownership = assertClaimOwnership(
    row,
    mutationContext.actorUserId,
    claimVersion,
    claimToken
  );

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
    correctionRequestClaimVersion: ownership.claimVersion,
    correctionRequestLegacyClaimHash: ownership.legacyTokenHash,
    correctionRequestLegacyAdopted: ownership.legacyAdopted,
  }, {
    mutationContext,
  });
  const completedRow = await getCorrectionRequestRow(requestId);
  const draftSyncFailures = await syncActiveRepricingDrafts(mutationContext);
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
  CLAIM_TOKEN_HEADER,
  assertClaimOwnership,
  canTransitionCorrectionRequest,
  claimCorrectionRequest,
  completeCorrectionRequest,
  createCorrectionRequest,
  forceReleaseCorrectionRequest,
  getCorrectionPreviewSignature,
  getCorrectionRequests,
  haveSameRequestAnswers,
  getClaimTokenHash,
  normalizeClaimVersion,
  normalizeRequestStatusFilter,
  releaseCorrectionRequest,
  refreshCorrectionRequest,
  updateCorrectionRequestStatus,
};
