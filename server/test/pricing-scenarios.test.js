const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveWeightBand,
  sortScenariosByPrecedence,
  validateWeightBands,
} = require('../src/utils/pricing-scenarios');

test('scenario priority takes precedence over rule count', () => {
  const scenarios = sortScenariosByPrecedence([
    { id: 1, priority: 0, match_json: { raw_type: 1, quality: 1, is_calibrated: 0 } },
    { id: 2, priority: 100, match_json: { style: 5 } },
  ]);

  assert.equal(scenarios[0].id, 2);
});

test('weight bands use inclusive lower and exclusive upper limits', () => {
  const bands = validateWeightBands([
    { label: 'До 10 г', min_weight: 0, max_weight: 10 },
    { label: '10-15 г', min_weight: 10, max_weight: 15 },
    { label: 'Від 15 г', min_weight: 15, max_weight: null },
  ]).map((band, index) => ({ ...band, id: index + 1 }));

  assert.equal(resolveWeightBand(bands, 9.9).id, 1);
  assert.equal(resolveWeightBand(bands, 10).id, 2);
  assert.equal(resolveWeightBand(bands, 14.9).id, 2);
  assert.equal(resolveWeightBand(bands, 15).id, 3);
});

test('weight bands reject gaps', () => {
  assert.throws(
    () => validateWeightBands([
      { label: 'До 10 г', min_weight: 0, max_weight: 10 },
      { label: 'Від 11 г', min_weight: 11, max_weight: null },
    ]),
    /без пропусків/
  );
});
