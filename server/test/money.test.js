const test = require('node:test');
const assert = require('node:assert/strict');

const { roundAutomaticUah, roundUah } = require('../src/utils/money');

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

test('marketing rounding uses the tier selected from the unrounded automatic price', () => {
  assert.equal(roundAutomaticUah(100), 100);
  assert.equal(roundAutomaticUah(100.5), 100);
  assert.equal(roundAutomaticUah(101), 100);
  assert.equal(roundAutomaticUah(255), 260);
  assert.equal(roundAutomaticUah(299), 300);
  assert.equal(roundAutomaticUah(300), 300);
  assert.equal(roundAutomaticUah(4975), 5000);
  assert.equal(roundAutomaticUah(5000), 5000);
  assert.equal(roundAutomaticUah(24999), 25000);
  assert.equal(roundAutomaticUah(25000), 25000);
  assert.equal(roundAutomaticUah(99750), 100000);
  assert.equal(roundAutomaticUah(100000), 100000);
  assert.equal(roundAutomaticUah(100500), 101000);
});

test('marketing rounding matches the approved examples without pre-rounding', () => {
  assert.equal(roundAutomaticUah(2556), 2550);
  assert.equal(roundAutomaticUah(3943), 3950);
  assert.equal(roundAutomaticUah(1536), 1550);
  assert.equal(roundAutomaticUah(613), 600);
  assert.equal(roundAutomaticUah(918), 900);
  assert.equal(roundAutomaticUah(1338), 1350);
  assert.equal(roundAutomaticUah(null), null);
  assert.equal(roundAutomaticUah('invalid'), null);
});
