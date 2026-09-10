import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildRecountPayload,
  buildRecountPreviewPayload,
  getDecodedAnswerMap,
  haveAnswersChanged,
  normalizeRecountTargetAnswers,
  normalizeRecountTargetState,
  updateRecountOptionAnswer,
  updateRecountTextAnswer,
} from '../src/lib/product-recount.js';
import { isQuestionVisible } from '../src/lib/sku-visibility.js';

const braceletQuestions = [
  {
    id: 'raw_type',
    label: 'Тип сировини',
    required: 1,
    options: [
      { id: 1, label: 'Натуральний' },
      { id: 2, label: 'Формований' },
    ],
  },
  {
    id: 'size',
    label: 'Розмір',
    required: 1,
    options: [
      { id: 5, label: '1-2', visible_if_json: { raw_type: 1 } },
      { id: 0, label: 'Не обрано', visible_if_json: { raw_type: 2 } },
    ],
  },
];
const recountHookSource = fs.readFileSync(
  new URL('../src/hooks/useProductRecount.js', import.meta.url),
  'utf8'
);

test('recount starts from decoded answers enriched with stored product data', () => {
  assert.deepEqual(getDecodedAnswerMap({
    decodedAnswers: [
      { key: 'quality', value_id: 1 },
      { key: 'extra', value_id: null },
    ],
    product: {
      details: {
        answers: { quality: 2, processing: 1 },
        isCalibrated: 0,
      },
    },
  }), {
    quality: 2,
    extra: 0,
    processing: 1,
    is_calibrated: 0,
  });
});

test('recount detects changed, added, and cleared answers', () => {
  assert.equal(haveAnswersChanged({ quality: 1 }, { quality: 1 }), false);
  assert.equal(haveAnswersChanged({ quality: 1 }, { quality: 2 }), true);
  assert.equal(haveAnswersChanged({ quality: 1 }, { quality: 1, extra: 2 }), true);
  assert.equal(haveAnswersChanged({ quality: 1, extra: 2 }, { quality: 1 }), true);
});

test('correction payload forwards a valid manual UAH price', () => {
  assert.deepEqual(buildRecountPayload({
    sourceSku: 'ZZ1-1',
    answers: { kind: 2 },
    isCalibrated: 0,
    reason: 'No matrix cell',
    manualPriceUah: '725',
  }), {
    sourceSku: 'ZZ1-1',
    answers: { kind: 2 },
    isCalibrated: 0,
    reason: 'No matrix cell',
    manualPriceUah: 725,
  });
});

test('correction payload forwards the edited target weight to authoritative recount', () => {
  assert.equal(buildRecountPayload({ answers: {}, weight: '21.7' }).weight, '21.7');
});

test('optional recount option selection clears to an explicit missing answer', () => {
  const question = { id: 'discount', required: 0 };
  const selected = updateRecountOptionAnswer({}, question, 2);
  const cleared = updateRecountOptionAnswer(selected, question, 2);

  assert.deepEqual(selected, { discount: 2 });
  assert.deepEqual(cleared, { discount: null });
  assert.equal(buildRecountPayload({ answers: cleared }).answers.discount, null);
});

test('required recount answers and genuine zero values are not cleared as optional sentinels', () => {
  assert.deepEqual(
    updateRecountOptionAnswer({ kind: 1 }, { id: 'kind', required: 1 }, 1),
    { kind: 1 }
  );
  assert.deepEqual(
    updateRecountOptionAnswer({}, { id: 'zero_option', required: 0 }, 0),
    { zero_option: 0 }
  );
  assert.deepEqual(
    updateRecountOptionAnswer({}, { id: 'is_calibrated', required: 1 }, 0),
    { is_calibrated: 0 }
  );
  assert.deepEqual(
    updateRecountTextAnswer({ note: 'old' }, { id: 'note', required: 1 }, ''),
    { note: null }
  );
});

test('recount selects the sole authoritative target option after an inherited answer becomes invalid', () => {
  const edited = updateRecountOptionAnswer(
    { raw_type: 1, size: 5 },
    braceletQuestions[0],
    2
  );
  const normalized = normalizeRecountTargetAnswers(braceletQuestions, edited);

  assert.deepEqual(normalized, { raw_type: 2, size: 0 });
  assert.equal(typeof normalized.size, 'number');
  assert.equal(
    buildRecountPreviewPayload({
      sourceSku: 'BR-SOURCE',
      answers: normalized,
      isCalibrated: 0,
      weight: '12',
    }).answers.size,
    0,
    'the debounced preview must receive the normalized target without a manual click'
  );
  assert.match(
    recountHookSource,
    /setRecountTarget[\s\S]*normalizeRecountTargetState[\s\S]*updateRecountOptionAnswer/
  );
  assert.match(
    recountHookSource,
    /const recountPreviewPayload = useMemo[\s\S]*answers: recountAnswers/
  );
});

test('recount sole-option normalization cascades deterministically to a stable target', () => {
  const questions = [
    ...braceletQuestions,
    {
      id: 'shape',
      label: 'Форма',
      required: 1,
      options: [
        { id: 9, label: 'Стара форма', visible_if_json: { size: 5 } },
        { id: 7, label: 'Форма для нового розміру', visible_if_json: { size: 0 } },
      ],
    },
  ];

  assert.deepEqual(
    normalizeRecountTargetAnswers(questions, { raw_type: 2, size: 5, shape: 9 }),
    { raw_type: 2, size: 0, shape: 7 }
  );
});

test('recount does not guess when an invalid inherited answer has multiple valid target options', () => {
  const questions = [
    braceletQuestions[0],
    {
      ...braceletQuestions[1],
      options: [
        braceletQuestions[1].options[0],
        { id: 0, label: 'Не обрано', visible_if_json: { raw_type: 2 } },
        { id: 4, label: '0-1', visible_if_json: { raw_type: 2 } },
      ],
    },
  ];

  assert.deepEqual(
    normalizeRecountTargetAnswers(questions, { raw_type: 2, size: 5 }),
    { raw_type: 2, size: null }
  );
});

test('recount normalization fails closed instead of looping through cyclic sole options', () => {
  const cyclicQuestion = {
    id: 'cycle',
    required: 1,
    options: [
      { id: 1, label: 'Перший', visible_if_json: { cycle: 2 } },
      { id: 2, label: 'Другий', visible_if_json: { cycle: 1 } },
    ],
  };

  assert.deepEqual(
    normalizeRecountTargetAnswers([cyclicQuestion], { cycle: 1 }),
    { cycle: null }
  );
});

test('recount normalization restores hidden dependencies in the natural formed natural round-trip', () => {
  const questions = [
    braceletQuestions[0],
    {
      id: 'is_calibrated',
      label: 'Сировина калібрована?',
      required: 1,
      visible_if_json: { raw_type: 1 },
      options: [
        { id: 0, label: 'Ні' },
        { id: 1, label: 'Так' },
        { id: 2, label: 'Частково' },
      ],
    },
    {
      id: 'size',
      label: 'Розмір',
      required: 1,
      visible_if_json: { raw_type: 1, is_calibrated: 0 },
      options: [
        { id: 5, label: '1-2' },
        { id: 6, label: '2-3' },
      ],
    },
  ];
  let target = {
    answers: { raw_type: 1, is_calibrated: 0, size: 5 },
    retainedHiddenAnswers: {},
  };

  target = normalizeRecountTargetState(
    questions,
    updateRecountOptionAnswer(target.answers, questions[0], 2),
    target.retainedHiddenAnswers
  );
  assert.deepEqual(target.answers, {
    raw_type: 2,
    is_calibrated: null,
    size: null,
  });

  target = normalizeRecountTargetState(
    questions,
    updateRecountOptionAnswer(target.answers, questions[0], 1),
    target.retainedHiddenAnswers
  );
  assert.deepEqual(
    target.answers,
    { raw_type: 1, is_calibrated: 0, size: null },
    'restoring raw type must reconsider hidden calibration and size in the same fixed point'
  );
  assert.equal(
    isQuestionVisible(questions[2], target.answers, target.answers.is_calibrated),
    true,
    'Size must be visible immediately without a second unrelated edit'
  );
});

test('a newly visible recount question still auto-selects its sole target option', () => {
  const questions = [
    braceletQuestions[0],
    {
      id: 'is_calibrated',
      required: 1,
      visible_if_json: { raw_type: 1 },
      options: [{ id: 0 }, { id: 1 }, { id: 2 }],
    },
    {
      id: 'size',
      required: 1,
      visible_if_json: { raw_type: 1, is_calibrated: 0 },
      options: [{ id: 5, label: 'Єдиний розмір' }],
    },
  ];
  const formed = normalizeRecountTargetState(
    questions,
    { raw_type: 2, is_calibrated: 0, size: 5 }
  );
  const naturalAgain = normalizeRecountTargetState(
    questions,
    { ...formed.answers, raw_type: 1 },
    formed.retainedHiddenAnswers
  );

  assert.deepEqual(naturalAgain.answers, {
    raw_type: 1,
    is_calibrated: 0,
    size: 5,
  });
});

test('recount clears target-hidden inherited answers without changing normal product normalization', () => {
  const questions = [
    braceletQuestions[0],
    {
      id: 'legacy_detail',
      label: 'Стара ознака',
      required: 0,
      visible_if_json: { raw_type: 1 },
      options: [{ id: 3, label: 'Значення' }],
    },
  ];
  const skuManagerSource = fs.readFileSync(
    new URL('../src/hooks/useSkuManager.js', import.meta.url),
    'utf8'
  );

  assert.deepEqual(
    normalizeRecountTargetAnswers(questions, { raw_type: 2, legacy_detail: 3 }),
    { raw_type: 2, legacy_detail: null }
  );
  assert.doesNotMatch(skuManagerSource, /normalizeRecountTargetAnswers/);
});
