const assert = require('node:assert/strict');
const test = require('node:test');

const {
  decodeSku,
  getDecodedPricingPayload,
  resolveContextualAnswerLabels,
} = require('../src/services/product/product-decode');

test('decode reads through its supplied queryable and preserves unknown-category details', async () => {
  const calls = [];
  const queryable = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ code: 'NM', name: 'Necklace', requires_weight: 0 }] };
    },
  };

  await assert.rejects(
    decodeSku('XX123', queryable),
    (error) => error.statusCode === 422
      && error.details.type === 'unknown_category'
      && error.details.received === 'XX'
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM categories/);
});

test('decode labels contextual semantic values without replacing their SKU-independent ID', () => {
  const decoded = resolveContextualAnswerLabels([
    { key: 'is_calibrated', value_id: 2, value_label: 'Unknown' },
    { key: 'quality', value_id: 7, value_label: 'Generic' },
  ], [{
    key: 'quality',
    options: [
      { value_id: 7, sku_code: 'A', label: 'Generic' },
      {
        value_id: 7,
        sku_code: 'A',
        label: 'Unverified',
        visible_if_json: { is_calibrated: 2 },
      },
    ],
  }]);

  assert.equal(decoded[1].value_id, 7);
  assert.equal(decoded[1].value_label, 'Unverified');
});

test('decoded stored pricing keeps legacy zero and manual-price meanings separate', () => {
  const payload = getDecodedPricingPayload({
    decodedAnswers: [],
    product: {
      weight: 0,
      total_price: 0,
      total_price_uah: 0,
      price_per_gram: 0,
      uah_rate: null,
      details: {
        calculatedPriceUah: null,
        autoPriceUah: null,
        manualPriceUah: 500,
      },
    },
    pricing: {
      pricePerGram: 3,
      totalPrice: 12,
      currencyPayload: { calculatedPriceUah: 480, totalPriceUah: 500 },
      pricingDetails: { dependentKeys: [] },
    },
    pricingAnswers: {},
    suffixValue: null,
  });

  assert.equal(payload.source, 'stored');
  assert.equal(payload.calculatedPriceUah, null);
  assert.equal(payload.automaticPriceUah, null);
  assert.equal(payload.totalPriceUah, 0);
});
