const test = require('node:test');
const assert = require('node:assert/strict');

const { getRuleDependencies, isRuleMatched } = require('../src/utils/rules');

test('flat rules keep matching every condition', () => {
  const rule = { style: 5, is_calibrated: 0 };

  assert.equal(isRuleMatched(rule, { style: 5, is_calibrated: 0 }), true);
  assert.equal(isRuleMatched(rule, { style: 5, is_calibrated: 1 }), false);
});

test('or rules match when at least one condition matches', () => {
  const rule = { $or: [{ style: 5 }, { is_calibrated: 0 }] };

  assert.equal(isRuleMatched(rule, { style: 5, is_calibrated: 1 }), true);
  assert.equal(isRuleMatched(rule, { style: 1, is_calibrated: 0 }), true);
  assert.equal(isRuleMatched(rule, { style: 1, is_calibrated: 1 }), false);
});

test('rule dependencies include keys nested in logical operators', () => {
  assert.deepEqual(
    getRuleDependencies({ $or: [{ style: 5 }, { is_calibrated: 0 }] }),
    ['style', 'is_calibrated']
  );
});
