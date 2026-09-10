const pool = require('../src/db/pool');

const BOOTSTRAP_LOCK_KEY = 'amber_security_bootstrap_first_administrator';

function parseUserId(argv = process.argv.slice(2)) {
  const flagIndex = argv.indexOf('--user-id');
  const raw = flagIndex === -1 ? null : argv[flagIndex + 1];
  const userId = Number(raw);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('Usage: npm run auth:bootstrap-admin -- --user-id <positive-local-user-id>');
  }
  return userId;
}

async function bootstrapAdministrator(userId, { databasePool = pool } = {}) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0) {
    throw new Error('A positive local application user ID is required');
  }
  const normalizedUserId = Number(userId);
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [BOOTSTRAP_LOCK_KEY]);
    const stateResult = await client.query(
      'SELECT * FROM security_bootstrap_state WHERE singleton = TRUE FOR UPDATE'
    );
    if (stateResult.rows.length !== 1) {
      throw new Error('Security bootstrap state is missing');
    }
    if (stateResult.rows[0].completed_at) {
      throw new Error('First-Administrator bootstrap has already been completed permanently');
    }

    const userResult = await client.query(
      `SELECT u.id,
              EXISTS (
                SELECT 1 FROM application_external_identities e
                WHERE e.application_user_id = u.id
              ) AS has_external_identity
       FROM application_users u
       WHERE u.id = $1
       FOR UPDATE`,
      [normalizedUserId]
    );
    if (userResult.rows.length === 0) {
      throw new Error(`Application user ${normalizedUserId} does not exist`);
    }
    if (!userResult.rows[0].has_external_identity) {
      throw new Error(`Application user ${normalizedUserId} has no verified external identity`);
    }

    const roleResult = await client.query(
      `SELECT id FROM roles
       WHERE role_key = 'administrator' AND is_system = TRUE AND status = 'active'
       FOR UPDATE`
    );
    if (roleResult.rows.length !== 1) {
      throw new Error('Built-in Administrator role is unavailable');
    }
    await client.query(
      `INSERT INTO user_role_assignments (application_user_id, role_id)
       VALUES ($1, $2)
       ON CONFLICT (application_user_id, role_id) WHERE revoked_at IS NULL DO NOTHING`,
      [normalizedUserId, roleResult.rows[0].id]
    );
    await client.query(
      `UPDATE application_users
       SET status = 'active',
           activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
           deactivated_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [normalizedUserId]
    );
    const completed = await client.query(
      `UPDATE security_bootstrap_state
       SET completed_at = CURRENT_TIMESTAMP, administrator_user_id = $1
       WHERE singleton = TRUE AND completed_at IS NULL
       RETURNING completed_at`,
      [normalizedUserId]
    );
    if (completed.rows.length !== 1) {
      throw new Error('First-Administrator bootstrap has already been completed permanently');
    }
    await client.query('COMMIT');
    return { applicationUserId: normalizedUserId, roleKey: 'administrator' };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    const result = await bootstrapAdministrator(parseUserId());
    console.log(
      `Activated application user ${result.applicationUserId} as the first Administrator.`
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) void main();

module.exports = {
  BOOTSTRAP_LOCK_KEY,
  bootstrapAdministrator,
  parseUserId,
};
