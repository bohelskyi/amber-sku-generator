export function parseManualPrice(value) {
  const normalized = String(value ?? '').trim().replace(',', '.');
  if (!normalized) return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
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

export function applyManualPrices(items = [], manualPrices = {}) {
  return items.map((item) => {
    if (!Object.prototype.hasOwnProperty.call(manualPrices, item.productId)) return item;
    const newPriceUah = parseManualPrice(manualPrices[item.productId]);
    if (newPriceUah === null || item.status === 'error') return item;
    const oldPriceUah = item.oldPriceUah === null ? null : Number(item.oldPriceUah);
    return {
      ...item,
      calculatedPriceUah: item.newPriceUah,
      newPriceUah,
      priceDeltaUah: newPriceUah - Number(oldPriceUah || 0),
      status: oldPriceUah === null || oldPriceUah !== newPriceUah ? 'changed' : 'unchanged',
      manualOverride: true,
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

export function getRepricingSummary(baseSummary, items = []) {
  return {
    ...baseSummary,
    changedCount: items.filter((item) => item.status === 'changed').length,
    unchangedCount: items.filter((item) => item.status === 'unchanged').length,
    errorCount: items.filter((item) => item.status === 'error').length,
  };
}
