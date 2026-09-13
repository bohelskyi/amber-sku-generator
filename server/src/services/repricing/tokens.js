const crypto = require('node:crypto');
const { asRuleObject } = require('../../utils/rules');
const {
  REPRICING_SCOPE_GLOBAL,
  REPRICING_SCOPE_SCENARIO,
} = require('./constants');
const { getProductRepricingState } = require('./pricing-state');

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

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJsonValue(value[key])])
  );
}

function hashPayload(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(sortJsonValue(value)))
    .digest('hex');
}

function getPricingContextSnapshot(context) {
  const scenarios = [...(context.scenarios || [])]
    .sort((first, second) => Number(first.id) - Number(second.id))
    .map(getScenarioSnapshot);
  const weightBands = [...(context.weightBandsByScenario || new Map()).entries()]
    .flatMap(([scenarioId, bands]) => bands.map((band) => ({
      scenarioId: Number(scenarioId),
      id: Number(band.id),
      label: band.label,
      minWeight: Number(band.min_weight),
      maxWeight: band.max_weight === null ? null : Number(band.max_weight),
      sortOrder: Number(band.sort_order || 0),
    })))
    .sort((first, second) => (
      first.scenarioId - second.scenarioId
      || first.sortOrder - second.sortOrder
      || first.id - second.id
    ));
  const matrix = [...(context.matrixByCell || new Map()).values()]
    .map((cell) => ({
      scenarioId: Number(cell.scenario_id),
      xVal: Number(cell.x_val),
      yVal: Number(cell.y_val),
      price: Number(cell.price),
    }))
    .sort((first, second) => (
      first.scenarioId - second.scenarioId
      || first.xVal - second.xVal
      || first.yVal - second.yVal
    ));
  const modifiers = [...(context.modifiers || [])]
    .map((modifier) => ({
      id: Number(modifier.id),
      triggerKey: modifier.trigger_key || '',
      triggerVal: modifier.trigger_val === null ? null : Number(modifier.trigger_val),
      matchJson: asRuleObject(modifier.match_json),
      factor: modifier.factor === null ? null : Number(modifier.factor),
    }))
    .sort((first, second) => first.id - second.id);

  return {
    categoryCode: context.categoryCode,
    requiresWeight: Number(context.category?.requires_weight || 0),
    scenarios,
    weightBands,
    matrix,
    modifiers,
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
