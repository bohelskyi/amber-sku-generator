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

let server;
let baseUrl;
const schemas = {};
let primarySku;

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
  await ensureLegacySkuSchemas();
  for (const code of ['ZZ', 'MM', 'WW']) {
    const result = await pool.query(
      `SELECT id FROM sku_schema_versions WHERE category_code = $1 AND status = 'active'`,
      [code]
    );
    schemas[code] = Number(result.rows[0].id);
  }
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
    body: { category: 'MM', answers: { kind: 1 }, weight: 0, skuSchemaVersionId: schemas.ZZ, manualPriceUah: 200 },
  });
  assert.equal(wrongSchema.response.status, 422);

  const noAuto = await request('/api/save', {
    method: 'POST',
    body: { category: 'MM', answers: { kind: 1 }, weight: 0, skuSchemaVersionId: schemas.MM },
  });
  assert.equal(noAuto.response.status, 422);
  assert.match(noAuto.data.error, /Вкажіть ціну вручну/);
  const manual = await request('/api/save', {
    method: 'POST',
    body: { category: 'MM', answers: { kind: 1 }, weight: 0, skuSchemaVersionId: schemas.MM, manualPriceUah: 321 },
  });
  assert.equal(manual.response.status, 200, manual.text);
  const stored = await pool.query('SELECT total_price_uah FROM products WHERE id = $1', [manual.data.id]);
  assert.equal(Number(stored.rows[0].total_price_uah), 321);
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
  const rolledBack = await request(`/api/admin/repricing/${batchId}/rollback`, {
    method: 'POST', body: {},
  });
  assert.equal(rolledBack.response.status, 200, rolledBack.text);

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

test('export snapshot is immutable, idempotent, and cursor is monotonic', async () => {
  const first = await request('/api/export/snapshots', {
    method: 'POST', body: { fromSku: primarySku }, headers: { 'Idempotency-Key': 'integration-export-1' },
  });
  assert.equal(first.response.status, 201, first.text);
  const repeated = await request('/api/export/snapshots', {
    method: 'POST', body: { fromSku: primarySku }, headers: { 'Idempotency-Key': 'integration-export-1' },
  });
  assert.equal(repeated.data.id, first.data.id);
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
  await assert.rejects(
    pool.query("UPDATE export_snapshots SET csv_content = 'changed' WHERE id = $1", [first.data.id]),
    /immutable/
  );
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
