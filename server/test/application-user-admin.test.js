const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertAssignableRoleKey,
  normalizeManagedApplicationUser,
  parseApplicationUserId,
} = require('../src/services/application-user-admin.service');

test('application-user administration accepts only strict positive user IDs', () => {
  assert.equal(parseApplicationUserId(17), 17);
  assert.equal(parseApplicationUserId('17'), 17);
  for (const value of [null, '', '01', '1x', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseApplicationUserId(value), (error) => (
      error.statusCode === 400 && error.code === 'INVALID_APPLICATION_USER_ID'
    ));
  }
});

test('only the three built-in role keys are accepted for user management', () => {
  for (const roleKey of ['administrator', 'manager', 'storekeeper']) {
    assert.equal(assertAssignableRoleKey(roleKey), roleKey);
  }
  for (const roleKey of [undefined, '', 'Administrator', 'custom', '__proto__']) {
    assert.throws(() => assertAssignableRoleKey(roleKey), (error) => (
      error.statusCode === 400 && error.code === 'ROLE_NOT_ASSIGNABLE'
    ));
  }
});

test('managed-user projections expose safe profile and built-in-role fields only', () => {
  const user = normalizeManagedApplicationUser({
    id: '9',
    status: 'active',
    preferred_username: 'safe.user',
    display_name: 'Safe User',
    last_authenticated_at: new Date('2026-09-09T10:00:00.000Z'),
    identity_linked: true,
    role_keys: ['manager'],
    issuer: 'must-not-be-exposed',
    subject: 'must-not-be-exposed',
    email: 'not-needed@example.invalid',
  });

  assert.deepEqual(user, {
    id: 9,
    status: 'active',
    preferredUsername: 'safe.user',
    displayName: 'Safe User',
    lastAuthenticatedAt: '2026-09-09T10:00:00.000Z',
    identityLinked: true,
    roleKey: 'manager',
    hasMultipleBuiltInRoles: false,
  });
  assert.doesNotMatch(JSON.stringify(user), /issuer|subject|example\.invalid/);
});
