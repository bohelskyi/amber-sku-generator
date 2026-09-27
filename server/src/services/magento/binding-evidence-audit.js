const { readAmberEvidence } = require('./binding-evidence-db');
const { auditMagentoSchema, MAX_REPORT_BYTES } = require('./schema-audit');
const { analyzeBindings } = require('./binding-evidence-analysis');
const { sampleProducts } = require('./binding-evidence-products');
const { percentEncode } = require('./oauth');
const { MagentoIntegrationError } = require('./errors');
const { compare } = require('./mapper-schema');
const { compatibilityEvidence } = require('./compatibility-evidence');

function assertEvidenceSafe(report, config, sensitiveValues = []) {
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT_BYTES) throw new MagentoIntegrationError('MAGENTO_DISCOVERY_LIMIT');
  const secrets = [...['consumerKey', 'consumerSecret', 'accessToken', 'accessTokenSecret'].map((key) => config[key]),
    ...sensitiveValues].filter((v) => typeof v === 'string' && v.length);
  const forbidden = secrets.flatMap((v) => [v, percentEncode(v)]);
  function check(value) {
    if (typeof value === 'string' && (/OAuth\s|oauth_signature|Authorization\s*:|(?:postgres(?:ql)?|https?):\/\/[^\s/]+@/i.test(value)
      || forbidden.some((secret) => value.includes(secret)))) throw new MagentoIntegrationError('MAGENTO_AUDIT_SENSITIVE_DATA');
    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) { check(key); check(item); }
    }
  }
  check(report);
}

async function auditBindingEvidence(config, { databasePool, fetchImpl, templateVersionId, sensitiveValues, mode,
  now = () => new Date().toISOString(), readAmber = readAmberEvidence, discover = auditMagentoSchema } = {}) {
  if (mode !== undefined && mode !== 'compatibility') throw new MagentoIntegrationError('MAGENTO_BINDING_AUDIT_ARGUMENTS');
  const amber = await readAmber(databasePool, { templateVersionId, mode });
  const schema = await discover(config, { fetchImpl, storeCode: 'all' });
  const magentoSchemaObservedAt = now();
  const analysis = analyzeBindings(amber, schema);
  if (mode === 'compatibility') {
    const report = await compatibilityEvidence(config, amber, schema, analysis, { fetchImpl, now, magentoSchemaObservedAt });
    assertEvidenceSafe(report, config, sensitiveValues);
    return report;
  }
  const sampled = await sampleProducts(config, amber, schema, analysis, { fetchImpl });
  for (const entry of analysis.knownCases) {
    entry.productWitnesses = sampled.sampleProducts.filter((p) => p.amberGroup === entry.category
      && String(p.sourceAnswers[entry.key]) === entry.valueId).map((p) => ({ localProductId: p.localProductId,
      lookup: p.lookup, evaluation: p.evaluation, output: p.fields?.find((f) => f.target === entry.target)?.expected ?? null }));
  }
  const diagnostics = [...analysis.diagnostics, ...sampled.diagnostics].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const diagnosticCounts = {};
  for (const d of diagnostics) diagnosticCounts[d.code] = (diagnosticCounts[d.code] || 0) + 1;
  const report = { reportVersion: 1, generatedAt: now(), limitations: [
    'Candidate labels and near-label suggestions are review evidence, never semantic bindings.',
    'The Amber snapshot is repeatable-read/read-only; subsequent Magento GET observations are not an atomic cross-system snapshot.',
    'Default exports use the system mapper. An explicitly requested publication is reported by immutable identity/hash; selection metadata alone does not switch default exports.',
    'Only three active local candidates per template route are tried; prior Amber export exposure is not proof of Magento import.',
    'Usage counts inspect stored semantic answers, not decoded SKU digits. No semantic identity is inferred from sku_code or label.',
    'Conservative branch analysis proves some outputs inapplicable; possible output does not prove an existing product populates it.',
    'Failed evaluations are marked provisional. Dynamic output domains and absent sample classes require further operator evidence.',
    'Only two found products are compared under active ua/en scopes. Matching all and ua values does not establish the destination of a blank CSV store-view row.',
    'Option labels are observed in all scope. Store-localized option labels and the future native REST translation require separate review.',
  ], sources: { magentoSchemaObservedAt, amberCatalog: { observedAt: amber.observedAt, questions: analysis.sourceEvidence },
    publishedSchemas: { versions: amber.schemas }, template: { ...amber.template,
      questionContracts: amber.compiled.definition.questionContracts, sourceSupport: amber.compiled.definition.sourceSupport || null } },
  storeTopology: schema.storeTopology, attributeSets: schema.attributeSets,
  bindingEvidence: analysis.bindingEvidence, dynamicMappings: analysis.dynamicMappings,
  transportControls: analysis.transportControls, routeEvidence: analysis.routeEvidence,
  magentoOnlyOptions: analysis.magentoOnlyOptions, sampleProducts: sampled.sampleProducts,
  knownCases: analysis.knownCases, diagnostics, summary: { websites: schema.storeTopology.websites.length,
    storeGroups: schema.storeTopology.storeGroups.length, storeViews: schema.storeTopology.storeViews.length,
    attributes: schema.attributes.length, attributeSets: schema.attributeSets.length,
    samplesFound: sampled.sampleProducts.filter((p) => p.lookup === 'found').length,
    sampleAttempts: sampled.sampleProducts.length, diagnosticCounts } };
  assertEvidenceSafe(report, config, sensitiveValues);
  return report;
}

module.exports = { auditBindingEvidence, assertEvidenceSafe };
