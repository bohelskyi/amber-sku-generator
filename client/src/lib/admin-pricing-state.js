import { formatDecimal } from './formatters.js';

const normalizeId = (value) => String(value ?? '');

export const findScenarioById = (pricesData, scenarioId) => (
  (pricesData?.scenarios || []).find(
    (scenario) => normalizeId(scenario.id) === normalizeId(scenarioId)
  ) || null
);

export const getScenarioMatrixCellKey = (scenarioId, xVal, yVal, price) => (
  [scenarioId, xVal, yVal, price ?? ''].map(normalizeId).join(':')
);

export const buildScenarioEditorDraft = (scenario) => {
  if (!scenario) return null;

  return {
    id: scenario.id,
    name: scenario.name,
    group_name: scenario.group_name || '',
    match_json: typeof scenario.match_json === 'string'
      ? scenario.match_json
      : JSON.stringify(scenario.match_json ?? {}),
    axis_x_key: scenario.axis_x_key || '',
    axis_y_key: scenario.axis_y_key || '',
    priority: String(scenario.priority ?? 0),
    status: scenario.status || 'active',
    price_mode: scenario.price_mode || 'category_default',
    apply_modifiers: scenario.apply_modifiers !== false,
    weight_bands: (scenario.weight_bands || []).map((band) => ({
      ...band,
      min_weight: formatDecimal(band.min_weight),
      max_weight: formatDecimal(band.max_weight),
    })),
  };
};
