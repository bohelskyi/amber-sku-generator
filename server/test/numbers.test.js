const test = require('node:test');
const assert = require('node:assert/strict');

const { parseNonNegativeDecimal } = require('../src/utils/numbers');

test('decimal input accepts dots and commas', () => {
  assert.equal(parseNonNegativeDecimal('0.49'), 0.49);
  assert.equal(parseNonNegativeDecimal('0,49'), 0.49);
  assert.equal(parseNonNegativeDecimal(2.5), 2.5);
});

test('decimal input rejects invalid and negative values', () => {
  assert.throws(() => parseNonNegativeDecimal('abc'), /невід'ємним числом/);
  assert.throws(() => parseNonNegativeDecimal('-0.49'), /невід'ємним числом/);
  assert.throws(() => parseNonNegativeDecimal(''), /невід'ємним числом/);
});
