const { LIMITS } = require('./definition');
const { PRODUCT_FIELDS } = require('./input-projection');
const { HEADERS } = require('./magento-v1-data');
const { policyFor, EVALUATOR, PUBLIC_EVALUATOR } = require('./source-support');
const { CHARACTERISTIC_EVALUATOR, isExtensibleEvaluator, EXTENSIBLE_EVALUATOR } = require('./version-contract');

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
async function loadSourceEvidence(client, definition) {
  const native = definition?.evaluatorVersion === CHARACTERISTIC_EVALUATOR;
  // Only compiled v4/v5 callers expand the evidence scope. Legacy callers retain
  // the original six-category snapshot and canonical preview fingerprints.
  const categories = isExtensibleEvaluator(definition?.evaluatorVersion)
    ? [...new Set([...definition.groups.map((g) => g.route), ...Object.values(definition.sources).filter((s) => s.kind !== 'product').map((s) => s.category)])].sort()
    : Object.keys(HEADERS);
  const { rows } = await client.query(`
    SELECT
      (SELECT COALESCE(jsonb_agg(code ORDER BY code), '[]') FROM categories
        WHERE code = ANY($1::text[])) AS categories,
      (SELECT COALESCE(jsonb_agg(row_to_json(q) ORDER BY q.id), '[]') FROM (
        SELECT q.id, q.category_code, q.key, q.label, q.include_in_sku, q.input_type,
          ${native ? `COALESCE((to_jsonb(q)->>'archived')::boolean,false) AS archived,
          (SELECT COALESCE(jsonb_agg(o.value_id::text ORDER BY o.id),'[]') FROM options o
           WHERE o.question_id=q.id AND o.archived=false) AS active_value_ids,` : ''}
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
      ) s) AS schemas`, [categories]);
  const evidence = rows[0];
  if (definition?.evaluatorVersion === CHARACTERISTIC_EVALUATOR) {
    evidence.characteristicVersions = (await client.query('SELECT id,category_code,version,snapshot FROM product_characteristic_versions WHERE category_code=ANY($1::text[]) ORDER BY id', [categories])).rows;
  }
  return evidence;
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
    const semanticHistory = definition.evaluatorVersion === CHARACTERISTIC_EVALUATOR
      ? (evidence.characteristicVersions || []).filter((v) => v.category_code === source.category).flatMap((v) => v.snapshot.questions
        .filter((q) => q.key === source.key).map((q) => ({ ...q, value_ids: q.options.map((o) => String(o.value_id)) }))) : [];
    const historical = evidence.schemas.filter((s) => s.category_code === source.category)
      .flatMap((s) => s.questions.filter((q) => q.key === source.key));
    if (current.length > 1) {
      report(sourceId, 'SOURCE_REFERENCE_AMBIGUOUS', 'Duplicate current question key', { requirement: 'unique_current_question' });
    }
    // SKU evidence is historical; current non-SKU metadata is a separate contract.
    const nonSku = definition.evaluatorVersion === CHARACTERISTIC_EVALUATOR
      ? [] : current.filter((q) => Number(q.include_in_sku) === 0);
    // A v5 publication explicitly freezes current characteristics. Its source
    // membership does not require an earlier product save or encoded SKU schema.
    // Legacy evaluators keep their historical proof; product evaluation still
    // requires each native product's own immutable characteristic version.
    const nativeCurrent = definition.evaluatorVersion === CHARACTERISTIC_EVALUATOR
      ? current.filter((q) => q.archived === false
        && q.input_type === (source.kind === 'information' ? 'text' : 'options'))
        .map((q) => ({ ...q, value_ids: q.active_value_ids || [] })) : [];
    const matches = source.kind === 'information' ? [...nonSku, ...semanticHistory.filter((q) => q.input_type === 'text'), ...nativeCurrent] : [...historical, ...nonSku, ...semanticHistory, ...nativeCurrent];
    const approvedLegacyInformation = current.length === 0 && source.kind === 'information'
      && source.type === 'scalar' && source.provenance === 'supplied-stored-answers-v1' && source.aliases.length === 0
      && HISTORICAL_INFORMATION_SOURCES.some((entry) => entry.category === source.category && entry.key === source.key
        && [entry.outputContract, 'magento-products-columns-v2'].includes(definition.outputContract)
        && [entry.evaluatorVersion, EVALUATOR, PUBLIC_EVALUATOR, EXTENSIBLE_EVALUATOR, CHARACTERISTIC_EVALUATOR].includes(definition.evaluatorVersion));
    if (!matches.length && !approvedLegacyInformation) {
      report(sourceId, 'SOURCE_REFERENCE_UNRESOLVED', source.kind === 'information'
        ? 'Current non-SKU question metadata required' : 'Historical SKU or current non-SKU question evidence required',
      { requirement: source.kind === 'information' ? 'current_non_sku_question' : 'historical_sku_or_current_non_sku_question' });
    }
    resolved.set(sourceId, { values: new Set(matches.flatMap((q) => q.value_ids)),
      currentValueIds: [...new Set(current.flatMap((q) => q.value_ids))],
      historicalValueIds: [...new Set([...historical, ...semanticHistory, ...nativeCurrent].flatMap((q) => q.value_ids))] });
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
    const policy = policyFor(definition, definition.sources[contract.source]);
    const claims = policy ? policy.semanticValues : contract.allowed;
    const unresolvedValueIds = match ? claims.filter((value) => !(policy ? match.historicalValueIds.includes(value) : match.values.has(value))) : [];
    if (unresolvedValueIds.length) {
      report(contract.source, 'SOURCE_REFERENCE_UNRESOLVED', `Unverified semantic value IDs: ${questionId}: ${unresolvedValueIds.join(', ')}`,
        { requirement: 'historical_sku_or_current_non_sku_value_ids', questionId, unresolvedValueIds,
          currentValueIds: match.currentValueIds, historicalValueIds: match.historicalValueIds });
    }
  }
  return diagnostics;
}

async function getSourceRegistry(client) {
  const nativeAuthoring = (await client.query("SELECT to_regclass('public.product_characteristic_versions') IS NOT NULL AS available")).rows[0]?.available === true;
  let references;
  if (nativeAuthoring) {
    const categories = (await client.query('SELECT code FROM categories ORDER BY code LIMIT $1', [require('./version-contract').MAX_GROUPS + 1])).rows;
    if (categories.length > require('./version-contract').MAX_GROUPS) throw Object.assign(new Error('Source registry category scope exceeds its explicit bound'), { code: 'TEMPLATE_SOURCE_SCOPE_LIMIT', statusCode: 422 });
    references = await loadSourceEvidence(client, { evaluatorVersion: CHARACTERISTIC_EVALUATOR, groups: categories.map((q) => ({ route: q.code })), sources: {} });
  } else references = await loadSourceEvidence(client);
  return {
    formatVersion: 1, evaluatorVersion: 'magento-declarative-1', outputContract: 'magento-products-v1',
    nativeCharacteristicsUpgrade: { targetContract: require('./version-contract').CHARACTERISTIC_CONTRACT,
      evaluatorVersion: CHARACTERISTIC_EVALUATOR, supportedEvaluatorVersions: ['magento-declarative-3', 'magento-declarative-4'] },
    effectiveNamesUpgrade: { targetContract: require('./effective-product-names').POLICY,
      evaluatorVersion: CHARACTERISTIC_EVALUATOR, supportedEvaluatorVersions: ['magento-declarative-3', 'magento-declarative-4', CHARACTERISTIC_EVALUATOR] },
    productFields: PRODUCT_FIELDS, operations: OPERATIONS, limits: { ...LIMITS, previewProducts: 100 },
    productSourceContracts: [{ version: 'public-product-identity-v1', evaluatorVersion: PUBLIC_EVALUATOR,
      publicSource: 'public_sku', internalSource: 'full_sku' }],
    units: { weight: 'stored grams', total_price_uah: 'stored final UAH', answers: 'stored values; no unit conversion' },
    aliasPolicy: 'No repository-verifiable cross-key lineage; aliases fail publication with explicit diagnostics',
    historicalInformationSources: HISTORICAL_INFORMATION_SOURCES,
    sourceSupportPolicies: [{ version: require('./source-support').VERSION, evaluatorVersion: EVALUATOR,
      outputContracts: ['magento-products-v1', 'magento-products-columns-v2'],
      sources: ['NM.extra', 'AR.size'], placeholder: 'numeric-zero-v1', stringZeroPlaceholder: false }],
    productionAcceptanceVerified: false,
    nativeCharacteristicsAuthoring: nativeAuthoring,
    references,
  };
}

module.exports = { OPERATIONS, loadSourceEvidence, validateSourceReferences, getSourceRegistry };
