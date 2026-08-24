const { asRuleObject } = require('./rules');

const PRICE_MODES = new Set(['category_default', 'per_gram_usd', 'fixed_uah']);
const SCENARIO_STATUSES = new Set(['draft', 'active', 'archived']);

function normalizePriceMode(value) {
  const normalized = String(value || 'category_default');
  return PRICE_MODES.has(normalized) ? normalized : 'category_default';
}

function normalizeScenarioStatus(value, fallback = 'draft') {
  const normalized = String(value || fallback);
  return SCENARIO_STATUSES.has(normalized) ? normalized : fallback;
}

function sortScenariosByPrecedence(scenarios = []) {
  return [...scenarios].sort((a, b) => {
    const priorityDifference = Number(b.priority || 0) - Number(a.priority || 0);
    if (priorityDifference !== 0) return priorityDifference;

    const aRuleCount = Object.keys(asRuleObject(a.match_json)).length;
    const bRuleCount = Object.keys(asRuleObject(b.match_json)).length;
    return bRuleCount - aRuleCount || Number(a.id) - Number(b.id);
  });
}

function normalizeWeightBands(weightBands = []) {
  return weightBands.map((band, index) => {
    const minWeight = Number(band.min_weight);
    const hasMaxWeight = band.max_weight !== null
      && band.max_weight !== undefined
      && band.max_weight !== '';
    const maxWeight = hasMaxWeight ? Number(band.max_weight) : null;

    return {
      id: band.id !== undefined && band.id !== null ? Number(band.id) : null,
      label: String(band.label || '').trim(),
      min_weight: minWeight,
      max_weight: maxWeight,
      sort_order: index,
    };
  });
}

function validateWeightBands(weightBands = []) {
  const bands = normalizeWeightBands(weightBands).sort(
    (a, b) => a.min_weight - b.min_weight || a.sort_order - b.sort_order
  );

  if (bands.length === 0) {
    throw new Error('Для вагових діапазонів потрібно додати хоча б один рядок.');
  }

  bands.forEach((band, index) => {
    if (!band.label) throw new Error(`Ваговий діапазон №${index + 1} не має назви.`);
    if (!Number.isFinite(band.min_weight) || band.min_weight < 0) {
      throw new Error(`Ваговий діапазон «${band.label}» має некоректну нижню межу.`);
    }
    if (band.max_weight !== null && (
      !Number.isFinite(band.max_weight) || band.max_weight <= band.min_weight
    )) {
      throw new Error(`Ваговий діапазон «${band.label}» має некоректну верхню межу.`);
    }
    if (index === 0 && band.min_weight !== 0) {
      throw new Error('Перший ваговий діапазон повинен починатися з 0 г.');
    }
    if (index > 0 && bands[index - 1].max_weight !== band.min_weight) {
      throw new Error('Вагові діапазони повинні йти без пропусків і перетинів.');
    }
    if (index < bands.length - 1 && band.max_weight === null) {
      throw new Error('Тільки останній ваговий діапазон може не мати верхньої межі.');
    }
  });

  if (bands[bands.length - 1].max_weight !== null) {
    throw new Error('Останній ваговий діапазон повинен охоплювати всю більшу вагу.');
  }

  return bands.map((band, index) => ({ ...band, sort_order: index }));
}

function resolveWeightBand(weightBands = [], weight) {
  const numericWeight = Number(weight);
  if (!Number.isFinite(numericWeight) || numericWeight < 0) return null;

  return weightBands.find((band) => (
    numericWeight >= Number(band.min_weight)
    && (
      band.max_weight === null
      || band.max_weight === undefined
      || numericWeight < Number(band.max_weight)
    )
  )) || null;
}

module.exports = {
  normalizePriceMode,
  normalizeScenarioStatus,
  resolveWeightBand,
  sortScenariosByPrecedence,
  validateWeightBands,
};
