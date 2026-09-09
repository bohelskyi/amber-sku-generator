const assert = require('node:assert/strict');
const test = require('node:test');

const { parseUserId } = require('../scripts/bootstrap-admin');

test('bootstrap CLI accepts only an explicit positive local application user ID', () => {
  assert.equal(parseUserId(['--user-id', '17']), 17);
  for (const argv of [
    [],
    ['--user-id'],
    ['--user-id', '0'],
    ['--user-id', '-1'],
    ['--user-id', '1.5'],
    ['--user-id', 'not-a-user'],
  ]) {
    assert.throws(() => parseUserId(argv), /--user-id/);
  }
});
