const crypto = require('crypto');
const pool = require('../db/pool');
const { getAppConfig } = require('./catalog.service');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
}

function hashSnapshot(snapshot) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableValue(snapshot)))
    .digest('hex');
}

function getVersionMarker(version) {
  return Number(version) === 1 ? '' : `${Number(version)}/`;
}

function parseVersionedSkuPart(skuWithoutCategory) {
  const source = String(skuWithoutCategory || '');
  const compactMatch = source.match(/^(\d+)\//);
  if (compactMatch) {
    return {
      version: Number(compactMatch[1]),
      marker: compactMatch[0],
      encodedWithSuffix: source.slice(compactMatch[0].length),
    };
  }

  // Keep decoding the short-lived pre-release marker format.
  const legacyVersionMatch = source.match(/^V(\d+)-/i);
  if (!legacyVersionMatch) {
    return { version: 1, marker: '', encodedWithSuffix: source };
  }

  return {
    version: Number(legacyVersionMatch[1]),
    marker: legacyVersionMatch[0].toUpperCase(),
    encodedWithSuffix: source.slice(legacyVersionMatch[0].length),
  };
}

function validateSnapshot(questions) {
  for (const question of questions) {
    if (question.options.length === 0) {
      const err = new Error(`Питання «${question.label}» не має активних варіантів.`);
      err.statusCode = 422;
      throw err;
    }

    const valuesByCode = new Map();
    for (const option of question.options) {
      if (!valuesByCode.has(option.sku_code)) valuesByCode.set(option.sku_code, new Set());
      valuesByCode.get(option.sku_code).add(String(option.value_id));
    }
    for (const [skuCode, values] of valuesByCode) {
      if (values.size <= 1) continue;
      const err = new Error(
        `У питанні «${question.label}» SKU-код «${skuCode}» призначено різним внутрішнім значенням.`
      );
      err.statusCode = 422;
      throw err;
    }
  }
}

async function readCatalogSnapshot(categoryCode, {
  includeArchived = false,
  allowedQuestionKeys = null,
  queryable = pool,
} = {}) {
  const result = await queryable.query(
    `SELECT q.key, q.label AS question_label, q.sku_index,
            COALESCE(q.display_order, q.sku_index) AS display_order,
            q.required, COALESCE(q.sku_separator, '') AS sku_separator,
            q.visible_if_json AS question_visible_if,
            o.value_id, o.sku_code, o.label AS option_label,
            o.visible_if_json AS option_visible_if,
            o.hidden_if_json AS option_hidden_if,
            COALESCE(o.archived, FALSE) AS archived
     FROM questions q
     LEFT JOIN options o ON o.question_id = q.id
     WHERE q.category_code = $1
       AND COALESCE(q.include_in_sku, 1) = 1
     ORDER BY q.sku_index, q.id, o.id`,
    [categoryCode]
  );

  const questions = [];
  const byKey = new Map();
  for (const row of result.rows) {
    if (allowedQuestionKeys && !allowedQuestionKeys.has(row.key)) continue;

    if (!byKey.has(row.key)) {
      const question = {
        key: row.key,
        label: row.question_label,
        sku_index: Number(row.sku_index),
        display_order: Number(row.display_order),
        required: Number(row.required),
        sku_separator: row.sku_separator || '',
        visible_if_json: row.question_visible_if || null,
        options: [],
      };
      byKey.set(row.key, question);
      questions.push(question);
    }

    if (row.value_id === null || row.value_id === undefined) continue;
    if (!includeArchived && row.archived) continue;
    byKey.get(row.key).options.push({
      value_id: Number(row.value_id),
      sku_code: String(row.sku_code ?? row.value_id),
      label: row.option_label,
      visible_if_json: row.option_visible_if || null,
      hidden_if_json: row.option_hidden_if || null,
      archived: Boolean(row.archived),
    });
  }

  return questions;
}

async function insertSnapshot(client, categoryCode, version, questions) {
  const marker = getVersionMarker(version);
  const configHash = hashSnapshot(questions);
  const versionResult = await client.query(
    `INSERT INTO sku_schema_versions
     (category_code, version, marker, status, config_hash)
     VALUES ($1, $2, $3, 'active', $4)
     RETURNING *`,
    [categoryCode, version, marker, configHash]
  );
  const schemaVersion = versionResult.rows[0];

  for (const question of questions) {
    const questionResult = await client.query(
      `INSERT INTO sku_schema_questions
       (schema_version_id, question_key, label, sku_index, required, sku_separator,
        visible_if_json, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING id`,
      [
        schemaVersion.id,
        question.key,
        question.label,
        question.sku_index,
        question.required,
        question.sku_separator || '',
        question.visible_if_json ? JSON.stringify(question.visible_if_json) : null,
        question.display_order,
      ]
    );

    for (const option of question.options) {
      await client.query(
        `INSERT INTO sku_schema_options
         (schema_question_id, value_id, sku_code, label, visible_if_json,
          hidden_if_json, archived)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
        [
          questionResult.rows[0].id,
          option.value_id,
          option.sku_code,
          option.label,
          option.visible_if_json ? JSON.stringify(option.visible_if_json) : null,
          option.hidden_if_json ? JSON.stringify(option.hidden_if_json) : null,
          option.archived,
        ]
      );
    }
  }

  return schemaVersion;
}

async function getStoredQuestionKeys(categoryCode, queryable = pool) {
  const result = await queryable.query(
    `SELECT DISTINCT answer.key
     FROM products p
     CROSS JOIN LATERAL jsonb_object_keys(
       CASE
         WHEN jsonb_typeof(p.details -> 'answers') = 'object' THEN p.details -> 'answers'
         ELSE '{}'::jsonb
       END
     ) AS answer(key)
     WHERE p.category = $1`,
    [categoryCode]
  );
  return new Set(result.rows.map((row) => row.key));
}

async function ensureLegacySkuSchemas() {
  const categories = await pool.query('SELECT code FROM categories ORDER BY code');

  for (const category of categories.rows) {
    const existing = await pool.query(
      'SELECT id FROM sku_schema_versions WHERE category_code = $1 LIMIT 1',
      [category.code]
    );
    if (existing.rows.length > 0) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const productCountResult = await client.query(
        'SELECT COUNT(*)::int AS count FROM products WHERE category = $1',
        [category.code]
      );
      const productCount = Number(productCountResult.rows[0].count);
      const storedKeys = productCount > 0
        ? await getStoredQuestionKeys(category.code, client)
        : null;
      const requiredResult = productCount > 0
        ? await client.query(
            `SELECT key FROM questions
             WHERE category_code = $1
               AND COALESCE(include_in_sku, 1) = 1
               AND required = 1`,
            [category.code]
          )
        : { rows: [] };
      const allowedKeys = storedKeys
        ? new Set([...storedKeys, ...requiredResult.rows.map((row) => row.key)])
        : null;
      const questions = await readCatalogSnapshot(category.code, {
        includeArchived: true,
        allowedQuestionKeys: allowedKeys,
        queryable: client,
      });
      const schemaVersion = await insertSnapshot(client, category.code, 1, questions);
      await client.query(
        `UPDATE products
         SET sku_schema_version_id = $1
         WHERE category = $2 AND sku_schema_version_id IS NULL`,
        [schemaVersion.id, category.code]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

async function getSchemaQuestions(schemaVersionId, queryable = pool) {
  const result = await queryable.query(
    `SELECT sq.id AS question_id, sq.question_key, sq.label AS question_label,
            sq.sku_index, sq.display_order, sq.required, sq.sku_separator,
            sq.visible_if_json AS question_visible_if,
            so.value_id, so.sku_code, so.label AS option_label,
            so.visible_if_json AS option_visible_if,
            so.hidden_if_json AS option_hidden_if, so.archived
     FROM sku_schema_questions sq
     LEFT JOIN sku_schema_options so ON so.schema_question_id = sq.id
     WHERE sq.schema_version_id = $1
     ORDER BY sq.sku_index, sq.id, so.id`,
    [Number(schemaVersionId)]
  );

  const questions = [];
  const byId = new Map();
  for (const row of result.rows) {
    if (!byId.has(row.question_id)) {
      const question = {
        id: row.question_key,
        key: row.question_key,
        label: row.question_label,
        sku_index: Number(row.sku_index),
        display_order: Number(row.display_order),
        required: Number(row.required),
        include_in_sku: 1,
        input_type: 'options',
        sku_separator: row.sku_separator || '',
        visible_if_json: row.question_visible_if || null,
        options: [],
      };
      byId.set(row.question_id, question);
      questions.push(question);
    }

    if (row.value_id === null || row.value_id === undefined) continue;
    byId.get(row.question_id).options.push({
      id: Number(row.value_id),
      value_id: Number(row.value_id),
      sku_code: String(row.sku_code),
      label: row.option_label,
      visible_if_json: row.option_visible_if || null,
      hidden_if_json: row.option_hidden_if || null,
      archived: row.archived ? 1 : 0,
    });
  }
  return questions;
}

async function getSchemaVersion(categoryCode, version, queryable = pool) {
  const result = await queryable.query(
    `SELECT * FROM sku_schema_versions
     WHERE category_code = $1 AND version = $2
     LIMIT 1`,
    [categoryCode, Number(version)]
  );
  if (result.rows.length === 0) return null;
  return {
    ...result.rows[0],
    version: Number(result.rows[0].version),
    questions: await getSchemaQuestions(result.rows[0].id, queryable),
  };
}

async function getActiveSchema(categoryCode, queryable = pool) {
  const result = await queryable.query(
    `SELECT version FROM sku_schema_versions
     WHERE category_code = $1 AND status = 'active'
     LIMIT 1`,
    [categoryCode]
  );
  if (result.rows.length === 0) return null;
  return getSchemaVersion(categoryCode, result.rows[0].version, queryable);
}

async function getSchemaStatus(categoryCode) {
  const active = await getActiveSchema(categoryCode);
  const draft = await readCatalogSnapshot(categoryCode);
  const versionsResult = await pool.query(
    `SELECT id, version, marker, status, published_at
     FROM sku_schema_versions
     WHERE category_code = $1
     ORDER BY version DESC`,
    [categoryCode]
  );
  return {
    categoryCode,
    active: active ? {
      id: active.id,
      version: active.version,
      marker: active.marker,
      publishedAt: active.published_at,
    } : null,
    draftChanged: active ? hashSnapshot(draft) !== active.config_hash : draft.length > 0,
    nextVersion: active ? active.version + 1 : 1,
    nextMarker: getVersionMarker(active ? active.version + 1 : 1),
    versions: versionsResult.rows.map((row) => ({
      ...row,
      version: Number(row.version),
    })),
  };
}

async function publishSkuSchema(categoryCode) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `sku-schema:${categoryCode}`,
    ]);
    const currentResult = await client.query(
      `SELECT * FROM sku_schema_versions
       WHERE category_code = $1 AND status = 'active'
       FOR UPDATE`,
      [categoryCode]
    );
    const current = currentResult.rows[0] || null;
    const questions = await readCatalogSnapshot(categoryCode, { queryable: client });
    if (questions.length === 0) {
      const err = new Error('Неможливо опублікувати порожню SKU-схему.');
      err.statusCode = 422;
      throw err;
    }
    validateSnapshot(questions);
    const nextHash = hashSnapshot(questions);
    if (current && nextHash === current.config_hash) {
      const err = new Error('У структурі артикула немає неопублікованих змін.');
      err.statusCode = 409;
      throw err;
    }

    if (current) {
      await client.query(
        `UPDATE sku_schema_versions SET status = 'archived' WHERE id = $1`,
        [current.id]
      );
    }
    const nextVersion = current ? Number(current.version) + 1 : 1;
    const published = await insertSnapshot(client, categoryCode, nextVersion, questions);
    await client.query('COMMIT');
    return {
      id: published.id,
      categoryCode,
      version: nextVersion,
      marker: published.marker,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getPublicConfig() {
  const config = await getAppConfig();
  for (const categoryCode of Object.keys(config.categories)) {
    const active = await getActiveSchema(categoryCode);
    if (!active) continue;
    const nonSkuQuestions = (config.questions[categoryCode] || []).filter(
      (question) => Number(question.include_in_sku) !== 1
    );
    config.questions[categoryCode] = [...active.questions, ...nonSkuQuestions]
      .sort((a, b) => Number(a.display_order) - Number(b.display_order));
    config.categories[categoryCode].sku_schema_version_id = Number(active.id);
    config.categories[categoryCode].sku_schema_version = active.version;
    config.categories[categoryCode].sku_schema_marker = active.marker;
  }
  return config;
}

module.exports = {
  ensureLegacySkuSchemas,
  getActiveSchema,
  getPublicConfig,
  getSchemaStatus,
  getSchemaVersion,
  getVersionMarker,
  hashSnapshot,
  parseVersionedSkuPart,
  publishSkuSchema,
  readCatalogSnapshot,
  validateSnapshot,
};
