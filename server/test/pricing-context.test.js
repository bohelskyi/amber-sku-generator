const assert = require('node:assert/strict');
const test = require('node:test');

const { calculatePricing, loadPricingContext } = require('../src/services/pricing.service');
const {
  loadPricingContexts,
  loadScenarioPricingContext,
} = require('../src/services/pricing/pricing-context');

function contextRow(categoryCode, overrides = {}) {
  return {
    category_code: categoryCode,
    requires_weight: 0,
    scenarios: [],
    weight_bands: [],
    matrix: [],
    modifiers: [],
    ordinal: 1,
    ...overrides,
  };
}

test('single-category context is hydrated by one query without taking transaction ownership', async () => {
  const calls = [];
  const queryable = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [contextRow('ZZ', {
        scenarios: [{
          id: 1,
          category_code: 'ZZ',
          name: 'Matrix',
          group_name: '',
          match_json: {},
          axis_x_key: 'kind',
          axis_y_key: null,
          priority: 0,
          status: 'active',
          price_mode: 'fixed_uah',
          apply_modifiers: true,
        }],
        weight_bands: [{
          id: 4,
          scenario_id: 1,
          label: 'All',
          min_weight: '0',
          max_weight: null,
          sort_order: 0,
        }],
        matrix: [{ scenario_id: 1, x_val: 1, y_val: 0, price: '1000.0000' }],
        modifiers: [{
          id: 2,
          category_code: 'ZZ',
          trigger_key: 'kind',
          trigger_val: 1,
          match_json: {},
          factor: '1.100000',
        }],
      })] };
    },
  };

  const context = await loadPricingContext('ZZ', queryable);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, [['ZZ']]);
  assert.match(calls[0].sql, /WITH requested/);
  assert.equal(context.categoryCode, 'ZZ');
  assert.deepEqual(context.category, { requires_weight: 0 });
  assert.equal(context.scenarios[0].id, 1);
  assert.equal(context.weightBandsByScenario.get(1)[0].min_weight, '0');
  assert.equal(context.matrixByCell.get('1:1:0').price, '1000.0000');
  assert.equal(context.modifiers[0].factor, '1.100000');
  assert.equal(queryable.connect, undefined);
  assert.equal(queryable.release, undefined);
});

test('reused pricing context avoids all per-product SQL round trips', async () => {
  let queryCount = 0;
  const queryable = {
    async query() {
      queryCount += 1;
      return { rows: [contextRow('ZZ', {
        scenarios: [{
          id: 1,
          category_code: 'ZZ',
          name: 'Matrix',
          match_json: {},
          axis_x_key: 'kind',
          axis_y_key: null,
          priority: 0,
          status: 'active',
          price_mode: 'fixed_uah',
          apply_modifiers: true,
        }],
        matrix: [{ scenario_id: 1, x_val: 1, y_val: 0, price: '1000.0000' }],
      })] };
    },
  };
  const context = await loadPricingContext('ZZ', queryable);
  const first = await calculatePricing('ZZ', { kind: 1 }, 0, 0, {
    context,
    rateInfo: { rate: 40, source: 'test', fetchedAt: '2026-09-11T00:00:00Z' },
  });
  const second = await calculatePricing('ZZ', { kind: 1 }, 0, 0, {
    context,
    rateInfo: { rate: 40, source: 'test', fetchedAt: '2026-09-11T00:00:00Z' },
  });
  assert.equal(queryCount, 1);
  assert.equal(first.currencyPayload.totalPriceUah, 1000);
  assert.equal(second.currencyPayload.totalPriceUah, 1000);
});

test('bulk contexts share one statement and preserve requested category order', async () => {
  let callCount = 0;
  const queryable = {
    async query(sql, values) {
      callCount += 1;
      assert.match(sql, /unnest\(\$1::text\[\]\)/);
      assert.deepEqual(values, [['BB', 'AA']]);
      return { rows: [contextRow('BB'), contextRow('AA', { ordinal: 2 })] };
    },
  };

  const contexts = await loadPricingContexts(['BB', 'AA', 'BB'], queryable);
  assert.equal(callCount, 1);
  assert.deepEqual([...contexts.keys()], ['BB', 'AA']);
  assert.equal(contexts.get('AA').categoryCode, 'AA');
  assert.deepEqual(await loadPricingContexts([], queryable), new Map());
  assert.equal(callCount, 1);
});

test('missing categories retain the legacy empty context shape', async () => {
  const queryable = {
    async query() {
      return { rows: [contextRow('MISSING', { requires_weight: null })] };
    },
  };
  const context = await loadPricingContext('MISSING', queryable);
  assert.deepEqual(context, {
    categoryCode: 'MISSING',
    category: null,
    scenarios: [],
    weightBandsByScenario: new Map(),
    matrixByCell: new Map(),
    modifiers: [],
  });
});

test('scenario-target context uses one query and rejects inactive or missing targets', async () => {
  let rows = [];
  let callCount = 0;
  const queryable = {
    async query() {
      callCount += 1;
      return { rows };
    },
  };
  assert.equal(await loadScenarioPricingContext(99, queryable), null);

  rows = [contextRow('ZZ', {
    scenarios: [{ id: 9, category_code: 'ZZ', status: 'active' }],
    target_scenario: { id: 9, category_code: 'ZZ', status: 'active' },
  })];
  const loaded = await loadScenarioPricingContext(9, queryable);
  assert.equal(callCount, 2);
  assert.deepEqual(loaded.scenario, { id: 9, category_code: 'ZZ', status: 'active' });
  assert.equal(loaded.context.categoryCode, 'ZZ');
});

test('category mismatch retains its exact error', async () => {
  const context = {
    categoryCode: 'OTHER',
    category: null,
    scenarios: [],
    weightBandsByScenario: new Map(),
    matrixByCell: new Map(),
    modifiers: [],
  };
  await assert.rejects(
    calculatePricing('ZZ', {}, 0, 0, { context, rateInfo: { rate: 40 } }),
    { message: 'Pricing context does not belong to category ZZ' }
  );
});
