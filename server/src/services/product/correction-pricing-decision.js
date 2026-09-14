const { getUsdUahRateInfo } = require('../currency.service');
const { roundAutomaticUah } = require('../../utils/money');

function invalidDecision(message) {
  const error = new Error(message);
  error.statusCode = 422;
  return error;
}

function positiveDecimal(value, name, scale) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw invalidDecision(`${name} має бути додатним числом.`);
  }
  const text = String(value).trim().replace(',', '.');
  const number = Number(text);
  if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(number)
      || number <= 0 || Number(number.toFixed(scale)) !== number) {
    throw invalidDecision(`${name} має бути додатним числом з точністю до ${scale} знаків.`);
  }
  return number;
}

function normalizePricingDecision(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidDecision('Вкажіть режим ціни для запиту.');
  }
  const allowed = {
    system_auto: ['mode'],
    usd_per_gram: ['mode', 'usdPerGram', 'marketingRoundingEnabled'],
    manual_uah: ['mode', 'manualPriceUah'],
  };
  if (!Object.hasOwn(allowed, input.mode)
      || Object.keys(input).some((key) => !allowed[input.mode].includes(key))) {
    throw invalidDecision('Поля рішення про ціну не відповідають вибраному режиму.');
  }
  if (input.mode === 'system_auto') return { mode: 'system_auto' };
  if (input.mode === 'usd_per_gram') {
    if (typeof input.marketingRoundingEnabled !== 'boolean') {
      throw invalidDecision('Явно виберіть маркетингове округлення для ціни USD/г.');
    }
    return {
      mode: 'usd_per_gram',
      usdPerGram: positiveDecimal(input.usdPerGram, 'Ціна USD/г', 4),
      marketingRoundingEnabled: input.marketingRoundingEnabled,
    };
  }
  return {
    mode: 'manual_uah',
    manualPriceUah: positiveDecimal(input.manualPriceUah, 'Ручна ціна UAH', 2),
  };
}

function decisionFromRequest(row) {
  if (row.pricing_mode === 'system_auto') return { mode: 'system_auto' };
  if (row.pricing_mode === 'usd_per_gram') return {
    mode: 'usd_per_gram',
    usdPerGram: Number(row.pricing_usd_per_gram),
    marketingRoundingEnabled: Number(row.pricing_rounding_enabled) === 1,
  };
  if (row.pricing_mode === 'manual_uah') return {
    mode: 'manual_uah',
    manualPriceUah: Number(row.pricing_manual_uah),
  };
  return null;
}

async function calculateDecisionPricing(decision, weight, providedRateInfo = null) {
  if (decision.mode === 'manual_uah') {
    return {
      weightVal: Number(weight || 0),
      pricePerGram: 0,
      fixedPriceUah: null,
      priceMode: 'manual_uah',
      usesWeight: false,
      totalPrice: '0.00',
      logMessage: 'Точна ручна ціна UAH',
      pricingDetails: { scenario: null, matrix: null, priceMode: 'manual_uah' },
      currencyPayload: {
        uahRate: null,
        pricePerGramUah: null,
        calculatedPriceUah: null,
        totalPriceUah: decision.manualPriceUah,
      },
    };
  }
  const targetWeight = Number(weight);
  if (!Number.isFinite(targetWeight) || targetWeight <= 0) {
    throw invalidDecision('Для ціни USD/г вага виправленого товару повинна бути більшою за 0.');
  }
  let rateInfo;
  try {
    rateInfo = providedRateInfo || await getUsdUahRateInfo();
  } catch {
    throw invalidDecision('Авторитетний курс USD/UAH недоступний для ціни USD/г.');
  }
  const rate = Number(rateInfo?.rate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw invalidDecision('Авторитетний курс USD/UAH недоступний для ціни USD/г.');
  }
  const rawUah = decision.usdPerGram * targetWeight * rate;
  const selectedUah = decision.marketingRoundingEnabled
    ? roundAutomaticUah(rawUah) : Number(rawUah.toFixed(2));
  if (!Number.isFinite(selectedUah) || selectedUah <= 0) {
    throw invalidDecision('Ціна USD/г не утворює додатну ціну UAH.');
  }
  return {
    weightVal: targetWeight,
    pricePerGram: decision.usdPerGram,
    fixedPriceUah: null,
    priceMode: 'per_gram_usd',
    usesWeight: true,
    totalPrice: (decision.usdPerGram * targetWeight).toFixed(2),
    logMessage: 'Захищена ціна USD/г із запиту на виправлення',
    pricingDetails: { scenario: null, matrix: null, priceMode: 'per_gram_usd' },
    currencyPayload: {
      uahRate: rate,
      uahRateSource: rateInfo.source,
      uahRateDate: rateInfo.rateDate,
      uahRateFetchedAt: rateInfo.fetchedAt,
      uahRateStale: Boolean(rateInfo.stale),
      pricePerGramUah: (decision.usdPerGram * rate).toFixed(2),
      calculatedPriceUah: rawUah,
      totalPriceUah: selectedUah,
    },
  };
}

module.exports = {
  calculateDecisionPricing,
  decisionFromRequest,
  normalizePricingDecision,
};
