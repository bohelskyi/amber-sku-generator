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
  getCorrectionDecisionSignature,
  getCorrectionPreviewSignature,
  getProductStateSignature,
  stableAnswerEntries,
} = require('./product/product-signatures');
const {
  decisionFromRequest,
  normalizePricingDecision,
} = require('./product/correction-pricing-decision');
const { loadPricingContext } = require('./pricing/pricing-context');
const { getPricingContextFingerprint } = require('./pricing/pricing-context-fingerprint');
const {
  applyProductPriceChange,
  normalizePriceChangeDecision,
  previewProductPriceChange,
} = require('./product-price-change.service');

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
    requestType: row.request_type || 'recount',
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
    pricingDecision: decisionFromRequest(row),
    pricingOrigin: row.pricing_origin || null,
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

function normalizeRequestType(value) {
  const requestType = String(value || 'recount').trim().toLowerCase();
  if (!['recount', 'price_change'].includes(requestType)) {
    const error = new Error('Невідомий тип запиту на виправлення.');
    error.statusCode = 422;
    throw error;
  }
  return requestType;
}

function getRequestedPriceChangeDecision(payload, canOverride) {
  const decision = normalizePriceChangeDecision(payload.pricingDecision);
  if (decision.mode !== 'system_auto' && !canOverride) {
    const error = new Error('Недостатньо дозволу для вибору ціни запиту.');
    error.statusCode = 403;
    throw error;
  }
  return decision;
}

function getRequestedDecision(payload, canOverride) {
  if (!Object.hasOwn(payload, 'pricingDecision')) return null;
  const decision = normalizePricingDecision(payload.pricingDecision);
  if (Object.hasOwn(payload, 'manualPriceUah')) {
    const error = new Error('Не поєднуйте рішення про ціну зі старим полем ручної ціни.');
    error.statusCode = 422;
    throw error;
  }
  if (decision.mode !== 'system_auto' && !canOverride) {
    const error = new Error('Недостатньо дозволу для вибору ціни запиту.');
    error.statusCode = 403;
    throw error;
  }
  return decision;
}

function getPersistedNewRequestDecision(requestedDecision, preview) {
  if (requestedDecision) {
    return {
      decision: requestedDecision,
      pricingOrigin: requestedDecision.mode === 'manual_uah'
        ? 'authorized_override' : null,
    };
  }
  if (Number(preview?.corrected?.manualPriceUah) > 0) {
    return {
      decision: {
        mode: 'manual_uah',
        manualPriceUah: Number(preview.corrected.manualPriceUah),
      },
      pricingOrigin: 'automatic_unavailable_fallback',
    };
  }
  return {
    decision: { mode: 'system_auto' },
    pricingOrigin: null,
  };
}

function getStoredRecountAnswerPatch(row) {
  const proposedAnswers = row.proposed_payload?.answers || {};
  const oldAnswers = row.old_payload?.answers;
  if (!oldAnswers || typeof oldAnswers !== 'object' || Array.isArray(oldAnswers)
      || !proposedAnswers || typeof proposedAnswers !== 'object'
      || Array.isArray(proposedAnswers)) {
    return proposedAnswers;
  }
  const answerPatch = { ...proposedAnswers };
  for (const key of Object.keys(oldAnswers)) {
    if (!Object.hasOwn(proposedAnswers, key)) answerPatch[key] = null;
  }
  return answerPatch;
}

async function previewCorrectionRequest(payload = {}, options = {}) {
  const requestType = normalizeRequestType(payload.requestType);
  if (requestType === 'price_change') {
    const decision = getRequestedPriceChangeDecision(payload, options.canOverride === true);
    return {
      requestType,
      ...await previewProductPriceChange({
        productId: payload.productId,
        pricingDecision: decision,
      }),
    };
  }
  const decision = getRequestedDecision(payload, options.canOverride === true);
  const preview = await buildProductRecountPreview({ ...payload, pricingDecision: decision });
  if (!decision && preview.corrected.manualPriceUah
      && Number(preview.corrected.autoPriceUah) > 0) {
    const error = new Error('Ручна ціна без дозволу доступна лише за відсутності автоматичної.');
    error.statusCode = 403;
    throw error;
  }
  return {
    requestType: 'recount',
    ...preview,
    previewSignature: getCorrectionDecisionSignature(preview, decision),
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
        requestType: claimedRow.request_type || 'recount',
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
      requestType: result.rows[0].request_type || 'recount',
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
      requestType: row.request_type || 'recount',
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

async function createPriceChangeRequest(payload = {}, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const decision = getRequestedPriceChangeDecision(payload, options.canOverride === true);
  const suppliedToken = String(payload.previewToken || '').trim();
  if (!suppliedToken) {
    const error = new Error('Для створення запиту потрібен актуальний previewToken.');
    error.statusCode = 422;
    throw error;
  }
  const productId = Number(payload.productId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sourceResult = await client.query(
      `SELECT id, full_sku, category
       FROM products
       WHERE id = $1
       FOR UPDATE`,
      [productId]
    );
    if (sourceResult.rows.length !== 1) {
      const error = new Error('Товар для зміни ціни більше не існує.');
      error.statusCode = 404;
      throw error;
    }
    const preview = await previewProductPriceChange({
      productId,
      pricingDecision: decision,
    }, { queryable: client });
    if (preview.previewToken !== suppliedToken) {
      const error = new Error('Попередній розрахунок змінився. Оновіть його перед створенням запиту.');
      error.statusCode = 409;
      error.publicCode = 'STALE_PRODUCT_PRICE_PREVIEW';
      throw error;
    }
    if (preview.unchanged) {
      const error = new Error('Результуюча ціна UAH не відрізняється від поточної.');
      error.statusCode = 422;
      error.publicCode = 'PRODUCT_PRICE_UNCHANGED';
      throw error;
    }
    const oldPayload = {
      requestType: 'price_change',
      productId,
      sku: preview.sku,
      stateSignature: preview.productStateSignature,
      totalPriceUah: preview.currentPriceUah,
      pricing: preview.currentPricing,
    };
    const proposedPayload = {
      requestType: 'price_change',
      productId,
      sku: preview.sku,
      totalPriceUah: preview.resultingPriceUah,
      priceDifferenceUah: preview.priceDifferenceUah,
      pricingDecision: decision,
      pricing: preview.resultingPricing,
      pricingContextFingerprint: preview.pricingContextFingerprint,
      uahRateDate: preview.uahRateDate,
      previewToken: preview.previewToken,
    };
    const result = await client.query(
      `INSERT INTO correction_requests
       (request_type, source_product_id, category_code, source_sku, proposed_sku,
        old_payload, proposed_payload, changes, comment, preview_signature,
        created_by_user_id, pricing_mode, pricing_usd_per_gram, pricing_manual_uah,
        pricing_rounding_enabled, pricing_origin)
       VALUES ('price_change', $1, $2, $3, $3, $4::jsonb, $5::jsonb, '[]'::jsonb,
               $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        productId,
        sourceResult.rows[0].category,
        preview.sku,
        JSON.stringify(oldPayload),
        JSON.stringify(proposedPayload),
        String(payload.comment || payload.reason || '').trim() || null,
        preview.previewToken,
        mutationContext.actorUserId,
        decision.mode,
        decision.mode === 'usd_per_gram' ? decision.usdPerGram : null,
        decision.mode === 'manual_uah' ? decision.manualPriceUah : null,
        decision.mode === 'system_auto' ? null : Number(decision.marketingRoundingEnabled),
        decision.mode === 'manual_uah' ? 'authorized_override' : null,
      ]
    );
    await writeCorrectionAuditEvent(client, mutationContext, 'created', result.rows[0].id, {
      requestType: 'price_change',
      sourceProductId: productId,
      sourceSku: preview.sku,
      proposedSku: preview.sku,
      pricingMode: decision.mode,
      pricingDecision: decision,
      currentPriceUah: preview.currentPriceUah,
      resultingPriceUah: preview.resultingPriceUah,
    });
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

async function createCorrectionRequest(payload = {}, options = {}) {
  if (normalizeRequestType(payload.requestType) === 'price_change') {
    return createPriceChangeRequest(payload, options);
  }
  const mutationContext = createMutationContext(options.mutationContext);
  const requestedDecision = getRequestedDecision(payload, options.canOverride === true);
  const preview = await buildProductRecountPreview({
    ...payload,
    pricingDecision: requestedDecision,
  });
  if (requestedDecision?.mode === 'system_auto'
      && !(Number(preview.corrected.autoPriceUah) > 0)) {
    const error = new Error('Автоматична ціна відсутня. Виберіть інший дозволений режим ціни.');
    error.statusCode = 422;
    throw error;
  }
  if (!requestedDecision && !(Number(preview.corrected.totalPriceUah) > 0)) {
    const error = new Error('Автоматична ціна відсутня. Вкажіть точну ручну ціну UAH.');
    error.statusCode = 422;
    throw error;
  }
  if (!requestedDecision && preview.corrected.manualPriceUah
      && Number(preview.corrected.autoPriceUah) > 0) {
    const error = new Error('Ручна ціна без дозволу доступна лише за відсутності автоматичної.');
    error.statusCode = 403;
    throw error;
  }
  const { decision, pricingOrigin } = getPersistedNewRequestDecision(
    requestedDecision,
    preview
  );
  const signature = getCorrectionDecisionSignature(preview, decision);
  if (requestedDecision && payload.previewSignature !== signature) {
    const error = new Error('Попередній розрахунок змінився. Оновіть його перед створенням запиту.');
    error.statusCode = 409;
    throw error;
  }
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
       (request_type, source_product_id, category_code, source_sku, proposed_sku, old_payload,
        proposed_payload, changes, comment, preview_signature, created_by_user_id,
        pricing_mode, pricing_usd_per_gram, pricing_manual_uah, pricing_rounding_enabled,
        pricing_origin)
       VALUES ('recount', $1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10,
               $11, $12, $13, $14, $15)
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
        decision.mode,
        decision.mode === 'usd_per_gram' ? decision.usdPerGram : null,
        decision.mode === 'manual_uah' ? decision.manualPriceUah : null,
        decision.mode === 'usd_per_gram'
          ? Number(decision.marketingRoundingEnabled) : null,
        pricingOrigin,
      ]
    );
    await writeCorrectionAuditEvent(
      client,
      mutationContext,
      'created',
      result.rows[0].id,
      {
        requestType: 'recount',
        sourceProductId: Number(preview.source.productId),
        sourceSku: preview.source.sku,
        proposedSku: preview.corrected.fullSku,
        pricingMode: decision.mode,
        pricingDecision: decision,
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

async function refreshClaimedPriceChangeRequest(
  row,
  actorUserId,
  claimVersion,
  claimToken,
  options = {}
) {
  const pricingDecision = decisionFromRequest(row);
  const mutationContext = createMutationContext(
    options.mutationContext || { actorUserId, requestId: null }
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const preview = await previewProductPriceChange({
      productId: Number(row.source_product_id),
      pricingDecision,
    }, {
      allowedCorrectionRequestId: Number(row.id),
      lockProduct: true,
      queryable: client,
    });
    if (preview.unchanged) {
      const error = new Error('Після оновлення результуюча ціна не відрізняється від поточної.');
      error.statusCode = 422;
      error.publicCode = 'PRODUCT_PRICE_UNCHANGED';
      throw error;
    }
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
      locked.rows[0], actorUserId, claimVersion, claimToken
    );
    const oldPayload = {
      requestType: 'price_change',
      productId: Number(row.source_product_id),
      sku: preview.sku,
      stateSignature: preview.productStateSignature,
      totalPriceUah: preview.currentPriceUah,
      pricing: preview.currentPricing,
    };
    const proposedPayload = {
      requestType: 'price_change',
      productId: Number(row.source_product_id),
      sku: preview.sku,
      totalPriceUah: preview.resultingPriceUah,
      priceDifferenceUah: preview.priceDifferenceUah,
      pricingDecision,
      pricing: preview.resultingPricing,
      pricingContextFingerprint: preview.pricingContextFingerprint,
      uahRateDate: preview.uahRateDate,
      previewToken: preview.previewToken,
    };
    const result = await client.query(
      `UPDATE correction_requests
       SET source_sku = $1, proposed_sku = $1,
           old_payload = $2::jsonb, proposed_payload = $3::jsonb,
           changes = '[]'::jsonb, preview_signature = $4,
           claimed_by_user_id = $5, claim_token_hash = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 AND request_type = 'price_change'
       RETURNING *`,
      [
        preview.sku,
        JSON.stringify(oldPayload),
        JSON.stringify(proposedPayload),
        preview.previewToken,
        actorUserId,
        Number(row.id),
      ]
    );
    if (ownership.legacyAdopted) {
      await writeCorrectionAuditEvent(client, mutationContext, 'claimed', row.id, {
        requestType: 'price_change',
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

async function refreshClaimedCorrectionRequest(
  row,
  actorUserId,
  claimVersion,
  claimToken,
  options = {}
) {
  if ((row.request_type || 'recount') === 'price_change') {
    return refreshClaimedPriceChangeRequest(
      row, actorUserId, claimVersion, claimToken, options
    );
  }
  const pricingDecision = decisionFromRequest(row);
  const answers = getStoredRecountAnswerPatch(row);
  const preview = await buildProductRecountPreview({
    sourceSku: row.source_sku,
    answers,
    isCalibrated: row.proposed_payload?.answers?.is_calibrated ?? null,
    reason: row.comment || '',
    manualPriceUah: row.proposed_payload?.manualPriceUah ?? null,
    weight: row.proposed_payload?.weight ?? undefined,
    pricingDecision,
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
        getCorrectionDecisionSignature(preview, pricingDecision),
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
        requestType: row.request_type || 'recount',
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

  if ((row.request_type || 'recount') === 'price_change') {
    const priceChange = await applyProductPriceChange({
      productId: Number(row.source_product_id),
      pricingDecision: decisionFromRequest(row),
      previewToken: row.proposed_payload?.previewToken || row.preview_signature,
    }, {
      mutationContext,
      correctionRequest: {
        id: Number(row.id),
        claimedByUserId: mutationContext.actorUserId,
        claimVersion: ownership.claimVersion,
        previewToken: row.proposed_payload?.previewToken || row.preview_signature,
      },
    });
    const completedRow = await getCorrectionRequestRow(requestId);
    return {
      success: true,
      request: normalizeRequestRow(completedRow),
      priceChange,
    };
  }

  const pricingDecision = decisionFromRequest(row);
  const answers = getStoredRecountAnswerPatch(row);
  const preview = await buildProductRecountPreview({
    sourceSku: row.source_sku,
    answers,
    isCalibrated: row.proposed_payload?.answers?.is_calibrated ?? null,
    reason: row.comment || '',
    manualPriceUah: row.proposed_payload?.manualPriceUah ?? null,
    weight: row.proposed_payload?.weight ?? undefined,
    pricingDecision,
  });
  let signatureMatches = getCorrectionDecisionSignature(preview, pricingDecision)
    === row.preview_signature;
  if (!pricingDecision && !signatureMatches
      && !Object.hasOwn(row.proposed_payload || {}, 'pricingContextFingerprint')) {
    const context = await loadPricingContext(row.category_code);
    signatureMatches = Number(context?.category?.marketing_rounding_enabled) === 1
      && getPricingContextFingerprint(context) === preview.corrected.pricingContextFingerprint
      && getCorrectionPreviewSignature(preview, { legacyDefaultRounding: true })
        === row.preview_signature;
  }
  if (!signatureMatches) {
    const error = new Error('Товар або розрахунок змінилися після створення запиту. Оновіть запит і звірте дані на сайті.');
    error.statusCode = 409;
    error.details = { type: 'stale_correction_request' };
    throw error;
  }

  const recountResult = await applyProductRecount({
    sourceSku: row.source_sku,
    answers,
    isCalibrated: row.proposed_payload?.answers?.is_calibrated ?? null,
    reason: row.comment || '',
    manualPriceUah: row.proposed_payload?.manualPriceUah ?? null,
    weight: row.proposed_payload?.weight ?? undefined,
    pricingDecision,
    correctionRequestId: Number(requestId),
    correctionRequestSignature: row.preview_signature,
    correctionRequestClaimVersion: ownership.claimVersion,
    correctionRequestLegacyClaimHash: ownership.legacyTokenHash,
    correctionRequestLegacyAdopted: ownership.legacyAdopted,
  }, {
    mutationContext,
    trustedCorrectionDecision: Boolean(pricingDecision),
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
  previewCorrectionRequest,
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
