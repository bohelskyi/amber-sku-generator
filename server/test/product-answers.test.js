const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildProductAnswerContext,
  mergeRecountAnswerPatch,
  normalizeAnswerMap,
  omitHiddenRecountAnswers,
} = require('../src/services/product/product-answers');

test('answer normalization preserves calibration states and semantic values', () => {
  assert.deepEqual(normalizeAnswerMap({
    zero: '0',
    one: '1',
    two: '2',
    semantic: '17',
    text: 'amber',
    absent: '',
  }), {
    zero: 0,
    one: 1,
    two: 2,
    semantic: 17,
    text: 'amber',
  });
});

test('recount answer patches explicitly clear values without clearing zero', () => {
  assert.deepEqual(mergeRecountAnswerPatch(
    { optional: 3, calibrated: 2, retained: 4 },
    { optional: '', calibrated: 0 }
  ), { calibrated: 0, retained: 4 });
});

test('stored answer context preserves calibration state 2', () => {
  assert.deepEqual(buildProductAnswerContext({
    decodedAnswers: [{ key: 'shape', value_id: 7 }],
    product: {
      details: {
        answers: { quality: '4' },
        isCalibrated: '2',
      },
    },
  }), { shape: 7, quality: 4, is_calibrated: 2 });
});

test('only recount filtering removes answers hidden by the target configuration', () => {
  const answers = { is_calibrated: 2, visible: 4, inherited: 9, nonSchema: 12 };
  const result = omitHiddenRecountAnswers(answers, [
    { key: 'visible', visible_if_json: null },
    { key: 'inherited', visible_if_json: { is_calibrated: 1 } },
  ], 2);

  assert.deepEqual(result, { is_calibrated: 2, visible: 4, nonSchema: 12 });
  assert.deepEqual(answers, { is_calibrated: 2, visible: 4, inherited: 9, nonSchema: 12 });
});
