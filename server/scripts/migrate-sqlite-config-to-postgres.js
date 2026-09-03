const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const args = process.argv.slice(2);
const replaceExisting = args.includes('--replace');

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
  --replace       Explicitly replace existing config; refused when products exist
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
    const optionColumns = new Set(
      (await sqliteAll(sqliteDb, 'PRAGMA table_info(options)')).map((column) => column.name)
    );
    const options = await sqliteAll(sqliteDb, `
      SELECT id, question_id, value_id, label,
             ${optionColumns.has('sku_code') ? 'sku_code' : 'CAST(value_id AS TEXT)'} AS sku_code
      FROM options
    `);
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

    const targetState = await pgClient.query(
      `SELECT
         (SELECT COUNT(*)::int FROM categories) AS category_count,
         (SELECT COUNT(*)::int FROM questions) AS question_count,
         (SELECT COUNT(*)::int FROM products) AS product_count`
    );
    const state = targetState.rows[0];
    const hasConfiguration = Number(state.category_count) > 0 || Number(state.question_count) > 0;
    if (hasConfiguration && !replaceExisting) {
      throw new Error(
        'Target PostgreSQL already contains configuration. Re-run with --replace only after review.'
      );
    }
    if (replaceExisting && Number(state.product_count) > 0) {
      throw new Error('Refusing --replace because target PostgreSQL contains products.');
    }

    await pgClient.query('DELETE FROM sku_schema_versions');
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
        `INSERT INTO options (id, question_id, value_id, sku_code, label)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          Number(row.id),
          Number(row.question_id),
          Number(row.value_id || 0),
          String(row.sku_code ?? row.value_id),
          row.label,
        ]
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

    for (const category of categories) {
      const categoryQuestions = questions
        .filter((question) => question.category_code === category.code)
        .sort((a, b) => Number(a.sku_index) - Number(b.sku_index));
      const snapshotHash = crypto.createHash('sha256').update(JSON.stringify({
        category: category.code,
        questions: categoryQuestions.map((question) => ({
          key: question.key,
          label: question.label,
          skuIndex: Number(question.sku_index || 0),
          required: Number(question.required || 0),
          options: options
            .filter((option) => Number(option.question_id) === Number(question.id))
            .map((option) => ({ valueId: Number(option.value_id), skuCode: String(option.sku_code) })),
        })),
      })).digest('hex');
      const schemaResult = await pgClient.query(
        `INSERT INTO sku_schema_versions
         (category_code, version, marker, status, config_hash)
         VALUES ($1, 1, '', 'active', $2)
         RETURNING id`,
        [category.code, snapshotHash]
      );
      for (const question of categoryQuestions) {
        const schemaQuestionResult = await pgClient.query(
          `INSERT INTO sku_schema_questions
           (schema_version_id, question_key, label, sku_index, required, display_order)
           VALUES ($1, $2, $3, $4::integer, $5, $4::real)
           RETURNING id`,
          [
            Number(schemaResult.rows[0].id),
            question.key,
            question.label,
            Number(question.sku_index || 0),
            Number(question.required || 0),
          ]
        );
        for (const option of options.filter(
          (item) => Number(item.question_id) === Number(question.id)
        )) {
          await pgClient.query(
            `INSERT INTO sku_schema_options
             (schema_question_id, value_id, sku_code, label)
             VALUES ($1, $2, $3, $4)`,
            [
              Number(schemaQuestionResult.rows[0].id),
              Number(option.value_id),
              String(option.sku_code),
              option.label,
            ]
          );
        }
      }
    }

    await setSequence(pgClient, 'questions', 'id');
    await setSequence(pgClient, 'options', 'id');
    await setSequence(pgClient, 'price_scenarios', 'id');
    await setSequence(pgClient, 'price_modifiers', 'id');
    await setSequence(pgClient, 'sku_schema_versions', 'id');
    await setSequence(pgClient, 'sku_schema_questions', 'id');
    await setSequence(pgClient, 'sku_schema_options', 'id');

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
