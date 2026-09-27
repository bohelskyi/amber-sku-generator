const { PublicHttpError } = require('../../http/errors');
const { HEADERS } = require('./magento-v1-data');
const invalid = () => { throw new PublicHttpError(400, 'Invalid display query', { code: 'TEMPLATE_COMMAND_INVALID' }); };

async function searchSampleProducts(client, input) {
  if (!input || Object.keys(input).some((k) => !['q', 'offset'].includes(k))
    || typeof input.q !== 'string' || input.q.trim().length < 2 || input.q.length > 160
    || (input.offset !== undefined && (!['string', 'number'].includes(typeof input.offset)
      || !/^(0|[1-9][0-9]{0,5})$/.test(String(input.offset))))) invalid();
  const offset = Number(input.offset || 0);
  const { rows } = await client.query(`SELECT id, full_sku, category, status
    FROM products WHERE strpos(lower(full_sku), lower($1)) > 0
    ORDER BY (lower(full_sku) = lower($1)) DESC, id DESC LIMIT $2 OFFSET $3`, [input.q.trim(), 21, offset]);
  return { products: rows.slice(0, 20), nextOffset: rows.length > 20 ? offset + 20 : null };
}

async function sourceDetails(client, input) {
  if (!input || Object.keys(input).some((k) => !['category', 'key'].includes(k))
    || typeof input.category !== 'string' || !Object.hasOwn(HEADERS, input.category) || typeof input.key !== 'string'
    || !/^[A-Za-z0-9_]{1,80}$/.test(input.key) || ['__proto__', 'constructor', 'prototype'].includes(input.key)) invalid();
  const parameters = [input.category, input.key, 513];
  const current = (await client.query(`SELECT q.label, q.include_in_sku, q.input_type,
    (SELECT COALESCE(jsonb_agg(o),'[]') FROM (SELECT value_id::text, label, sku_code
      FROM options WHERE question_id=q.id ORDER BY id LIMIT $3) o) AS options
    FROM questions q WHERE category_code=$1 AND key=$2 ORDER BY q.id LIMIT 2`, parameters)).rows;
  const historical = (await client.query(`SELECT q.label, v.version, v.status,
    (SELECT COALESCE(jsonb_agg(o),'[]') FROM (SELECT value_id::text, label, sku_code, archived
      FROM sku_schema_options WHERE schema_question_id=q.id ORDER BY id LIMIT $3) o) AS options
    FROM sku_schema_questions q JOIN sku_schema_versions v ON v.id=q.schema_version_id
    WHERE v.category_code=$1 AND q.question_key=$2 AND v.status IN ('active','archived')
    ORDER BY v.version DESC, q.id LIMIT 21`, parameters)).rows;
  const truncated = historical.length > 20 || [...current, ...historical].some((q) => q.options.length > 512);
  return { category: input.category, key: input.key, current: current.map((q) => ({ ...q, options: q.options.slice(0, 512) })),
    historical: historical.slice(0, 20).map((q) => ({ ...q, options: q.options.slice(0, 512) })), truncated };
}
module.exports = { searchSampleProducts, sourceDetails };
