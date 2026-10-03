const editor = require('./integration-editor.service');
const { getAppConfig } = require('../catalog/catalog-read-model');
const { semanticReadiness } = require('./integration-readiness');
const { entries } = require('./binding-review');
const { originHash } = require('./binding-contract');
const { presentProblem } = require('./sync-problems');
const { historicalAmbiguitySql } = require('./lifecycle-issue');

// Match the daily problem summary's identities, using each request/deletion's
// exact product pointer. Joining all historical revisions by identity multiplies
// problems and can attribute a recount's issue to its former category.
const OPERATIONAL_COUNTS_SQL = `WITH pending AS (
  SELECT r.public_product_identity_id AS identity_id,p.category,(${historicalAmbiguitySql}) AS historical_ambiguity,
    CASE WHEN r.reason_code='reconciliation_required' THEN jsonb_build_array(jsonb_build_object('code',r.reason_code))
      WHEN n.state IN ('conflict','baseline_required') THEN jsonb_build_array(jsonb_build_object('code',
        CASE WHEN n.state='conflict' THEN 'NAME_CONFLICT' ELSE 'NAME_BASELINE_REQUIRED' END))
      WHEN jsonb_array_length(r.diagnostics)>0 THEN r.diagnostics
      ELSE jsonb_build_array(jsonb_build_object('code',COALESCE(r.reason_code,'data_or_binding'))) END AS reasons
  FROM magento_product_sync_requests r JOIN products p ON p.id=r.product_id
  LEFT JOIN product_full_export_state f ON f.product_id=p.id
  LEFT JOIN magento_name_sync_states n ON n.public_product_identity_id=r.public_product_identity_id AND n.origin_hash=$1
  WHERE r.state='needs_attention' AND NOT EXISTS (SELECT 1 FROM magento_test_deletions d
    WHERE d.public_product_identity_id=r.public_product_identity_id AND d.state<>'finalized')
  UNION ALL
  SELECT d.public_product_identity_id,p.category,false,'[{"code":"TEST_DELETION_PENDING"}]'::jsonb
  FROM magento_test_deletions d JOIN products p ON p.id=d.product_id WHERE d.state<>'finalized'
), classified AS (
  SELECT identity_id,category,CASE WHEN historical_ambiguity AND reason->>'code'='AMBER_SYNC_ELIGIBILITY_UNRESOLVED'
    THEN 'LIFECYCLE_HISTORICAL_AMBIGUITY' ELSE COALESCE(reason->>'code','data_or_binding') END AS code
  FROM pending CROSS JOIN LATERAL jsonb_array_elements(reasons) reason
)
SELECT category,code,grouping(category,code)::int AS level,count(DISTINCT identity_id)::int AS count
FROM classified GROUP BY GROUPING SETS ((category,code),(category),()) ORDER BY category,code`;

async function operationalCounts(client, origin) {
  const rows = (await client.query(OPERATIONAL_COUNTS_SQL, [origin])).rows;
  const categories = new Map();
  const category = (code) => {
    if (!categories.has(code)) categories.set(code, { state: 'known', count: 0, reasons: [] });
    return categories.get(code);
  };
  let count = 0;
  for (const row of rows) {
    if (row.level === 3) count = row.count;
    else if (row.level === 1) category(row.category).count = row.count;
    else category(row.category).reasons.push({ ...presentProblem({ code: row.code }), count: row.count });
  }
  return { count, categories };
}

function preparationSummary(category, revision, reviewEntries = []) {
  const reasons = [];
  const add = (code, message, count) => { if (count) reasons.push({ code, message, count }); };
  if (!category.routes.length) {
    add('NOT_CONNECTED', 'Ще не підключено', 1);
  } else if (!category.routes.every((route) => route.reviewState === 'blocked')) {
    const bindings = revision.bindings;
    const routeByKey = new Map(category.routes.map((route) => [route.routeKey, route]));
    const attributeByKey = new Map(bindings.attributes.map((attribute) => [attribute.bindingKey, attribute]));
    const excluded = (entry) => {
      const attribute = attributeByKey.get(entry.decision?.bindingKey || entry.bindingKey)
        || bindings.attributes.find((item) => item.routeKey === entry.routeKey && item.rowId === entry.row && item.target === entry.target);
      const route = routeByKey.get(entry.routeKey || attribute?.routeKey);
      return entry.decision?.reviewState === 'blocked' || route?.reviewState === 'blocked'
        || attribute?.reviewState === 'blocked';
    };
    add('SKU_SCHEMA_REQUIRED', 'Потрібна опублікована схема SKU перед використанням', category.schema ? 0 : 1);
    add('MAPPING_MISSING', 'Потрібні відповідності для нових значень', category.values.filter((value) =>
      value.state !== 'not_applicable' && value.mappings.length === 0).length);
    add('MAPPING_REVIEW_REQUIRED', 'Потрібно переглянути непідтверджені відповідності', reviewEntries.filter((entry) =>
      entry.group === category.code && !excluded(entry) && entry.decision.reviewState !== 'approved').length);
    const structural = new Set();
    for (const value of category.values) {
      for (const mapping of value.mappings) {
        if (!['drifted', 'blocked'].includes(mapping.state)) continue;
        const decisions = bindings.options.filter((option) => option.sourceKind === 'semantic' && option.amberGroup === category.code
          && option.questionKey === value.questionKey && option.valueId === value.valueId
          && attributeByKey.get(option.bindingKey)?.routeKey === mapping.routeKey
          && attributeByKey.get(option.bindingKey)?.attributeCode === mapping.attribute);
        if (decisions.some((decision) => !excluded({ decision }))) {
          structural.add(`${mapping.routeKey}/${mapping.attribute}/${value.questionKey}/${value.valueId}`);
        }
      }
    }
    for (const diagnostic of category.diagnostics) {
      const attribute = attributeByKey.get(diagnostic.bindingKey);
      const routeKey = diagnostic.routeKey || attribute?.routeKey;
      if (routeKey && !routeByKey.has(routeKey)) continue;
      if (!excluded({ ...diagnostic, routeKey })) structural.add(JSON.stringify(diagnostic));
    }
    add('STRUCTURE_REVIEW_REQUIRED', 'Потрібна підготовка структурних відповідностей', structural.size);
  }
  return { needed: reasons.length > 0, count: reasons.reduce((sum, reason) => sum + reason.count, 0), reasons };
}

async function overview(config, { canViewProducts = false, ...options } = {}) {
  return editor.read(options, async (client) => {
    const origin = config.configured ? originHash(config.baseUrl) : '';
    const activation = (await client.query('SELECT enabled,installation_key FROM magento_auto_sync_activation WHERE singleton')).rows[0];
    const revision = await editor.selected(client, config);
    const compiled = revision ? await editor.compiledRevision(client, revision) : null;
    const catalog = await getAppConfig(client);
    const schemas = (await client.query(`SELECT id,category_code,version,published_at FROM sku_schema_versions
      WHERE status='active' ORDER BY category_code,version DESC`)).rows;
    const installationKey = activation?.installation_key || null;
    const metadata = (await client.query(`SELECT
      (SELECT count(*)::int FROM magento_binding_revisions WHERE origin_hash=$1 AND installation_key=$2 AND state='draft') AS drafts,
      transaction_timestamp() AS at`, [origin, installationKey])).rows[0];
    const observation = (await client.query(`SELECT id,state,observed_at FROM magento_binding_revisions
      WHERE origin_hash=$1 AND installation_key=$2 ORDER BY observed_at DESC,created_at DESC,id LIMIT 1`,
    [origin, installationKey])).rows[0];
    const template = revision ? (await client.query('SELECT version_number FROM export_template_versions WHERE id=$1', [revision.templateVersionId])).rows[0] : null;
    const problems = canViewProducts ? await operationalCounts(client, origin) : null;
    const unknown = { state: 'unavailable', count: null, reasons: [] };
    const reviewEntries = revision ? entries(revision) : [];
    const categories = semanticReadiness(catalog, schemas, revision, compiled?.compiled.definition).map((category) => ({
      code: category.code, name: category.name,
      operational: problems ? problems.categories.get(category.code) || { state: 'known', count: 0, reasons: [] } : unknown,
      preparation: preparationSummary(category, revision, reviewEntries), impact: 'unexamined',
    }));
    // Retained products can refer to historical category codes no longer present
    // in the mutable catalog. Recorded problems must still remain reachable.
    for (const [code, operational] of problems?.categories || []) {
      if (!categories.some((category) => category.code === code)) categories.push({ code, name: code, operational,
        preparation: { needed: false, count: 0, reasons: [] }, impact: 'unexamined' });
    }
    return { integration: {
      configured: config.configured === true,
      activePublication: revision ? { id: revision.id, versionNumber: revision.versionNumber, revision: revision.revision,
        templateId: revision.templateId, templateVersionId: revision.templateVersionId, templateVersionNumber: template?.version_number ?? null,
        publishedAt: revision.publishedAt, observedAt: revision.observedAt } : null,
      delivery: { state: activation ? activation.enabled ? 'enabled' : 'disabled' : 'unknown' },
      operational: problems ? { state: 'known', count: problems.count } : { state: 'unavailable', count: null },
      structureObservation: observation ? { observedAt: observation.observed_at, bindingId: observation.id, state: observation.state } : null,
      draftCount: metadata.drafts, asOf: metadata.at,
    }, categories: categories.sort((a, b) => a.code.localeCompare(b.code)) };
  });
}

module.exports = { overview, operationalCounts, preparationSummary };
