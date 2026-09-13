const { isDeepStrictEqual } = require('node:util');
const { REPRICING_SCOPE_GLOBAL, REPRICING_SCOPE_SCENARIO } = require('./constants');
const { normalizeStoredPricingResolutions } = require('./resolutions');
const { getRepricingPreviewSnapshot } = require('./tokens');

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
  const storedContext = storedSnapshot.scope === REPRICING_SCOPE_GLOBAL
    ? {
        scope: storedSnapshot.scope,
        scenarios: storedSnapshot.scenarios || [],
        configurationToken: storedSnapshot.configurationToken || null,
      }
    : {
        scenario: storedSnapshot.scenario || {},
        bindingToken: storedSnapshot.bindingToken || null,
      };
  const currentContext = currentSnapshot.scope === REPRICING_SCOPE_GLOBAL
    ? {
        scope: currentSnapshot.scope,
        scenarios: currentSnapshot.scenarios || [],
        configurationToken: currentSnapshot.configurationToken || null,
      }
    : {
        scenario: currentSnapshot.scenario || {},
        bindingToken: currentSnapshot.bindingToken || null,
      };
  const contextChanged = !isDeepStrictEqual(storedContext, currentContext);
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

function normalizeDraftUiState(uiState = {}) {
  const allowedFilters = new Set(['changed', 'unchanged', 'skipped', 'error', 'all']);
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
    scenarioFilter: String(uiState.scenarioFilter || 'all').slice(0, 80),
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
  const { manualOverrides, automaticProductIds } = normalizeStoredPricingResolutions(
    row.manual_overrides
  );
  const reviewedProductIds = normalizeReviewedProductIds(row.reviewed_product_ids || []);
  return {
    id: Number(row.id),
    scope: row.scope || REPRICING_SCOPE_SCENARIO,
    scenarioId: row.scenario_id === null ? null : Number(row.scenario_id),
    categoryCode: row.category_code,
    scenarioName: row.scenario_name,
    status: row.status,
    manualOverrides,
    manualOverrideCount: manualOverrides.length,
    automaticProductIds,
    automaticResolutionCount: automaticProductIds.length,
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

module.exports = {
  getDraftSyncInfo,
  normalizeDraftRow,
  normalizeDraftUiState,
  normalizeReviewedProductIds,
};
