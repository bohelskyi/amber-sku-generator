import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyManualPrices,
  canApplyRepricing,
  getInvalidManualPriceIds,
  getManualOverrides,
  getRepricingSummary,
  sortRepricingItems,
} from '../src/lib/repricing.js';

const applyState = (summary, overrides = {}) => ({
  summary,
  invalidManualPriceCount: getInvalidManualPriceIds(overrides).length,
  draftConflictCount: 0,
  blockingCorrectionRequestCount: 0,
  isDraftStale: false,
});

test('price_missing requires an explicit valid manual resolution before apply', () => {
  const missingItem = {
    productId: 7,
    sku: 'BR7',
    oldPriceUah: 400,
    status: 'error',
    errorCode: 'price_missing',
  };
  const unresolvedSummary = getRepricingSummary({}, [missingItem]);
  assert.equal(canApplyRepricing(applyState(unresolvedSummary)), false);

  const keepCurrent = { 7: '400' };
  const keptItems = applyManualPrices([missingItem], keepCurrent);
  const keptSummary = getRepricingSummary({}, keptItems);
  assert.equal(keptItems[0].status, 'changed');
  assert.equal(keptItems[0].resolvedPriceMissing, true);
  assert.equal(keptSummary.errorCount, 0);
  assert.equal(canApplyRepricing(applyState(keptSummary, keepCurrent)), true);

  const changedPrice = { 7: '550' };
  const changedItems = applyManualPrices([missingItem], changedPrice);
  assert.equal(changedItems[0].newPriceUah, 550);
  assert.equal(canApplyRepricing(applyState(
    getRepricingSummary({}, changedItems),
    changedPrice
  )), true);

  const invalidPrice = { 7: '0' };
  const invalidItems = applyManualPrices([missingItem], invalidPrice);
  assert.equal(invalidItems[0].status, 'error');
  assert.equal(canApplyRepricing(applyState(
    getRepricingSummary({}, invalidItems),
    invalidPrice
  )), false);
});

test('an already-manual product remains resolvable on every repricing cycle', () => {
  const manualItem = {
    productId: 8,
    sku: 'BR8',
    oldPriceUah: 550,
    status: 'error',
    errorCode: 'manual_price',
    message: 'Товар має ручну ціну.',
  };

  assert.equal(canApplyRepricing(applyState(getRepricingSummary({}, [manualItem]))), false);

  const keptPrice = { 8: '550' };
  const keptItems = applyManualPrices([manualItem], keptPrice);
  assert.equal(keptItems[0].status, 'changed');
  assert.equal(keptItems[0].newPriceUah, 550);
  assert.equal(keptItems[0].resolvedManualPrice, true);
  assert.equal(canApplyRepricing(applyState(
    getRepricingSummary({}, keptItems),
    keptPrice
  )), true);

  const changedPrice = { 8: '675' };
  const changedItems = applyManualPrices([manualItem], changedPrice);
  assert.equal(changedItems[0].status, 'changed');
  assert.equal(changedItems[0].newPriceUah, 675);
  assert.equal(canApplyRepricing(applyState(
    getRepricingSummary({}, changedItems),
    changedPrice
  )), true);

  const invalidPrice = { 8: '0' };
  const invalidItems = applyManualPrices([manualItem], invalidPrice);
  assert.equal(invalidItems[0].status, 'error');
  assert.equal(canApplyRepricing(applyState(
    getRepricingSummary({}, invalidItems),
    invalidPrice
  )), false);
});

test('ordinary automatic repricing remains applicable when it has valid changes', () => {
  assert.equal(canApplyRepricing(applyState({
    changedCount: 2,
    unchangedCount: 1,
    errorCount: 0,
  })), true);
});

test('manual prices accept comma decimals and round to whole hryvnias', () => {
  assert.deepEqual(getManualOverrides({ 7: '450,6' }), [
    { productId: 7, newPriceUah: 451 },
  ]);
  assert.deepEqual(getInvalidManualPriceIds({ 7: '', 8: '-1', 9: '400', 10: '0.4' }), [7, 8, 10]);
});

test('manual price changes the row status and delta', () => {
  const [item] = applyManualPrices([{
    productId: 7,
    oldPriceUah: 400,
    newPriceUah: 500,
    priceDeltaUah: 100,
    status: 'changed',
    pricingChange: {
      reasonCodes: ['price_per_gram_changed'],
      reasonLabels: ['Змінено ціну за грам'],
    },
  }], { 7: '400' });

  assert.equal(item.newPriceUah, 400);
  assert.equal(item.priceDeltaUah, 0);
  assert.equal(item.status, 'unchanged');
  assert.equal(item.manualOverride, true);
  assert.deepEqual(item.pricingChange.reasonCodes, [
    'price_per_gram_changed',
    'manual_override',
  ]);
});

test('manual price replaces an exchange-rate-only explanation', () => {
  const [item] = applyManualPrices([{
    productId: 8,
    oldPriceUah: 400,
    newPriceUah: 410,
    status: 'changed',
    pricingChange: {
      reasonCodes: ['exchange_rate_only'],
      reasonLabels: ['Лише оновлення курсу'],
    },
  }], { 8: '450' });

  assert.deepEqual(item.pricingChange.reasonCodes, ['manual_override']);
  assert.deepEqual(item.pricingChange.reasonLabels, ['Ціну скориговано вручну']);
});

test('repricing rows sort naturally by SKU and numerically by price', () => {
  const items = [
    { productId: 1, sku: 'BR10', newPriceUah: 300 },
    { productId: 2, sku: 'BR2', newPriceUah: 500 },
  ];

  assert.deepEqual(sortRepricingItems(items, { key: 'sku', direction: 'asc' }).map((item) => item.sku), ['BR2', 'BR10']);
  assert.deepEqual(sortRepricingItems(items, { key: 'newPriceUah', direction: 'desc' }).map((item) => item.newPriceUah), [500, 300]);
});
