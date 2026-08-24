import test from 'node:test';
import assert from 'node:assert/strict';

import { getPricingAxis } from '../src/lib/pricing-axis.js';
import { getVisibleOptionsForQuestion } from '../src/lib/sku-visibility.js';

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
