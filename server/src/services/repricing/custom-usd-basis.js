const { calculateDecisionPricing } = require('../product/correction-pricing-decision');
const {
  buildPricingChange,
  buildPricingState,
  toNullableNumber,
} = require('./pricing-state');

function getCustomUsdBasis(details) {
  const basis = details?.customUsdPerGramBasis;
  if (!basis || typeof basis !== 'object') return null;
  const usdPerGram = Number(basis.usdPerGram);
  if (!Number.isFinite(usdPerGram) || usdPerGram <= 0
      || typeof basis.marketingRoundingEnabled !== 'boolean') return null;
  return basis;
}

async function buildCustomUsdRepricingItem(product, details, answers, rateInfo) {
  const basis = getCustomUsdBasis(details);
  const pricing = await calculateDecisionPricing({
    mode: 'usd_per_gram',
    usdPerGram: Number(basis.usdPerGram),
    marketingRoundingEnabled: basis.marketingRoundingEnabled,
  }, product.weight, rateInfo);
  const oldPriceUah = toNullableNumber(product.total_price_uah);
  const newPriceUah = pricing.currencyPayload.totalPriceUah;
  const matrixName = details.logMessage || 'Власна ціна USD/г';
  const pricingChange = buildPricingChange(
    buildPricingState({
      details,
      pricePerGram: product.price_per_gram,
      uahRate: product.uah_rate,
      priceUah: oldPriceUah,
    }),
    buildPricingState({
      details,
      matrixName,
      priceMode: 'per_gram_usd',
      pricePerGram: basis.usdPerGram,
      uahRate: pricing.currencyPayload.uahRate,
      priceUah: newPriceUah,
    })
  );
  return {
    productId: Number(product.id),
    sku: product.full_sku,
    categoryCode: product.category,
    weight: toNullableNumber(product.weight),
    answers,
    oldPriceUah,
    calculatedPriceUah: pricing.currencyPayload.calculatedPriceUah,
    automaticPriceUah: newPriceUah,
    newPriceUah,
    priceDeltaUah: Number((newPriceUah - Number(oldPriceUah || 0)).toFixed(2)),
    status: oldPriceUah === null || Math.abs(oldPriceUah - newPriceUah) >= 0.005
      ? 'changed' : 'unchanged',
    errorCode: null,
    pricingState: 'automatic',
    matrixName,
    priceMode: 'per_gram_usd',
    pricePerGram: Number(basis.usdPerGram),
    totalPrice: Number(pricing.totalPrice),
    uahRate: pricing.currencyPayload.uahRate,
    uahRateDate: pricing.currencyPayload.uahRateDate || null,
    uahRateSource: pricing.currencyPayload.uahRateSource || null,
    uahRateFetchedAt: pricing.currencyPayload.uahRateFetchedAt || null,
    uahRateStale: Boolean(pricing.currencyPayload.uahRateStale),
    logMessage: matrixName,
    pricingDetails: { scenario: null, matrix: null, customUsdPerGram: true },
    pricingChange,
    customUsdPerGramBasis: basis,
  };
}

module.exports = { buildCustomUsdRepricingItem, getCustomUsdBasis };
