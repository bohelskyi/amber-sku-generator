const pool = require('../db/pool');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const { getUsdUahRateInfo } = require('./currency.service');
const { resolveAxisValue } = require('../utils/pricing-axis');
const {
  normalizePriceMode,
  normalizeScenarioStatus,
  resolveWeightBand,
  sortScenariosByPrecedence,
  validateWeightBands,
} = require('../utils/pricing-scenarios');
const { asRuleObject, getRuleDependencies, isRuleMatched } = require('../utils/rules');
const { roundAutomaticUah } = require('../utils/money');
const { parsePositiveDecimal } = require('../utils/numbers');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = stableValue(value[key]);
        return result;
      }, {});
  }
  return value;
}

function valuesEqual(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function addAuditChange(changes, field, previousValue, nextValue, options = {}) {
  if (valuesEqual(previousValue, nextValue)) return;
  changes[field] = options.sensitive
    ? { changed: true }
    : { from: previousValue, to: nextValue };
}

function hasWeightBandChanges(summary) {
  return summary.created > 0
    || summary.updated > 0
    || summary.deleted > 0
    || summary.matrixCellsDeleted > 0;
}

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

async function loadPricingContext(categoryCode, queryable = pool) {
  const scenarios = await queryable.query(
    `SELECT *
     FROM price_scenarios
     WHERE category_code = $1 AND COALESCE(status, 'active') = 'active'`,
    [categoryCode]
  );
  const categoryResult = await queryable.query(
    'SELECT requires_weight FROM categories WHERE code = $1 LIMIT 1',
    [categoryCode]
  );

  const scenarioIds = scenarios.rows.map((scenario) => Number(scenario.id));
  const weightBandsResult = scenarioIds.length > 0
    ? await queryable.query(
        `SELECT id, scenario_id, label, min_weight, max_weight, sort_order
         FROM price_weight_bands
         WHERE scenario_id = ANY($1::int[])
         ORDER BY scenario_id, sort_order, min_weight`,
        [scenarioIds]
      )
    : { rows: [] };
  const [matrixResult, modifiersResult] = await Promise.all([
    scenarioIds.length > 0
      ? queryable.query(
          `SELECT scenario_id, x_val, y_val, price
           FROM price_matrix
           WHERE scenario_id = ANY($1::int[])`,
          [scenarioIds]
        )
      : Promise.resolve({ rows: [] }),
    queryable.query('SELECT * FROM price_modifiers WHERE category_code = $1', [categoryCode]),
  ]);
  const weightBandsByScenario = new Map();
  for (const band of weightBandsResult.rows) {
    if (!weightBandsByScenario.has(Number(band.scenario_id))) {
      weightBandsByScenario.set(Number(band.scenario_id), []);
    }
    weightBandsByScenario.get(Number(band.scenario_id)).push(band);
  }

  const matrixByCell = new Map();
  for (const row of matrixResult.rows) {
    matrixByCell.set(`${Number(row.scenario_id)}:${Number(row.x_val)}:${Number(row.y_val)}`, row);
  }

  return {
    categoryCode,
    category: categoryResult.rows[0] || null,
    scenarios: scenarios.rows,
    weightBandsByScenario,
    matrixByCell,
    modifiers: modifiersResult.rows,
  };
}

async function calculatePricing(
  categoryCode,
  answers = {},
  weight,
  isCalibrated,
  { queryable = pool, context = null, rateInfo = null } = {}
) {
  const pricingContext = context || await loadPricingContext(categoryCode, queryable);
  if (pricingContext.categoryCode !== categoryCode) {
    throw new Error(`Pricing context does not belong to category ${categoryCode}`);
  }
  const scenarios = { rows: pricingContext.scenarios };
  const categoryResult = { rows: pricingContext.category ? [pricingContext.category] : [] };
  const { weightBandsByScenario } = pricingContext;

  let pricePerGram = 0;
  let fixedPriceUah = null;
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

  const activeScenario = sortScenariosByPrecedence(scenarios.rows).find((scenario) => {
    return isPricingRuleMatched(scenario.match_json, answers, normalizedCalibrated);
  });
  const categoryRequiresWeight =
    categoryResult.rows.length > 0 &&
    Number(categoryResult.rows[0].requires_weight) === 1;
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
    const weightBands = weightBandsByScenario.get(Number(activeScenario.id)) || [];
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
      : pricingContext.matrixByCell.get(
          `${Number(activeScenario.id)}:${Number(xVal)}:${Number(yVal)}`
        );
    const priceRow = { rows: matrixRow ? [matrixRow] : [] };

    if (priceRow.rows.length > 0) {
      const basePrice = Number(priceRow.rows[0].price);
      const matchedModifiers = [];
      let calculatedPrice = basePrice;
      logMessage = `${activeScenario.name} (Базова: ${isWeightBased ? `$${calculatedPrice}` : `${calculatedPrice} ₴`})`;

      const modifiers = activeScenario.apply_modifiers === false
        ? { rows: [] }
        : { rows: pricingContext.modifiers };

      for (const modifier of modifiers.rows) {
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
        scenario: {
          id: activeScenario.id,
          name: activeScenario.name,
          group_name: activeScenario.group_name || '',
          match_json: asRuleObject(activeScenario.match_json),
          axis_x_key: activeScenario.axis_x_key,
          axis_y_key: activeScenario.axis_y_key,
          priority: Number(activeScenario.priority || 0),
          status: activeScenario.status || 'active',
          price_mode: normalizePriceMode(activeScenario.price_mode),
          apply_modifiers: activeScenario.apply_modifiers !== false,
        },
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

  let totalPrice = isWeightBased ? (pricePerGram * weightVal).toFixed(2) : '0.00';

  let currencyPayload = {
    uahRate: null,
    pricePerGramUah: null,
    calculatedPriceUah: null,
    totalPriceUah: null,
  };
  try {
    const resolvedRateInfo = rateInfo || await getUsdUahRateInfo();
    const uahRate = Number(resolvedRateInfo.rate);
    if (!Number.isFinite(uahRate) || uahRate <= 0) {
      throw new Error(resolvedRateInfo.error || 'USD/UAH rate is unavailable');
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
      uahRateSource: resolvedRateInfo.source,
      uahRateDate: resolvedRateInfo.rateDate,
      uahRateFetchedAt: resolvedRateInfo.fetchedAt,
      uahRateAgeMs: resolvedRateInfo.ageMs,
      uahRateStale: Boolean(resolvedRateInfo.stale),
      uahRateError: resolvedRateInfo.error || null,
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

  return {
    weightVal,
    pricePerGram,
    fixedPriceUah,
    priceMode,
    usesWeight,
    totalPrice,
    logMessage,
    currencyPayload,
    pricingDetails: pricingDetails || {
      isWeightBased,
      usesWeight,
      priceMode,
      calibratedValue: normalizedCalibrated,
      scenario: activeScenario
        ? {
            id: activeScenario.id,
            name: activeScenario.name,
            group_name: activeScenario.group_name || '',
            match_json: asRuleObject(activeScenario.match_json),
            axis_x_key: activeScenario.axis_x_key,
            axis_y_key: activeScenario.axis_y_key,
            priority: Number(activeScenario.priority || 0),
            status: activeScenario.status || 'active',
            price_mode: normalizePriceMode(activeScenario.price_mode),
            apply_modifiers: activeScenario.apply_modifiers !== false,
          }
        : null,
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
  let weightBandRows = [];
  if (scenarioIds.length > 0) {
    const [matrixResult, weightBandsResult] = await Promise.all([
      pool.query(
        'SELECT * FROM price_matrix WHERE scenario_id = ANY($1::int[]) ORDER BY scenario_id, x_val, y_val',
        [scenarioIds]
      ),
      pool.query(
        `SELECT id, scenario_id, label, min_weight, max_weight, sort_order
         FROM price_weight_bands
         WHERE scenario_id = ANY($1::int[])
         ORDER BY scenario_id, sort_order, min_weight`,
        [scenarioIds]
      ),
    ]);
    matrixRows = matrixResult.rows;
    weightBandRows = weightBandsResult.rows;
  }

  const matrixByScenario = new Map();
  for (const row of matrixRows) {
    if (!matrixByScenario.has(row.scenario_id)) matrixByScenario.set(row.scenario_id, []);
    matrixByScenario.get(row.scenario_id).push(row);
  }

  const weightBandsByScenario = new Map();
  for (const row of weightBandRows) {
    if (!weightBandsByScenario.has(row.scenario_id)) {
      weightBandsByScenario.set(row.scenario_id, []);
    }
    weightBandsByScenario.get(row.scenario_id).push({
      ...row,
      min_weight: Number(row.min_weight),
      max_weight: row.max_weight === null ? null : Number(row.max_weight),
    });
  }

  return {
    scenarios: scenariosResult.rows.map((scenario) => ({
      ...scenario,
      matrix: matrixByScenario.get(scenario.id) || [],
      weight_bands: weightBandsByScenario.get(scenario.id) || [],
    })),
    modifiers: modifiersResult.rows,
  };
}

function normalizeScenarioPayload(payload = {}, fallbackStatus = 'draft') {
  const axisXKey = String(payload.axis_x_key || '').trim();
  const axisYKey = String(payload.axis_y_key || '').trim();
  if (axisYKey === 'weight_band') {
    const err = new Error('Вагові діапазони підтримуються тільки в рядках матриці.');
    err.statusCode = 400;
    throw err;
  }

  const weightBands = axisXKey === 'weight_band'
    ? validateWeightBands(payload.weight_bands || [])
    : [];

  return {
    priority: Number.isFinite(Number(payload.priority)) ? Number(payload.priority) : 0,
    status: normalizeScenarioStatus(payload.status, fallbackStatus),
    priceMode: normalizePriceMode(payload.price_mode),
    applyModifiers: payload.apply_modifiers !== false,
    axisXKey,
    axisYKey,
    weightBands,
  };
}

async function syncScenarioWeightBands(client, scenarioId, weightBands, hadWeightBands) {
  const existingResult = await client.query(
    `SELECT id, label, min_weight, max_weight, sort_order
     FROM price_weight_bands
     WHERE scenario_id = $1
     ORDER BY id
     FOR UPDATE`,
    [Number(scenarioId)]
  );
  const existingById = new Map(
    existingResult.rows.map((row) => [Number(row.id), row])
  );
  const existingIds = new Set(existingById.keys());
  const summary = { created: 0, updated: 0, deleted: 0, matrixCellsDeleted: 0 };

  if (weightBands.length === 0) {
    if (hadWeightBands || existingIds.size > 0) {
      const deletedMatrix = await client.query(
        'DELETE FROM price_matrix WHERE scenario_id = $1',
        [Number(scenarioId)]
      );
      const deletedBands = await client.query(
        'DELETE FROM price_weight_bands WHERE scenario_id = $1',
        [Number(scenarioId)]
      );
      summary.matrixCellsDeleted = deletedMatrix.rowCount;
      summary.deleted = deletedBands.rowCount;
    }
    return summary;
  }

  const keptIds = new Set();
  for (const band of weightBands) {
    if (band.id !== null && existingIds.has(Number(band.id))) {
      const existing = existingById.get(Number(band.id));
      const changed = existing.label !== band.label
        || Number(existing.min_weight) !== Number(band.min_weight)
        || (existing.max_weight === null ? null : Number(existing.max_weight))
          !== (band.max_weight === null ? null : Number(band.max_weight))
        || Number(existing.sort_order) !== Number(band.sort_order);
      if (changed) {
        await client.query(
          `UPDATE price_weight_bands
           SET label = $1, min_weight = $2, max_weight = $3, sort_order = $4
           WHERE id = $5 AND scenario_id = $6`,
          [
            band.label,
            band.min_weight,
            band.max_weight,
            band.sort_order,
            Number(band.id),
            Number(scenarioId),
          ]
        );
        summary.updated += 1;
      }
      keptIds.add(Number(band.id));
      continue;
    }

    const inserted = await client.query(
      `INSERT INTO price_weight_bands
       (scenario_id, label, min_weight, max_weight, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [Number(scenarioId), band.label, band.min_weight, band.max_weight, band.sort_order]
    );
    keptIds.add(Number(inserted.rows[0].id));
    summary.created += 1;
  }

  const removedIds = [...existingIds].filter((id) => !keptIds.has(id));
  if (removedIds.length > 0) {
    const deletedMatrix = await client.query(
      'DELETE FROM price_matrix WHERE scenario_id = $1 AND x_val = ANY($2::int[])',
      [Number(scenarioId), removedIds]
    );
    const deletedBands = await client.query(
      'DELETE FROM price_weight_bands WHERE scenario_id = $1 AND id = ANY($2::int[])',
      [Number(scenarioId), removedIds]
    );
    summary.matrixCellsDeleted += deletedMatrix.rowCount;
    summary.deleted += deletedBands.rowCount;
  }

  return summary;
}

async function upsertPriceCell({ scenario_id, x_val, y_val, price }, options = {}) {
  const normalizedScenarioId = Number(scenario_id);
  const normalizedXVal = Number(x_val);
  const normalizedYVal = Number(y_val || 0);
  const hasPrice = price !== undefined
    && price !== null
    && !(typeof price === 'string' && price.trim() === '');

  const normalizedPrice = hasPrice ? parsePositiveDecimal(price, 'Ціна') : null;
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scenarioResult = await client.query(
      `SELECT id, category_code, name
       FROM price_scenarios
       WHERE id = $1
       FOR KEY SHARE`,
      [normalizedScenarioId]
    );
    const currentResult = await client.query(
      `SELECT price
       FROM price_matrix
       WHERE scenario_id = $1 AND x_val = $2 AND y_val = $3
       FOR UPDATE`,
      [normalizedScenarioId, normalizedXVal, normalizedYVal]
    );
    const currentPrice = currentResult.rows.length > 0
      ? Number(currentResult.rows[0].price)
      : null;

    if (!hasPrice) {
      if (currentPrice === null) {
        await client.query('COMMIT');
        return;
      }
      await client.query(
        `DELETE FROM price_matrix
         WHERE scenario_id = $1 AND x_val = $2 AND y_val = $3`,
        [normalizedScenarioId, normalizedXVal, normalizedYVal]
      );
      const scenario = scenarioResult.rows[0];
      await writeAuditEvent(client, {
        mutationContext,
        eventKey: 'pricing.matrix_cell.deleted',
        subjectType: 'pricing_matrix_cell',
        subjectId: `${normalizedScenarioId}:${normalizedXVal}:${normalizedYVal}`,
        details: {
          scenarioId: normalizedScenarioId,
          scenarioName: scenario.name,
          categoryCode: scenario.category_code,
          xValue: normalizedXVal,
          yValue: normalizedYVal,
          oldPrice: currentPrice,
          newPrice: null,
        },
      });
      await client.query('COMMIT');
      return;
    }

    if (currentPrice !== null && currentPrice === normalizedPrice) {
      await client.query('COMMIT');
      return;
    }

    await client.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (scenario_id, x_val, y_val)
       DO UPDATE SET price = EXCLUDED.price`,
      [normalizedScenarioId, normalizedXVal, normalizedYVal, normalizedPrice]
    );
    const scenario = scenarioResult.rows[0];
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'pricing.matrix_cell.set',
      subjectType: 'pricing_matrix_cell',
      subjectId: `${normalizedScenarioId}:${normalizedXVal}:${normalizedYVal}`,
      details: {
        scenarioId: normalizedScenarioId,
        scenarioName: scenario.name,
        categoryCode: scenario.category_code,
        xValue: normalizedXVal,
        yValue: normalizedYVal,
        oldPrice: currentPrice,
        newPrice: normalizedPrice,
      },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createScenario({
  category_code,
  name,
  group_name,
  match_json,
  axis_x_key,
  axis_y_key,
  priority,
  status,
  price_mode,
  apply_modifiers,
  weight_bands,
}, options = {}) {
  const payload = typeof match_json === 'string' ? JSON.parse(match_json) : match_json || {};
  const scenarioGroup = normalizeScenarioGroup(group_name, name);
  const normalized = normalizeScenarioPayload({
    axis_x_key,
    axis_y_key,
    priority,
    status,
    price_mode,
    apply_modifiers,
    weight_bands,
  });
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO price_scenarios
       (category_code, name, group_name, match_json, axis_x_key, axis_y_key,
        priority, status, price_mode, apply_modifiers)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        category_code,
        name,
        scenarioGroup,
        JSON.stringify(payload),
        normalized.axisXKey,
        normalized.axisYKey || null,
        normalized.priority,
        normalized.status,
        normalized.priceMode,
        normalized.applyModifiers,
      ]
    );
    const scenarioId = Number(result.rows[0].id);
    await syncScenarioWeightBands(
      client,
      scenarioId,
      normalized.weightBands,
      false
    );
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'pricing.scenario.created',
      subjectType: 'pricing_scenario',
      subjectId: scenarioId,
      details: {
        categoryCode: category_code,
        name,
        groupName: scenarioGroup,
        axisXKey: normalized.axisXKey,
        axisYKey: normalized.axisYKey || null,
        status: normalized.status,
        priceMode: normalized.priceMode,
        weightBandCount: normalized.weightBands.length,
      },
    });
    await client.query('COMMIT');
    return { id: scenarioId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateScenario({
  id,
  name,
  group_name,
  match_json,
  axis_x_key,
  axis_y_key,
  priority,
  status,
  price_mode,
  apply_modifiers,
  weight_bands,
}, options = {}) {
  const payload = typeof match_json === 'string' ? JSON.parse(match_json) : match_json || {};
  const scenarioGroup = normalizeScenarioGroup(group_name, name);
  const normalized = normalizeScenarioPayload({
    axis_x_key,
    axis_y_key,
    priority,
    status,
    price_mode,
    apply_modifiers,
    weight_bands,
  }, 'active');
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT id, category_code, name, group_name, match_json, axis_x_key, axis_y_key,
              priority, status, price_mode, apply_modifiers
       FROM price_scenarios
       WHERE id = $1
       FOR UPDATE`,
      [Number(id)]
    );
    if (currentResult.rows.length === 0) {
      const err = new Error('Сценарій не знайдено');
      err.statusCode = 404;
      throw err;
    }

    const current = currentResult.rows[0];
    const changes = {};
    addAuditChange(changes, 'name', current.name, name);
    addAuditChange(changes, 'groupName', current.group_name || '', scenarioGroup);
    addAuditChange(changes, 'matchRule', current.match_json || {}, payload, { sensitive: true });
    addAuditChange(changes, 'axisXKey', current.axis_x_key, normalized.axisXKey);
    addAuditChange(changes, 'axisYKey', current.axis_y_key, normalized.axisYKey || null);
    addAuditChange(changes, 'priority', Number(current.priority), normalized.priority);
    addAuditChange(changes, 'status', current.status, normalized.status);
    addAuditChange(changes, 'priceMode', current.price_mode, normalized.priceMode);
    addAuditChange(
      changes,
      'applyModifiers',
      Boolean(current.apply_modifiers),
      normalized.applyModifiers
    );

    if (Object.keys(changes).length > 0) {
      await client.query(
        `UPDATE price_scenarios
         SET name = $1, group_name = $2, match_json = $3::jsonb,
             axis_x_key = $4, axis_y_key = $5, priority = $6, status = $7,
             price_mode = $8, apply_modifiers = $9
         WHERE id = $10`,
        [
          name,
          scenarioGroup,
          JSON.stringify(payload),
          normalized.axisXKey,
          normalized.axisYKey || null,
          normalized.priority,
          normalized.status,
          normalized.priceMode,
          normalized.applyModifiers,
          Number(id),
        ]
      );
    }
    const weightBandChanges = await syncScenarioWeightBands(
      client,
      Number(id),
      normalized.weightBands,
      current.axis_x_key === 'weight_band'
    );
    if (Object.keys(changes).length > 0 || hasWeightBandChanges(weightBandChanges)) {
      await writeAuditEvent(client, {
        mutationContext,
        eventKey: 'pricing.scenario.updated',
        subjectType: 'pricing_scenario',
        subjectId: Number(id),
        details: {
          categoryCode: current.category_code,
          name,
          changes,
          ...(hasWeightBandChanges(weightBandChanges) ? { weightBandChanges } : {}),
        },
      });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function duplicateScenario(id, options = {}) {
  const mutationContext = createMutationContext(options.mutationContext);
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
      `INSERT INTO price_scenarios
       (category_code, name, group_name, match_json, axis_x_key, axis_y_key,
        priority, status, price_mode, apply_modifiers)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 'draft', $8, $9)
       RETURNING id`,
      [
        source.category_code,
        `${source.name} (копія)`,
        normalizeScenarioGroup(source.group_name, source.name),
        JSON.stringify(source.match_json || {}),
        source.axis_x_key,
        source.axis_y_key,
        Number(source.priority || 0),
        normalizePriceMode(source.price_mode),
        source.apply_modifiers !== false,
      ]
    );

    const newScenarioId = duplicatedScenario.rows[0].id;
    const bandIdMap = new Map();
    const sourceBands = await client.query(
      `SELECT id, label, min_weight, max_weight, sort_order
       FROM price_weight_bands
       WHERE scenario_id = $1
       ORDER BY sort_order, min_weight`,
      [Number(id)]
    );
    for (const band of sourceBands.rows) {
      const insertedBand = await client.query(
        `INSERT INTO price_weight_bands
         (scenario_id, label, min_weight, max_weight, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [newScenarioId, band.label, band.min_weight, band.max_weight, band.sort_order]
      );
      bandIdMap.set(Number(band.id), Number(insertedBand.rows[0].id));
    }

    const sourceMatrix = await client.query(
      'SELECT x_val, y_val, price FROM price_matrix WHERE scenario_id = $1',
      [Number(id)]
    );
    let copiedMatrixCellCount = 0;
    for (const cell of sourceMatrix.rows) {
      const xVal = source.axis_x_key === 'weight_band'
        ? bandIdMap.get(Number(cell.x_val))
        : Number(cell.x_val);
      if (xVal === undefined) continue;
      await client.query(
        `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
         VALUES ($1, $2, $3, $4)`,
        [Number(newScenarioId), xVal, Number(cell.y_val), Number(cell.price)]
      );
      copiedMatrixCellCount += 1;
    }

    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'pricing.scenario.duplicated',
      subjectType: 'pricing_scenario',
      subjectId: Number(newScenarioId),
      details: {
        sourceScenarioId: Number(id),
        categoryCode: source.category_code,
        name: `${source.name} (копія)`,
        status: 'draft',
        copiedWeightBandCount: sourceBands.rows.length,
        copiedMatrixCellCount,
      },
    });

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
  let firstEntry = null;
  for (const [key, value] of Object.entries(asRuleObject(rule))) {
    if (key === '$or' || key === '$and') {
      if (Array.isArray(value)) {
        for (const branch of value) {
          const nestedTrigger = getLegacyModifierTrigger(branch);
          if (nestedTrigger.triggerKey) return nestedTrigger;
        }
      }
      continue;
    }
    firstEntry = [key, value];
    break;
  }

  const [firstKey, firstValue] = firstEntry || ['', 0];
  const normalizedValue = Array.isArray(firstValue) ? firstValue[0] : firstValue;
  return {
    triggerKey: firstKey || '',
    triggerVal: normalizedValue === undefined || normalizedValue === null || normalizedValue === ''
      ? 0
      : Number(normalizedValue),
  };
}

async function createModifier(
  { category_code, trigger_key, trigger_val, match_json, factor },
  options = {}
) {
  const payload = normalizeModifierRule({ match_json, trigger_key, trigger_val });
  const legacyTrigger = getLegacyModifierTrigger(payload);
  const normalizedFactor = Number(factor);
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO price_modifiers (category_code, trigger_key, trigger_val, match_json, factor)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id`,
      [
        category_code,
        legacyTrigger.triggerKey,
        legacyTrigger.triggerVal,
        JSON.stringify(payload),
        normalizedFactor,
      ]
    );
    const modifierId = Number(result.rows[0].id);
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'pricing.modifier.created',
      subjectType: 'pricing_modifier',
      subjectId: modifierId,
      details: {
        categoryCode: category_code,
        triggerKey: legacyTrigger.triggerKey,
        triggerValue: legacyTrigger.triggerVal,
        factor: normalizedFactor,
      },
    });
    await client.query('COMMIT');
    return { id: modifierId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function updateModifier(
  { id, factor, match_json, trigger_key, trigger_val },
  options = {}
) {
  const factorOnly = match_json === undefined
    && trigger_key === undefined
    && trigger_val === undefined;
  const normalizedFactor = Number(factor);
  const mutationContext = createMutationContext(options.mutationContext);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT id, category_code, trigger_key, trigger_val, match_json, factor
       FROM price_modifiers
       WHERE id = $1
       FOR UPDATE`,
      [Number(id)]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('COMMIT');
      return;
    }

    const payload = factorOnly
      ? current.match_json || {}
      : normalizeModifierRule({ match_json, trigger_key, trigger_val });
    const legacyTrigger = factorOnly
      ? {
          triggerKey: current.trigger_key || '',
          triggerVal: current.trigger_val === null ? 0 : Number(current.trigger_val),
        }
      : getLegacyModifierTrigger(payload);
    const changes = {};
    addAuditChange(changes, 'factor', Number(current.factor), normalizedFactor);
    addAuditChange(changes, 'triggerKey', current.trigger_key || '', legacyTrigger.triggerKey);
    addAuditChange(
      changes,
      'triggerValue',
      current.trigger_val === null ? 0 : Number(current.trigger_val),
      legacyTrigger.triggerVal
    );
    addAuditChange(changes, 'matchRule', current.match_json || {}, payload, { sensitive: true });

    if (Object.keys(changes).length === 0) {
      await client.query('COMMIT');
      return;
    }

    if (factorOnly) {
      await client.query('UPDATE price_modifiers SET factor = $1 WHERE id = $2', [
        normalizedFactor,
        Number(id),
      ]);
    } else {
      await client.query(
        `UPDATE price_modifiers
         SET trigger_key = $1, trigger_val = $2, match_json = $3::jsonb, factor = $4
         WHERE id = $5`,
        [
          legacyTrigger.triggerKey,
          legacyTrigger.triggerVal,
          JSON.stringify(payload),
          normalizedFactor,
          Number(id),
        ]
      );
    }
    await writeAuditEvent(client, {
      mutationContext,
      eventKey: 'pricing.modifier.updated',
      subjectType: 'pricing_modifier',
      subjectId: Number(id),
      details: {
        categoryCode: current.category_code,
        changes,
      },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  calculatePricing,
  loadPricingContext,
  getAdminPrices,
  upsertPriceCell,
  createScenario,
  updateScenario,
  duplicateScenario,
  createModifier,
  updateModifier,
};
