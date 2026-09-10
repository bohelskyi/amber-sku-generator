const crypto = require('node:crypto');
const pool = require('../db/pool');
const { writeAuditEvent } = require('../audit/audit-events');
const { createMutationContext } = require('../audit/mutation-context');
const { runAccessAdminMutation } = require('./access-admin-transaction');

const ADMINISTRATOR_ROLE_KEY = 'administrator';
const RESERVED_PERMISSION_KEYS = Object.freeze([
  'users.manage',
  'roles.manage',
  'audit.view',
]);
const RESERVED_PERMISSION_KEY_SET = new Set(RESERVED_PERMISSION_KEYS);
const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const ROLE_AUDIT_EVENTS = Object.freeze({
  CREATED: 'role.created',
  UPDATED: 'role.updated',
  PERMISSIONS_CHANGED: 'role.permissions_changed',
  DEACTIVATED: 'role.deactivated',
  REACTIVATED: 'role.reactivated',
});

class RoleAdminError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RoleAdminError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function createRoleAdminError(statusCode, code, message) {
  return new RoleAdminError(statusCode, code, message);
}

function parsePositiveInteger(value, code, label) {
  const normalized = typeof value === 'number' ? String(value) : value;
  if (typeof normalized !== 'string' || !/^[1-9]\d*$/.test(normalized)) {
    throw new RoleAdminError(400, code, `${label} must be a positive integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new RoleAdminError(400, code, `${label} must be a positive integer`);
  }
  return parsed;
}

function parseRoleId(value) {
  return parsePositiveInteger(value, 'INVALID_ROLE_ID', 'Role ID');
}

function parseExpectedVersion(value) {
  return parsePositiveInteger(value, 'INVALID_ROLE_VERSION', 'Expected role version');
}

function parseExpectedActiveAssignedUserCount(value) {
  const normalized = typeof value === 'number' ? String(value) : value;
  if (typeof normalized !== 'string' || !/^\d+$/.test(normalized)) {
    throw new RoleAdminError(
      400,
      'INVALID_AFFECTED_USER_COUNT',
      'Expected active assigned-user count must be a non-negative integer'
    );
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new RoleAdminError(
      400,
      'INVALID_AFFECTED_USER_COUNT',
      'Expected active assigned-user count must be a non-negative integer'
    );
  }
  return parsed;
}

function normalizeRoleText(value, { field, maxLength }) {
  if (typeof value !== 'string') {
    throw new RoleAdminError(400, 'INVALID_ROLE_DETAILS', `${field} is required`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new RoleAdminError(
      400,
      'INVALID_ROLE_DETAILS',
      `${field} must contain between 1 and ${maxLength} characters`
    );
  }
  return normalized;
}

function normalizePermissionKeys(value) {
  if (!Array.isArray(value)) {
    throw new RoleAdminError(
      400,
      'INVALID_PERMISSION_SET',
      'permissionKeys must be an array'
    );
  }
  const keys = [...new Set(value)];
  if (keys.some((key) => typeof key !== 'string' || !PERMISSION_KEY_PATTERN.test(key))) {
    throw new RoleAdminError(
      400,
      'INVALID_PERMISSION_SET',
      'Permission set contains an invalid permission key'
    );
  }
  return keys.sort();
}

function assertNoReservedPermissions(permissionKeys) {
  const reserved = permissionKeys.filter((key) => RESERVED_PERMISSION_KEY_SET.has(key));
  if (reserved.length > 0) {
    throw new RoleAdminError(
      400,
      'RESERVED_PERMISSION',
      `Administrator-only permissions cannot be granted: ${reserved.join(', ')}`
    );
  }
}

function isProtectedAdministrator(role) {
  return role.role_key === ADMINISTRATOR_ROLE_KEY && role.is_system === true;
}

function normalizeRole(row) {
  const permissionKeys = Array.isArray(row.permission_keys)
    ? row.permission_keys.filter(Boolean).sort()
    : [];
  return {
    id: Number(row.id),
    key: row.role_key,
    displayName: row.display_name,
    description: row.description,
    isSystem: Boolean(row.is_system),
    isProtected: isProtectedAdministrator(row),
    status: row.status,
    version: Number(row.version),
    permissionKeys,
    permissionCount: permissionKeys.length,
    assignedUserCount: Number(row.assigned_user_count || 0),
    activeAssignedUserCount: Number(row.active_assigned_user_count || 0),
    disabledAssignedUserCount: Number(row.disabled_assigned_user_count || 0),
  };
}

const ROLE_SELECT = `
  SELECT role.id, role.role_key, role.display_name, role.description,
         role.is_system, role.status, role.version,
         COALESCE((
           SELECT ARRAY_AGG(role_permission.permission_key ORDER BY role_permission.permission_key)
           FROM role_permissions role_permission
           WHERE role_permission.role_id = role.id
         ), ARRAY[]::text[]) AS permission_keys,
         (SELECT COUNT(*)::int
          FROM user_role_assignments assignment
          WHERE assignment.role_id = role.id AND assignment.revoked_at IS NULL)
           AS assigned_user_count,
         (SELECT COUNT(*)::int
          FROM user_role_assignments assignment
          JOIN application_users app_user ON app_user.id = assignment.application_user_id
          WHERE assignment.role_id = role.id AND assignment.revoked_at IS NULL
            AND app_user.status = 'active') AS active_assigned_user_count,
         (SELECT COUNT(*)::int
          FROM user_role_assignments assignment
          JOIN application_users app_user ON app_user.id = assignment.application_user_id
          WHERE assignment.role_id = role.id AND assignment.revoked_at IS NULL
            AND app_user.status = 'disabled') AS disabled_assigned_user_count
  FROM roles role`;

async function listRoles({ databasePool = pool } = {}) {
  const result = await databasePool.query(
    `${ROLE_SELECT}
     ORDER BY CASE WHEN role.role_key = 'administrator' AND role.is_system = TRUE THEN 0 ELSE 1 END,
              CASE role.status WHEN 'active' THEN 0 ELSE 1 END,
              LOWER(role.display_name), role.id`
  );
  return result.rows.map(normalizeRole);
}

async function listPermissions({ databasePool = pool } = {}) {
  const result = await databasePool.query(
    `SELECT permission_key, description
     FROM permissions
     ORDER BY permission_key`
  );
  return result.rows.map((row) => ({
    key: row.permission_key,
    description: row.description,
    reserved: RESERVED_PERMISSION_KEY_SET.has(row.permission_key),
  }));
}

async function lockRole(client, roleId) {
  const result = await client.query(
    `SELECT id, role_key, display_name, description, is_system, status, version
     FROM roles WHERE id = $1 FOR UPDATE`,
    [roleId]
  );
  if (result.rows.length !== 1) {
    throw new RoleAdminError(404, 'ROLE_NOT_FOUND', 'Role was not found');
  }
  return result.rows[0];
}

function assertEditableRole(role) {
  if (isProtectedAdministrator(role)) {
    throw new RoleAdminError(
      409,
      'ADMINISTRATOR_ROLE_PROTECTED',
      'The built-in Administrator role is protected and cannot be modified'
    );
  }
}

function assertRoleVersion(role, expectedVersion) {
  if (Number(role.version) !== expectedVersion) {
    throw new RoleAdminError(
      409,
      'ROLE_VERSION_CONFLICT',
      'The role changed; refresh before trying again'
    );
  }
}

async function validatePermissionCatalog(client, permissionKeys) {
  if (permissionKeys.length === 0) return;
  const result = await client.query(
    `SELECT permission_key FROM permissions WHERE permission_key = ANY($1::text[])`,
    [permissionKeys]
  );
  if (result.rows.length !== permissionKeys.length) {
    const known = new Set(result.rows.map((row) => row.permission_key));
    const unknown = permissionKeys.filter((key) => !known.has(key));
    throw new RoleAdminError(
      400,
      'UNKNOWN_PERMISSION',
      `Unknown permission keys: ${unknown.join(', ')}`
    );
  }
}

async function getRole(client, roleId) {
  const result = await client.query(`${ROLE_SELECT} WHERE role.id = $1`, [roleId]);
  if (result.rows.length !== 1) {
    throw new RoleAdminError(404, 'ROLE_NOT_FOUND', 'Role was not found');
  }
  return normalizeRole(result.rows[0]);
}

function normalizeMutationOptions(options = {}) {
  const contextInput = options.mutationContext || options;
  const actorUserId = parsePositiveInteger(
    contextInput.actorUserId,
    'INVALID_APPLICATION_USER_ID',
    'Mutation actor user ID'
  );
  return {
    actorUserId,
    mutationContext: createMutationContext({
      actorUserId,
      requestId: contextInput.requestId,
    }),
    databasePool: options.databasePool || pool,
  };
}

function runRoleMutation(options, operation) {
  return runAccessAdminMutation({
    ...options,
    requiredPermission: 'roles.manage',
    createError: createRoleAdminError,
    operation,
  });
}

async function writeRoleAuditEvent(client, mutationContext, eventKey, roleId, details) {
  return writeAuditEvent(client, {
    mutationContext,
    eventKey,
    subjectType: 'role',
    subjectId: roleId,
    details,
  });
}

function translateDatabaseError(error) {
  if (error?.code === '23505' && error.constraint === 'roles_display_name_case_insensitive_idx') {
    return new RoleAdminError(
      409,
      'ROLE_DISPLAY_NAME_CONFLICT',
      'A role with this display name already exists'
    );
  }
  return error;
}

async function createRole(input, options = {}) {
  const displayName = normalizeRoleText(input?.displayName, {
    field: 'Role display name', maxLength: 100,
  });
  const description = normalizeRoleText(input?.description, {
    field: 'Role description', maxLength: 500,
  });
  const permissionKeys = normalizePermissionKeys(input?.permissionKeys);
  assertNoReservedPermissions(permissionKeys);
  const normalized = normalizeMutationOptions(options);
  try {
    return await runRoleMutation(normalized, async (client) => {
      await validatePermissionCatalog(client, permissionKeys);
      const roleKey = `custom_${crypto.randomUUID().replaceAll('-', '')}`;
      const inserted = await client.query(
        `INSERT INTO roles (role_key, display_name, description, is_system)
         VALUES ($1, $2, $3, FALSE)
         RETURNING id, version`,
        [roleKey, displayName, description]
      );
      const roleId = Number(inserted.rows[0].id);
      if (permissionKeys.length > 0) {
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_key)
           SELECT $1, UNNEST($2::text[])`,
          [roleId, permissionKeys]
        );
      }
      await writeRoleAuditEvent(client, normalized.mutationContext,
        ROLE_AUDIT_EVENTS.CREATED, roleId, {
          roleKey, displayName, permissionKeys,
        });
      return getRole(client, roleId);
    });
  } catch (error) {
    throw translateDatabaseError(error);
  }
}

async function updateRole(roleIdValue, input, options = {}) {
  const roleId = parseRoleId(roleIdValue);
  const expectedVersion = parseExpectedVersion(input?.expectedVersion);
  const displayName = normalizeRoleText(input?.displayName, {
    field: 'Role display name', maxLength: 100,
  });
  const description = normalizeRoleText(input?.description, {
    field: 'Role description', maxLength: 500,
  });
  const normalized = normalizeMutationOptions(options);
  try {
    return await runRoleMutation(normalized, async (client) => {
      const role = await lockRole(client, roleId);
      assertEditableRole(role);
      assertRoleVersion(role, expectedVersion);
      const changedFields = [];
      if (role.display_name !== displayName) changedFields.push('displayName');
      if (role.description !== description) changedFields.push('description');
      if (changedFields.length === 0) return getRole(client, roleId);

      await client.query(
        `UPDATE roles
         SET display_name = $1, description = $2,
             version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [displayName, description, roleId]
      );
      await writeRoleAuditEvent(client, normalized.mutationContext,
        ROLE_AUDIT_EVENTS.UPDATED, roleId, {
          changedFields,
          ...(changedFields.includes('displayName') ? {
            previousDisplayName: role.display_name,
            newDisplayName: displayName,
          } : {}),
          versionFrom: Number(role.version),
          versionTo: Number(role.version) + 1,
        });
      return getRole(client, roleId);
    });
  } catch (error) {
    throw translateDatabaseError(error);
  }
}

async function replaceRolePermissions(roleIdValue, input, options = {}) {
  const roleId = parseRoleId(roleIdValue);
  const expectedVersion = parseExpectedVersion(input?.expectedVersion);
  const permissionKeys = normalizePermissionKeys(input?.permissionKeys);
  const normalized = normalizeMutationOptions(options);
  return runRoleMutation(normalized, async (client) => {
    const role = await lockRole(client, roleId);
    assertEditableRole(role);
    assertRoleVersion(role, expectedVersion);
    assertNoReservedPermissions(permissionKeys);
    await validatePermissionCatalog(client, permissionKeys);
    const currentResult = await client.query(
      `SELECT permission_key FROM role_permissions WHERE role_id = $1 ORDER BY permission_key`,
      [roleId]
    );
    const currentKeys = currentResult.rows.map((row) => row.permission_key);
    const requested = new Set(permissionKeys);
    const current = new Set(currentKeys);
    const addedPermissionKeys = permissionKeys.filter((key) => !current.has(key));
    const removedPermissionKeys = currentKeys.filter((key) => !requested.has(key));
    if (addedPermissionKeys.length === 0 && removedPermissionKeys.length === 0) {
      return getRole(client, roleId);
    }

    const counts = await client.query(
      `SELECT COUNT(*)::int AS assigned_user_count,
              COUNT(*) FILTER (WHERE app_user.status = 'active')::int
                AS active_assigned_user_count,
              COUNT(*) FILTER (WHERE app_user.status = 'disabled')::int
                AS disabled_assigned_user_count
       FROM user_role_assignments assignment
       JOIN application_users app_user ON app_user.id = assignment.application_user_id
       WHERE assignment.role_id = $1 AND assignment.revoked_at IS NULL`,
      [roleId]
    );
    const activeAssignedUserCount = Number(counts.rows[0].active_assigned_user_count);
    if (removedPermissionKeys.length > 0 && activeAssignedUserCount > 0) {
      const expectedCount = parseExpectedActiveAssignedUserCount(
        input?.expectedActiveAssignedUserCount
      );
      if (expectedCount !== activeAssignedUserCount) {
        throw new RoleAdminError(
          409,
          'ROLE_AFFECTED_USERS_CONFLICT',
          'The number of affected active users changed; refresh and confirm again'
        );
      }
    }

    if (removedPermissionKeys.length > 0) {
      await client.query(
        `DELETE FROM role_permissions
         WHERE role_id = $1 AND permission_key = ANY($2::text[])`,
        [roleId, removedPermissionKeys]
      );
    }
    if (addedPermissionKeys.length > 0) {
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_key)
         SELECT $1, UNNEST($2::text[])`,
        [roleId, addedPermissionKeys]
      );
    }
    await client.query(
      `UPDATE roles
       SET version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [roleId]
    );
    await writeRoleAuditEvent(client, normalized.mutationContext,
      ROLE_AUDIT_EVENTS.PERMISSIONS_CHANGED, roleId, {
        addedPermissionKeys,
        removedPermissionKeys,
        affectedActiveUserCount: activeAssignedUserCount,
        affectedDisabledUserCount: Number(counts.rows[0].disabled_assigned_user_count),
        versionFrom: Number(role.version),
        versionTo: Number(role.version) + 1,
      });
    return getRole(client, roleId);
  });
}

async function changeRoleStatus(roleIdValue, expectedVersionValue, nextStatus, options = {}) {
  const roleId = parseRoleId(roleIdValue);
  const expectedVersion = parseExpectedVersion(expectedVersionValue);
  const normalized = normalizeMutationOptions(options);
  return runRoleMutation(normalized, async (client) => {
    const role = await lockRole(client, roleId);
    assertEditableRole(role);
    assertRoleVersion(role, expectedVersion);
    if (role.status === nextStatus) return getRole(client, roleId);

    if (nextStatus === 'disabled') {
      const assignments = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM user_role_assignments
         WHERE role_id = $1 AND revoked_at IS NULL`,
        [roleId]
      );
      if (Number(assignments.rows[0].count) > 0) {
        throw new RoleAdminError(
          409,
          'ROLE_HAS_CURRENT_ASSIGNMENTS',
          'Reassign every current user before deactivating this role'
        );
      }
    }

    await client.query(
      `UPDATE roles
       SET status = $1, version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [nextStatus, roleId]
    );
    await writeRoleAuditEvent(client, normalized.mutationContext,
      nextStatus === 'disabled'
        ? ROLE_AUDIT_EVENTS.DEACTIVATED
        : ROLE_AUDIT_EVENTS.REACTIVATED,
      roleId,
      {
        previousStatus: role.status,
        newStatus: nextStatus,
        versionFrom: Number(role.version),
        versionTo: Number(role.version) + 1,
      });
    return getRole(client, roleId);
  });
}

function deactivateRole(roleId, expectedVersion, options = {}) {
  return changeRoleStatus(roleId, expectedVersion, 'disabled', options);
}

function reactivateRole(roleId, expectedVersion, options = {}) {
  return changeRoleStatus(roleId, expectedVersion, 'active', options);
}

module.exports = {
  ADMINISTRATOR_ROLE_KEY,
  RESERVED_PERMISSION_KEYS,
  ROLE_AUDIT_EVENTS,
  RoleAdminError,
  createRole,
  deactivateRole,
  listPermissions,
  listRoles,
  normalizePermissionKeys,
  parseExpectedVersion,
  parseRoleId,
  reactivateRole,
  replaceRolePermissions,
  updateRole,
};
