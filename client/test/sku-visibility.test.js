import test from 'node:test';
import assert from 'node:assert/strict';

import { getPricingAxis } from '../src/lib/pricing-axis.js';
import { getVisibleOptionsForQuestion, isQuestionVisible } from '../src/lib/sku-visibility.js';

test('Necklaces size is shown only for natural calibration 0 or 1', () => {
  const question = {
    id: 'size',
    visible_if_json: { is_calibrated: [0, 1] },
    options: [
      { id: 1, visible_if_json: { raw_type: [1, 2], is_calibrated: [1, null] } },
      { id: 4, visible_if_json: { raw_type: 1, is_calibrated: 0 } },
    ],
  };
  for (const [answers, visible, optionIds] of [
    [{ raw_type: 1, is_calibrated: 0 }, true, [4]],
    [{ raw_type: 1, is_calibrated: 1 }, true, [1]],
    [{ raw_type: 1, is_calibrated: 2 }, false, []],
    [{ raw_type: 2 }, false, []],
  ]) {
    assert.equal(isQuestionVisible(question, answers, answers.is_calibrated ?? null), visible);
    if (visible) {
      assert.deepEqual(getVisibleOptionsForQuestion(question, answers).map((option) => option.id), optionIds);
    }
  }
});

const qualityQuestion = {
  id: 'quality',
  label: 'Якість',
  options: [
    { id: 1, label: 'Натура 1', visible_if_json: { raw_type: 1 } },
    { id: 2, label: 'Натура 2', visible_if_json: { raw_type: 1 } },
    {
      id: 3,
      label: 'Натура 3',
      visible_if_json: { raw_type: 1 },
      hidden_if_json: { raw_type: 1, is_calibrated: 0 },
    },
    { id: 1, label: 'Формований 1', visible_if_json: { raw_type: 2 } },
    { id: 2, label: 'Формований 2', visible_if_json: { raw_type: 2 } },
    { id: 3, label: 'Формований 3', visible_if_json: { raw_type: 2 } },
  ],
};

test('hidden_if removes natural grade 3 for non-calibrated products', () => {
  const options = getVisibleOptionsForQuestion(
    qualityQuestion,
    { raw_type: 1, is_calibrated: 0 },
    0
  );

  assert.deepEqual(options.map((option) => option.id), [1, 2]);
});

test('hidden_if keeps grade 3 in other product branches', () => {
  const calibratedNatural = getVisibleOptionsForQuestion(
    qualityQuestion,
    { raw_type: 1, is_calibrated: 1 },
    1
  );
  const formed = getVisibleOptionsForQuestion(qualityQuestion, { raw_type: 2 }, null);

  assert.deepEqual(calibratedNatural.map((option) => option.id), [1, 2, 3]);
  assert.deepEqual(formed.map((option) => option.id), [1, 2, 3]);
});

test('pricing axes respect hidden_if in a scenario context', () => {
  const axis = getPricingAxis(
    'quality',
    [qualityQuestion],
    'X',
    [],
    { raw_type: 1, is_calibrated: 0 }
  );

  assert.deepEqual(axis.options.map((option) => option.label), ['Натура 1', 'Натура 2']);
});

test('hidden_if supports matching any configured condition', () => {
  const question = {
    id: 'quality',
    options: [
      {
        id: 3,
        label: '3 сорт',
        hidden_if_json: {
          $or: [
            { style: 5 },
            { is_calibrated: 0 },
          ],
        },
      },
    ],
  };

  assert.deepEqual(
    getVisibleOptionsForQuestion(question, { style: 5, is_calibrated: 1 }, 1),
    []
  );
  assert.deepEqual(
    getVisibleOptionsForQuestion(question, { style: 1, is_calibrated: 0 }, 0),
    []
  );
  assert.deepEqual(
    getVisibleOptionsForQuestion(question, { style: 1, is_calibrated: 1 }, 1).map(
      (option) => option.id
    ),
    [3]
  );
});

test('pricing axes hide an option when any hidden condition is guaranteed', () => {
  const question = {
    id: 'quality',
    label: 'Якість',
    options: [
      { id: 1, label: '1 сорт' },
      {
        id: 3,
        label: '3 сорт',
        hidden_if_json: { $or: [{ style: 5 }, { is_calibrated: 0 }] },
      },
    ],
  };

  const styleAxis = getPricingAxis('quality', [question], 'X', [], { style: 5 });
  const calibratedAxis = getPricingAxis('quality', [question], 'X', [], { is_calibrated: 0 });

  assert.deepEqual(styleAxis.options.map((option) => option.id), [1]);
  assert.deepEqual(calibratedAxis.options.map((option) => option.id), [1]);
});

test('archived options are unavailable in builders and new pricing axes', () => {
  const question = {
    id: 'style',
    label: 'Виконання',
    options: [
      { id: 2, label: 'Комбіновані' },
      { id: 3, label: 'Комбіновані (знижка 20%)', archived: 1 },
    ],
  };

  assert.deepEqual(
    getVisibleOptionsForQuestion(question).map((option) => option.id),
    [2]
  );
  assert.deepEqual(
    getPricingAxis('style', [question], 'X').options.map((option) => option.id),
    [2]
  );
});
