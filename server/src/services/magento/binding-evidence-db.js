const { loadMagentoCatalog } = require('../magento-products-v1');
const { loadDraftPreviewProducts } = require('../export-templates/draft-inputs');
const { loadSupportInputs } = require('../export-templates/support-inputs');
const { materializeMagentoV1 } = require('../export-templates/magento-v1-definition');
const { compileDefinition } = require('../export-templates/definition');
const { routeTools } = require('./binding-evidence-routes');
const { MagentoIntegrationError } = require('./errors');
const { PLANS: COMPATIBILITY_PLANS, SIZE_CASES } = require('./compatibility-evidence-plans');

const KNOWN_CASES = Object.freeze([
  { category: 'KL', key: 'addit', valueId: '1', target: 'kulony_dodatkovo', reportedOptionId: '6047' },
  { category: 'AR', key: 'size', valueId: '28', target: 'rozmir_kartyny' },
  { category: 'CH', key: 'count', valueId: '9', target: 'kilkist_namystyn' },
]);
const ROW_LIMIT = 50000;
const CANDIDATES_PER_ROUTE = 3;
function invalid() { throw new MagentoIntegrationError('MAGENTO_BINDING_EVIDENCE_INVALID'); }
function bounded(rows) { if (rows.length > ROW_LIMIT) invalid(); return rows; }

function hydrate(rows, historical = false) {
  const questions = new Map();
  for (const row of rows) {
    const id = row.question_id;
    if (!questions.has(id)) questions.set(id, { id, category_code: row.category_code, key: row.key,
      label: row.question_label, kind: historical || row.input_type === 'options' ? 'semantic'
        : row.input_type === 'text' ? 'information' : 'unknown',
      input_type: historical ? 'options' : row.input_type, include_in_sku: historical ? 1 : row.include_in_sku,
      required: row.required, visible_if_json: row.question_visible_if,
      ...(historical ? { schemaId: row.schema_id, version: row.version, schemaStatus: row.schema_status } : {}), options: [] });
    if (row.option_id !== null) questions.get(id).options.push({ id: row.option_id,
      value_id: String(row.value_id), sku_code: row.sku_code, label: row.option_label,
      archived: row.archived, visible_if_json: row.option_visible_if, hidden_if_json: row.option_hidden_if });
  }
  return [...questions.values()];
}

// No application startup, lifecycle gate, advisory locks, seed or migration paths.
// Finish the local repeatable-read snapshot before making any remote requests.
async function readAmberEvidence(databasePool, { templateVersionId, mode, supportSystem = false, sku } = {}) {
  if (mode !== undefined && mode !== 'compatibility') invalid();
  const client = await databasePool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const activation = (await client.query(`SELECT implementation, template_version_id, generation
      FROM export_template_activation WHERE id=1`)).rows[0] || null;
    let compiled;
    let template;
    if (templateVersionId) {
      const versionId = templateVersionId === 'selected' ? activation?.template_version_id : templateVersionId;
      if (!versionId) invalid();
      const row = (await client.query(`SELECT id, template_id, version_number, definition, definition_hash,
        evaluator_version, output_contract, format_version FROM export_template_versions WHERE id=$1`, [versionId])).rows[0];
      if (!row) invalid();
      compiled = compileDefinition(row.definition);
      if (compiled.hash !== row.definition_hash || row.evaluator_version !== compiled.definition.evaluatorVersion
        || row.output_contract !== compiled.definition.outputContract || row.format_version !== compiled.definition.formatVersion) invalid();
      template = { kind: 'published', versionId: row.id, templateId: row.template_id, versionNumber: row.version_number };
    }
    const categories = compiled?.definition.evaluatorVersion === require('../export-templates/version-contract').EXTENSIBLE_EVALUATOR
      ? compiled.definition.groups.map((g) => g.route)
      : Object.keys(require('../export-templates/magento-v1-data').GROUPS);
    const { rows: currentRows } = await client.query(`SELECT q.id AS question_id, q.category_code, q.key,
      q.label AS question_label, q.input_type, q.include_in_sku, q.required,
      q.visible_if_json AS question_visible_if, o.id AS option_id, o.value_id, o.sku_code,
      o.label AS option_label, o.archived, o.visible_if_json AS option_visible_if, o.hidden_if_json AS option_hidden_if
      FROM questions q LEFT JOIN options o ON o.question_id=q.id
      WHERE q.category_code=ANY($1::text[]) ORDER BY q.category_code, q.id, o.id LIMIT $2`, [categories, ROW_LIMIT + 1]);
    const current = hydrate(bounded(currentRows));
    if (new Set(current.map((q) => `${q.category_code}.${q.key}`)).size !== current.length) invalid();
    const { rows: schemas } = await client.query(`SELECT id, category_code, version, status, published_at, config_hash
      FROM sku_schema_versions WHERE category_code=ANY($1::text[]) AND published_at IS NOT NULL
      ORDER BY category_code, version, id LIMIT $2`, [categories, ROW_LIMIT + 1]);
    bounded(schemas);
    const { rows: historicalRows } = await client.query(`SELECT q.id AS question_id, v.category_code, q.question_key AS key,
      q.label AS question_label, q.required, q.visible_if_json AS question_visible_if,
      v.id AS schema_id, v.version, v.status AS schema_status, o.id AS option_id, o.value_id, o.sku_code,
      o.label AS option_label, o.archived, o.visible_if_json AS option_visible_if, o.hidden_if_json AS option_hidden_if
      FROM sku_schema_versions v JOIN sku_schema_questions q ON q.schema_version_id=v.id
      LEFT JOIN sku_schema_options o ON o.schema_question_id=q.id
      WHERE v.category_code=ANY($1::text[]) AND v.published_at IS NOT NULL
      ORDER BY v.category_code, v.version, q.id, o.id LIMIT $2`, [categories, ROW_LIMIT + 1]);
    const historical = hydrate(bounded(historicalRows), true);
    if (!templateVersionId) {
      let definition = materializeMagentoV1(await loadMagentoCatalog(client), { publicSku: true });
      if (supportSystem) {
        const { loadSourceEvidence, validateSourceReferences } = require('../export-templates/source-references');
        const evidence = await loadSourceEvidence(client);
        definition = require('../export-templates/source-support').upgradeSourceSupport(definition, evidence);
        const diagnostics = validateSourceReferences(definition, evidence);
        if (diagnostics.length) throw require('./binding-contract').error(422, 'TEMPLATE_SOURCE_INVALID',
          'Unresolved bootstrap evaluator sources', { diagnostics });
      }
      compiled = compileDefinition(definition);
      template = { kind: 'system', source: 'code-backed-magento-products-v1' };
    }
    template = { ...template, definitionHash: compiled.hash, evaluatorVersion: compiled.definition.evaluatorVersion,
      outputContract: compiled.definition.outputContract, activation };
    const plans = routeTools(compiled.definition).plans;
    if (plans.length > 24) invalid();
    const { rows: candidates } = mode === 'compatibility' ? await client.query(`SELECT r.id AS route_id,
      p.id AS product_id, p.status AS local_status, p.eligible_count
      FROM jsonb_to_recordset($1::jsonb) AS r(id text, category text, key text, value text,
        required jsonb, scan int)
      CROSS JOIN LATERAL (SELECT p.id, p.status, count(*) OVER ()::int AS eligible_count
        FROM products p WHERE p.category=r.category AND p.status='active'
        AND p.corrected_to_product_id IS NULL
        AND p.full_sku IS NOT NULL AND btrim(p.full_sku)<>''
        AND (r.key IS NULL OR p.details->'answers'->>r.key=r.value)
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(r.required) k(key)
          WHERE COALESCE(btrim(p.details->'answers'->>k.key), '')='')
        ORDER BY p.id LIMIT r.scan) p ORDER BY r.id, p.id`, [JSON.stringify(COMPATIBILITY_PLANS)])
      : await client.query(`SELECT r.id AS route_id, p.id AS product_id
      FROM jsonb_to_recordset($1::jsonb) AS r(id text, "amberGroup" text, predicates jsonb)
      CROSS JOIN LATERAL (SELECT p.id,
        EXISTS (SELECT 1 FROM product_export_revisions e WHERE e.product_id=p.id AND e.has_product_snapshot) AS exposed,
        (p.corrected_from_product_id IS NULL) AS uncorrected, (p.exclude_from_export=0) AS exportable
        FROM products p WHERE p.category=r."amberGroup"
        AND p.status='active' AND p.corrected_to_product_id IS NULL AND p.full_sku IS NOT NULL AND btrim(p.full_sku)<>''
        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.predicates) c
          WHERE (COALESCE(p.details->'answers'->>(c->>'key'), '') = c->>'value') IS DISTINCT FROM (c->>'equal')::boolean)
        ORDER BY exposed DESC, uncorrected DESC, exportable DESC, p.id DESC LIMIT $2) p
      ORDER BY r.id, p.exposed DESC, p.uncorrected DESC, p.exportable DESC, p.id DESC`, [JSON.stringify(plans), CANDIDATES_PER_ROUTE]);
    const ids = [...new Set(candidates.map((p) => p.product_id))];
    if (sku !== undefined) {
      require('./sync-preview-db').selection({ sku });
      const selected = await require('../product/public-identity').resolveProductLookup(client, sku);
      if (!selected.product || selected.internalMatchCount > 1) throw require('./binding-contract').error(422, 'MAGENTO_PREVIEW_PRODUCT_NOT_UNIQUE', 'SKU must select one product');
      if (!ids.includes(selected.product.id)) ids.push(selected.product.id);
    }
    const { products, missingProductIds } = await loadDraftPreviewProducts(client, ids);
    if (missingProductIds.length) invalid();
    const supported = await loadSupportInputs(client, compiled.definition, products);
    const { rows: usage } = await client.query(`SELECT c.category, c.key, c."valueId",
      count(p.id)::int AS total, count(p.id) FILTER (WHERE p.status='active' AND p.corrected_to_product_id IS NULL)::int AS current
      FROM jsonb_to_recordset($1::jsonb) AS c(category text, key text, "valueId" text)
      LEFT JOIN products p ON p.category=c.category AND p.details->'answers'->>c.key=c."valueId"
      GROUP BY c.category, c.key, c."valueId" ORDER BY c.category, c.key, c."valueId"`,
    [JSON.stringify(mode === 'compatibility' ? SIZE_CASES : KNOWN_CASES)]);
    const observedAt = (await client.query('SELECT transaction_timestamp() AS observed_at')).rows[0].observed_at;
    await client.query('COMMIT');
    return { observedAt, current, historical, schemas, template, compiled, plans, candidates,
      products: supported.products, usage };
  } catch (cause) {
    await client.query('ROLLBACK').catch(() => {});
    throw cause;
  } finally { client.release(); }
}

module.exports = { readAmberEvidence, KNOWN_CASES, CANDIDATES_PER_ROUTE };
