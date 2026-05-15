const initialConfig = require('../../data_config');
const pool = require('../db/pool');
const { parseOptionalRule } = require('../utils/rules');
const { normalizeSkuSeparator } = require('../utils/sku');

function normalizeInputType(inputType) {
  return String(inputType || 'options').trim().toLowerCase() === 'text' ? 'text' : 'options';
}

function normalizeEditableSkuSeparator(separator) {
  const rawSeparator = String(separator || '').trim();
  const normalizedSeparator = normalizeSkuSeparator(rawSeparator);

  if (rawSeparator && !normalizedSeparator) {
    const err = new Error('Розділювач SKU може містити тільки -, _, . або /');
    err.statusCode = 400;
    throw err;
  }

  return normalizedSeparator;
}

async function getAppConfig() {
  const config = { categories: {}, questions: {}, extraConfig: initialConfig.extraConfig };

  const categories = await pool.query('SELECT * FROM categories');
  for (const row of categories.rows) {
    config.categories[row.code] = {
      name: row.name,
      code: row.code,
      requires_weight: row.requires_weight,
    };
  }

  const questions = await pool.query(`
    SELECT
      q.id AS q_db_id,
      q.category_code,
      q.key,
      q.label AS q_label,
      q.sku_index,
      q.required,
      q.include_in_sku,
      q.input_type,
      q.sku_separator,
      q.visible_if_json AS q_visible_if_json,
      o.id AS o_db_id,
      o.value_id,
      o.label AS o_label,
      o.visible_if_json
    FROM questions q
    LEFT JOIN options o ON q.id = o.question_id
    ORDER BY q.category_code, q.sku_index, o.value_id
  `);

  const tempQuestions = {};
  for (const row of questions.rows) {
    if (!tempQuestions[row.q_db_id]) {
      tempQuestions[row.q_db_id] = {
        q_db_id: row.q_db_id,
        id: row.key,
        label: row.q_label,
        sku_index: row.sku_index,
        required: row.required,
        include_in_sku: row.include_in_sku,
        input_type: row.input_type || 'options',
        sku_separator: row.sku_separator || '',
        visible_if_json: row.q_visible_if_json || null,
        cat: row.category_code,
        options: [],
      };
    }

    if (row.o_db_id) {
      tempQuestions[row.q_db_id].options.push({
        db_id: row.o_db_id,
        id: row.value_id,
        label: row.o_label,
        visible_if_json: row.visible_if_json || null,
      });
    }
  }

  for (const question of Object.values(tempQuestions)) {
    if (!config.questions[question.cat]) config.questions[question.cat] = [];
    config.questions[question.cat].push(question);
  }

  return config;
}

async function createCategory({ code, name, requires_weight }) {
  await pool.query(
    'INSERT INTO categories (code, name, requires_weight) VALUES ($1, $2, $3)',
    [code, name, requires_weight !== undefined ? Number(requires_weight) : 1]
  );

  return { id: code, name };
}

async function updateCategory({ code, name, requires_weight }) {
  await pool.query(
    'UPDATE categories SET name = $1, requires_weight = $2 WHERE code = $3',
    [name, requires_weight !== undefined ? Number(requires_weight) : 1, code]
  );
}

async function createQuestion(payload) {
  const normalizedInputType = normalizeInputType(payload.input_type);
  const skuSeparator = normalizeEditableSkuSeparator(payload.sku_separator);
  const visibleRule = parseOptionalRule(payload.visible_if_json);
  const normalizedIncludeInSku =
    normalizedInputType === 'text'
      ? 0
      : payload.include_in_sku !== undefined
        ? Number(payload.include_in_sku)
        : 1;

  const result = await pool.query(
    `INSERT INTO questions (category_code, key, label, sku_index, required, include_in_sku, input_type, sku_separator, visible_if_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      payload.category_code,
      payload.key,
      payload.label,
      Number(payload.sku_index),
      payload.required !== undefined ? Number(payload.required) : 1,
      normalizedIncludeInSku,
      normalizedInputType,
      skuSeparator,
      visibleRule ? JSON.stringify(visibleRule) : null,
    ]
  );

  return { id: result.rows[0].id };
}

async function updateQuestion(payload) {
  const normalizedInputType = normalizeInputType(payload.input_type);
  const skuSeparator = normalizeEditableSkuSeparator(payload.sku_separator);
  const visibleRule = parseOptionalRule(payload.visible_if_json);
  const normalizedIncludeInSku =
    normalizedInputType === 'text'
      ? 0
      : payload.include_in_sku !== undefined
        ? Number(payload.include_in_sku)
        : 1;

  await pool.query(
    `UPDATE questions
     SET label = $1, sku_index = $2, required = $3, include_in_sku = $4, input_type = $5, sku_separator = $6, visible_if_json = $7::jsonb
     WHERE id = $8`,
    [
      payload.label,
      Number(payload.sku_index),
      payload.required !== undefined ? Number(payload.required) : 1,
      normalizedIncludeInSku,
      normalizedInputType,
      skuSeparator,
      visibleRule ? JSON.stringify(visibleRule) : null,
      Number(payload.id),
    ]
  );
}

async function createOption(payload) {
  const visibleRule = parseOptionalRule(payload.visible_if_json);
  const result = await pool.query(
    'INSERT INTO options (question_id, value_id, label, visible_if_json) VALUES ($1, $2, $3, $4::jsonb) RETURNING id',
    [
      Number(payload.question_id),
      Number(payload.value_id),
      payload.label,
      visibleRule ? JSON.stringify(visibleRule) : null,
    ]
  );

  return { id: result.rows[0].id };
}

async function updateOption(payload) {
  const visibleRule = parseOptionalRule(payload.visible_if_json);
  await pool.query(
    `UPDATE options
     SET value_id = $1, label = $2, visible_if_json = $3::jsonb
     WHERE id = $4`,
    [
      Number(payload.value_id),
      payload.label,
      visibleRule ? JSON.stringify(visibleRule) : null,
      Number(payload.id),
    ]
  );
}

async function deleteCatalogItem(type, id) {
  if (type === 'category') {
    await pool.query('DELETE FROM categories WHERE code = $1', [id]);
    return;
  }
  if (type === 'question') {
    await pool.query('DELETE FROM questions WHERE id = $1', [Number(id)]);
    return;
  }
  if (type === 'option') {
    await pool.query('DELETE FROM options WHERE id = $1', [Number(id)]);
    return;
  }
  if (type === 'modifier') {
    await pool.query('DELETE FROM price_modifiers WHERE id = $1', [Number(id)]);
    return;
  }
  if (type === 'scenario') {
    await pool.query('DELETE FROM price_scenarios WHERE id = $1', [Number(id)]);
    return;
  }

  const err = new Error('Некоректний тип');
  err.statusCode = 400;
  throw err;
}

module.exports = {
  getAppConfig,
  createCategory,
  updateCategory,
  createQuestion,
  updateQuestion,
  createOption,
  updateOption,
  deleteCatalogItem,
};
