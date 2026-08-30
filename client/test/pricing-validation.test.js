import assert from 'node:assert/strict';
import test from 'node:test';

import { isValidPositivePrice, requiresManualPrice } from '../src/lib/pricing-validation.js';

test('missing, zero, and invalid automatic prices require manual pricing', () => {
  for (const totalPriceUah of [null, undefined, '', 0, '0', Number.NaN]) {
    assert.equal(requiresManualPrice({ totalPriceUah }), true);
  }
  assert.equal(requiresManualPrice({ totalPriceUah: 125 }), false);
});

test('manual price must be finite and strictly positive', () => {
  assert.equal(isValidPositivePrice(1), true);
  assert.equal(isValidPositivePrice('250'), true);
  assert.equal(isValidPositivePrice(0), false);
  assert.equal(isValidPositivePrice(-1), false);
  assert.equal(isValidPositivePrice(''), false);
});
