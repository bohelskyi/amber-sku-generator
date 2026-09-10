const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeManagedApplicationUser,
  parseApplicationUserId,
  parseExpectedAssignmentId,
  parseRoleId,
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

test('user management accepts numeric role and optimistic assignment identities', () => {
  assert.equal(parseRoleId(3), 3);
  assert.equal(parseRoleId('4'), 4);
  assert.equal(parseExpectedAssignmentId(null), null);
  assert.equal(parseExpectedAssignmentId('12'), 12);
  assert.throws(() => parseRoleId('manager'), (error) => (
    error.statusCode === 400 && error.code === 'INVALID_ROLE_ID'
  ));
  assert.throws(() => parseExpectedAssignmentId(undefined), (error) => (
    error.statusCode === 400 && error.code === 'EXPECTED_ASSIGNMENT_REQUIRED'
  ));
});

test('managed-user projections expose safe profile and current-role fields only', () => {
  const user = normalizeManagedApplicationUser({
    id: '9',
    status: 'active',
    preferred_username: 'safe.user',
    display_name: 'Safe User',
    last_authenticated_at: new Date('2026-09-09T10:00:00.000Z'),
    identity_linked: true,
    assignment_id: '81',
    role_id: '4',
    role_key: 'custom_inventory',
    role_display_name: 'Inventory specialist',
    role_is_system: false,
    role_status: 'active',
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
    currentAssignmentId: 81,
    role: {
      id: 4,
      key: 'custom_inventory',
      displayName: 'Inventory specialist',
      isSystem: false,
      status: 'active',
    },
  });
  assert.doesNotMatch(JSON.stringify(user), /issuer|subject|example\.invalid/);
});
