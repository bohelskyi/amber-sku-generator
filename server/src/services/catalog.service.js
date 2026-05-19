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

function normalizeCategoryCode(code) {
  return String(code || '').trim().toUpperCase();
}

function normalizeQuestionKey(key) {
  return String(key || '').trim();
}

function renameJsonObjectKey(value, oldKey, newKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!Object.prototype.hasOwnProperty.call(value, oldKey)) return value;

  return Object.entries(value).reduce((result, [key, item]) => {
    result[key === oldKey ? newKey : key] = item;
    return result;
  }, {});
}

function renameAxisKey(axisKey, oldKey, newKey) {
  if (!axisKey) return axisKey;
  return String(axisKey)
    .split('+')
    .map((key) => (key.trim() === oldKey ? newKey : key.trim()))
    .join('+');
}

async function renameVisibleRuleKey(client, tableName, idColumn, row, oldKey, newKey) {
  const nextRule = renameJsonObjectKey(row.visible_if_json, oldKey, newKey);
  if (nextRule === row.visible_if_json) return;

  await client.query(
    `UPDATE ${tableName} SET visible_if_json = $1::jsonb WHERE ${idColumn} = $2`,
    [JSON.stringify(nextRule), row.id]
  );
}

async function renameQuestionKeyReferences(client, categoryCode, oldKey, newKey) {
  const questionRules = await client.query(
    `SELECT id, visible_if_json
     FROM questions
     WHERE category_code = $1
       AND visible_if_json ? $2`,
    [categoryCode, oldKey]
  );
  for (const row of questionRules.rows) {
    await renameVisibleRuleKey(client, 'questions', 'id', row, oldKey, newKey);
  }

  const optionRules = await client.query(
    `SELECT o.id, o.visible_if_json
     FROM options o
     JOIN questions q ON q.id = o.question_id
     WHERE q.category_code = $1
       AND o.visible_if_json ? $2`,
    [categoryCode, oldKey]
  );
  for (const row of optionRules.rows) {
    await renameVisibleRuleKey(client, 'options', 'id', row, oldKey, newKey);
  }

  const scenarios = await client.query(
    `SELECT id, match_json, axis_x_key, axis_y_key
     FROM price_scenarios
     WHERE category_code = $1
       AND (
         match_json ? $2
         OR axis_x_key = $2
         OR axis_y_key = $2
         OR axis_x_key LIKE $3
         OR axis_y_key LIKE $3
       )`,
    [categoryCode, oldKey, `%${oldKey}%`]
  );
  for (const row of scenarios.rows) {
    const nextMatchJson = renameJsonObjectKey(row.match_json, oldKey, newKey);
    await client.query(
      `UPDATE price_scenarios
       SET match_json = $1::jsonb,
           axis_x_key = $2,
           axis_y_key = $3
       WHERE id = $4`,
      [
        JSON.stringify(nextMatchJson || {}),
        renameAxisKey(row.axis_x_key, oldKey, newKey),
        renameAxisKey(row.axis_y_key, oldKey, newKey),
        row.id,
      ]
    );
  }

  await client.query(
    `UPDATE price_modifiers
     SET trigger_key = $1
     WHERE category_code = $2 AND trigger_key = $3`,
    [newKey, categoryCode, oldKey]
  );

  await client.query(
    `UPDATE products
     SET details = jsonb_set(
       details #- $1::text[],
       $2::text[],
       details #> $1::text[],
       true
     )
     WHERE category = $3
       AND details #> $1::text[] IS NOT NULL`,
    [[`answers`, oldKey], [`answers`, newKey], categoryCode]
  );
}

async function getAppConfig() {
  const config = { categories: {}, questions: {}, extraConfig: initialConfig.extraConfig };

  const categories = await pool.query('SELECT * FROM categories');
  for (const row of categories.rows) {
    config.categories[row.code] = {
      name: row.name,
      code: row.code,
      requires_weight: row.requires_weight,
      skip_hidden_sku_questions: row.skip_hidden_sku_questions || 0,
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

async function createCategory({ code, name, requires_weight, skip_hidden_sku_questions }) {
  const normalizedCode = normalizeCategoryCode(code);
  await pool.query(
    'INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions) VALUES ($1, $2, $3, $4)',
    [
      normalizedCode,
      name,
      requires_weight !== undefined ? Number(requires_weight) : 1,
      skip_hidden_sku_questions !== undefined ? Number(skip_hidden_sku_questions) : 0,
    ]
  );

  return { id: normalizedCode, name };
}

async function updateCategory({ code, next_code, name, requires_weight, skip_hidden_sku_questions }) {
  const currentCode = normalizeCategoryCode(code);
  const nextCode = normalizeCategoryCode(next_code || code);
  const normalizedRequiresWeight = requires_weight !== undefined ? Number(requires_weight) : 1;
  const normalizedSkipHidden =
    skip_hidden_sku_questions !== undefined ? Number(skip_hidden_sku_questions) : 0;

  if (!currentCode || !nextCode) {
    const err = new Error('Потрібен код категорії');
    err.statusCode = 400;
    throw err;
  }

  if (currentCode === nextCode) {
    await pool.query(
      'UPDATE categories SET name = $1, requires_weight = $2, skip_hidden_sku_questions = $3 WHERE code = $4',
      [name, normalizedRequiresWeight, normalizedSkipHidden, currentCode]
    );
    return { code: nextCode };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const currentResult = await client.query(
      'SELECT * FROM categories WHERE code = $1 FOR UPDATE',
      [currentCode]
    );
    if (currentResult.rows.length === 0) {
      const err = new Error('Категорію не знайдено');
      err.statusCode = 404;
      throw err;
    }

    const duplicateResult = await client.query(
      'SELECT code FROM categories WHERE code = $1',
      [nextCode]
    );
    if (duplicateResult.rows.length > 0) {
      const err = new Error(`Категорія з кодом ${nextCode} вже існує`);
      err.statusCode = 400;
      throw err;
    }

    await client.query(
      'INSERT INTO categories (code, name, requires_weight, sku_separator, skip_hidden_sku_questions) SELECT $1, $2, $3, sku_separator, $4 FROM categories WHERE code = $5',
      [nextCode, name, normalizedRequiresWeight, normalizedSkipHidden, currentCode]
    );
    await client.query('UPDATE questions SET category_code = $1 WHERE category_code = $2', [nextCode, currentCode]);
    await client.query('UPDATE price_scenarios SET category_code = $1 WHERE category_code = $2', [nextCode, currentCode]);
    await client.query('UPDATE price_modifiers SET category_code = $1 WHERE category_code = $2', [nextCode, currentCode]);
    await client.query('UPDATE products SET category = $1 WHERE category = $2', [nextCode, currentCode]);
    await client.query('DELETE FROM categories WHERE code = $1', [currentCode]);

    await client.query('COMMIT');
    return { code: nextCode };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createQuestion(payload) {
  const normalizedInputType = normalizeInputType(payload.input_type);
  const questionKey = normalizeQuestionKey(payload.key);
  const skuSeparator = normalizeEditableSkuSeparator(payload.sku_separator);
  const visibleRule = parseOptionalRule(payload.visible_if_json ?? payload.visible_if);
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
      questionKey,
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
  const questionKey = normalizeQuestionKey(payload.key);
  const skuSeparator = normalizeEditableSkuSeparator(payload.sku_separator);
  const visibleRule = parseOptionalRule(payload.visible_if_json ?? payload.visible_if);
  const normalizedIncludeInSku =
    normalizedInputType === 'text'
      ? 0
      : payload.include_in_sku !== undefined
        ? Number(payload.include_in_sku)
        : 1;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const currentResult = await client.query(
      'SELECT id, category_code, key FROM questions WHERE id = $1 FOR UPDATE',
      [Number(payload.id)]
    );
    if (currentResult.rows.length === 0) {
      const err = new Error('Питання не знайдено');
      err.statusCode = 404;
      throw err;
    }

    const currentQuestion = currentResult.rows[0];
    const nextKey = questionKey || currentQuestion.key;

    if (nextKey !== currentQuestion.key) {
      const duplicateResult = await client.query(
        'SELECT id FROM questions WHERE category_code = $1 AND key = $2 AND id <> $3',
        [currentQuestion.category_code, nextKey, Number(payload.id)]
      );
      if (duplicateResult.rows.length > 0) {
        const err = new Error(`Питання з key ${nextKey} вже існує в цій категорії`);
        err.statusCode = 400;
        throw err;
      }

      await renameQuestionKeyReferences(
        client,
        currentQuestion.category_code,
        currentQuestion.key,
        nextKey
      );
    }

    await client.query(
      `UPDATE questions
       SET key = $1, label = $2, sku_index = $3, required = $4, include_in_sku = $5, input_type = $6, sku_separator = $7, visible_if_json = $8::jsonb
       WHERE id = $9`,
      [
        nextKey,
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

    await client.query('COMMIT');
    return { key: nextKey };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createOption(payload) {
  const visibleRule = parseOptionalRule(payload.visible_if_json ?? payload.visible_if);
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
  const visibleRule = parseOptionalRule(payload.visible_if_json ?? payload.visible_if);
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
