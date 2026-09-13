const suite = require('./suite-context');
const {
  assert,
  fs,
  os,
  path,
  test,
  sqlite3,
  Pool,
  TEST_DATABASE_URL,
  pool,
  execFileAsync,
  runMigrations,
  sqliteRun,
} = suite;

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
