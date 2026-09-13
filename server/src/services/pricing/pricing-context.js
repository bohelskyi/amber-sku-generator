const pool = require('../../db/pool');

const CONTEXT_PROJECTION = `
SELECT
  requested.category_code,
  categories.requires_weight,
  COALESCE((
    SELECT json_agg(json_build_object(
      'id', scenario.id,
      'category_code', scenario.category_code,
      'name', scenario.name,
      'group_name', scenario.group_name,
      'match_json', scenario.match_json,
      'axis_x_key', scenario.axis_x_key,
      'axis_y_key', scenario.axis_y_key,
      'priority', scenario.priority,
      'status', scenario.status,
      'price_mode', scenario.price_mode,
      'apply_modifiers', scenario.apply_modifiers
    ) ORDER BY scenario.id)
    FROM price_scenarios scenario
    WHERE scenario.category_code = requested.category_code
      AND COALESCE(scenario.status, 'active') = 'active'
  ), '[]'::json) AS scenarios,
  COALESCE((
    SELECT json_agg(json_build_object(
      'id', band.id,
      'scenario_id', band.scenario_id,
      'label', band.label,
      'min_weight', band.min_weight::text,
      'max_weight', CASE WHEN band.max_weight IS NULL THEN NULL ELSE band.max_weight::text END,
      'sort_order', band.sort_order
    ) ORDER BY band.scenario_id, band.sort_order, band.min_weight)
    FROM price_weight_bands band
    JOIN price_scenarios scenario ON scenario.id = band.scenario_id
    WHERE scenario.category_code = requested.category_code
      AND COALESCE(scenario.status, 'active') = 'active'
  ), '[]'::json) AS weight_bands,
  COALESCE((
    SELECT json_agg(json_build_object(
      'scenario_id', matrix.scenario_id,
      'x_val', matrix.x_val,
      'y_val', matrix.y_val,
      'price', matrix.price::text
    ) ORDER BY matrix.scenario_id, matrix.x_val, matrix.y_val)
    FROM price_matrix matrix
    JOIN price_scenarios scenario ON scenario.id = matrix.scenario_id
    WHERE scenario.category_code = requested.category_code
      AND COALESCE(scenario.status, 'active') = 'active'
  ), '[]'::json) AS matrix,
  COALESCE((
    SELECT json_agg(json_build_object(
      'id', modifier.id,
      'category_code', modifier.category_code,
      'trigger_key', modifier.trigger_key,
      'trigger_val', modifier.trigger_val,
      'match_json', modifier.match_json,
      'factor', modifier.factor::text
    ) ORDER BY modifier.id)
    FROM price_modifiers modifier
    WHERE modifier.category_code = requested.category_code
  ), '[]'::json) AS modifiers,
  requested.ordinal
FROM requested
LEFT JOIN categories ON categories.code = requested.category_code
ORDER BY requested.ordinal`;

function hydratePricingContext(row) {
  const weightBandsByScenario = new Map();
  for (const band of row.weight_bands || []) {
    const scenarioId = Number(band.scenario_id);
    if (!weightBandsByScenario.has(scenarioId)) weightBandsByScenario.set(scenarioId, []);
    weightBandsByScenario.get(scenarioId).push(band);
  }

  const matrixByCell = new Map();
  for (const matrixRow of row.matrix || []) {
    matrixByCell.set(
      `${Number(matrixRow.scenario_id)}:${Number(matrixRow.x_val)}:${Number(matrixRow.y_val)}`,
      matrixRow
    );
  }

  return {
    categoryCode: row.category_code,
    category: row.requires_weight === null || row.requires_weight === undefined
      ? null
      : { requires_weight: row.requires_weight },
    scenarios: row.scenarios || [],
    weightBandsByScenario,
    matrixByCell,
    modifiers: row.modifiers || [],
  };
}

async function loadPricingContexts(categoryCodes, queryable = pool) {
  const requestedCodes = Array.from(new Set(categoryCodes.map((code) => String(code))));
  if (requestedCodes.length === 0) return new Map();

  const result = await queryable.query(
    `WITH requested AS (
       SELECT category_code, ordinality::integer AS ordinal
       FROM unnest($1::text[]) WITH ORDINALITY AS input(category_code, ordinality)
     )
     ${CONTEXT_PROJECTION}`,
    [requestedCodes]
  );
  return new Map(result.rows.map((row) => [row.category_code, hydratePricingContext(row)]));
}

async function loadPricingContext(categoryCode, queryable = pool) {
  const contexts = await loadPricingContexts([categoryCode], queryable);
  return contexts.get(String(categoryCode));
}

async function loadScenarioPricingContext(scenarioId, queryable = pool) {
  const result = await queryable.query(
    `WITH target AS (
       SELECT id, category_code, name, group_name, match_json, axis_x_key, axis_y_key,
              priority, status, price_mode, apply_modifiers
       FROM price_scenarios
       WHERE id = $1 AND COALESCE(status, 'active') = 'active'
     ), requested AS (
       SELECT category_code, 1::integer AS ordinal
       FROM target
     )
     SELECT context_rows.*, to_json(target.*) AS target_scenario
     FROM (
       ${CONTEXT_PROJECTION}
     ) context_rows
     JOIN target ON target.category_code = context_rows.category_code`,
    [Number(scenarioId)]
  );
  if (result.rows.length === 0) return null;

  return {
    scenario: result.rows[0].target_scenario,
    context: hydratePricingContext(result.rows[0]),
  };
}

module.exports = {
  loadPricingContext,
  loadPricingContexts,
  loadScenarioPricingContext,
};
