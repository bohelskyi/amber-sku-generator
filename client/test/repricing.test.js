import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyManualPrices,
  getInvalidManualPriceIds,
  getManualOverrides,
  sortRepricingItems,
} from '../src/lib/repricing.js';

test('manual prices accept comma decimals and round to whole hryvnias', () => {
  assert.deepEqual(getManualOverrides({ 7: '450,6' }), [
    { productId: 7, newPriceUah: 451 },
  ]);
  assert.deepEqual(getInvalidManualPriceIds({ 7: '', 8: '-1', 9: '400' }), [7, 8]);
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
