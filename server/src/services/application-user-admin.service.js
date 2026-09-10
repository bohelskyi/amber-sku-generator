const pool = require('../db/pool');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const {
  APPLICATION_USER_ADMIN_LOCK_KEY,
  runAccessAdminMutation,
} = require('./access-admin-transaction');

const USER_ADMIN_AUDIT_EVENTS = Object.freeze({
  APPROVED: 'application_user.approved',
  ROLE_CHANGED: 'application_user.role_changed',
  DISABLED: 'application_user.disabled',
  ENABLED: 'application_user.enabled',
});

class ApplicationUserAdminError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ApplicationUserAdminError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function createApplicationUserAdminError(statusCode, code, message) {
  return new ApplicationUserAdminError(statusCode, code, message);
}

function parsePositiveId(value, code, label) {
  const normalized = typeof value === 'number' ? String(value) : value;
  if (typeof normalized !== 'string' || !/^[1-9]\d*$/.test(normalized)) {
    throw new ApplicationUserAdminError(400, code, `${label} must be a positive integer`);
  }
  const id = Number(normalized);
  if (!Number.isSafeInteger(id)) {
    throw new ApplicationUserAdminError(400, code, `${label} must be a positive integer`);
  }
  return id;
}

function parseApplicationUserId(value) {
  return parsePositiveId(value, 'INVALID_APPLICATION_USER_ID', 'Application user ID');
}

function parseRoleId(value) {
  return parsePositiveId(value, 'INVALID_ROLE_ID', 'Role ID');
}

function parseExpectedAssignmentId(value, { required = true } = {}) {
  if (value === null) return null;
  if (value === undefined && !required) return undefined;
  if (value === undefined) {
    throw new ApplicationUserAdminError(
      400,
      'EXPECTED_ASSIGNMENT_REQUIRED',
      'The expected current assignment ID is required'
    );
  }
  return parsePositiveId(
    value,
    'INVALID_EXPECTED_ASSIGNMENT_ID',
    'Expected current assignment ID'
  );
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeRole(row) {
  if (row?.role_id === null || row?.role_id === undefined) return null;
  return {
    id: Number(row.role_id),
    key: row.role_key,
    displayName: row.role_display_name,
    isSystem: Boolean(row.role_is_system),
    status: row.role_status,
  };
}

function auditRole(role) {
  if (!role) return null;
  return { id: role.id, key: role.key, displayName: role.displayName };
}

function normalizeManagedApplicationUser(row) {
  return {
    id: Number(row.id),
    status: row.status,
    preferredUsername: row.preferred_username || null,
    displayName: row.display_name || null,
    lastAuthenticatedAt: normalizeTimestamp(row.last_authenticated_at),
    identityLinked: Boolean(row.identity_linked),
    currentAssignmentId: row.assignment_id === null || row.assignment_id === undefined
      ? null
      : Number(row.assignment_id),
    role: normalizeRole(row),
  };
}

const MANAGED_USER_SELECT = `
  SELECT u.id, u.status, u.preferred_username, u.display_name,
         u.last_authenticated_at,
         EXISTS (
           SELECT 1
           FROM application_external_identities identity
           WHERE identity.application_user_id = u.id
         ) AS identity_linked,
         assignment.id AS assignment_id,
         role.id AS role_id,
         role.role_key,
         role.display_name AS role_display_name,
         role.is_system AS role_is_system,
         role.status AS role_status
  FROM application_users u
  LEFT JOIN user_role_assignments assignment
    ON assignment.application_user_id = u.id AND assignment.revoked_at IS NULL
  LEFT JOIN roles role ON role.id = assignment.role_id`;

async function listApplicationUsers({ databasePool = pool } = {}) {
  const result = await databasePool.query(
    `${MANAGED_USER_SELECT}
     ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
              COALESCE(u.display_name, u.preferred_username, ''), u.id`
  );
  return result.rows.map(normalizeManagedApplicationUser);
}

async function listAssignableRoles({ databasePool = pool } = {}) {
  const result = await databasePool.query(
    `SELECT id AS role_id, role_key, display_name AS role_display_name,
            is_system AS role_is_system, status AS role_status
     FROM roles
     WHERE status = 'active'
     ORDER BY CASE WHEN role_key = 'administrator' AND is_system = TRUE THEN 0 ELSE 1 END,
              LOWER(display_name), id`
  );
  return result.rows.map(normalizeRole);
}

async function getManagedApplicationUser(userId, queryable) {
  const result = await queryable.query(`${MANAGED_USER_SELECT} WHERE u.id = $1`, [userId]);
  if (result.rows.length !== 1) {
    throw new ApplicationUserAdminError(
      404,
      'APPLICATION_USER_NOT_FOUND',
      'Application user was not found'
    );
  }
  return normalizeManagedApplicationUser(result.rows[0]);
}

async function lockApplicationUser(client, userId) {
  const result = await client.query(
    'SELECT id, status FROM application_users WHERE id = $1 FOR UPDATE',
    [userId]
  );
  if (result.rows.length !== 1) {
    throw new ApplicationUserAdminError(
      404,
      'APPLICATION_USER_NOT_FOUND',
      'Application user was not found'
    );
  }
  return result.rows[0];
}

async function getCurrentAssignment(client, userId) {
  const result = await client.query(
    `SELECT assignment.id, assignment.role_id,
            role.role_key, role.display_name AS role_display_name,
            role.is_system AS role_is_system, role.status AS role_status
     FROM user_role_assignments assignment
     JOIN roles role ON role.id = assignment.role_id
     WHERE assignment.application_user_id = $1
       AND assignment.revoked_at IS NULL
     FOR UPDATE OF assignment`,
    [userId]
  );
  if (result.rows.length > 1) {
    throw new ApplicationUserAdminError(
      409,
      'MULTIPLE_CURRENT_ROLES',
      'Application user has multiple current role assignments'
    );
  }
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: Number(row.id),
    roleId: Number(row.role_id),
    role: normalizeRole({
      role_id: row.role_id,
      role_key: row.role_key,
      role_display_name: row.role_display_name,
      role_is_system: row.role_is_system,
      role_status: row.role_status,
    }),
  };
}

async function getAssignableRole(client, roleId) {
  const result = await client.query(
    `SELECT id AS role_id, role_key, display_name AS role_display_name,
            is_system AS role_is_system, status AS role_status
     FROM roles
     WHERE id = $1 AND status = 'active'
     FOR SHARE`,
    [roleId]
  );
  if (result.rows.length !== 1) {
    throw new ApplicationUserAdminError(
      400,
      'ROLE_NOT_ASSIGNABLE',
      'Role must be an active application role'
    );
  }
  return normalizeRole(result.rows[0]);
}

function assertExpectedAssignment(currentAssignment, expectedAssignmentId) {
  const currentId = currentAssignment?.id ?? null;
  if (currentId !== expectedAssignmentId) {
    throw new ApplicationUserAdminError(
      409,
      'APPLICATION_USER_ASSIGNMENT_CONFLICT',
      'The application user role changed; refresh before trying again'
    );
  }
}

function isAdministratorRole(role) {
  return role?.key === 'administrator' && role?.isSystem === true;
}

async function assertAdministratorCanBeRemoved(client) {
  const result = await client.query(
    `SELECT COUNT(DISTINCT u.id)::int AS count
     FROM application_users u
     JOIN user_role_assignments assignment
       ON assignment.application_user_id = u.id AND assignment.revoked_at IS NULL
     JOIN roles role ON role.id = assignment.role_id
     WHERE u.status = 'active'
       AND role.role_key = 'administrator'
       AND role.is_system = TRUE
       AND role.status = 'active'`
  );
  if (Number(result.rows[0].count) <= 1) {
    throw new ApplicationUserAdminError(
      409,
      'LAST_ADMINISTRATOR_REQUIRED',
      'At least one active Administrator must remain'
    );
  }
}

async function replaceCurrentRole(client, userId, role, actorUserId, currentAssignment) {
  if (currentAssignment?.roleId === role.id) return false;
  if (currentAssignment) {
    await client.query(
      `UPDATE user_role_assignments
       SET revoked_at = CURRENT_TIMESTAMP, revoked_by_user_id = $1
       WHERE id = $2`,
      [actorUserId, currentAssignment.id]
    );
  }
  await client.query(
    `INSERT INTO user_role_assignments
     (application_user_id, role_id, assigned_by_user_id)
     VALUES ($1, $2, $3)`,
    [userId, role.id, actorUserId]
  );
  return true;
}

function normalizeMutationOptions(options = {}) {
  const contextInput = options.mutationContext || options;
  const actorUserId = parseApplicationUserId(contextInput.actorUserId);
  return {
    actorUserId,
    mutationContext: createMutationContext({
      actorUserId,
      requestId: contextInput.requestId,
    }),
    databasePool: options.databasePool || pool,
  };
}

function runUserMutation(options, operation) {
  return runAccessAdminMutation({
    ...options,
    requiredPermission: 'users.manage',
    createError: createApplicationUserAdminError,
    operation,
  });
}

async function writeUserAdminAuditEvent(client, mutationContext, eventKey, userId, details) {
  return writeAuditEvent(client, {
    mutationContext,
    eventKey,
    subjectType: 'application_user',
    subjectId: userId,
    details,
  });
}

async function approveApplicationUser(userIdValue, roleIdValue, options = {}) {
  const userId = parseApplicationUserId(userIdValue);
  const roleId = parseRoleId(roleIdValue);
  const normalized = normalizeMutationOptions(options);
  return runUserMutation(normalized, async (client) => {
    const user = await lockApplicationUser(client, userId);
    if (user.status !== 'pending') {
      throw new ApplicationUserAdminError(409, 'APPLICATION_USER_STATUS_CONFLICT',
        'Only a pending application user can be approved');
    }
    const role = await getAssignableRole(client, roleId);
    const currentAssignment = await getCurrentAssignment(client, userId);
    await replaceCurrentRole(client, userId, role, normalized.actorUserId, currentAssignment);
    await client.query(
      `UPDATE application_users
       SET status = 'active', activated_at = CURRENT_TIMESTAMP,
           deactivated_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [userId]
    );
    const managedUser = await getManagedApplicationUser(userId, client);
    await writeUserAdminAuditEvent(client, normalized.mutationContext,
      USER_ADMIN_AUDIT_EVENTS.APPROVED, userId, {
        previousStatus: 'pending', newStatus: 'active', role: auditRole(managedUser.role),
      });
    return managedUser;
  });
}

async function changeApplicationUserRole(userIdValue, roleIdValue, options = {}) {
  const userId = parseApplicationUserId(userIdValue);
  const roleId = parseRoleId(roleIdValue);
  const expectedAssignmentId = parseExpectedAssignmentId(options.expectedAssignmentId);
  const normalized = normalizeMutationOptions(options);
  return runUserMutation(normalized, async (client) => {
    const user = await lockApplicationUser(client, userId);
    if (!['active', 'disabled'].includes(user.status)) {
      throw new ApplicationUserAdminError(409, 'APPLICATION_USER_STATUS_CONFLICT',
        'Approve a pending application user before changing its role');
    }
    const role = await getAssignableRole(client, roleId);
    const currentAssignment = await getCurrentAssignment(client, userId);
    assertExpectedAssignment(currentAssignment, expectedAssignmentId);
    if (user.status === 'active' && isAdministratorRole(currentAssignment?.role)
        && !isAdministratorRole(role)) {
      await assertAdministratorCanBeRemoved(client);
    }
    const changed = await replaceCurrentRole(client, userId, role,
      normalized.actorUserId, currentAssignment);
    const managedUser = await getManagedApplicationUser(userId, client);
    if (changed) {
      await writeUserAdminAuditEvent(client, normalized.mutationContext,
        USER_ADMIN_AUDIT_EVENTS.ROLE_CHANGED, userId, {
          userStatus: user.status,
          previousRole: auditRole(currentAssignment?.role),
          newRole: auditRole(managedUser.role),
        });
    }
    return managedUser;
  });
}

async function disableApplicationUser(userIdValue, options = {}) {
  const userId = parseApplicationUserId(userIdValue);
  const normalized = normalizeMutationOptions(options);
  return runUserMutation(normalized, async (client) => {
    const user = await lockApplicationUser(client, userId);
    if (user.status !== 'active') {
      throw new ApplicationUserAdminError(409, 'APPLICATION_USER_STATUS_CONFLICT',
        'Only an active application user can be disabled');
    }
    const currentAssignment = await getCurrentAssignment(client, userId);
    if (isAdministratorRole(currentAssignment?.role)) {
      await assertAdministratorCanBeRemoved(client);
    }
    await client.query(
      `UPDATE application_users
       SET status = 'disabled', deactivated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [userId]
    );
    const managedUser = await getManagedApplicationUser(userId, client);
    await writeUserAdminAuditEvent(client, normalized.mutationContext,
      USER_ADMIN_AUDIT_EVENTS.DISABLED, userId, {
        previousStatus: 'active', newStatus: 'disabled', role: auditRole(managedUser.role),
      });
    return managedUser;
  });
}

async function enableApplicationUser(userIdValue, roleIdValue, options = {}) {
  const userId = parseApplicationUserId(userIdValue);
  const roleId = roleIdValue === undefined || roleIdValue === null
    ? null
    : parseRoleId(roleIdValue);
  const expectedAssignmentId = parseExpectedAssignmentId(options.expectedAssignmentId, {
    required: roleId !== null,
  });
  const normalized = normalizeMutationOptions(options);
  return runUserMutation(normalized, async (client) => {
    const user = await lockApplicationUser(client, userId);
    if (user.status !== 'disabled') {
      throw new ApplicationUserAdminError(409, 'APPLICATION_USER_STATUS_CONFLICT',
        'Only a disabled application user can be enabled');
    }
    const currentAssignment = await getCurrentAssignment(client, userId);
    if (roleId !== null) {
      assertExpectedAssignment(currentAssignment, expectedAssignmentId);
      const role = await getAssignableRole(client, roleId);
      await replaceCurrentRole(client, userId, role, normalized.actorUserId, currentAssignment);
    } else if (!currentAssignment || currentAssignment.role.status !== 'active') {
      throw new ApplicationUserAdminError(409, 'ACTIVE_ROLE_REQUIRED',
        'Select one active role before enabling this application user');
    }
    await client.query(
      `UPDATE application_users
       SET status = 'active', activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
           deactivated_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [userId]
    );
    const managedUser = await getManagedApplicationUser(userId, client);
    await writeUserAdminAuditEvent(client, normalized.mutationContext,
      USER_ADMIN_AUDIT_EVENTS.ENABLED, userId, {
        previousStatus: 'disabled', newStatus: 'active', role: auditRole(managedUser.role),
      });
    return managedUser;
  });
}

module.exports = {
  APPLICATION_USER_ADMIN_LOCK_KEY,
  ApplicationUserAdminError,
  USER_ADMIN_AUDIT_EVENTS,
  approveApplicationUser,
  assertAdministratorCanBeRemoved,
  changeApplicationUserRole,
  disableApplicationUser,
  enableApplicationUser,
  listApplicationUsers,
  listAssignableRoles,
  normalizeManagedApplicationUser,
  parseApplicationUserId,
  parseExpectedAssignmentId,
  parseRoleId,
};
