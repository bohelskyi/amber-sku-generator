const initialConfig = require('../../data_config');
const pool = require('./pool');

async function migratePricesToDb(client) {
  const { naturalCalibratedPrices, formedPrices } = initialConfig;

  for (const categoryCode of ['CH', 'BR', 'NM', 'KL']) {
    const formedScenario = await client.query(
      `INSERT INTO price_scenarios (category_code, name, group_name, match_json, axis_x_key, axis_y_key)
       VALUES ($1, 'Формований', 'Формовані', $2::jsonb, 'quality', NULL)
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
      `INSERT INTO price_scenarios (category_code, name, group_name, match_json, axis_x_key, axis_y_key)
       VALUES ($1, 'Натур. Калібрований', 'Натур. Калібрований', $2::jsonb, 'size', 'texture')
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
      `INSERT INTO price_modifiers (category_code, trigger_key, trigger_val, match_json, factor)
       VALUES ($1, 'quality', 2, $2::jsonb, 0.7)`,
      [categoryCode, JSON.stringify({ quality: 2 })]
    );
  }

  console.log('Prices migrated to DB');
}

async function ensureCalibratedQuestions() {
  const categoryRows = await pool.query(`
    SELECT q.category_code, q.sku_index, COALESCE(q.display_order, q.sku_index) AS display_order
    FROM questions q
    WHERE q.key = 'raw_type'
      AND NOT EXISTS (
        SELECT 1
        FROM questions cq
        WHERE cq.category_code = q.category_code
          AND cq.key = 'is_calibrated'
      )
  `);

  const calibratedConfig = initialConfig.extraConfig?.is_calibrated;
  if (!calibratedConfig?.options?.length) return;

  for (const row of categoryRows.rows) {
    const insertedQuestion = await pool.query(
      `INSERT INTO questions
       (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type, sku_separator, visible_if_json)
       VALUES ($1, 'is_calibrated', $2, $3, $4, 1, 0, 'options', '', $5::jsonb)
       RETURNING id`,
      [
        row.category_code,
        calibratedConfig.label || 'Сировина калібрована?',
        Number(row.sku_index || 0) + 1,
        Number(row.display_order || 0) + 0.5,
        JSON.stringify({ raw_type: 1 }),
      ]
    );
    const questionId = insertedQuestion.rows[0].id;

    for (const option of calibratedConfig.options) {
      await pool.query(
        'INSERT INTO options (question_id, value_id, sku_code, label) VALUES ($1, $2, $3, $4)',
        [questionId, option.id, String(option.id), option.label]
      );
    }
  }
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
          `INSERT INTO questions (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type, visible_if_json)
           VALUES ($1, $2, $3, $4, $5, 1, 1, 'options', $6::jsonb)
           RETURNING id`,
          [
            code,
            question.id,
            question.label,
            question.sku_index,
            question.display_order !== undefined ? question.display_order : question.sku_index,
            question.visible_if_json ? JSON.stringify(question.visible_if_json) : null,
          ]
        );
        const questionId = insertedQuestion.rows[0].id;

        for (const option of question.options) {
          await client.query(
            'INSERT INTO options (question_id, value_id, sku_code, label) VALUES ($1, $2, $3, $4)',
            [questionId, option.id, String(option.id), option.label]
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

  await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'");
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS exclude_from_export INTEGER DEFAULT 0');
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS corrected_from_product_id INTEGER REFERENCES products(id)');
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS corrected_to_product_id INTEGER REFERENCES products(id)');
  await pool.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS correction_reason TEXT');
  await pool.query("UPDATE products SET status = 'active' WHERE status IS NULL OR status = ''");
  await pool.query('UPDATE products SET exclude_from_export = 0 WHERE exclude_from_export IS NULL');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      code TEXT PRIMARY KEY,
      name TEXT,
      requires_weight INTEGER DEFAULT 1,
      sku_separator TEXT DEFAULT '',
      skip_hidden_sku_questions INTEGER DEFAULT 0
    )
  `);

  await pool.query("ALTER TABLE categories ADD COLUMN IF NOT EXISTS sku_separator TEXT DEFAULT ''");
  await pool.query('ALTER TABLE categories ADD COLUMN IF NOT EXISTS skip_hidden_sku_questions INTEGER DEFAULT 0');
  await pool.query('UPDATE categories SET skip_hidden_sku_questions = 0 WHERE skip_hidden_sku_questions IS NULL');

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
      display_order REAL,
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
      sku_code TEXT,
      label TEXT,
      visible_if_json JSONB,
      hidden_if_json JSONB,
      archived BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  await pool.query('ALTER TABLE options ADD COLUMN IF NOT EXISTS visible_if_json JSONB');
  await pool.query('ALTER TABLE options ADD COLUMN IF NOT EXISTS hidden_if_json JSONB');
  await pool.query('ALTER TABLE options ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE options ADD COLUMN IF NOT EXISTS sku_code TEXT');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_scenarios (
      id SERIAL PRIMARY KEY,
      category_code TEXT REFERENCES categories(code) ON DELETE CASCADE,
      name TEXT,
      group_name TEXT DEFAULT '',
      match_json JSONB,
      axis_x_key TEXT,
      axis_y_key TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      price_mode TEXT NOT NULL DEFAULT 'category_default',
      apply_modifiers BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);

  await pool.query("ALTER TABLE price_scenarios ADD COLUMN IF NOT EXISTS group_name TEXT DEFAULT ''");
  await pool.query('ALTER TABLE price_scenarios ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0');
  await pool.query("ALTER TABLE price_scenarios ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'");
  await pool.query("ALTER TABLE price_scenarios ADD COLUMN IF NOT EXISTS price_mode TEXT NOT NULL DEFAULT 'category_default'");
  await pool.query('ALTER TABLE price_scenarios ADD COLUMN IF NOT EXISTS apply_modifiers BOOLEAN NOT NULL DEFAULT TRUE');
  await pool.query(`
    UPDATE price_scenarios
    SET group_name = CASE
      WHEN position(' - ' in name) > 0 THEN split_part(name, ' - ', 1)
      ELSE name
    END
    WHERE group_name IS NULL OR group_name = ''
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
    CREATE TABLE IF NOT EXISTS price_weight_bands (
      id SERIAL PRIMARY KEY,
      scenario_id INTEGER NOT NULL REFERENCES price_scenarios(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      min_weight NUMERIC NOT NULL,
      max_weight NUMERIC,
      sort_order INTEGER NOT NULL DEFAULT 0,
      CHECK (min_weight >= 0),
      CHECK (max_weight IS NULL OR max_weight > min_weight)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_modifiers (
      id SERIAL PRIMARY KEY,
      category_code TEXT REFERENCES categories(code) ON DELETE CASCADE,
      trigger_key TEXT,
      trigger_val INTEGER,
      match_json JSONB,
      factor REAL
    )
  `);

  await pool.query('ALTER TABLE price_modifiers ADD COLUMN IF NOT EXISTS match_json JSONB');
  await pool.query(`
    UPDATE price_modifiers
    SET match_json = jsonb_build_object(trigger_key, trigger_val)
    WHERE match_json IS NULL
      AND trigger_key IS NOT NULL
      AND trigger_key <> ''
      AND trigger_val IS NOT NULL
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_corrections (
      id SERIAL PRIMARY KEY,
      source_product_id INTEGER REFERENCES products(id),
      corrected_product_id INTEGER REFERENCES products(id),
      source_sku TEXT,
      corrected_sku TEXT,
      old_payload JSONB,
      new_payload JSONB,
      reason TEXT,
      price_delta_uah REAL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS repricing_batches (
      id SERIAL PRIMARY KEY,
      scenario_id INTEGER REFERENCES price_scenarios(id) ON DELETE SET NULL,
      category_code TEXT,
      scenario_name TEXT NOT NULL,
      scenario_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      preview_token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      candidate_count INTEGER NOT NULL DEFAULT 0,
      changed_count INTEGER NOT NULL DEFAULT 0,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      applied_at TIMESTAMPTZ
    )
  `);

  await pool.query('ALTER TABLE repricing_batches ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS repricing_items (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES repricing_batches(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      sku TEXT NOT NULL,
      old_price_uah NUMERIC,
      new_price_uah NUMERIC NOT NULL,
      price_delta_uah NUMERIC NOT NULL,
      old_payload JSONB NOT NULL,
      new_payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (batch_id, product_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS repricing_drafts (
      id SERIAL PRIMARY KEY,
      scenario_id INTEGER REFERENCES price_scenarios(id) ON DELETE SET NULL,
      category_code TEXT NOT NULL,
      scenario_name TEXT NOT NULL,
      scenario_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      preview_fingerprint TEXT NOT NULL,
      preview_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      manual_overrides JSONB NOT NULL DEFAULT '[]'::jsonb,
      ui_state JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'draft',
      applied_batch_id INTEGER REFERENCES repricing_batches(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      applied_at TIMESTAMPTZ,
      discarded_at TIMESTAMPTZ,
      CHECK (status IN ('draft', 'applied', 'discarded'))
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repricing_drafts_one_active_scenario
    ON repricing_drafts (scenario_id)
    WHERE status = 'draft'
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_repricing_drafts_status_updated
    ON repricing_drafts (status, updated_at DESC)
  `);

  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS required INTEGER DEFAULT 1');
  await pool.query('UPDATE questions SET required = 1 WHERE required IS NULL');
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS include_in_sku INTEGER DEFAULT 1');
  await pool.query('UPDATE questions SET include_in_sku = 1 WHERE include_in_sku IS NULL');
  await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS input_type TEXT DEFAULT 'options'");
  await pool.query("UPDATE questions SET input_type = 'options' WHERE input_type IS NULL OR input_type = ''");
  await pool.query("ALTER TABLE questions ADD COLUMN IF NOT EXISTS sku_separator TEXT DEFAULT ''");
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS visible_if_json JSONB');
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS display_order REAL');
  await pool.query('UPDATE questions SET display_order = sku_index WHERE display_order IS NULL');

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

  await ensureCalibratedQuestions();
}

module.exports = {
  initDb,
};
