const { createMagentoClient } = require('./client');
const { auditMagentoSchema } = require('./schema-audit');
const { readPreviewProduct } = require('./sync-preview-db');
const { evaluate, productEvidence } = require('./binding-evidence-products');
const { requirements, bindingKey, validateBindings } = require('./binding-validation');
const { describeMapper, CSV_FIELDS } = require('./mapper-schema');
const { optionCandidates, OPTION_INPUTS, transport } = require('./binding-evidence-analysis');
const { compareSchema } = require('./binding-drift');
const { originHash, error } = require('./binding-contract');
const { assertEvidenceSafe } = require('./binding-evidence-audit');
const { populated, numeric, numericComparison, orientation } = require('./compatibility-evidence-comparisons');
const { indexTrees, currentAssignments, resolveCategories } = require('./sync-preview-categories');
const { syncEligibility } = require('./sync-eligibility');
const { readDomains, planDomains } = require('./sync-preview-domains');

const MERCHANDISING = ['description', 'short_description', 'meta_title', 'meta_description'];
const NATIVE = { sku: 'sku', name: 'name', price: 'price', weight: 'weight', product_type: 'type_id',
  product_online: 'status', visibility: 'visibility', attribute_set_code: 'attribute_set_id' };
const DOMAINS = { categories: 'extension_attributes.category_links', product_websites: 'extension_attributes.website_ids',
  qty: 'inventory.qty', is_in_stock: 'inventory.is_in_stock', store_view_code: 'store_view_code' };
const VISIBILITY = { 'Not Visible Individually': 1, Catalog: 2, Search: 3, 'Catalog, Search': 4 };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const OPERATIONS = ['coreProduct', 'categories', 'inventory', 'websites', 'storeViews'];
const FIELD_OPERATION = { categories: 'categories', qty: 'inventory', is_in_stock: 'inventory',
  product_websites: 'websites', store_view_code: 'storeViews' };
function blockerOperation(code, details) {
  if (['AMBER_PRODUCT_EXCLUDED', 'AMBER_PRODUCT_NOT_CURRENT'].includes(code)) return 'all';
  if (code.startsWith('CATEGORY_') || code === 'CURRENT_CATEGORY_ASSIGNMENTS_UNAVAILABLE') return 'categories';
  if (code.startsWith('INVENTORY_')) return 'inventory';
  if (code.startsWith('WEBSITE_')) return 'websites';
  if (code.startsWith('STORE_VIEW_')) return 'storeViews';
  return FIELD_OPERATION[details.target || details.diagnostic?.target] || 'coreProduct';
}
function sendability(blockers, candidatePayload, transportReport) {
  const operations = Object.fromEntries(OPERATIONS.map((operation) => {
    const relevant = blockers.filter((b) => b.operation === operation || b.operation === 'all');
    return [operation, { sendable: relevant.length === 0, blockers: relevant }];
  }));
  const overall = { sendable: blockers.length === 0, blockers };
  // Domain readiness describes an exact scoped payload, not the combined inspection payload.
  const core = structuredClone(candidatePayload);
  if (core.product.extension_attributes) {
    delete core.product.extension_attributes.category_links;
    if (!Object.keys(core.product.extension_attributes).length) delete core.product.extension_attributes;
  }
  operations.coreProduct.candidatePayload = core;
  operations.categories.candidateLinks = candidatePayload.product.extension_attributes?.category_links ?? null;
  if (transportReport) for (const domain of ['inventory', 'websites', 'storeViews']) operations[domain].plan = transportReport[domain];
  return { ...overall, scope: 'complete_sync_plan', operations, overall };
}
function typeApplicability(attribute, type) {
  if (!Array.isArray(attribute?.apply_to)) return 'unknown';
  return !attribute.apply_to.length || attribute.apply_to.includes(type) ? 'applicable' : 'not_applicable';
}

function comparison(expected, current, isOption = false) {
  if (equal(expected, current) || (expected !== null && current !== null && String(expected) === String(current))) return 'exact';
  if (!populated(current)) return 'absent';
  if (isOption) return 'semantic_difference';
  const result = numericComparison(expected, current, true);
  return result === 'numeric_equivalent' ? 'numeric_equivalent_formatting' : result === 'rounded'
    ? 'rounded_legacy_value' : 'semantic_difference';
}
function policyFor(revision, key, scope) {
  return revision?.bindings.policies.find((p) => p.bindingKey === key && p.storeCode === scope)
    || revision?.bindings.policies.find((p) => p.bindingKey === key && p.storeCode === 'all') || null;
}
function optionLabels(attribute, value) {
  if (!OPTION_INPUTS.has(attribute?.frontend_input) || !populated(value)) return null;
  return (Array.isArray(value) ? value : String(value).split(',')).map((id) => ({ optionId: String(id),
    label: attribute.options?.find((o) => o.value === String(id))?.label ?? null }));
}

function planPreview(amber, schema, raw, categoryNodes, { storeCode = 'all', generatedAt = new Date().toISOString(), domainEvidence } = {}) {
  const { product, revision } = amber;
  const expected = evaluate(amber, product);
  const base = expected.base; const mode = raw ? 'update' : 'create';
  const blockers = []; const warnings = [];
  const block = (code, details = {}) => blockers.push({ code, operation: blockerOperation(code, details), ...details });
  if (raw && raw.sku !== product.full_sku) block('CURRENT_PRODUCT_SKU_MISMATCH');
  const warn = (code, details = {}) => warnings.push({ code, ...details });
  const definition = amber.compiled.definition;
  const mapper = describeMapper(definition);
  let plans = [];
  try { plans = requirements(definition, revision?.schema || schema); }
  catch { block('ROUTE_ANALYSIS_UNSUPPORTED'); }
  const matching = plans.filter((r) => r.amberGroup === product.category && r.predicates.every((p) =>
    (String(product.details?.answers?.[p.questionKey] ?? '') === p.valueId) === p.equal));
  const route = matching.length === 1 ? matching[0] : null;
  if (!route) block('ATTRIBUTE_SET_ROUTE_UNRESOLVED');
  const decision = revision?.bindings.routes.find((r) => r.routeKey === route?.routeKey) || null;
  const predictedSets = schema.attributeSets.filter((s) => s.attribute_set_name === base.attribute_set_code);
  const selected = decision?.setId != null ? schema.attributeSets.find((s) => s.attribute_set_id === decision.setId)
    : predictedSets.length === 1 ? predictedSets[0] : null;
  const setStatus = decision?.reviewState === 'blocked' || decision?.enabled === false ? 'blocked'
    : !selected ? 'unresolved' : decision?.reviewState === 'approved' ? 'resolved_authoritative' : 'candidate_only';
  if (setStatus !== 'resolved_authoritative') block('ATTRIBUTE_SET_DECISION_REQUIRED', { status: setStatus, routeKey: route?.routeKey ?? null });
  const targets = new Set([...mapper.targets.map((t) => t.target), ...MERCHANDISING, ...Object.values(NATIVE),
    ...schema.attributes.filter((a) => a.is_required).map((a) => a.attribute_code)]);
  const current = raw ? productEvidence(raw, targets) : null;
  const attributeSet = { amberGroup: product.category, routeKey: route?.routeKey ?? null,
    evaluatorPredictedName: base.attribute_set_code ?? null, persistedDecision: decision,
    liveMatchingSets: predictedSets.map((s) => ({ id: s.attribute_set_id, name: s.attribute_set_name })),
    selected: selected ? { id: selected.attribute_set_id, name: selected.attribute_set_name } : null,
    currentMagentoSet: raw ? { id: raw.attribute_set_id,
      name: schema.attributeSets.find((s) => s.attribute_set_id === raw.attribute_set_id)?.attribute_set_name ?? null } : null,
    status: setStatus, diagnostics: [] };
  if (raw && selected && raw.attribute_set_id !== selected.attribute_set_id) {
    attributeSet.diagnostics.push('PRODUCT_ATTRIBUTE_SET_MISMATCH');
    warn('PRODUCT_ATTRIBUTE_SET_MISMATCH', { current: raw.attribute_set_id, candidate: selected.attribute_set_id });
  }
  if (decision?.setId != null && selected?.attribute_set_name !== base.attribute_set_code) {
    attributeSet.diagnostics.push('PERSISTED_ROUTE_DIFFERS_FROM_EVALUATOR');
  }
  if (product.category === 'SV' && String(product.details?.answers?.souvenir) === '5') {
    attributeSet.compatibilityEvidence = { source: 'operator_reported_bounded_compatibility_evidence', sampleCount: 20,
      historicalPredicted: { id: 154, name: 'Камінь' }, observed: { id: 151, name: 'Сувеніри', count: 20 },
      authority: 'candidate_only', usedToSelectSet: false };
  }
  if (!expected.ready) block('PRODUCT_EVALUATION_NOT_READY', { issueFields: expected.issueFields });
  const eligibility = syncEligibility(product, raw);
  for (const item of eligibility.reasons) block(item.code, { operation: 'all', reason: item.rule });
  const drift = revision ? compareSchema(revision, schema) : null;
  if (revision) {
    const validation = validateBindings(revision.bindings, definition, revision.schema);
    for (const issue of validation.diagnostics.filter((d) => !d.routeKey || d.routeKey === route?.routeKey)) block('PERSISTED_BINDING_INVALID', { diagnostic: issue });
    for (const d of drift.diagnostics) {
      const relevant = d.routeKey ? d.routeKey === route?.routeKey : d.bindingKey
        ? route?.attributes.some((a) => a.bindingKey === d.bindingKey) : false;
      if (relevant) block('BINDING_DRIFT_REVIEW_REQUIRED', { diagnostic: d });
      else warn('BINDING_SCHEMA_DRIFT', { diagnostic: d });
    }
  }
  const payload = { sku: product.full_sku, custom_attributes: [] };
  const attributes = []; const diff = []; const fieldOwnership = [];
  const group = definition.groups.find((g) => g.route === product.category);
  const values = current?.fields || {};
  const boundAttribute = (target) => revision?.bindings.attributes.find((a) => a.routeKey === route?.routeKey && a.rowId === 'base' && a.target === target);
  const policy = (target) => policyFor(revision, bindingKey(route?.routeKey || '', 'base', target), storeCode);

  for (const target of group?.columns || []) {
    const value = base[target] ?? null;
    const req = route?.attributes.find((a) => a.rowId === 'base' && a.target === target);
    const binding = boundAttribute(target);
    const attributeCode = binding?.attributeCode || target;
    const attr = schema.attributes.find((a) => a.attribute_code === attributeCode);
    const usage = mapper.targets.find((t) => t.target === target)?.usages.find((u) => u.amberGroup === product.category && u.row === 'base');
    const sources = mapper.sources.filter((s) => usage?.sourceIds.includes(s.id)).map((s) => ({ ...s,
      storedValue: s.questionKey ? product.details?.answers?.[s.questionKey] ?? null : product[s.field] ?? null }));
    // Only fixed literals use the standard Boolean source's native 0/1 contract.
    // Semantic answers (including calibration state 2) never enter this translation.
    const booleanControl = ['boolean', 'select'].includes(attr?.frontend_input)
      && attr.source_model === 'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Boolean'
      && usage?.sourceIds.length === 0 && !usage.dynamicOutput && usage.values.length > 0
      && usage.values.every((v) => v.kind === 'literal' && ['Yes', 'No'].includes(v.label));
    const strategy = booleanControl ? 'transport_control' : req?.strategy || (transport(target, attr) ? 'transport_control' : 'scalar');
    const native = NATIVE[target]; const domain = DOMAINS[target];
    const rawValue = values[native || attributeCode] ?? null;
    const labels = optionLabels(attr, rawValue);
    let candidate = null; let option = null; let candidates = null; let optionDecision = null;
    let authority = populated(value) ? 'scalar' : 'not_applicable';
    const diagnostics = [];
    const fail = (code) => { diagnostics.push(code); block(code, { target }); };
    const policyDecision = policy(target);
    const policyBlocked = policyDecision?.reviewState === 'blocked' || policyDecision?.policy === 'blocked';
    const blocked = binding?.reviewState === 'blocked' || policyBlocked;
    const isOption = OPTION_INPUTS.has(attr?.frontend_input) && !native && !domain;
    if (req && revision) {
      const matches = revision.bindings.options.filter((o) => o.bindingKey === req.bindingKey && (o.sourceKind === 'semantic'
        ? req.semanticSources.some((s) => s.amberGroup === o.amberGroup && s.questionKey === o.questionKey)
          && String(product.details?.answers?.[o.questionKey] ?? '') === o.valueId
        : o.domainKey === req.domainKey && o.outputKey === value));
      if (matches.length === 1) optionDecision = matches[0];
      else if (matches.length > 1) fail('OPTION_SOURCE_AMBIGUOUS');
    }
    if ((blocked && populated(value)) || optionDecision?.reviewState === 'blocked') {
      authority = 'blocked'; fail('MAPPING_EXPLICITLY_BLOCKED');
    } else if (populated(value)) {
      if (native) {
        candidate = target === 'attribute_set_code' ? selected?.attribute_set_id ?? null
          : ['price', 'weight'].includes(target) ? numeric(value) : target === 'visibility' ? VISIBILITY[value] ?? null
            : target === 'product_online' ? ['1', '2'].includes(String(value)) ? Number(value) : null : value;
        if ((target === 'price' && (candidate === null || candidate <= 0)) || (target === 'weight' && (candidate === null || candidate < 0))
          || (target === 'product_type' && candidate !== 'simple')
          || (target === 'sku' && candidate !== product.full_sku) || candidate === null) {
          candidate = null; authority = 'unresolved'; fail('INVALID_NATIVE_VALUE');
        } else authority = target === 'attribute_set_code' ? setStatus
          : binding?.reviewState === 'approved' ? 'authoritative' : 'scalar';
      } else if (domain || CSV_FIELDS.has(target)) {
        authority = 'candidate_only'; // Planned native operation, never a fake EAV field.
      } else if (!attr || attr.frontend_input === null) {
        authority = 'unresolved'; fail('ATTRIBUTE_METADATA_UNRESOLVED');
      } else if (booleanControl) {
        const nativeValue = value === 'Yes' ? '1' : value === 'No' ? '0' : null;
        const matches = attr.options?.filter((o) => !o.isEmpty && o.value === nativeValue) || [];
        option = matches.length === 1 ? matches[0] : null;
        candidate = option?.value ?? null;
        authority = option ? binding?.reviewState === 'approved' ? 'authoritative' : 'scalar' : 'unresolved';
        if (!option) fail('NATIVE_BOOLEAN_VALUE_UNRESOLVED');
      } else if (isOption) {
        candidates = optionCandidates(attr, String(value));
        if (optionDecision?.optionId) {
          option = attr.options?.find((o) => !o.isEmpty && o.value === optionDecision.optionId) || null;
          if (!option || optionDecision.evaluatedOutput !== value) fail('PERSISTED_OPTION_IDENTITY_MISMATCH');
          if (optionDecision.evaluatedOutput !== value) option = null;
        } else {
          const choices = candidates.exact.length ? candidates.exact : candidates.drift;
          if (choices.length === 1) option = { value: choices[0].optionId, label: choices[0].label };
        }
        candidate = option?.value ?? null;
        authority = option ? binding?.reviewState === 'approved' && optionDecision?.reviewState === 'approved'
          ? 'authoritative' : 'candidate_only' : 'unresolved';
        if (authority !== 'authoritative') fail(option ? 'OPTION_BINDING_REVIEW_REQUIRED' : 'OPTION_UNRESOLVED');
        if (candidates.status === 'label_drift_candidate') warn(authority === 'authoritative'
          ? 'APPROVED_LABEL_DIFFERENCE' : 'LABEL_DRIFT_REVIEW_REQUIRED', { target });
        if (req?.unsupportedSemanticOutput) fail('SEMANTIC_OUTPUT_DOMAIN_UNRESOLVED');
      } else {
        candidate = value; authority = binding?.reviewState === 'approved' ? 'authoritative' : 'scalar';
        if (!['text', 'textarea', 'price', 'weight', 'date', 'datetime'].includes(attr.frontend_input)) {
          candidate = null; authority = 'unresolved'; fail('ATTRIBUTE_INPUT_UNSUPPORTED');
        }
      }
    }
    // Compare installation membership independently from scalar/option resolution.
    const applicable = !populated(value) ? 'not_applicable' : native || domain ? 'native_control'
      : !selected ? 'unresolved' : selected.attributeCodes.includes(attributeCode) ? 'present' : 'absent';
    if (applicable === 'absent') fail('ATTRIBUTE_NOT_IN_SELECTED_SET');
    const productTypeApplicability = typeApplicability(attr, base.product_type);
    if (populated(value) && !native && !domain && productTypeApplicability === 'not_applicable') fail('ATTRIBUTE_NOT_APPLICABLE_TO_PRODUCT_TYPE');
    if (binding?.strategy === 'transport_control' && binding.transportTarget) {
      const expectedTarget = native ? `product.${native}` : domain ? `product.${domain}` : `product.custom_attributes.${attributeCode}`;
      if (binding.transportTarget !== expectedTarget) fail('TRANSPORT_BINDING_UNSUPPORTED');
    }
    if (binding && !['approved', 'blocked'].includes(binding.reviewState) && populated(value)) fail('ATTRIBUTE_BINDING_REVIEW_REQUIRED');
    let preserve = false; let ownership = policyDecision?.policy || 'preview_default';
    const approvedPolicy = policyDecision?.reviewState === 'approved';
    if (approvedPolicy && !raw && target === 'product_online' && policyDecision.policy === 'initialize_create_only'
      && policyDecision.evidence?.createValue === 2 && candidate !== null) candidate = 2;
    if (approvedPolicy && (policyDecision.policy === 'magento_managed' || (raw && policyDecision.policy === 'initialize_create_only'))) preserve = true;
    if (!approvedPolicy && raw && (MERCHANDISING.includes(target) || (target === 'name' && comparison(value, rawValue) !== 'exact'))) {
      preserve = true; ownership = 'preserve_by_safe_preview';
      if (target === 'name') fail('ownership_review_required');
    }
    if (!approvedPolicy && !raw && MERCHANDISING.includes(target)) {
      preserve = true; ownership = 'optional_create_policy_required';
      if (populated(value)) warn('OPTIONAL_MERCHANDISING_POLICY_REQUIRED', { target });
    }
    if (policyDecision && !['approved', 'blocked'].includes(policyDecision.reviewState) && populated(value)) fail('FIELD_POLICY_REVIEW_REQUIRED');
    if (preserve && raw && comparison(value, rawValue) !== 'exact') warn('FIELD_INTENTIONALLY_PRESERVED', { target });
    // Omission preserves maintained content, including current names; never synthesize clearing blanks.
    const writable = !preserve && !blocked && authority !== 'blocked' && candidate !== null && !domain;
    if (writable && native) payload[native] = candidate;
    else if (writable && attr) payload.custom_attributes.push({ attribute_code: attributeCode, value: candidate });
    const compared = isOption ? comparison(option?.label ?? value, labels?.map((l) => l.label).join(',') ?? null, true)
      : comparison(candidate ?? value, rawValue);
    const same = ['exact', 'numeric_equivalent_formatting'].includes(compared)
      && (!isOption || String(rawValue) === String(candidate));
    if (writable && !same && !['sku', 'attribute_set_code'].includes(target)) {
      if (!binding) fail('ATTRIBUTE_BINDING_REQUIRED');
      if (!approvedPolicy) fail('FIELD_OWNERSHIP_REVIEW_REQUIRED');
    }
    if (compared === 'numeric_equivalent_formatting') warn('NUMERIC_FORMATTING_DIFFERENCE', { target });
    if (compared === 'rounded_legacy_value') warn('LEGACY_REMOTE_ROUNDED_VALUE', { target });
    const action = preserve ? 'preserve' : authority === 'blocked' ? 'blocked' : !populated(value) ? 'unchanged'
      : candidate === null ? domain ? 'blocked' : 'unresolved' : same ? 'unchanged' : populated(rawValue) ? 'would_update' : 'would_add';
    attributes.push({ target, source: sources, evaluatedValue: value, strategy, magentoAttributeCode: native || domain ? null : attributeCode,
      magentoAttributeId: attr?.attribute_id ?? null, magentoOptionId: option?.value ?? null, resolvedOptionLabel: option?.label ?? null,
      persistedDecision: binding || null, optionDecision, candidates, authority, applicability: applicable,
      productTypeApplicability, nativeTranslation: booleanControl ? 'csv_boolean_to_native_value' : null,
      currentSetApplicability: raw ? schema.attributeSets.find((s) => s.attribute_set_id === raw.attribute_set_id)?.attributeCodes.includes(attributeCode) ?? null : null,
      currentRawValue: rawValue, currentResolvedOptions: labels, wouldChange: writable && !same, diagnostics });
    fieldOwnership.push({ target, policy: ownership, persistedDecision: policyDecision, action });
    diff.push({ target, current: rawValue, currentLabel: labels, evaluated: value,
      candidate, comparison: compared, authority, action, includedInPayload: writable });
  }
  // Required native values may be omitted only when preserving a valid existing field.
  for (const field of ['sku', 'attribute_set_id', 'name', 'price', 'status', 'visibility', 'type_id']) {
    if (!populated(payload[field]) && (!raw || !populated(raw[field]))) block('REQUIRED_NATIVE_FIELD_MISSING', { field });
  }
  if (raw && raw.type_id !== 'simple') block('CURRENT_PRODUCT_TYPE_UNSUPPORTED');
  const requiredAttributes = [];
  for (const a of schema.attributes.filter((a) => a.is_required && selected?.attributeCodes.includes(a.attribute_code))) {
    const applicability = typeApplicability(a, payload.type_id || raw?.type_id);
    requiredAttributes.push({ attributeCode: a.attribute_code, applyTo: a.apply_to ?? null, applicability });
    if (applicability === 'not_applicable') continue;
    const candidate = payload[a.attribute_code] ?? payload.custom_attributes.find((v) => v.attribute_code === a.attribute_code)?.value;
    if (!populated(candidate) && !populated(values[a.attribute_code])) block('REQUIRED_ATTRIBUTE_VALUE_MISSING', { target: a.attribute_code });
  }
  const taxonomyPolicy = policy('categories');
  const taxonomyOwned = taxonomyPolicy?.reviewState === 'approved' && taxonomyPolicy.policy === 'authoritative_create_update';
  const categories = resolveCategories(base.categories || '', categoryNodes, currentAssignments(raw), { ownershipApproved: taxonomyOwned,
    decisions: boundAttribute('categories')?.evidence?.categories || [] });
  const categoryTarget = require('./category-create-target');
  for (const item of categories.requested.filter((r) => r.normalizedPath === categoryTarget.PATH && product.category === 'KL'
    && String(product.details?.answers?.addit) === '1')) {
    item.source = categoryTarget.SOURCE;
    if (!item.categoryId && !item.exactCandidates.length && revision?.state === 'draft') item.createAction = {
      command: `npm run magento:category -- --revision ${revision.id} --path "${categoryTarget.PATH}"`,
      parentPath: categoryTarget.PARENT, requiresApply: true, recursive: false,
      applyArguments: ['--apply', '--expected-revision', revision.revision, '--actor-user-id', '<local-user-id>'] };
  }
  for (const r of categories.requested) if (!r.categoryId) block(r.status === 'ambiguous' ? 'CATEGORY_PATH_AMBIGUOUS' : 'CATEGORY_PATH_MISSING', { path: r.requestedPath });
  for (const r of categories.requested) {
    if (r.authority === 'blocked') block('CATEGORY_MAPPING_BLOCKED', { path: r.requestedPath });
    if (r.drifted) block('CATEGORY_BINDING_DRIFT', { path: r.requestedPath });
  }
  if (categories.requested.some((r) => r.categoryId && r.authority === 'candidate_only')) block('CATEGORY_IDENTITIES_REVIEW_REQUIRED');
  if (categories.wouldAdd.length && taxonomyPolicy?.reviewState !== 'approved') block('CATEGORY_OWNERSHIP_REVIEW_REQUIRED');
  if (categories.preservedMagentoOnly.length) warn('MAGENTO_ONLY_CATEGORIES_PRESERVED', { count: categories.preservedMagentoOnly.length });
  if (!categories.currentKnown) block('CURRENT_CATEGORY_ASSIGNMENTS_UNAVAILABLE');
  const categoryPreserved = fieldOwnership.find((f) => f.target === 'categories')?.action === 'preserve';
  const categoryBlocked = attributes.find((a) => a.target === 'categories')?.authority === 'blocked';
  if (categories.candidateLinks && categories.requested.length && !categoryPreserved && !categoryBlocked) {
    payload.extension_attributes = { category_links: categories.candidateLinks };
  } else if (categories.requested.length && !categories.candidateLinks) block('CATEGORY_NATIVE_PAYLOAD_UNRESOLVED');
  const categoryDiff = diff.find((d) => d.target === 'categories');
  if (categoryDiff) Object.assign(categoryDiff, { current: categories.current, candidate: categories.candidateLinks,
    comparison: categories.wouldAdd.length || (taxonomyOwned && categories.wouldRemoveIfAuthoritative.length) ? 'semantic_difference' : 'exact',
    action: categoryBlocked ? 'blocked' : categoryPreserved ? 'preserve' : categories.candidateLinks
      ? categories.wouldAdd.length || (taxonomyOwned && categories.wouldRemoveIfAuthoritative.length) ? 'would_update' : 'unchanged' : 'unresolved',
    includedInPayload: Boolean(payload.extension_attributes?.category_links) });
  const transportReport = planDomains({ expected, schema, revision, routeKey: route?.routeKey,
    raw, sku: product.full_sku, evidence: domainEvidence, block });
  for (const target of ['qty', 'is_in_stock', 'product_websites']) {
    const entry = diff.find((d) => d.target === target);
    const domain = target === 'product_websites' ? transportReport.websites : transportReport.inventory;
    if (entry) Object.assign(entry, { current: target === 'product_websites' ? domain.currentIds : domain.current,
      candidate: target === 'product_websites' ? domain.operations : domain.candidatePayload,
      action: domain.action, includedInPayload: false, operation: FIELD_OPERATION[target] });
    const ownership = fieldOwnership.find((f) => f.target === target);
    if (ownership) ownership.action = domain.action;
  }
  if (product.category === 'CH' && raw) {
    const direction = orientation(base.dovzhyna_namystyny, base.diametr_namystyny,
      values.dovzhyna_namystyny, values.diametr_namystyny);
    if (direction === 'reversed') {
      warn('LEGACY_REMOTE_DIMENSIONS_REVERSED');
      for (const d of diff.filter((d) => ['dovzhyna_namystyny', 'diametr_namystyny', 'rozmir_kameniu'].includes(d.target))) d.compatibility = 'legacy_remote_mismatch';
    }
    const size = diff.find((d) => d.target === 'rozmir_kameniu');
    if (size && size.comparison !== 'exact') { size.compatibility = 'legacy_remote_mismatch'; warn('LEGACY_REMOTE_SIZE_TEXT_MISMATCH'); }
  }
  const written = new Set(payload.custom_attributes.map((a) => a.attribute_code));
  const untouched = raw ? (raw.custom_attributes || []).filter((a) => !written.has(a.attribute_code))
    .map((a) => ({ field: a.attribute_code, action: 'preserve', reason: 'omitted_from_candidate_payload' })) : [];
  if (raw) {
    for (const field of ['name', 'price', 'status', 'visibility', 'type_id', 'weight', 'media_gallery_entries', 'product_links', 'tier_prices', 'options']) {
      if (Object.hasOwn(raw, field) && !Object.hasOwn(payload, field)) untouched.push({ field, action: 'preserve', reason: 'omitted_from_candidate_payload' });
    }
    for (const field of ['website_ids', 'stock_item']) if (Object.hasOwn(raw.extension_attributes || {}, field)) {
      untouched.push({ field: `extension_attributes.${field}`, action: 'preserve', reason: field === 'stock_item' ? 'preserve_inventory_on_update' : 'separate_additive_website_operation' });
    }
  }
  const dedup = (items) => [...new Map(items.map((x) => [JSON.stringify(x), x])).values()];
  const finalBlockers = dedup(blockers);
  return { reportVersion: 1, generatedAt, mode, amberProduct: { id: product.id, sku: product.full_sku,
    group: product.category, status: product.status, schemaVersionId: product.sku_schema_version_id ?? null,
    sourceAnswers: Object.fromEntries(Object.values(definition.sources).filter((s) => s.category === product.category)
      .map((s) => [s.key, product.details?.answers?.[s.key] ?? null])) },
    sources: { amberObservedAt: amber.observedAt, template: amber.template, magentoScope: storeCode,
      observationConsistency: 'Local repeatable-read snapshot followed by sequential non-atomic Magento GETs' },
    evaluation: { ready: expected.ready, issueFields: expected.issueFields }, syncEligibility: eligibility, requiredAttributes,
    bindingRevision: revision ? { id: revision.id, state: revision.state, revision: revision.revision,
      templateVersionId: revision.templateVersionId, drift } : null,
    attributeSet, attributes, categories, fieldOwnership, untouchedMagentoFields: untouched,
    transport: transportReport, currentMagento: current, candidatePayload: { product: payload }, diff,
    warnings: dedup(warnings), blockers: finalBlockers, sendable: finalBlockers.length === 0,
    sendability: sendability(finalBlockers, { product: payload }, transportReport),
    limitations: ['No execution or approval is performed. Inventory, website and store-view plans are separate native operations; no writers are implemented.',
      'Candidate category/option labels never create approved bindings. Preview preservation defaults are not persisted.'] };
}

async function previewProduct(config, { databasePool, fetchImpl, storeCode = 'all', now = () => new Date().toISOString(),
  readAmber = readPreviewProduct, discover = auditMagentoSchema, sensitiveValues = [], onObservation, ...selection } = {}) {
  const amber = await readAmber(databasePool, selection);
  if (amber.revision && (amber.revision.originHash !== originHash(config.baseUrl) || amber.revision.schema.storeCode !== storeCode)) {
    throw error(422, 'MAGENTO_BINDING_INSTALLATION_OR_SCOPE_MISMATCH', 'Binding installation or observation scope differs');
  }
  const schema = await discover(config, { fetchImpl, storeCode });
  const client = createMagentoClient(config, { fetchImpl, storeCode });
  let raw = null;
  try { raw = await client.findProductBySku(amber.product.full_sku); }
  catch (cause) { if (cause.code !== 'MAGENTO_PRODUCT_NOT_FOUND') throw cause; }
  const roots = [...new Set(schema.storeTopology.storeGroups.map((g) => g.root_category_id).filter((id) => id > 0))];
  if (roots.length > 100) throw error(422, 'MAGENTO_PREVIEW_CATEGORY_LIMIT', 'Too many category roots');
  const trees = []; const categoryFailures = [];
  for (const id of roots) {
    let tree;
    try { tree = await client.getCategoryTree(id); }
    catch (cause) {
      if (!['MAGENTO_HTTP_ERROR', 'MAGENTO_NETWORK_ERROR', 'MAGENTO_TIMEOUT'].includes(cause.code)) throw cause;
      categoryFailures.push({ code: 'CATEGORY_TREE_UNAVAILABLE', operation: 'categories', rootCategoryId: id, reason: cause.code });
      continue;
    }
    if (Number(tree?.id) !== id) throw error(422, 'MAGENTO_PREVIEW_CATEGORIES_INVALID', 'Category root differs');
    trees.push(tree);
  }
  const domainEvidence = await readDomains(config, { client, schema, sku: amber.product.full_sku, raw,
    expected: evaluate(amber, amber.product), fetchImpl });
  const report = planPreview(amber, schema, raw, indexTrees(trees), { storeCode, generatedAt: now(), domainEvidence });
  if (categoryFailures.length) {
    report.categories.readFailures = categoryFailures;
    report.blockers.push(...categoryFailures);
    report.sendable = false; report.sendability = sendability(report.blockers, report.candidatePayload, report.transport);
  }
  assertEvidenceSafe(report, config, sensitiveValues);
  if (onObservation) await onObservation({ amber, schema, raw, categoryNodes: indexTrees(trees), domainEvidence, categoryFailures });
  return report;
}
module.exports = { previewProduct, planPreview, comparison };
