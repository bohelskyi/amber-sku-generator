import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterPresentableAnswerChanges,
  getAnswerValueLabel,
  getQuestionLabel,
} from '../src/lib/answer-labels.js';

const config = {
  questions: {
    NM: [
      {
        id: 'quality',
        label: 'Якість',
        required: 1,
        options: [
          { id: 1, label: '1 сорт' },
          { id: 2, label: '2 сорт' },
        ],
      },
      {
        id: 'extra',
        label: 'Додатково',
        required: 0,
        options: [],
      },
      {
        id: 'zero_option',
        label: 'Нульова опція',
        required: 0,
        options: [{ id: 0, label: 'Явний нуль' }],
      },
    ],
  },
  extraConfig: {
    is_calibrated: {
      options: [
        { id: 0, label: 'Некалібрована' },
        { id: 1, label: 'Калібрована' },
        { id: 2, label: 'Напівкалібрована' },
      ],
    },
  },
};

test('answer labels resolve structured correction changes', () => {
  assert.equal(getQuestionLabel(config, 'NM', 'quality'), 'Якість');
  assert.equal(getAnswerValueLabel(config, 'NM', 'quality', 2), '2 сорт');
  assert.equal(getAnswerValueLabel(config, 'NM', 'extra', 0), 'Не обрано');
  assert.equal(getQuestionLabel(config, 'NM', 'is_calibrated'), 'Калібрування');
});

test('missing answers do not numerically match zero-valued options', () => {
  assert.equal(getAnswerValueLabel(config, 'NM', 'zero_option', null), 'Не обрано');
  assert.equal(getAnswerValueLabel(config, 'NM', 'zero_option', undefined), 'Не обрано');
  assert.equal(getAnswerValueLabel(config, 'NM', 'zero_option', ''), 'Не обрано');
  assert.equal(getAnswerValueLabel(config, 'NM', 'zero_option', 0), 'Явний нуль');

  assert.equal(getAnswerValueLabel(config, 'NM', 'is_calibrated', null), 'Невідомо');
  assert.equal(getAnswerValueLabel(config, 'NM', 'is_calibrated', 0), 'Некалібрована');
  assert.equal(getAnswerValueLabel(config, 'NM', 'is_calibrated', 1), 'Калібрована');
  assert.equal(getAnswerValueLabel(config, 'NM', 'is_calibrated', 2), 'Напівкалібрована');
});

test('correction presentation suppresses only placeholder-backed semantic no-ops', () => {
  const changes = [
    { key: 'extra', from: 0, to: null },
    { key: 'zero_option', from: 0, to: null },
    { key: 'unknown_zero', from: 0, to: null },
    { key: 'is_calibrated', from: 0, to: 2 },
  ];
  const oldPayload = {
    answers: { extra: 0, zero_option: 0, unknown_zero: 0, is_calibrated: 0 },
    decodedAnswers: [
      { key: 'extra', value_id: null, value_label: 'Не обрано', is_placeholder: true },
      { key: 'zero_option', value_id: 0, value_label: 'Явний нуль', is_placeholder: false },
      { key: 'is_calibrated', value_id: 0, value_label: 'Некалібрована', is_placeholder: false },
    ],
  };

  assert.deepEqual(
    filterPresentableAnswerChanges(changes, { oldPayload, newPayload: { answers: {} } }),
    changes.slice(1)
  );
});
