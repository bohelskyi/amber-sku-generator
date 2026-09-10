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
  getApplicationAccess,
  resolveOrCreateApplicationUser,
  bootstrapAdministrator,
  runMigrations,
  request,
  schemas,
} = suite;

test('parallel replica bootstrap is idempotent through calibrated questions and SKU schemas', async () => {
  const databaseName = 'amber_startup_race_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const bootstrapSource = `
    const db = require('./src/db/pool');
    const { seedDefaultData } = require('./src/db/init-db');
    const { ensureLegacySkuSchemas } = require('./src/services/sku-schema.service');
    (async () => {
      try {
        await seedDefaultData();
        await ensureLegacySkuSchemas();
      } finally {
        await db.end();
      }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  try {
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    const bootstrapOutcomes = await Promise.allSettled(Array.from(
      { length: 4 },
      () => runNodeInDatabase(databaseUrl, bootstrapSource)
    ));
    const bootstrapFailures = bootstrapOutcomes
      .filter((outcome) => outcome.status === 'rejected')
      .map((outcome) => outcome.reason);
    if (bootstrapFailures.length > 0) {
      throw new AggregateError(bootstrapFailures, 'One or more replica bootstraps failed');
    }

    const replicaPool = new Pool({ connectionString: databaseUrl });
    try {
      const [categoryResult, duplicateQuestions, calibratedQuestions, schemaCounts] =
        await Promise.all([
          replicaPool.query('SELECT count(*)::int AS count FROM categories'),
          replicaPool.query(`
            SELECT category_code, key, count(*)::int AS count
            FROM questions
            GROUP BY category_code, key
            HAVING count(*) > 1
          `),
          replicaPool.query(`
            SELECT raw.category_code
            FROM questions raw
            LEFT JOIN questions calibrated
              ON calibrated.category_code = raw.category_code
             AND calibrated.key = 'is_calibrated'
            WHERE raw.key = 'raw_type'
            GROUP BY raw.category_code
            HAVING count(calibrated.id) <> 1
          `),
          replicaPool.query(`
            SELECT category_code, count(*)::int AS count
            FROM sku_schema_versions
            GROUP BY category_code
            HAVING count(*) <> 1
          `),
        ]);
      assert.ok(Number(categoryResult.rows[0].count) > 0);
      assert.deepEqual(duplicateQuestions.rows, []);
      assert.deepEqual(calibratedQuestions.rows, []);
      assert.deepEqual(schemaCounts.rows, []);
    } finally {
      await replicaPool.end();
    }
  } finally {
    await dropTestDatabase(databaseName);
  }
});

test('calibrated-question seeding rolls back a partial failure and succeeds on retry', async () => {
  const databaseName = 'amber_seed_failure_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const seedPool = new Pool({ connectionString: databaseUrl });
  try {
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    const rawQuestion = await seedPool.query(
      `INSERT INTO categories (code, name, requires_weight) VALUES ('QQ', 'Seed retry', 0);
       INSERT INTO questions
       (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
       VALUES ('QQ', 'raw_type', 'Raw type', 1, 1, 1, 1, 'options')
       RETURNING id`
    );
    await seedPool.query(
      `INSERT INTO options (question_id, value_id, sku_code, label)
       VALUES ($1, 1, '1', 'Natural')`,
      [rawQuestion[1].rows[0].id]
    );
    await seedPool.query(`
      CREATE OR REPLACE FUNCTION fail_calibrated_option_seed()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM questions q
          WHERE q.id = NEW.question_id
            AND q.category_code = 'QQ'
            AND q.key = 'is_calibrated'
        ) THEN
          RAISE EXCEPTION 'seed option failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_calibrated_option_seed
      BEFORE INSERT ON options
      FOR EACH ROW EXECUTE FUNCTION fail_calibrated_option_seed();
    `);
    const seedSource = `
      const db = require('./src/db/pool');
      const { seedDefaultData } = require('./src/db/init-db');
      seedDefaultData()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    await assert.rejects(runNodeInDatabase(databaseUrl, seedSource));
    const afterFailure = await seedPool.query(
      `SELECT count(*)::int AS count FROM questions
       WHERE category_code = 'QQ' AND key = 'is_calibrated'`
    );
    assert.equal(afterFailure.rows[0].count, 0);

    await seedPool.query('DROP TRIGGER fail_calibrated_option_seed ON options');
    await seedPool.query('DROP FUNCTION fail_calibrated_option_seed()');
    await runNodeInDatabase(databaseUrl, seedSource);
    const afterRetry = await seedPool.query(
      `SELECT count(DISTINCT q.id)::int AS questions, count(o.id)::int AS options
       FROM questions q
       LEFT JOIN options o ON o.question_id = q.id
       WHERE q.category_code = 'QQ' AND q.key = 'is_calibrated'`
    );
    assert.equal(afterRetry.rows[0].questions, 1);
    assert.equal(afterRetry.rows[0].options, 3);
  } finally {
    await seedPool.end();
    await dropTestDatabase(databaseName);
  }
});

test('migrations ignore request query timeouts for legitimate long DDL', async () => {
  const databaseName = 'amber_migration_timeout_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const migrationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-migrations-'));
  try {
    await fs.writeFile(
      path.join(migrationDirectory, '001_slow.sql'),
      'SELECT pg_sleep(0.2); CREATE TABLE slow_migration_completed (id INTEGER PRIMARY KEY);\n'
    );
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(migrationDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `, {
      PG_QUERY_TIMEOUT_MS: '50',
      PG_STATEMENT_TIMEOUT_MS: '50',
    });
    const migrationPool = new Pool({ connectionString: databaseUrl });
    try {
      const result = await migrationPool.query(
        "SELECT to_regclass('public.slow_migration_completed') AS table_name"
      );
      assert.equal(result.rows[0].table_name, 'slow_migration_completed');
    } finally {
      await migrationPool.end();
    }
  } finally {
    await fs.rm(migrationDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration failure rolls back only the failing file and leaves it unapplied', async () => {
  const databaseName = 'amber_migration_failure_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const migrationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-failing-migrations-'));
  try {
    await fs.writeFile(
      path.join(migrationDirectory, '001_success.sql'),
      'CREATE TABLE successful_migration (id INTEGER PRIMARY KEY);\n'
    );
    await fs.writeFile(
      path.join(migrationDirectory, '002_failure.sql'),
      'CREATE TABLE rolled_back_migration (id INTEGER); SELECT * FROM table_that_does_not_exist;\n'
    );
    await assert.rejects(runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(migrationDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `));

    const migrationPool = new Pool({ connectionString: databaseUrl });
    try {
      const state = await migrationPool.query(`
        SELECT to_regclass('public.successful_migration') AS successful,
               to_regclass('public.rolled_back_migration') AS rolled_back,
               array_agg(name ORDER BY name) AS applied
        FROM schema_migrations
      `);
      assert.equal(state.rows[0].successful, 'successful_migration');
      assert.equal(state.rows[0].rolled_back, null);
      assert.deepEqual(state.rows[0].applied, ['001_success.sql']);
    } finally {
      await migrationPool.end();
    }
  } finally {
    await fs.rm(migrationDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration 023 rolls back its audit schema and permission grant together', async () => {
  const databaseName = 'amber_audit_migration_rollback_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preAuditDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-audit-migrations-')
  );
  const failingAuditDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-failing-audit-migration-')
  );
  try {
    const migrationDirectory = path.resolve(serverRoot, 'migrations');
    const migrationFiles = (await fs.readdir(migrationDirectory))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('023_')
        && !fileName.startsWith('024_')
        && !fileName.startsWith('025_')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(migrationDirectory, fileName),
      path.resolve(preAuditDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preAuditDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const auditSql = await fs.readFile(
      path.resolve(migrationDirectory, '023_audit_events.sql'),
      'utf8'
    );
    await fs.writeFile(
      path.resolve(failingAuditDirectory, '023_audit_events.sql'),
      `${auditSql}\nSELECT * FROM forced_missing_audit_migration_table;\n`
    );
    await assert.rejects(runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(failingAuditDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `));

    const migrationPool = new Pool({ connectionString: databaseUrl });
    try {
      const state = await migrationPool.query(`
        SELECT to_regclass('public.audit_events') AS audit_events,
               to_regprocedure('public.protect_audit_event_immutability()') AS audit_function,
               (SELECT count(*)::int FROM permissions WHERE permission_key = 'audit.view')
                 AS permission_count,
               (SELECT count(*)::int FROM schema_migrations
                WHERE name = '023_audit_events.sql') AS migration_count
      `);
      assert.deepEqual(state.rows, [{
        audit_events: null,
        audit_function: null,
        permission_count: 0,
        migration_count: 0,
      }]);
    } finally {
      await migrationPool.end();
    }
  } finally {
    await fs.rm(preAuditDirectory, { recursive: true, force: true });
    await fs.rm(failingAuditDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration checksums are stable across LF and CRLF but reject SQL changes', async () => {
  const databaseName = 'amber_migration_checksum_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const migrationDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-checksum-migrations-')
  );
  const migrationPath = path.join(migrationDirectory, '001_checksum.sql');
  const lfSql = 'CREATE TABLE migration_checksum_probe (\n  id INTEGER PRIMARY KEY\n);\n';
  const runMigrationSource = `
    const db = require('./src/db/pool');
    const { runMigrations } = require('./src/db/run-migrations');
    runMigrations({ directory: ${JSON.stringify(migrationDirectory)} })
      .finally(() => db.end())
      .catch((error) => { console.error(error); process.exitCode = 1; });
  `;

  try {
    await fs.writeFile(migrationPath, lfSql);
    await runNodeInDatabase(databaseUrl, runMigrationSource);

    const checksumPool = new Pool({ connectionString: databaseUrl });
    let linuxChecksum;
    try {
      const stored = await checksumPool.query(
        "SELECT checksum FROM schema_migrations WHERE name = '001_checksum.sql'"
      );
      linuxChecksum = stored.rows[0].checksum;
    } finally {
      await checksumPool.end();
    }

    await fs.writeFile(migrationPath, lfSql.replace(/\n/g, '\r\n'));
    await runNodeInDatabase(databaseUrl, runMigrationSource);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      const stored = await verifiedPool.query(
        "SELECT checksum FROM schema_migrations WHERE name = '001_checksum.sql'"
      );
      assert.equal(stored.rows[0].checksum, linuxChecksum);
    } finally {
      await verifiedPool.end();
    }

    const changedSql = lfSql.replace('INTEGER', 'BIGINT').replace(/\n/g, '\r\n');
    await fs.writeFile(migrationPath, changedSql);
    await assert.rejects(
      runNodeInDatabase(databaseUrl, runMigrationSource),
      (error) => {
        assert.match(String(error.stderr || error.message), /Migration checksum mismatch: 001_checksum\.sql/);
        return true;
      }
    );
  } finally {
    await fs.rm(migrationDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('fresh, pre-checksum, and checkpoint upgrade paths produce equivalent database topology', async () => {
  const freshName = 'amber_fresh_schema_test';
  const upgradeName = 'amber_upgrade_schema_test';
  const checkpointName = 'amber_checkpoint_schema_test';
  const freshUrl = await recreateTestDatabase(freshName);
  const upgradeUrl = await recreateTestDatabase(upgradeName);
  const checkpointUrl = await recreateTestDatabase(checkpointName);
  const oldMigrationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-old-migrations-'));
  const checkpointMigrationDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-checkpoint-migrations-')
  );
  try {
    const allMigrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => fileName.endsWith('.sql'));
    const migrationFiles = allMigrationFiles
      .filter((fileName) => /^(00[1-9]|010|011)_/.test(fileName));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(serverRoot, 'migrations', fileName),
      path.resolve(oldMigrationDirectory, fileName)
    )));
    await Promise.all(allMigrationFiles
      .filter((fileName) => (
         !fileName.startsWith('015_')
         && !fileName.startsWith('016_')
         && !fileName.startsWith('017_')
         && !fileName.startsWith('018_')
         && !fileName.startsWith('019_')
         && !fileName.startsWith('020_')
         && !fileName.startsWith('021_')
         && !fileName.startsWith('022_')
         && !fileName.startsWith('023_')
         && !fileName.startsWith('024_')
         && !fileName.startsWith('025_')
         && !fileName.startsWith('026_')
         && !fileName.startsWith('027_')
         && !fileName.startsWith('028_')
      ))
      .map((fileName) => fs.copyFile(
        path.resolve(serverRoot, 'migrations', fileName),
        path.resolve(checkpointMigrationDirectory, fileName)
      )));

    await runNodeInDatabase(freshUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      (async () => {
        await runMigrations();
        await runMigrations();
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    await runNodeInDatabase(upgradeUrl, `
      const db = require('./src/db/pool');
      const { legacyInitDb } = require('./src/db/init-db');
      const { runMigrations } = require('./src/db/run-migrations');
      const { ensureLegacySkuSchemas } = require('./src/services/sku-schema.service');
      (async () => {
        await legacyInitDb();
        await runMigrations({ directory: ${JSON.stringify(oldMigrationDirectory)} });
        await db.query('UPDATE schema_migrations SET checksum = NULL');
        await ensureLegacySkuSchemas();
        await runMigrations();
        await runMigrations();
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    await runNodeInDatabase(checkpointUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      (async () => {
        await runMigrations({ directory: ${JSON.stringify(checkpointMigrationDirectory)} });
        await runMigrations();
        await runMigrations();
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const topologyQueries = [
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
              numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, column_name`,
      `SELECT c.conrelid::regclass::text AS table_name, c.conname,
              pg_get_constraintdef(c.oid) AS definition, c.convalidated
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public'
       ORDER BY table_name, c.conname`,
      `SELECT tablename, indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
       ORDER BY tablename, indexname`,
    ];
    const freshPool = new Pool({ connectionString: freshUrl });
    const upgradePool = new Pool({ connectionString: upgradeUrl });
    const checkpointPool = new Pool({ connectionString: checkpointUrl });
    try {
      for (const query of topologyQueries) {
        const [fresh, upgraded, checkpoint] = await Promise.all([
          freshPool.query(query),
          upgradePool.query(query),
          checkpointPool.query(query),
        ]);
        assert.deepEqual(upgraded.rows, fresh.rows);
        assert.deepEqual(checkpoint.rows, fresh.rows);
      }
      const checksums = await upgradePool.query(
        'SELECT count(*)::int AS count FROM schema_migrations WHERE checksum IS NULL'
      );
      assert.equal(checksums.rows[0].count, 0);
      const checkpointMigration = await checkpointPool.query(
        "SELECT count(*)::int AS count FROM schema_migrations WHERE name ~ '^(015|016|017|018|019|020|021|022|023|024)_'"
      );
      assert.equal(checkpointMigration.rows[0].count, 10);
    } finally {
      await freshPool.end();
      await upgradePool.end();
      await checkpointPool.end();
    }
  } finally {
    await fs.rm(oldMigrationDirectory, { recursive: true, force: true });
    await fs.rm(checkpointMigrationDirectory, { recursive: true, force: true });
    await dropTestDatabase(freshName);
    await dropTestDatabase(upgradeName);
    await dropTestDatabase(checkpointName);
  }
});

test('migrations 020-024 upgrade a database at migration 019 and repeated startup stays safe', async () => {
  const databaseName = 'amber_rbac_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preRbacDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-pre-rbac-migrations-'));
  try {
    const migrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('020_')
        && !fileName.startsWith('021_')
        && !fileName.startsWith('022_')
        && !fileName.startsWith('023_')
        && !fileName.startsWith('024_')
        && !fileName.startsWith('025_')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(serverRoot, 'migrations', fileName),
      path.resolve(preRbacDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      (async () => {
        await runMigrations({ directory: ${JSON.stringify(preRbacDirectory)} });
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    const upgradePool = new Pool({ connectionString: databaseUrl });
    try {
      assert.equal(
        (await upgradePool.query("SELECT to_regclass('public.application_users') AS name"))
          .rows[0].name,
        null
      );
      assert.equal(
        (await upgradePool.query(
          "SELECT count(*)::int AS count FROM schema_migrations WHERE name = '019_postgres_session_store.sql'"
        )).rows[0].count,
        1
      );
    } finally {
      await upgradePool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      (async () => {
        await runMigrations();
        await runMigrations();
        const counts = await db.query(
          'SELECT (SELECT count(*) FROM permissions)::int AS permissions, '
            + '(SELECT count(*) FROM roles)::int AS roles, '
            + '(SELECT count(*) FROM role_permissions)::int AS mappings'
        );
        if (counts.rows[0].permissions !== 26
            || counts.rows[0].roles !== 3
            || counts.rows[0].mappings !== 50) {
          throw new Error('Unexpected RBAC seed counts: ' + JSON.stringify(counts.rows[0]));
        }
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
  } finally {
    await fs.rm(preRbacDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration 021 adds business capabilities and corrects built-in mappings on migration 020', async () => {
  const databaseName = 'amber_permission_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const prePermissionDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-permission-migrations-')
  );
  try {
    const migrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('021_')
        && !fileName.startsWith('022_')
        && !fileName.startsWith('023_')
        && !fileName.startsWith('024_')
        && !fileName.startsWith('025_')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(serverRoot, 'migrations', fileName),
      path.resolve(prePermissionDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(prePermissionDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const upgradePool = new Pool({ connectionString: databaseUrl });
    try {
      const before = await upgradePool.query(`
        SELECT r.role_key, rp.permission_key
        FROM roles r
        JOIN role_permissions rp ON rp.role_id = r.id
        WHERE (r.role_key = 'storekeeper' AND rp.permission_key = 'products.archive')
           OR rp.permission_key IN ('products.recount', 'exports.view')
      `);
      assert.deepEqual(before.rows, []);
    } finally {
      await upgradePool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      (async () => {
        await runMigrations();
        await runMigrations();
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      const after = await verifiedPool.query(`
        SELECT r.role_key, ARRAY_AGG(rp.permission_key ORDER BY rp.permission_key) AS permission_keys
        FROM roles r
        JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.role_key IN ('administrator', 'manager', 'storekeeper')
        GROUP BY r.id
        ORDER BY r.role_key
      `);
      const byRole = Object.fromEntries(after.rows.map((row) => [row.role_key, row.permission_keys]));
      assert.equal(byRole.administrator.includes('exports.view'), true);
      assert.equal(byRole.administrator.includes('products.recount'), true);
      assert.equal(byRole.manager.includes('exports.view'), true);
      assert.equal(byRole.manager.includes('products.archive'), false);
      assert.equal(byRole.manager.includes('products.recount'), false);
      assert.equal(byRole.storekeeper.includes('exports.view'), true);
      assert.equal(byRole.storekeeper.includes('products.archive'), true);
      assert.equal(byRole.storekeeper.includes('products.recount'), true);
    } finally {
      await verifiedPool.end();
    }
  } finally {
    await fs.rm(prePermissionDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration 022 removes Manager correction processing without changing other built-in roles', async () => {
  const databaseName = 'amber_manager_correction_permissions_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preManagerPermissionDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-manager-permission-migrations-')
  );
  try {
    const migrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('022_')
        && !fileName.startsWith('023_')
        && !fileName.startsWith('024_')
        && !fileName.startsWith('025_')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(serverRoot, 'migrations', fileName),
      path.resolve(preManagerPermissionDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preManagerPermissionDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const upgradePool = new Pool({ connectionString: databaseUrl });
    try {
      const before = await upgradePool.query(`
        SELECT r.role_key, ARRAY_AGG(rp.permission_key ORDER BY rp.permission_key) AS permission_keys
        FROM roles r
        JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.role_key IN ('administrator', 'manager', 'storekeeper')
        GROUP BY r.id
        ORDER BY r.role_key
      `);
      const byRole = Object.fromEntries(before.rows.map((row) => [row.role_key, row.permission_keys]));
      assert.equal(byRole.manager.includes('corrections.claim'), true);
      assert.equal(byRole.manager.includes('corrections.complete'), true);
      assert.equal(byRole.administrator.includes('corrections.claim'), true);
      assert.equal(byRole.storekeeper.includes('corrections.complete'), true);
    } finally {
      await upgradePool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      (async () => {
        await runMigrations();
        await runMigrations();
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      const after = await verifiedPool.query(`
        SELECT r.role_key, ARRAY_AGG(rp.permission_key ORDER BY rp.permission_key) AS permission_keys
        FROM roles r
        JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.role_key IN ('administrator', 'manager', 'storekeeper')
        GROUP BY r.id
        ORDER BY r.role_key
      `);
      const byRole = Object.fromEntries(after.rows.map((row) => [row.role_key, row.permission_keys]));
      assert.equal(byRole.manager.includes('corrections.claim'), false);
      assert.equal(byRole.manager.includes('corrections.complete'), false);
      assert.equal(byRole.manager.includes('corrections.create'), true);
      assert.equal(byRole.manager.includes('corrections.reject'), true);
      assert.equal(byRole.administrator.includes('corrections.claim'), true);
      assert.equal(byRole.administrator.includes('corrections.complete'), true);
      assert.equal(byRole.storekeeper.includes('corrections.claim'), true);
      assert.equal(byRole.storekeeper.includes('corrections.complete'), true);
    } finally {
      await verifiedPool.end();
    }
  } finally {
    await fs.rm(preManagerPermissionDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('first-Administrator bootstrap is verified, transactional, concurrent-safe, and permanently one-use', async () => {
  const databaseName = 'amber_bootstrap_admin_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  await runNodeInDatabase(databaseUrl, `
    const db = require('./src/db/pool');
    const { runMigrations } = require('./src/db/run-migrations');
    runMigrations()
      .finally(() => db.end())
      .catch((error) => { console.error(error); process.exitCode = 1; });
  `);
  const bootstrapPool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const unlinked = await bootstrapPool.query(
      "INSERT INTO application_users (status) VALUES ('pending') RETURNING id"
    );
    await assert.rejects(
      bootstrapAdministrator(Number(unlinked.rows[0].id), { databasePool: bootstrapPool }),
      /no verified external identity/
    );

    const pendingUser = await resolveOrCreateApplicationUser({
      issuer: 'https://bootstrap.example/realms/amber',
      sub: 'first-administrator',
      preferred_username: 'first.admin',
      name: 'First Administrator',
      authenticatedAt: '2026-09-09T12:00:00.000Z',
    }, { databasePool: bootstrapPool });
    const attempts = await Promise.allSettled([
      bootstrapAdministrator(pendingUser.id, { databasePool: bootstrapPool }),
      bootstrapAdministrator(pendingUser.id, { databasePool: bootstrapPool }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
    assert.match(
      attempts.find((attempt) => attempt.status === 'rejected').reason.message,
      /already been completed permanently/
    );

    const access = await getApplicationAccess({
      issuer: 'https://bootstrap.example/realms/amber',
      sub: 'first-administrator',
      authenticatedAt: '2026-09-09T12:00:00.000Z',
    }, { databasePool: bootstrapPool });
    assert.equal(access.applicationUser.status, 'active');
    assert.equal(access.roles.length, 1);
    assert.equal(access.roles[0].key, 'administrator');
    assert.equal(access.roles[0].displayName, 'Administrator');
    assert.equal(Number.isSafeInteger(access.roles[0].id), true);
    assert.equal(access.permissions.length, 26);
    const state = await bootstrapPool.query(
      `SELECT administrator_user_id, completed_at IS NOT NULL AS completed
       FROM security_bootstrap_state WHERE singleton = TRUE`
    );
    assert.equal(Number(state.rows[0].administrator_user_id), pendingUser.id);
    assert.equal(state.rows[0].completed, true);
    await assert.rejects(
      bootstrapAdministrator(pendingUser.id, { databasePool: bootstrapPool }),
      /already been completed permanently/
    );
  } finally {
    await bootstrapPool.end();
    await dropTestDatabase(databaseName);
  }
});

test('legacy in-progress correction requests survive through migration 025 without false ownership', async () => {
  const databaseName = 'amber_legacy_claim_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preClaimDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-claim-migrations-')
  );
  try {
    const migrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('018_')
        && !fileName.startsWith('020_')
        && !fileName.startsWith('021_')
        && !fileName.startsWith('022_')
        && !fileName.startsWith('023_')
        && !fileName.startsWith('024_')
        && !fileName.startsWith('025_')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(serverRoot, 'migrations', fileName),
      path.resolve(preClaimDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preClaimDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const legacyPool = new Pool({ connectionString: databaseUrl });
    let legacyRequestId;
    try {
      await legacyPool.query(
        "INSERT INTO categories (code, name, requires_weight) VALUES ('CL', 'Claim legacy', 0)"
      );
      const question = await legacyPool.query(`
        INSERT INTO questions
          (category_code, key, label, sku_index, display_order, required,
           include_in_sku, input_type)
        VALUES ('CL', 'kind', 'Kind', 1, 1, 1, 1, 'options')
        RETURNING id
      `);
      await legacyPool.query(
        `INSERT INTO options (question_id, value_id, sku_code, label)
         VALUES ($1, 1, '1', 'One'), ($1, 2, '2', 'Two')`,
        [question.rows[0].id]
      );
      const scenario = await legacyPool.query(`
        INSERT INTO price_scenarios
          (category_code, name, match_json, axis_x_key, price_mode, status)
        VALUES ('CL', 'Claim prices', '{}'::jsonb, 'kind', 'fixed_uah', 'active')
        RETURNING id
      `);
      await legacyPool.query(
        `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
         VALUES ($1, 1, 0, 100), ($1, 2, 0, 200)`,
        [scenario.rows[0].id]
      );
      const products = await legacyPool.query(`
        INSERT INTO products
          (full_sku, base_sku, sequence_number, category, weight, total_price,
           total_price_uah, price_per_gram, details, status)
        VALUES
          ('CL1001', 'CL1', 1, 'CL', 0, 100, 100, 0,
           '{"answers":{"kind":1},"isCalibrated":0}'::jsonb, 'active'),
          ('CL1002', 'CL1', 2, 'CL', 0, 100, 100, 0,
           '{"answers":{"kind":1},"isCalibrated":0}'::jsonb, 'active')
        RETURNING id, full_sku
      `);
      await runNodeInDatabase(databaseUrl, `
        const db = require('./src/db/pool');
        const { ensureLegacySkuSchemas } = require('./src/services/sku-schema.service');
        ensureLegacySkuSchemas()
          .finally(() => db.end())
          .catch((error) => { console.error(error); process.exitCode = 1; });
      `);
      const firstProduct = products.rows.find((row) => row.full_sku === 'CL1001');
      const inserted = await legacyPool.query(
        `INSERT INTO correction_requests
          (source_product_id, category_code, source_sku, proposed_sku, old_payload,
           proposed_payload, changes, status, preview_signature)
         VALUES ($1, 'CL', 'CL1001', 'CL2001', '{}'::jsonb,
                 '{"answers":{"kind":2}}'::jsonb,
                 '[]'::jsonb, 'in_progress', 'legacy-signature')
         RETURNING id`,
        [firstProduct.id]
      );
      legacyRequestId = Number(inserted.rows[0].id);
    } finally {
      await legacyPool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const assert = require('node:assert/strict');
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      const { claimCorrectionRequest } = require('./src/services/correction-request.service');
      (async () => {
        await runMigrations();
        const actor = await db.query(
          "INSERT INTO application_users (status, display_name, preferred_username) "
            + "VALUES ('active', 'Legacy Claim Actor', 'legacy.claim.actor') RETURNING id"
        );
        const mutationContext = {
          actorUserId: Number(actor.rows[0].id),
          requestId: 'legacy-unowned-claim',
        };
        const before = await db.query(
          'SELECT status, claim_token_hash, claimed_at, created_by_user_id, '
            + 'claimed_by_user_id, claim_version '
            + 'FROM correction_requests WHERE id = $1',
          [${legacyRequestId}]
        );
        assert.deepEqual(before.rows[0], {
          status: 'in_progress', claim_token_hash: null, claimed_at: null,
          created_by_user_id: null, claimed_by_user_id: null, claim_version: '0',
        });
        const claimed = await claimCorrectionRequest(${legacyRequestId}, { mutationContext });
        assert.equal(claimed.request.status, 'in_progress');
        assert.equal(claimed.request.claimVersion, 1);
        assert.equal(Object.hasOwn(claimed, 'claimToken'), false);
        await assert.rejects(
          claimCorrectionRequest(${legacyRequestId}, { mutationContext }),
          /інший працівник/
        );
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const upgradedPool = new Pool({ connectionString: databaseUrl });
    try {
      const claimed = await upgradedPool.query(
        `SELECT status, claim_token_hash, claimed_at, claimed_by_user_id, claim_version
         FROM correction_requests WHERE id = $1`,
        [legacyRequestId]
      );
      assert.equal(claimed.rows[0].status, 'in_progress');
      assert.equal(claimed.rows[0].claim_token_hash, null);
      assert.ok(claimed.rows[0].claimed_by_user_id);
      assert.equal(Number(claimed.rows[0].claim_version), 1);
      assert.ok(claimed.rows[0].claimed_at);
      const secondProduct = await upgradedPool.query(
        "SELECT id FROM products WHERE full_sku = 'CL1002'"
      );
      await assert.rejects(
        upgradedPool.query(
          `INSERT INTO correction_requests
            (source_product_id, category_code, source_sku, proposed_sku, old_payload,
             proposed_payload, changes, status, preview_signature)
           VALUES ($1, 'CL', 'CL1002', 'CL2002', '{}'::jsonb, '{}'::jsonb,
                   '[]'::jsonb, 'in_progress', 'new-invalid-signature')`,
          [secondProduct.rows[0].id]
        ),
        (error) => error.code === '23514'
      );
    } finally {
      await upgradedPool.end();
    }
  } finally {
    await fs.rm(preClaimDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('legacy zero prices upgrade without repricing products or blocking edits', async () => {
  const databaseName = 'amber_legacy_zero_price_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preCompatibilityDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-zero-compat-migrations-')
  );
  try {
    const migrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => fileName.endsWith('.sql') && !/^(014|015|016)_/.test(fileName));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(serverRoot, 'migrations', fileName),
      path.resolve(preCompatibilityDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preCompatibilityDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const legacyPool = new Pool({ connectionString: databaseUrl });
    try {
      await legacyPool.query(`
        INSERT INTO categories (code, name, requires_weight)
        VALUES ('LX', 'Legacy zero', 0);

        WITH inserted_question AS (
          INSERT INTO questions
            (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
          VALUES ('LX', 'kind', 'Kind', 1, 1, 1, 1, 'options')
          RETURNING id
        )
        INSERT INTO options (question_id, value_id, sku_code, label)
        SELECT id, 1, '1', 'One' FROM inserted_question
        UNION ALL
        SELECT id, 2, '2', 'Two' FROM inserted_question;

        WITH inserted_scenario AS (
          INSERT INTO price_scenarios
            (category_code, name, match_json, axis_x_key, axis_y_key, price_mode, status)
          VALUES ('LX', 'Current automatic price', '{}'::jsonb, 'kind', NULL, 'fixed_uah', 'active')
          RETURNING id
        )
        INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
        SELECT id, 1, 0, 1000 FROM inserted_scenario
        UNION ALL
        SELECT id, 2, 0, 0 FROM inserted_scenario;

        INSERT INTO products
          (full_sku, base_sku, sequence_number, category, weight, total_price,
           total_price_uah, price_per_gram, details)
        VALUES
          ('LX1001', 'LX1', 1, 'LX', 0, 0, 0, 0, '{"answers":{"kind":1}}'::jsonb);
      `);
    } finally {
      await legacyPool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const assert = require('node:assert/strict');
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      const { ensureLegacySkuSchemas } = require('./src/services/sku-schema.service');
      const { applyProductRecount, decodeSku } = require('./src/services/product.service');
      (async () => {
        await runMigrations();
        await ensureLegacySkuSchemas();

        const decoded = await decodeSku('LX1001');
        assert.equal(decoded.pricing.totalPriceUah, 0);
        assert.equal(decoded.pricing.calculatedPriceUah, null);

        const actor = await db.query(
          "INSERT INTO application_users (status, display_name, preferred_username) "
            + "VALUES ('active', 'Legacy Recount Actor', 'legacy.recount.actor') RETURNING id"
        );

        const correction = await applyProductRecount({
          sourceSku: 'LX1001',
          answers: { kind: 2 },
          reason: 'still editable',
          manualPriceUah: 500,
        }, {
          mutationContext: {
            actorUserId: Number(actor.rows[0].id),
            requestId: 'legacy-zero-recount',
          },
        });
        assert.equal(correction.success, true);
        assert.equal(correction.corrected.totalPriceUah, 500);
        await assert.rejects(
          db.query(
            "INSERT INTO products "
              + "(full_sku, base_sku, sequence_number, category, total_price_uah, details) "
              + "VALUES ('LX1999', 'LX1', 999, 'LX', 0, '{}'::jsonb)"
          ),
          (error) => error.code === '23514'
        );
      })()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      const state = await verifiedPool.query(`
        SELECT p.total_price_uah, p.legacy_uah_price_unset,
               p.correction_reason, p.sku_schema_version_id, p.corrected_to_product_id,
               corrected.total_price_uah AS corrected_price_uah,
               (SELECT count(*)::int FROM price_matrix WHERE price = 0) AS zero_matrix_rows,
               (SELECT count(*)::int FROM price_matrix WHERE price = 1000) AS positive_matrix_rows
        FROM products p
        LEFT JOIN products corrected ON corrected.id = p.corrected_to_product_id
        WHERE p.full_sku = 'LX1001'
      `);
      assert.equal(Number(state.rows[0].total_price_uah), 0);
      assert.equal(state.rows[0].legacy_uah_price_unset, true);
      assert.equal(state.rows[0].correction_reason, 'still editable');
      assert.ok(Number(state.rows[0].sku_schema_version_id) > 0);
      assert.ok(Number(state.rows[0].corrected_to_product_id) > 0);
      assert.equal(Number(state.rows[0].corrected_price_uah), 500);
      assert.equal(state.rows[0].zero_matrix_rows, 0);
      assert.equal(state.rows[0].positive_matrix_rows, 1);
    } finally {
      await verifiedPool.end();
    }
  } finally {
    await fs.rm(preCompatibilityDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});
