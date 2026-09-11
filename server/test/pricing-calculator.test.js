const assert = require('node:assert/strict');
const test = require('node:test');

const { calculatePricing } = require('../src/services/pricing.service');

function makeContext({
  categoryCode = 'ZZ',
  requiresWeight = 0,
  scenarios = [],
  weightBands = [],
  matrix = [],
  modifiers = [],
} = {}) {
  const weightBandsByScenario = new Map();
  for (const band of weightBands) {
    const scenarioId = Number(band.scenario_id);
    if (!weightBandsByScenario.has(scenarioId)) weightBandsByScenario.set(scenarioId, []);
    weightBandsByScenario.get(scenarioId).push(band);
  }

  const matrixByCell = new Map();
  for (const cell of matrix) {
    matrixByCell.set(
      `${Number(cell.scenario_id)}:${Number(cell.x_val)}:${Number(cell.y_val)}`,
      cell
    );
  }

  return {
    categoryCode,
    category: { requires_weight: requiresWeight },
    scenarios,
    weightBandsByScenario,
    matrixByCell,
    modifiers,
  };
}

const RATE = {
  rate: 40,
  source: 'test-cache',
  rateDate: '2026-09-10',
  fetchedAt: '2026-09-11T08:00:00.000Z',
  ageMs: 1234,
  stale: true,
  error: 'using stale rate',
};

test('fixed UAH pricing preserves the complete public result shape', async () => {
  const context = makeContext({
    scenarios: [{
      id: 7,
      category_code: 'ZZ',
      name: 'Fixed',
      group_name: 'Group',
      match_json: { kind: 2 },
      axis_x_key: 'size',
      axis_y_key: null,
      priority: 3,
      status: 'active',
      price_mode: 'fixed_uah',
      apply_modifiers: true,
    }],
    matrix: [{ scenario_id: 7, x_val: 4, y_val: 0, price: '2556.0000' }],
  });

  const actual = await calculatePricing('ZZ', { kind: 2, size: 4 }, 0, 0, {
    context,
    rateInfo: RATE,
  });

  assert.deepEqual(actual, {
    weightVal: 0,
    pricePerGram: 0,
    fixedPriceUah: 2556,
    priceMode: 'fixed_uah',
    usesWeight: false,
    totalPrice: '63.90',
    logMessage: 'Fixed (Базова: 2556 ₴)',
    currencyPayload: {
      uahRate: 40,
      pricePerGramUah: null,
      calculatedPriceUah: 2556,
      totalPriceUah: 2550,
      uahRateSource: 'test-cache',
      uahRateDate: '2026-09-10',
      uahRateFetchedAt: '2026-09-11T08:00:00.000Z',
      uahRateAgeMs: 1234,
      uahRateStale: true,
      uahRateError: 'using stale rate',
    },
    pricingDetails: {
      isWeightBased: false,
      usesWeight: false,
      priceMode: 'fixed_uah',
      calibratedValue: 0,
      scenario: {
        id: 7,
        name: 'Fixed',
        group_name: 'Group',
        match_json: { kind: 2 },
        axis_x_key: 'size',
        axis_y_key: null,
        priority: 3,
        status: 'active',
        price_mode: 'fixed_uah',
        apply_modifiers: true,
      },
      matrix: {
        x: { key: 'size', value: 4, label: null, dependentKeys: ['size'] },
        y: { key: null, value: 0, label: null, dependentKeys: [] },
      },
      basePrice: 2556,
      finalPricePerGram: null,
      finalFixedPriceUah: 2556,
      matchedModifiers: [],
      dependentKeys: ['kind', 'size'],
    },
  });
});

test('per-gram weight bands use inclusive lower and exclusive upper bounds', async () => {
  const scenario = {
    id: 8,
    name: 'Bands',
    group_name: '',
    match_json: {},
    axis_x_key: 'weight_band',
    axis_y_key: 'kind',
    priority: 0,
    status: 'active',
    price_mode: 'per_gram_usd',
    apply_modifiers: true,
  };
  const context = makeContext({
    requiresWeight: 1,
    scenarios: [scenario],
    weightBands: [
      { id: 80, scenario_id: 8, label: 'Light', min_weight: '0', max_weight: '5' },
      { id: 81, scenario_id: 8, label: 'Heavy', min_weight: '5', max_weight: null },
    ],
    matrix: [
      { scenario_id: 8, x_val: 80, y_val: 1, price: '2.0000' },
      { scenario_id: 8, x_val: 81, y_val: 1, price: '3.0000' },
    ],
  });

  const below = await calculatePricing('ZZ', { kind: 1 }, 4.999, 0, { context, rateInfo: RATE });
  const boundary = await calculatePricing('ZZ', { kind: 1 }, 5, 0, { context, rateInfo: RATE });

  assert.equal(below.pricingDetails.matrix.x.value, 80);
  assert.equal(below.pricingDetails.matrix.x.label, 'Light');
  assert.equal(below.currencyPayload.calculatedPriceUah, 399.91999999999996);
  assert.equal(boundary.pricingDetails.matrix.x.value, 81);
  assert.equal(boundary.pricingDetails.matrix.x.label, 'Heavy');
  assert.equal(boundary.totalPrice, '15.00');
  assert.equal(boundary.currencyPayload.pricePerGramUah, '120.00');
  assert.equal(boundary.currencyPayload.totalPriceUah, 600);
  assert.deepEqual(boundary.pricingDetails.dependentKeys, ['weight', 'kind']);
});

test('scenario precedence and calibration values 0, 1, and 2 stay distinct', async () => {
  const scenarios = [
    { id: 30, name: 'Fallback', match_json: {}, axis_x_key: null, axis_y_key: null, priority: 0, price_mode: 'fixed_uah' },
    { id: 12, name: 'Calibrated 1', match_json: { is_calibrated: 1 }, axis_x_key: null, axis_y_key: null, priority: 5, price_mode: 'fixed_uah' },
    { id: 11, name: 'Calibrated 2', match_json: { is_calibrated: 2 }, axis_x_key: null, axis_y_key: null, priority: 5, price_mode: 'fixed_uah' },
  ];
  const context = makeContext({
    scenarios,
    matrix: [
      { scenario_id: 30, x_val: 0, y_val: 0, price: '100' },
      { scenario_id: 12, x_val: 0, y_val: 0, price: '200' },
      { scenario_id: 11, x_val: 0, y_val: 0, price: '300' },
    ],
  });

  const zero = await calculatePricing('ZZ', {}, 0, 0, { context, rateInfo: RATE });
  const one = await calculatePricing('ZZ', { is_calibrated: 1 }, 0, 0, { context, rateInfo: RATE });
  const two = await calculatePricing('ZZ', { is_calibrated: 2 }, 0, 0, { context, rateInfo: RATE });

  assert.equal(zero.pricingDetails.scenario.id, 30);
  assert.equal(zero.pricingDetails.calibratedValue, 0);
  assert.equal(one.pricingDetails.scenario.id, 12);
  assert.equal(one.pricingDetails.calibratedValue, 1);
  assert.equal(two.pricingDetails.scenario.id, 11);
  assert.equal(two.pricingDetails.calibratedValue, 2);
});

test('contextual modifier rules take precedence over legacy triggers and retain order', async () => {
  const context = makeContext({
    scenarios: [{
      id: 9,
      name: 'Modified',
      match_json: { $and: [{ kind: 1 }, { $or: [{ tone: 2 }, { missing: 0 }] }] },
      axis_x_key: 'kind+variant',
      axis_y_key: null,
      priority: 0,
      price_mode: 'fixed_uah',
      apply_modifiers: true,
    }],
    matrix: [{ scenario_id: 9, x_val: 6, y_val: 0, price: '1000' }],
    modifiers: [
      { id: 4, trigger_key: 'kind', trigger_val: 99, match_json: { tone: 2 }, factor: '1.5' },
      { id: 5, trigger_key: 'kind', trigger_val: 1, match_json: {}, factor: '2' },
    ],
  });

  const actual = await calculatePricing('ZZ', { kind: 1, variant: 2, tone: 2 }, 0, 0, {
    context,
    rateInfo: RATE,
  });

  assert.equal(actual.fixedPriceUah, 3000);
  assert.equal(actual.logMessage, 'Modified (Базова: 1000 ₴) + Модифікатор (50%) + Модифікатор (100%)');
  assert.deepEqual(actual.pricingDetails.matchedModifiers.map(({ id }) => id), [4, 5]);
  assert.deepEqual(actual.pricingDetails.dependentKeys, [
    'kind', 'tone', 'missing', 'variant',
  ]);
});

test('rate failures retain fixed UAH pricing and fail closed for per-gram pricing', async () => {
  const invalidRate = { rate: null, error: 'rate offline' };
  const fixedContext = makeContext({
    scenarios: [{ id: 1, name: 'Fixed', match_json: {}, axis_x_key: null, axis_y_key: null, price_mode: 'fixed_uah' }],
    matrix: [{ scenario_id: 1, x_val: 0, y_val: 0, price: '1000' }],
  });
  const weightedContext = makeContext({
    requiresWeight: 1,
    scenarios: [{ id: 2, name: 'Weighted', match_json: {}, axis_x_key: null, axis_y_key: null, price_mode: 'per_gram_usd' }],
    matrix: [{ scenario_id: 2, x_val: 0, y_val: 0, price: '2' }],
  });

  const fixed = await calculatePricing('ZZ', {}, 0, 0, { context: fixedContext, rateInfo: invalidRate });
  const weighted = await calculatePricing('ZZ', {}, 5, 0, { context: weightedContext, rateInfo: invalidRate });

  assert.deepEqual(fixed.currencyPayload, {
    uahRate: null,
    pricePerGramUah: null,
    calculatedPriceUah: 1000,
    totalPriceUah: 1000,
    uahRateError: 'rate offline',
  });
  assert.deepEqual(weighted.currencyPayload, {
    uahRate: null,
    pricePerGramUah: null,
    calculatedPriceUah: null,
    totalPriceUah: null,
    uahRateError: 'rate offline',
  });
});

test('category mismatch fails before any supplied rate is interpreted', async () => {
  const context = makeContext({ categoryCode: 'OTHER' });
  await assert.rejects(
    calculatePricing('ZZ', {}, 0, 0, { context, rateInfo: { rate: 40 } }),
    /Pricing context does not belong to category ZZ/
  );
});
