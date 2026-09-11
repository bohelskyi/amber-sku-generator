const pool = require('../../db/pool');

function groupByScenario(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.scenario_id)) grouped.set(row.scenario_id, []);
    grouped.get(row.scenario_id).push(row);
  }
  return grouped;
}

async function getAdminPrices(catCode, queryable = pool) {
  const result = await queryable.query(
    `SELECT
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
         ) ORDER BY COALESCE(NULLIF(scenario.group_name, ''), scenario.name), scenario.id)
         FROM price_scenarios scenario
         WHERE scenario.category_code = $1
       ), '[]'::json) AS scenarios,
       COALESCE((
         SELECT json_agg(json_build_object(
           'scenario_id', matrix.scenario_id,
           'x_val', matrix.x_val,
           'y_val', matrix.y_val,
           'price', matrix.price::text
         ) ORDER BY matrix.scenario_id, matrix.x_val, matrix.y_val)
         FROM price_matrix matrix
         JOIN price_scenarios scenario ON scenario.id = matrix.scenario_id
         WHERE scenario.category_code = $1
       ), '[]'::json) AS matrix,
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
         WHERE scenario.category_code = $1
       ), '[]'::json) AS weight_bands,
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
         WHERE modifier.category_code = $1
       ), '[]'::json) AS modifiers`,
    [catCode]
  );
  const row = result.rows[0] || {};
  const matrixByScenario = groupByScenario(row.matrix || []);
  const weightBandsByScenario = groupByScenario((row.weight_bands || []).map((band) => ({
    ...band,
    min_weight: Number(band.min_weight),
    max_weight: band.max_weight === null ? null : Number(band.max_weight),
  })));

  return {
    scenarios: (row.scenarios || []).map((scenario) => ({
      ...scenario,
      matrix: matrixByScenario.get(scenario.id) || [],
      weight_bands: weightBandsByScenario.get(scenario.id) || [],
    })),
    modifiers: row.modifiers || [],
  };
}

module.exports = { getAdminPrices };
