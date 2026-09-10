const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizePermissionKeys,
  parseExpectedVersion,
  parseRoleId,
} = require('../src/services/role-admin.service');

test('role administration validates numeric identities and versions', () => {
  assert.equal(parseRoleId('12'), 12);
  assert.equal(parseExpectedVersion(3), 3);
  for (const value of [undefined, null, '', '01', 0, -1, 'manager']) {
    assert.throws(() => parseExpectedVersion(value), (error) => (
      error.statusCode === 400 && error.code === 'INVALID_ROLE_VERSION'
    ));
  }
});

test('permission-set input is exact, unique, and sorted', () => {
  assert.deepEqual(normalizePermissionKeys([
    'products.view',
    'history.view',
    'products.view',
  ]), ['history.view', 'products.view']);
  for (const value of [null, {}, ['Administrator'], ['products'], [7]]) {
    assert.throws(() => normalizePermissionKeys(value), (error) => (
      error.statusCode === 400 && error.code === 'INVALID_PERMISSION_SET'
    ));
  }
});
