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
      })),
  });
}

function getPreviewToken(scenario, applicableItems, {
  configurationToken = null,
  candidateBindings = [],
} = {}) {
  return hashPayload({
    scope: REPRICING_SCOPE_SCENARIO,
    configurationToken,
    scenario: getScenarioSnapshot(scenario),
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
      }))
      .sort((first, second) => first.productId - second.productId),
  };

  if (isGlobal) {
    return {
      scope: REPRICING_SCOPE_GLOBAL,
      scenarios: preview.scenarios || [],
      configurationToken: preview.configurationToken,
      ...snapshot,
    };
  }

  return {
    scenario: preview.scenario,
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
