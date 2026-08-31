const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const pool = require('../db/pool');
const { calculatePricing, loadPricingContext } = require('./pricing.service');
const { getUsdUahRateInfo } = require('./currency.service');
const { roundUah } = require('../utils/money');
const { asRuleObject, isRuleMatched } = require('../utils/rules');

function getProductDetails(product) {
  if (!product?.details) return {};
  if (typeof product.details === 'object') return product.details;

  try {
    return JSON.parse(product.details);
  } catch {
    return {};
  }
}

function getPricingAnswers(product, details) {
  const answers = details.answers && typeof details.answers === 'object'
    ? { ...details.answers }
    : {};

  if (answers.is_calibrated === undefined && details.isCalibrated !== undefined) {
    answers.is_calibrated = details.isCalibrated;
  }

  return answers;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getStoredMatrixName(details = {}) {
  const structuredName = details?.pricingScenario?.name
    || details?.repricing?.pricingChange?.newMatrixName;
  if (structuredName) return String(structuredName);

  const logMessage = String(details?.logMessage || '').trim();
  if (!logMessage) return null;
  const detailsStart = logMessage.indexOf(' (');
  return detailsStart > 0 ? logMessage.slice(0, detailsStart) : logMessage;
}

function getStoredPriceMode(details = {}, pricePerGram = null, explicitMode = null) {
  const storedMode = explicitMode
    || details?.pricingScenario?.price_mode
    || details?.pricingScenario?.priceMode
    || details?.repricing?.pricingChange?.newPriceMode;
  if (storedMode === 'fixed_uah' || storedMode === 'per_gram_usd') return storedMode;
  return Number(pricePerGram || 0) > 0 ? 'per_gram_usd' : 'fixed_uah';
}

function buildPricingState({
  details = {},
  matrixName = null,
  priceMode = null,
  pricePerGram = null,
  uahRate = null,
  priceUah = null,
} = {}) {
  const normalizedPricePerGram = toNullableNumber(pricePerGram);
  const normalizedMode = getStoredPriceMode(details, normalizedPricePerGram, priceMode);
  return {
    matrixName: matrixName || getStoredMatrixName(details),
    priceMode: normalizedMode,
    pricePerGram: normalizedMode === 'per_gram_usd' ? normalizedPricePerGram : null,
    uahRate: toNullableNumber(uahRate),
    fixedPriceUah: normalizedMode === 'fixed_uah' ? toNullableNumber(priceUah) : null,
    priceUah: toNullableNumber(priceUah),
  };
}

function numbersDiffer(first, second, tolerance = 0.0001) {
  if (first === null || second === null) return false;
  return Math.abs(Number(first) - Number(second)) >= tolerance;
}

function buildPricingChange(oldState, newState, { manualOverride = false } = {}) {
  const reasons = [];
  const priceChanged = numbersDiffer(oldState.priceUah, newState.priceUah, 0.005);
  const exchangeRateChanged = oldState.priceMode === 'per_gram_usd'
    && newState.priceMode === 'per_gram_usd'
    && numbersDiffer(oldState.uahRate, newState.uahRate);
  const addReason = (code, label) => {
    if (!reasons.some((reason) => reason.code === code)) reasons.push({ code, label });
  };

  if (
    oldState.matrixName
    && newState.matrixName
    && oldState.matrixName !== newState.matrixName
  ) {
    addReason('matrix_changed', 'Змінено цінову матрицю');
  }
  if (oldState.priceMode !== newState.priceMode) {
    addReason('price_mode_changed', 'Змінено спосіб розрахунку');
  }
  if (
    oldState.priceMode === 'per_gram_usd'
    && newState.priceMode === 'per_gram_usd'
    && numbersDiffer(oldState.pricePerGram, newState.pricePerGram)
  ) {
    addReason('price_per_gram_changed', 'Змінено ціну за грам');
  }
  if (
    oldState.priceMode === 'fixed_uah'
    && newState.priceMode === 'fixed_uah'
    && numbersDiffer(oldState.fixedPriceUah, newState.fixedPriceUah, 0.005)
  ) {
    addReason('fixed_price_changed', 'Змінено фіксовану ціну');
  }
  if (manualOverride) addReason('manual_override', 'Ціну скориговано вручну');
  if (reasons.length === 0 && priceChanged && exchangeRateChanged) {
    addReason('exchange_rate_only', 'Лише оновлення курсу');
  }

  if (reasons.length === 0 && priceChanged) {
    const difference = Math.abs(Number(oldState.priceUah) - Number(newState.priceUah));
    addReason(
      difference < 1 ? 'final_price_rounded' : 'final_price_recalculated',
      difference < 1 ? 'Округлено кінцеву ціну' : 'Перераховано кінцеву ціну'
    );
  }

  return {
    oldMatrixName: oldState.matrixName,
    newMatrixName: newState.matrixName,
    oldPriceMode: oldState.priceMode,
    newPriceMode: newState.priceMode,
    oldPricePerGram: oldState.pricePerGram,
    newPricePerGram: newState.pricePerGram,
    oldUahRate: oldState.uahRate,
    newUahRate: newState.uahRate,
    oldFixedPriceUah: oldState.fixedPriceUah,
    newFixedPriceUah: newState.fixedPriceUah,
    reasonCodes: reasons.map((reason) => reason.code),
    reasonLabels: reasons.map((reason) => reason.label),
  };
}

function addManualOverrideReason(pricingChange = {}) {
  const reasonCodes = (pricingChange.reasonCodes || [])
    .filter((code) => code !== 'manual_override' && code !== 'exchange_rate_only');
  const reasonLabels = (pricingChange.reasonLabels || [])
    .filter((label) => (
      label !== 'Ціну скориговано вручну' && label !== 'Лише оновлення курсу'
    ));
  return {
    ...pricingChange,
    reasonCodes: [...reasonCodes, 'manual_override'],
    reasonLabels: [...reasonLabels, 'Ціну скориговано вручну'],
  };
}

function hasManualPrice(details) {
  const value = details.manualPriceUah;
  return value !== null && value !== undefined && value !== '';
}

function getScenarioSnapshot(scenario) {
  return {
    id: Number(scenario.id),
    categoryCode: scenario.category_code,
    name: scenario.name,
    matchJson: asRuleObject(scenario.match_json),
    axisXKey: scenario.axis_x_key,
    axisYKey: scenario.axis_y_key || '',
    priority: Number(scenario.priority || 0),
    priceMode: scenario.price_mode,
    applyModifiers: scenario.apply_modifiers !== false,
  };
}

function getPreviewToken(scenario, applicableItems) {
  const payload = {
    scenario: getScenarioSnapshot(scenario),
    changes: applicableItems.map((item) => ({
      productId: item.productId,
      sku: item.sku,
      weight: item.weight ?? null,
      answers: item.answers || {},
      oldPriceUah: item.oldPriceUah,
      newPriceUah: item.newPriceUah ?? null,
      status: item.status,
      errorCode: item.errorCode || null,
      pricingChange: item.pricingChange || null,
    })),
  };

  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function getRepricingPreviewSnapshot(preview) {
  return {
    scenario: preview.scenario,
    summary: preview.summary,
    items: [...(preview.items || [])]
      .map((item) => ({
        productId: Number(item.productId),
        sku: item.sku,
        oldPriceUah: item.oldPriceUah ?? null,
        newPriceUah: item.newPriceUah ?? null,
        status: item.status,
        errorCode: item.errorCode || null,
        uahRate: item.uahRate ?? null,
        matrixName: item.matrixName || null,
        pricingChange: item.pricingChange || null,
      }))
      .sort((first, second) => first.productId - second.productId),
  };
}

function getRepricingPreviewFingerprint(preview) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(getRepricingPreviewSnapshot(preview)))
    .digest('hex');
}

function getDraftSyncInfo(storedSnapshot = {}, currentPreview) {
  const currentSnapshot = getRepricingPreviewSnapshot(currentPreview);
  const storedItems = new Map(
    (storedSnapshot.items || []).map((item) => [Number(item.productId), item])
  );
  const currentItems = new Map(
    currentSnapshot.items.map((item) => [Number(item.productId), item])
  );
  const added = currentSnapshot.items.filter((item) => !storedItems.has(item.productId));
  const removed = (storedSnapshot.items || []).filter(
    (item) => !currentItems.has(Number(item.productId))
  );
  const changed = currentSnapshot.items.filter((item) => {
    const stored = storedItems.get(item.productId);
    return stored && !isDeepStrictEqual(stored, item);
  });
  const contextChanged = !isDeepStrictEqual(
    storedSnapshot.scenario || {},
    currentSnapshot.scenario || {}
  );
  const summaryChanged = !isDeepStrictEqual(
    storedSnapshot.summary || {},
    currentSnapshot.summary || {}
  );

  return {
    hasChanges: contextChanged || summaryChanged || added.length > 0
      || removed.length > 0 || changed.length > 0,
    contextChanged,
    summaryChanged,
    added,
    removed,
    changed,
  };
}

function normalizeManualOverrides(manualOverrides = []) {
  if (!Array.isArray(manualOverrides)) {
    const error = new Error('Некоректний список ручних цін.');
    error.statusCode = 400;
    throw error;
  }
  if (manualOverrides.length > 10000) {
    const error = new Error('Забагато ручних цін в одному запиті.');
    error.statusCode = 400;
    throw error;
  }

  const normalized = [];
  const productIds = new Set();
  for (const override of manualOverrides) {
    const productId = Number(override?.productId);
    const rawPrice = String(override?.newPriceUah ?? '').trim().replace(',', '.');
    const parsedPrice = Number(rawPrice);
    const newPriceUah = roundUah(parsedPrice);
    if (!Number.isInteger(productId) || productId <= 0 || newPriceUah === null || newPriceUah <= 0) {
      const error = new Error('Ручна ціна повинна бути додатним числом, а товар має бути коректним.');
      error.statusCode = 422;
      throw error;
    }
    if (productIds.has(productId)) {
      const error = new Error(`Ручну ціну для товару ${productId} передано більше одного разу.`);
      error.statusCode = 422;
      throw error;
    }
    productIds.add(productId);
    normalized.push({ productId, newPriceUah });
  }

  return normalized.sort((first, second) => first.productId - second.productId);
}

function getApplicationToken(previewToken, manualOverrides = []) {
  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  if (normalizedOverrides.length === 0) return previewToken;
  const payload = {
    previewToken,
    manualOverrides: normalizedOverrides,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function applyManualOverridesToPreview(preview, manualOverrides = []) {
  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  const overridesByProductId = new Map(
    normalizedOverrides.map((override) => [override.productId, override.newPriceUah])
  );
  const itemsByProductId = new Map(
    preview.items.map((item) => [Number(item.productId), item])
  );

  for (const override of normalizedOverrides) {
    const item = itemsByProductId.get(override.productId);
    if (!item) {
      const error = new Error(`Товар ${override.productId} не належить до цього перегляду переоцінки.`);
      error.statusCode = 422;
      throw error;
    }
    const isResolvableManualPriceError = item.status === 'error'
      && ['price_missing', 'manual_price'].includes(item.errorCode);
    if (item.status === 'error' && !isResolvableManualPriceError) {
      const error = new Error(`Для товару ${item.sku} спочатку потрібно усунути помилку розрахунку.`);
      error.statusCode = 422;
      throw error;
    }
  }

  const items = preview.items.map((item) => {
    if (!overridesByProductId.has(Number(item.productId))) return item;

    const newPriceUah = overridesByProductId.get(Number(item.productId));
    const resolvesManualPrice = item.status === 'error'
      && ['price_missing', 'manual_price'].includes(item.errorCode);
    const oldPriceUah = item.oldPriceUah === null ? null : Number(item.oldPriceUah);
    const uahRate = Number(item.uahRate || 0);
    const weight = Number(item.weight || 0);
    const totalPrice = uahRate > 0
      ? Number((newPriceUah / uahRate).toFixed(2))
      : item.totalPrice;
    const pricePerGram = uahRate > 0 && weight > 0
      ? Number((newPriceUah / uahRate / weight).toFixed(2))
      : item.pricePerGram;
    const isChanged = resolvesManualPrice || oldPriceUah === null || oldPriceUah !== newPriceUah;

    return {
      ...item,
      calculatedPriceUah: resolvesManualPrice ? null : item.newPriceUah,
      newPriceUah,
      priceDeltaUah: newPriceUah - Number(oldPriceUah || 0),
      totalPrice,
      pricePerGram,
      status: isChanged ? 'changed' : 'unchanged',
      manualOverride: true,
      resolvedManualPrice: resolvesManualPrice,
      resolvedPriceMissing: resolvesManualPrice && item.errorCode === 'price_missing',
      logMessage: resolvesManualPrice ? item.message : item.logMessage,
      pricingChange: addManualOverrideReason(item.pricingChange),
    };
  });

  return {
    ...preview,
    summary: {
      ...preview.summary,
      changedCount: items.filter((item) => item.status === 'changed').length,
      unchangedCount: items.filter((item) => item.status === 'unchanged').length,
      errorCount: items.filter((item) => item.status === 'error').length,
    },
    items,
  };
}

async function getActiveScenario(scenarioId) {
  const result = await pool.query(
    `SELECT *
     FROM price_scenarios
     WHERE id = $1 AND COALESCE(status, 'active') = 'active'
     LIMIT 1`,
    [Number(scenarioId)]
  );

  if (result.rows.length === 0) {
    const error = new Error('Активну цінову матрицю не знайдено.');
    error.statusCode = 404;
    throw error;
  }

  return result.rows[0];
}

async function getRepricingScenarios() {
  const result = await pool.query(
    `SELECT s.id, s.category_code, s.name, s.group_name, s.match_json, s.axis_x_key,
            s.axis_y_key, s.priority, s.price_mode, s.apply_modifiers,
            COUNT(p.id)::int AS active_products_in_category
     FROM price_scenarios s
     LEFT JOIN products p
       ON p.category = s.category_code
      AND COALESCE(p.status, 'active') = 'active'
     WHERE COALESCE(s.status, 'active') = 'active'
     GROUP BY s.id
     ORDER BY s.category_code, s.priority DESC, s.name, s.id`
  );

  return result.rows.map((scenario) => ({
    ...scenario,
    id: Number(scenario.id),
    priority: Number(scenario.priority || 0),
    active_products_in_category: Number(scenario.active_products_in_category || 0),
  }));
}

function buildErrorItem(product, details, answers, code, message) {
  return {
    productId: Number(product.id),
    sku: product.full_sku,
    weight: product.weight === null ? null : Number(product.weight),
    answers,
    oldPriceUah: product.total_price_uah === null ? null : Number(product.total_price_uah),
    totalPrice: product.total_price === null ? null : Number(product.total_price),
    pricePerGram: product.price_per_gram === null ? null : Number(product.price_per_gram),
    uahRate: product.uah_rate === null ? null : Number(product.uah_rate),
    status: 'error',
    errorCode: code,
    message,
    hasManualPrice: hasManualPrice(details),
  };
}

function getRepricingProductIds(previewOrItems = []) {
  const items = Array.isArray(previewOrItems)
    ? previewOrItems
    : previewOrItems?.items || [];
  return [...new Set(items
    .map((item) => Number(item.productId))
    .filter((productId) => Number.isInteger(productId) && productId > 0))]
    .sort((first, second) => first - second);
}

function normalizeBlockingCorrectionRequest(row) {
  return {
    id: Number(row.id),
    sourceProductId: Number(row.source_product_id),
    sourceSku: row.source_sku,
    proposedSku: row.proposed_sku,
    status: row.status,
  };
}

async function getBlockingCorrectionRequests(previewOrItems, queryable = pool) {
  const productIds = getRepricingProductIds(previewOrItems);
  if (productIds.length === 0) return [];

  const result = await queryable.query(
    `SELECT id, source_product_id, source_sku, proposed_sku, status
     FROM correction_requests
     WHERE source_product_id = ANY($1::int[])
       AND status = ANY($2::text[])
     ORDER BY updated_at, id`,
    [productIds, ['pending', 'in_progress']]
  );
  return result.rows.map(normalizeBlockingCorrectionRequest);
}

function assertNoBlockingCorrectionRequests(requests = []) {
  if (requests.length === 0) return;

  const requestIds = requests.map((request) => `#${request.id}`);
  const error = new Error(
    `Переоцінку зупинено: спочатку опрацюйте активні запити ${requestIds.join(', ')}, що належать цій матриці.`
  );
  error.statusCode = 409;
  error.details = {
    type: 'active_correction_requests',
    requests,
  };
  throw error;
}

async function buildRepricingPreview(scenarioId) {
  const scenario = await getActiveScenario(scenarioId);
  const pricingContext = await loadPricingContext(scenario.category_code);
  let rateInfo = null;
  try {
    rateInfo = await getUsdUahRateInfo();
  } catch (error) {
    rateInfo = {
      rate: null,
      source: 'unavailable',
      rateDate: null,
      fetchedAt: null,
      ageMs: null,
      stale: false,
      error: String(error.message || error),
    };
  }
  const scenarioRule = asRuleObject(scenario.match_json);
  const productsResult = await pool.query(
    `SELECT id, full_sku, category, weight, total_price, total_price_uah,
            price_per_gram, uah_rate, details, status, exclude_from_export
     FROM products
     WHERE category = $1
       AND COALESCE(status, 'active') = 'active'
     ORDER BY id`,
    [scenario.category_code]
  );

  const items = [];
  let skippedCount = 0;

  for (const product of productsResult.rows) {
    const details = getProductDetails(product);
    const answers = getPricingAnswers(product, details);
    if (!isRuleMatched(scenarioRule, answers)) continue;

    if (hasManualPrice(details)) {
      items.push(buildErrorItem(
        product,
        details,
        answers,
        'manual_price',
        'Товар має ручну ціну.'
      ));
      continue;
    }

    try {
      const pricing = await calculatePricing(
        product.category,
        answers,
        product.weight,
        answers.is_calibrated,
        { context: pricingContext, rateInfo }
      );
      const selectedScenarioId = Number(pricing.pricingDetails?.scenario?.id || 0);
      if (selectedScenarioId !== Number(scenario.id)) {
        skippedCount += 1;
        continue;
      }

      const newPriceUah = roundUah(pricing.currencyPayload?.totalPriceUah);
      if (!pricing.pricingDetails?.matrix || newPriceUah === null || newPriceUah <= 0) {
        items.push(buildErrorItem(
          product,
          details,
          answers,
          'price_missing',
          pricing.logMessage || 'Не вдалося розрахувати нову ціну.'
        ));
        continue;
      }

      const oldPriceUah = product.total_price_uah === null
        ? null
        : Number(product.total_price_uah);
      const isChanged = oldPriceUah === null || Math.abs(oldPriceUah - newPriceUah) >= 0.005;
      const matrixName = pricing.pricingDetails.scenario?.name || scenario.name;
      const priceMode = pricing.priceMode;
      const pricePerGram = Number(pricing.pricePerGram || 0);
      const uahRate = pricing.currencyPayload?.uahRate === null
        ? null
        : Number(pricing.currencyPayload?.uahRate);
      const pricingChange = buildPricingChange(
        buildPricingState({
          details,
          pricePerGram: product.price_per_gram,
          uahRate: product.uah_rate,
          priceUah: oldPriceUah,
        }),
        buildPricingState({
          details: { pricingScenario: pricing.pricingDetails.scenario },
          matrixName,
          priceMode,
          pricePerGram,
          uahRate,
          priceUah: newPriceUah,
        })
      );
      items.push({
        productId: Number(product.id),
        sku: product.full_sku,
        weight: product.weight === null ? null : Number(product.weight),
        answers,
        oldPriceUah,
        newPriceUah,
        priceDeltaUah: Number((newPriceUah - Number(oldPriceUah || 0)).toFixed(2)),
        status: isChanged ? 'changed' : 'unchanged',
        matrixName,
        priceMode,
        pricePerGram,
        totalPrice: Number(pricing.totalPrice || 0),
        uahRate,
        logMessage: pricing.logMessage,
        pricingDetails: pricing.pricingDetails,
        pricingChange,
      });
    } catch (error) {
      items.push(buildErrorItem(
        product,
        details,
        answers,
        'calculation_failed',
        error.message || 'Помилка розрахунку ціни.'
      ));
    }
  }

  const changedItems = items.filter((item) => item.status === 'changed');
  const unchangedItems = items.filter((item) => item.status === 'unchanged');
  const errorItems = items.filter((item) => item.status === 'error');
  const applicableItems = items.filter((item) => (
    item.status === 'changed' || ['price_missing', 'manual_price'].includes(item.errorCode)
  ));
  const blockingCorrectionRequests = await getBlockingCorrectionRequests(items);

  return {
    scenario: getScenarioSnapshot(scenario),
    previewToken: getPreviewToken(scenario, applicableItems),
    summary: {
      candidateCount: items.length + skippedCount,
      changedCount: changedItems.length,
      unchangedCount: unchangedItems.length,
      skippedCount,
      errorCount: errorItems.length,
    },
    items,
    blockingCorrectionRequests,
  };
}

function normalizeDraftUiState(uiState = {}) {
  const allowedFilters = new Set(['changed', 'unchanged', 'error', 'all']);
  const allowedReviewFilters = new Set(['all', 'pending', 'reviewed']);
  const allowedSortKeys = new Set([
    'sku', 'weight', 'oldPriceUah', 'newPriceUah', 'priceDeltaUah',
  ]);
  const sortKey = allowedSortKeys.has(uiState?.sort?.key) ? uiState.sort.key : 'sku';
  return {
    filter: allowedFilters.has(uiState.filter) ? uiState.filter : 'changed',
    reviewFilter: allowedReviewFilters.has(uiState.reviewFilter)
      ? uiState.reviewFilter
      : 'all',
    search: String(uiState.search || '').slice(0, 120),
    sort: {
      key: sortKey,
      direction: uiState?.sort?.direction === 'desc' ? 'desc' : 'asc',
    },
  };
}

function normalizeReviewedProductIds(productIds = []) {
  if (!Array.isArray(productIds) || productIds.length > 10000) {
    const error = new Error('Некоректний список переглянутих товарів.');
    error.statusCode = 400;
    throw error;
  }

  return [...new Set(productIds.map(Number))]
    .filter((productId) => Number.isInteger(productId) && productId > 0)
    .sort((first, second) => first - second);
}

function normalizeDraftRow(row) {
  if (!row) return null;
  const manualOverrides = normalizeManualOverrides(row.manual_overrides || []);
  const reviewedProductIds = normalizeReviewedProductIds(row.reviewed_product_ids || []);
  return {
    id: Number(row.id),
    scenarioId: row.scenario_id === null ? null : Number(row.scenario_id),
    categoryCode: row.category_code,
    scenarioName: row.scenario_name,
    status: row.status,
    manualOverrides,
    manualOverrideCount: manualOverrides.length,
    reviewedProductIds,
    reviewedProductCount: reviewedProductIds.length,
    uiState: normalizeDraftUiState(row.ui_state || {}),
    previewFingerprint: row.preview_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
    discardedAt: row.discarded_at,
    appliedBatchId: row.applied_batch_id === null ? null : Number(row.applied_batch_id),
  };
}

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
     WHERE status = 'draft' AND scenario_id IS NOT NULL
     ORDER BY updated_at DESC, id DESC`
  );
  return result.rows.map(normalizeDraftRow);
}

async function getDraftOverrideConflicts(overrides, preview) {
  const previewIds = new Set((preview.items || []).map((item) => Number(item.productId)));
  const unavailable = overrides.filter((item) => !previewIds.has(item.productId));
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
  if (!row.scenario_id) {
    const error = new Error('Матриця цієї чернетки більше не існує.');
    error.statusCode = 409;
    throw error;
  }

  const preview = await buildRepricingPreview(row.scenario_id);
  const overrides = normalizeManualOverrides(row.manual_overrides || []);
  const previewIds = new Set(preview.items.map((item) => Number(item.productId)));
  const availableOverrides = overrides.filter((item) => previewIds.has(item.productId));
  const reviewedProductIds = normalizeReviewedProductIds(row.reviewed_product_ids || [])
    .filter((productId) => previewIds.has(productId));
  const draft = normalizeDraftRow(row);
  draft.reviewedProductIds = reviewedProductIds;
  draft.reviewedProductCount = reviewedProductIds.length;
  const conflicts = await getDraftOverrideConflicts(overrides, preview);
  return {
    draft,
    preview,
    manualOverrides: availableOverrides,
    conflicts,
    sync: getDraftSyncInfo(row.preview_snapshot || {}, preview),
  };
}

async function createRepricingDraft({
  scenarioId,
  manualOverrides = [],
  reviewedProductIds = [],
  uiState = {},
}) {
  const scenario = await getActiveScenario(scenarioId);
  const existing = await pool.query(
    `SELECT id FROM repricing_drafts
     WHERE scenario_id = $1 AND status = 'draft'
     LIMIT 1`,
    [Number(scenario.id)]
  );
  if (existing.rows.length > 0) return getRepricingDraft(existing.rows[0].id);

  const preview = await buildRepricingPreview(scenario.id);
  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  const normalizedReviewedIds = normalizeReviewedProductIds(reviewedProductIds);
  applyManualOverridesToPreview(preview, normalizedOverrides);
  const snapshot = getRepricingPreviewSnapshot(preview);
  try {
    const result = await pool.query(
      `INSERT INTO repricing_drafts
       (scenario_id, category_code, scenario_name, scenario_snapshot,
        preview_fingerprint, preview_snapshot, manual_overrides, reviewed_product_ids, ui_state)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
       RETURNING id`,
      [
        Number(scenario.id),
        scenario.category_code,
        scenario.name,
        JSON.stringify(getScenarioSnapshot(scenario)),
        getRepricingPreviewFingerprint(preview),
        JSON.stringify(snapshot),
        JSON.stringify(normalizedOverrides),
        JSON.stringify(normalizedReviewedIds),
        JSON.stringify(normalizeDraftUiState(uiState)),
      ]
    );
    return getRepricingDraft(result.rows[0].id);
  } catch (error) {
    if (error.code !== '23505') throw error;
    const concurrent = await pool.query(
      `SELECT id FROM repricing_drafts
       WHERE scenario_id = $1 AND status = 'draft' LIMIT 1`,
      [Number(scenario.id)]
    );
    return getRepricingDraft(concurrent.rows[0].id);
  }
}

async function saveRepricingDraft(
  draftId,
  { manualOverrides = [], reviewedProductIds = [], uiState = {} }
) {
  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  const normalizedReviewedIds = normalizeReviewedProductIds(reviewedProductIds);
  const result = await pool.query(
    `UPDATE repricing_drafts
     SET manual_overrides = $1::jsonb,
         reviewed_product_ids = $2::jsonb,
         ui_state = $3::jsonb,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4 AND status = 'draft'
     RETURNING *`,
    [
      JSON.stringify(normalizedOverrides),
      JSON.stringify(normalizedReviewedIds),
      JSON.stringify(normalizeDraftUiState(uiState)),
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

async function syncRepricingDraft(draftId) {
  const row = await getRepricingDraftRow(draftId);
  if (row.status !== 'draft' || !row.scenario_id) {
    const error = new Error('Цю чернетку неможливо синхронізувати.');
    error.statusCode = 409;
    throw error;
  }
  const preview = await buildRepricingPreview(row.scenario_id);
  const previewIds = new Set(preview.items.map((item) => Number(item.productId)));
  const reviewedProductIds = normalizeReviewedProductIds(row.reviewed_product_ids || [])
    .filter((productId) => previewIds.has(productId));
  const result = await pool.query(
    `UPDATE repricing_drafts
     SET scenario_snapshot = $1::jsonb,
         preview_fingerprint = $2,
         preview_snapshot = $3::jsonb,
         reviewed_product_ids = $4::jsonb,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $5 AND status = 'draft'
     RETURNING id`,
    [
      JSON.stringify(preview.scenario),
      getRepricingPreviewFingerprint(preview),
      JSON.stringify(getRepricingPreviewSnapshot(preview)),
      JSON.stringify(reviewedProductIds),
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

async function discardRepricingDraft(draftId) {
  const result = await pool.query(
    `UPDATE repricing_drafts
     SET status = 'discarded', discarded_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'draft'
     RETURNING id`,
    [Number(draftId)]
  );
  if (result.rows.length === 0) {
    const error = new Error('Активну чернетку переоцінки не знайдено.');
    error.statusCode = 404;
    throw error;
  }
  return { success: true, id: Number(result.rows[0].id) };
}

function getUpdatedDetails(details, item, batchId, appliedAt) {
  const autoPriceUah = item.manualOverride
    ? (item.calculatedPriceUah ?? null)
    : (item.calculatedPriceUah ?? item.newPriceUah);
  return {
    ...details,
    logMessage: item.logMessage,
    autoPriceUah,
    manualPriceUah: item.manualOverride ? item.newPriceUah : (details.manualPriceUah ?? null),
    pricingScenario: item.pricingDetails?.scenario || details.pricingScenario || null,
    repricing: {
      batchId,
      scenarioId: item.pricingDetails?.scenario?.id || details.pricingScenario?.id || null,
      oldPriceUah: item.oldPriceUah,
      newPriceUah: item.newPriceUah,
      calculatedPriceUah: item.manualOverride
        ? (item.calculatedPriceUah ?? null)
        : (item.calculatedPriceUah ?? item.newPriceUah),
      manualOverride: Boolean(item.manualOverride),
      pricingChange: item.pricingChange || null,
      appliedAt,
    },
  };
}

async function getBatchByPreviewToken(previewToken, client = pool) {
  const result = await client.query(
    `SELECT id, scenario_id, category_code, scenario_name, candidate_count, changed_count,
            unchanged_count, skipped_count, error_count, status, created_at, applied_at,
            rolled_back_at
     FROM repricing_batches
     WHERE preview_token = $1 AND status = 'completed'
     LIMIT 1`,
    [previewToken]
  );
  return result.rows[0] || null;
}

async function applyRepricing({ scenarioId, previewToken, manualOverrides = [], draftId = null }) {
  if (!previewToken) {
    const error = new Error('Спочатку сформуйте попередній перегляд.');
    error.statusCode = 400;
    throw error;
  }

  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  let draft = null;
  if (draftId !== null && draftId !== undefined && draftId !== '') {
    draft = await getRepricingDraftRow(draftId);
    if (draft.status !== 'draft' || Number(draft.scenario_id) !== Number(scenarioId)) {
      const error = new Error('Чернетка не відповідає вибраній матриці або вже закрита.');
      error.statusCode = 409;
      throw error;
    }
    const storedOverrides = normalizeManualOverrides(draft.manual_overrides || []);
    if (JSON.stringify(storedOverrides) !== JSON.stringify(normalizedOverrides)) {
      const error = new Error('Ручні ціни ще не збережено в чернетці. Дочекайтеся автозбереження.');
      error.statusCode = 409;
      throw error;
    }
  }
  const applicationToken = getApplicationToken(previewToken, normalizedOverrides);
  const existingBatch = await getBatchByPreviewToken(applicationToken);
  if (existingBatch) {
    if (draft) {
      await pool.query(
        `UPDATE repricing_drafts
         SET status = 'applied', applied_batch_id = $1, applied_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND status = 'draft'`,
        [Number(existingBatch.id), Number(draft.id)]
      );
    }
    return { success: true, alreadyApplied: true, batch: existingBatch };
  }

  const basePreview = await buildRepricingPreview(scenarioId);
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
  const preview = applyManualOverridesToPreview(basePreview, normalizedOverrides);
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockedProductsResult = await client.query(
      `SELECT id, full_sku, weight, total_price, total_price_uah, price_per_gram,
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
      const lockedOverrides = normalizeManualOverrides(lockedDraft.manual_overrides || []);
      if (
        lockedDraft.status !== 'draft'
        || Number(lockedDraft.scenario_id) !== Number(scenarioId)
        || lockedDraft.preview_fingerprint !== draft.preview_fingerprint
        || JSON.stringify(lockedOverrides) !== JSON.stringify(normalizedOverrides)
      ) {
        const error = new Error('Чернетку змінили під час підготовки переоцінки. Оновіть її повторно.');
        error.statusCode = 409;
        throw error;
      }
    }
    const batchResult = await client.query(
      `INSERT INTO repricing_batches
       (scenario_id, category_code, scenario_name, scenario_snapshot, preview_token, status,
        candidate_count, changed_count, unchanged_count, skipped_count, error_count, applied_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, 'completed', $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
       ON CONFLICT (preview_token) WHERE status = 'completed' DO NOTHING
       RETURNING id, applied_at`,
      [
        preview.scenario.id,
        preview.scenario.categoryCode,
        preview.scenario.name,
        JSON.stringify(preview.scenario),
        applicationToken,
        preview.summary.candidateCount,
        preview.summary.changedCount,
        preview.summary.unchangedCount,
        preview.summary.skippedCount,
        preview.summary.errorCount,
      ]
    );

    if (batchResult.rows.length === 0) {
      await client.query('ROLLBACK');
      const batch = await getBatchByPreviewToken(applicationToken);
      if (draft && batch) {
        await pool.query(
          `UPDATE repricing_drafts
           SET status = 'applied', applied_batch_id = $1, applied_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND status = 'draft'`,
          [Number(batch.id), Number(draft.id)]
        );
      }
      return { success: true, alreadyApplied: true, batch };
    }

    const batchId = Number(batchResult.rows[0].id);
    const appliedAt = batchResult.rows[0].applied_at;

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

      await client.query(
        `INSERT INTO repricing_items
         (batch_id, product_id, sku, old_price_uah, new_price_uah, price_delta_uah,
          old_payload, new_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
        [
          batchId,
          item.productId,
          item.sku,
          item.oldPriceUah,
          item.newPriceUah,
          item.priceDeltaUah,
          JSON.stringify(oldPayload),
          JSON.stringify(newPayload),
        ]
      );
    }

    if (draft) {
      const draftResult = await client.query(
        `UPDATE repricing_drafts
         SET status = 'applied', applied_batch_id = $1, applied_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND status = 'draft'
         RETURNING id`,
        [batchId, Number(draft.id)]
      );
      if (draftResult.rows.length === 0) {
        const error = new Error('Чернетку змінили або закрили під час застосування.');
        error.statusCode = 409;
        throw error;
      }
    }

    await client.query('COMMIT');
    return {
      success: true,
      alreadyApplied: false,
      batch: {
        id: batchId,
        scenario_id: preview.scenario.id,
        scenario_name: preview.scenario.name,
        category_code: preview.scenario.categoryCode,
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

async function getRepricingBatches(limit = 20) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const result = await pool.query(
    `SELECT b.id, b.scenario_id, b.category_code, b.scenario_name, b.status,
            b.candidate_count, b.changed_count, b.unchanged_count, b.skipped_count,
            b.error_count, b.created_at, b.applied_at, b.rolled_back_at,
            (
              b.status = 'completed'
              AND NOT EXISTS (
                SELECT 1
                FROM repricing_items ri
                LEFT JOIN products p ON p.id = ri.product_id
                WHERE ri.batch_id = b.id
                  AND (
                    p.id IS NULL
                    OR COALESCE(p.status, 'active') <> 'active'
                    OR p.details #>> '{repricing,batchId}' IS DISTINCT FROM b.id::text
                    OR p.total_price_uah IS DISTINCT FROM ri.new_price_uah
                  )
              )
            ) AS can_rollback
     FROM repricing_batches b
     ORDER BY b.id DESC
     LIMIT $1`,
    [normalizedLimit]
  );

  return result.rows.map((batch) => ({
    ...batch,
    id: Number(batch.id),
    scenario_id: batch.scenario_id === null ? null : Number(batch.scenario_id),
    candidate_count: Number(batch.candidate_count || 0),
    changed_count: Number(batch.changed_count || 0),
    unchanged_count: Number(batch.unchanged_count || 0),
    skipped_count: Number(batch.skipped_count || 0),
    error_count: Number(batch.error_count || 0),
    can_rollback: Boolean(batch.can_rollback),
  }));
}

function areNullableNumbersEqual(first, second, tolerance = 0.01) {
  if (first === null || first === undefined) return second === null || second === undefined;
  if (second === null || second === undefined) return false;
  return Math.abs(Number(first) - Number(second)) <= tolerance;
}

function doesProductMatchRepricingBatch(product, newPayload, batchId) {
  return (
    String(product.status || 'active') === 'active'
    && Number(product.details?.repricing?.batchId || 0) === Number(batchId)
    && areNullableNumbersEqual(product.total_price, newPayload.totalPrice)
    && areNullableNumbersEqual(product.total_price_uah, newPayload.totalPriceUah)
    && areNullableNumbersEqual(product.price_per_gram, newPayload.pricePerGram)
    && areNullableNumbersEqual(product.uah_rate, newPayload.uahRate)
  );
}

async function rollbackRepricing(batchId) {
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
      `SELECT id, scenario_id, category_code, scenario_name, status, changed_count,
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
       SET status = 'rolled_back', rolled_back_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, scenario_id, category_code, scenario_name, status, changed_count,
                 applied_at, rolled_back_at`,
      [normalizedBatchId]
    );
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

async function getRepricingBatchItems(batchId) {
  const batchResult = await pool.query(
    'SELECT id, scenario_name, applied_at FROM repricing_batches WHERE id = $1 LIMIT 1',
    [Number(batchId)]
  );
  if (batchResult.rows.length === 0) {
    const error = new Error('Партію переоцінки не знайдено.');
    error.statusCode = 404;
    throw error;
  }

  const itemsResult = await pool.query(
    `SELECT sku, old_price_uah, new_price_uah, price_delta_uah, old_payload, new_payload,
            COALESCE((new_payload #>> '{details,repricing,manualOverride}')::boolean, FALSE)
              AS manual_override
     FROM repricing_items
     WHERE batch_id = $1
     ORDER BY id`,
    [Number(batchId)]
  );

  const items = itemsResult.rows.map((item) => {
    const oldPayload = item.old_payload || {};
    const newPayload = item.new_payload || {};
    const storedChange = newPayload?.details?.repricing?.pricingChange;
    const pricingChange = storedChange || buildPricingChange(
      buildPricingState({
        details: oldPayload.details || {},
        pricePerGram: oldPayload.pricePerGram,
        uahRate: oldPayload.uahRate,
        priceUah: oldPayload.totalPriceUah ?? item.old_price_uah,
      }),
      buildPricingState({
        details: newPayload.details || {},
        pricePerGram: newPayload.pricePerGram,
        uahRate: newPayload.uahRate,
        priceUah: newPayload.totalPriceUah ?? item.new_price_uah,
      }),
      { manualOverride: item.manual_override }
    );

    return {
      sku: item.sku,
      old_price_uah: item.old_price_uah,
      new_price_uah: item.new_price_uah,
      price_delta_uah: item.price_delta_uah,
      manual_override: item.manual_override,
      old_matrix_name: pricingChange.oldMatrixName,
      new_matrix_name: pricingChange.newMatrixName,
      old_price_mode: pricingChange.oldPriceMode,
      new_price_mode: pricingChange.newPriceMode,
      old_price_per_gram_usd: pricingChange.oldPricePerGram,
      new_price_per_gram_usd: pricingChange.newPricePerGram,
      old_uah_rate: pricingChange.oldUahRate,
      new_uah_rate: pricingChange.newUahRate,
      change_reason: (pricingChange.reasonLabels || []).join('; '),
    };
  });

  return { batch: batchResult.rows[0], items };
}

async function getRepricingRollbackItems(batchId) {
  const data = await getRepricingBatchItems(batchId);
  return {
    batch: data.batch,
    items: data.items.map((item) => ({
      sku: item.sku,
      current_price_uah: item.new_price_uah,
      restored_price_uah: item.old_price_uah,
      difference_uah: item.old_price_uah === null
        ? null
        : Number(item.old_price_uah) - Number(item.new_price_uah),
    })),
  };
}

module.exports = {
  assertNoBlockingCorrectionRequests,
  applyRepricing,
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
  getRepricingBatchItems,
  getRepricingRollbackItems,
  getRepricingBatches,
  getRepricingScenarios,
  hasManualPrice,
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
