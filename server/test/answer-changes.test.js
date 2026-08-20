const test = require('node:test');
const assert = require('node:assert/strict');

const { getAnswerChanges } = require('../src/utils/answer-changes');

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
