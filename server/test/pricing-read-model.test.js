const assert = require('node:assert/strict');
const test = require('node:test');

const { getAdminPrices } = require('../src/services/pricing/pricing-read-model');

test('Admin pricing read model preserves its exact shape, types, and database order', async () => {
  const calls = [];
  const queryable = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{
        scenarios: [
          {
            id: 2,
            category_code: 'ZZ',
            name: 'Draft',
            group_name: 'A',
            match_json: { kind: 2 },
            axis_x_key: 'weight_band',
            axis_y_key: null,
            priority: 5,
            status: 'draft',
            price_mode: 'fixed_uah',
            apply_modifiers: false,
          },
          {
            id: 1,
            category_code: 'ZZ',
            name: 'Active',
            group_name: 'B',
            match_json: {},
            axis_x_key: 'kind',
            axis_y_key: 'tone',
            priority: 0,
            status: 'active',
            price_mode: 'per_gram_usd',
            apply_modifiers: true,
          },
        ],
        matrix: [
          { scenario_id: 1, x_val: 1, y_val: 2, price: '3.2500' },
          { scenario_id: 2, x_val: 20, y_val: 0, price: '1000.0000' },
        ],
        weight_bands: [
          { id: 20, scenario_id: 2, label: 'Small', min_weight: '0', max_weight: '5.5', sort_order: 0 },
          { id: 21, scenario_id: 2, label: 'Large', min_weight: '5.5', max_weight: null, sort_order: 1 },
        ],
        modifiers: [{
          id: 4,
          category_code: 'ZZ',
          trigger_key: 'kind',
          trigger_val: 2,
          match_json: { kind: 2 },
          factor: '1.200000',
        }],
      }] };
    },
  };

  const actual = await getAdminPrices('ZZ', queryable);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ['ZZ']);
  assert.match(calls[0].sql, /status/);
  assert.deepEqual(actual, {
    scenarios: [
      {
        id: 2,
        category_code: 'ZZ',
        name: 'Draft',
        group_name: 'A',
        match_json: { kind: 2 },
        axis_x_key: 'weight_band',
        axis_y_key: null,
        priority: 5,
        status: 'draft',
        price_mode: 'fixed_uah',
        apply_modifiers: false,
        matrix: [{ scenario_id: 2, x_val: 20, y_val: 0, price: '1000.0000' }],
        weight_bands: [
          { id: 20, scenario_id: 2, label: 'Small', min_weight: 0, max_weight: 5.5, sort_order: 0 },
          { id: 21, scenario_id: 2, label: 'Large', min_weight: 5.5, max_weight: null, sort_order: 1 },
        ],
      },
      {
        id: 1,
        category_code: 'ZZ',
        name: 'Active',
        group_name: 'B',
        match_json: {},
        axis_x_key: 'kind',
        axis_y_key: 'tone',
        priority: 0,
        status: 'active',
        price_mode: 'per_gram_usd',
        apply_modifiers: true,
        matrix: [{ scenario_id: 1, x_val: 1, y_val: 2, price: '3.2500' }],
        weight_bands: [],
      },
    ],
    modifiers: [{
      id: 4,
      category_code: 'ZZ',
      trigger_key: 'kind',
      trigger_val: 2,
      match_json: { kind: 2 },
      factor: '1.200000',
    }],
  });
});

test('Admin pricing read model returns empty arrays for an empty category', async () => {
  let calls = 0;
  const queryable = {
    async query() {
      calls += 1;
      return { rows: [{ scenarios: [], matrix: [], weight_bands: [], modifiers: [] }] };
    },
  };
  assert.deepEqual(await getAdminPrices('EMPTY', queryable), { scenarios: [], modifiers: [] });
  assert.equal(calls, 1);
});
