const pool = require('../db/pool');

const APPLICATION_USER_ADMIN_LOCK_KEY = 'amber_application_user_admin_active_administrators';
const ASSIGNABLE_ROLE_KEYS = Object.freeze([
  'administrator',
  'manager',
  'storekeeper',
]);
const ASSIGNABLE_ROLE_KEY_SET = new Set(ASSIGNABLE_ROLE_KEYS);

class ApplicationUserAdminError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ApplicationUserAdminError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parseApplicationUserId(value) {
  const normalized = typeof value === 'number' ? String(value) : value;
  if (typeof normalized !== 'string' || !/^[1-9]\d*$/.test(normalized)) {
    throw new ApplicationUserAdminError(
      400,
      'INVALID_APPLICATION_USER_ID',
      'Application user ID must be a positive integer'
    );
  }
  const userId = Number(normalized);
  if (!Number.isSafeInteger(userId)) {
    throw new ApplicationUserAdminError(
      400,
      'INVALID_APPLICATION_USER_ID',
      'Application user ID must be a positive integer'
    );
  }
  return userId;
}

function assertAssignableRoleKey(value) {
  if (typeof value !== 'string' || !ASSIGNABLE_ROLE_KEY_SET.has(value)) {
    throw new ApplicationUserAdminError(
      400,
      'ROLE_NOT_ASSIGNABLE',
      'Role must be an active built-in application role'
    );
  }
  return value;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeManagedApplicationUser(row) {
  const roleKeys = Array.isArray(row?.role_keys)
    ? row.role_keys.filter((roleKey) => ASSIGNABLE_ROLE_KEY_SET.has(roleKey))
    : [];
  return {
    id: Number(row.id),
    status: row.status,
    preferredUsername: row.preferred_username || null,
    displayName: row.display_name || null,
    lastAuthenticatedAt: normalizeTimestamp(row.last_authenticated_at),
    identityLinked: Boolean(row.identity_linked),
    roleKey: roleKeys.length === 1 ? roleKeys[0] : null,
    hasMultipleBuiltInRoles: roleKeys.length > 1,
  };
}

const MANAGED_USER_SELECT = `
  SELECT u.id, u.status, u.preferred_username, u.display_name,
         u.last_authenticated_at,
         EXISTS (
           SELECT 1
           FROM application_external_identities e
           WHERE e.application_user_id = u.id
         ) AS identity_linked,
         ARRAY(
           SELECT r.role_key
           FROM user_role_assignments a
           JOIN roles r ON r.id = a.role_id
           WHERE a.application_user_id = u.id
             AND a.revoked_at IS NULL
             AND r.is_system = TRUE
             AND r.role_key = ANY($1::text[])
           ORDER BY r.role_key
         ) AS role_keys
  FROM application_users u`;

async function listApplicationUsers({ databasePool = pool } = {}) {
  const result = await databasePool.query(
    `${MANAGED_USER_SELECT}
     ORDER BY CASE u.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
              COALESCE(u.display_name, u.preferred_username, ''), u.id`,
    [ASSIGNABLE_ROLE_KEYS]
  );
  return result.rows.map(normalizeManagedApplicationUser);
}

async function listAssignableBuiltInRoles({ databasePool = pool } = {}) {
  const result = await databasePool.query(
    `SELECT role_key
     FROM roles
     WHERE is_system = TRUE
       AND status = 'active'
       AND role_key = ANY($1::text[])
     ORDER BY CASE role_key
       WHEN 'administrator' THEN 0
       WHEN 'manager' THEN 1
       WHEN 'storekeeper' THEN 2
       ELSE 3
     END`,
    [ASSIGNABLE_ROLE_KEYS]
  );
  return result.rows.map((row) => ({ key: row.role_key }));
}

async function getManagedApplicationUser(userId, queryable) {
  const result = await queryable.query(
    `${MANAGED_USER_SELECT} WHERE u.id = $2`,
    [ASSIGNABLE_ROLE_KEYS, userId]
  );
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

async function getActiveBuiltInAssignments(client, userId) {
  const result = await client.query(
    `SELECT a.id, a.role_id, r.role_key, r.status AS role_status
     FROM user_role_assignments a
     JOIN roles r ON r.id = a.role_id
     WHERE a.application_user_id = $1
       AND a.revoked_at IS NULL
       AND r.is_system = TRUE
       AND r.role_key = ANY($2::text[])
     ORDER BY a.id
     FOR UPDATE OF a`,
    [userId, ASSIGNABLE_ROLE_KEYS]
  );
  return result.rows;
}

async function getAssignableRole(client, roleKey) {
  const result = await client.query(
    `SELECT id, role_key
     FROM roles
     WHERE role_key = $1
       AND role_key = ANY($2::text[])
       AND is_system = TRUE
       AND status = 'active'
     FOR SHARE`,
    [roleKey, ASSIGNABLE_ROLE_KEYS]
  );
  if (result.rows.length !== 1) {
    throw new ApplicationUserAdminError(
      400,
      'ROLE_NOT_ASSIGNABLE',
      'Role must be an active built-in application role'
    );
  }
  return result.rows[0];
}

async function assertAdministratorCanBeRemoved(client) {
  const result = await client.query(
    `SELECT COUNT(DISTINCT u.id)::int AS count
     FROM application_users u
     JOIN user_role_assignments a
       ON a.application_user_id = u.id AND a.revoked_at IS NULL
     JOIN roles r ON r.id = a.role_id
     WHERE u.status = 'active'
       AND r.role_key = 'administrator'
       AND r.is_system = TRUE
       AND r.status = 'active'`
  );
  if (Number(result.rows[0].count) <= 1) {
    throw new ApplicationUserAdminError(
      409,
      'LAST_ADMINISTRATOR_REQUIRED',
      'At least one active Administrator must remain'
    );
  }
}

async function replaceActiveBuiltInRole(client, userId, role, actorUserId, assignments) {
  if (
    assignments.length === 1
    && assignments[0].role_key === role.role_key
    && assignments[0].role_status === 'active'
  ) {
    return;
  }

  if (assignments.length > 0) {
    await client.query(
      `UPDATE user_role_assignments
       SET revoked_at = CURRENT_TIMESTAMP,
           revoked_by_user_id = $1
       WHERE id = ANY($2::bigint[])`,
      [actorUserId, assignments.map((assignment) => assignment.id)]
    );
  }
  await client.query(
    `INSERT INTO user_role_assignments
     (application_user_id, role_id, assigned_by_user_id)
     VALUES ($1, $2, $3)`,
    [userId, role.id, actorUserId]
  );
}

async function runUserMutation(databasePool, operation) {
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      APPLICATION_USER_ADMIN_LOCK_KEY,
    ]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function normalizeMutationOptions(options = {}) {
  return {
    actorUserId: parseApplicationUserId(options.actorUserId),
    databasePool: options.databasePool || pool,
  };
}

async function approveApplicationUser(userIdValue, roleKeyValue, options = {}) {
  const userId = parseApplicationUserId(userIdValue);
  const roleKey = assertAssignableRoleKey(roleKeyValue);
  const { actorUserId, databasePool } = normalizeMutationOptions(options);
  return runUserMutation(databasePool, async (client) => {
    const user = await lockApplicationUser(client, userId);
    if (user.status !== 'pending') {
      throw new ApplicationUserAdminError(
        409,
        'APPLICATION_USER_STATUS_CONFLICT',
        'Only a pending application user can be approved'
      );
    }
    const role = await getAssignableRole(client, roleKey);
    const assignments = await getActiveBuiltInAssignments(client, userId);
    await replaceActiveBuiltInRole(client, userId, role, actorUserId, assignments);
    await client.query(
      `UPDATE application_users
       SET status = 'active',
           activated_at = CURRENT_TIMESTAMP,
           deactivated_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [userId]
    );
    return getManagedApplicationUser(userId, client);
  });
}

async function changeApplicationUserRole(userIdValue, roleKeyValue, options = {}) {
  const userId = parseApplicationUserId(userIdValue);
  const roleKey = assertAssignableRoleKey(roleKeyValue);
  const { actorUserId, databasePool } = normalizeMutationOptions(options);
  return runUserMutation(databasePool, async (client) => {
    const user = await lockApplicationUser(client, userId);
    if (!['active', 'disabled'].includes(user.status)) {
      throw new ApplicationUserAdminError(
        409,
        'APPLICATION_USER_STATUS_CONFLICT',
        'Approve a pending application user before changing its role'
      );
    }
    const role = await getAssignableRole(client, roleKey);
    const assignments = await getActiveBuiltInAssignments(client, userId);
    const removesActiveAdministrator = user.status === 'active'
      && roleKey !== 'administrator'
      && assignments.some((assignment) => assignment.role_key === 'administrator');
    if (removesActiveAdministrator) await assertAdministratorCanBeRemoved(client);
    await replaceActiveBuiltInRole(client, userId, role, actorUserId, assignments);
    return getManagedApplicationUser(userId, client);
  });
}

async function disableApplicationUser(userIdValue, options = {}) {
  const userId = parseApplicationUserId(userIdValue);
  const { actorUserId, databasePool } = normalizeMutationOptions(options);
  return runUserMutation(databasePool, async (client) => {
    const user = await lockApplicationUser(client, userId);
    if (user.status !== 'active') {
      throw new ApplicationUserAdminError(
        409,
        'APPLICATION_USER_STATUS_CONFLICT',
        'Only an active application user can be disabled'
      );
    }
    const assignments = await getActiveBuiltInAssignments(client, userId);
    if (assignments.some((assignment) => assignment.role_key === 'administrator')) {
      await assertAdministratorCanBeRemoved(client);
    }
    await client.query(
      `UPDATE application_users
       SET status = 'disabled',
           deactivated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [userId]
    );
    return getManagedApplicationUser(userId, client);
  });
}

async function enableApplicationUser(userIdValue, roleKeyValue, options = {}) {
  const userId = parseApplicationUserId(userIdValue);
  const roleKey = roleKeyValue === undefined
    ? null
    : assertAssignableRoleKey(roleKeyValue);
  const { actorUserId, databasePool } = normalizeMutationOptions(options);
  return runUserMutation(databasePool, async (client) => {
    const user = await lockApplicationUser(client, userId);
    if (user.status !== 'disabled') {
      throw new ApplicationUserAdminError(
        409,
        'APPLICATION_USER_STATUS_CONFLICT',
        'Only a disabled application user can be enabled'
      );
    }
    const assignments = await getActiveBuiltInAssignments(client, userId);
    if (roleKey) {
      const role = await getAssignableRole(client, roleKey);
      await replaceActiveBuiltInRole(client, userId, role, actorUserId, assignments);
    } else if (
      assignments.length !== 1
      || assignments[0].role_status !== 'active'
      || !ASSIGNABLE_ROLE_KEY_SET.has(assignments[0].role_key)
    ) {
      throw new ApplicationUserAdminError(
        409,
        'ACTIVE_BUILT_IN_ROLE_REQUIRED',
        'Select one active built-in role before enabling this application user'
      );
    }
    await client.query(
      `UPDATE application_users
       SET status = 'active',
           activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
           deactivated_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [userId]
    );
    return getManagedApplicationUser(userId, client);
  });
}

module.exports = {
  APPLICATION_USER_ADMIN_LOCK_KEY,
  ASSIGNABLE_ROLE_KEYS,
  ApplicationUserAdminError,
  approveApplicationUser,
  assertAssignableRoleKey,
  changeApplicationUserRole,
  disableApplicationUser,
  enableApplicationUser,
  listApplicationUsers,
  listAssignableBuiltInRoles,
  normalizeManagedApplicationUser,
  parseApplicationUserId,
};
