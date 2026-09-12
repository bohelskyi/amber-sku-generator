const initialConfig = require('../../../data_config');
const pool = require('../../db/pool');

async function getAppConfig() {
  const config = { categories: {}, questions: {}, extraConfig: initialConfig.extraConfig };

  const categories = await pool.query(
    `SELECT c.*,
            NOT (
              EXISTS (SELECT 1 FROM products p WHERE p.category = c.code)
              OR EXISTS (
                SELECT 1
                FROM sku_registry sr
                LEFT JOIN products rp ON rp.id = sr.first_product_id
                WHERE rp.category = c.code OR sr.full_sku LIKE c.code || '%'
              )
              OR EXISTS (
                SELECT 1
                FROM sku_schema_versions sv
                WHERE sv.category_code = c.code AND sv.published_at IS NOT NULL
              )
            ) AS code_mutable
     FROM categories c`
  );
  for (const row of categories.rows) {
    config.categories[row.code] = {
      name: row.name,
      code: row.code,
      requires_weight: row.requires_weight,
      skip_hidden_sku_questions: row.skip_hidden_sku_questions || 0,
      code_mutable: Boolean(row.code_mutable),
    };
  }

  const questions = await pool.query(`
    SELECT
      q.id AS q_db_id,
      q.category_code,
      q.key,
      q.label AS q_label,
      q.sku_index,
      q.display_order,
      q.required,
      q.include_in_sku,
      q.input_type,
      q.sku_separator,
      q.visible_if_json AS q_visible_if_json,
      o.id AS o_db_id,
      o.value_id,
      o.sku_code,
      o.label AS o_label,
      o.visible_if_json,
      o.hidden_if_json,
      COALESCE(o.archived, FALSE) AS o_archived
    FROM questions q
    LEFT JOIN options o ON q.id = o.question_id
    ORDER BY q.category_code, COALESCE(q.display_order, q.sku_index), q.sku_index, o.value_id
  `);

  const tempQuestions = new Map();
  for (const row of questions.rows) {
    if (!tempQuestions.has(row.q_db_id)) {
      tempQuestions.set(row.q_db_id, {
        q_db_id: row.q_db_id,
        id: row.key,
        label: row.q_label,
        sku_index: row.sku_index,
        display_order: row.display_order ?? row.sku_index,
        required: row.required,
        include_in_sku: row.include_in_sku,
        input_type: row.input_type || 'options',
        sku_separator: row.sku_separator || '',
        visible_if_json: row.q_visible_if_json || null,
        cat: row.category_code,
        options: [],
      });
    }

    if (row.o_db_id) {
      tempQuestions.get(row.q_db_id).options.push({
        db_id: row.o_db_id,
        id: row.value_id,
        sku_code: String(row.sku_code ?? row.value_id),
        label: row.o_label,
        visible_if_json: row.visible_if_json || null,
        hidden_if_json: row.hidden_if_json || null,
        archived: row.o_archived ? 1 : 0,
      });
    }
  }

  for (const question of tempQuestions.values()) {
    if (!config.questions[question.cat]) config.questions[question.cat] = [];
    config.questions[question.cat].push(question);
  }

  return config;
}

module.exports = {
  getAppConfig,
};
