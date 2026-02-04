const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const args = process.argv.slice(2);

function getArgValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

if (args.includes('--help')) {
  console.log(`
Usage:
  npm run migrate:config -- --sqlite=./amber.db --pg=postgresql://user:pass@host:5432/db

Options:
  --sqlite=PATH   Path to old SQLite DB (default: ./amber.db)
  --pg=URL        PostgreSQL connection string (default: DATABASE_URL env var)
`);
  process.exit(0);
}

const sqlitePath = path.resolve(getArgValue('sqlite', './amber.db'));
const pgUrl = getArgValue('pg', process.env.DATABASE_URL);

if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite file not found: ${sqlitePath}`);
  process.exit(1);
}

if (!pgUrl) {
  console.error('PostgreSQL URL missing. Pass --pg=... or set DATABASE_URL.');
  process.exit(1);
}

function openSqlite(filePath) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filePath, sqlite3.OPEN_READONLY, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function sqliteAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function sqliteClose(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function setSequence(pgClient, table, column) {
  const query = `
    SELECT setval(
      pg_get_serial_sequence($1, $2),
      COALESCE((SELECT MAX(${column}) FROM ${table}), 1),
      (SELECT COUNT(*) > 0 FROM ${table})
    )
  `;
  await pgClient.query(query, [table, column]);
}

async function run() {
  console.log(`Reading SQLite config from: ${sqlitePath}`);

  const sqliteDb = await openSqlite(sqlitePath);
  const pgPool = new Pool({ connectionString: pgUrl });
  const pgClient = await pgPool.connect();

  try {
    const categories = await sqliteAll(sqliteDb, 'SELECT code, name, requires_weight FROM categories');
    const questions = await sqliteAll(
      sqliteDb,
      'SELECT id, category_code, key, label, sku_index, required FROM questions'
    );
    const options = await sqliteAll(
      sqliteDb,
      'SELECT id, question_id, value_id, label FROM options'
    );
    const scenarios = await sqliteAll(
      sqliteDb,
      'SELECT id, category_code, name, match_json, axis_x_key, axis_y_key FROM price_scenarios'
    );
    const matrix = await sqliteAll(
      sqliteDb,
      'SELECT scenario_id, x_val, y_val, price FROM price_matrix'
    );
    const modifiers = await sqliteAll(
      sqliteDb,
      'SELECT id, category_code, trigger_key, trigger_val, factor FROM price_modifiers'
    );

    console.log(
      `Loaded rows from SQLite: categories=${categories.length}, questions=${questions.length}, options=${options.length}, scenarios=${scenarios.length}, matrix=${matrix.length}, modifiers=${modifiers.length}`
    );

    await pgClient.query('BEGIN');

    await pgClient.query('DELETE FROM price_matrix');
    await pgClient.query('DELETE FROM price_modifiers');
    await pgClient.query('DELETE FROM price_scenarios');
    await pgClient.query('DELETE FROM options');
    await pgClient.query('DELETE FROM questions');
    await pgClient.query('DELETE FROM categories');

    for (const row of categories) {
      await pgClient.query(
        'INSERT INTO categories (code, name, requires_weight) VALUES ($1, $2, $3)',
        [row.code, row.name, Number(row.requires_weight || 0)]
      );
    }

    for (const row of questions) {
      await pgClient.query(
        `INSERT INTO questions (id, category_code, key, label, sku_index, required)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          Number(row.id),
          row.category_code,
          row.key,
          row.label,
          Number(row.sku_index || 0),
          Number(row.required || 0),
        ]
      );
    }

    for (const row of options) {
      await pgClient.query(
        'INSERT INTO options (id, question_id, value_id, label) VALUES ($1, $2, $3, $4)',
        [Number(row.id), Number(row.question_id), Number(row.value_id || 0), row.label]
      );
    }

    for (const row of scenarios) {
      let matchJson = row.match_json;
      if (!matchJson) matchJson = '{}';
      await pgClient.query(
        `INSERT INTO price_scenarios (id, category_code, name, match_json, axis_x_key, axis_y_key)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [Number(row.id), row.category_code, row.name, String(matchJson), row.axis_x_key, row.axis_y_key]
      );
    }

    for (const row of matrix) {
      await pgClient.query(
        'INSERT INTO price_matrix (scenario_id, x_val, y_val, price) VALUES ($1, $2, $3, $4)',
        [
          Number(row.scenario_id),
          Number(row.x_val || 0),
          Number(row.y_val || 0),
          Number(row.price || 0),
        ]
      );
    }

    for (const row of modifiers) {
      await pgClient.query(
        `INSERT INTO price_modifiers (id, category_code, trigger_key, trigger_val, factor)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          Number(row.id),
          row.category_code,
          row.trigger_key,
          Number(row.trigger_val || 0),
          Number(row.factor || 0),
        ]
      );
    }

    await setSequence(pgClient, 'questions', 'id');
    await setSequence(pgClient, 'options', 'id');
    await setSequence(pgClient, 'price_scenarios', 'id');
    await setSequence(pgClient, 'price_modifiers', 'id');

    await pgClient.query('COMMIT');

    console.log('Config migration completed successfully.');
  } catch (err) {
    try {
      await pgClient.query('ROLLBACK');
    } catch {
      // ignore rollback error
    }
    console.error('Config migration failed:', err.message || err);
    process.exitCode = 1;
  } finally {
    pgClient.release();
    await pgPool.end();
    await sqliteClose(sqliteDb);
  }
}

run();
