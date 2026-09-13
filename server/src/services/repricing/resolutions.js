const crypto = require('node:crypto');
const { toUahNumber } = require('../../utils/money');
const { REPRICING_SCOPE_GLOBAL } = require('./constants');

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
    const newPriceUah = toUahNumber(parsedPrice);
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

function normalizeAutomaticProductIds(productIds = []) {
  if (!Array.isArray(productIds) || productIds.length > 10000) {
    const error = new Error('Некоректний список автоматичних рішень.');
    error.statusCode = 400;
    throw error;
  }

  const normalized = productIds.map(Number);
  if (normalized.some((productId) => !Number.isInteger(productId) || productId <= 0)) {
    const error = new Error('Товар для автоматичної ціни має бути коректним.');
    error.statusCode = 422;
    throw error;
  }
  return [...new Set(normalized)].sort((first, second) => first - second);
}

function assertDistinctPricingResolutions(manualOverrides, automaticProductIds) {
  const manualProductIds = new Set(manualOverrides.map((item) => item.productId));
  const duplicateProductId = automaticProductIds.find((productId) => manualProductIds.has(productId));
  if (duplicateProductId) {
    const error = new Error(`Для товару ${duplicateProductId} оберіть лише один спосіб визначення ціни.`);
    error.statusCode = 422;
    throw error;
  }
}

function normalizeStoredPricingResolutions(payload) {
  if (Array.isArray(payload) || payload === null || payload === undefined) {
    return {
      manualOverrides: normalizeManualOverrides(payload || []),
      automaticProductIds: [],
    };
  }
  if (!payload || typeof payload !== 'object') {
    const error = new Error('Некоректні збережені рішення переоцінки.');
    error.statusCode = 400;
    throw error;
  }

  const manualOverrides = normalizeManualOverrides(payload.manualOverrides || []);
  const automaticProductIds = normalizeAutomaticProductIds(payload.automaticProductIds || []);
  assertDistinctPricingResolutions(manualOverrides, automaticProductIds);
  return { manualOverrides, automaticProductIds };
}

function serializePricingResolutions(manualOverrides, automaticProductIds) {
  if (automaticProductIds.length === 0) return manualOverrides;
  return { manualOverrides, automaticProductIds };
}

function getApplicationToken(previewToken, manualOverrides = [], automaticProductIds = []) {
  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  const normalizedAutomaticProductIds = normalizeAutomaticProductIds(automaticProductIds);
  assertDistinctPricingResolutions(normalizedOverrides, normalizedAutomaticProductIds);
  if (normalizedOverrides.length === 0 && normalizedAutomaticProductIds.length === 0) {
    return previewToken;
  }
  const payload = {
    previewToken,
    manualOverrides: normalizedOverrides,
    ...(normalizedAutomaticProductIds.length > 0
      ? { automaticProductIds: normalizedAutomaticProductIds }
      : {}),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function addAutomaticResolutionReason(pricingChange = {}) {
  const reasonCodes = (pricingChange.reasonCodes || [])
    .filter((code) => code !== 'manual_override' && code !== 'use_automatic');
  const reasonLabels = (pricingChange.reasonLabels || [])
    .filter((label) => (
      label !== 'Ціну скориговано вручну'
      && label !== 'Явно застосовано автоматичну ціну'
    ));
  return {
    ...pricingChange,
    reasonCodes: [...reasonCodes, 'use_automatic'],
    reasonLabels: [...reasonLabels, 'Явно застосовано автоматичну ціну'],
  };
}

function applyManualOverridesToPreview(
  preview,
  manualOverrides = [],
  automaticProductIds = []
) {
  const normalizedOverrides = normalizeManualOverrides(manualOverrides);
  const normalizedAutomaticProductIds = normalizeAutomaticProductIds(automaticProductIds);
  assertDistinctPricingResolutions(normalizedOverrides, normalizedAutomaticProductIds);
  const overridesByProductId = new Map(
    normalizedOverrides.map((override) => [override.productId, override.newPriceUah])
  );
  const automaticProductIdSet = new Set(normalizedAutomaticProductIds);
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

  for (const productId of normalizedAutomaticProductIds) {
    const item = itemsByProductId.get(productId);
    if (!item) {
      const error = new Error(`Товар ${productId} не належить до цього перегляду переоцінки.`);
      error.statusCode = 422;
      throw error;
    }
    const automaticPriceUah = toUahNumber(item.automaticPriceUah ?? item.newPriceUah);
    const hasAutomaticPrice = preview.scope === REPRICING_SCOPE_GLOBAL
      && item.errorCode === 'manual_price'
      && item.pricingDetails?.matrix
      && automaticPriceUah !== null
      && automaticPriceUah > 0;
    if (!hasAutomaticPrice) {
      const error = new Error(`Для товару ${item.sku} зараз немає дійсної автоматичної ціни.`);
      error.statusCode = 422;
      throw error;
    }
  }

  const items = preview.items.map((item) => {
    if (automaticProductIdSet.has(Number(item.productId))) {
      const newPriceUah = toUahNumber(item.automaticPriceUah ?? item.newPriceUah);
      return {
        ...item,
        newPriceUah,
        priceDeltaUah: newPriceUah - Number(item.oldPriceUah || 0),
        status: 'changed',
        manualOverride: false,
        useAutomatic: true,
        resolvedManualPrice: true,
        pricingState: 'automatic',
        pricingChange: addAutomaticResolutionReason(item.pricingChange),
      };
    }
    if (!overridesByProductId.has(Number(item.productId))) return item;

    const newPriceUah = overridesByProductId.get(Number(item.productId));
    const resolvesManualPrice = item.status === 'error'
      && ['price_missing', 'manual_price'].includes(item.errorCode);
    const calculatedPriceUah = item.calculatedPriceUah ?? item.newPriceUah ?? null;
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
      calculatedPriceUah,
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

module.exports = {
  applyManualOverridesToPreview,
  assertDistinctPricingResolutions,
  getApplicationToken,
  normalizeAutomaticProductIds,
  normalizeManualOverrides,
  normalizeStoredPricingResolutions,
  serializePricingResolutions,
};
