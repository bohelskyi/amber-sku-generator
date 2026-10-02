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
      if (sql.includes('public_product_identities')) return { rows: [] };
      return { rows: [{ code: 'NM', name: 'Necklace', requires_weight: 0 }] };
    },
  };

  await assert.rejects(
    decodeSku('XX123', queryable),
    (error) => error.statusCode === 422
      && error.details.type === 'unknown_category'
      && error.details.received === 'XX'
  );
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /FROM categories/);
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

test('stored SV legacy reads use stored schema, answers and zero pricing for internal and public lookup', async () => {
  const product = {
    id: 17, full_sku: 'SV5111010', public_sku: 'AG-000017', category: 'SV',
    base_sku: 'SV5111', sequence_number: 10, sku_schema_version_id: 42,
    weight: '4.500', total_price: '0', total_price_uah: '0', price_per_gram: '0', uah_rate: null,
    legacy_uah_price_unset: true,
    details: { answers: { souvenir: 5 }, isCalibrated: 2, manualPriceUah: 500,
      pricingScenario: { name: 'Historical fixed', price_mode: 'fixed_uah',
        match_json: { is_calibrated: 2 }, axis_x_key: 'souvenir', axis_y_key: null } },
  };
  for (const sku of [product.full_sku, product.public_sku]) {
    const queryable = { async query(sql, params) {
      if (sql.includes('public_product_identities')) return { rows: [{ ...product,
        public_match: sku === product.public_sku, internal_match: sku === product.full_sku }] };
      if (sql.includes('FROM categories')) return { rows: [{ code: 'SV', name: 'Souvenirs', requires_weight: 0 }] };
      if (sql.includes('FROM sku_schema_versions')) {
        assert.match(sql, /WHERE id = \$1/);
        assert.deepEqual(params, [42]);
        return { rows: [{ id: 42, version: 3, marker: '3/', status: 'archived' }] };
      }
      if (sql.includes('FROM sku_schema_questions')) return { rows: [{
        question_id: 1, question_key: 'souvenir', question_label: 'Souvenir', sku_index: 1,
        required: 1, value_id: 5, sku_code: '8', option_label: 'Stored option', archived: true,
      }] };
      if (sql.includes('FROM questions')) return { rows: [{ visible_if_json: null }] };
      throw new Error(`Unexpected query during stored read: ${sql}`);
    } };
    const decoded = await decodeSku(sku, queryable);
    assert.equal(decoded.skuSchema.version, 3);
    assert.equal(decoded.decodeSource, 'stored_history');
    assert.equal(decoded.internalSku, product.full_sku);
    assert.equal(decoded.publicSku, product.public_sku);
    assert.equal(decoded.product.id, 17);
    assert.equal(decoded.decodedAnswers[0].value_id, 5);
    assert.equal(decoded.decodedAnswers[0].value_label, 'Stored option');
    assert.equal(decoded.calibration.value, 2);
    assert.equal(decoded.pricing.weight, 4.5);
    assert.equal(decoded.pricing.totalPriceUah, 0);
    assert.equal(decoded.pricing.automaticPriceUah, null);
    assert.equal(decoded.pricing.calculatedPriceUah, null);
    assert.deepEqual(decoded.pricing.dependentKeys, ['is_calibrated', 'souvenir']);
    assert.equal(decoded.pricing.matrixName, 'Historical fixed');
  }
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
