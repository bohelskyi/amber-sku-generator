const pool = require('../../db/pool');
const { calculatePricing } = require('../pricing.service');
const {
  loadPricingContexts,
  loadScenarioPricingContext,
} = require('../pricing/pricing-context');
const { getUsdUahRateInfo } = require('../currency.service');
const { toUahNumber } = require('../../utils/money');
const { asRuleObject, isRuleMatched } = require('../../utils/rules');
const { REPRICING_SCOPE_GLOBAL } = require('./constants');
const {
  buildPricingChange,
  buildPricingState,
  getPricingAnswers,
  getProductDetails,
  hasManualPrice,
  toNullableNumber,
} = require('./pricing-state');
const {
  getGlobalPreviewToken,
  getPreviewToken,
  getPricingContextSnapshot,
  getProductRepricingStateToken,
  getScenarioSnapshot,
  hashPayload,
} = require('./tokens');
const { getBlockingCorrectionRequests } = require('./correction-blockers');
const { startPhase } = require('../../observability/performance-metrics');

async function getActiveScenario(scenarioId) {
  const result = await pool.query(
    `SELECT *
     FROM price_scenarios
     WHERE id = $1 AND COALESCE(status, 'active') = 'active'
     LIMIT 1`,
    [Number(scenarioId)]
  );

  if (result.rows.length === 0) {
    const error = new Error('Активну цінову матрицю не знайдено.');
    error.statusCode = 404;
    throw error;
  }

  return result.rows[0];
}

async function getRepricingScenarios() {
  const result = await pool.query(
    `SELECT s.id, s.category_code, s.name, s.group_name, s.match_json, s.axis_x_key,
            s.axis_y_key, s.priority, s.price_mode, s.apply_modifiers,
            COUNT(p.id)::int AS active_products_in_category
     FROM price_scenarios s
     LEFT JOIN products p
       ON p.category = s.category_code
      AND COALESCE(p.status, 'active') = 'active'
     WHERE COALESCE(s.status, 'active') = 'active'
     GROUP BY s.id
     ORDER BY s.category_code, s.priority DESC, s.name, s.id`
  );

  return result.rows.map((scenario) => ({
    ...scenario,
    id: Number(scenario.id),
    priority: Number(scenario.priority || 0),
    active_products_in_category: Number(scenario.active_products_in_category || 0),
  }));
}

function buildErrorItem(product, details, answers, code, message) {
  return {
    productId: Number(product.id),
    sku: product.full_sku,
    weight: product.weight === null ? null : Number(product.weight),
    answers,
    oldPriceUah: product.total_price_uah === null ? null : Number(product.total_price_uah),
    totalPrice: product.total_price === null ? null : Number(product.total_price),
    pricePerGram: product.price_per_gram === null ? null : Number(product.price_per_gram),
    uahRate: product.uah_rate === null ? null : Number(product.uah_rate),
    status: 'error',
    errorCode: code,
    message,
    hasManualPrice: hasManualPrice(details),
  };
}

async function buildRepricingPreviewState(scenarioId) {
  const loadedPricing = await loadScenarioPricingContext(scenarioId);
  if (!loadedPricing) {
    const error = new Error('Активну цінову матрицю не знайдено.');
    error.statusCode = 404;
    throw error;
  }
  const { scenario, context: pricingContext } = loadedPricing;
  const configurationToken = hashPayload([getPricingContextSnapshot(pricingContext)]);
  let rateInfo = null;
  try {
    rateInfo = await getUsdUahRateInfo();
  } catch (error) {
    rateInfo = {
      rate: null,
      source: 'unavailable',
      rateDate: null,
      fetchedAt: null,
      ageMs: null,
      stale: false,
      error: String(error.message || error),
    };
  }
  const scenarioRule = asRuleObject(scenario.match_json);
  const productsResult = await pool.query(
    `SELECT id, full_sku, category, weight, total_price, total_price_uah,
            price_per_gram, uah_rate, details, status, exclude_from_export
     FROM products
     WHERE category = $1
       AND COALESCE(status, 'active') = 'active'
     ORDER BY id`,
    [scenario.category_code]
  );

  const finishProjection = startPhase('repricing.projection_and_tokens');
  const items = [];
  const candidateBindings = [];
  let skippedCount = 0;

  for (const product of productsResult.rows) {
    const details = getProductDetails(product);
    const answers = getPricingAnswers(product, details);
    if (!isRuleMatched(scenarioRule, answers)) continue;
    candidateBindings.push({
      productId: Number(product.id),
      productStateToken: getProductRepricingStateToken(product),
    });

    if (hasManualPrice(details)) {
      items.push(buildErrorItem(
        product,
        details,
        answers,
        'manual_price',
        'Товар має ручну ціну.'
      ));
      continue;
    }

    try {
      const pricing = await calculatePricing(
        product.category,
        answers,
        product.weight,
        answers.is_calibrated,
        { context: pricingContext, rateInfo }
      );
      const selectedScenarioId = Number(pricing.pricingDetails?.scenario?.id || 0);
      if (selectedScenarioId !== Number(scenario.id)) {
        skippedCount += 1;
        continue;
      }

      const calculatedPriceUah = toUahNumber(pricing.currencyPayload?.calculatedPriceUah);
      const newPriceUah = toUahNumber(pricing.currencyPayload?.totalPriceUah);
      if (!pricing.pricingDetails?.matrix || newPriceUah === null || newPriceUah <= 0) {
        items.push(buildErrorItem(
          product,
          details,
          answers,
          'price_missing',
          pricing.logMessage || 'Не вдалося розрахувати нову ціну.'
        ));
        continue;
      }

      const oldPriceUah = product.total_price_uah === null
        ? null
        : Number(product.total_price_uah);
      const isChanged = oldPriceUah === null || Math.abs(oldPriceUah - newPriceUah) >= 0.005;
      const matrixName = pricing.pricingDetails.scenario?.name || scenario.name;
      const priceMode = pricing.priceMode;
      const pricePerGram = Number(pricing.pricePerGram || 0);
      const uahRate = pricing.currencyPayload?.uahRate === null
        ? null
        : Number(pricing.currencyPayload?.uahRate);
      const pricingChange = buildPricingChange(
        buildPricingState({
          details,
          pricePerGram: product.price_per_gram,
          uahRate: product.uah_rate,
          priceUah: oldPriceUah,
        }),
        buildPricingState({
          details: { pricingScenario: pricing.pricingDetails.scenario },
          matrixName,
          priceMode,
          pricePerGram,
          uahRate,
          priceUah: newPriceUah,
        })
      );
      items.push({
        productId: Number(product.id),
        sku: product.full_sku,
        weight: product.weight === null ? null : Number(product.weight),
        answers,
        oldPriceUah,
        calculatedPriceUah,
        automaticPriceUah: newPriceUah,
        newPriceUah,
        priceDeltaUah: Number((newPriceUah - Number(oldPriceUah || 0)).toFixed(2)),
        status: isChanged ? 'changed' : 'unchanged',
        matrixName,
        priceMode,
        pricePerGram,
        totalPrice: Number(pricing.totalPrice || 0),
        uahRate,
        logMessage: pricing.logMessage,
        pricingDetails: pricing.pricingDetails,
        pricingChange,
      });
    } catch (error) {
      items.push(buildErrorItem(
        product,
        details,
        answers,
        'calculation_failed',
        error.message || 'Помилка розрахунку ціни.'
      ));
    }
  }

  const changedItems = items.filter((item) => item.status === 'changed');
  const unchangedItems = items.filter((item) => item.status === 'unchanged');
  const errorItems = items.filter((item) => item.status === 'error');
  const applicableItems = items.filter((item) => (
    item.status === 'changed' || ['price_missing', 'manual_price'].includes(item.errorCode)
  ));
  const blockingCorrectionRequests = await getBlockingCorrectionRequests(items);

  const preview = {
    scenario: getScenarioSnapshot(scenario),
    previewToken: getPreviewToken(scenario, applicableItems, {
      configurationToken,
      candidateBindings,
    }),
    summary: {
      candidateCount: items.length + skippedCount,
      changedCount: changedItems.length,
      unchangedCount: unchangedItems.length,
      skippedCount,
      errorCount: errorItems.length,
    },
    items,
    blockingCorrectionRequests,
  };
  finishProjection();
  return {
    preview,
    productStateTokensById: new Map(candidateBindings.map((binding) => (
      [binding.productId, binding.productStateToken]
    ))),
  };
}

async function buildRepricingPreview(scenarioId) {
  return (await buildRepricingPreviewState(scenarioId)).preview;
}

async function buildGlobalRepricingPreview() {
  const productsResult = await pool.query(
    `SELECT id, full_sku, category, weight, total_price, total_price_uah,
            price_per_gram, uah_rate, details, status, exclude_from_export
     FROM products
     WHERE COALESCE(status, 'active') = 'active'
     ORDER BY id`
  );
  const finishProjection = startPhase('repricing.projection_and_tokens');
  const categoryCodes = [...new Set(productsResult.rows.map((product) => product.category))]
    .filter(Boolean)
    .sort();
  const contextsByCategory = await loadPricingContexts(categoryCodes);
  const contexts = categoryCodes.map((categoryCode) => contextsByCategory.get(categoryCode));
  const configuration = contexts.map(getPricingContextSnapshot);
  const configurationToken = hashPayload(configuration);
  const scenarios = configuration.flatMap((context) => context.scenarios)
    .sort((first, second) => (
      String(first.categoryCode).localeCompare(String(second.categoryCode))
      || Number(first.id) - Number(second.id)
    ));
  let rateInfo = null;
  try {
    rateInfo = await getUsdUahRateInfo();
  } catch (error) {
    rateInfo = {
      rate: null,
      source: 'unavailable',
      rateDate: null,
      fetchedAt: null,
      ageMs: null,
      stale: false,
      error: String(error.message || error),
    };
  }

  const items = [];
  for (const product of productsResult.rows) {
    const details = getProductDetails(product);
    const answers = getPricingAnswers(product, details);
    const oldPriceUah = toNullableNumber(product.total_price_uah);
    const baseItem = {
      productId: Number(product.id),
      productStateToken: getProductRepricingStateToken(product),
      sku: product.full_sku,
      categoryCode: product.category,
      weight: toNullableNumber(product.weight),
      answers,
      oldPriceUah,
      totalPrice: toNullableNumber(product.total_price),
      pricePerGram: toNullableNumber(product.price_per_gram),
      uahRate: toNullableNumber(product.uah_rate),
      hasManualPrice: hasManualPrice(details),
    };

    try {
      const pricing = await calculatePricing(
        product.category,
        answers,
        product.weight,
        answers.is_calibrated,
        { context: contextsByCategory.get(product.category), rateInfo }
      );
      const selectedScenario = pricing.pricingDetails?.scenario || null;
      const matrixName = selectedScenario?.name || null;
      const calculatedPriceUah = toUahNumber(pricing.currencyPayload?.calculatedPriceUah);
      const newPriceUah = toUahNumber(pricing.currencyPayload?.totalPriceUah);
      const priceMode = pricing.priceMode;
      const pricePerGram = Number(pricing.pricePerGram || 0);
      const uahRate = pricing.currencyPayload?.uahRate === null
        ? null
        : Number(pricing.currencyPayload?.uahRate);
      const pricingChange = buildPricingChange(
        buildPricingState({
          details,
          pricePerGram: product.price_per_gram,
          uahRate: product.uah_rate,
          priceUah: oldPriceUah,
        }),
        buildPricingState({
          details: { pricingScenario: selectedScenario },
          matrixName,
          priceMode,
          pricePerGram,
          uahRate,
          priceUah: newPriceUah,
        })
      );
      const calculated = {
        ...baseItem,
        scenarioId: selectedScenario ? Number(selectedScenario.id) : null,
        scenarioName: selectedScenario?.name || null,
        matrixName,
        priceMode,
        pricePerGram,
        totalPrice: Number(pricing.totalPrice || 0),
        newPriceUah,
        calculatedPriceUah,
        automaticPriceUah: newPriceUah,
        priceDeltaUah: newPriceUah === null
          ? null
          : Number((newPriceUah - Number(oldPriceUah || 0)).toFixed(2)),
        uahRate,
        logMessage: pricing.logMessage,
        pricingDetails: pricing.pricingDetails,
        pricingChange,
      };

      if (hasManualPrice(details)) {
        items.push({
          ...calculated,
          status: 'error',
          errorCode: 'manual_price',
          message: 'Товар має ручну ціну. Підтвердьте або змініть її явно.',
          pricingState: 'manual',
        });
        continue;
      }

      if (!pricing.pricingDetails?.matrix || newPriceUah === null || newPriceUah <= 0) {
        items.push({
          ...calculated,
          status: 'error',
          errorCode: 'price_missing',
          message: pricing.logMessage || 'Не вдалося розрахувати нову ціну.',
          pricingState: 'missing',
        });
        continue;
      }

      const isChanged = oldPriceUah === null || Math.abs(oldPriceUah - newPriceUah) >= 0.005;
      items.push({
        ...calculated,
        status: isChanged ? 'changed' : 'unchanged',
        errorCode: null,
        pricingState: 'automatic',
      });
    } catch (error) {
      items.push({
        ...baseItem,
        scenarioId: null,
        scenarioName: null,
        matrixName: null,
        newPriceUah: null,
        calculatedPriceUah: null,
        priceDeltaUah: null,
        status: 'error',
        errorCode: 'calculation_failed',
        message: error.message || 'Помилка розрахунку ціни.',
        pricingState: hasManualPrice(details) ? 'manual' : 'missing',
      });
    }
  }

  const blockingCorrectionRequests = await getBlockingCorrectionRequests(items);
  const preview = {
    scope: REPRICING_SCOPE_GLOBAL,
    scenarios,
    configurationToken,
    previewToken: getGlobalPreviewToken(configurationToken, items),
    summary: {
      candidateCount: items.length,
      changedCount: items.filter((item) => item.status === 'changed').length,
      unchangedCount: items.filter((item) => item.status === 'unchanged').length,
      skippedCount: items.filter((item) => item.status === 'skipped').length,
      errorCount: items.filter((item) => item.status === 'error').length,
    },
    items,
    blockingCorrectionRequests,
  };
  finishProjection();
  return preview;
}

module.exports = {
  buildGlobalRepricingPreview,
  buildRepricingPreview,
  buildRepricingPreviewState,
  getActiveScenario,
  getRepricingScenarios,
};
