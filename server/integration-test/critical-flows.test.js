const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NBU_RATE_OVERRIDE = '40';

const pool = require('../src/db/pool');
const app = require('../src/app');
const { runMigrations } = require('../src/db/run-migrations');
const { seedDefaultData } = require('../src/db/init-db');
const { ensureLegacySkuSchemas } = require('../src/services/sku-schema.service');
const { saveLastKnownRate } = require('../src/services/currency.service');

let server;
let baseUrl;
const schemas = {};
let primarySku;
const serverRoot = path.resolve(__dirname, '..');

function databaseUrlFor(databaseName) {
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error(`Unsafe test database name: ${databaseName}`);
  }
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function recreateTestDatabase(databaseName) {
  await pool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await pool.query(`CREATE DATABASE ${databaseName}`);
  return databaseUrlFor(databaseName);
}

async function dropTestDatabase(databaseName) {
  await pool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
}

async function runNodeInDatabase(databaseUrl, source, extraEnv = {}) {
  return execFileAsync(process.execPath, ['-e', source], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      NBU_RATE_OVERRIDE: '40',
      ...extraEnv,
    },
  });
}

async function request(url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { response, data, text };
}

async function createFixtureCategory(code, requiresWeight, withPrices) {
  await pool.query(
    `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
     VALUES ($1, $2, $3, 0)`,
    [code, `Test ${code}`, requiresWeight ? 1 : 0]
  );
  const question = await pool.query(
    `INSERT INTO questions
     (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
     VALUES ($1, 'kind', 'Kind', 1, 1, 1, 1, 'options') RETURNING id`,
    [code]
  );
  await pool.query(
    `INSERT INTO options (question_id, value_id, sku_code, label)
     VALUES ($1, 1, '1', 'One'), ($1, 2, '2', 'Two')`,
    [question.rows[0].id]
  );
  if (withPrices) {
    const scenario = await pool.query(
      `INSERT INTO price_scenarios
       (category_code, name, match_json, axis_x_key, axis_y_key, price_mode, status)
       VALUES ($1, 'Test fixed', '{}'::jsonb, 'kind', NULL, 'fixed_uah', 'active')
       RETURNING id`,
      [code]
    );
    await pool.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       VALUES ($1, 1, 0, 1000), ($1, 2, 0, 1500)`,
      [scenario.rows[0].id]
    );
    return Number(scenario.rows[0].id);
  }
  return null;
}

async function createLegacySemiCalibratedNecklaceFixture() {
  await pool.query(
    `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
     VALUES ('LN', 'Legacy necklace', 1, 0)`
  );
  const questions = await pool.query(`
    INSERT INTO questions
      (category_code, key, label, sku_index, display_order, required,
       include_in_sku, input_type, visible_if_json)
    VALUES
      ('LN', 'raw_type', 'Тип сировини', 1, 1, 1, 1, 'options', NULL),
      ('LN', 'size', 'Розмір', 2, 2, 1, 1, 'options', '{"is_calibrated":[0,1]}'::jsonb),
      ('LN', 'shape', 'Форма', 3, 3, 1, 1, 'options', NULL),
      ('LN', 'is_calibrated', 'Калібрування', 0, 4, 1, 0, 'options', NULL)
    RETURNING id, key
  `);
  const questionIds = Object.fromEntries(
    questions.rows.map((question) => [question.key, Number(question.id)])
  );
  await pool.query(
    `INSERT INTO options (question_id, value_id, sku_code, label)
     VALUES
       ($1, 1, '1', 'Натуральне'),
       ($2, 1, '1', '40 см'),
       ($3, 6, '6', 'Кругла'),
       ($3, 7, '7', 'Овальна'),
       ($4, 0, '0', 'Некаліброване'),
       ($4, 1, '1', 'Каліброване'),
       ($4, 2, '2', 'Напівкаліброване')`,
    [
      questionIds.raw_type,
      questionIds.size,
      questionIds.shape,
      questionIds.is_calibrated,
    ]
  );
  const scenario = await pool.query(
    `INSERT INTO price_scenarios
       (category_code, name, match_json, axis_x_key, axis_y_key, price_mode, status)
     VALUES
       ('LN', 'Напівкаліброване намисто', '{"is_calibrated":2}'::jsonb,
        'shape', NULL, 'per_gram_usd', 'active')
     RETURNING id`
  );
  await pool.query(
    `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
     VALUES ($1, 6, 0, 4.5), ($1, 7, 0, 5)`,
    [scenario.rows[0].id]
  );
}

test.before(async () => {
  const database = await pool.query('SELECT current_database() AS name');
  if (!String(database.rows[0].name).endsWith('_test')) {
    throw new Error(`Refusing destructive integration setup for ${database.rows[0].name}`);
  }
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations();
  await seedDefaultData();
  schemas.ZZScenario = await createFixtureCategory('ZZ', false, true);
  await createFixtureCategory('MM', false, false);
  await createFixtureCategory('WW', true, false);
  await createLegacySemiCalibratedNecklaceFixture();
  await ensureLegacySkuSchemas();
  for (const code of ['ZZ', 'MM', 'WW', 'LN']) {
    const result = await pool.query(
      `SELECT id FROM sku_schema_versions WHERE category_code = $1 AND status = 'active'`,
      [code]
    );
    schemas[code] = Number(result.rows[0].id);
  }
  await pool.query(
    `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price,
        total_price_uah, price_per_gram, uah_rate, details, sku_schema_version_id)
     VALUES
       ('LN106020', 'LN106', 20, 'LN', 20.3, 91.35, 3654, 4.5, 40,
        '{"answers":{"raw_type":1,"shape":6,"is_calibrated":2},"isCalibrated":2}'::jsonb,
        $1)`,
    [schemas.LN]
  );
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('health endpoints report liveness and DB readiness', async () => {
  assert.equal((await request('/health/live')).response.status, 200);
  assert.equal((await request('/health/ready')).response.status, 200);
});

test('legacy hidden size placeholder remains recountable without weakening new-product validation', async () => {
  const decoded = await request('/api/decode', {
    method: 'POST',
    body: { sku: 'LN106020' },
  });
  assert.equal(decoded.response.status, 200, decoded.text);
  assert.equal(decoded.data.existsInDb, true);
  const decodedSize = decoded.data.decodedAnswers.find((answer) => answer.key === 'size');
  assert.deepEqual(
    { valueId: decodedSize.value_id, isPlaceholder: decodedSize.is_placeholder },
    { valueId: null, isPlaceholder: true }
  );

  const correctionPayload = {
    sourceSku: 'LN106020',
    answers: { shape: 7 },
    isCalibrated: 2,
    reason: 'legacy hidden size compatibility',
  };
  const preview = await request('/api/recount/preview', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(preview.data.corrected.fullSku, 'LN107020');
  assert.equal(Object.hasOwn(preview.data.corrected.answers, 'size'), false);

  const applied = await request('/api/recount/apply', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(applied.response.status, 200, applied.text);
  const correctedState = await pool.query(
    `SELECT source.status AS source_status, corrected.full_sku,
            corrected.total_price_uah, corrected.details->'answers' AS answers
     FROM products source
     JOIN products corrected ON corrected.id = source.corrected_to_product_id
     WHERE source.full_sku = 'LN106020'`
  );
  assert.equal(correctedState.rows[0].source_status, 'corrected');
  assert.equal(correctedState.rows[0].full_sku, 'LN107020');
  assert.ok(Number(correctedState.rows[0].total_price_uah) > 0);
  assert.equal(Object.hasOwn(correctedState.rows[0].answers, 'size'), false);

  const hiddenZeroOnNewProduct = await request('/api/preview', {
    method: 'POST',
    body: {
      categoryCode: 'LN',
      answers: { raw_type: 1, size: 0, shape: 6, is_calibrated: 2 },
      weight: 20.3,
      isCalibrated: 2,
    },
  });
  assert.equal(hiddenZeroOnNewProduct.response.status, 422, hiddenZeroOnNewProduct.text);
  assert.match(hiddenZeroOnNewProduct.data.error, /Розмір/);

  const visibleInvalid = await request('/api/preview', {
    method: 'POST',
    body: {
      categoryCode: 'LN',
      answers: { raw_type: 1, size: 0, shape: 6, is_calibrated: 1 },
      weight: 20.3,
      isCalibrated: 1,
    },
  });
  assert.equal(visibleInvalid.response.status, 422, visibleInvalid.text);
  assert.match(visibleInvalid.data.error, /Розмір/);
});

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
      .filter((fileName) => !fileName.startsWith('015_') && !fileName.startsWith('016_'))
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
        "SELECT count(*)::int AS count FROM schema_migrations WHERE name ~ '^(015|016)_'"
      );
      assert.equal(checkpointMigration.rows[0].count, 2);
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

        const correction = await applyProductRecount({
          sourceSku: 'LX1001',
          answers: { kind: 2 },
          reason: 'still editable',
          manualPriceUah: 500,
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

test('duplicate question invariant is atomic across independent transactions', async () => {
  const questionKey = `concurrent_question_${Date.now()}`;
  const worker = async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO questions
         (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
         VALUES ('ZZ', $1, 'Concurrent', 99, 99, 0, 0, 'text')`,
        [questionKey]
      );
      await client.query('SELECT pg_sleep(0.15)');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const outcomes = await Promise.allSettled([worker(), worker()]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, '23505');
  const stored = await pool.query(
    'SELECT count(*)::int AS count FROM questions WHERE category_code = $1 AND key = $2',
    ['ZZ', questionKey]
  );
  assert.equal(stored.rows[0].count, 1);
});

test('price-cell API stores only positive prices and treats empty or missing price as deletion', async () => {
  const cell = {
    scenario_id: schemas.ZZScenario,
    x_val: 999,
    y_val: 0,
  };
  const readCell = () => pool.query(
    `SELECT price FROM price_matrix
     WHERE scenario_id = $1 AND x_val = $2 AND y_val = $3`,
    [cell.scenario_id, cell.x_val, cell.y_val]
  );

  try {
    const created = await request('/api/admin/price-cell', {
      method: 'POST',
      body: { ...cell, price: '12.50' },
    });
    assert.equal(created.response.status, 200, created.text);
    assert.equal(Number((await readCell()).rows[0].price), 12.5);

    const zero = await request('/api/admin/price-cell', {
      method: 'POST',
      body: { ...cell, price: 0 },
    });
    assert.equal(zero.response.status, 400, zero.text);
    assert.match(zero.data.error, /більшим за 0/);
    assert.equal(Number((await readCell()).rows[0].price), 12.5);

    const blank = await request('/api/admin/price-cell', {
      method: 'POST',
      body: { ...cell, price: '   ' },
    });
    assert.equal(blank.response.status, 200, blank.text);
    assert.equal((await readCell()).rows.length, 0);

    await request('/api/admin/price-cell', {
      method: 'POST',
      body: { ...cell, price: 8 },
    });
    const missing = await request('/api/admin/price-cell', {
      method: 'POST',
      body: cell,
    });
    assert.equal(missing.response.status, 200, missing.text);
    assert.equal((await readCell()).rows.length, 0);
  } finally {
    await pool.query(
      `DELETE FROM price_matrix
       WHERE scenario_id = $1 AND x_val = $2 AND y_val = $3`,
      [cell.scenario_id, cell.x_val, cell.y_val]
    );
  }
});

test('preview/save are authoritative and concurrent sequences are unique', async () => {
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0 },
  });
  assert.equal(preview.response.status, 200);
  const payload = {
    category: 'ZZ',
    answers: { kind: 1 },
    weight: 0,
    skuSchemaVersionId: schemas.ZZ,
    previewToken: preview.data.previewToken,
    fullSku: 'ATTACKER-SKU',
    totalPriceUah: 1,
    baseSku: 'WRONG',
  };
  const saved = await request('/api/save', { method: 'POST', body: payload });
  assert.equal(saved.response.status, 200, saved.text);
  primarySku = saved.data.fullSku;
  assert.notEqual(primarySku, 'ATTACKER-SKU');
  const stored = await pool.query(
    'SELECT full_sku, base_sku, total_price_uah FROM products WHERE id = $1',
    [saved.data.id]
  );
  assert.equal(Number(stored.rows[0].total_price_uah), 1000);
  assert.equal(stored.rows[0].base_sku, preview.data.baseSku);

  const concurrent = await Promise.all([
    request('/api/save', { method: 'POST', body: payload }),
    request('/api/save', { method: 'POST', body: payload }),
  ]);
  assert.deepEqual(concurrent.map((item) => item.response.status), [200, 200]);
  assert.equal(new Set(concurrent.map((item) => item.data.fullSku)).size, 2);
  const concurrentStored = await pool.query(
    `SELECT full_sku, sequence_number
     FROM products
     WHERE full_sku = ANY($1::text[])
     ORDER BY sequence_number`,
    [concurrent.map((item) => item.data.fullSku)]
  );
  assert.equal(concurrentStored.rows.length, 2);
  assert.equal(new Set(concurrentStored.rows.map((row) => Number(row.sequence_number))).size, 2);
});

test('save rejects a preview after authoritative pricing changes', async () => {
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 2 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(preview.response.status, 200, preview.text);
  const countBefore = await pool.query(
    `SELECT count(*)::int AS count FROM products
     WHERE category = 'ZZ' AND details->'answers'->>'kind' = '2'`
  );
  try {
    const changedMatrix = await pool.query(
      'UPDATE price_matrix SET price = price + 25 WHERE scenario_id = $1 AND x_val = 2',
      [schemas.ZZScenario]
    );
    assert.equal(changedMatrix.rowCount, 1);
    const changedPreview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 2 }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(changedPreview.response.status, 200, changedPreview.text);
    assert.notEqual(changedPreview.data.previewToken, preview.data.previewToken);
    const staleSave = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind: 2 },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: preview.data.previewToken,
      },
    });
    assert.equal(staleSave.response.status, 409, staleSave.text);
    const countAfter = await pool.query(
      `SELECT count(*)::int AS count FROM products
       WHERE category = 'ZZ' AND details->'answers'->>'kind' = '2'`
    );
    assert.equal(countAfter.rows[0].count, countBefore.rows[0].count);
  } finally {
    await pool.query(
      'UPDATE price_matrix SET price = price - 25 WHERE scenario_id = $1 AND x_val = 2',
      [schemas.ZZScenario]
    );
  }
});

test('required answers, weight, schema ownership, and manual fallback fail closed', async () => {
  const missing = await request('/api/preview', {
    method: 'POST', body: { categoryCode: 'ZZ', answers: {}, weight: 0 },
  });
  assert.equal(missing.response.status, 422);
  const weight = await request('/api/preview', {
    method: 'POST', body: { categoryCode: 'WW', answers: { kind: 1 }, weight: 0 },
  });
  assert.equal(weight.response.status, 422);
  const wrongSchema = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      skuSchemaVersionId: schemas.ZZ, previewToken: 'wrong', manualPriceUah: 200,
    },
  });
  assert.equal(wrongSchema.response.status, 422);

  const noPricePreview = await request('/api/preview', {
    method: 'POST',
    body: {
      categoryCode: 'MM', answers: { kind: 1 }, weight: 0, isCalibrated: 0,
    },
  });
  assert.equal(noPricePreview.response.status, 200, noPricePreview.text);

  const legacyPayload = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      skuSchemaVersionId: schemas.MM, manualPriceUah: 321,
    },
  });
  assert.equal(legacyPayload.response.status, 422);
  assert.match(legacyPayload.data.error, /previewToken/);

  const noAuto = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      isCalibrated: null,
      skuSchemaVersionId: schemas.MM, previewToken: noPricePreview.data.previewToken,
    },
  });
  assert.equal(noAuto.response.status, 422);
  assert.match(noAuto.data.error, /Вкажіть ціну вручну/);
  const zeroManual = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      isCalibrated: null,
      skuSchemaVersionId: schemas.MM, previewToken: noPricePreview.data.previewToken,
      manualPriceUah: 0,
    },
  });
  assert.equal(zeroManual.response.status, 422);
  assert.match(zeroManual.data.error, /більшою за 0/);
  const manual = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      isCalibrated: null,
      skuSchemaVersionId: schemas.MM, previewToken: noPricePreview.data.previewToken,
      manualPriceUah: 321,
    },
  });
  assert.equal(manual.response.status, 200, manual.text);
  const stored = await pool.query('SELECT total_price_uah FROM products WHERE id = $1', [manual.data.id]);
  assert.equal(Number(stored.rows[0].total_price_uah), 321);

  const malformedPreview = await request('/api/preview', {
    method: 'POST', body: { categoryCode: 'MM', answers: { kind: 2 }, weight: 0 },
  });
  const malformedManual = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 2 }, weight: 0,
      skuSchemaVersionId: schemas.MM, previewToken: malformedPreview.data.previewToken,
      manualPriceUah: true,
    },
  });
  assert.equal(malformedManual.response.status, 422);
});

test('correction applies a manual price when the target configuration has no matrix cell', async () => {
  const sourcePreview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(sourcePreview.response.status, 200, sourcePreview.text);
  const source = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: sourcePreview.data.previewToken,
    },
  });
  assert.equal(source.response.status, 200, source.text);

  const removedCell = await pool.query(
    'DELETE FROM price_matrix WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0 RETURNING price',
    [schemas.ZZScenario]
  );
  assert.equal(removedCell.rowCount, 1);
  try {
    const preview = await request('/api/recount/preview', {
      method: 'POST',
      body: { sourceSku: source.data.fullSku, answers: { kind: 2 }, reason: 'manual correction' },
    });
    assert.equal(preview.response.status, 200, preview.text);
    assert.equal(preview.data.corrected.totalPriceUah, null);

    const zeroManual = await request('/api/recount/apply', {
      method: 'POST',
      body: {
        sourceSku: source.data.fullSku,
        answers: { kind: 2 },
        reason: 'manual correction',
        manualPriceUah: 0,
      },
    });
    assert.equal(zeroManual.response.status, 422, zeroManual.text);
    assert.match(zeroManual.data.error, /більшою за 0/);

    const applied = await request('/api/recount/apply', {
      method: 'POST',
      body: {
        sourceSku: source.data.fullSku,
        answers: { kind: 2 },
        reason: 'manual correction',
        manualPriceUah: 725,
      },
    });
    assert.equal(applied.response.status, 200, applied.text);
    assert.equal(applied.data.corrected.manualPriceUah, 725);
    const stored = await pool.query(
      'SELECT total_price_uah FROM products WHERE id = $1',
      [applied.data.correctedProductId]
    );
    assert.equal(Number(stored.rows[0].total_price_uah), 725);
  } finally {
    await pool.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       VALUES ($1, 2, 0, $2)
       ON CONFLICT (scenario_id, x_val, y_val) DO UPDATE SET price = EXCLUDED.price`,
      [schemas.ZZScenario, removedCell.rows[0].price]
    );
  }
});

test('exchange-rate cache never lets an older replica overwrite a newer fetch', async () => {
  const olderFetchedAt = '2026-08-30T10:00:00.000Z';
  const newerFetchedAt = '2026-08-31T10:00:00.000Z';
  await pool.query("DELETE FROM exchange_rate_cache WHERE currency_pair = 'USD_UAH'");
  await pool.query(`
    CREATE OR REPLACE FUNCTION delay_older_exchange_rate_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.fetched_at = TIMESTAMPTZ '2026-08-30 10:00:00+00' THEN
        PERFORM pg_sleep(0.2);
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER delay_older_exchange_rate_write
    BEFORE INSERT OR UPDATE ON exchange_rate_cache
    FOR EACH ROW EXECUTE FUNCTION delay_older_exchange_rate_write();
  `);
  try {
    const olderWrite = saveLastKnownRate({
      rate: 40,
      rateDate: '2026-08-30',
      fetchedAt: olderFetchedAt,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const newerWrite = saveLastKnownRate({
      rate: 41,
      rateDate: '2026-08-31',
      fetchedAt: newerFetchedAt,
    });
    await Promise.all([olderWrite, newerWrite]);
    const stored = await pool.query(
      "SELECT rate, fetched_at FROM exchange_rate_cache WHERE currency_pair = 'USD_UAH'"
    );
    assert.equal(Number(stored.rows[0].rate), 41);
    assert.equal(new Date(stored.rows[0].fetched_at).toISOString(), newerFetchedAt);
  } finally {
    await pool.query('DROP TRIGGER delay_older_exchange_rate_write ON exchange_rate_cache');
    await pool.query('DROP FUNCTION delay_older_exchange_rate_write()');
  }
});

test('used category code is immutable while metadata remains editable', async () => {
  const changedCode = await request('/api/admin/category', {
    method: 'PUT',
    body: { code: 'ZZ', next_code: 'ZX', name: 'Renamed', requires_weight: 0 },
  });
  assert.equal(changedCode.response.status, 409);
  const metadata = await request('/api/admin/category', {
    method: 'PUT',
    body: { code: 'ZZ', next_code: 'ZZ', name: 'Renamed', requires_weight: 0 },
  });
  assert.equal(metadata.response.status, 200, metadata.text);
});

test('concurrent correction only applies once after transactional revalidation', async () => {
  const correctionPayload = { sourceSku: primarySku, answers: { kind: 2 }, reason: 'integration' };
  const preview = await request('/api/recount/preview', { method: 'POST', body: correctionPayload });
  assert.equal(preview.response.status, 200, preview.text);
  const results = await Promise.all([
    request('/api/recount/apply', { method: 'POST', body: correctionPayload }),
    request('/api/recount/apply', { method: 'POST', body: correctionPayload }),
  ]);
  assert.deepEqual(results.map((item) => item.response.status).sort(), [200, 409]);
  const sourceState = await pool.query(
    `SELECT id, status, corrected_to_product_id
     FROM products WHERE full_sku = $1`,
    [primarySku]
  );
  assert.equal(sourceState.rows[0].status, 'corrected');
  assert.ok(Number(sourceState.rows[0].corrected_to_product_id) > 0);
  const correctionState = await pool.query(
    `SELECT count(*)::int AS correction_count,
            count(DISTINCT corrected_product_id)::int AS corrected_products
     FROM product_corrections
     WHERE source_product_id = $1`,
    [sourceState.rows[0].id]
  );
  assert.deepEqual(correctionState.rows[0], {
    correction_count: 1,
    corrected_products: 1,
  });
});

test('correction requests reject stale product state, refresh, and complete atomically', async () => {
  const candidate = await pool.query(
    `SELECT id, full_sku
     FROM products
     WHERE category = 'ZZ'
       AND status = 'active'
       AND details->'answers'->>'kind' = '1'
     ORDER BY id
     LIMIT 1`
  );
  assert.ok(candidate.rows[0]);
  const created = await request('/api/admin/correction-requests', {
    method: 'POST',
    body: {
      sourceSku: candidate.rows[0].full_sku,
      answers: { kind: 2 },
      reason: 'stale request integration',
    },
  });
  assert.equal(created.response.status, 200, created.text);
  const requestId = Number(created.data.request.id);

  await pool.query(
    'UPDATE products SET total_price_uah = total_price_uah + 1 WHERE id = $1',
    [candidate.rows[0].id]
  );
  const staleCompletion = await request(
    `/api/admin/correction-requests/${requestId}/complete`,
    { method: 'POST', body: {} }
  );
  assert.equal(staleCompletion.response.status, 409);
  const unchanged = await pool.query(
    `SELECT status, corrected_to_product_id,
            (SELECT status FROM correction_requests WHERE id = $1) AS request_status
     FROM products WHERE id = $2`,
    [requestId, candidate.rows[0].id]
  );
  assert.deepEqual(unchanged.rows[0], {
    status: 'active',
    corrected_to_product_id: null,
    request_status: 'pending',
  });

  const refreshed = await request(
    `/api/admin/correction-requests/${requestId}/refresh`,
    { method: 'POST', body: {} }
  );
  assert.equal(refreshed.response.status, 200, refreshed.text);
  const completed = await request(
    `/api/admin/correction-requests/${requestId}/complete`,
    { method: 'POST', body: {} }
  );
  assert.equal(completed.response.status, 200, completed.text);
  const finalState = await pool.query(
    `SELECT p.status, p.corrected_to_product_id, cr.status AS request_status,
            cr.corrected_product_id
     FROM products p
     JOIN correction_requests cr ON cr.id = $1
     WHERE p.id = $2`,
    [requestId, candidate.rows[0].id]
  );
  assert.equal(finalState.rows[0].status, 'corrected');
  assert.equal(finalState.rows[0].request_status, 'completed');
  assert.equal(
    Number(finalState.rows[0].corrected_to_product_id),
    Number(finalState.rows[0].corrected_product_id)
  );
});

test('repricing preview/apply/rollback and correction blocking work', async () => {
  await pool.query(
    'UPDATE price_matrix SET price = price + 100 WHERE scenario_id = $1',
    [schemas.ZZScenario]
  );
  const preview = await request('/api/admin/repricing/preview', {
    method: 'POST', body: { scenarioId: schemas.ZZScenario },
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.ok(preview.data.summary.changedCount > 0);
  const applied = await request('/api/admin/repricing/apply', {
    method: 'POST',
    body: { scenarioId: schemas.ZZScenario, previewToken: preview.data.previewToken },
  });
  assert.equal(applied.response.status, 200, applied.text);
  const batchId = applied.data.batch?.id || applied.data.batchId;
  const appliedItems = await pool.query(
    `SELECT ri.product_id, ri.old_price_uah, ri.new_price_uah,
            p.total_price_uah, p.details #>> '{repricing,batchId}' AS current_batch_id
     FROM repricing_items ri
     JOIN products p ON p.id = ri.product_id
     WHERE ri.batch_id = $1
     ORDER BY ri.product_id`,
    [batchId]
  );
  assert.ok(appliedItems.rows.length > 0);
  for (const item of appliedItems.rows) {
    assert.equal(Number(item.total_price_uah), Number(item.new_price_uah));
    assert.equal(Number(item.current_batch_id), Number(batchId));
  }
  const rolledBack = await request(`/api/admin/repricing/${batchId}/rollback`, {
    method: 'POST', body: {},
  });
  assert.equal(rolledBack.response.status, 200, rolledBack.text);
  const rolledBackItems = await pool.query(
    `SELECT ri.product_id, ri.old_price_uah, p.total_price_uah,
            p.details #>> '{repricing,batchId}' AS current_batch_id
     FROM repricing_items ri
     JOIN products p ON p.id = ri.product_id
     WHERE ri.batch_id = $1
     ORDER BY ri.product_id`,
    [batchId]
  );
  for (const item of rolledBackItems.rows) {
    assert.equal(Number(item.total_price_uah), Number(item.old_price_uah));
    assert.notEqual(Number(item.current_batch_id || 0), Number(batchId));
  }

  const candidate = await pool.query(
    `SELECT full_sku FROM products
     WHERE category = 'ZZ' AND status = 'active' AND details->'answers'->>'kind' = '1'
     ORDER BY id DESC LIMIT 1`
  );
  await pool.query(
    'UPDATE price_matrix SET price = price + 50 WHERE scenario_id = $1',
    [schemas.ZZScenario]
  );
  const racePreview = await request('/api/admin/repricing/preview', {
    method: 'POST', body: { scenarioId: schemas.ZZScenario },
  });
  const lockClient = await pool.connect();
  await lockClient.query('BEGIN');
  await lockClient.query('SELECT id FROM products WHERE full_sku = $1 FOR UPDATE', [
    candidate.rows[0].full_sku,
  ]);
  const correctionPromise = request('/api/recount/apply', {
      method: 'POST',
      body: { sourceSku: candidate.rows[0].full_sku, answers: { kind: 2 }, reason: 'race repricing' },
  });
  const repricingPromise = request('/api/admin/repricing/apply', {
      method: 'POST',
      body: { scenarioId: schemas.ZZScenario, previewToken: racePreview.data.previewToken },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await lockClient.query('COMMIT');
  lockClient.release();
  const raceResults = await Promise.all([correctionPromise, repricingPromise]);
  assert.deepEqual(raceResults.map((item) => item.response.status).sort(), [200, 409]);
});

test('repricing keeps manual-priced products editable across consecutive cycles', async () => {
  const createProduct = async (kind) => {
    const preview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const saved = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: preview.data.previewToken,
      },
    });
    assert.equal(saved.response.status, 200, saved.text);
    return {
      ...saved.data,
      currentPriceUah: Number(preview.data.totalPriceUah),
    };
  };

  const keepCurrentProduct = await createProduct(2);
  const newManualProduct = await createProduct(2);
  const automaticProduct = await createProduct(1);
  const appliedBatchIds = [];

  const removedCell = await pool.query(
    `DELETE FROM price_matrix
     WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0
     RETURNING price`,
    [schemas.ZZScenario]
  );
  assert.equal(removedCell.rowCount, 1);
  await pool.query(
    'UPDATE price_matrix SET price = price + 100 WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0',
    [schemas.ZZScenario]
  );

  try {
    const preview = await request('/api/admin/repricing/preview', {
      method: 'POST', body: { scenarioId: schemas.ZZScenario },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const missingItems = preview.data.items.filter((item) => item.errorCode === 'price_missing');
    const missingProductIds = new Set(missingItems.map((item) => Number(item.productId)));
    assert.equal(missingProductIds.has(Number(keepCurrentProduct.id)), true);
    assert.equal(missingProductIds.has(Number(newManualProduct.id)), true);
    assert.equal(preview.data.summary.errorCount, missingItems.length);
    assert.ok(preview.data.summary.changedCount > 0);

    const unresolved = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: { scenarioId: schemas.ZZScenario, previewToken: preview.data.previewToken },
    });
    assert.equal(unresolved.response.status, 422, unresolved.text);

    const manualOverrides = missingItems.map((item) => ({
      productId: Number(item.productId),
      newPriceUah: Number(item.productId) === Number(newManualProduct.id)
        ? 1750
        : Number(item.oldPriceUah),
    }));
    const invalidOverrides = manualOverrides.map((override) => (
      Number(override.productId) === Number(keepCurrentProduct.id)
        ? { ...override, newPriceUah: 0 }
        : override
    ));
    const invalid = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        previewToken: preview.data.previewToken,
        manualOverrides: invalidOverrides,
      },
    });
    assert.equal(invalid.response.status, 422, invalid.text);

    const draft = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        manualOverrides,
        reviewedProductIds: [],
        uiState: {},
      },
    });
    assert.equal(draft.response.status, 200, draft.text);
    assert.deepEqual(draft.data.manualOverrides, manualOverrides);

    const applied = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        previewToken: preview.data.previewToken,
        manualOverrides,
        draftId: draft.data.draft.id,
      },
    });
    assert.equal(applied.response.status, 200, applied.text);
    appliedBatchIds.push(Number(applied.data.batch.id));

    const stored = await pool.query(
      `SELECT id, total_price_uah, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [[keepCurrentProduct.id, newManualProduct.id, automaticProduct.id]]
    );
    const storedById = new Map(stored.rows.map((row) => [Number(row.id), row]));
    const kept = storedById.get(Number(keepCurrentProduct.id));
    const changed = storedById.get(Number(newManualProduct.id));
    const automatic = storedById.get(Number(automaticProduct.id));
    assert.equal(Number(kept.total_price_uah), keepCurrentProduct.currentPriceUah);
    assert.equal(Number(kept.details.manualPriceUah), keepCurrentProduct.currentPriceUah);
    assert.equal(kept.details.autoPriceUah, null);
    assert.equal(kept.details.repricing.manualOverride, true);
    assert.equal(kept.details.repricing.calculatedPriceUah, null);
    assert.equal(Number(changed.total_price_uah), 1750);
    assert.equal(Number(changed.details.manualPriceUah), 1750);
    assert.equal(changed.details.autoPriceUah, null);
    assert.equal(changed.details.repricing.manualOverride, true);
    assert.equal(
      Number(automatic.total_price_uah),
      automaticProduct.currentPriceUah + 100
    );
    assert.equal(
      Number(automatic.details.autoPriceUah),
      automaticProduct.currentPriceUah + 100
    );
    assert.equal(automatic.details.manualPriceUah, null);
    assert.equal(automatic.details.repricing.manualOverride, false);

    const secondPreview = await request('/api/admin/repricing/preview', {
      method: 'POST', body: { scenarioId: schemas.ZZScenario },
    });
    assert.equal(secondPreview.response.status, 200, secondPreview.text);
    const manualItems = secondPreview.data.items.filter(
      (item) => item.errorCode === 'manual_price'
    );
    const repeatedManualItem = manualItems.find(
      (item) => Number(item.productId) === Number(newManualProduct.id)
    );
    assert.ok(repeatedManualItem, 'the manually-priced product must remain in the next preview');
    assert.equal(Number(repeatedManualItem.oldPriceUah), 1750);

    const secondManualOverrides = manualItems.map((item) => ({
      productId: Number(item.productId),
      newPriceUah: Number(item.productId) === Number(newManualProduct.id)
        ? 1850
        : Number(item.oldPriceUah),
    }));
    const secondDraft = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        manualOverrides: secondManualOverrides,
        reviewedProductIds: [],
        uiState: {},
      },
    });
    assert.equal(secondDraft.response.status, 200, secondDraft.text);

    const secondApplied = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        previewToken: secondPreview.data.previewToken,
        manualOverrides: secondManualOverrides,
        draftId: secondDraft.data.draft.id,
      },
    });
    assert.equal(secondApplied.response.status, 200, secondApplied.text);
    appliedBatchIds.push(Number(secondApplied.data.batch.id));

    const storedAfterSecondCycle = await pool.query(
      `SELECT total_price_uah, details
       FROM products WHERE id = $1`,
      [newManualProduct.id]
    );
    assert.equal(Number(storedAfterSecondCycle.rows[0].total_price_uah), 1850);
    assert.equal(Number(storedAfterSecondCycle.rows[0].details.manualPriceUah), 1850);
    assert.equal(storedAfterSecondCycle.rows[0].details.autoPriceUah, null);
    assert.equal(storedAfterSecondCycle.rows[0].details.repricing.manualOverride, true);
  } finally {
    for (const appliedBatchId of [...appliedBatchIds].reverse()) {
      const rollback = await request(`/api/admin/repricing/${appliedBatchId}/rollback`, {
        method: 'POST', body: {},
      });
      assert.equal(rollback.response.status, 200, rollback.text);
    }
    await pool.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       VALUES ($1, 2, 0, $2)
       ON CONFLICT (scenario_id, x_val, y_val) DO UPDATE SET price = EXCLUDED.price`,
      [schemas.ZZScenario, removedCell.rows[0].price]
    );
    await pool.query(
      'UPDATE price_matrix SET price = price - 100 WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0',
      [schemas.ZZScenario]
    );
  }
});

test('repricing rolls back every product and batch row after a mid-apply failure', async () => {
  await pool.query(
    'UPDATE price_matrix SET price = price + 30 WHERE scenario_id = $1',
    [schemas.ZZScenario]
  );
  try {
    const preview = await request('/api/admin/repricing/preview', {
      method: 'POST', body: { scenarioId: schemas.ZZScenario },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const changedItems = preview.data.items.filter((item) => item.status === 'changed');
    assert.ok(changedItems.length >= 2);
    const productIds = changedItems.map((item) => Number(item.productId));
    const before = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [productIds]
    );
    const failureProductId = productIds[1];
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_repricing_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = ${failureProductId}
           AND NEW.details #>> '{repricing,batchId}'
               IS DISTINCT FROM OLD.details #>> '{repricing,batchId}' THEN
          RAISE EXCEPTION 'forced repricing failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_test_repricing_update
      BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION fail_test_repricing_update();
    `);
    try {
      const failed = await request('/api/admin/repricing/apply', {
        method: 'POST',
        body: { scenarioId: schemas.ZZScenario, previewToken: preview.data.previewToken },
      });
      assert.equal(failed.response.status, 500);
    } finally {
      await pool.query('DROP TRIGGER fail_test_repricing_update ON products');
      await pool.query('DROP FUNCTION fail_test_repricing_update()');
    }
    const after = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [productIds]
    );
    assert.deepEqual(after.rows, before.rows);
    const persisted = await pool.query(
      `SELECT count(*)::int AS batches
       FROM repricing_batches
       WHERE preview_token = $1 AND status = 'completed'`,
      [preview.data.previewToken]
    );
    assert.equal(persisted.rows[0].batches, 0);
  } finally {
    await pool.query(
      'UPDATE price_matrix SET price = price - 30 WHERE scenario_id = $1',
      [schemas.ZZScenario]
    );
  }
});

test('export snapshot is immutable, idempotent, and cursor is monotonic', async () => {
  const legacyBypass = await request(`/api/export/csv?fromSku=${encodeURIComponent(primarySku)}`);
  assert.equal(legacyBypass.response.status, 410);
  const first = await request('/api/export/snapshots', {
    method: 'POST', body: { fromSku: primarySku }, headers: { 'Idempotency-Key': 'integration-export-1' },
  });
  assert.equal(first.response.status, 201, first.text);
  const repeated = await request('/api/export/snapshots', {
    method: 'POST', body: { fromSku: primarySku }, headers: { 'Idempotency-Key': 'integration-export-1' },
  });
  assert.equal(repeated.data.id, first.data.id);
  const mismatched = await request('/api/export/snapshots', {
    method: 'POST',
    body: { fromSku: primarySku, toSku: primarySku },
    headers: { 'Idempotency-Key': 'integration-export-1' },
  });
  assert.equal(mismatched.response.status, 409);
  const csv = await request(`/api/export/snapshots/${first.data.id}/csv`);
  assert.equal(csv.response.status, 200);
  assert.match(csv.text, /^sku,price_uah/);
  assert.equal((await request(`/api/export/snapshots/${first.data.id}/confirm`, { method: 'POST', body: {} })).response.status, 200);
  const cursorBefore = Number((await pool.query('SELECT exported_to_product_id FROM export_state')).rows[0].exported_to_product_id);

  const historical = await request('/api/export/snapshots', {
    method: 'POST',
    body: { fromSku: primarySku, toSku: primarySku },
    headers: { 'Idempotency-Key': 'integration-export-old' },
  });
  await request(`/api/export/snapshots/${historical.data.id}/confirm`, { method: 'POST', body: {} });
  const cursorAfter = Number((await pool.query('SELECT exported_to_product_id FROM export_state')).rows[0].exported_to_product_id);
  assert.equal(cursorAfter, cursorBefore);

  await pool.query(
    `UPDATE export_state
     SET exported_to_product_id = 0, last_snapshot_id = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE singleton = TRUE`
  );
  const concurrentConfirmations = await Promise.all([
    request(`/api/export/snapshots/${historical.data.id}/confirm`, { method: 'POST', body: {} }),
    request(`/api/export/snapshots/${first.data.id}/confirm`, { method: 'POST', body: {} }),
  ]);
  assert.deepEqual(concurrentConfirmations.map((result) => result.response.status), [200, 200]);
  const concurrentCursor = await pool.query(
    `SELECT st.exported_to_product_id, st.last_snapshot_id,
            GREATEST(old.exported_to_product_id, latest.exported_to_product_id) AS expected_cursor,
            CASE
              WHEN latest.exported_to_product_id >= old.exported_to_product_id THEN latest.id
              ELSE old.id
            END AS expected_snapshot_id
     FROM export_state st
     JOIN export_snapshots old ON old.id = $1
     JOIN export_snapshots latest ON latest.id = $2
     WHERE st.singleton = TRUE`,
    [historical.data.id, first.data.id]
  );
  assert.equal(
    Number(concurrentCursor.rows[0].exported_to_product_id),
    Number(concurrentCursor.rows[0].expected_cursor)
  );
  assert.equal(
    concurrentCursor.rows[0].last_snapshot_id,
    concurrentCursor.rows[0].expected_snapshot_id
  );
  await assert.rejects(
    pool.query("UPDATE export_snapshots SET csv_content = 'changed' WHERE id = $1", [first.data.id]),
    /immutable/
  );

  const endpoints = (await pool.query(
    `SELECT full_sku FROM products
     WHERE full_sku IS NOT NULL
     ORDER BY id
     LIMIT 2`
  )).rows.map((row) => row.full_sku);
  assert.equal(endpoints.length, 2);
  await pool.query(`
    CREATE OR REPLACE FUNCTION delay_test_export_snapshot_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_sleep(0.2);
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER delay_test_export_snapshot_insert
    BEFORE INSERT ON export_snapshots
    FOR EACH ROW EXECUTE FUNCTION delay_test_export_snapshot_insert();
  `);
  try {
    const concurrentKey = 'integration-export-conflict';
    const concurrent = await Promise.all([
      request('/api/export/snapshots', {
        method: 'POST',
        body: { fromSku: endpoints[0], toSku: endpoints[0] },
        headers: { 'Idempotency-Key': concurrentKey },
      }),
      request('/api/export/snapshots', {
        method: 'POST',
        body: { fromSku: endpoints[1], toSku: endpoints[1] },
        headers: { 'Idempotency-Key': concurrentKey },
      }),
    ]);
    assert.deepEqual(
      concurrent.map((result) => result.response.status).sort(),
      [201, 409]
    );
    const storedConflict = await pool.query(
      `SELECT count(*)::int AS count
       FROM export_snapshots
       WHERE idempotency_key = $1`,
      [concurrentKey]
    );
    assert.equal(storedConflict.rows[0].count, 1);
  } finally {
    await pool.query('DROP TRIGGER delay_test_export_snapshot_insert ON export_snapshots');
    await pool.query('DROP FUNCTION delay_test_export_snapshot_insert()');
  }
});

function sqliteRun(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
}

test('SQLite import targets current schema and refuses implicit replacement', async () => {
  const importDbName = 'amber_import_test';
  const adminUrl = new URL(TEST_DATABASE_URL);
  const importUrl = new URL(TEST_DATABASE_URL);
  importUrl.pathname = `/${importDbName}`;
  await pool.query(`DROP DATABASE IF EXISTS ${importDbName} WITH (FORCE)`);
  await pool.query(`CREATE DATABASE ${importDbName}`);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-sqlite-'));
  const sqlitePath = path.join(tempDir, 'legacy.db');
  const sqlite = new sqlite3.Database(sqlitePath);
  try {
    await sqliteRun(sqlite, `
      CREATE TABLE categories(code TEXT, name TEXT, requires_weight INTEGER);
      CREATE TABLE questions(id INTEGER, category_code TEXT, key TEXT, label TEXT, sku_index INTEGER, required INTEGER);
      CREATE TABLE options(id INTEGER, question_id INTEGER, value_id INTEGER, sku_code TEXT, label TEXT);
      CREATE TABLE price_scenarios(id INTEGER, category_code TEXT, name TEXT, match_json TEXT, axis_x_key TEXT, axis_y_key TEXT);
      CREATE TABLE price_matrix(scenario_id INTEGER, x_val INTEGER, y_val INTEGER, price REAL);
      CREATE TABLE price_modifiers(id INTEGER, category_code TEXT, trigger_key TEXT, trigger_val INTEGER, factor REAL);
      INSERT INTO categories VALUES ('IX', 'Imported', 0);
      INSERT INTO questions VALUES (1, 'IX', 'kind', 'Kind', 1, 1);
      INSERT INTO options VALUES (1, 1, 7, 'A7', 'Seven');
      INSERT INTO price_scenarios VALUES (1, 'IX', 'Imported matrix', '{}', 'kind', NULL);
      INSERT INTO price_matrix VALUES (1, 7, 0, 12.5);
    `);
  } finally {
    await new Promise((resolve, reject) => sqlite.close((error) => error ? reject(error) : resolve()));
  }
  try {
    await execFileAsync(process.execPath, ['-e', `
      process.env.DATABASE_URL = ${JSON.stringify(importUrl.toString())};
      const { runMigrations } = require('./src/db/run-migrations');
      const db = require('./src/db/pool');
      runMigrations().then(() => db.end()).catch((error) => { console.error(error); process.exit(1); });
    `], { cwd: path.resolve(__dirname, '..') });
    await execFileAsync(process.execPath, [
      'scripts/migrate-sqlite-config-to-postgres.js',
      `--sqlite=${sqlitePath}`,
      `--pg=${importUrl.toString()}`,
    ], { cwd: path.resolve(__dirname, '..') });
    const importedPool = new Pool({ connectionString: importUrl.toString() });
    try {
      const imported = await importedPool.query(
        `SELECT o.sku_code, sv.version
         FROM options o
         JOIN questions q ON q.id = o.question_id
         JOIN sku_schema_versions sv ON sv.category_code = q.category_code
         WHERE q.category_code = 'IX'`
      );
      assert.deepEqual(imported.rows, [{ sku_code: 'A7', version: 1 }]);
    } finally {
      await importedPool.end();
    }
    await assert.rejects(
      execFileAsync(process.execPath, [
        'scripts/migrate-sqlite-config-to-postgres.js',
        `--sqlite=${sqlitePath}`,
        `--pg=${importUrl.toString()}`,
      ], { cwd: path.resolve(__dirname, '..') })
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await pool.query(`DROP DATABASE IF EXISTS ${importDbName} WITH (FORCE)`);
  }
});
