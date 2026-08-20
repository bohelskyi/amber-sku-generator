const pool = require('../db/pool');
const { getUsdUahRate } = require('./currency.service');
const { resolveAxisValue } = require('../utils/pricing-axis');
const { asRuleObject } = require('../utils/rules');
const { roundUah } = require('../utils/money');

function normalizeScenarioGroup(groupName, scenarioName = '') {
  const normalizedGroup = String(groupName || '').trim();
  if (normalizedGroup) return normalizedGroup;

  const normalizedName = String(scenarioName || '').trim();
  if (!normalizedName) return 'Без групи';
  if (normalizedName.includes(' - ')) return normalizedName.split(' - ')[0].trim() || 'Без групи';
  return normalizedName;
}

function getAnswerValue(answers, key) {
  return answers[key] === undefined || answers[key] === null || answers[key] === ''
    ? 0
    : Number(answers[key]);
}

function isRuleValueMatched(actualValue, expectedValue) {
  if (Array.isArray(expectedValue)) {
    return expectedValue.map((value) => Number(value)).includes(Number(actualValue));
  }

  return Number(actualValue) === Number(expectedValue);
}

function getRuleAnswerValue(key, answers, normalizedCalibrated) {
  return key === 'is_calibrated' ? normalizedCalibrated : getAnswerValue(answers, key);
}

function isPricingRuleMatched(ruleJson, answers, normalizedCalibrated) {
  const rules = asRuleObject(ruleJson);
  for (const [key, value] of Object.entries(rules)) {
    if (!isRuleValueMatched(getRuleAnswerValue(key, answers, normalizedCalibrated), value)) {
      return false;
    }
  }
  return true;
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

function getRuleKeys(ruleJson) {
  return Object.keys(asRuleObject(ruleJson));
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
  const calibratedAnswer =
    answers.is_calibrated !== undefined &&
    answers.is_calibrated !== null &&
    answers.is_calibrated !== ''
      ? answers.is_calibrated
      : isCalibrated;
  const normalizedCalibrated = Number(calibratedAnswer || 0);
  const weightVal = getPricingWeight(answers, weight);
  let pricingDetails = null;

  const activeScenario = [...scenarios.rows].sort((a, b) => {
    const aRuleCount = Object.keys(asRuleObject(a.match_json)).length;
    const bRuleCount = Object.keys(asRuleObject(b.match_json)).length;
    return bRuleCount - aRuleCount || Number(a.id) - Number(b.id);
  }).find((scenario) => {
    return isPricingRuleMatched(scenario.match_json, answers, normalizedCalibrated);
  });
  const categoryRequiresWeight =
    categoryResult.rows.length > 0 &&
    Number(categoryResult.rows[0].requires_weight) === 1 &&
    categoryCode !== 'SK';
  const scenarioUsesWeight =
    activeScenario &&
    (axisUsesKey(activeScenario.axis_x_key, 'weight') ||
      axisUsesKey(activeScenario.axis_y_key, 'weight'));
  const isWeightBased = categoryRequiresWeight || scenarioUsesWeight;

  if (activeScenario) {
    const matrixAnswers = scenarioUsesWeight ? { ...answers, weight: 0 } : answers;
    const xVal = resolveAxisValue(activeScenario.axis_x_key, matrixAnswers);
    const yVal = resolveAxisValue(activeScenario.axis_y_key, matrixAnswers);

    const priceRow = await pool.query(
      `SELECT price
       FROM price_matrix
       WHERE scenario_id = $1 AND x_val = $2 AND y_val = $3`,
      [activeScenario.id, xVal, yVal]
    );

    if (priceRow.rows.length > 0) {
      const basePrice = Number(priceRow.rows[0].price);
      const matchedModifiers = [];
      pricePerGram = Number(priceRow.rows[0].price);
      logMessage = `${activeScenario.name} (Базова: ${isWeightBased ? `$${pricePerGram}` : `${pricePerGram} ₴`})`;

      const modifiers = await pool.query(
        'SELECT * FROM price_modifiers WHERE category_code = $1',
        [categoryCode]
      );

      for (const modifier of modifiers.rows) {
        const modifierRule = Object.keys(asRuleObject(modifier.match_json)).length > 0
          ? modifier.match_json
          : { [modifier.trigger_key]: modifier.trigger_val };

        if (isPricingRuleMatched(modifierRule, answers, normalizedCalibrated)) {
          pricePerGram *= Number(modifier.factor);
          matchedModifiers.push({
            id: modifier.id,
            factor: Number(modifier.factor),
            match_json: asRuleObject(modifierRule),
            dependentKeys: getRuleKeys(modifierRule),
          });
          logMessage += ` + Модифікатор (${Math.round((Number(modifier.factor) - 1) * 100)}%)`;
        }
      }

      pricingDetails = {
        isWeightBased,
        calibratedValue: normalizedCalibrated,
        scenario: {
          id: activeScenario.id,
          name: activeScenario.name,
          group_name: activeScenario.group_name || '',
          match_json: asRuleObject(activeScenario.match_json),
          axis_x_key: activeScenario.axis_x_key,
          axis_y_key: activeScenario.axis_y_key,
        },
        matrix: {
          x: {
            key: activeScenario.axis_x_key,
            value: xVal,
            dependentKeys: getAxisKeys(activeScenario.axis_x_key),
          },
          y: {
            key: activeScenario.axis_y_key,
            value: yVal,
            dependentKeys: getAxisKeys(activeScenario.axis_y_key),
          },
        },
        basePrice,
        finalPricePerGram: pricePerGram,
        matchedModifiers,
        dependentKeys: uniqueKeys([
          ...getRuleKeys(activeScenario.match_json),
          ...getAxisKeys(activeScenario.axis_x_key),
          ...getAxisKeys(activeScenario.axis_y_key),
          ...matchedModifiers.flatMap((modifier) => modifier.dependentKeys),
        ]),
      };
    } else {
      logMessage = `${activeScenario.name} (Нема ціни для комбінації)`;
    }
  } else {
    logMessage = 'Немає сценарію для цих параметрів';
  }

  let totalPrice = isWeightBased ? (pricePerGram * weightVal).toFixed(2) : '0.00';

  let currencyPayload = { uahRate: null, pricePerGramUah: null, totalPriceUah: null };
  try {
    const uahRate = await getUsdUahRate();
    if (isWeightBased) {
      currencyPayload = {
        uahRate,
        pricePerGramUah: (pricePerGram * uahRate).toFixed(2),
        totalPriceUah: roundUah(Number(totalPrice) * uahRate),
      };
    } else {
      totalPrice = uahRate > 0 ? (pricePerGram / uahRate).toFixed(2) : '0.00';
      currencyPayload = {
        uahRate,
        pricePerGramUah: null,
        totalPriceUah: roundUah(pricePerGram),
      };
    }
  } catch (err) {
    console.error('NBU rate error:', err.message || err);
    if (!isWeightBased) {
      currencyPayload = {
        uahRate: null,
        pricePerGramUah: null,
        totalPriceUah: roundUah(pricePerGram),
      };
    }
  }

  return {
    weightVal,
    pricePerGram,
    totalPrice,
    logMessage,
    currencyPayload,
    pricingDetails: pricingDetails || {
      isWeightBased,
      calibratedValue: normalizedCalibrated,
      scenario: activeScenario
        ? {
            id: activeScenario.id,
            name: activeScenario.name,
            group_name: activeScenario.group_name || '',
            match_json: asRuleObject(activeScenario.match_json),
            axis_x_key: activeScenario.axis_x_key,
            axis_y_key: activeScenario.axis_y_key,
          }
        : null,
      matrix: null,
      basePrice: null,
      finalPricePerGram: pricePerGram,
      matchedModifiers: [],
      dependentKeys: activeScenario
        ? uniqueKeys([
            ...getRuleKeys(activeScenario.match_json),
            ...getAxisKeys(activeScenario.axis_x_key),
            ...getAxisKeys(activeScenario.axis_y_key),
          ])
        : [],
    },
  };
}

async function getAdminPrices(catCode) {
  const scenariosResult = await pool.query(
    `SELECT *
     FROM price_scenarios
     WHERE category_code = $1
     ORDER BY COALESCE(NULLIF(group_name, ''), name), id`,
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

async function createScenario({ category_code, name, group_name, match_json, axis_x_key, axis_y_key }) {
  const payload = typeof match_json === 'string' ? JSON.parse(match_json) : match_json || {};
  const scenarioGroup = normalizeScenarioGroup(group_name, name);
  const result = await pool.query(
    `INSERT INTO price_scenarios (category_code, name, group_name, match_json, axis_x_key, axis_y_key)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING id`,
    [category_code, name, scenarioGroup, JSON.stringify(payload), axis_x_key, axis_y_key]
  );

  return { id: result.rows[0].id };
}

async function updateScenario({ id, name, group_name, match_json, axis_x_key, axis_y_key }) {
  const payload = typeof match_json === 'string' ? JSON.parse(match_json) : match_json || {};
  const scenarioGroup = normalizeScenarioGroup(group_name, name);
  await pool.query(
    `UPDATE price_scenarios
     SET name = $1, group_name = $2, match_json = $3::jsonb, axis_x_key = $4, axis_y_key = $5
     WHERE id = $6`,
    [name, scenarioGroup, JSON.stringify(payload), axis_x_key, axis_y_key || null, Number(id)]
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
      `INSERT INTO price_scenarios (category_code, name, group_name, match_json, axis_x_key, axis_y_key)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING id`,
      [
        source.category_code,
        `${source.name} (копія)`,
        normalizeScenarioGroup(source.group_name, source.name),
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

function normalizeModifierRule({ match_json, trigger_key, trigger_val }) {
  const payload = typeof match_json === 'string' ? JSON.parse(match_json || '{}') : match_json || {};
  if (Object.keys(payload).length > 0) return payload;
  if (trigger_key) return { [trigger_key]: Number(trigger_val) };
  return {};
}

function getLegacyModifierTrigger(rule) {
  const [firstKey, firstValue] = Object.entries(rule)[0] || ['', 0];
  const normalizedValue = Array.isArray(firstValue) ? firstValue[0] : firstValue;
  return {
    triggerKey: firstKey || '',
    triggerVal: normalizedValue === undefined || normalizedValue === null || normalizedValue === ''
      ? 0
      : Number(normalizedValue),
  };
}

async function createModifier({ category_code, trigger_key, trigger_val, match_json, factor }) {
  const payload = normalizeModifierRule({ match_json, trigger_key, trigger_val });
  const legacyTrigger = getLegacyModifierTrigger(payload);
  const result = await pool.query(
    `INSERT INTO price_modifiers (category_code, trigger_key, trigger_val, match_json, factor)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING id`,
    [
      category_code,
      legacyTrigger.triggerKey,
      legacyTrigger.triggerVal,
      JSON.stringify(payload),
      Number(factor),
    ]
  );

  return { id: result.rows[0].id };
}

async function updateModifier({ id, factor, match_json, trigger_key, trigger_val }) {
  if (match_json === undefined && trigger_key === undefined && trigger_val === undefined) {
    await pool.query('UPDATE price_modifiers SET factor = $1 WHERE id = $2', [
      Number(factor),
      Number(id),
    ]);
    return;
  }

  const payload = normalizeModifierRule({ match_json, trigger_key, trigger_val });
  const legacyTrigger = getLegacyModifierTrigger(payload);
  await pool.query(
    `UPDATE price_modifiers
     SET trigger_key = $1, trigger_val = $2, match_json = $3::jsonb, factor = $4
     WHERE id = $5`,
    [
      legacyTrigger.triggerKey,
      legacyTrigger.triggerVal,
      JSON.stringify(payload),
      Number(factor),
      Number(id),
    ]
  );
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
