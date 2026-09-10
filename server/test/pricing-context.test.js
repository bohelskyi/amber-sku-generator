const assert = require('node:assert/strict');
const test = require('node:test');

const { calculatePricing, loadPricingContext } = require('../src/services/pricing.service');

test('reused pricing context avoids per-product SQL round trips', async () => {
  let queryCount = 0;
  const queryable = {
    async query(sql) {
      queryCount += 1;
      if (sql.includes('FROM price_scenarios')) return { rows: [{
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
      }] };
      if (sql.includes('FROM categories')) return { rows: [{ requires_weight: 0 }] };
      if (sql.includes('FROM price_weight_bands')) return { rows: [] };
      if (sql.includes('FROM price_matrix')) return { rows: [
        { scenario_id: 1, x_val: 1, y_val: 0, price: '1000.0000' },
      ] };
      if (sql.includes('FROM price_modifiers')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const context = await loadPricingContext('ZZ', queryable);
  const contextQueryCount = queryCount;
  const first = await calculatePricing('ZZ', { kind: 1 }, 0, 0, {
    context,
    rateInfo: { rate: 40, source: 'test', fetchedAt: new Date().toISOString() },
  });
  const second = await calculatePricing('ZZ', { kind: 1 }, 0, 0, {
    context,
    rateInfo: { rate: 40, source: 'test', fetchedAt: new Date().toISOString() },
  });
  assert.equal(queryCount, contextQueryCount);
  assert.equal(first.currencyPayload.calculatedPriceUah, 1000);
  assert.equal(first.currencyPayload.totalPriceUah, 1000);
  assert.equal(second.currencyPayload.totalPriceUah, 1000);

  context.matrixByCell.set('1:1:0', {
    scenario_id: 1,
    x_val: 1,
    y_val: 0,
    price: '2556.0000',
  });
  const marketingRounded = await calculatePricing('ZZ', { kind: 1 }, 0, 0, {
    context,
    rateInfo: { rate: 40, source: 'test', fetchedAt: new Date().toISOString() },
  });
  assert.equal(marketingRounded.currencyPayload.calculatedPriceUah, 2556);
  assert.equal(marketingRounded.currencyPayload.totalPriceUah, 2550);
});
