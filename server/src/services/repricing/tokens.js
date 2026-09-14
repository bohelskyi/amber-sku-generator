const crypto = require('node:crypto');
const {
  getPricingContextSnapshot,
  getScenarioSnapshot,
  hashPayload,
} = require('../pricing/pricing-context-fingerprint');
const {
  REPRICING_SCOPE_GLOBAL,
  REPRICING_SCOPE_SCENARIO,
} = require('./constants');
const { getProductRepricingState } = require('./pricing-state');

function getScenarioSelectionSnapshot(scenario) {
  return {
    id: Number(scenario.id),
    categoryCode: scenario.category_code || scenario.categoryCode,
    priority: Number(scenario.priority || 0),
    matchJson: scenario.match_json || scenario.matchJson || {},
  };
}

function getProductRepricingStateToken(product) {
  return hashPayload(getProductRepricingState(product));
}

function getGlobalPreviewToken(configurationToken, items) {
  return hashPayload({
    scope: REPRICING_SCOPE_GLOBAL,
    configurationToken,
    items: [...items]
      .sort((first, second) => Number(first.productId) - Number(second.productId))
      .map((item) => ({
        productId: Number(item.productId),
        productStateToken: item.productStateToken,
        scenarioId: item.scenarioId ?? null,
        oldPriceUah: item.oldPriceUah ?? null,
        calculatedPriceUah: item.calculatedPriceUah ?? null,
        automaticPriceUah: item.automaticPriceUah ?? null,
        newPriceUah: item.newPriceUah ?? null,
        status: item.status,
        errorCode: item.errorCode || null,
        pricingState: item.pricingState,
        pricingChange: item.pricingChange || null,
        ...(item.customUsdPerGramBasis ? {
          customUsdPerGramBasis: item.customUsdPerGramBasis,
          uahRateDate: item.uahRateDate || null,
        } : {}),
      })),
  });
}

function getPreviewToken(scenario, applicableItems, {
  configurationToken = null,
  candidateBindings = [],
  customOnlyPricing = false,
} = {}) {
  return hashPayload({
    scope: REPRICING_SCOPE_SCENARIO,
    configurationToken,
    scenario: customOnlyPricing
      ? getScenarioSelectionSnapshot(scenario) : getScenarioSnapshot(scenario),
    candidates: [...candidateBindings]
      .sort((first, second) => Number(first.productId) - Number(second.productId))
      .map((binding) => ({
        productId: Number(binding.productId),
        productStateToken: binding.productStateToken,
      })),
    changes: [...applicableItems]
      .sort((first, second) => Number(first.productId) - Number(second.productId))
      .map((item) => ({
        productId: item.productId,
        sku: item.sku,
        weight: item.weight ?? null,
        answers: item.answers || {},
        oldPriceUah: item.oldPriceUah,
        calculatedPriceUah: item.calculatedPriceUah ?? null,
        automaticPriceUah: item.automaticPriceUah ?? null,
        newPriceUah: item.newPriceUah ?? null,
        status: item.status,
        errorCode: item.errorCode || null,
        pricingChange: item.pricingChange || null,
        ...(item.customUsdPerGramBasis ? {
          customUsdPerGramBasis: item.customUsdPerGramBasis,
          uahRateDate: item.uahRateDate || null,
        } : {}),
      })),
  });
}

function getRepricingPreviewSnapshot(preview) {
  const isGlobal = preview.scope === REPRICING_SCOPE_GLOBAL;
  const snapshot = {
    summary: preview.summary,
    items: [...(preview.items || [])]
      .map((item) => ({
        productId: Number(item.productId),
        sku: item.sku,
        ...(isGlobal ? {
          categoryCode: item.categoryCode || null,
          scenarioId: item.scenarioId ?? null,
          scenarioName: item.scenarioName || null,
          productStateToken: item.productStateToken || null,
        } : {}),
        oldPriceUah: item.oldPriceUah ?? null,
        calculatedPriceUah: item.calculatedPriceUah ?? null,
        automaticPriceUah: item.automaticPriceUah ?? null,
        newPriceUah: item.newPriceUah ?? null,
        status: item.status,
        errorCode: item.errorCode || null,
        uahRate: item.uahRate ?? null,
        matrixName: item.matrixName || null,
        pricingChange: item.pricingChange || null,
        ...(item.customUsdPerGramBasis ? {
          customUsdPerGramBasis: item.customUsdPerGramBasis,
          uahRateDate: item.uahRateDate || null,
        } : {}),
      }))
      .sort((first, second) => first.productId - second.productId),
  };

  if (isGlobal) {
    return {
      scope: REPRICING_SCOPE_GLOBAL,
      scenarios: preview.bindingScenarios
        || (preview.customOnlyPricing ? [] : (preview.scenarios || [])),
      configurationToken: preview.configurationToken,
      ...snapshot,
    };
  }

  return {
    scenario: preview.customOnlyPricing
      ? getScenarioSelectionSnapshot(preview.scenario) : preview.scenario,
    bindingToken: preview.previewToken || null,
    ...snapshot,
  };
}

function getRepricingPreviewFingerprint(preview) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(getRepricingPreviewSnapshot(preview)))
    .digest('hex');
}

module.exports = {
  getGlobalPreviewToken,
  getPreviewToken,
  getPricingContextSnapshot,
  getProductRepricingStateToken,
  getRepricingPreviewFingerprint,
  getRepricingPreviewSnapshot,
  getScenarioSnapshot,
  hashPayload,
};
