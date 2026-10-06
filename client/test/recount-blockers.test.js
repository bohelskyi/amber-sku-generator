import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  focusFirstRecountBlocker,
  formatRecountBlockerSummary,
  getRecountFieldBlockers,
} from '../src/lib/recount-blockers.js';

const requiredQuestion = {
  id: 'quality',
  label: 'Якість',
  required: 1,
  options: [
    { id: 1, label: 'Перша' },
    { id: 2, label: 'Друга' },
  ],
};

test('missing required recount field is exposed for red field presentation', () => {
  const blockers = getRecountFieldBlockers({
    questions: [requiredQuestion],
    answers: {},
  });
  const dashboardSource = fs.readFileSync(
    new URL('../src/components/app/HomeDashboard.jsx', import.meta.url),
    'utf8'
  );

  assert.deepEqual(blockers, [{
    questionId: 'quality',
    message: 'Заповніть обов’язкове поле «Якість».',
  }]);
  assert.match(dashboardSource, /data-recount-blocker/);
  assert.match(dashboardSource, /recount-field-row builder-field-row/);
  assert.match(dashboardSource, /blocker \? 'is-invalid' : ''/);
});

test('multiple recount blockers produce the correct compact count', () => {
  const blockers = getRecountFieldBlockers({
    questions: [
      requiredQuestion,
      { id: 'shape', label: 'Форма', required: 1, options: [{ id: 1, label: 'Кругла' }] },
    ],
    answers: {},
  });

  assert.equal(blockers.length, 2);
  assert.equal(formatRecountBlockerSummary(blockers.length), 'Заповніть 2 обов’язкові поля');
});

test('unavailable recount value is exposed with the server validation message', () => {
  const serverMessage = 'Значення «2» недоступне для поля «Якість».';
  const blockers = getRecountFieldBlockers({
    questions: [{
      ...requiredQuestion,
      options: [
        { id: 1, label: 'Перша' },
        { id: 2, label: 'Друга', archived: 1 },
      ],
    }],
    answers: { quality: 2 },
    serverMessage,
  });

  assert.deepEqual(blockers, [{ questionId: 'quality', message: serverMessage }]);
});

test('fixing a recount value immediately clears its blocker', () => {
  const questions = [requiredQuestion];

  assert.equal(getRecountFieldBlockers({ questions, answers: {} }).length, 1);
  assert.deepEqual(getRecountFieldBlockers({
    questions,
    answers: { quality: 1 },
  }), []);
});

test('explicit recount validation maps an invalid target weight to the weight field', () => {
  const serverMessage = 'Для цієї категорії вага повинна бути більшою за 0.';

  assert.deepEqual(getRecountFieldBlockers({
    requiresWeight: true,
    serverMessage,
    weight: '',
  }), [{ questionId: 'weight', message: serverMessage }]);
  assert.deepEqual(getRecountFieldBlockers({
    requiresWeight: true,
    weight: '20.5',
  }), []);
});

test('failed recount attempt scrolls and focuses the first blocker', () => {
  const calls = [];
  const firstBlocker = {
    scrollIntoView(options) {
      calls.push(['scroll', options]);
    },
    focus(options) {
      calls.push(['focus', options]);
    },
  };
  const root = {
    querySelector(selector) {
      assert.equal(selector, '[data-recount-blocker="true"]');
      return firstBlocker;
    },
  };

  assert.equal(focusFirstRecountBlocker(root), true);
  assert.deepEqual(calls, [
    ['scroll', { behavior: 'auto', block: 'center' }],
    ['focus', { preventScroll: true }],
  ]);
});

test('target-hidden recount questions are not exposed as blockers', () => {
  const blockers = getRecountFieldBlockers({
    questions: [{
      ...requiredQuestion,
      visible_if_json: { raw_type: 1 },
    }],
    answers: { raw_type: 2 },
  });

  assert.deepEqual(blockers, []);
});


test('recount validates numeric metadata and maps authoritative errors while preserving archive assignments', () => {
  const questions = [{ id: 'length', label: 'Довжина', input_type: 'text', numeric_validation: { kind: 'decimal', min: 1, minInclusive: false, max: 3, maxInclusive: true, maxFractionDigits: 2 } },
    { id: 'old', archived: 1, required: 1 },
    { id: 'kind', label: 'Вид', options: [{ id: 0, archived: 1 }], required: 1 }];
  assert.deepEqual(getRecountFieldBlockers({ questions, answers: { length: '2,35', kind: 0 }, previousAnswers: { kind: 0 } }), []);
  assert.equal(getRecountFieldBlockers({ questions, answers: { length: '1', kind: 0 }, previousAnswers: { kind: 0 } })[0].questionId, 'length');
  assert.equal(getRecountFieldBlockers({ questions, answers: { length: '2,350', kind: 0 }, previousAnswers: { kind: 0 } })[0].questionId, 'length');
  assert.deepEqual(getRecountFieldBlockers({ questions, answers: { length: '2.3', kind: 0 }, previousAnswers: { kind: 0 }, fieldErrors: { length: 'Сервер перевірив межу' } }), [{ questionId: 'length', message: 'Сервер перевірив межу' }]);
});
