const { LIMITS } = require('./definition');
const { PRODUCT_FIELDS } = require('./input-projection');
const { HEADERS } = require('./magento-v1-data');

// Approved stored-information contract, not a cross-key alias or inferred lineage.
// The original Magento mapper and docs/EXPORTS.md retain this exact legacy key
// after pedant_size in ordered answer-v1 fallback. No other JSON key is approved.
const HISTORICAL_INFORMATION_SOURCES = Object.freeze([
  Object.freeze({ category: 'KL', key: 'exact_size', label: 'Історичний розмір кулона',
    outputContract: 'magento-products-v1', evaluatorVersion: 'magento-declarative-1' }),
]);

const OPERATIONS = Object.freeze(['literal', 'source', 'ref', 'text', 'present', 'semanticKey',
  'lookup', 'firstPresent', 'when', 'eq', 'in', 'all', 'any', 'not', 'catalogRule',
  'questionValue', 'numberText', 'decimalText', 'numericBand', 'interpolate', 'join', 'require', 'error']);

// One statement gives publication a coherent MVCC source snapshot even at READ COMMITTED.
// Preview calls this inside its existing-style REPEATABLE READ READ ONLY transaction.
// No live labels/rules/options are substituted into the frozen definition.
async function loadSourceEvidence(client) {
  const { rows } = await client.query(`
    SELECT
      (SELECT COALESCE(jsonb_agg(code ORDER BY code), '[]') FROM categories
        WHERE code = ANY($1::text[])) AS categories,
      (SELECT COALESCE(jsonb_agg(row_to_json(q) ORDER BY q.id), '[]') FROM (
        SELECT q.id, q.category_code, q.key, q.label, q.include_in_sku, q.input_type,
          (SELECT COALESCE(jsonb_agg(o.value_id::text ORDER BY o.id), '[]')
           FROM options o WHERE o.question_id = q.id) AS value_ids
        FROM questions q WHERE q.category_code = ANY($1::text[])
      ) q) AS questions,
      (SELECT COALESCE(jsonb_agg(row_to_json(s) ORDER BY s.id), '[]') FROM (
        SELECT v.id, v.category_code, v.version,
          (SELECT COALESCE(jsonb_agg(row_to_json(q) ORDER BY q.id), '[]') FROM (
            SELECT q.id, q.question_key AS key,
              (SELECT COALESCE(jsonb_agg(o.value_id::text ORDER BY o.id), '[]')
               FROM sku_schema_options o WHERE o.schema_question_id = q.id) AS value_ids
            FROM sku_schema_questions q WHERE q.schema_version_id = v.id
          ) q) AS questions
        FROM sku_schema_versions v WHERE v.category_code = ANY($1::text[])
      ) s) AS schemas`, [Object.keys(HEADERS)]);
  return rows[0];
}

function validateSourceReferences(definition, evidence) {
  const diagnostics = [];
  const resolved = new Map();
  const report = (sourceId, code, message, details = {}) => {
    const source = definition.sources[sourceId];
    diagnostics.push({ sourceId, code, message,
      ...(source ? { category: source.category, key: source.key, kind: source.kind } : {}), ...details });
  };
  for (const group of definition.groups || []) {
    if (!evidence.categories.includes(group.route)) {
      report(group.route, 'SOURCE_REFERENCE_UNRESOLVED', 'Output category does not exist', { requirement: 'category', category: group.route });
    }
  }
  for (const [sourceId, source] of Object.entries(definition.sources)) {
    if (source.kind === 'product') continue;
    if (!evidence.categories.includes(source.category)) {
      report(sourceId, 'SOURCE_REFERENCE_UNRESOLVED', 'Category does not exist', { requirement: 'category' });
      continue;
    }
    const current = evidence.questions.filter((q) => q.category_code === source.category && q.key === source.key);
    const historical = evidence.schemas.filter((s) => s.category_code === source.category)
      .flatMap((s) => s.questions.filter((q) => q.key === source.key));
    if (current.length > 1) {
      report(sourceId, 'SOURCE_REFERENCE_AMBIGUOUS', 'Duplicate current question key', { requirement: 'unique_current_question' });
    }
    // SKU evidence is historical; current non-SKU metadata is a separate contract.
    const nonSku = current.filter((q) => Number(q.include_in_sku) === 0);
    const matches = source.kind === 'information' ? nonSku : [...historical, ...nonSku];
    const approvedLegacyInformation = current.length === 0 && source.kind === 'information'
      && source.type === 'scalar' && source.provenance === 'supplied-stored-answers-v1' && source.aliases.length === 0
      && HISTORICAL_INFORMATION_SOURCES.some((entry) => entry.category === source.category && entry.key === source.key
        && [entry.outputContract, 'magento-products-columns-v2'].includes(definition.outputContract) && entry.evaluatorVersion === definition.evaluatorVersion);
    if (!matches.length && !approvedLegacyInformation) {
      report(sourceId, 'SOURCE_REFERENCE_UNRESOLVED', source.kind === 'information'
        ? 'Current non-SKU question metadata required' : 'Historical SKU or current non-SKU question evidence required',
      { requirement: source.kind === 'information' ? 'current_non_sku_question' : 'historical_sku_or_current_non_sku_question' });
    }
    resolved.set(sourceId, { values: new Set(matches.flatMap((q) => q.value_ids)),
      currentValueIds: [...new Set(current.flatMap((q) => q.value_ids))],
      historicalValueIds: [...new Set(historical.flatMap((q) => q.value_ids))] });
    for (const alias of source.aliases) {
      const schema = evidence.schemas.find((s) => String(s.id) === alias.schemaId);
      if (!schema || schema.category_code !== source.category || !schema.questions.some((q) => q.key === alias.key)) {
        report(sourceId, 'SOURCE_REFERENCE_UNRESOLVED', 'Alias schema/category/key ownership is not evidenced',
          { requirement: 'alias_ownership', aliasKey: alias.key, schemaId: alias.schemaId });
      } else {
        // PR1B's free-text `evidence` is a claim, not an authoritative lineage record.
        // The repository has no durable cross-key or non-SKU rename lineage to verify it.
        report(sourceId, 'SOURCE_REFERENCE_UNSUPPORTED', 'Alias equivalence cannot be verified from repository lineage',
          { requirement: 'alias_lineage', aliasKey: alias.key, schemaId: alias.schemaId });
      }
    }
  }
  for (const [questionId, contract] of Object.entries(definition.questionContracts)) {
    if (!contract.exists) report(contract.source, 'SOURCE_REFERENCE_UNRESOLVED', `Missing captured question: ${questionId}`,
      { requirement: 'captured_question', questionId });
    const match = resolved.get(contract.source);
    const unresolvedValueIds = match ? contract.allowed.filter((value) => !match.values.has(value)) : [];
    if (unresolvedValueIds.length) {
      report(contract.source, 'SOURCE_REFERENCE_UNRESOLVED', `Unverified semantic value IDs: ${questionId}: ${unresolvedValueIds.join(', ')}`,
        { requirement: 'historical_sku_or_current_non_sku_value_ids', questionId, unresolvedValueIds,
          currentValueIds: match.currentValueIds, historicalValueIds: match.historicalValueIds });
    }
  }
  return diagnostics;
}

async function getSourceRegistry(client) {
  return {
    formatVersion: 1, evaluatorVersion: 'magento-declarative-1', outputContract: 'magento-products-v1',
    productFields: PRODUCT_FIELDS, operations: OPERATIONS, limits: { ...LIMITS, previewProducts: 100 },
    units: { weight: 'stored grams', total_price_uah: 'stored final UAH', answers: 'stored values; no unit conversion' },
    aliasPolicy: 'No repository-verifiable cross-key lineage; aliases fail publication with explicit diagnostics',
    historicalInformationSources: HISTORICAL_INFORMATION_SOURCES,
    productionAcceptanceVerified: false,
    references: await loadSourceEvidence(client),
  };
}

module.exports = { OPERATIONS, loadSourceEvidence, validateSourceReferences, getSourceRegistry };
