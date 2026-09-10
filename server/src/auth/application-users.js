const pool = require('../db/pool');

const APPLICATION_USER_STATUSES = Object.freeze({
  PENDING: 'pending',
  ACTIVE: 'active',
  DISABLED: 'disabled',
});

const PROFILE_FIELDS = Object.freeze([
  ['preferred_username', 'preferred_username'],
  ['name', 'display_name'],
  ['given_name', 'given_name'],
  ['family_name', 'family_name'],
  ['email', 'email'],
]);

function optionalProfileString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getAuthenticatedAt(identity) {
  const value = identity?.authenticatedAt;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error('Authenticated identity timestamp is invalid');
  }
  return value;
}

function assertExternalIdentity(identity) {
  if (!identity || typeof identity !== 'object') {
    throw new Error('Authenticated identity is missing');
  }
  if (typeof identity.issuer !== 'string' || !identity.issuer.trim()) {
    throw new Error('Authenticated identity issuer is missing');
  }
  if (typeof identity.sub !== 'string' || !identity.sub.trim()) {
    throw new Error('Authenticated identity subject is missing');
  }
  getAuthenticatedAt(identity);
}

function normalizeApplicationUser(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    status: row.status,
    preferredUsername: row.preferred_username || null,
    displayName: row.display_name || null,
    givenName: row.given_name || null,
    familyName: row.family_name || null,
    email: row.email || null,
  };
}

function profileValues(identity) {
  return PROFILE_FIELDS.map(([claim]) => optionalProfileString(identity[claim]));
}

async function resolveOrCreateApplicationUser(identity, { databasePool = pool } = {}) {
  assertExternalIdentity(identity);
  const issuer = identity.issuer;
  const subject = identity.sub;
  const authenticatedAt = getAuthenticatedAt(identity);
  const profile = profileValues(identity);
  const client = await databasePool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `application-external-identity:${issuer}\n${subject}`,
    ]);
    const existing = await client.query(
      `SELECT u.*
       FROM application_external_identities e
       JOIN application_users u ON u.id = e.application_user_id
       WHERE e.issuer = $1 AND e.subject = $2
       FOR UPDATE OF e, u`,
      [issuer, subject]
    );

    let userRow;
    if (existing.rows.length > 0) {
      const updated = await client.query(
        `UPDATE application_users
         SET preferred_username = $1,
             display_name = $2,
             given_name = $3,
             family_name = $4,
             email = $5,
             updated_at = CURRENT_TIMESTAMP,
             last_authenticated_at = GREATEST(last_authenticated_at, $6::timestamptz)
         WHERE id = $7
         RETURNING *`,
        [...profile, authenticatedAt, existing.rows[0].id]
      );
      userRow = updated.rows[0];
      await client.query(
        `UPDATE application_external_identities
         SET last_authenticated_at = GREATEST(last_authenticated_at, $1::timestamptz)
         WHERE issuer = $2 AND subject = $3`,
        [authenticatedAt, issuer, subject]
      );
    } else {
      const inserted = await client.query(
        `INSERT INTO application_users
         (status, preferred_username, display_name, given_name, family_name, email,
          last_authenticated_at)
         VALUES ('pending', $1, $2, $3, $4, $5, $6::timestamptz)
         RETURNING *`,
        [...profile, authenticatedAt]
      );
      userRow = inserted.rows[0];
      await client.query(
        `INSERT INTO application_external_identities
         (application_user_id, issuer, subject, last_authenticated_at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [userRow.id, issuer, subject, authenticatedAt]
      );
    }

    await client.query('COMMIT');
    return normalizeApplicationUser(userRow);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getApplicationAccess(identity, { databasePool = pool } = {}) {
  assertExternalIdentity(identity);
  const result = await databasePool.query(
    `SELECT u.id, u.status, u.preferred_username, u.display_name, u.given_name,
            u.family_name, u.email, r.id AS role_id, r.role_key,
            r.display_name AS role_display_name,
            p.permission_key
     FROM application_external_identities e
     JOIN application_users u ON u.id = e.application_user_id
     LEFT JOIN user_role_assignments a
       ON a.application_user_id = u.id AND a.revoked_at IS NULL
     LEFT JOIN roles r
       ON r.id = a.role_id AND r.status = 'active'
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.permission_key = rp.permission_key
     WHERE e.issuer = $1 AND e.subject = $2
     ORDER BY r.role_key, p.permission_key`,
    [identity.issuer, identity.sub]
  );
  if (result.rows.length === 0) return null;

  const rolesByKey = new Map();
  const permissions = new Set();
  for (const row of result.rows) {
    if (row.role_key && !rolesByKey.has(row.role_key)) {
      rolesByKey.set(row.role_key, {
        id: Number(row.role_id),
        key: row.role_key,
        displayName: row.role_display_name,
      });
    }
    if (row.permission_key) permissions.add(row.permission_key);
  }

  return {
    applicationUser: normalizeApplicationUser(result.rows[0]),
    roles: [...rolesByKey.values()],
    permissions: [...permissions].sort(),
  };
}

async function getOrCreateApplicationAccess(identity, options = {}) {
  let access = await getApplicationAccess(identity, options);
  if (access) return access;
  await resolveOrCreateApplicationUser(identity, options);
  access = await getApplicationAccess(identity, options);
  if (!access) throw new Error('Application user could not be resolved');
  return access;
}

module.exports = {
  APPLICATION_USER_STATUSES,
  getApplicationAccess,
  getOrCreateApplicationAccess,
  normalizeApplicationUser,
  resolveOrCreateApplicationUser,
};
