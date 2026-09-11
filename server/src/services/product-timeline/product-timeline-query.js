const pool = require('../../db/pool');
const { nullableNumber } = require('./historical-normalization');

async function loadTimelineSeedRows(querySku, database = pool) {
  const result = await database.query(
    `SELECT id FROM products WHERE full_sku = $1 ORDER BY id`,
    [querySku]
  );
  return result.rows;
}

async function loadProductTimelineData(seedId, database = pool) {
  const lineageResult = await database.query(
    `WITH RECURSIVE edges AS (
       SELECT COALESCE(pc.source_product_id, source_match.id) AS source_id,
              COALESCE(pc.corrected_product_id, corrected_match.id) AS corrected_id
       FROM product_corrections pc
       LEFT JOIN LATERAL (
         SELECT MIN(id)::integer AS id FROM products
         WHERE full_sku = pc.source_sku HAVING COUNT(*) = 1
       ) source_match ON TRUE
       LEFT JOIN LATERAL (
         SELECT MIN(id)::integer AS id FROM products
         WHERE full_sku = pc.corrected_sku HAVING COUNT(*) = 1
       ) corrected_match ON TRUE
       WHERE COALESCE(pc.source_product_id, source_match.id) IS NOT NULL
         AND COALESCE(pc.corrected_product_id, corrected_match.id) IS NOT NULL
       UNION
       SELECT id, corrected_to_product_id FROM products WHERE corrected_to_product_id IS NOT NULL
       UNION
       SELECT corrected_from_product_id, id FROM products WHERE corrected_from_product_id IS NOT NULL
     ), lineage(id) AS (
       SELECT $1::integer
       UNION
       SELECT CASE WHEN e.source_id = l.id THEN e.corrected_id ELSE e.source_id END
       FROM lineage l
       JOIN edges e ON e.source_id = l.id OR e.corrected_id = l.id
     )
     SELECT p.*
     FROM products p
     JOIN lineage l ON l.id = p.id`,
    [seedId]
  );
  const products = lineageResult.rows;
  const productIds = products.map((product) => Number(product.id));
  const productSkus = products.map((product) => product.full_sku);

  const [correctionResult, requestResult, repricingResult] = await Promise.all([
    database.query(
      `SELECT * FROM product_corrections
       WHERE source_product_id = ANY($1::int[]) OR corrected_product_id = ANY($1::int[])
          OR source_sku = ANY($2::text[]) OR corrected_sku = ANY($2::text[])
       ORDER BY created_at, id`,
      [productIds, productSkus]
    ),
    database.query(
      `SELECT * FROM correction_requests
       WHERE source_product_id = ANY($1::int[])
       ORDER BY created_at, id`,
      [productIds]
    ),
    database.query(
      `SELECT ri.*, b.scope, b.scenario_name, b.status AS batch_status,
              b.applied_at, b.rolled_back_at, b.applied_by_user_id, b.rolled_back_by_user_id
       FROM repricing_items ri
       JOIN repricing_batches b ON b.id = ri.batch_id
       WHERE ri.product_id = ANY($1::int[])
       ORDER BY COALESCE(b.applied_at, ri.created_at), ri.id`,
      [productIds]
    ),
  ]);
  const corrections = correctionResult.rows;
  const requests = requestResult.rows;
  const repricingItems = repricingResult.rows;
  const requestIds = requests.map((request) => String(request.id));
  const batchIds = [...new Set(repricingItems.map((item) => String(item.batch_id)))];
  const productSubjectIds = productIds.map(String);
  const auditResult = await database.query(
    `SELECT id, event_key, actor_user_id, actor_snapshot, subject_type, subject_id,
            details, occurred_at
     FROM audit_events
     WHERE (subject_type = 'product' AND subject_id = ANY($1::text[]))
        OR (subject_type = 'correction_request' AND subject_id = ANY($2::text[]))
        OR (subject_type = 'repricing_batch' AND subject_id = ANY($3::text[]))
     ORDER BY occurred_at, id`,
    [productSubjectIds, requestIds, batchIds]
  );

  const schemaIds = new Set(
    products.map((product) => nullableNumber(product.sku_schema_version_id)).filter(Boolean)
  );
  for (const correction of corrections) {
    const oldSchemaId = nullableNumber(correction.old_payload?.skuSchemaVersionId);
    const newSchemaId = nullableNumber(correction.new_payload?.skuSchemaVersionId);
    if (oldSchemaId) schemaIds.add(oldSchemaId);
    if (newSchemaId) schemaIds.add(newSchemaId);
  }
  for (const request of requests) {
    const oldSchemaId = nullableNumber(request.old_payload?.skuSchemaVersionId);
    const newSchemaId = nullableNumber(request.proposed_payload?.skuSchemaVersionId);
    if (oldSchemaId) schemaIds.add(oldSchemaId);
    if (newSchemaId) schemaIds.add(newSchemaId);
  }
  const schemaResult = schemaIds.size === 0
    ? { rows: [] }
    : await database.query(
      `SELECT q.schema_version_id, q.question_key, q.label AS question_label,
              o.id AS option_id, o.value_id, o.label AS option_label,
              o.visible_if_json, o.hidden_if_json
       FROM sku_schema_questions q
       LEFT JOIN sku_schema_options o ON o.schema_question_id = q.id
       WHERE q.schema_version_id = ANY($1::int[])
       ORDER BY q.schema_version_id, q.sku_index, o.id`,
      [[...schemaIds]]
    );

  return {
    products,
    corrections,
    requests,
    repricingItems,
    audits: auditResult.rows,
    schemaRows: schemaResult.rows,
  };
}

module.exports = {
  loadProductTimelineData,
  loadTimelineSeedRows,
};
