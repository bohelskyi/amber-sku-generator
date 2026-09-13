const suite = require('./suite-context');
const {
  assert,
  fs,
  os,
  path,
  test,
  Pool,
  pool,
  serverRoot,
  runNodeInDatabase,
  recreateTestDatabase,
  dropTestDatabase,
  runMigrations,
  roleIdForKey,
} = suite;

test('migration 019 matches the connect-pg-simple 10.0.0 table contract', async () => {
  const columns = await pool.query(`
    SELECT column_name, data_type, is_nullable, datetime_precision
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'session'
    ORDER BY ordinal_position
  `);
  assert.deepEqual(columns.rows, [
    { column_name: 'sid', data_type: 'character varying', is_nullable: 'NO', datetime_precision: null },
    { column_name: 'sess', data_type: 'json', is_nullable: 'NO', datetime_precision: null },
    { column_name: 'expire', data_type: 'timestamp without time zone', is_nullable: 'NO', datetime_precision: 6 },
  ]);

  const constraints = await pool.query(`
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'public.session'::regclass
    ORDER BY conname
  `);
  assert.deepEqual(constraints.rows, [
    { conname: 'session_pkey', definition: 'PRIMARY KEY (sid)' },
  ]);

  const indexes = await pool.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'session'
    ORDER BY indexname
  `);
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    'IDX_session_expire',
    'session_pkey',
  ]);
});

test('migrations 020-028 create constrained RBAC, audit, and business actor attribution', async () => {
  const requiredTables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name
  `, [[
    'application_external_identities',
    'application_users',
    'audit_events',
    'permissions',
    'role_permissions',
    'roles',
    'security_bootstrap_state',
    'user_role_assignments',
  ]]);
  assert.deepEqual(requiredTables.rows.map((row) => row.table_name), [
    'application_external_identities',
    'application_users',
    'audit_events',
    'permissions',
    'role_permissions',
    'roles',
    'security_bootstrap_state',
    'user_role_assignments',
  ]);

  const permissionKeys = [
    'audit.view',
    'catalog.manage',
    'catalog.view',
    'corrections.claim',
    'corrections.complete',
    'corrections.create',
    'corrections.force_release',
    'corrections.reject',
    'corrections.view',
    'exports.create',
    'exports.view',
    'history.view',
    'pricing.manage',
    'pricing.view',
    'products.archive',
    'products.create',
    'products.decode',
    'products.recount',
    'products.view',
    'repricing.apply',
    'repricing.prepare',
    'repricing.rollback',
    'repricing.view',
    'roles.manage',
    'sku_schemas.publish',
    'users.manage',
  ];
  const permissions = await pool.query(
    'SELECT permission_key FROM permissions ORDER BY permission_key'
  );
  assert.deepEqual(permissions.rows.map((row) => row.permission_key), permissionKeys);

  const mappings = await pool.query(`
    SELECT r.role_key, r.display_name, r.is_system, r.status,
           ARRAY_AGG(rp.permission_key ORDER BY rp.permission_key) AS permission_keys
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id
    GROUP BY r.id
    ORDER BY r.role_key
  `);
  const byRole = Object.fromEntries(mappings.rows.map((row) => [row.role_key, row]));
  assert.deepEqual(Object.keys(byRole), ['administrator', 'manager', 'storekeeper']);
  for (const role of mappings.rows) {
    assert.equal(role.is_system, true);
    assert.equal(role.status, 'active');
  }
  assert.deepEqual(byRole.administrator.permission_keys, permissionKeys);
  assert.deepEqual(byRole.manager.permission_keys, [
    'corrections.create',
    'corrections.reject',
    'corrections.view',
    'exports.view',
    'history.view',
    'pricing.view',
    'products.decode',
    'products.view',
    'repricing.prepare',
    'repricing.view',
  ]);
  assert.deepEqual(byRole.storekeeper.permission_keys, [
    'corrections.claim',
    'corrections.complete',
    'corrections.create',
    'corrections.reject',
    'corrections.view',
    'exports.view',
    'history.view',
    'products.archive',
    'products.create',
    'products.decode',
    'products.recount',
    'products.view',
    'repricing.prepare',
    'repricing.view',
  ]);

  assert.equal(
    (await pool.query('SELECT count(*)::int AS count FROM user_role_assignments')).rows[0].count,
    0
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT completed_at, administrator_user_id
       FROM security_bootstrap_state WHERE singleton = TRUE`
    )).rows[0],
    { completed_at: null, administrator_user_id: null }
  );

  const roleVersion = await pool.query(
    `SELECT column_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'roles' AND column_name = 'version'`
  );
  assert.deepEqual(roleVersion.rows, [{
    column_name: 'version',
    is_nullable: 'NO',
    column_default: '1',
  }]);
  const customRoleIndexes = await pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = ANY($1::text[])
     ORDER BY indexname`,
    [[
      'roles_display_name_case_insensitive_idx',
      'user_role_assignments_one_current_role_per_user_idx',
    ]]
  );
  assert.deepEqual(customRoleIndexes.rows.map((row) => row.indexname), [
    'roles_display_name_case_insensitive_idx',
    'user_role_assignments_one_current_role_per_user_idx',
  ]);

  const constraintClient = await pool.connect();
  try {
    await constraintClient.query('BEGIN');
    const probeUser = await constraintClient.query(
      `INSERT INTO application_users (status, display_name)
       VALUES ('disabled', 'Role constraint probe') RETURNING id`
    );
    const managerId = await roleIdForKey('manager', constraintClient);
    const storekeeperId = await roleIdForKey('storekeeper', constraintClient);
    await constraintClient.query(
      `INSERT INTO user_role_assignments (application_user_id, role_id) VALUES ($1, $2)`,
      [probeUser.rows[0].id, managerId]
    );
    await constraintClient.query('SAVEPOINT duplicate_assignment');
    await assert.rejects(
      constraintClient.query(
        `INSERT INTO user_role_assignments (application_user_id, role_id) VALUES ($1, $2)`,
        [probeUser.rows[0].id, storekeeperId]
      ),
      (error) => error.code === '23505'
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT duplicate_assignment');

    await constraintClient.query('SAVEPOINT reserved_grant');
    await assert.rejects(
      constraintClient.query(
        `INSERT INTO role_permissions (role_id, permission_key)
         VALUES ($1, 'users.manage')`,
        [managerId]
      ),
      /reserved for the built-in Administrator role/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT reserved_grant');

    await constraintClient.query('SAVEPOINT role_delete');
    await assert.rejects(
      constraintClient.query('DELETE FROM roles WHERE id = $1', [managerId]),
      /deactivate a role instead of deleting it/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT role_delete');

    await constraintClient.query('SAVEPOINT role_truncate');
    await assert.rejects(
      constraintClient.query('TRUNCATE roles CASCADE'),
      /roles cannot be truncated/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT role_truncate');

    await constraintClient.query('SAVEPOINT role_permissions_truncate');
    await assert.rejects(
      constraintClient.query('TRUNCATE role_permissions'),
      /role_permissions cannot be truncated/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT role_permissions_truncate');

    await constraintClient.query('SAVEPOINT role_key_mutation');
    await assert.rejects(
      constraintClient.query(
        `UPDATE roles SET role_key = 'renamed_manager_key' WHERE id = $1`,
        [managerId]
      ),
      /role_key and is_system are immutable/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT role_key_mutation');

    await constraintClient.query('SAVEPOINT role_system_mutation');
    await assert.rejects(
      constraintClient.query('UPDATE roles SET is_system = FALSE WHERE id = $1', [managerId]),
      /role_key and is_system are immutable/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT role_system_mutation');

    await constraintClient.query('SAVEPOINT administrator_mutation');
    await assert.rejects(
      constraintClient.query(
        `UPDATE roles SET status = 'disabled'
         WHERE role_key = 'administrator' AND is_system = TRUE`
      ),
      /built-in Administrator role is immutable/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT administrator_mutation');

    await constraintClient.query('SAVEPOINT administrator_permission_removal');
    await assert.rejects(
      constraintClient.query(
        `DELETE FROM role_permissions mapping
         USING roles role
         WHERE mapping.role_id = role.id
           AND role.role_key = 'administrator'
           AND mapping.permission_key = 'products.view'`
      ),
      /Administrator permissions cannot be removed/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT administrator_permission_removal');

    await constraintClient.query(
      `INSERT INTO permissions (permission_key, description)
       VALUES ('integration.future_permission', 'Future permission probe')`
    );
    assert.equal(Number((await constraintClient.query(
      `SELECT COUNT(*) FROM role_permissions mapping
       JOIN roles role ON role.id = mapping.role_id
       WHERE role.role_key = 'administrator'
         AND mapping.permission_key = 'integration.future_permission'`
    )).rows[0].count), 1);
    await constraintClient.query('ROLLBACK');
  } finally {
    constraintClient.release();
  }
});

test('migration 028 aborts without changing unsafe existing RBAC state', async () => {
  const databaseName = 'amber_custom_role_conflict_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preCustomRoleDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-custom-role-migrations-')
  );
  try {
    const migrationDirectory = path.resolve(serverRoot, 'migrations');
    const migrationFiles = (await fs.readdir(migrationDirectory))
      .filter((fileName) => fileName.endsWith('.sql') && !fileName.startsWith('028_'));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(migrationDirectory, fileName),
      path.resolve(preCustomRoleDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preCustomRoleDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    const conflictPool = new Pool({ connectionString: databaseUrl });
    try {
      const user = await conflictPool.query(
        `INSERT INTO application_users (status, display_name)
         VALUES ('disabled', 'Ambiguous role user') RETURNING id`
      );
      await conflictPool.query(
        `INSERT INTO user_role_assignments (application_user_id, role_id)
         SELECT $1, id FROM roles WHERE role_key IN ('manager', 'storekeeper')`,
        [user.rows[0].id]
      );
      await assert.rejects(
        runNodeInDatabase(databaseUrl, `
          const db = require('./src/db/pool');
          const { runMigrations } = require('./src/db/run-migrations');
          runMigrations()
            .finally(() => db.end())
            .catch((error) => { console.error(error); process.exitCode = 1; });
        `),
        /cannot enforce one current role/
      );
      assert.equal(Number((await conflictPool.query(
        `SELECT COUNT(*) FROM user_role_assignments
         WHERE application_user_id = $1 AND revoked_at IS NULL`,
        [user.rows[0].id]
      )).rows[0].count), 2);
      assert.equal((await conflictPool.query(
        `SELECT COUNT(*)::int AS count FROM schema_migrations
         WHERE name = '028_custom_roles.sql'`
      )).rows[0].count, 0);

      await conflictPool.query(
        `UPDATE user_role_assignments
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE application_user_id = $1
           AND role_id = (SELECT id FROM roles WHERE role_key = 'storekeeper')`,
        [user.rows[0].id]
      );
      await conflictPool.query(
        `INSERT INTO role_permissions (role_id, permission_key)
         SELECT id, 'users.manage' FROM roles WHERE role_key = 'manager'`
      );
      await assert.rejects(
        runNodeInDatabase(databaseUrl, `
          const db = require('./src/db/pool');
          const { runMigrations } = require('./src/db/run-migrations');
          runMigrations()
            .finally(() => db.end())
            .catch((error) => { console.error(error); process.exitCode = 1; });
        `),
        /cannot preserve reserved permissions/
      );
      assert.equal(Number((await conflictPool.query(
        `SELECT COUNT(*) FROM role_permissions mapping
         JOIN roles role ON role.id = mapping.role_id
         WHERE role.role_key = 'manager' AND mapping.permission_key = 'users.manage'`
      )).rows[0].count), 1, 'failed migration must not silently revoke reserved mappings');
    } finally {
      await conflictPool.end();
    }
  } finally {
    await fs.rm(preCustomRoleDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration 025 adds nullable user attribution and a nonnegative correction claim epoch', async () => {
  const columns = await pool.query(`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'correction_requests'
      AND column_name = ANY($1::text[])
    ORDER BY column_name
  `, [[
    'claim_version',
    'claimed_by_user_id',
    'created_by_user_id',
  ]]);
  assert.deepEqual(columns.rows, [
    { column_name: 'claim_version', is_nullable: 'NO', column_default: '0' },
    { column_name: 'claimed_by_user_id', is_nullable: 'YES', column_default: null },
    { column_name: 'created_by_user_id', is_nullable: 'YES', column_default: null },
  ]);

  const indexes = await pool.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'correction_requests'
      AND indexname LIKE 'correction_requests_%_user_idx'
    ORDER BY indexname
  `);
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    'correction_requests_claimed_by_user_idx',
    'correction_requests_created_by_user_idx',
  ]);
  const foreignKeys = await pool.query(`
    SELECT kcu.column_name, ccu.table_name AS referenced_table, rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_schema = tc.constraint_schema
     AND rc.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_schema = rc.unique_constraint_schema
     AND ccu.constraint_name = rc.unique_constraint_name
    WHERE tc.constraint_schema = 'public'
      AND tc.table_name = 'correction_requests'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name IN ('created_by_user_id', 'claimed_by_user_id')
    ORDER BY kcu.column_name
  `);
  assert.deepEqual(foreignKeys.rows, [
    {
      column_name: 'claimed_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      column_name: 'created_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
  ]);
});

test('migration 026 adds only nullable repricing actor references with restricted deletion', async () => {
  const columns = await pool.query(`
    SELECT table_name, column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (
        ('repricing_drafts', 'created_by_user_id'),
        ('repricing_drafts', 'last_modified_by_user_id'),
        ('repricing_drafts', 'discarded_by_user_id'),
        ('repricing_batches', 'applied_by_user_id'),
        ('repricing_batches', 'rolled_back_by_user_id')
      )
    ORDER BY table_name, column_name
  `);
  assert.deepEqual(columns.rows, [
    {
      table_name: 'repricing_batches',
      column_name: 'applied_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'repricing_batches',
      column_name: 'rolled_back_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'repricing_drafts',
      column_name: 'created_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'repricing_drafts',
      column_name: 'discarded_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'repricing_drafts',
      column_name: 'last_modified_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
  ]);

  const foreignKeys = await pool.query(`
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS referenced_table, rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_schema = tc.constraint_schema
     AND rc.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_schema = rc.unique_constraint_schema
     AND ccu.constraint_name = rc.unique_constraint_name
    WHERE tc.constraint_schema = 'public'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND (tc.table_name, kcu.column_name) IN (
        ('repricing_drafts', 'created_by_user_id'),
        ('repricing_drafts', 'last_modified_by_user_id'),
        ('repricing_drafts', 'discarded_by_user_id'),
        ('repricing_batches', 'applied_by_user_id'),
        ('repricing_batches', 'rolled_back_by_user_id')
      )
    ORDER BY tc.table_name, kcu.column_name
  `);
  assert.deepEqual(foreignKeys.rows, [
    {
      table_name: 'repricing_batches',
      column_name: 'applied_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      table_name: 'repricing_batches',
      column_name: 'rolled_back_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      table_name: 'repricing_drafts',
      column_name: 'created_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      table_name: 'repricing_drafts',
      column_name: 'discarded_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      table_name: 'repricing_drafts',
      column_name: 'last_modified_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
  ]);
});

test('migration 027 adds only nullable export and SKU publication actor references', async () => {
  const columns = await pool.query(`
    SELECT table_name, column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (
        ('export_snapshots', 'created_by_user_id'),
        ('export_snapshots', 'confirmed_by_user_id'),
        ('sku_schema_versions', 'published_by_user_id')
      )
    ORDER BY table_name, column_name
  `);
  assert.deepEqual(columns.rows, [
    {
      table_name: 'export_snapshots',
      column_name: 'confirmed_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'export_snapshots',
      column_name: 'created_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'sku_schema_versions',
      column_name: 'published_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
  ]);

  const foreignKeys = await pool.query(`
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS referenced_table, rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_schema = tc.constraint_schema
     AND rc.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_schema = rc.unique_constraint_schema
     AND ccu.constraint_name = rc.unique_constraint_name
    WHERE tc.constraint_schema = 'public'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND (tc.table_name, kcu.column_name) IN (
        ('export_snapshots', 'created_by_user_id'),
        ('export_snapshots', 'confirmed_by_user_id'),
        ('sku_schema_versions', 'published_by_user_id')
      )
    ORDER BY tc.table_name, kcu.column_name
  `);
  assert.deepEqual(foreignKeys.rows, [
    {
      table_name: 'export_snapshots',
      column_name: 'confirmed_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      table_name: 'export_snapshots',
      column_name: 'created_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      table_name: 'sku_schema_versions',
      column_name: 'published_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
  ]);
});

test('migration 023 constrains and makes durable audit records immutable', async () => {
  const columns = await pool.query(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_events'
    ORDER BY ordinal_position
  `);
  assert.deepEqual(columns.rows, [
    { column_name: 'id', is_nullable: 'NO' },
    { column_name: 'event_key', is_nullable: 'NO' },
    { column_name: 'actor_user_id', is_nullable: 'NO' },
    { column_name: 'actor_snapshot', is_nullable: 'NO' },
    { column_name: 'subject_type', is_nullable: 'NO' },
    { column_name: 'subject_id', is_nullable: 'NO' },
    { column_name: 'request_id', is_nullable: 'YES' },
    { column_name: 'details', is_nullable: 'NO' },
    { column_name: 'occurred_at', is_nullable: 'NO' },
  ]);

  const indexes = await pool.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'audit_events'
    ORDER BY indexname
  `);
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    'audit_events_actor_idx',
    'audit_events_event_key_idx',
    'audit_events_occurred_idx',
    'audit_events_pkey',
    'audit_events_subject_idx',
  ]);

  const grants = await pool.query(`
    SELECT r.role_key
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id
    WHERE rp.permission_key = 'audit.view'
    ORDER BY r.role_key
  `);
  assert.deepEqual(grants.rows, [{ role_key: 'administrator' }]);
  assert.equal(
    Number((await pool.query('SELECT count(*) FROM audit_events')).rows[0].count),
    0,
    'migration must not synthesize historical events'
  );

  const actor = await pool.query(
    `INSERT INTO application_users (status, display_name, preferred_username)
     VALUES ('pending', 'Migration Actor', 'migration.actor')
     RETURNING id`
  );
  const actorUserId = Number(actor.rows[0].id);
  await assert.rejects(
    pool.query(
      `INSERT INTO audit_events
       (event_key, actor_user_id, actor_snapshot, subject_type, subject_id)
       VALUES ('application_user.tested', $1,
               '{"displayName":"Migration Actor","preferredUsername":"migration.actor","email":"forbidden"}'::jsonb,
               'application_user', $2)`,
      [actorUserId, String(actorUserId)]
    ),
    (error) => error.code === '23514'
  );
  const event = await pool.query(
    `INSERT INTO audit_events
     (event_key, actor_user_id, actor_snapshot, subject_type, subject_id, request_id)
     VALUES ('application_user.tested', $1,
             '{"displayName":"Migration Actor","preferredUsername":"migration.actor"}'::jsonb,
             'application_user', $2, 'migration-023-test')
     RETURNING id`,
    [actorUserId, String(actorUserId)]
  );
  await assert.rejects(
    pool.query('UPDATE audit_events SET details = $1::jsonb WHERE id = $2', [
      JSON.stringify({ changed: true }),
      event.rows[0].id,
    ]),
    /audit events are immutable/
  );
  await assert.rejects(
    pool.query('DELETE FROM audit_events WHERE id = $1', [event.rows[0].id]),
    /audit events are immutable/
  );
  await assert.rejects(
    pool.query('TRUNCATE audit_events'),
    /audit events are immutable/
  );
});

test('migration 024 preserves historical product attribution as null', async () => {
  const databaseName = 'amber_product_actor_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preAttributionDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-product-attribution-migrations-')
  );
  try {
    const migrationDirectory = path.resolve(serverRoot, 'migrations');
    const migrationFiles = (await fs.readdir(migrationDirectory))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('024_')
        && !fileName.startsWith('025_')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(migrationDirectory, fileName),
      path.resolve(preAttributionDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preAttributionDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const migrationPool = new Pool({ connectionString: databaseUrl });
    try {
      await migrationPool.query(
        "INSERT INTO categories (code, name, requires_weight) VALUES ('HA', 'Historical attribution', 0)"
      );
      const products = await migrationPool.query(`
        INSERT INTO products
          (full_sku, base_sku, sequence_number, category, weight, total_price,
           total_price_uah, price_per_gram, details, status)
        VALUES
          ('HA1001', 'HA1', 1, 'HA', 0, 25, 1000, 0, '{}'::jsonb, 'corrected'),
          ('HA2002', 'HA2', 2, 'HA', 0, 30, 1200, 0, '{}'::jsonb, 'active')
        RETURNING id, full_sku
      `);
      const bySku = Object.fromEntries(products.rows.map((row) => [row.full_sku, Number(row.id)]));
      await migrationPool.query(
        `INSERT INTO product_corrections
          (source_product_id, corrected_product_id, source_sku, corrected_sku,
           old_payload, new_payload, reason, price_delta_uah)
         VALUES ($1, $2, 'HA1001', 'HA2002', '{}'::jsonb, '{}'::jsonb, 'historical', 200)`,
        [bySku.HA1001, bySku.HA2002]
      );
    } finally {
      await migrationPool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      const columns = await verifiedPool.query(`
        SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('products', 'created_by_user_id'),
            ('products', 'archived_by_user_id'),
            ('product_corrections', 'performed_by_user_id')
          )
        ORDER BY table_name, column_name
      `);
      assert.deepEqual(columns.rows, [
        { table_name: 'product_corrections', column_name: 'performed_by_user_id', is_nullable: 'YES' },
        { table_name: 'products', column_name: 'archived_by_user_id', is_nullable: 'YES' },
        { table_name: 'products', column_name: 'created_by_user_id', is_nullable: 'YES' },
      ]);
      const foreignKeys = await verifiedPool.query(`
        SELECT tc.table_name, kcu.column_name, ccu.table_name AS referenced_table,
               rc.delete_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_schema = tc.constraint_schema
         AND kcu.constraint_name = tc.constraint_name
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_schema = tc.constraint_schema
         AND rc.constraint_name = tc.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_schema = rc.unique_constraint_schema
         AND ccu.constraint_name = rc.unique_constraint_name
        WHERE tc.constraint_schema = 'public'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name IN ('products', 'product_corrections')
          AND kcu.column_name IN (
            'created_by_user_id', 'archived_by_user_id', 'performed_by_user_id'
          )
        ORDER BY tc.table_name, kcu.column_name
      `);
      assert.deepEqual(foreignKeys.rows, [
        {
          table_name: 'product_corrections',
          column_name: 'performed_by_user_id',
          referenced_table: 'application_users',
          delete_rule: 'RESTRICT',
        },
        {
          table_name: 'products',
          column_name: 'archived_by_user_id',
          referenced_table: 'application_users',
          delete_rule: 'RESTRICT',
        },
        {
          table_name: 'products',
          column_name: 'created_by_user_id',
          referenced_table: 'application_users',
          delete_rule: 'RESTRICT',
        },
      ]);
      assert.deepEqual((await verifiedPool.query(`
        SELECT created_by_user_id, archived_by_user_id
        FROM products
        WHERE full_sku IN ('HA1001', 'HA2002')
        ORDER BY full_sku
      `)).rows, [
        { created_by_user_id: null, archived_by_user_id: null },
        { created_by_user_id: null, archived_by_user_id: null },
      ]);
      assert.deepEqual((await verifiedPool.query(`
        SELECT performed_by_user_id FROM product_corrections WHERE source_sku = 'HA1001'
      `)).rows, [{ performed_by_user_id: null }]);
      assert.equal(Number((await verifiedPool.query(
        "SELECT count(*) FROM audit_events WHERE event_key LIKE 'product.%'"
      )).rows[0].count), 0);
    } finally {
      await verifiedPool.end();
    }
  } finally {
    await fs.rm(preAttributionDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration 026 preserves historical repricing attribution as null without audit synthesis', async () => {
  const databaseName = 'amber_repricing_actor_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preAttributionDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-repricing-attribution-migrations-')
  );
  try {
    const migrationDirectory = path.resolve(serverRoot, 'migrations');
    const migrationFiles = (await fs.readdir(migrationDirectory))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(migrationDirectory, fileName),
      path.resolve(preAttributionDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preAttributionDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const migrationPool = new Pool({ connectionString: databaseUrl });
    let batchId;
    let draftId;
    try {
      const batch = await migrationPool.query(`
        INSERT INTO repricing_batches
          (scenario_name, preview_token, status, applied_at)
        VALUES ('Historical batch', 'historical-batch-token', 'completed', CURRENT_TIMESTAMP)
        RETURNING id
      `);
      batchId = Number(batch.rows[0].id);
      const draft = await migrationPool.query(`
        INSERT INTO repricing_drafts
          (category_code, scenario_name, preview_fingerprint, status, applied_batch_id,
           applied_at)
        VALUES ('HX', 'Historical draft', 'historical-draft-fingerprint', 'applied', $1,
                CURRENT_TIMESTAMP)
        RETURNING id
      `, [batchId]);
      draftId = Number(draft.rows[0].id);
    } finally {
      await migrationPool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      assert.deepEqual((await verifiedPool.query(`
        SELECT created_by_user_id, last_modified_by_user_id, discarded_by_user_id
        FROM repricing_drafts WHERE id = $1
      `, [draftId])).rows, [{
        created_by_user_id: null,
        last_modified_by_user_id: null,
        discarded_by_user_id: null,
      }]);
      assert.deepEqual((await verifiedPool.query(`
        SELECT applied_by_user_id, rolled_back_by_user_id
        FROM repricing_batches WHERE id = $1
      `, [batchId])).rows, [{
        applied_by_user_id: null,
        rolled_back_by_user_id: null,
      }]);
      assert.equal(Number((await verifiedPool.query(
        "SELECT count(*) FROM audit_events WHERE event_key LIKE 'repricing.%' OR event_key LIKE 'repricing_draft.%'"
      )).rows[0].count), 0);
    } finally {
      await verifiedPool.end();
    }
  } finally {
    await fs.rm(preAttributionDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration 027 preserves historical export and publication attribution as null', async () => {
  const databaseName = 'amber_export_schema_actor_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preAttributionDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-export-schema-attribution-migrations-')
  );
  try {
    const migrationDirectory = path.resolve(serverRoot, 'migrations');
    const migrationFiles = (await fs.readdir(migrationDirectory))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(migrationDirectory, fileName),
      path.resolve(preAttributionDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preAttributionDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const migrationPool = new Pool({ connectionString: databaseUrl });
    let snapshotId;
    let schemaVersionId;
    try {
      snapshotId = 'historical-export-snapshot';
      await migrationPool.query(`
        INSERT INTO export_snapshots
          (id, idempotency_key, from_sku, resolved_to_sku, exported_to_product_id,
           row_count, file_name, csv_content, status, confirmed_at)
        VALUES ($1, 'historical-export-key', 'HX1001', 'HX1001', 0,
                0, 'historical.csv', 'sku,price_uah', 'confirmed', CURRENT_TIMESTAMP)
      `, [snapshotId]);
      await migrationPool.query(
        "INSERT INTO categories (code, name, requires_weight) VALUES ('HX', 'Historical schema', 0)"
      );
      const schemaVersion = await migrationPool.query(`
        INSERT INTO sku_schema_versions
          (category_code, version, marker, status, config_hash)
        VALUES ('HX', 1, '', 'active', 'historical-schema-hash')
        RETURNING id
      `);
      schemaVersionId = Number(schemaVersion.rows[0].id);
    } finally {
      await migrationPool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      assert.deepEqual((await verifiedPool.query(`
        SELECT created_by_user_id, confirmed_by_user_id
        FROM export_snapshots WHERE id = $1
      `, [snapshotId])).rows, [{
        created_by_user_id: null,
        confirmed_by_user_id: null,
      }]);
      assert.deepEqual((await verifiedPool.query(`
        SELECT published_by_user_id FROM sku_schema_versions WHERE id = $1
      `, [schemaVersionId])).rows, [{ published_by_user_id: null }]);
      assert.equal(Number((await verifiedPool.query(`
        SELECT count(*) FROM audit_events
        WHERE event_key LIKE 'export_snapshot.%' OR event_key LIKE 'sku_schema.%'
      `)).rows[0].count), 0);
    } finally {
      await verifiedPool.end();
    }
  } finally {
    await fs.rm(preAttributionDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});
