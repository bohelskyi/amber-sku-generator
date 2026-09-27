const { routeTools } = require('./binding-evidence-routes');
const { describeMapper } = require('./mapper-schema');
const { transport, OPTION_INPUTS } = require('./binding-evidence-analysis');
const { hash, code, semanticId, command, invalid, safeData, unique, list } = require('./binding-contract');

const STATES = ['proposed','review_required','approved','blocked'];
const STRATEGIES = ['scalar','semantic_option','dynamic_exact_label_option','numeric_band_option','constant_option','transport_control'];
const POLICIES = ['authoritative_create_update','initialize_create_only','magento_managed','blocked'];
const bindingKey = (routeKey, rowId, target) => hash({ routeKey, rowId, target });
const predicateKey = (p) => `${p.questionKey}${p.equal ? '=' : '!='}value_id:${p.valueId}`;
function stableRoute(plan) {
  if (plan.analysis) invalid(); // Unsupported routing expressions require a later contract, never a guessed route.
  const predicates = plan.predicates.map((p) => {
    if (!code(p.key) || !semanticId(p.value) || typeof p.equal !== 'boolean') invalid();
    return { questionKey: p.key, valueId: p.value, equal: p.equal };
  }).sort((a, b) => predicateKey(a) < predicateKey(b) ? -1 : predicateKey(a) > predicateKey(b) ? 1 : 0);
  unique(predicates, predicateKey);
  const routeKey = predicates.length ? `${plan.amberGroup}.` + predicates.map(predicateKey).join('&') : `${plan.amberGroup}:all`;
  if (routeKey.length > 512) invalid();
  return { routeKey, amberGroup: plan.amberGroup, predicates };
}

// Describes frozen evaluator outputs; it does not implement a second evaluator.
function requirements(definition, schema) {
  const tools = routeTools(definition);
  const mapper = describeMapper(definition);
  const references = new Map(definition.bindings.map((b) => [b.id, b.value]));
  const dereference = (node) => node?.op === 'ref' ? dereference(references.get(node.id)) : node;
  function semanticLookupProof(node, table, sourceId, seen = new Set()) {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (node.op === 'ref') return semanticLookupProof(references.get(node.id), table, sourceId, seen);
    if (node.op === 'lookup' && node.table === table) {
      const input = dereference(node.input);
      const source = input?.op === 'semanticKey' ? dereference(input.input) : null;
      if (source?.op === 'source' && source.id === sourceId && definition.sources[sourceId]?.kind === 'semantic') return true;
    }
    return Object.values(node).some((v) => semanticLookupProof(v, table, sourceId, seen));
  }
  const result = [];
  for (const plan of tools.plans) {
    if (plan.predicates.some((p) => definition.sources[p.sourceId]?.kind !== 'semantic'
      || definition.sources[p.sourceId].category !== plan.amberGroup)) invalid();
    const route = stableRoute(plan);
    const group = definition.groups.find((g) => g.route === plan.amberGroup);
    const attributes = [];
    for (const row of group.rows) for (const target of group.columns) {
      const cell = row.cells[target];
      if (!tools.possible(cell, plan.predicates)) continue;
      const usage = mapper.targets.find((t) => t.target === target)?.usages.find((u) => u.amberGroup === group.route && u.row === row.id);
      const observed = schema.attributes.find((a) => a.attribute_code === target);
      const values = (usage?.values || []).filter((v) => v.label !== '');
      const semantics = values.filter((v) => v.kind === 'dictionary' && v.sourceIds?.some((id) => definition.sources[id]?.kind === 'semantic'));
      const strategy = transport(target, observed) ? 'transport_control' : !OPTION_INPUTS.has(observed?.frontend_input) ? 'scalar'
        : values.some((v) => v.kind === 'numeric_band') ? 'numeric_band_option'
          : semantics.length ? 'semantic_option' : usage.dynamicOutput ? 'dynamic_exact_label_option' : 'constant_option';
      // Domain identity binds exact template + cell expression. Output identity is the
      // evaluator's exact string, not a remote option label or a fabricated value_id.
      const domainKey = hash({ definitionHash: hash(definition), group: group.route, row: row.id, target, cell });
      const options = [];
      let unsupportedSemanticOutput = false;
      for (const v of values) {
        if (strategy === 'semantic_option') {
          const sources = (v.sourceIds || []).filter((id) => definition.sources[id]?.kind === 'semantic');
          if (sources.length !== 1 || !semanticId(v.amberValueId) || !semanticLookupProof(cell, v.table, sources[0])) {
            unsupportedSemanticOutput = true; continue;
          }
          const s = definition.sources[sources[0]];
          if (plan.predicates.some((p) => p.key === s.key && (p.value === v.amberValueId) !== p.equal)) continue;
          if (!tools.possible(cell, [...plan.predicates, { sourceId: sources[0], key: s.key, value: v.amberValueId, equal: true }])) continue;
          options.push({ sourceKind: 'semantic', sourceKey: `${s.category}.${s.key}=value_id:${v.amberValueId}`,
            amberGroup: s.category, questionKey: s.key, valueId: v.amberValueId, evaluatedOutput: v.label });
        } else if (strategy.endsWith('_option')) {
          options.push({ sourceKind: 'evaluated', sourceKey: hash({ domainKey, outputKey: v.label }),
            domainKey, outputKey: v.label, evaluatedOutput: v.label });
        }
      }
      const dedup = [...new Map(options.map((o) => [JSON.stringify(o), o])).values()];
      const semanticSources = (usage?.sourceIds || []).map((id) => definition.sources[id])
        .filter((s) => s?.kind === 'semantic').map((s) => ({ amberGroup: s.category, questionKey: s.key }));
      attributes.push({ bindingKey: bindingKey(route.routeKey, row.id, target), routeKey: route.routeKey,
        rowId: row.id, target, strategy, domainKey, semanticSources, dynamic: usage?.dynamicOutput || false, options: dedup,
        unsupportedSemanticOutput: strategy === 'semantic_option' && (unsupportedSemanticOutput || usage.dynamicOutput || semantics.length !== values.length) });
    }
    result.push({ ...route, evaluatorSetName: plan.attributeSetName, attributes });
  }
  unique(result, (r) => r.routeKey);
  return result;
}
function evidence(v) {
  if (v === undefined) return {};
  command(v, [], ['note','diagnosticCodes','artifactHash','sampleCount','candidateIds']);
  if (v.note !== undefined && (typeof v.note !== 'string' || v.note.length > 2000)) invalid();
  if (v.artifactHash !== undefined && !/^[a-f0-9]{64}$/.test(v.artifactHash)) invalid();
  if (v.sampleCount !== undefined && (!Number.isSafeInteger(v.sampleCount) || v.sampleCount < 0)) invalid();
  for (const k of ['diagnosticCodes','candidateIds']) if (v[k] !== undefined &&
    (!Array.isArray(v[k]) || v[k].length > 100 || v[k].some((s) => typeof s !== 'string' || s.length > 160))) invalid();
  return v;
}
function review(row) { if (!STATES.includes(row.reviewState)) invalid(); return evidence(row.evidence); }
function normalizeBindings(input) {
  input = safeData(input);
  command(input, ['routes','attributes','options','policies']);
  const routes = list(input.routes, 100).map((r) => {
    command(r, ['routeKey','enabled','setId','reviewState'], ['evidence','evaluatorSetName']);
    if (typeof r.routeKey !== 'string' || typeof r.enabled !== 'boolean'
      || (r.setId !== null && (!Number.isSafeInteger(r.setId) || r.setId <= 0))) invalid();
    return { ...r, evidence: review(r) };
  });
  const attributes = list(input.attributes, 5000).map((a) => {
    command(a, ['routeKey','rowId','target','strategy','attributeCode','transportTarget','reviewState'], ['evidence','unknownOutputPolicy','bindingKey']);
    if (!code(a.target) || !['base','english'].includes(a.rowId) || !STRATEGIES.includes(a.strategy)
      || (a.attributeCode !== null && !code(a.attributeCode))
      || (a.transportTarget !== null && (typeof a.transportTarget !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.]{0,159}$/.test(a.transportTarget)))
      || (a.strategy === 'transport_control' ? a.attributeCode !== null : a.transportTarget !== null)
      || (a.unknownOutputPolicy !== undefined && a.unknownOutputPolicy !== 'block')) invalid();
    if (a.bindingKey !== undefined && a.bindingKey !== bindingKey(a.routeKey, a.rowId, a.target)) invalid();
    return { ...a, bindingKey: bindingKey(a.routeKey, a.rowId, a.target), unknownOutputPolicy: 'block', evidence: review(a) };
  });
  const options = list(input.options).map((o) => {
    command(o, ['bindingKey','sourceKind','evaluatedOutput','optionId','reviewState'],
      ['amberGroup','questionKey','valueId','skuCodeEvidence','domainKey','outputKey','evidence','sourceKey','strategy']);
    if ((o.evaluatedOutput === null ? o.sourceKind !== 'semantic' || o.reviewState === 'approved'
      : typeof o.evaluatedOutput !== 'string' || !o.evaluatedOutput || o.evaluatedOutput.length > 4096)
      || (o.optionId !== null && (typeof o.optionId !== 'string' || !o.optionId || o.optionId.length > 4096))) invalid();
    const a = attributes.find((a) => a.bindingKey === o.bindingKey);
    if (!a || (o.strategy !== undefined && o.strategy !== a.strategy)) invalid();
    let sourceKey;
    if (o.sourceKind === 'semantic') {
      if (a.strategy !== 'semantic_option' || !['BR','NM','KL','CH','AR','SV'].includes(o.amberGroup)
        || !code(o.questionKey) || !semanticId(o.valueId) || Object.hasOwn(o, 'domainKey') || Object.hasOwn(o, 'outputKey')
        || (o.skuCodeEvidence !== undefined && (typeof o.skuCodeEvidence !== 'string' || !/^[0-9]{1,100}$/.test(o.skuCodeEvidence)))) invalid();
      sourceKey = `${o.amberGroup}.${o.questionKey}=value_id:${o.valueId}`;
    } else if (o.sourceKind === 'evaluated') {
      if (!['dynamic_exact_label_option','numeric_band_option','constant_option'].includes(a.strategy)
        || ['amberGroup','questionKey','valueId','skuCodeEvidence'].some((k) => Object.hasOwn(o, k))
        || typeof o.domainKey !== 'string' || !/^[a-f0-9]{64}$/.test(o.domainKey)
        || typeof o.outputKey !== 'string' || !o.outputKey || o.outputKey.length > 4096) invalid();
      sourceKey = hash({ domainKey: o.domainKey, outputKey: o.outputKey });
    } else invalid();
    if (o.sourceKey !== undefined && o.sourceKey !== sourceKey) invalid();
    return { ...o, sourceKey, strategy: a.strategy, evidence: review(o) };
  });
  const policies = list(input.policies, 10000).map((p) => {
    command(p, ['bindingKey','storeCode','policy','reviewState'], ['evidence']);
    if (!attributes.some((a) => a.bindingKey === p.bindingKey) || !code(p.storeCode) || !POLICIES.includes(p.policy)) invalid();
    return { ...p, evidence: review(p) };
  });
  unique(routes, (r) => r.routeKey); unique(attributes, (a) => a.bindingKey);
  unique(options, (o) => `${o.bindingKey}/${o.sourceKey}`);
  const targets = new Map(); const outputs = new Map();
  for (const o of options.filter((v) => v.optionId !== null)) {
    if (o.evaluatedOutput === null) invalid();
    const targetKey = `${o.bindingKey}/${o.optionId}`; const previous = targets.get(targetKey);
    if (previous && (o.sourceKind !== 'semantic' || previous.sourceKind !== 'semantic'
      || o.evaluatedOutput !== previous.evaluatedOutput)) invalid();
    targets.set(targetKey, o);
    const outputKey = JSON.stringify([o.bindingKey, o.evaluatedOutput]);
    if (outputs.has(outputKey) && outputs.get(outputKey) !== o.optionId) invalid();
    outputs.set(outputKey, o.optionId);
  }
  unique(policies, (p) => `${p.bindingKey}/${p.storeCode}`);
  unique(policies, (p) => {
    const a = attributes.find((a) => a.bindingKey === p.bindingKey);
    return `${a.routeKey}/${a.attributeCode || a.transportTarget || a.target}/${p.storeCode}`;
  });
  unique(attributes.filter((a) => a.attributeCode), (a) => `${a.routeKey}/${a.rowId}/${a.attributeCode}`);
  unique(attributes.filter((a) => a.transportTarget), (a) => `${a.routeKey}/${a.rowId}/${a.transportTarget}`);
  return { routes, attributes, options, policies };
}

function validateBindings(bindings, definition, schema, { publish = false } = {}) {
  const required = requirements(definition, schema);
  const diagnostics = [];
  const issue = (code, identity) => diagnostics.push({ code, ...identity });
  const reviewed = (row, context) => { if (publish && !['approved','blocked'].includes(row.reviewState)) issue('BINDING_REVIEW_REQUIRED', context); };
  if (publish && !bindings.routes.some((r) => r.enabled)) issue('ENABLED_ROUTE_REQUIRED', {});
  const plans = required.flatMap((r) => r.attributes);
  for (const route of bindings.routes) {
    const expected = required.find((r) => r.routeKey === route.routeKey);
    if (!expected) { issue('ROUTE_IDENTITY_INVALID', { routeKey: route.routeKey }); continue; }
    if (route.evaluatorSetName !== undefined && route.evaluatorSetName !== expected.evaluatorSetName) issue('ROUTE_EVIDENCE_MISMATCH', { routeKey: route.routeKey });
    if (route.setId !== null && !schema.attributeSets.some((s) => s.attribute_set_id === route.setId)) issue('ATTRIBUTE_SET_MISSING', { routeKey: route.routeKey });
    if (route.reviewState === 'approved' && route.setId === null) issue('ATTRIBUTE_SET_ID_REQUIRED', { routeKey: route.routeKey });
    if (!publish || !route.enabled) continue;
    reviewed(route, { routeKey: route.routeKey });
    if (route.reviewState === 'blocked') continue; // Entire route is explicitly unsupported.
    for (const a of expected.attributes) if (!bindings.attributes.some((v) => v.bindingKey === a.bindingKey)) issue('ATTRIBUTE_BINDING_REQUIRED', { bindingKey: a.bindingKey, target: a.target });
  }
  for (const a of bindings.attributes) {
    const route = bindings.routes.find((r) => r.routeKey === a.routeKey);
    const expected = plans.find((p) => p.bindingKey === a.bindingKey);
    if (!route || !expected) { issue('ATTRIBUTE_CONTEXT_INVALID', { bindingKey: a.bindingKey }); continue; }
    if (a.strategy !== expected.strategy) issue('MAPPING_STRATEGY_INVALID', { bindingKey: a.bindingKey });
    // This contract retains existing evaluator target meaning, including CH dimensions.
    // Target renaming needs an independently reviewed future adapter contract.
    if (a.attributeCode !== null && a.attributeCode !== a.target) issue('ATTRIBUTE_TARGET_MISMATCH', { bindingKey: a.bindingKey });
    const attr = schema.attributes.find((v) => v.attribute_code === a.attributeCode);
    if (a.attributeCode !== null && !attr) issue('ATTRIBUTE_MISSING', { bindingKey: a.bindingKey });
    if (a.reviewState === 'approved' && (a.strategy === 'transport_control' ? !a.transportTarget : !attr)) issue('ATTRIBUTE_IDENTITY_REQUIRED', { bindingKey: a.bindingKey });
    const enabled = publish && route.enabled && route.reviewState !== 'blocked';
    if (enabled) reviewed(a, { bindingKey: a.bindingKey });
    const needed = enabled && a.reviewState !== 'blocked';
    if (needed) {
      if (expected.unsupportedSemanticOutput) issue('SEMANTIC_OUTPUT_DOMAIN_UNRESOLVED', { bindingKey: a.bindingKey });
      if (a.strategy === 'dynamic_exact_label_option' && !bindings.options.some((o) => o.bindingKey === a.bindingKey)) issue('DYNAMIC_DOMAIN_BINDING_REQUIRED', { bindingKey: a.bindingKey });
      if (attr && !schema.attributeSets.find((s) => s.attribute_set_id === route.setId)?.attributeCodes.includes(attr.attribute_code)) issue('ATTRIBUTE_NOT_IN_EXPECTED_SET', { bindingKey: a.bindingKey });
      for (const o of expected.options) if (!bindings.options.some((v) => v.bindingKey === a.bindingKey && v.sourceKey === o.sourceKey && v.evaluatedOutput === o.evaluatedOutput)) issue('OPTION_BINDING_REQUIRED', { bindingKey: a.bindingKey, sourceKey: o.sourceKey });
      if (!bindings.policies.some((p) => p.bindingKey === a.bindingKey)) issue('FIELD_POLICY_REQUIRED', { bindingKey: a.bindingKey });
    }
    for (const o of bindings.options.filter((v) => v.bindingKey === a.bindingKey)) {
      const known = expected.options.find((v) => v.sourceKey === o.sourceKey && v.evaluatedOutput === o.evaluatedOutput);
      const unenumerated = o.sourceKind === 'semantic' && o.evaluatedOutput === null && o.optionId === null
        && o.reviewState !== 'approved' && !expected.options.some((v) => v.sourceKey === o.sourceKey)
        && expected.semanticSources.some((s) => s.amberGroup === o.amberGroup && s.questionKey === o.questionKey);
      if (!known && !unenumerated
        && !(expected.dynamic && o.sourceKind === 'evaluated' && o.domainKey === expected.domainKey && o.outputKey === o.evaluatedOutput
        && ['dynamic_exact_label_option','numeric_band_option'].includes(a.strategy))) issue('OPTION_SOURCE_INVALID', { bindingKey: a.bindingKey, sourceKey: o.sourceKey });
      if (o.optionId !== null && !attr?.options.some((v) => !v.isEmpty && v.value === o.optionId)) issue('OPTION_ID_MISSING', { bindingKey: a.bindingKey, sourceKey: o.sourceKey });
      if (o.reviewState === 'approved' && o.optionId === null) issue('OPTION_ID_REQUIRED', { bindingKey: a.bindingKey, sourceKey: o.sourceKey });
      if (needed) reviewed(o, { bindingKey: a.bindingKey, sourceKey: o.sourceKey });
    }
    for (const p of bindings.policies.filter((v) => v.bindingKey === a.bindingKey)) {
      if (p.storeCode !== 'all' && !schema.storeTopology.storeViews.some((v) => v.code === p.storeCode && v.is_active === true)) issue('STORE_SCOPE_INVALID', { bindingKey: a.bindingKey });
      if (['approved','blocked'].includes(p.reviewState) && (p.policy === 'blocked') !== (p.reviewState === 'blocked')) issue('FIELD_POLICY_STATE_INVALID', { bindingKey: a.bindingKey });
      if (needed) reviewed(p, { bindingKey: a.bindingKey, storeCode: p.storeCode });
    }
  }
  return { valid: diagnostics.length === 0, diagnostics, requirements: required };
}

module.exports = { stableRoute, bindingKey, requirements, normalizeBindings, validateBindings };
