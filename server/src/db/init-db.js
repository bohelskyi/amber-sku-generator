const initialConfig = require('../../data_config');
const pool = require('./pool');

async function migratePricesToDb(client) {
  const { naturalCalibratedPrices, formedPrices } = initialConfig;

  for (const categoryCode of ['CH', 'BR', 'NM', 'KL']) {
    const formedScenario = await client.query(
      `INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key)
       VALUES ($1, 'Формований', $2::jsonb, 'quality', NULL)
       RETURNING id`,
      [categoryCode, JSON.stringify({ raw_type: 2 })]
    );
    const formedScenarioId = formedScenario.rows[0].id;

    for (const [qualityId, price] of Object.entries(formedPrices)) {
      await client.query(
        `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
         VALUES ($1, $2, 0, $3)`,
        [formedScenarioId, Number(qualityId), Number(price)]
      );
    }
  }

  for (const categoryCode of ['CH', 'BR', 'NM', 'KL']) {
    const naturalScenario = await client.query(
      `INSERT INTO price_scenarios (category_code, name, match_json, axis_x_key, axis_y_key)
       VALUES ($1, 'Натур. Калібрований', $2::jsonb, 'size', 'texture')
       RETURNING id`,
      [categoryCode, JSON.stringify({ raw_type: 1, is_calibrated: 1 })]
    );
    const naturalScenarioId = naturalScenario.rows[0].id;

    for (const [sizeId, textures] of Object.entries(naturalCalibratedPrices)) {
      for (const [textureId, price] of Object.entries(textures)) {
        await client.query(
          `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
           VALUES ($1, $2, $3, $4)`,
          [naturalScenarioId, Number(sizeId), Number(textureId), Number(price)]
        );
      }
    }

    await client.query(
      `INSERT INTO price_modifiers (category_code, trigger_key, trigger_val, factor)
       VALUES ($1, 'quality', 2, 0.7)`,
      [categoryCode]
    );
  }

  console.log('Prices migrated to DB');
}

async function migrateData() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const [code, category] of Object.entries(initialConfig.categories)) {
      const requiresWeight = code === 'AR' || code === 'DK' || code === 'SK' ? 0 : 1;
      await client.query(
        'INSERT INTO categories (code, name, requires_weight) VALUES ($1, $2, $3)',
        [code, category.name, requiresWeight]
      );

      const questions = initialConfig.questions[code] || [];
      for (const question of questions) {
        const insertedQuestion = await client.query(
          `INSERT INTO questions (category_code, key, label, sku_index, required, include_in_sku, input_type, visible_if_json)
           VALUES ($1, $2, $3, $4, 1, 1, 'options', $5::jsonb)
           RETURNING id`,
          [
            code,
            question.id,
            question.label,
            question.sku_index,
            question.visible_if_json ? JSON.stringify(question.visible_if_json) : null,
          ]
        );
        const questionId = insertedQuestion.rows[0].id;

        for (const option of question.options) {
          await client.query(
            'INSERT INTO options (question_id, value_id, label) VALUES ($1, $2, $3)',
            [questionId, option.id, option.label]
          );
        }
      }
    }

    await migratePricesToDb(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      full_sku TEXT,
      base_sku TEXT,
      sequence_number INTEGER,
      category TEXT,
      weight REAL,
      total_price REAL,
      price_per_gram REAL,
      details JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS total_price_uah REAL
  `);

  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS uah_rate REAL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      code TEXT PRIMARY KEY,
      name TEXT,
      requires_weight INTEGER DEFAULT 1,
      sku_separator TEXT DEFAULT ''
    )
  `);

  await pool.query("ALTER TABLE categories ADD COLUMN IF NOT EXISTS sku_separator TEXT DEFAULT ''");

  const questionSeparatorColumnResult = await pool.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'questions'
        AND column_name = 'sku_separator'
    ) AS exists
  `);
  const hadQuestionSeparatorColumn = Boolean(questionSeparatorColumnResult.rows[0]?.exists);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS questions (
      id SERIAL PRIMARY KEY,
      category_code TEXT REFERENCES categories(code) ON DELETE CASCADE,
      key TEXT,
      label TEXT,
      sku_index INTEGER,
      required INTEGER DEFAULT 1,
      include_in_sku INTEGER DEFAULT 1,
      input_type TEXT DEFAULT 'options',
      sku_separator TEXT DEFAULT '',
      visible_if_json JSONB
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS options (
      id SERIAL PRIMARY KEY,
      question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
      value_id INTEGER,
      label TEXT,
      visible_if_json JSONB
    )
  `);

  await pool.query('ALTER TABLE options ADD COLUMN IF NOT EXISTS visible_if_json JSONB');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_scenarios (
      id SERIAL PRIMARY KEY,
      category_code TEXT REFERENCES categories(code) ON DELETE CASCADE,
      name TEXT,
      match_json JSONB,
      axis_x_key TEXT,
      axis_y_key TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_matrix (
      scenario_id INTEGER REFERENCES price_scenarios(id) ON DELETE CASCADE,
      x_val INTEGER NOT NULL,
      y_val INTEGER NOT NULL DEFAULT 0,
      price REAL,
      PRIMARY KEY (scenario_id, x_val, y_val)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_modifiers (
      id SERIAL PRIMARY KEY,
      category_code TEXT REFERENCES categories(code) ON DELETE CASCADE,
      trigger_key TEXT,
      trigger_val INTEGER,
      factor REAL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS export_events (
      id SERIAL PRIMARY KEY,
      from_sku TEXT,
      to_sku TEXT,
      resolved_to_sku TEXT,
      exported_to_product_id INTEGER,
      row_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS required INTEGER DEFAULT 1');
  await pool.query('UPDATE questions SET required = 1 WHERE required IS NULL');
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS include_in_sku INTEGER DEFAULT 1');
  await pool.query('UPDATE questions SET include_in_sku = 1 WHERE include_in_sku IS NULL');
  await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS input_type TEXT DEFAULT 'options'");
  await pool.query("UPDATE questions SET input_type = 'options' WHERE input_type IS NULL OR input_type = ''");
  await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS sku_separator TEXT DEFAULT ''");
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS visible_if_json JSONB');

  const { rows } = await pool.query('SELECT count(*)::int AS count FROM categories');
  if (rows[0].count === 0) {
    console.log('Empty DB. Migrating data & prices...');
    await migrateData();
  }

  await pool.query(
    "UPDATE categories SET requires_weight = 0 WHERE code = ANY($1::text[])",
    [['AR', 'DK', 'SK']]
  );

  if (!hadQuestionSeparatorColumn) {
    await pool.query(
      "UPDATE questions SET sku_separator = '-' WHERE category_code = 'AR' AND key = 'size' AND COALESCE(sku_separator, '') = ''"
    );
  }
}

module.exports = {
  initDb,
};
