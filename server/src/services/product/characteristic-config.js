const { hashPayload } = require('../pricing/pricing-context-fingerprint');

// Semantic creation evidence is separate from historical SKU schema publications.
// Optional metadata is read through JSON so migration 060 does not depend on 061.
async function readCharacteristicConfiguration(queryable, categoryCode) {
  const result = await queryable.query(`SELECT to_jsonb(c) AS category,
    COALESCE((SELECT jsonb_agg(to_jsonb(q) || jsonb_build_object('options',
      COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM options o WHERE o.question_id=q.id), '[]'::jsonb))
      ORDER BY COALESCE(q.display_order,q.sku_index),q.id)
      FROM questions q WHERE q.category_code=c.code), '[]'::jsonb) AS questions
    FROM categories c WHERE c.code=$1`, [categoryCode]);
  if (!result.rows.length) throw Object.assign(new Error(`Категорію ${categoryCode} не знайдено.`), { statusCode: 404 });
  const { category, questions } = result.rows[0];
  const snapshot = { contract: 'product-characteristics-v1', category_code: category.code,
    requires_weight: Number(category.requires_weight), questions: questions.map((q) => ({
      id: q.id, key: q.key, label: q.label, input_type: q.input_type,
      required: Number(q.required), display_order: q.display_order,
      include_in_sku: Number(q.include_in_sku), visible_if_json: q.visible_if_json,
      archived: Boolean(q.archived), numeric_validation: q.numeric_validation ?? null,
      options: q.options.map((o) => ({ value_id: o.value_id, label: o.label,
        label_en: o.label_en ?? null, visible_if_json: o.visible_if_json,
        hidden_if_json: o.hidden_if_json, archived: Boolean(o.archived) })),
    })) };
  const keys = snapshot.questions.map((q) => q.key);
  if (new Set(keys).size !== keys.length) throw Object.assign(new Error('Повторні ключі характеристик категорії.'), { statusCode: 422 });
  return { ...snapshot, config_hash: hashPayload(snapshot) };
}

async function persistCharacteristicConfiguration(queryable, configuration) {
  const { config_hash: hash, ...snapshot } = configuration;
  if (hashPayload(snapshot) !== hash) throw new Error('Characteristic snapshot hash mismatch');
  await queryable.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`characteristic-config:${configuration.category_code}`]);
  const existing = await queryable.query('SELECT id,version FROM product_characteristic_versions WHERE category_code=$1 AND config_hash=$2', [configuration.category_code, hash]);
  if (existing.rows.length) return existing.rows[0];
  return (await queryable.query(`INSERT INTO product_characteristic_versions(category_code,version,config_hash,snapshot)
    SELECT $1,COALESCE(max(version),0)+1,$2,$3::jsonb FROM product_characteristic_versions WHERE category_code=$1
    RETURNING id,version`, [configuration.category_code, hash, JSON.stringify(snapshot)])).rows[0];
}

async function getCharacteristicVersion(queryable, id) {
  const result = await queryable.query('SELECT id,version,category_code,config_hash,snapshot FROM product_characteristic_versions WHERE id=$1', [id]);
  const row = result.rows[0];
  if (!row) return null;
  if (hashPayload(row.snapshot) !== row.config_hash) throw new Error('Stored characteristic snapshot hash mismatch');
  return { ...row.snapshot, id: row.id, version: row.version, config_hash: row.config_hash };
}

module.exports = { readCharacteristicConfiguration, persistCharacteristicConfiguration, getCharacteristicVersion };
