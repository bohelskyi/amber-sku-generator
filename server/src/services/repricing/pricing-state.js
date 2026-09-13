const { isDeepStrictEqual } = require('node:util');

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

function hasManualPrice(details) {
  const value = details.manualPriceUah;
  return value !== null && value !== undefined && value !== '';
}

function getProductRepricingState(product) {
  return {
    id: Number(product.id),
    sku: product.full_sku,
    category: product.category,
    weight: toNullableNumber(product.weight),
    totalPrice: toNullableNumber(product.total_price),
    totalPriceUah: toNullableNumber(product.total_price_uah),
    pricePerGram: toNullableNumber(product.price_per_gram),
    uahRate: toNullableNumber(product.uah_rate),
    details: getProductDetails(product),
    status: product.status || 'active',
    excludeFromExport: Number(product.exclude_from_export || 0),
  };
}

function areNullableNumbersEqual(first, second, tolerance = 0.01) {
  if (first === null || first === undefined) return second === null || second === undefined;
  if (second === null || second === undefined) return false;
  return Math.abs(Number(first) - Number(second)) <= tolerance;
}

const REPRICING_PAYLOAD_NUMBER_KEYS = [
  'totalPrice',
  'totalPriceUah',
  'pricePerGram',
  'uahRate',
];

function normalizeRecordedRepricingPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (!Object.hasOwn(payload, 'details')) return null;
  if (!payload.details || typeof payload.details !== 'object' || Array.isArray(payload.details)) {
    return null;
  }

  const normalized = { details: payload.details };
  for (const key of REPRICING_PAYLOAD_NUMBER_KEYS) {
    if (!Object.hasOwn(payload, key)) return null;
    const value = payload[key];
    if (value === null) {
      normalized[key] = null;
      continue;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    normalized[key] = number;
  }
  return normalized;
}

function doesProductMatchRepricingBatch(product, newPayload, batchId) {
  const recordedPayload = normalizeRecordedRepricingPayload(newPayload);
  if (!recordedPayload) return false;
  const currentPayload = {
    totalPrice: toNullableNumber(product.total_price),
    totalPriceUah: toNullableNumber(product.total_price_uah),
    pricePerGram: toNullableNumber(product.price_per_gram),
    uahRate: toNullableNumber(product.uah_rate),
    details: getProductDetails(product),
  };
  return (
    String(product.status || 'active') === 'active'
    && Number(product.details?.repricing?.batchId || 0) === Number(batchId)
    && isDeepStrictEqual(currentPayload, recordedPayload)
  );
}

module.exports = {
  areNullableNumbersEqual,
  buildPricingChange,
  buildPricingState,
  doesProductMatchRepricingBatch,
  getPricingAnswers,
  getProductDetails,
  getProductRepricingState,
  hasManualPrice,
  toNullableNumber,
};
