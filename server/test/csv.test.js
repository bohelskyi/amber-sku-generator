const assert = require('node:assert/strict');
const test = require('node:test');

const { buildCsv, escapeCsvValue } = require('../src/utils/csv');

test('CSV neutralizes spreadsheet formulas in text values', () => {
  for (const prefix of ['=', '+', '-', '@']) {
    assert.equal(escapeCsvValue(`${prefix}SUM(A1:A2)`), `'${prefix}SUM(A1:A2)`);
  }
  assert.equal(escapeCsvValue(-12.5), '-12.5');
});

test('CSV preserves quote, comma, and newline escaping after neutralization', () => {
  assert.equal(escapeCsvValue('=1,2'), '"\'=1,2"');
  assert.equal(escapeCsvValue('hello "world"'), '"hello ""world"""');
  assert.equal(buildCsv([['a', 'line\nbreak']]), 'a,"line\nbreak"');
});
