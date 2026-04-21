const pool = require('../db/pool');
const { getUsdUahRate } = require('./currency.service');
const { resolveAxisValue } = require('../utils/pricing-axis');
const { asRuleObject } = require('../utils/rules');

function getAnswerValue(answers, key) {
  return answers[key] === undefined || answers[key] === null || answers[key] === ''
    ? 0
    : Number(answers[key]);
}

async function calculatePricing(categoryCode, answers = {}, weight, isCalibrated) {
  const scenarios = await pool.query(
    'SELECT * FROM price_scenarios WHERE category_code = $1',
    [categoryCode]
  );
  const categoryResult = await pool.query(
    'SELECT requires_weight FROM categories WHERE code = $1 LIMIT 1',
    [categoryCode]
  );

  let pricePerGram = 0;
  let logMessage = 'Ціна не знайдена';
  const normalizedCalibrated = Number(isCalibrated || 0);
  const isWeightBased =
    categoryResult.rows.length > 0 &&
    Number(categoryResult.rows[0].requires_weight) === 1 &&
    categoryCode !== 'SK';

  const activeScenario = [...scenarios.rows].sort((a, b) => {
    const aRuleCount = Object.keys(asRuleObject(a.match_json)).length;
    const bRuleCount = Object.keys(asRuleObject(b.match_json)).length;
    return bRuleCount - aRuleCount || Number(a.id) - Number(b.id);
  }).find((scenario) => {
    const rules = asRuleObject(scenario.match_json);
    for (const [key, value] of Object.entries(rules)) {
      if (key === 'is_calibrated') {
        if (Number(value) !== normalizedCalibrated) return false;
      } else if (getAnswerValue(answers, key) !== Number(value)) {
        return false;
      }
    }
    return true;
  });

  if (activeScenario) {
    const xVal = resolveAxisValue(activeScenario.axis_x_key, answers);
    const yVal = resolveAxisValue(activeScenario.axis_y_key, answers);

    const priceRow = await pool.query(
      `SELECT price
       FROM price_matrix
       WHERE scenario_id = $1 AND x_val = $2 AND y_val = $3`,
      [activeScenario.id, xVal, yVal]
    );

    if (priceRow.rows.length > 0) {
      pricePerGram = Number(priceRow.rows[0].price);
      logMessage = `${activeScenario.name} (Базова: ${isWeightBased ? `$${pricePerGram}` : `${pricePerGram} ₴`})`;

      const modifiers = await pool.query(
        'SELECT * FROM price_modifiers WHERE category_code = $1',
        [categoryCode]
      );

      for (const modifier of modifiers.rows) {
        if (getAnswerValue(answers, modifier.trigger_key) === Number(modifier.trigger_val)) {
          pricePerGram *= Number(modifier.factor);
          logMessage += ` + Модифікатор (${Math.round((Number(modifier.factor) - 1) * 100)}%)`;
        }
      }
    } else {
      logMessage = `${activeScenario.name} (Нема ціни для комбінації)`;
    }
  } else {
    logMessage = 'Немає сценарію для цих параметрів';
  }

  const parsedWeight = Number.parseFloat(weight);
  const weightVal = Number.isFinite(parsedWeight) ? parsedWeight : 0;
  let totalPrice = isWeightBased ? (pricePerGram * weightVal).toFixed(2) : '0.00';

  let currencyPayload = { uahRate: null, pricePerGramUah: null, totalPriceUah: null };
  try {
    const uahRate = await getUsdUahRate();
    if (isWeightBased) {
      currencyPayload = {
        uahRate,
        pricePerGramUah: (pricePerGram * uahRate).toFixed(2),
        totalPriceUah: (Number(totalPrice) * uahRate).toFixed(2),
      };
    } else {
      totalPrice = uahRate > 0 ? (pricePerGram / uahRate).toFixed(2) : '0.00';
      currencyPayload = {
        uahRate,
        pricePerGramUah: null,
        totalPriceUah: pricePerGram.toFixed(2),
      };
    }
  } catch (err) {
    console.error('NBU rate error:', err.message || err);
    if (!isWeightBased) {
      currencyPayload = {
        uahRate: null,
        pricePerGramUah: null,
        totalPriceUah: pricePerGram.toFixed(2),
      };
    }
  }

  return {
    weightVal,
    pricePerGram,
    totalPrice,
    logMessage,
    currencyPayload,
  };
}

async function getAdminPrices(catCode) {
  const scenariosResult = await pool.query(
    'SELECT * FROM price_scenarios WHERE category_code = $1 ORDER BY id',
    [catCode]
  );
  const modifiersResult = await pool.query(
    'SELECT * FROM price_modifiers WHERE category_code = $1 ORDER BY id',
    [catCode]
  );

  const scenarioIds = scenariosResult.rows.map((scenario) => scenario.id);
  let matrixRows = [];
  if (scenarioIds.length > 0) {
    const matrixResult = await pool.query(
      'SELECT * FROM price_matrix WHERE scenario_id = ANY($1::int[]) ORDER BY scenario_id, x_val, y_val',
      [scenarioIds]
    );
    matrixRows = matrixResult.rows;
  }

  const matrixByScenario = new Map();
  for (const row of matrixRows) {
    if (!matrixByScenario.has(row.scenario_id)) matrixByScenario.set(row.scenario_id, []);
    matrixByScenario.get(row.scenario_id).push(row);
  }

  return {
    scenarios: scenariosResult.rows.map((scenario) => ({
      ...scenario,
      matrix: matrixByScenario.get(scenario.id) || [],
    })),
    modifiers: modifiersResult.rows,
  };
}

async function upsertPriceCell({ scenario_id, x_val, y_val, price }) {
  await pool.query(
    `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (scenario_id, x_val, y_val)
     DO UPDATE SET price = EXCLUDED.price`,
    [Number(scenario_id), Number(x_val), Number(y_val || 0), Number(price)]
  );
}

async function createScenario({ category_code, name, match_json, axis_x_key, axis_y_key }) {
  const payload = typeof match_json === 'string' ? JSON.parse(match_json) : match_json || {};
  const result = await pool.query(
    `INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     RETURNING id`,
    [category_code, name, JSON.stringify(payload), axis_x_key, axis_y_key]
  );

  return { id: result.rows[0].id };
}

async function updateScenario({ id, name, match_json, axis_x_key, axis_y_key }) {
  const payload = typeof match_json === 'string' ? JSON.parse(match_json) : match_json || {};
  await pool.query(
    `UPDATE price_scenarios
     SET name = $1, match_json = $2::jsonb, axis_x_key = $3, axis_y_key = $4
     WHERE id = $5`,
    [name, JSON.stringify(payload), axis_x_key, axis_y_key || null, Number(id)]
  );
}

async function duplicateScenario(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sourceScenario = await client.query(
      'SELECT * FROM price_scenarios WHERE id = $1 LIMIT 1',
      [Number(id)]
    );
    if (sourceScenario.rows.length === 0) {
      const err = new Error('Сценарій не знайдено');
      err.statusCode = 404;
      throw err;
    }

    const source = sourceScenario.rows[0];
    const duplicatedScenario = await client.query(
      `INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id`,
      [
        source.category_code,
        `${source.name} (копія)`,
        JSON.stringify(source.match_json || {}),
        source.axis_x_key,
        source.axis_y_key,
      ]
    );

    const newScenarioId = duplicatedScenario.rows[0].id;
    await client.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       SELECT $1, x_val, y_val, price
       FROM price_matrix
       WHERE scenario_id = $2`,
      [Number(newScenarioId), Number(id)]
    );

    await client.query('COMMIT');
    return { success: true, id: newScenarioId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createModifier({ category_code, trigger_key, trigger_val, factor }) {
  const result = await pool.query(
    `INSERT INTO price_modifiers (category_code, trigger_key, trigger_val, factor)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [category_code, trigger_key, Number(trigger_val), Number(factor)]
  );

  return { id: result.rows[0].id };
}

async function updateModifier({ id, factor }) {
  await pool.query('UPDATE price_modifiers SET factor = $1 WHERE id = $2', [
    Number(factor),
    Number(id),
  ]);
}

module.exports = {
  calculatePricing,
  getAdminPrices,
  upsertPriceCell,
  createScenario,
  updateScenario,
  duplicateScenario,
  createModifier,
  updateModifier,
};
