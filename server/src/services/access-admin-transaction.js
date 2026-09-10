const APPLICATION_USER_ADMIN_LOCK_KEY = 'amber_application_user_admin_active_administrators';

async function assertActorStillAuthorized(client, actorUserId, permissionKey, createError) {
  const result = await client.query(
    `SELECT u.status,
            EXISTS (
              SELECT 1
              FROM user_role_assignments assignment
              JOIN roles role ON role.id = assignment.role_id AND role.status = 'active'
              JOIN role_permissions role_permission ON role_permission.role_id = role.id
              WHERE assignment.application_user_id = u.id
                AND assignment.revoked_at IS NULL
                AND role_permission.permission_key = $2
            ) AS has_permission
     FROM application_users u
     WHERE u.id = $1
     FOR KEY SHARE`,
    [actorUserId, permissionKey]
  );
  if (
    result.rows.length !== 1
    || result.rows[0].status !== 'active'
    || !result.rows[0].has_permission
  ) {
    throw createError(
      403,
      'ADMIN_PERMISSION_REVOKED',
      'Administrative permission changed before the operation could be completed'
    );
  }
}

async function runAccessAdminMutation({
  databasePool,
  actorUserId,
  requiredPermission,
  createError,
  operation,
}) {
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      APPLICATION_USER_ADMIN_LOCK_KEY,
    ]);
    await assertActorStillAuthorized(
      client,
      actorUserId,
      requiredPermission,
      createError
    );
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

module.exports = {
  APPLICATION_USER_ADMIN_LOCK_KEY,
  assertActorStillAuthorized,
  runAccessAdminMutation,
};
