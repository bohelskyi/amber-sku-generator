export function parseManualPrice(value) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export function getManualOverrides(manualPrices = {}) {
  return Object.entries(manualPrices)
    .map(([productId, value]) => ({
      productId: Number(productId),
      newPriceUah: parseManualPrice(value),
    }))
    .filter((item) => Number.isInteger(item.productId) && item.newPriceUah !== null)
    .sort((first, second) => first.productId - second.productId);
}

export function getInvalidManualPriceIds(manualPrices = {}) {
  return Object.entries(manualPrices)
    .filter(([, value]) => parseManualPrice(value) === null)
    .map(([productId]) => Number(productId));
}

function parseAutomaticPrice(value) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getUnresolvedManualPriceItems(
  items = [],
  manualPrices = {},
  automaticProductIds = []
) {
  const automaticProductIdSet = new Set(automaticProductIds.map(Number));
  return items.filter((item) => (
    item.errorCode === 'manual_price'
    && parseManualPrice(item.oldPriceUah) !== null
    && !Object.prototype.hasOwnProperty.call(manualPrices, item.productId)
    && !automaticProductIdSet.has(Number(item.productId))
  ));
}

export function keepCurrentManualPrices(
  items = [],
  manualPrices = {},
  reviewedProductIds = [],
  automaticProductIds = []
) {
  const unresolvedItems = getUnresolvedManualPriceItems(
    items,
    manualPrices,
    automaticProductIds
  );
  const nextManualPrices = { ...manualPrices };
  const nextReviewedProductIds = new Set(reviewedProductIds.map(Number));

  for (const item of unresolvedItems) {
    nextManualPrices[item.productId] = String(item.oldPriceUah ?? '');
    nextReviewedProductIds.add(Number(item.productId));
  }

  return {
    manualPrices: nextManualPrices,
    reviewedProductIds: [...nextReviewedProductIds]
      .sort((first, second) => first - second),
    automaticProductIds: [...new Set(automaticProductIds.map(Number))]
      .sort((first, second) => first - second),
    affectedProductIds: unresolvedItems.map((item) => Number(item.productId)),
  };
}

export function applyManualPrices(items = [], manualPrices = {}, automaticProductIds = []) {
  const automaticProductIdSet = new Set(automaticProductIds.map(Number));
  return items.map((item) => {
    if (automaticProductIdSet.has(Number(item.productId))) {
      const newPriceUah = parseAutomaticPrice(item.automaticPriceUah ?? item.newPriceUah);
      const canUseAutomatic = item.errorCode === 'manual_price' && newPriceUah !== null;
      if (!canUseAutomatic) return item;
      const oldPriceUah = item.oldPriceUah === null ? null : Number(item.oldPriceUah);
      const reasonCodes = (item.pricingChange?.reasonCodes || [])
        .filter((code) => code !== 'manual_override' && code !== 'use_automatic');
      const reasonLabels = (item.pricingChange?.reasonLabels || [])
        .filter((label) => (
          label !== 'Ціну скориговано вручну'
          && label !== 'Явно застосовано автоматичну ціну'
        ));
      return {
        ...item,
        newPriceUah,
        priceDeltaUah: newPriceUah - Number(oldPriceUah || 0),
        status: 'changed',
        manualOverride: false,
        useAutomatic: true,
        resolvedManualPrice: true,
        pricingState: 'automatic',
        pricingChange: {
          ...(item.pricingChange || {}),
          reasonCodes: [...reasonCodes, 'use_automatic'],
          reasonLabels: [
            ...reasonLabels,
            'Явно застосовано автоматичну ціну',
          ],
        },
      };
    }
    if (!Object.prototype.hasOwnProperty.call(manualPrices, item.productId)) return item;
    const newPriceUah = parseManualPrice(manualPrices[item.productId]);
    const resolvesManualPrice = item.status === 'error'
      && ['price_missing', 'manual_price'].includes(item.errorCode);
    if (newPriceUah === null || (item.status === 'error' && !resolvesManualPrice)) return item;
    const oldPriceUah = item.oldPriceUah === null ? null : Number(item.oldPriceUah);
    const calculatedPriceUah = item.calculatedPriceUah ?? item.newPriceUah ?? null;
    const reasonCodes = (item.pricingChange?.reasonCodes || [])
      .filter((code) => code !== 'manual_override' && code !== 'exchange_rate_only');
    const reasonLabels = (item.pricingChange?.reasonLabels || [])
      .filter((label) => (
        label !== 'Ціну скориговано вручну' && label !== 'Лише оновлення курсу'
      ));
    return {
      ...item,
      calculatedPriceUah,
      newPriceUah,
      priceDeltaUah: newPriceUah - Number(oldPriceUah || 0),
      status: resolvesManualPrice
        ? 'changed'
        : (oldPriceUah === null || oldPriceUah !== newPriceUah ? 'changed' : 'unchanged'),
      manualOverride: true,
      resolvedManualPrice: resolvesManualPrice,
      resolvedPriceMissing: resolvesManualPrice && item.errorCode === 'price_missing',
      pricingChange: {
        ...(item.pricingChange || {}),
        reasonCodes: [...reasonCodes, 'manual_override'],
        reasonLabels: [...reasonLabels, 'Ціну скориговано вручну'],
      },
    };
  });
}

function compareValues(first, second, direction) {
  const firstMissing = first === null || first === undefined || first === '';
  const secondMissing = second === null || second === undefined || second === '';
  if (firstMissing || secondMissing) {
    if (firstMissing && secondMissing) return 0;
    return firstMissing ? 1 : -1;
  }

  const multiplier = direction === 'desc' ? -1 : 1;
  if (typeof first === 'string' || typeof second === 'string') {
    return String(first).localeCompare(String(second), 'uk', {
      numeric: true,
      sensitivity: 'base',
    }) * multiplier;
  }
  return (Number(first) - Number(second)) * multiplier;
}

export function sortRepricingItems(items = [], sort = {}) {
  const key = sort.key || 'sku';
  const direction = sort.direction === 'desc' ? 'desc' : 'asc';
  return [...items].sort((first, second) => (
    compareValues(first[key], second[key], direction)
    || Number(first.productId) - Number(second.productId)
  ));
}

export function filterRepricingItems(items = [], {
  status = 'all',
  scenarioFilter = 'all',
  search = '',
  reviewFilter = 'all',
  reviewedProductIds = [],
} = {}) {
  const normalizedSearch = String(search || '').trim().toUpperCase();
  const reviewedIds = new Set(reviewedProductIds.map(Number));
  return items.filter((item) => {
    if (status !== 'all' && item.status !== status) return false;
    const itemScenario = item.scenarioId === null || item.scenarioId === undefined
      ? 'none'
      : String(item.scenarioId);
    if (scenarioFilter !== 'all' && itemScenario !== String(scenarioFilter)) return false;
    const isReviewed = reviewedIds.has(Number(item.productId));
    if (reviewFilter === 'pending' && isReviewed) return false;
    if (reviewFilter === 'reviewed' && !isReviewed) return false;
    return !normalizedSearch || String(item.sku || '').toUpperCase().includes(normalizedSearch);
  });
}

export function getRepricingSummary(baseSummary, items = []) {
  return {
    ...baseSummary,
    changedCount: items.filter((item) => item.status === 'changed').length,
    unchangedCount: items.filter((item) => item.status === 'unchanged').length,
    errorCount: items.filter((item) => item.status === 'error').length,
  };
}

export function canApplyRepricing({
  summary,
  invalidManualPriceCount = 0,
  draftConflictCount = 0,
  blockingCorrectionRequestCount = 0,
  isDraftStale = false,
} = {}) {
  return Number(summary?.changedCount || 0) > 0
    && Number(summary?.errorCount || 0) === 0
    && Number(invalidManualPriceCount || 0) === 0
    && Number(draftConflictCount || 0) === 0
    && Number(blockingCorrectionRequestCount || 0) === 0
    && !isDraftStale;
}
