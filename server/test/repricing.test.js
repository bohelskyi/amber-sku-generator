const test = require('node:test');
const assert = require('node:assert/strict');

const { getPreviewToken, hasManualPrice } = require('../src/services/repricing.service');

const scenario = {
  id: 63,
  category_code: 'NM',
  name: 'Дитячі',
  match_json: { extra: 2 },
  axis_x_key: 'weight_band',
  axis_y_key: 'processing',
  priority: 100,
  price_mode: 'fixed_uah',
  apply_modifiers: false,
};

test('repricing preview token is stable for the same changes', () => {
  const items = [{ productId: 1, oldPriceUah: 300, newPriceUah: 400 }];

  assert.equal(getPreviewToken(scenario, items), getPreviewToken(scenario, items));
  assert.notEqual(
    getPreviewToken(scenario, items),
    getPreviewToken(scenario, [{ ...items[0], newPriceUah: 500 }])
  );
});

test('repricing identifies an explicit manual price', () => {
  assert.equal(hasManualPrice({ manualPriceUah: 450 }), true);
  assert.equal(hasManualPrice({ manualPriceUah: '450' }), true);
  assert.equal(hasManualPrice({ manualPriceUah: null }), false);
  assert.equal(hasManualPrice({}), false);
});
