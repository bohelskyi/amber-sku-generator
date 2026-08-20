const test = require('node:test');
const assert = require('node:assert/strict');

const { roundUah } = require('../src/utils/money');

test('rounds final UAH prices to whole hryvnias', () => {
  assert.equal(roundUah(591.39), 591);
  assert.equal(roundUah('894.62'), 895);
  assert.equal(roundUah(100.5), 101);
});

test('keeps missing or invalid prices empty', () => {
  assert.equal(roundUah(null), null);
  assert.equal(roundUah(''), null);
  assert.equal(roundUah('invalid'), null);
});
