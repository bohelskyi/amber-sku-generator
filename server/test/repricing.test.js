const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertNoBlockingCorrectionRequests,
  applyManualOverridesToPreview,
  buildPricingChange,
  buildPricingState,
  doesProductMatchRepricingBatch,
  getApplicationToken,
  getDraftSyncInfo,
  getGlobalPreviewToken,
  getPreviewToken,
  getRepricingPreviewFingerprint,
  getRepricingPreviewSnapshot,
  getRepricingProductIds,
  hasManualPrice,
  normalizeManualOverrides,
  normalizeReviewedProductIds,
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

test('global repricing token binds configuration and every product exactly once', () => {
  const items = [
    {
      productId: 2,
      productStateToken: 'product-2',
      scenarioId: 22,
      oldPriceUah: 200,
      newPriceUah: 250,
      status: 'changed',
      pricingState: 'automatic',
    },
    {
      productId: 1,
      productStateToken: 'product-1',
      scenarioId: 11,
      oldPriceUah: 100,
      newPriceUah: 100,
      status: 'unchanged',
      pricingState: 'automatic',
    },
  ];

  assert.equal(
    getGlobalPreviewToken('configuration-a', items),
    getGlobalPreviewToken('configuration-a', [...items].reverse())
  );
  assert.notEqual(
    getGlobalPreviewToken('configuration-a', items),
    getGlobalPreviewToken('configuration-b', items)
  );
  assert.notEqual(
    getGlobalPreviewToken('configuration-a', items),
    getGlobalPreviewToken('configuration-a', [items[0]])
  );
});

test('repricing blocking checks use every unique candidate product', () => {
  assert.deepEqual(getRepricingProductIds({
    items: [
      { productId: 7, status: 'changed' },
      { productId: '3', status: 'unchanged' },
      { productId: 7, status: 'error' },
      { productId: 0 },
      { productId: 'invalid' },
    ],
  }), [3, 7]);
});

test('active correction requests block repricing at the service boundary', () => {
  const requests = [{ id: 12, sourceProductId: 7, sourceSku: 'NM7' }];

  assert.throws(
    () => assertNoBlockingCorrectionRequests(requests),
    (error) => (
      error.statusCode === 409
      && error.details?.type === 'active_correction_requests'
      && error.details.requests === requests
      && error.message.includes('#12')
    )
  );
  assert.doesNotThrow(() => assertNoBlockingCorrectionRequests([]));
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

test('pricing explanation prioritizes matrix and per-gram changes over exchange-rate noise', () => {
  const change = buildPricingChange(
    buildPricingState({
      details: { logMessage: 'Стара матриця (Базова: $1.5)' },
      pricePerGram: 1.5,
      uahRate: 41.2,
      priceUah: 618,
    }),
    buildPricingState({
      matrixName: 'Нова матриця',
      priceMode: 'per_gram_usd',
      pricePerGram: 2,
      uahRate: 42,
      priceUah: 840,
    })
  );

  assert.equal(change.oldMatrixName, 'Стара матриця');
  assert.equal(change.newMatrixName, 'Нова матриця');
  assert.equal(change.oldPricePerGram, 1.5);
  assert.equal(change.newPricePerGram, 2);
  assert.deepEqual(change.reasonCodes, [
    'matrix_changed',
    'price_per_gram_changed',
  ]);
});

test('pricing explanation reports the exchange rate when it is the only cause', () => {
  const change = buildPricingChange(
    buildPricingState({
      matrixName: 'Некалібровані - 1 сорт',
      priceMode: 'per_gram_usd',
      pricePerGram: 1.5,
      uahRate: 41,
      priceUah: 615,
    }),
    buildPricingState({
      matrixName: 'Некалібровані - 1 сорт',
      priceMode: 'per_gram_usd',
      pricePerGram: 1.5,
      uahRate: 42,
      priceUah: 630,
    })
  );

  assert.deepEqual(change.reasonCodes, ['exchange_rate_only']);
  assert.deepEqual(change.reasonLabels, ['Лише оновлення курсу']);
});

test('pricing explanation distinguishes a fixed price and manual correction', () => {
  const change = buildPricingChange(
    buildPricingState({ priceMode: 'fixed_uah', priceUah: 400 }),
    buildPricingState({ priceMode: 'fixed_uah', priceUah: 500 }),
    { manualOverride: true }
  );

  assert.equal(change.oldPricePerGram, null);
  assert.equal(change.newPricePerGram, null);
  assert.deepEqual(change.reasonCodes, ['fixed_price_changed', 'manual_override']);
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

test('reviewed repricing products are normalized for draft persistence', () => {
  assert.deepEqual(normalizeReviewedProductIds([7, '3', 7, 0, -1, 'bad']), [3, 7]);
  assert.throws(() => normalizeReviewedProductIds({ productId: 7 }), /Некоректний список/);
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
        pricingChange: {
          reasonCodes: ['price_per_gram_changed'],
          reasonLabels: ['Змінено ціну за грам'],
        },
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
  assert.deepEqual(preview.items[0].pricingChange.reasonCodes, [
    'price_per_gram_changed',
    'manual_override',
  ]);
  assert.equal(preview.summary.changedCount, 1);
});

test('price_missing remains an error until a manual price is explicitly supplied', () => {
  const preview = applyManualOverridesToPreview({
    summary: { changedCount: 0, unchangedCount: 0, errorCount: 1 },
    items: [{
      productId: 7,
      sku: 'NM7',
      weight: 10,
      oldPriceUah: 400,
      totalPrice: 8,
      pricePerGram: 0.8,
      uahRate: 50,
      status: 'error',
      errorCode: 'price_missing',
      message: 'No matrix price',
    }],
  }, []);

  assert.equal(preview.items[0].status, 'error');
  assert.equal(preview.summary.errorCount, 1);
  assert.equal(preview.summary.changedCount, 0);
});

test('price_missing accepts keeping the current price as an explicit manual resolution', () => {
  const preview = applyManualOverridesToPreview({
    summary: { changedCount: 0, unchangedCount: 0, errorCount: 1 },
    items: [{
      productId: 7,
      sku: 'NM7',
      weight: 10,
      oldPriceUah: 400,
      totalPrice: 8,
      pricePerGram: 0.8,
      uahRate: 50,
      status: 'error',
      errorCode: 'price_missing',
    }],
  }, [{ productId: 7, newPriceUah: 400 }]);

  assert.equal(preview.items[0].status, 'changed');
  assert.equal(preview.items[0].newPriceUah, 400);
  assert.equal(preview.items[0].priceDeltaUah, 0);
  assert.equal(preview.items[0].manualOverride, true);
  assert.equal(preview.items[0].resolvedPriceMissing, true);
  assert.equal(preview.summary.errorCount, 0);
  assert.equal(preview.summary.changedCount, 1);
});

test('price_missing accepts a new positive manual price but other errors stay blocked', () => {
  const resolved = applyManualOverridesToPreview({
    summary: { changedCount: 0, unchangedCount: 0, errorCount: 1 },
    items: [{
      productId: 7,
      sku: 'NM7',
      weight: 10,
      oldPriceUah: 400,
      totalPrice: 8,
      pricePerGram: 0.8,
      uahRate: 50,
      status: 'error',
      errorCode: 'price_missing',
    }],
  }, [{ productId: 7, newPriceUah: 550 }]);

  assert.equal(resolved.items[0].newPriceUah, 550);
  assert.equal(resolved.items[0].totalPrice, 11);
  assert.equal(resolved.items[0].pricePerGram, 1.1);
  assert.equal(resolved.summary.errorCount, 0);

  assert.throws(
    () => applyManualOverridesToPreview({
      summary: { errorCount: 1 },
      items: [{ productId: 8, sku: 'NM8', status: 'error', errorCode: 'calculation_failed' }],
    }, [{ productId: 8, newPriceUah: 550 }]),
    /спочатку потрібно усунути помилку/
  );
});

test('manual_price accepts keeping or changing the existing manual price', () => {
  const preview = {
    summary: { changedCount: 0, unchangedCount: 0, errorCount: 1 },
    items: [{
      productId: 9,
      sku: 'NM9',
      weight: 10,
      oldPriceUah: 550,
      totalPrice: 11,
      pricePerGram: 1.1,
      uahRate: 50,
      status: 'error',
      errorCode: 'manual_price',
      message: 'Товар має ручну ціну.',
    }],
  };

  const kept = applyManualOverridesToPreview(preview, [
    { productId: 9, newPriceUah: 550 },
  ]);
  assert.equal(kept.items[0].status, 'changed');
  assert.equal(kept.items[0].newPriceUah, 550);
  assert.equal(kept.items[0].resolvedManualPrice, true);
  assert.equal(kept.summary.errorCount, 0);

  const changed = applyManualOverridesToPreview(preview, [
    { productId: 9, newPriceUah: 675 },
  ]);
  assert.equal(changed.items[0].status, 'changed');
  assert.equal(changed.items[0].newPriceUah, 675);
  assert.equal(changed.items[0].priceDeltaUah, 125);
  assert.equal(changed.summary.errorCount, 0);
});

test('manual resolution preserves the authoritative automatic price as an audit reference', () => {
  const preview = applyManualOverridesToPreview({
    summary: { changedCount: 0, unchangedCount: 0, errorCount: 1 },
    items: [{
      productId: 19,
      sku: 'NM19',
      weight: 10,
      oldPriceUah: 550,
      newPriceUah: 700,
      calculatedPriceUah: 700,
      totalPrice: 14,
      pricePerGram: 1.4,
      uahRate: 50,
      status: 'error',
      errorCode: 'manual_price',
    }],
  }, [{ productId: 19, newPriceUah: 600 }]);

  assert.equal(preview.items[0].status, 'changed');
  assert.equal(preview.items[0].newPriceUah, 600);
  assert.equal(preview.items[0].calculatedPriceUah, 700);
});

test('repricing preview token binds resolvable price_missing product state', () => {
  const item = {
    productId: 7,
    sku: 'NM7',
    weight: 10,
    answers: { extra: 2 },
    oldPriceUah: 400,
    status: 'error',
    errorCode: 'price_missing',
  };

  assert.notEqual(
    getPreviewToken(scenario, [item]),
    getPreviewToken(scenario, [{ ...item, answers: { extra: 3 } }])
  );
  assert.notEqual(
    getPreviewToken(scenario, [item]),
    getPreviewToken(scenario, [{ ...item, oldPriceUah: 450 }])
  );
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
