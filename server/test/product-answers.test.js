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

test('missing SV processing stays absent in recount; explicit semantic zero becomes a real change', () => {
  const source = { decodeSource: 'stored_history', decodedAnswers: [
    { key: 'stone_processing', value_id: null, is_placeholder: true },
    { key: 'additional_stone', value_id: 1, is_placeholder: false },
  ], product: { category: 'SV', details: { answers: { souvenir: 5, additional_stone: 1 } } } };
  const before = structuredClone(source);
  const answers = buildProductAnswerContext(source);
  assert.equal(Object.hasOwn(answers, 'stone_processing'), false);
  const repaired = mergeRecountAnswerPatch(answers, { stone_processing: 0 });
  assert.deepEqual(require('../src/utils/answer-changes').getAnswerChanges(answers, repaired), [
    { key: 'stone_processing', from: null, to: 0 },
  ]);
  source.product.details.answers.stone_processing = 0;
  assert.equal(buildProductAnswerContext(source).stone_processing, 0);
  delete source.product.details.answers.stone_processing;
  source.decodedAnswers[0] = { key: 'stone_processing', value_id: 0, is_placeholder: false };
  assert.equal(buildProductAnswerContext(source).stone_processing, 0);
  source.product.category = 'NM';
  source.decodedAnswers[0] = { key: 'stone_processing', value_id: null, is_placeholder: true };
  assert.equal(buildProductAnswerContext(source).stone_processing, 0);
  assert.deepEqual(before.product.details.answers, { souvenir: 5, additional_stone: 1 });
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
