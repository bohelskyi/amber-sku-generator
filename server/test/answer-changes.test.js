const test = require('node:test');
const assert = require('node:assert/strict');

const {
  filterPresentableAnswerChanges,
  getAnswerChanges,
} = require('../src/utils/answer-changes');

test('returns no changes for equivalent answer sets', () => {
  assert.deepEqual(
    getAnswerChanges(
      { quality: 1, is_calibrated: 0, note: 'test' },
      { quality: '1', is_calibrated: '0', note: 'test' }
    ),
    []
  );
});

test('reports changed, added, and removed answers', () => {
  assert.deepEqual(
    getAnswerChanges(
      { quality: 1, color: 2, texture: 3 },
      { quality: 2, color: 2, size: 4 }
    ),
    [
      { key: 'quality', from: 1, to: 2 },
      { key: 'texture', from: 3, to: null },
      { key: 'size', from: null, to: 4 },
    ]
  );
});

test('presentation suppresses only semantic absence and evidenced placeholder zero changes', () => {
  const changes = [
    { key: 'missing_to_null', from: undefined, to: null },
    { key: 'blank_to_missing', from: '  ', to: undefined },
    { key: 'placeholder', from: 0, to: null },
    { key: 'configured_zero', from: 0, to: null },
    { key: 'unknown_zero', from: 0, to: null },
    { key: 'is_calibrated', from: 0, to: 2 },
  ];
  const oldPayload = {
    answers: {
      placeholder: 0,
      configured_zero: 0,
      unknown_zero: 0,
      is_calibrated: 0,
    },
    decodedAnswers: [
      {
        key: 'placeholder',
        value_id: null,
        value_label: 'Не обрано',
        is_placeholder: true,
      },
      {
        key: 'configured_zero',
        value_id: 0,
        value_label: 'Явний нуль',
        is_placeholder: false,
      },
      {
        key: 'is_calibrated',
        value_id: 0,
        value_label: 'Некалібрована',
        is_placeholder: false,
      },
    ],
  };

  assert.deepEqual(
    filterPresentableAnswerChanges(changes, { oldPayload, newPayload: { answers: {} } }),
    [
      { key: 'configured_zero', from: 0, to: null },
      { key: 'unknown_zero', from: 0, to: null },
      { key: 'is_calibrated', from: 0, to: 2 },
    ]
  );
});

test('presentation recognizes placeholder evidence on either side without changing raw diffs', () => {
  const rawRemoval = getAnswerChanges({ extra: 0 }, {});
  assert.deepEqual(rawRemoval, [{ key: 'extra', from: 0, to: null }]);
  assert.deepEqual(
    filterPresentableAnswerChanges(rawRemoval, {
      oldPayload: {
        answers: { extra: 0 },
        decodedAnswers: [{ key: 'extra', value_id: null }],
      },
      newPayload: { answers: {} },
    }),
    []
  );

  assert.deepEqual(
    filterPresentableAnswerChanges([{ key: 'extra', from: null, to: '0' }], {
      oldPayload: { answers: {} },
      newPayload: {
        answers: { extra: 0 },
        decodedAnswers: [{ key: 'extra', value_id: null, is_placeholder: true }],
      },
    }),
    []
  );
});
