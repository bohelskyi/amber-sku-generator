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
  assert.match(dashboardSource, /border-rose-400/);
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
    ['scroll', { behavior: 'smooth', block: 'center' }],
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
