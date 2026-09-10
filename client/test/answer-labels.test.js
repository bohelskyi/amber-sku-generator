import test from 'node:test';
import assert from 'node:assert/strict';

import { getAnswerValueLabel, getQuestionLabel } from '../src/lib/answer-labels.js';

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
    ],
  },
};

test('answer labels resolve structured correction changes', () => {
  assert.equal(getQuestionLabel(config, 'NM', 'quality'), 'Якість');
  assert.equal(getAnswerValueLabel(config, 'NM', 'quality', 2), '2 сорт');
  assert.equal(getAnswerValueLabel(config, 'NM', 'extra', 0), 'Не обрано');
  assert.equal(getQuestionLabel(config, 'NM', 'is_calibrated'), 'Калібрування');
});
