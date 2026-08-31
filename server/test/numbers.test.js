const test = require('node:test');
const assert = require('node:assert/strict');

const { parseNonNegativeDecimal, parsePositiveDecimal } = require('../src/utils/numbers');

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

test('positive decimal rejects zero before persistence', () => {
  assert.equal(parsePositiveDecimal('0.49', 'Ціна'), 0.49);
  assert.equal(parsePositiveDecimal('1,25', 'Ціна'), 1.25);
  assert.throws(() => parsePositiveDecimal(0, 'Ціна'), /більшим за 0/);
  assert.throws(() => parsePositiveDecimal('0.00', 'Ціна'), /більшим за 0/);
  assert.throws(() => parsePositiveDecimal(true, 'Ціна'), /більшим за 0/);
});
