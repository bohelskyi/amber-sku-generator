const { projectSupportProducts } = require('./source-support');

// One batched immutable-schema read on the caller's transaction, never a current
// active-schema fallback. Full questions are needed by the existing reconstruction.
async function loadSupportInputs(client, definition, products) {
  if (!definition.sourceSupport) return { products, schemas: [] };
  const categories = new Set(Object.keys(definition.sourceSupport.sources).map((key) => key.split('.')[0]));
  const ids = [...new Set(products.filter((p) => categories.has(p.category) && p.sku_schema_version_id != null)
    .map((p) => String(p.sku_schema_version_id)))];
  const { rows: schemas } = ids.length ? await client.query(`
    SELECT v.id, v.category_code, v.version,
      COALESCE((SELECT jsonb_agg(q ORDER BY q.sku_index, q.schema_question_id) FROM (
        SELECT sq.id AS schema_question_id, sq.question_key AS key, sq.label,
          sq.sku_index, sq.required, sq.sku_separator, sq.visible_if_json,
          COALESCE((SELECT jsonb_agg(o ORDER BY o.option_id) FROM (
            SELECT so.id AS option_id, so.value_id, so.sku_code, so.label,
              so.visible_if_json, so.hidden_if_json, so.archived
            FROM sku_schema_options so WHERE so.schema_question_id=sq.id
          ) o), '[]'::jsonb) AS options
        FROM sku_schema_questions sq WHERE sq.schema_version_id=v.id
      ) q), '[]'::jsonb) AS questions
    FROM sku_schema_versions v WHERE v.id=ANY($1::integer[]) ORDER BY v.id`, [ids]) : { rows: [] };
  return { products: projectSupportProducts(products, schemas), schemas };
}

module.exports = { loadSupportInputs };
