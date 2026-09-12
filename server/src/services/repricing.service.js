const pool = require('../db/pool');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const {
  GLOBAL_REPRICING_NAME,
  REPRICING_SCOPE_GLOBAL,
  REPRICING_SCOPE_SCENARIO,
} = require('./repricing/constants');
const {
  areNullableNumbersEqual,
  buildPricingChange,
  buildPricingState,
  doesProductMatchRepricingBatch,
  getProductDetails,
  hasManualPrice,
} = require('./repricing/pricing-state');
const {
  getGlobalPreviewToken,
  getPreviewToken,
  getPricingContextSnapshot,
  getProductRepricingStateToken,
  getRepricingPreviewFingerprint,
  getRepricingPreviewSnapshot,
  getScenarioSnapshot,
} = require('./repricing/tokens');
const {
  applyManualOverridesToPreview,
  assertDistinctPricingResolutions,
  getApplicationToken,
  normalizeAutomaticProductIds,
  normalizeManualOverrides,
  normalizeStoredPricingResolutions,
  serializePricingResolutions,
} = require('./repricing/resolutions');
const {
  getDraftSyncInfo,
  normalizeDraftRow,
  normalizeDraftUiState,
  normalizeReviewedProductIds,
} = require('./repricing/draft-model');
const {
  assertNoBlockingCorrectionRequests,
  getBlockingCorrectionRequests,
  getRepricingProductIds,
} = require('./repricing/correction-blockers');
const {
  buildGlobalRepricingPreview,
  buildRepricingPreview,
  buildRepricingPreviewState,
  getActiveScenario,
  getRepricingScenarios,
} = require('./repricing/preview-read-model');
const {
  getRepricingBatchItems,
  getRepricingBatches,
  getRepricingRollbackItems,
} = require('./repricing/batch-read-model');

async function getRepricingDraftRow(draftId, queryable = pool, lock = false) {
  const normalizedDraftId = Number(draftId);
  if (!Number.isInteger(normalizedDraftId) || normalizedDraftId <= 0) {
    const error = new Error('Некоректна чернетка переоцінки.');
    error.statusCode = 400;
    throw error;
  }
  const result = await queryable.query(
    `SELECT * FROM repricing_drafts WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [normalizedDraftId]
  );
  if (result.rows.length === 0) {
    const error = new Error('Чернетку переоцінки не знайдено.');
    error.statusCode = 404;
    throw error;
  }
  return result.rows[0];
}

async function getRepricingDrafts() {
  const result = await pool.query(
    `SELECT * FROM repricing_drafts
     WHERE status = 'draft'
       AND (scope = 'global' OR scenario_id IS NOT NULL)
     ORDER BY updated_at DESC, id DESC`
  );
  return result.rows.map(normalizeDraftRow);
}

async function getDraftOverrideConflicts(resolutions, preview) {
  const previewIds = new Set((preview.items || []).map((item) => Number(item.productId)));
  const unavailable = resolutions.filter((item) => !previewIds.has(item.productId));
  if (unavailable.length === 0) return [];

  const productIds = unavailable.map((item) => item.productId);
  const result = await pool.query(
    `SELECT id, full_sku, status, total_price_uah
     FROM products
     WHERE id = ANY($1::int[])`,
    [productIds]
  );
  const products = new Map(result.rows.map((row) => [Number(row.id), row]));
  return unavailable.map((override) => {
    const product = products.get(override.productId);
    return {
      ...override,
      sku: product?.full_sku || `#${override.productId}`,
      status: product?.status || 'missing',
      currentPriceUah: product?.total_price_uah === null || product?.total_price_uah === undefined
        ? null
        : Number(product.total_price_uah),
    };
  });
}

async function getRepricingDraft(draftId) {
  const row = await getRepricingDraftRow(draftId);
  if (row.status !== 'draft') {
    const error = new Error('Ця чернетка вже не є активною.');
    error.statusCode = 409;
    throw error;
  }
  const scope = row.scope || REPRICING_SCOPE_SCENARIO;
  if (scope === REPRICING_SCOPE_SCENARIO && !row.scenario_id) {
    const error = new Error('Матриця цієї чернетки більше не існує.');
    error.statusCode = 409;
    throw error;
  }

  const preview = scope === REPRICING_SCOPE_GLOBAL
    ? await buildGlobalRepricingPreview()
    : await buildRepricingPreview(row.scenario_id);
  const storedResolutions = normalizeStoredPricingResolutions(row.manual_overrides);
  const overrides = storedResolutions.manualOverrides;
  const automaticProductIds = storedResolutions.automaticProductIds;
  const previewIds = new Set(preview.items.map((item) => Number(item.productId)));
  const availableOverrides = overrides.filter((item) => previewIds.has(item.productId));
  const availableAutomaticProductIds = automaticProductIds.filter((productId) => (
    previewIds.has(productId)
  ));
  const reviewedProductIds = normalizeReviewedProductIds(row.reviewed_product_ids || [])
    .filter((productId) => previewIds.has(productId));
  const draft = normalizeDraftRow(row);
  draft.reviewedProductIds = reviewedProductIds;
  draft.reviewedProductCount = reviewedProductIds.length;
  const conflicts = await getDraftOverrideConflicts([
    ...overrides,
    ...automaticProductIds.map((productId) => ({ productId, useAutomatic: true })),
  ], preview);
  return {
    draft,
    preview,
    manualOverrides: availableOverrides,
    automaticProductIds: availableAutomaticProductIds,
    conflicts,
    sync: getDraftSyncInfo(row.preview_snapshot || {}, preview),
  };
}

async function createRepricingDraft({
  scope = REPRICING_SCOPE_SCENARIO,
  scenarioId,
  manualOverrides = [],
  automaticProductIds = [],
  reviewedProductIds = [],
  uiState = {},
}, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const normalizedScope = scope === REPRICING_SCOPE_GLOBAL
    ? REPRICING_SCOPE_GLOBAL
    : REPRICING_SCOPE_SCENARIO;
  const scenario = normalizedScope === REPRICING_SCOPE_SCENARIO
    ? await getActiveScenario(scenarioId)
    : null;
  const existing = await pool.query(
    `SELECT id FROM repricing_drafts
     WHERE scope = $1
       AND status = 'draft'
       AND (($1 = 'global' AND scenario_id IS NULL) OR scenario_id = $2)
     LIMIT 1`,
    [normalizedScope, scenario ? Number(scenario.id) : null]
  );
  if (existing.rows.length > 0) return getRepricingDraft(existing.rows[0].id);

  const preview = normalizedScope === REPRICING_SCOPE_GLOBAL
    ? await buildGlobalRepricingPreview()
    : await buildRepricingPreview(scenario.id);
  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  const normalizedAutomaticProductIds = normalizeAutomaticProductIds(automaticProductIds);
  assertDistinctPricingResolutions(normalizedOverrides, normalizedAutomaticProductIds);
  if (normalizedScope !== REPRICING_SCOPE_GLOBAL && normalizedAutomaticProductIds.length > 0) {
    const error = new Error('Автоматичне рішення доступне лише для загальної переоцінки.');
    error.statusCode = 422;
    throw error;
  }
  const normalizedReviewedIds = normalizeReviewedProductIds(reviewedProductIds);
  applyManualOverridesToPreview(preview, normalizedOverrides, normalizedAutomaticProductIds);
  const snapshot = getRepricingPreviewSnapshot(preview);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO repricing_drafts
       (scope, scenario_id, category_code, scenario_name, scenario_snapshot,
        preview_fingerprint, preview_snapshot, manual_overrides, reviewed_product_ids, ui_state,
        created_by_user_id, last_modified_by_user_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
               $11, $11)
       RETURNING id`,
      [
        normalizedScope,
        scenario ? Number(scenario.id) : null,
        scenario?.category_code || '*',
        scenario?.name || GLOBAL_REPRICING_NAME,
        JSON.stringify(normalizedScope === REPRICING_SCOPE_GLOBAL ? {
          scope: REPRICING_SCOPE_GLOBAL,
          scenarios: preview.scenarios,
          configurationToken: preview.configurationToken,
        } : getScenarioSnapshot(scenario)),
        getRepricingPreviewFingerprint(preview),
        JSON.stringify(snapshot),
        JSON.stringify(serializePricingResolutions(
          normalizedOverrides,
          normalizedAutomaticProductIds
        )),
        JSON.stringify(normalizedReviewedIds),
        JSON.stringify(normalizeDraftUiState(uiState)),
        mutationContext.actorUserId,
      ]
    );
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'repricing_draft.created',
      subjectType: 'repricing_draft',
      subjectId: result.rows[0].id,
      details: { scope: normalizedScope },
    });
    await client.query('COMMIT');
    return getRepricingDraft(result.rows[0].id);
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code !== '23505') throw error;
    const concurrent = await pool.query(
      `SELECT id FROM repricing_drafts
       WHERE scope = $1
         AND status = 'draft'
         AND (($1 = 'global' AND scenario_id IS NULL) OR scenario_id = $2)
       LIMIT 1`,
      [normalizedScope, scenario ? Number(scenario.id) : null]
    );
    if (!concurrent.rows[0]) throw error;
    return getRepricingDraft(concurrent.rows[0].id);
  } finally {
    client.release();
  }
}

async function saveRepricingDraft(
  draftId,
  {
    manualOverrides = [],
    automaticProductIds = [],
    reviewedProductIds = [],
    uiState = {},
  },
  options = {}
) {
  const mutationContext = createMutationContext(options.mutationContext);
  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  const normalizedAutomaticProductIds = normalizeAutomaticProductIds(automaticProductIds);
  assertDistinctPricingResolutions(normalizedOverrides, normalizedAutomaticProductIds);
  if (normalizedAutomaticProductIds.length > 0) {
    const draft = await getRepricingDraftRow(draftId);
    if ((draft.scope || REPRICING_SCOPE_SCENARIO) !== REPRICING_SCOPE_GLOBAL) {
      const error = new Error('Автоматичне рішення доступне лише для загальної переоцінки.');
      error.statusCode = 422;
      throw error;
    }
  }
  const normalizedReviewedIds = normalizeReviewedProductIds(reviewedProductIds);
  const result = await pool.query(
     `UPDATE repricing_drafts
      SET manual_overrides = $1::jsonb,
         reviewed_product_ids = $2::jsonb,
         ui_state = $3::jsonb,
         last_modified_by_user_id = $4,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $5 AND status = 'draft'
     RETURNING *`,
    [
      JSON.stringify(serializePricingResolutions(
        normalizedOverrides,
        normalizedAutomaticProductIds
      )),
      JSON.stringify(normalizedReviewedIds),
      JSON.stringify(normalizeDraftUiState(uiState)),
      mutationContext.actorUserId,
      Number(draftId),
    ]
  );
  if (result.rows.length === 0) {
    const error = new Error('Активну чернетку переоцінки не знайдено.');
    error.statusCode = 404;
    throw error;
  }
  return { draft: normalizeDraftRow(result.rows[0]) };
}

async function syncRepricingDraft(draftId, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const row = await getRepricingDraftRow(draftId);
  const scope = row.scope || REPRICING_SCOPE_SCENARIO;
  if (
    row.status !== 'draft'
    || (scope === REPRICING_SCOPE_SCENARIO && !row.scenario_id)
  ) {
    const error = new Error('Цю чернетку неможливо синхронізувати.');
    error.statusCode = 409;
    throw error;
  }
  const preview = scope === REPRICING_SCOPE_GLOBAL
    ? await buildGlobalRepricingPreview()
    : await buildRepricingPreview(row.scenario_id);
  const previewIds = new Set(preview.items.map((item) => Number(item.productId)));
  const reviewedProductIds = normalizeReviewedProductIds(row.reviewed_product_ids || [])
    .filter((productId) => previewIds.has(productId));
  const result = await pool.query(
     `UPDATE repricing_drafts
      SET scenario_snapshot = $1::jsonb,
          preview_fingerprint = $2,
         preview_snapshot = $3::jsonb,
         reviewed_product_ids = $4::jsonb,
         last_modified_by_user_id = $5,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $6 AND status = 'draft'
     RETURNING id`,
    [
      JSON.stringify(scope === REPRICING_SCOPE_GLOBAL ? {
        scope: REPRICING_SCOPE_GLOBAL,
        scenarios: preview.scenarios,
        configurationToken: preview.configurationToken,
      } : preview.scenario),
      getRepricingPreviewFingerprint(preview),
      JSON.stringify(getRepricingPreviewSnapshot(preview)),
      JSON.stringify(reviewedProductIds),
      mutationContext.actorUserId,
      Number(draftId),
    ]
  );
  if (result.rows.length === 0) {
    const error = new Error('Активну чернетку переоцінки не знайдено.');
    error.statusCode = 404;
    throw error;
  }
  return getRepricingDraft(draftId);
}

async function discardRepricingDraft(draftId, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE repricing_drafts
       SET status = 'discarded', discarded_at = CURRENT_TIMESTAMP,
           discarded_by_user_id = $2, last_modified_by_user_id = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'draft'
       RETURNING id, scope`,
      [Number(draftId), mutationContext.actorUserId]
    );
    if (result.rows.length === 0) {
      const error = new Error('Активну чернетку переоцінки не знайдено.');
      error.statusCode = 404;
      throw error;
    }
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'repricing_draft.discarded',
      subjectType: 'repricing_draft',
      subjectId: result.rows[0].id,
      details: { scope: result.rows[0].scope || REPRICING_SCOPE_SCENARIO },
    });
    await client.query('COMMIT');
    return { success: true, id: Number(result.rows[0].id) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function getUpdatedDetails(details, item, batchId, appliedAt) {
  const calculatedPriceUah = item.calculatedPriceUah ?? null;
  const autoPriceUah = item.automaticPriceUah
    ?? (item.manualOverride ? null : item.newPriceUah);
  return {
    ...details,
    logMessage: item.logMessage,
    calculatedPriceUah,
    autoPriceUah,
    manualPriceUah: item.useAutomatic
      ? null
      : (item.manualOverride ? item.newPriceUah : (details.manualPriceUah ?? null)),
    pricingScenario: item.pricingDetails?.scenario || details.pricingScenario || null,
    repricing: {
      batchId,
      scenarioId: item.pricingDetails?.scenario?.id || details.pricingScenario?.id || null,
      oldPriceUah: item.oldPriceUah,
      newPriceUah: item.newPriceUah,
      calculatedPriceUah,
      autoPriceUah,
      manualOverride: Boolean(item.manualOverride),
      useAutomatic: Boolean(item.useAutomatic),
      pricingChange: item.pricingChange || null,
      appliedAt,
    },
  };
}

async function getBatchByPreviewToken(previewToken, client = pool) {
  const result = await client.query(
    `SELECT id, scope, scenario_id, category_code, scenario_name, candidate_count, changed_count,
            unchanged_count, skipped_count, error_count, status, created_at, applied_at,
            rolled_back_at
     FROM repricing_batches
     WHERE preview_token = $1 AND status = 'completed'
     LIMIT 1`,
    [previewToken]
  );
  return result.rows[0] || null;
}

async function applyRepricingScope({
  scope,
  scenarioId,
  previewToken,
  manualOverrides = [],
  automaticProductIds = [],
  draftId = null,
}, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  if (!previewToken) {
    const error = new Error('Спочатку сформуйте попередній перегляд.');
    error.statusCode = 400;
    throw error;
  }

  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  const normalizedAutomaticProductIds = normalizeAutomaticProductIds(automaticProductIds);
  assertDistinctPricingResolutions(normalizedOverrides, normalizedAutomaticProductIds);
  if (scope !== REPRICING_SCOPE_GLOBAL && normalizedAutomaticProductIds.length > 0) {
    const error = new Error('Автоматичне рішення доступне лише для загальної переоцінки.');
    error.statusCode = 422;
    throw error;
  }
  let draft = null;
  if (draftId !== null && draftId !== undefined && draftId !== '') {
    draft = await getRepricingDraftRow(draftId);
    const draftScope = draft.scope || REPRICING_SCOPE_SCENARIO;
    const scenarioMismatch = scope === REPRICING_SCOPE_SCENARIO
      && Number(draft.scenario_id) !== Number(scenarioId);
    if (draft.status !== 'draft' || draftScope !== scope || scenarioMismatch) {
      const error = new Error('Чернетка не відповідає вибраній переоцінці або вже закрита.');
      error.statusCode = 409;
      throw error;
    }
    const storedResolutions = normalizeStoredPricingResolutions(draft.manual_overrides);
    if (
      JSON.stringify(storedResolutions.manualOverrides) !== JSON.stringify(normalizedOverrides)
      || JSON.stringify(storedResolutions.automaticProductIds)
        !== JSON.stringify(normalizedAutomaticProductIds)
    ) {
      const error = new Error('Рішення щодо цін ще не збережено в чернетці. Дочекайтеся автозбереження.');
      error.statusCode = 409;
      throw error;
    }
  }
  const applicationToken = getApplicationToken(
    previewToken,
    normalizedOverrides,
    normalizedAutomaticProductIds
  );
  const existingBatch = await getBatchByPreviewToken(applicationToken);
  if (existingBatch) {
    if (draft) {
      await pool.query(
         `UPDATE repricing_drafts
          SET status = 'applied', applied_batch_id = $1, applied_at = CURRENT_TIMESTAMP,
             last_modified_by_user_id = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND status = 'draft'`,
        [Number(existingBatch.id), mutationContext.actorUserId, Number(draft.id)]
      );
    }
    return { success: true, alreadyApplied: true, batch: existingBatch };
  }

  let basePreview;
  let productStateTokensById;
  if (scope === REPRICING_SCOPE_GLOBAL) {
    basePreview = await buildGlobalRepricingPreview();
    productStateTokensById = new Map(basePreview.items.map((item) => (
      [Number(item.productId), item.productStateToken]
    )));
  } else {
    const previewState = await buildRepricingPreviewState(scenarioId);
    basePreview = previewState.preview;
    productStateTokensById = previewState.productStateTokensById;
  }
  if (draft && getRepricingPreviewFingerprint(basePreview) !== draft.preview_fingerprint) {
    const error = new Error('Склад товарів або розрахунок змінився. Синхронізуйте чернетку.');
    error.statusCode = 409;
    throw error;
  }
  if (basePreview.previewToken !== previewToken) {
    const error = new Error('Дані або ціни змінилися. Сформуйте попередній перегляд повторно.');
    error.statusCode = 409;
    throw error;
  }
  assertNoBlockingCorrectionRequests(basePreview.blockingCorrectionRequests);
  const preview = applyManualOverridesToPreview(
    basePreview,
    normalizedOverrides,
    normalizedAutomaticProductIds
  );
  if (preview.summary.errorCount > 0) {
    const error = new Error('Переоцінку зупинено: у попередньому перегляді є помилки.');
    error.statusCode = 422;
    throw error;
  }
  if (preview.summary.changedCount === 0) {
    const error = new Error('Немає товарів зі зміненою ціною.');
    error.statusCode = 422;
    throw error;
  }

  const changedItems = preview.items.filter((item) => item.status === 'changed');
  const batchDescriptor = scope === REPRICING_SCOPE_GLOBAL
    ? {
        scenarioId: null,
        categoryCode: null,
        scenarioName: GLOBAL_REPRICING_NAME,
        scenarioSnapshot: {
          scope: REPRICING_SCOPE_GLOBAL,
          scenarios: preview.scenarios,
          configurationToken: preview.configurationToken,
        },
      }
    : {
        scenarioId: preview.scenario.id,
        categoryCode: preview.scenario.categoryCode,
        scenarioName: preview.scenario.name,
        scenarioSnapshot: preview.scenario,
      };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockedProductsResult = await client.query(
      `SELECT id, full_sku, category, weight, total_price, total_price_uah, price_per_gram,
              uah_rate, details, status, exclude_from_export
       FROM products
       WHERE id = ANY($1::int[])
       ORDER BY id
       FOR UPDATE`,
      [changedItems.map((item) => item.productId)]
    );
    const lockedProducts = new Map(
      lockedProductsResult.rows.map((product) => [Number(product.id), product])
    );
    const blockingRequests = await getBlockingCorrectionRequests(changedItems, client);
    assertNoBlockingCorrectionRequests(blockingRequests);
    if (draft) {
      const lockedDraft = await getRepricingDraftRow(draft.id, client, true);
      const lockedResolutions = normalizeStoredPricingResolutions(lockedDraft.manual_overrides);
      if (
        lockedDraft.status !== 'draft'
        || (lockedDraft.scope || REPRICING_SCOPE_SCENARIO) !== scope
        || (
          scope === REPRICING_SCOPE_SCENARIO
          && Number(lockedDraft.scenario_id) !== Number(scenarioId)
        )
        || lockedDraft.preview_fingerprint !== draft.preview_fingerprint
        || JSON.stringify(lockedResolutions.manualOverrides) !== JSON.stringify(normalizedOverrides)
        || JSON.stringify(lockedResolutions.automaticProductIds)
          !== JSON.stringify(normalizedAutomaticProductIds)
      ) {
        const error = new Error('Чернетку змінили під час підготовки переоцінки. Оновіть її повторно.');
        error.statusCode = 409;
        throw error;
      }
    }
    const batchResult = await client.query(
      `INSERT INTO repricing_batches
       (scope, scenario_id, category_code, scenario_name, scenario_snapshot, preview_token, status,
        candidate_count, changed_count, unchanged_count, skipped_count, error_count, applied_at,
        applied_by_user_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'completed', $7, $8, $9, $10, $11,
               CURRENT_TIMESTAMP, $12)
       ON CONFLICT (preview_token) WHERE status = 'completed' DO NOTHING
       RETURNING id, applied_at`,
      [
        scope,
        batchDescriptor.scenarioId,
        batchDescriptor.categoryCode,
        batchDescriptor.scenarioName,
        JSON.stringify(batchDescriptor.scenarioSnapshot),
        applicationToken,
        preview.summary.candidateCount,
        preview.summary.changedCount,
        preview.summary.unchangedCount,
        preview.summary.skippedCount,
        preview.summary.errorCount,
        mutationContext.actorUserId,
      ]
    );

    if (batchResult.rows.length === 0) {
      await client.query('ROLLBACK');
      const batch = await getBatchByPreviewToken(applicationToken);
      if (draft && batch) {
        await pool.query(
          `UPDATE repricing_drafts
           SET status = 'applied', applied_batch_id = $1, applied_at = CURRENT_TIMESTAMP,
              last_modified_by_user_id = $2, updated_at = CURRENT_TIMESTAMP
           WHERE id = $3 AND status = 'draft'`,
          [Number(batch.id), mutationContext.actorUserId, Number(draft.id)]
        );
      }
      return { success: true, alreadyApplied: true, batch };
    }

    const batchId = Number(batchResult.rows[0].id);
    const appliedAt = batchResult.rows[0].applied_at;
    const repricingItemRecords = [];

    for (const item of changedItems) {
      const product = lockedProducts.get(Number(item.productId));
      if (!product || String(product.status || 'active') !== 'active') {
        const error = new Error(`Товар ${item.sku} змінив статус під час переоцінки.`);
        error.statusCode = 409;
        throw error;
      }

      const currentPrice = product.total_price_uah === null
        ? null
        : Number(product.total_price_uah);
      const expectedProductStateToken = productStateTokensById.get(Number(item.productId));
      if (
        !expectedProductStateToken
        || getProductRepricingStateToken(product) !== expectedProductStateToken
      ) {
        const error = new Error(`Товар ${item.sku} змінився під час підготовки переоцінки.`);
        error.statusCode = 409;
        throw error;
      }
      if (currentPrice !== item.oldPriceUah) {
        const error = new Error(`Ціна товару ${item.sku} змінилася під час переоцінки.`);
        error.statusCode = 409;
        throw error;
      }

      const oldDetails = getProductDetails(product);
      const nextDetails = getUpdatedDetails(oldDetails, item, batchId, appliedAt);
      const oldPayload = {
        totalPrice: product.total_price === null ? null : Number(product.total_price),
        totalPriceUah: currentPrice,
        pricePerGram: product.price_per_gram === null ? null : Number(product.price_per_gram),
        uahRate: product.uah_rate === null ? null : Number(product.uah_rate),
        details: oldDetails,
      };
      const newPayload = {
        totalPrice: item.totalPrice,
        totalPriceUah: item.newPriceUah,
        pricePerGram: item.pricePerGram,
        uahRate: item.uahRate,
        details: nextDetails,
      };

      await client.query(
        `UPDATE products
         SET total_price = $1,
             total_price_uah = $2,
             price_per_gram = $3,
             uah_rate = $4,
             details = $5::jsonb
         WHERE id = $6`,
        [
          item.totalPrice,
          item.newPriceUah,
          item.pricePerGram,
          item.uahRate,
          JSON.stringify(nextDetails),
          item.productId,
        ]
      );

      repricingItemRecords.push({
        ordinal: repricingItemRecords.length,
        product_id: Number(item.productId),
        sku: item.sku,
        old_price_uah: item.oldPriceUah,
        new_price_uah: item.newPriceUah,
        price_delta_uah: item.priceDeltaUah,
        old_payload: oldPayload,
        new_payload: newPayload,
      });
    }

    const itemInsertResult = await client.query(
      `INSERT INTO repricing_items
       (batch_id, product_id, sku, old_price_uah, new_price_uah, price_delta_uah,
        old_payload, new_payload)
       SELECT $1, item.product_id, item.sku, item.old_price_uah, item.new_price_uah,
              item.price_delta_uah, item.old_payload, item.new_payload
       FROM jsonb_to_recordset($2::jsonb) AS item(
         ordinal INTEGER,
         product_id INTEGER,
         sku TEXT,
         old_price_uah NUMERIC,
         new_price_uah NUMERIC,
         price_delta_uah NUMERIC,
         old_payload JSONB,
         new_payload JSONB
       )
       ORDER BY item.ordinal
       RETURNING product_id`,
      [batchId, JSON.stringify(repricingItemRecords)]
    );

    const expectedProductIds = [...new Set(changedItems.map((item) => Number(item.productId)))]
      .sort((left, right) => left - right);
    const insertedProductIds = [
      ...new Set(itemInsertResult.rows.map((row) => Number(row.product_id))),
    ].sort((left, right) => left - right);
    const insertedExpectedProducts = expectedProductIds.length === insertedProductIds.length
      && expectedProductIds.every((productId, index) => productId === insertedProductIds[index]);
    if (
      itemInsertResult.rowCount !== changedItems.length
      || expectedProductIds.length !== changedItems.length
      || insertedProductIds.length !== itemInsertResult.rowCount
      || !insertedExpectedProducts
    ) {
      throw new Error('Repricing item batch insert did not persist the complete changed-product set.');
    }

    if (draft) {
      const draftResult = await client.query(
        `UPDATE repricing_drafts
         SET status = 'applied', applied_batch_id = $1, applied_at = CURRENT_TIMESTAMP,
             last_modified_by_user_id = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND status = 'draft'
         RETURNING id`,
        [batchId, mutationContext.actorUserId, Number(draft.id)]
      );
      if (draftResult.rows.length === 0) {
        const error = new Error('Чернетку змінили або закрили під час застосування.');
        error.statusCode = 409;
        throw error;
      }
    }

    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'repricing.applied',
      subjectType: 'repricing_batch',
      subjectId: batchId,
      details: draft ? { draftId: Number(draft.id) } : {},
    });
    await client.query('COMMIT');
    return {
      success: true,
      alreadyApplied: false,
      batch: {
        id: batchId,
        scope,
        scenario_id: batchDescriptor.scenarioId,
        scenario_name: batchDescriptor.scenarioName,
        category_code: batchDescriptor.categoryCode,
        ...preview.summary,
        applied_at: appliedAt,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function applyRepricing(payload, options = {}) {
  return applyRepricingScope({
    ...(payload || {}),
    scope: REPRICING_SCOPE_SCENARIO,
  }, options);
}

async function applyGlobalRepricing(payload, options = {}) {
  return applyRepricingScope({
    ...(payload || {}),
    scenarioId: null,
    scope: REPRICING_SCOPE_GLOBAL,
  }, options);
}


async function rollbackRepricing(batchId, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
  const normalizedBatchId = Number(batchId);
  if (!Number.isInteger(normalizedBatchId) || normalizedBatchId <= 0) {
    const error = new Error('Некоректна партія переоцінки.');
    error.statusCode = 400;
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batchResult = await client.query(
      `SELECT id, scope, scenario_id, category_code, scenario_name, status, changed_count,
              applied_at, rolled_back_at
       FROM repricing_batches
       WHERE id = $1
       FOR UPDATE`,
      [normalizedBatchId]
    );
    if (batchResult.rows.length === 0) {
      const error = new Error('Партію переоцінки не знайдено.');
      error.statusCode = 404;
      throw error;
    }
    const batch = batchResult.rows[0];
    if (batch.status === 'rolled_back') {
      await client.query('COMMIT');
      return { success: true, alreadyRolledBack: true, batch };
    }
    if (batch.status !== 'completed') {
      const error = new Error('Цю партію не можна відкотити в її поточному статусі.');
      error.statusCode = 409;
      throw error;
    }

    const itemCountResult = await client.query(
      'SELECT COUNT(*)::int AS count FROM repricing_items WHERE batch_id = $1',
      [normalizedBatchId]
    );
    const itemsResult = await client.query(
      `SELECT ri.product_id, ri.sku, ri.old_payload, ri.new_payload,
              p.id, p.total_price, p.total_price_uah, p.price_per_gram, p.uah_rate,
              p.details, p.status
       FROM repricing_items ri
       JOIN products p ON p.id = ri.product_id
       WHERE ri.batch_id = $1
       ORDER BY p.id
       FOR UPDATE OF p`,
      [normalizedBatchId]
    );
    if (itemsResult.rows.length !== Number(itemCountResult.rows[0].count)) {
      const error = new Error('Один або кілька товарів цієї переоцінки більше не існують.');
      error.statusCode = 409;
      throw error;
    }

    for (const item of itemsResult.rows) {
      const newPayload = item.new_payload || {};
      const stillMatchesBatch = doesProductMatchRepricingBatch(
        item,
        newPayload,
        normalizedBatchId
      );
      if (!stillMatchesBatch) {
        const error = new Error(
          `Товар ${item.sku} змінено після цієї переоцінки. Відкат зупинено без змін.`
        );
        error.statusCode = 409;
        throw error;
      }
    }

    for (const item of itemsResult.rows) {
      const oldPayload = item.old_payload || {};
      await client.query(
        `UPDATE products
         SET total_price = $1,
             total_price_uah = $2,
             price_per_gram = $3,
             uah_rate = $4,
             details = $5::jsonb
         WHERE id = $6`,
        [
          oldPayload.totalPrice ?? null,
          oldPayload.totalPriceUah ?? null,
          oldPayload.pricePerGram ?? null,
          oldPayload.uahRate ?? null,
          JSON.stringify(oldPayload.details || {}),
          Number(item.product_id),
        ]
      );
    }

    const rolledBackResult = await client.query(
      `UPDATE repricing_batches
       SET status = 'rolled_back', rolled_back_at = CURRENT_TIMESTAMP,
           rolled_back_by_user_id = $2
       WHERE id = $1
       RETURNING id, scope, scenario_id, category_code, scenario_name, status, changed_count,
                 applied_at, rolled_back_at`,
      [normalizedBatchId, mutationContext.actorUserId]
    );
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'repricing.rolled_back',
      subjectType: 'repricing_batch',
      subjectId: normalizedBatchId,
      details: {},
    });
    await client.query('COMMIT');
    return {
      success: true,
      alreadyRolledBack: false,
      batch: rolledBackResult.rows[0],
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}


module.exports = {
  assertNoBlockingCorrectionRequests,
  applyGlobalRepricing,
  applyRepricing,
  buildGlobalRepricingPreview,
  buildRepricingPreview,
  createRepricingDraft,
  discardRepricingDraft,
  getDraftSyncInfo,
  getPreviewToken,
  getRepricingDraft,
  getRepricingDrafts,
  getRepricingPreviewFingerprint,
  getRepricingPreviewSnapshot,
  getRepricingProductIds,
  getApplicationToken,
  getGlobalPreviewToken,
  getRepricingBatchItems,
  getRepricingRollbackItems,
  getRepricingBatches,
  getRepricingScenarios,
  getProductRepricingStateToken,
  hasManualPrice,
  normalizeAutomaticProductIds,
  normalizeManualOverrides,
  normalizeReviewedProductIds,
  applyManualOverridesToPreview,
  buildPricingChange,
  buildPricingState,
  saveRepricingDraft,
  syncRepricingDraft,
  rollbackRepricing,
  areNullableNumbersEqual,
  doesProductMatchRepricingBatch,
};
