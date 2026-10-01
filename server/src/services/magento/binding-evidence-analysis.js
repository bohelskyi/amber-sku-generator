const { describeMapper, CSV_FIELDS, compare } = require('./mapper-schema');
const { routeTools } = require('./binding-evidence-routes');
const { KNOWN_CASES } = require('./binding-evidence-db');
const OPTION_INPUTS = new Set(['select', 'multiselect', 'boolean']);

// CSV/native boundaries, not write translations. Boolean handling is schema-derived.
function transport(target, attribute) {
  if (CSV_FIELDS.has(target)) return target === 'attribute_set_code' ? 'attribute_set_name_to_id'
    : ['product_websites', 'store_view_code'].includes(target) ? 'website_store_identity'
      : 'csv_control_to_native_field';
  if (target === 'visibility') return 'csv_visibility_to_native_value';
  if (attribute?.frontend_input === 'boolean') return 'csv_boolean_to_native_value';
  return null;
}
function semanticEvidence(amber, source, valueId) {
  const match = (q) => q.category_code === source.amberGroup && q.key === source.questionKey;
  const currentQuestions = amber.current.filter(match);
  const historicalQuestions = amber.historical.filter(match);
  const occurrences = (questions) => questions.flatMap((q) => q.options.filter((o) => o.value_id === valueId)
    .map((o) => ({ questionId: q.id, optionId: o.id, value_id: o.value_id, sku_code: o.sku_code, label: o.label,
      archived: o.archived, visible_if_json: o.visible_if_json, hidden_if_json: o.hidden_if_json,
      ...(q.schemaId ? { schemaId: q.schemaId, version: q.version } : {}) })));
  const current = occurrences(currentQuestions);
  const historical = occurrences(historicalQuestions);
  const contexts = new Map();
  for (const o of [...current, ...historical]) {
    const context = o.schemaId || 'current';
    if (!contexts.has(context)) contexts.set(context, new Set());
    contexts.get(context).add(o.sku_code);
  }
  return { amberGroup: source.amberGroup, questionKey: source.questionKey, value_id: valueId,
    presence: current.length ? historical.length ? 'both' : 'current_only' : historical.length ? 'historical_only' : 'mapper_only',
    current, historical, ambiguous: currentQuestions.length > 1 || [...contexts.values()].some((codes) => codes.size > 1) };
}
// One edit (including adjacent transposition) is review evidence only. Short or
// arbitrary distant labels never become drift candidates and no ID is bound.
function nearLabel(a, b) {
  // Different measurements/counts are not spelling drift.
  if (![a, b].every((s) => /^[\p{L}\p{M}\s'’-]+$/u.test(s) && /\p{L}/u.test(s))) return false;
  const left = [...a]; const right = [...b];
  if (Math.min(left.length, right.length) < 4 || Math.max(left.length, right.length) > 200
    || Math.abs(left.length - right.length) > 1 || a === b) return false;
  const mismatch = left.findIndex((c, i) => c !== right[i]);
  const i = mismatch === -1 ? Math.min(left.length, right.length) : mismatch;
  if (left.length === right.length) return left.slice(i + 1).join('') === right.slice(i + 1).join('')
    || (left[i] === right[i + 1] && left[i + 1] === right[i]
      && left.slice(i + 2).join('') === right.slice(i + 2).join(''));
  return left.length < right.length ? left.slice(i).join('') === right.slice(i + 1).join('')
    : left.slice(i + 1).join('') === right.slice(i).join('');
}
function optionCandidates(attribute, label) {
  const options = (attribute?.options || []).filter((o) => !o.isEmpty);
  const exact = options.filter((o) => o.label === label);
  const drift = exact.length ? [] : options.filter((o) => nearLabel(label, o.label));
  return { status: label === '' ? 'empty_output' : exact.length === 1 ? 'exact_option_candidate'
    : exact.length > 1 ? 'ambiguous_option_candidate' : drift.length ? 'label_drift_candidate' : 'missing_magento_option',
  exact: exact.map(({ value, label }) => ({ optionId: value, label })),
  drift: drift.map(({ value, label }) => ({ optionId: value, label })) };
}

function bandRules(definition, node, seen = new Set()) {
  if (!node || typeof node !== 'object') return [];
  if (node.op === 'ref') {
    if (seen.has(node.id)) return [];
    return bandRules(definition, definition.bindings.find((b) => b.id === node.id)?.value, new Set([...seen, node.id]));
  }
  const own = node.op === 'numericBand' ? [{ format: node.format, onInvalid: node.onInvalid, bands: node.bands,
    outside: node.outside.op === 'literal' ? { kind: 'literal', value: node.outside.value } : { kind: node.outside.op } }] : [];
  return [...own, ...Object.values(node).flatMap((value) => bandRules(definition, value, seen))];
}

function analyzeBindings(amber, schema) {
  const definition = amber.compiled.definition;
  const mapper = describeMapper(definition);
  const routes = routeTools(definition);
  const diagnostics = [];
  const review = (code, details) => diagnostics.push({ code, severity: 'review', ...details });
  const bindingEvidence = [];
  const transportControls = [];
  const dynamicMappings = [];
  for (const target of mapper.targets) {
    const attribute = schema.attributes.find((a) => a.attribute_code === target.target);
    const translation = transport(target.target, attribute);
    if (translation) {
      transportControls.push({ target: target.target, classification: 'transport_control', nativeTranslationRequired: translation,
        magentoAttributeId: attribute?.attribute_id ?? null, usages: target.usages });
      continue;
    }
    if (!attribute) review('ATTRIBUTE_NOT_FOUND', { target: target.target });
    else if (attribute.frontend_input === null) review('ATTRIBUTE_FRONTEND_INPUT_MISSING', { target: target.target });
    for (const usage of target.usages) {
      const sources = mapper.sources.filter((s) => usage.sourceIds.includes(s.id));
      const cell = definition.groups.find((g) => g.route === usage.amberGroup).rows.find((r) => r.id === usage.row).cells[target.target];
      const hasOptions = OPTION_INPUTS.has(attribute?.frontend_input);
      const numericBand = usage.values.some((v) => v.kind === 'numeric_band');
      const semantic = usage.values.some((v) => v.kind === 'dictionary' && v.sourceIds?.some(
        (id) => sources.some((s) => s.id === id && s.kind === 'semantic')));
      const strategy = !attribute || attribute.frontend_input === null ? 'attribute_metadata_required'
        : !hasOptions ? 'scalar' : numericBand ? 'numeric_band_option'
          : semantic ? 'semantic_option' : usage.dynamicOutput ? 'dynamic_exact_label_option' : 'constant_option';
      const values = usage.values.map((v) => {
        const identities = (v.sourceIds || []).flatMap((id) => {
          const source = sources.find((s) => s.id === id && s.kind === 'semantic');
          return source && v.amberValueId !== undefined ? [semanticEvidence(amber, source, v.amberValueId)] : [];
        });
        const candidates = hasOptions ? optionCandidates(attribute, v.label) : { status: 'scalar', exact: [], drift: [] };
        const predicates = identities.map((a) => ({ sourceId: sources.find((s) => s.amberGroup === a.amberGroup
          && s.questionKey === a.questionKey).id, key: a.questionKey, value: a.value_id, equal: true }));
        const templateReachability = routes.possible(cell, predicates) ? 'conditional_possible' : 'blocked_by_template';
        for (const identity of identities) {
          const context = { target: target.target, amberGroup: identity.amberGroup,
            questionKey: identity.questionKey, value_id: identity.value_id, row: usage.row, templateReachability };
          if (identity.ambiguous || candidates.status === 'ambiguous_option_candidate') review('SEMANTIC_IDENTITY_AMBIGUOUS', context);
          if (candidates.status === 'label_drift_candidate') review('LABEL_DRIFT_REVIEW_REQUIRED', context);
          if (candidates.status === 'missing_magento_option') {
            if (identity.current.length) review('AMBER_CURRENT_VALUE_NOT_IN_MAGENTO', context);
            if (identity.historical.length) review('AMBER_HISTORICAL_VALUE_NOT_IN_MAGENTO', context);
          }
        }
        return { mapperOutput: v.label, outputKind: v.kind, ...(v.table ? { table: v.table } : {}),
          templateReachability,
          amber: identities, ...candidates, authority: 'candidate_evidence_only' };
      });
      const entry = { target: target.target, amberGroup: usage.amberGroup, row: usage.row,
        classification: 'product_attribute', strategy, sources, expectedAttributeSets: usage.expectedAttributeSetNames,
        possibleRouteIds: routes.plans.filter((p) => p.amberGroup === usage.amberGroup && routes.possible(cell, p.predicates)).map((p) => p.id),
        attributeId: attribute?.attribute_id ?? null, frontend_input: attribute?.frontend_input ?? null,
        magentoMetadata: { backend_type: attribute?.backend_type ?? null, scope: attribute?.scope ?? null,
          is_required: attribute?.is_required ?? null },
        dynamicOutput: usage.dynamicOutput, values };
      bindingEvidence.push(entry);
      if (['numeric_band_option', 'dynamic_exact_label_option'].includes(strategy)) {
        dynamicMappings.push({ target: target.target, amberGroup: usage.amberGroup, row: usage.row, strategy, sources,
          classification: 'dynamic_option_resolver_required',
          ...(strategy === 'numeric_band_option' ? { numericBands: bandRules(definition, cell) } : {}) });
        review('DYNAMIC_OPTION_RESOLVER_REQUIRED', { target: target.target, amberGroup: usage.amberGroup, row: usage.row });
      }
    }
  }
  const sourceEvidence = mapper.sources.filter((s) => s.kind !== 'product').map((s) => {
    const match = (q) => q.category_code === s.amberGroup && q.key === s.questionKey;
    const current = amber.current.filter(match);
    const historical = amber.historical.filter(match);
    const ids = [...new Set([...current, ...historical].flatMap((q) => q.options.map((o) => o.value_id)))].sort(compare);
    return { ...s, current, historical, presence: current.length ? historical.length ? 'both' : 'current_only'
      : historical.length ? 'historical_only' : 'missing',
    values: ids.map((id) => semanticEvidence(amber, s, id)) };
  });
  for (const source of sourceEvidence) for (const value of source.values) {
    value.mapperOutputs = bindingEvidence.filter((e) => e.amberGroup === source.amberGroup).flatMap((e) =>
      e.values.filter((v) => v.amber.some((a) => a.questionKey === source.questionKey && a.value_id === value.value_id))
        .map((v) => ({ target: e.target, row: e.row, output: v.mapperOutput, templateReachability: v.templateReachability })));
    if (source.kind === 'semantic' && !value.mapperOutputs.length) review('AMBER_VALUE_WITHOUT_ENUMERATED_MAPPER_OUTPUT',
      { amberGroup: source.amberGroup, questionKey: source.questionKey, value_id: value.value_id, presence: value.presence });
  }
  const routeEvidence = routes.plans.map((plan) => {
    const matches = schema.attributeSets.filter((s) => s.attribute_set_name === plan.attributeSetName);
    const selected = matches.length === 1 ? matches[0] : null;
    if (!selected) review(plan.attributeSetName === null ? 'ROUTE_STATIC_ANALYSIS_UNAVAILABLE'
      : matches.length ? 'ATTRIBUTE_SET_AMBIGUOUS' : 'ATTRIBUTE_SET_NOT_FOUND', { routeId: plan.id });
    const group = definition.groups.find((g) => g.route === plan.amberGroup);
    const targets = group.columns.filter((target) => !transport(target, schema.attributes.find((a) => a.attribute_code === target)))
      .map((target) => {
        const canPopulate = group.rows.some((row) => routes.possible(row.cells[target], plan.predicates));
        const contains = selected ? selected.attributeCodes.includes(target) : null;
        const classification = !canPopulate ? 'not_applicable_for_selected_attribute_set'
          : contains === false ? 'membership_review_if_populated' : 'possible_output';
        if (!canPopulate && contains === false) review('ATTRIBUTE_NOT_APPLICABLE_TO_SELECTED_SET', { routeId: plan.id, target });
        return { target, canPopulate, membership: contains, classification,
          evidence: 'conservative_template_branch_analysis' };
      });
    return { ...plan, attributeSetId: selected?.attribute_set_id ?? null, targets };
  });
  const magentoOnlyOptions = [];
  for (const attribute of schema.attributes) {
    const mappings = bindingEvidence.filter((e) => e.target === attribute.attribute_code && OPTION_INPUTS.has(e.frontend_input));
    if (!mappings.length) continue;
    const dynamic = mappings.some((m) => ['numeric_band_option', 'dynamic_exact_label_option'].includes(m.strategy) || m.dynamicOutput);
    const matched = new Set(mappings.flatMap((m) => m.values.flatMap((v) => v.exact.map((o) => o.optionId))));
    for (const option of (attribute.options || []).filter((o) => !o.isEmpty && !matched.has(o.value))) {
      const entry = { target: attribute.attribute_code, optionId: option.value, label: option.label,
        classification: dynamic ? 'dynamic_coverage_unknown' : 'magento_only_option' };
      magentoOnlyOptions.push(entry);
      if (!dynamic) review('MAGENTO_OPTION_WITHOUT_AMBER_SEMANTIC', { target: entry.target, optionId: entry.optionId });
    }
  }
  const knownCases = KNOWN_CASES.map((c) => {
    const entry = bindingEvidence.find((e) => e.target === c.target && e.amberGroup === c.category && e.row === 'base');
    const output = entry?.values.find((v) => v.amber.some((a) => a.questionKey === c.key && a.value_id === c.valueId));
    const source = sourceEvidence.find((s) => s.amberGroup === c.category && s.questionKey === c.key);
    const attribute = schema.attributes.find((a) => a.attribute_code === c.target);
    const reportedOption = c.reportedOptionId ? attribute?.options?.find((o) => o.value === c.reportedOptionId) : null;
    return { ...c, semanticEvidence: source ? semanticEvidence(amber, source, c.valueId) : null,
      productUsage: amber.usage.find((u) => u.category === c.category && u.key === c.key && u.valueId === c.valueId) || null,
      usageBasis: 'stored_semantic_answers_not_inferred_from_sku', mapperOutput: output?.mapperOutput ?? null,
      templateOutput: output?.templateReachability || 'not_enumerated',
      candidates: output ? { exact: output.exact, drift: output.drift } : null,
      reportedOption: reportedOption ? { optionId: reportedOption.value, label: reportedOption.label } : null,
      classification: output?.status === 'label_drift_candidate' ? 'LABEL_DRIFT_REVIEW_REQUIRED' : output?.status || 'MAPPER_OUTPUT_NOT_ENUMERATED' };
  });
  return { sourceEvidence, bindingEvidence, dynamicMappings, transportControls, routeEvidence, magentoOnlyOptions,
    knownCases, diagnostics };
}

module.exports = { analyzeBindings, semanticEvidence, optionCandidates, transport, OPTION_INPUTS };
