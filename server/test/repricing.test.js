const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyManualOverridesToPreview,
  doesProductMatchRepricingBatch,
  getApplicationToken,
  getDraftSyncInfo,
  getPreviewToken,
  getRepricingPreviewFingerprint,
  getRepricingPreviewSnapshot,
  hasManualPrice,
  normalizeManualOverrides,
} = require('../src/services/repricing.service');

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

test('draft fingerprint includes unchanged candidates and calculation context', () => {
  const preview = {
    scenario: { id: 63, name: 'Children' },
    summary: { candidateCount: 1, changedCount: 0, unchangedCount: 1, skippedCount: 0, errorCount: 0 },
    items: [{
      productId: 10,
      sku: 'NM10',
      oldPriceUah: 500,
      newPriceUah: 500,
      status: 'unchanged',
      uahRate: 50,
    }],
  };

  assert.notEqual(
    getRepricingPreviewFingerprint(preview),
    getRepricingPreviewFingerprint({
      ...preview,
      items: [...preview.items, {
        productId: 11,
        sku: 'NM11',
        oldPriceUah: 600,
        newPriceUah: 600,
        status: 'unchanged',
        uahRate: 50,
      }],
    })
  );
});

test('draft synchronization reports added, removed, and recalculated products', () => {
  const storedPreview = {
    scenario: { id: 36, name: 'Old name' },
    summary: { candidateCount: 2 },
    items: [
      { productId: 1, sku: 'NM1', oldPriceUah: 100, newPriceUah: 200, status: 'changed' },
      { productId: 2, sku: 'NM2', oldPriceUah: 100, newPriceUah: 200, status: 'changed' },
    ],
  };
  const currentPreview = {
    scenario: { id: 36, name: 'New name' },
    summary: { candidateCount: 2 },
    items: [
      { productId: 1, sku: 'NM1', oldPriceUah: 100, newPriceUah: 250, status: 'changed' },
      { productId: 3, sku: 'NM3', oldPriceUah: 100, newPriceUah: 200, status: 'changed' },
    ],
  };
  const sync = getDraftSyncInfo(getRepricingPreviewSnapshot(storedPreview), currentPreview);

  assert.equal(sync.hasChanges, true);
  assert.equal(sync.contextChanged, true);
  assert.deepEqual(sync.added.map((item) => item.productId), [3]);
  assert.deepEqual(sync.removed.map((item) => item.productId), [2]);
  assert.deepEqual(sync.changed.map((item) => item.productId), [1]);
});

test('repricing identifies an explicit manual price', () => {
  assert.equal(hasManualPrice({ manualPriceUah: 450 }), true);
  assert.equal(hasManualPrice({ manualPriceUah: '450' }), true);
  assert.equal(hasManualPrice({ manualPriceUah: null }), false);
  assert.equal(hasManualPrice({}), false);
});

test('application token includes normalized manual overrides', () => {
  assert.equal(getApplicationToken('base-token', []), 'base-token');
  assert.equal(
    getApplicationToken('base-token', [
      { productId: 2, newPriceUah: 500 },
      { productId: 1, newPriceUah: '400,4' },
    ]),
    getApplicationToken('base-token', [
      { productId: 1, newPriceUah: 400 },
      { productId: 2, newPriceUah: 500 },
    ])
  );
});

test('manual overrides recalculate final UAH and derived USD prices', () => {
  const preview = applyManualOverridesToPreview({
    summary: { changedCount: 1, unchangedCount: 1, errorCount: 0 },
    items: [
      {
        productId: 1,
        sku: 'NM1',
        weight: 10,
        oldPriceUah: 400,
        newPriceUah: 500,
        totalPrice: 10,
        pricePerGram: 1,
        uahRate: 50,
        status: 'changed',
      },
      {
        productId: 2,
        sku: 'NM2',
        weight: 10,
        oldPriceUah: 600,
        newPriceUah: 600,
        status: 'unchanged',
      },
    ],
  }, [{ productId: 1, newPriceUah: '450,4' }]);

  assert.equal(preview.items[0].newPriceUah, 450);
  assert.equal(preview.items[0].calculatedPriceUah, 500);
  assert.equal(preview.items[0].totalPrice, 9);
  assert.equal(preview.items[0].pricePerGram, 0.9);
  assert.equal(preview.items[0].manualOverride, true);
  assert.equal(preview.summary.changedCount, 1);
});

test('manual overrides reject invalid and unrelated products', () => {
  assert.throws(
    () => normalizeManualOverrides([{ productId: 1, newPriceUah: 0 }]),
    /додатним числом/
  );
  assert.throws(
    () => applyManualOverridesToPreview(
      { summary: {}, items: [] },
      [{ productId: 99, newPriceUah: 500 }]
    ),
    /не належить/
  );
});

test('rollback only accepts a product still owned by the same repricing batch', () => {
  const product = {
    status: 'active',
    total_price: 10,
    total_price_uah: 500,
    price_per_gram: 1,
    uah_rate: 50,
    details: { repricing: { batchId: 12 } },
  };
  const payload = {
    totalPrice: 10,
    totalPriceUah: 500,
    pricePerGram: 1,
    uahRate: 50,
  };

  assert.equal(doesProductMatchRepricingBatch(product, payload, 12), true);
  assert.equal(doesProductMatchRepricingBatch(product, payload, 11), false);
  assert.equal(
    doesProductMatchRepricingBatch({ ...product, total_price_uah: 501 }, payload, 12),
    false
  );
});
