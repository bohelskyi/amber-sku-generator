import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatDecimal,
  formatDecodedSuffix,
  formatUah,
  formatUahPerGram,
  formatWholeUah,
  formatUsd,
} from '../src/lib/formatters.js';

test('decimal display removes only trailing fractional zeros', () => {
  assert.equal(formatDecimal('1.0000'), '1');
  assert.equal(formatDecimal('1.5000'), '1.5');
  assert.equal(formatDecimal('1.2500'), '1.25');
  assert.equal(formatDecimal('1.2345'), '1.2345');
});

test('decimal display does not round or pass through floating-point conversion', () => {
  assert.equal(formatDecimal('1.23456789012345678900'), '1.234567890123456789');
  assert.equal(formatDecimal('9007199254740993.1200'), '9007199254740993.12');
  assert.equal(formatDecimal(1.5), '1.5');
  assert.equal(formatDecimal(null), '');
});

test('price and weight formatters consistently use compact decimals', () => {
  assert.equal(formatUah('1.5000'), '1.5 ₴');
  assert.equal(formatUahPerGram('1.2500'), '1.25 ₴');
  assert.equal(formatUsd('1.0000'), '$1');
  assert.equal(formatDecodedSuffix({ type: 'weight', value: '2.0000' }), '2 г');
});

test('pre-rounded UAH display is formatted as a whole hryvnia amount', () => {
  assert.equal(formatWholeUah(736.1576319999999), '736 ₴');
  assert.equal(formatWholeUah(750), '750 ₴');
});
