import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseConditionRows,
  stringifyConditionRows,
} from '../src/lib/admin-conditions.js';

test('flat conditions remain in all mode', () => {
  const parsed = parseConditionRows('{"style":5,"is_calibrated":0}');

  assert.equal(parsed.isValid, true);
  assert.equal(parsed.mode, 'all');
  assert.deepEqual(parsed.rows, [
    { key: 'style', values: ['5'] },
    { key: 'is_calibrated', values: ['0'] },
  ]);
});

test('any mode serializes conditions as explicit or branches', () => {
  const serialized = stringifyConditionRows([
    { key: 'style', values: ['5'] },
    { key: 'is_calibrated', values: ['0'] },
  ], 'any');

  assert.deepEqual(JSON.parse(serialized), {
    $or: [
      { style: 5 },
      { is_calibrated: 0 },
    ],
  });
  assert.equal(parseConditionRows(serialized).mode, 'any');
});
