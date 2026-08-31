const assert = require('node:assert/strict');
const test = require('node:test');

const { getProductPreviewToken } = require('../src/services/product.service');

function preview(overrides = {}) {
  return {
    weightVal: 10,
    skuSchemaVersionId: 4,
    baseSku: 'ZZ1',
    mode: 'weight',
    priceMode: 'per_gram_usd',
    pricePerGram: '2.50',
    fixedPriceUah: null,
    totalPrice: '25.00',
    totalPriceUah: 1000,
    uahRate: 40,
    uahRateDate: '2026-08-31',
    uahRateFetchedAt: '2026-08-31T08:00:00.000Z',
    ...overrides,
  };
}

test('preview token is stable across replicas with the same effective rate', () => {
  const first = getProductPreviewToken(
    preview(),
    'ZZ',
    { kind: 1, is_calibrated: 1 },
    null
  );
  const second = getProductPreviewToken(
    preview({ uahRateFetchedAt: '2026-08-31T08:05:00.000Z' }),
    'ZZ',
    { is_calibrated: 1, kind: 1 },
    1
  );
  assert.equal(second, first);
});

test('preview token changes when the effective price changes', () => {
  const first = getProductPreviewToken(preview(), 'ZZ', { kind: 1 }, null);
  const changed = getProductPreviewToken(
    preview({ totalPriceUah: 1001 }),
    'ZZ',
    { kind: 1 },
    null
  );
  assert.notEqual(changed, first);
});

test('preview token treats an unset calibration answer as false', () => {
  const unset = getProductPreviewToken(preview(), 'ZZ', { kind: 1 }, null);
  const explicitlyFalse = getProductPreviewToken(preview(), 'ZZ', { kind: 1 }, 0);
  const explicitlyTrue = getProductPreviewToken(preview(), 'ZZ', { kind: 1 }, 1);

  assert.equal(explicitlyFalse, unset);
  assert.notEqual(explicitlyTrue, unset);
});
