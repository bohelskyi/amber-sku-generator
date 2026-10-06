const { projectSupportProducts, projectProspectiveSupportProduct } = require('./source-support');

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
  const characteristicVersions = [];
  if (definition.evaluatorVersion === require('./version-contract').CHARACTERISTIC_EVALUATOR) {
    const ids = [...new Set(products.map((p) => p.characteristic_version_id).filter(Boolean))];
    for (const id of ids) {
      const version = await require('../product/characteristic-config').getCharacteristicVersion(client, id);
      if (version) characteristicVersions.push(version);
    }
  }
  return { products: projectSupportProducts(products, schemas, characteristicVersions), schemas, characteristicVersions };
}

async function loadProspectiveSupportInput(client, definition, product, expectedConfigHash) {
  const configuration = await require('../product/characteristic-config').readCharacteristicConfiguration(client, product.category);
  if (typeof expectedConfigHash !== 'string' || configuration.config_hash !== expectedConfigHash) {
    throw Object.assign(new Error('Prospective characteristic configuration changed'), { code: 'PRODUCT_CHARACTERISTICS_CHANGED', statusCode: 409 });
  }
  return projectProspectiveSupportProduct(definition, product, configuration);
}

module.exports = { loadSupportInputs, loadProspectiveSupportInput };
