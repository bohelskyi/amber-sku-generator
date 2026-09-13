const fs = require('node:fs/promises');
const path = require('node:path');
const { sanitizePlan } = require('./plan-sanitizer');

const explainTargets = [
  {
    id: 'catalog_hydration',
    text: `SELECT c.code, c.name, q.id, q.key, o.value_id, o.sku_code
           FROM categories c
           LEFT JOIN questions q ON q.category_code = c.code
           LEFT JOIN options o ON o.question_id = q.id
           ORDER BY c.code, q.display_order, q.id, o.id`,
    parameters: [],
  },
  {
    id: 'schema_lookup',
    text: `SELECT v.id, v.category_code, v.version, v.marker, q.question_key, o.value_id
           FROM sku_schema_versions v
           LEFT JOIN sku_schema_questions q ON q.schema_version_id = v.id
           LEFT JOIN sku_schema_options o ON o.schema_question_id = q.id
           WHERE v.category_code = $1 AND v.status = 'active'
           ORDER BY q.sku_index, o.id`,
    parameters: ['PF'],
  },
  {
    id: 'product_sequence_common',
    text: `SELECT sequence_number, full_sku FROM products
           WHERE base_sku = ANY($1::text[])
           ORDER BY sequence_number DESC LIMIT 1`,
    parameters: [['PF1']],
  },
  {
    id: 'product_variation_rare',
    text: `SELECT full_sku FROM sku_registry
           WHERE full_sku = $1 OR full_sku LIKE $2`,
    parameters: ['PF1999999', 'PF1999999-%'],
  },
  {
    id: 'pricing_context',
    text: `SELECT s.id, s.category_code, s.match_json, s.axis_x_key, s.axis_y_key,
                  s.price_mode, m.x_val, m.y_val, m.price
           FROM price_scenarios s LEFT JOIN price_matrix m ON m.scenario_id = s.id
           WHERE s.category_code = $1 AND s.status = 'active'
           ORDER BY s.priority DESC, s.id, m.x_val, m.y_val`,
    parameters: ['PF'],
  },
  {
    id: 'correction_queue_common',
    text: `SELECT id, source_product_id, status, updated_at
           FROM correction_requests
           WHERE status = ANY($1::text[])
           ORDER BY updated_at DESC, id DESC LIMIT 200`,
    parameters: [['pending', 'in_progress']],
  },
  {
    id: 'correction_history_page',
    text: `SELECT id, source_product_id, corrected_product_id, source_sku, corrected_sku,
                  old_payload, new_payload, created_at
           FROM product_corrections
           ORDER BY created_at DESC, id DESC LIMIT 200 OFFSET 0`,
    parameters: [],
  },
  {
    id: 'repricing_candidates',
    text: `SELECT id, full_sku, category, total_price_uah, details
           FROM products
           WHERE category = $1 AND COALESCE(status, 'active') = 'active'
           ORDER BY id`,
    parameters: ['PF'],
  },
  {
    id: 'timeline_recursive_lineage',
    text: `WITH RECURSIVE lineage AS (
             SELECT id, corrected_from_product_id, corrected_to_product_id, 0 AS depth
             FROM products WHERE id = $1
             UNION ALL
             SELECT p.id, p.corrected_from_product_id, p.corrected_to_product_id, l.depth + 1
             FROM products p JOIN lineage l ON p.id = l.corrected_to_product_id
             WHERE l.depth < 100
           ) SELECT * FROM lineage ORDER BY depth`,
    parameters: [1],
  },
  {
    id: 'export_range_common',
    text: `SELECT id, full_sku, category, total_price_uah, details, created_at
           FROM products
           WHERE id >= $1 AND id <= $2 AND COALESCE(exclude_from_export, 0) = 0
           ORDER BY id`,
    parameters: [1, 2147483647],
  },
];

function collectPlanSummary(planArtifact) {
  const root = planArtifact?.[0]?.Plan || {};
  const nodes = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    nodes.push({
      nodeType: node['Node Type'],
      relation: node['Relation Name'] || null,
      actualRows: node['Actual Rows'] ?? null,
      planRows: node['Plan Rows'] ?? null,
      loops: node['Actual Loops'] ?? null,
      sharedHitBlocks: node['Shared Hit Blocks'] ?? 0,
      sharedReadBlocks: node['Shared Read Blocks'] ?? 0,
      tempReadBlocks: node['Temp Read Blocks'] ?? 0,
      tempWrittenBlocks: node['Temp Written Blocks'] ?? 0,
    });
    for (const child of node.Plans || []) visit(child);
  }
  visit(root);
  return {
    planningTimeMs: planArtifact?.[0]?.['Planning Time'] ?? null,
    executionTimeMs: planArtifact?.[0]?.['Execution Time'] ?? null,
    nodes,
  };
}

async function captureExplainPlans(client, outputDirectory) {
  await client.query('ANALYZE');
  const summaries = [];
  await fs.mkdir(outputDirectory, { recursive: true });
  for (const target of explainTargets) {
    for (const temperature of ['first', 'warm']) {
      await client.query('BEGIN');
      try {
        const result = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${target.text}`,
          target.parameters
        );
        const sanitized = sanitizePlan(result.rows[0]['QUERY PLAN']);
        const fileName = `${target.id}.${temperature}.json`;
        await fs.writeFile(
          path.join(outputDirectory, fileName),
          `${JSON.stringify(sanitized, null, 2)}\n`,
          'utf8'
        );
        summaries.push({ id: target.id, temperature, fileName, ...collectPlanSummary(sanitized) });
      } finally {
        await client.query('ROLLBACK');
      }
    }
  }
  await fs.writeFile(
    path.join(outputDirectory, 'summary.json'),
    `${JSON.stringify(summaries, null, 2)}\n`,
    'utf8'
  );
  return summaries;
}

module.exports = { captureExplainPlans, collectPlanSummary, explainTargets };
