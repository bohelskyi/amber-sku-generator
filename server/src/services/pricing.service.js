const pool = require('../db/pool');
const { getUsdUahRateInfo } = require('./currency.service');
const {
  calculatePricingBase,
  finalizePricing,
} = require('./pricing/pricing-calculator');
const { loadPricingContext } = require('./pricing/pricing-context');
const { getAdminPrices } = require('./pricing/pricing-read-model');
const {
  upsertPriceCell,
  createScenario,
  updateScenario,
  duplicateScenario,
  createModifier,
  updateModifier,
} = require('./pricing/pricing-admin-commands');

async function calculatePricing(
  categoryCode,
  answers = {},
  weight,
  isCalibrated,
  { queryable = pool, context = null, rateInfo = null } = {}
) {
  const pricingContext = context || await loadPricingContext(categoryCode, queryable);
  const baseCalculation = calculatePricingBase({
    categoryCode,
    answers,
    weight,
    isCalibrated,
    context: pricingContext,
  });

  let resolvedRateInfo = rateInfo;
  let rateError = null;
  try {
    resolvedRateInfo = rateInfo || await getUsdUahRateInfo();
  } catch (err) {
    rateError = err;
  }

  return finalizePricing(baseCalculation, {
    rateInfo: resolvedRateInfo,
    rateError,
  });
}

module.exports = {
  calculatePricing,
  loadPricingContext,
  getAdminPrices,
  upsertPriceCell,
  createScenario,
  updateScenario,
  duplicateScenario,
  createModifier,
  updateModifier,
};
