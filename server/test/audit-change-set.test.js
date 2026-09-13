const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addAuditChange,
  stableValue,
  valuesEqual,
} = require('../src/audit/change-set');

test('stableValue recursively sorts object keys without reordering arrays', () => {
  assert.deepEqual(stableValue({ z: 1, a: [{ y: 2, x: 1 }] }), {
    a: [{ x: 1, y: 2 }],
    z: 1,
  });
});

test('valuesEqual compares object values independent of key order', () => {
  assert.equal(valuesEqual({ b: 2, a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(valuesEqual([1, 2], [2, 1]), false);
});

test('addAuditChange omits equal values and redacts sensitive changes', () => {
  const changes = {};
  addAuditChange(changes, 'unchanged', { b: 2, a: 1 }, { a: 1, b: 2 });
  addAuditChange(changes, 'name', 'Before', 'After');
  addAuditChange(changes, 'secret', 'old', 'new', { sensitive: true });

  assert.deepEqual(changes, {
    name: { from: 'Before', to: 'After' },
    secret: { changed: true },
  });
});
