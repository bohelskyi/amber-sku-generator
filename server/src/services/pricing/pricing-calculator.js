const { resolveAxisValue } = require('../../utils/pricing-axis');
const {
  normalizePriceMode,
  resolveWeightBand,
  sortScenariosByPrecedence,
} = require('../../utils/pricing-scenarios');
const { asRuleObject, getRuleDependencies, isRuleMatched } = require('../../utils/rules');
const { roundAutomaticUah } = require('../../utils/money');

function getAnswerValue(answers, key) {
  return answers[key] === undefined || answers[key] === null || answers[key] === ''
    ? 0
    : Number(answers[key]);
}

function isPricingRuleMatched(ruleJson, answers, normalizedCalibrated) {
  const context = {
    ...answers,
    is_calibrated: normalizedCalibrated,
  };
  for (const key of getRuleDependencies(ruleJson)) {
    if (context[key] === undefined || context[key] === null || context[key] === '') {
      context[key] = getAnswerValue(answers, key);
    }
  }
  return isRuleMatched(ruleJson, context);
}

function axisUsesKey(axisKey, targetKey) {
  return String(axisKey || '')
    .split('+')
    .map((key) => key.trim())
    .includes(targetKey);
}

function getAxisKeys(axisKey) {
  return String(axisKey || '')
    .split('+')
    .map((key) => key.trim())
    .filter(Boolean);
}

function getAxisDependentKeys(axisKey) {
  return getAxisKeys(axisKey).map((key) => (key === 'weight_band' ? 'weight' : key));
}

function getRuleKeys(ruleJson) {
  return getRuleDependencies(ruleJson);
}

function uniqueKeys(keys) {
  return Array.from(new Set(keys.filter(Boolean)));
}

function getPricingWeight(answers = {}, weight) {
  const parsedWeight = Number.parseFloat(weight);
  if (Number.isFinite(parsedWeight) && parsedWeight > 0) return parsedWeight;

  const answerWeight = Number.parseFloat(answers.weight);
  return Number.isFinite(answerWeight) ? answerWeight : 0;
}

function getEffectivePriceMode(scenario, categoryRequiresWeight, scenarioUsesWeight) {
  const configuredMode = normalizePriceMode(scenario?.price_mode);
  if (configuredMode !== 'category_default') return configuredMode;
  return categoryRequiresWeight || scenarioUsesWeight ? 'per_gram_usd' : 'fixed_uah';
}

function resolveScenarioAxisValue(axisKey, answers, weight, weightBands) {
  if (axisKey === 'weight_band') {
    return resolveWeightBand(weightBands, weight)?.id ?? null;
  }

  return resolveAxisValue(axisKey, answers);
}

function describeScenario(scenario) {
  return {
    id: scenario.id,
    name: scenario.name,
    group_name: scenario.group_name || '',
    match_json: asRuleObject(scenario.match_json),
    axis_x_key: scenario.axis_x_key,
    axis_y_key: scenario.axis_y_key,
    priority: Number(scenario.priority || 0),
    status: scenario.status || 'active',
    price_mode: normalizePriceMode(scenario.price_mode),
    apply_modifiers: scenario.apply_modifiers !== false,
  };
}

function calculatePricingBase({
  categoryCode,
  answers = {},
  weight,
  isCalibrated,
  context,
}) {
  if (context.categoryCode !== categoryCode) {
    throw new Error(`Pricing context does not belong to category ${categoryCode}`);
  }

  let pricePerGram = 0;
  let fixedPriceUah = null;
  let logMessage;
  const calibratedAnswer =
    answers.is_calibrated !== undefined &&
    answers.is_calibrated !== null &&
    answers.is_calibrated !== ''
      ? answers.is_calibrated
      : isCalibrated;
  const normalizedCalibrated = Number(calibratedAnswer || 0);
  const weightVal = getPricingWeight(answers, weight);
  let pricingDetails = null;

  const activeScenario = sortScenariosByPrecedence(context.scenarios).find((scenario) => {
    return isPricingRuleMatched(scenario.match_json, answers, normalizedCalibrated);
  });
  const categoryRequiresWeight = Boolean(
    context.category && Number(context.category.requires_weight) === 1
  );
  const scenarioUsesWeight =
    activeScenario &&
    (axisUsesKey(activeScenario.axis_x_key, 'weight') ||
      axisUsesKey(activeScenario.axis_y_key, 'weight') ||
      axisUsesKey(activeScenario.axis_x_key, 'weight_band') ||
      axisUsesKey(activeScenario.axis_y_key, 'weight_band'));
  const priceMode = getEffectivePriceMode(
    activeScenario,
    categoryRequiresWeight,
    scenarioUsesWeight
  );
  const isWeightBased = priceMode === 'per_gram_usd';
  const usesWeight = categoryRequiresWeight || scenarioUsesWeight;

  if (activeScenario) {
    const matrixAnswers = scenarioUsesWeight ? { ...answers, weight: 0 } : answers;
    const weightBands = context.weightBandsByScenario.get(Number(activeScenario.id)) || [];
    const xVal = resolveScenarioAxisValue(
      activeScenario.axis_x_key,
      matrixAnswers,
      weightVal,
      weightBands
    );
    const yVal = resolveScenarioAxisValue(
      activeScenario.axis_y_key,
      matrixAnswers,
      weightVal,
      weightBands
    );

    const matrixRow = xVal === null || yVal === null
      ? null
      : context.matrixByCell.get(
          `${Number(activeScenario.id)}:${Number(xVal)}:${Number(yVal)}`
        );

    if (matrixRow) {
      const basePrice = Number(matrixRow.price);
      const matchedModifiers = [];
      let calculatedPrice = basePrice;
      logMessage = `${activeScenario.name} (Базова: ${isWeightBased ? `$${calculatedPrice}` : `${calculatedPrice} ₴`})`;

      const modifiers = activeScenario.apply_modifiers === false ? [] : context.modifiers;
      for (const modifier of modifiers) {
        const modifierRule = Object.keys(asRuleObject(modifier.match_json)).length > 0
          ? modifier.match_json
          : { [modifier.trigger_key]: modifier.trigger_val };

        if (isPricingRuleMatched(modifierRule, answers, normalizedCalibrated)) {
          calculatedPrice *= Number(modifier.factor);
          matchedModifiers.push({
            id: modifier.id,
            factor: Number(modifier.factor),
            match_json: asRuleObject(modifierRule),
            dependentKeys: getRuleKeys(modifierRule),
          });
          logMessage += ` + Модифікатор (${Math.round((Number(modifier.factor) - 1) * 100)}%)`;
        }
      }

      pricePerGram = isWeightBased ? calculatedPrice : 0;
      fixedPriceUah = priceMode === 'fixed_uah' ? calculatedPrice : null;
      pricingDetails = {
        isWeightBased,
        usesWeight,
        priceMode,
        calibratedValue: normalizedCalibrated,
        scenario: describeScenario(activeScenario),
        matrix: {
          x: {
            key: activeScenario.axis_x_key,
            value: xVal,
            label: activeScenario.axis_x_key === 'weight_band'
              ? weightBands.find((band) => Number(band.id) === Number(xVal))?.label || null
              : null,
            dependentKeys: getAxisDependentKeys(activeScenario.axis_x_key),
          },
          y: {
            key: activeScenario.axis_y_key,
            value: yVal,
            label: activeScenario.axis_y_key === 'weight_band'
              ? weightBands.find((band) => Number(band.id) === Number(yVal))?.label || null
              : null,
            dependentKeys: getAxisDependentKeys(activeScenario.axis_y_key),
          },
        },
        basePrice,
        finalPricePerGram: isWeightBased ? pricePerGram : null,
        finalFixedPriceUah: fixedPriceUah,
        matchedModifiers,
        dependentKeys: uniqueKeys([
          ...getRuleKeys(activeScenario.match_json),
          ...getAxisDependentKeys(activeScenario.axis_x_key),
          ...getAxisDependentKeys(activeScenario.axis_y_key),
          ...matchedModifiers.flatMap((modifier) => modifier.dependentKeys),
        ]),
      };
    } else {
      logMessage = `${activeScenario.name} (Нема ціни для комбінації)`;
    }
  } else {
    logMessage = 'Немає сценарію для цих параметрів';
  }

  return {
    weightVal,
    pricePerGram,
    fixedPriceUah,
    priceMode,
    usesWeight,
    totalPrice: isWeightBased ? (pricePerGram * weightVal).toFixed(2) : '0.00',
    logMessage,
    pricingDetails: pricingDetails || {
      isWeightBased,
      usesWeight,
      priceMode,
      calibratedValue: normalizedCalibrated,
      scenario: activeScenario ? describeScenario(activeScenario) : null,
      matrix: null,
      basePrice: null,
      finalPricePerGram: isWeightBased ? pricePerGram : null,
      finalFixedPriceUah: fixedPriceUah,
      matchedModifiers: [],
      dependentKeys: activeScenario
        ? uniqueKeys([
            ...getRuleKeys(activeScenario.match_json),
            ...getAxisDependentKeys(activeScenario.axis_x_key),
            ...getAxisDependentKeys(activeScenario.axis_y_key),
          ])
        : [],
    },
    isWeightBased,
  };
}

function finalizePricing(baseCalculation, { rateInfo = null, rateError = null } = {}) {
  const {
    isWeightBased,
    weightVal,
    pricePerGram,
    fixedPriceUah,
  } = baseCalculation;
  let { totalPrice } = baseCalculation;
  let currencyPayload = {
    uahRate: null,
    pricePerGramUah: null,
    calculatedPriceUah: null,
    totalPriceUah: null,
  };

  try {
    if (rateError) throw rateError;
    const uahRate = Number(rateInfo.rate);
    if (!Number.isFinite(uahRate) || uahRate <= 0) {
      throw new Error(rateInfo.error || 'USD/UAH rate is unavailable');
    }
    if (isWeightBased) {
      const calculatedPriceUah = pricePerGram > 0
        ? pricePerGram * weightVal * uahRate
        : null;
      currencyPayload = {
        uahRate,
        pricePerGramUah: (pricePerGram * uahRate).toFixed(2),
        calculatedPriceUah,
        totalPriceUah: roundAutomaticUah(calculatedPriceUah),
      };
    } else {
      totalPrice = uahRate > 0 ? (Number(fixedPriceUah || 0) / uahRate).toFixed(2) : '0.00';
      const calculatedPriceUah = fixedPriceUah !== null && Number(fixedPriceUah) > 0
        ? Number(fixedPriceUah)
        : null;
      currencyPayload = {
        uahRate,
        pricePerGramUah: null,
        calculatedPriceUah,
        totalPriceUah: roundAutomaticUah(calculatedPriceUah),
      };
    }
    currencyPayload = {
      ...currencyPayload,
      uahRateSource: rateInfo.source,
      uahRateDate: rateInfo.rateDate,
      uahRateFetchedAt: rateInfo.fetchedAt,
      uahRateAgeMs: rateInfo.ageMs,
      uahRateStale: Boolean(rateInfo.stale),
      uahRateError: rateInfo.error || null,
    };
  } catch (err) {
    if (!isWeightBased) {
      currencyPayload = {
        uahRate: null,
        pricePerGramUah: null,
        calculatedPriceUah: fixedPriceUah,
        totalPriceUah: roundAutomaticUah(fixedPriceUah),
      };
    }
    currencyPayload = {
      ...currencyPayload,
      uahRateError: String(err.message || err),
    };
  }

  const publicCalculation = { ...baseCalculation };
  delete publicCalculation.isWeightBased;
  return {
    ...publicCalculation,
    totalPrice,
    currencyPayload,
  };
}

module.exports = { calculatePricingBase, finalizePricing };
