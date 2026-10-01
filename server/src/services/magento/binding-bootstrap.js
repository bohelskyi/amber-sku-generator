const c = require('./binding-contract');
const { requirements, normalizeBindings, validateBindings } = require('./binding-validation');
const { readAmberEvidence } = require('./binding-evidence-db');
const { evaluate } = require('./binding-evidence-products');
const { optionCandidates } = require('./binding-evidence-analysis');
const { auditMagentoSchema } = require('./schema-audit');
const { createMagentoClient } = require('./client');
const { indexTrees, resolveCategories } = require('./sync-preview-categories');
const { assertEvidenceSafe } = require('./binding-evidence-audit');

const TRANSPORT = { attribute_set_code: 'attribute_set_id', product_type: 'type_id', product_online: 'status',
  visibility: 'visibility', categories: 'extension_attributes.category_links',
  product_websites: 'extension_attributes.website_ids', store_view_code: 'store_view_code', qty: 'inventory.qty', is_in_stock: 'inventory.is_in_stock' };
const matchProduct = (route, product) => product.category === route.amberGroup && route.predicates.every((p) =>
  (String(product.details?.answers?.[p.questionKey] ?? '') === p.valueId) === p.equal);
const evidence = (code, ids = []) => ({ diagnosticCodes: [code], candidateIds: ids.map(String) });

function buildCandidates(amber, schema, categoryNodes, { group, routeKey } = {}) {
  const plans = requirements(amber.compiled.definition, schema);
  const selected = plans.filter((p) => (!group || p.amberGroup === group) && (!routeKey || p.routeKey === routeKey));
  if (!selected.length) throw c.error(422, 'MAGENTO_BINDING_SCOPE_EMPTY', 'No matching Amber route');
  const bindings = { routes: [], attributes: [], options: [], policies: [] };
  const products = (amber.products || []).map((product) => ({ product, result: evaluate(amber, product) }));
  for (const plan of plans) {
    const enabled = selected.includes(plan);
    const sets = schema.attributeSets.filter((s) => s.attribute_set_name === plan.evaluatorSetName);
    const set = sets.length === 1 ? sets[0] : null;
    // Known compatibility conflict is review evidence, never an implicit route override.
    const conflict = plan.amberGroup === 'SV' && plan.predicates.some((p) => p.questionKey === 'souvenir' && p.valueId === '5' && p.equal);
    bindings.routes.push({ routeKey: plan.routeKey, enabled, setId: set?.attribute_set_id ?? null,
      reviewState: set && !conflict ? 'proposed' : 'review_required',
      evidence: evidence(conflict ? 'COMPATIBILITY_ROUTE_REVIEW_REQUIRED' : set ? 'EXACT_SET_NAME' : 'SET_MISSING_OR_AMBIGUOUS', sets.map((s) => s.attribute_set_id)) });
    if (!enabled) continue;
    const samples = products.filter((p) => matchProduct(plan, p.product) && p.result.ready);
    for (const req of plan.attributes) {
      const attr = schema.attributes.find((a) => a.attribute_code === req.target);
      const native = req.strategy === 'transport_control';
      const destination = native ? `product.${TRANSPORT[req.target] || `custom_attributes.${req.target}`}` : null;
      const exact = native ? Boolean(TRANSPORT[req.target] || attr?.frontend_input === 'boolean')
        : Boolean(attr && set?.attributeCodes.includes(req.target));
      const a = { routeKey: plan.routeKey, rowId: req.rowId, target: req.target, strategy: req.strategy,
        attributeCode: native ? null : attr?.attribute_code ?? null, transportTarget: destination,
        reviewState: exact ? 'proposed' : 'review_required',
        evidence: evidence(exact ? native ? 'NATIVE_CONTROL' : 'EXACT_ATTRIBUTE_CODE' : 'ATTRIBUTE_MEMBERSHIP_OR_IDENTITY_UNRESOLVED', attr ? [attr.attribute_id] : []) };
      if (req.target === 'categories') {
        const paths = [...new Set(samples.flatMap((p) => String(p.result[req.rowId]?.categories || '').split(',').filter(Boolean)))];
        const resolved = resolveCategories(paths.join(','), categoryNodes, { known: true, source: 'bootstrap', links: [] });
        a.evidence.categories = resolved.requested.map((r) => ({ requestedPath: r.requestedPath, normalizedPath: r.normalizedPath,
          categoryId: r.categoryId, candidates: r.exactCandidates,
          reviewState: r.categoryId ? 'proposed' : r.status === 'missing' ? 'blocked' : 'review_required' }));
        a.evidence.sampleCount = samples.length;
        if (!paths.length) { a.reviewState = 'review_required'; a.evidence.diagnosticCodes.push('CATEGORY_OUTPUT_NOT_OBSERVED'); }
      }
      bindings.attributes.push(a);
      const unsupportedSources = req.options.filter((o) => o.sourceKind === 'semantic' && !c.questionKey(o.questionKey));
      if (unsupportedSources.length) {
        a.reviewState = 'blocked';
        a.evidence.diagnosticCodes.push('SEMANTIC_SOURCE_OUTSIDE_BINDING_CONTRACT');
        a.evidence.note = JSON.stringify(unsupportedSources.map((o) => ({ source: o.sourceKey, output: o.evaluatedOutput })));
        // Unsupported literal keys remain refusals; never fabricate an alias.
        continue;
      }
      const outputs = [...req.options];
      if (req.dynamic && ['dynamic_exact_label_option', 'numeric_band_option'].includes(req.strategy)) {
        for (const sample of samples) {
          const outputKey = sample.result[req.rowId]?.[req.target];
          if (typeof outputKey === 'string' && outputKey) outputs.push({ sourceKind: 'evaluated', domainKey: req.domainKey,
            outputKey, evaluatedOutput: outputKey });
        }
      }
      for (const source of req.semanticSources.filter(() => req.strategy === 'semantic_option')) {
        for (const q of amber.current || []) if (q.category_code === source.amberGroup && q.key === source.questionKey) {
          for (const o of q.options) if (!outputs.some((v) => v.sourceKind === 'semantic' && v.questionKey === source.questionKey && v.valueId === String(o.value_id))) {
            outputs.push({ sourceKind: 'semantic', amberGroup: source.amberGroup, questionKey: source.questionKey,
              valueId: String(o.value_id), evaluatedOutput: null });
          }
        }
      }
      const seen = new Set();
      for (const output of outputs) {
        const key = output.sourceKind === 'semantic' ? `${output.amberGroup}.${output.questionKey}=${output.valueId}` : output.outputKey;
        if (seen.has(key)) continue;
        seen.add(key);
        const found = output.evaluatedOutput ? optionCandidates(attr, output.evaluatedOutput) : { exact: [], drift: [] };
        const choices = found.exact.length ? found.exact : found.drift;
        const optionId = choices.length === 1 ? choices[0].optionId : null;
        const inclusion = output.amberGroup === 'KL' && output.questionKey === 'addit' && output.valueId === '1';
        const exactOption = found.exact.length === 1 && !inclusion;
        bindings.options.push({ ...output, bindingKey: req.bindingKey, optionId,
          reviewState: exactOption ? 'proposed' : choices.length ? 'review_required' : 'blocked',
          evidence: evidence(inclusion ? 'KL_INCLUSION_REVIEW_REQUIRED' : exactOption ? 'EXACT_OPTION_LABEL'
            : found.drift.length ? 'LABEL_DRIFT_REVIEW_REQUIRED' : choices.length ? 'OPTION_AMBIGUOUS' : 'OPTION_UNRESOLVED', choices.map((v) => v.optionId)) });
      }
      // Suggested preservation is reviewable separately; identity approval never approves ownership.
      if (req.rowId === 'base' || schema.storeTopology.storeViews.some((s) => s.code === 'en' && s.is_active)) {
        bindings.policies.push({ bindingKey: req.bindingKey, storeCode: req.rowId === 'base' ? schema.storeCode : 'en',
          policy: 'magento_managed', reviewState: 'review_required', evidence: evidence('OWNERSHIP_DECISION_REQUIRED') });
      }
    }
  }
  const result = normalizeBindings(bindings);
  const valid = validateBindings(result, amber.compiled.definition, schema);
  if (!valid.valid) throw c.error(422, 'MAGENTO_BINDING_INVALID', 'Bootstrap candidates failed validation', { diagnostics: valid.diagnostics });
  return result;
}

async function bootstrap(config, input, options = {}) {
  const { databasePool, fetchImpl, sensitiveValues = [], readAmber = readAmberEvidence, discover = auditMagentoSchema,
    preflight = require('./binding-bootstrap-persistence').preflight,
    persist = require('./binding-bootstrap-persistence').persistBootstrap } = options;
  c.installation(input.installationKey);
  await preflight(databasePool);
  const versionId = input.templateVersionId === 'system' ? undefined : c.identity(input.templateVersionId);
  const amber = await readAmber(databasePool, { templateVersionId: versionId, supportSystem: !versionId, sku: input.sku });
  const schema = c.normalizeSchema(await discover(config, { fetchImpl, storeCode: 'all' }));
  const client = createMagentoClient(config, { fetchImpl });
  const roots = [...new Set(schema.storeTopology.storeGroups.map((g) => g.root_category_id).filter((id) => id > 0))];
  if (roots.length > 100) c.invalid();
  const trees = [];
  for (const id of roots) {
    const tree = await client.getCategoryTree(id);
    if (Number(tree?.id) !== id) c.invalid();
    trees.push(tree);
  }
  const bindings = buildCandidates(amber, schema, indexTrees(trees), input);
  assertEvidenceSafe({ schema, bindings, template: amber.compiled.definition }, config, sensitiveValues);
  return persist({ installationKey: input.installationKey, origin: config.baseUrl,
    templateVersionId: versionId, definition: amber.compiled.definition, definitionHash: amber.compiled.hash,
    observedAt: new Date().toISOString(), schema, bindings }, options);
}
function extendCandidates(revision, candidates, scope) {
  if (revision.state !== 'draft' || (!scope.group && !scope.routeKey) || (scope.group && scope.routeKey)) c.invalid();
  const selected = candidates.routes.filter((r) => r.enabled);
  if (!selected.length || selected.some((r) => scope.group ? !r.routeKey.startsWith(`${scope.group}:`)
    && !r.routeKey.startsWith(`${scope.group}.`) : r.routeKey !== scope.routeKey)) c.invalid();
  const keys = new Set(selected.map((r) => r.routeKey));
  for (const key of keys) {
    const old = revision.bindings.routes.find((r) => r.routeKey === key);
    if (!old || old.enabled || ['approved', 'blocked'].includes(old.reviewState)
      || revision.bindings.attributes.some((a) => a.routeKey === key)) {
      throw c.error(409, 'MAGENTO_BINDING_SCOPE_ALREADY_REVIEWED', 'Extension requires an untouched disabled route');
    }
  }
  if (Object.values(candidates).flat().some((r) => r.reviewState === 'approved'
    || r.evidence?.categories?.some((v) => v.reviewState === 'approved'))) c.invalid();
  const addedAttributes = candidates.attributes.filter((a) => keys.has(a.routeKey));
  const attributeKeys = new Set(addedAttributes.map((a) => a.bindingKey));
  return normalizeBindings({
    routes: revision.bindings.routes.map((r) => keys.has(r.routeKey) ? selected.find((s) => s.routeKey === r.routeKey) : r),
    attributes: [...revision.bindings.attributes, ...addedAttributes],
    options: [...revision.bindings.options, ...candidates.options.filter((o) => attributeKeys.has(o.bindingKey))],
    policies: [...revision.bindings.policies, ...candidates.policies.filter((p) => attributeKeys.has(p.bindingKey))],
  });
}
async function extendDraft(config, input, options = {}) {
  const service = options.bindingService || require('./binding.service');
  const revision = await service.getRevision(input.id, options);
  if (revision.state !== 'draft' || revision.revision !== c.counter(input.expectedRevision)) {
    throw c.error(409, 'MAGENTO_BINDING_CONFLICT', 'Binding revision changed');
  }
  if (c.originHash(config.baseUrl) !== revision.originHash) {
    throw c.error(422, 'MAGENTO_BINDING_INSTALLATION_MISMATCH', 'Magento installation differs');
  }
  const amber = await (options.readAmber || readAmberEvidence)(options.databasePool,
    { templateVersionId: revision.templateVersionId, sku: input.sku });
  if (amber.compiled.hash !== revision.definitionHash) c.invalid();
  const observed = c.normalizeSchema(await (options.discover || auditMagentoSchema)(config,
    { fetchImpl: options.fetchImpl, storeCode: revision.schema.storeCode }));
  // Extension must not refresh the frozen observation or reinterpret carried decisions.
  if (c.hash(observed) !== revision.schemaFingerprint) {
    throw c.error(409, 'MAGENTO_BINDING_OBSERVATION_CHANGED', 'Schema drift requires separate review');
  }
  const client = createMagentoClient(config, { fetchImpl: options.fetchImpl, storeCode: revision.schema.storeCode });
  const roots = [...new Set(revision.schema.storeTopology.storeGroups.map((g) => g.root_category_id).filter((id) => id > 0))];
  if (roots.length > 100) c.invalid();
  const trees = [];
  for (const id of roots) {
    const tree = await client.getCategoryTree(id);
    if (Number(tree?.id) !== id) c.invalid();
    trees.push(tree);
  }
  const candidates = buildCandidates(amber, revision.schema, indexTrees(trees), input);
  const bindings = extendCandidates(revision, candidates, input);
  assertEvidenceSafe({ bindings }, config, options.sensitiveValues || []);
  return service.updateDraft(input.id, { expectedRevision: input.expectedRevision, bindings }, options);
}
module.exports = { buildCandidates, bootstrap, extendCandidates, extendDraft };
