// Pure projection of one fresh, server-owned first-sync observation.
// This module neither loads data nor writes it. Runtime setters must validate,
// lock and CAS the canonical source before any import or durable receipt.
const { assertCompiled } = require('../export-templates/definition');
const { evaluateProduct } = require('../export-templates/evaluate');
const { own, readSource } = require('../export-templates/input-projection');
const { normalizeSchema, hash } = require('./binding-contract');
const { requirements, normalizeBindings, validateBindings } = require('./binding-validation');
const { compareSchema } = require('./binding-drift');
const ownership = require('./native-identity-ownership');
const { isLegacySv } = require('./first-sync-legacy-inputs');
const { planFirstSyncFields, normalizeDecimal } = require('./first-sync-field-plan');

const INFORMATION = Object.freeze({ BR: ['braclet_size'], NM: ['neckle_size'],
  KL: ['exact_size'], CH: ['bead_length', 'bead_width', 'rosary_length'], SV: ['size'] });
const CONTROLS = new Set(['weight', 'sku', 'store_view_code', 'attribute_set_code', 'product_type',
  'product_online', 'visibility', 'qty', 'is_in_stock', 'product_websites', 'categories',
  'old_product', 'is_own_production', 'is_ownproduction', 'tax_class_name', 'allow_backorders',
  'use_config_manage_stock', 'manage_stock', 'out_of_stock_qty', 'weight']);
const PHOTOS = new Set(['base_image', 'small_image', 'thumbnail_image', 'additional_images',
  'base_image_label', 'small_image_label', 'thumbnail_image_label', 'additional_image_labels']);
const RECEIPT_STATES = new Set(['imported', 'equal', 'optional_empty', 'outward_verified', 'name_received']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const present = value => value !== null && value !== undefined
  && !(typeof value === 'string' && value.trim() === '');
const scalar = value => value === null || typeof value === 'boolean'
  || typeof value === 'string' && value.length <= 4096
  || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
function invalid(reason) {
  throw Object.assign(new Error('Invalid bounded first-sync projection input'),
    { code: 'FIRST_SYNC_PROJECTION_INPUT_INVALID', statusCode: 422, details: { reason } });
}
function object(value, reason) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== 'string'
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) invalid(reason);
  return value;
}
function shape(value, required, optional, reason) {
  object(value, reason);
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => ![...required, ...optional].includes(key))) invalid(reason);
}
function denseArray(value, limit, reason) {
  if (!Array.isArray(value) || value.length > limit
    || Reflect.ownKeys(value).some(key => typeof key !== 'string' || key !== 'length'
      && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) invalid(reason);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid(reason);
  }
}
function receiptsMap(receipts) {
  const result = new Map();
  if (receipts === undefined) return result;
  const put = (target, scope, receipt) => {
    if (typeof target !== 'string' || typeof scope !== 'string'
      || !IDENTIFIER.test(target) || !IDENTIFIER.test(scope)) invalid('RECEIPT_IDENTITY_INVALID');
    shape(receipt, ['state'], [], 'RECEIPT_INVALID');
    if (!RECEIPT_STATES.has(receipt.state) || receipt.state === 'name_received' && target !== 'name') {
      invalid('RECEIPT_STATE_INVALID');
    }
    const key = scope + '/' + target;
    if (result.has(key)) invalid('RECEIPT_DUPLICATE');
    result.set(key, { state: receipt.state });
  };
  if (Array.isArray(receipts)) {
    denseArray(receipts, 500, 'RECEIPTS_INVALID');
    for (const receipt of receipts) {
      shape(receipt, ['target', 'scope', 'state'], [], 'RECEIPT_INVALID');
      put(receipt.target, receipt.scope, { state: receipt.state });
    }
  } else {
    object(receipts, 'RECEIPTS_INVALID');
    if (Object.keys(receipts).length > 500) invalid('RECEIPTS_INVALID');
    for (const [key, receipt] of Object.entries(receipts)) {
      const parts = key.split('/');
      if (parts.length !== 2) invalid('RECEIPT_IDENTITY_INVALID');
      put(parts[1], parts[0], receipt);
    }
  }
  return result;
}
function state(value, unit) {
  if (!scalar(value) && value !== undefined) return { known: false };
  return { known: true, present: present(value), ...(value === undefined ? {} : { value }),
    ...(unit ? { unit } : {}) };
}
function sourceState(descriptor, product, unit) {
  try { return state(readSource(descriptor, product), unit); }
  catch { return { known: false }; }
}
function directSource(cell, definition) {
  const refs = new Map(definition.bindings.map(binding => [binding.id, binding.value]));
  const deref = (node, count = 0) => count > 40 ? null
    : node?.op === 'ref' ? deref(refs.get(node.id), count + 1) : node;
  const emptyOrError = node => {
    node = deref(node);
    return node?.op === 'error' || node?.op === 'literal' && node.value === '';
  };
  const visit = (raw, depth = 0) => {
    if (depth > 40) return null;
    const node = deref(raw);
    if (!node) return null;
    if (node.op === 'source') return { id: node.id, wrappers: [], required: false };
    if (['text', 'numberText', 'decimalText'].includes(node.op)) {
      // Trimming is admitted only by the exact information-source check below.
      // String-only coercion has no canonical scalar reverse contract.
      if (node.op === 'text' && node.format !== 'scalar-v1') return null;
      const inner = visit(node.input, depth + 1);
      return inner && { ...inner, wrappers: [...inner.wrappers, node.op], trimmed: inner.trimmed || node.op === 'text' && node.trim };
    }
    if (node.op === 'questionValue') {
      const contract = definition.questionContracts[node.question];
      const inner = visit(node.value, depth + 1);
      return contract?.exists && inner?.id === contract.source
        && Object.keys(contract.rule || {}).length === 0
        ? { ...inner, required: inner.required || Boolean(contract.required) } : null;
    }
    if (node.op === 'require' || node.op === 'when') {
      const condition = deref(node.if);
      const conditionSource = condition?.op === 'present' ? visit(condition.input, depth + 1) : null;
      const value = visit(node.op === 'require' ? node.value : node.then, depth + 1);
      const fallback = node.op === 'require' ? node.error : node.else;
      return conditionSource && value && conditionSource.id === value.id
        && emptyOrError(fallback) ? { ...value, required: value.required || deref(fallback).op === 'error' } : null;
    }
    return null;
  };
  return visit(cell);
}
function englishKnown(schema, pinned, evidence, raw) {
  const current = schema.storeTopology.storeViews.filter(view => view.code === 'en' && view.is_active === true);
  const saved = pinned.storeTopology.storeViews.filter(view => view.code === 'en' && view.is_active === true);
  if (current.length !== 1 || saved.length !== 1 || ['id', 'website_id', 'store_group_id']
    .some(key => current[0][key] !== saved[0][key])) return 'EN_SCOPE_IDENTITY_NOT_PROVEN';
  if ((evidence.failures || []).some(failure => failure.operation === 'storeViews'
    || failure.code === 'STORE_VIEW_READ_UNAVAILABLE')) return 'EN_REMOTE_READ_FAILED';
  const english = evidence.english;
  if (!english || own(english, 'id') !== raw.id || own(english, 'sku') !== raw.sku
    || !own(english, 'fields')) return 'EN_EXACT_PRODUCT_EVIDENCE_REQUIRED';
  object(english.fields, 'EN_FIELDS_INVALID');
  return null;
}
function nativeValues(raw) {
  const custom = own(raw, 'custom_attributes');
  const values = new Map();
  if (custom !== undefined) {
    denseArray(custom, 1000, 'REMOTE_CUSTOM_ATTRIBUTES_INVALID');
    for (const row of custom) {
      object(row, 'REMOTE_CUSTOM_ATTRIBUTE_INVALID');
      const code = own(row, 'attribute_code');
      if (typeof code !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(code)
        || !Object.hasOwn(row, 'value') || values.has(code)) invalid('REMOTE_CUSTOM_ATTRIBUTE_DUPLICATE_OR_INVALID');
      values.set(code, row.value);
    }
  }
  return target => Object.hasOwn(raw, target) ? own(raw, target) : values.get(target);
}
function emptyResult(mode, blockers, coverage = []) {
  return { mode, fields: [], projection: [], coverage: { fields: coverage,
    fullProductAdoption: false, photos: 'unsupported_without_url_import' }, blockers,
  plan: null, readyForOutbound: false, complete: false };
}
function effectiveLocalName(product, evaluated, scope) {
  const generated = evaluated.generatedNames || { all: evaluated.base?.name, en: evaluated.english?.name };
  // Retain invalid, bounded prior full names as exact CAS evidence. The first
  // populated remote name is authoritative independently for each language.
  for (const key of ['magento_name_override', 'magento_name_rule_pin']) {
    const saved = own(product, key);
    const previous = saved && own(saved, 'generated');
    if (previous && own(previous, 'all') === generated.all && own(previous, 'en') === generated.en) {
      const values = own(saved, 'values');
      if (values && Object.hasOwn(values, scope)) return state(own(values, scope));
    }
  }
  const row = scope === 'all' ? evaluated.base : evaluated.english;
  return row && Object.hasOwn(row, 'name') ? state(row.name) : { known: false };
}
function projectFirstSyncFields(input) {
  shape(input, ['observation'], ['report', 'receipts', 'currencyEvidence'], 'INPUT_SHAPE_INVALID');
  shape(input.observation, ['amber', 'raw', 'schema', 'domainEvidence'], [], 'OBSERVATION_SHAPE_INVALID');
  const { amber, raw } = input.observation;
  object(amber, 'AMBER_INVALID');
  const product = object(own(amber, 'product'), 'PRODUCT_INVALID');
  const receipts = receiptsMap(input.receipts);
  if (input.currencyEvidence !== undefined) {
    shape(input.currencyEvidence, ['verified'], ['currency', 'reason'], 'CURRENCY_EVIDENCE_INVALID');
    if (typeof input.currencyEvidence.verified !== 'boolean'
      || input.currencyEvidence.currency !== undefined && (typeof input.currencyEvidence.currency !== 'string'
        || !/^[A-Z]{3}$/.test(input.currencyEvidence.currency))
      || input.currencyEvidence.reason !== undefined && (typeof input.currencyEvidence.reason !== 'string'
        || input.currencyEvidence.reason.length > 160)) invalid('CURRENCY_EVIDENCE_INVALID');
  }
  if (raw === null) return emptyResult('create', []);
  object(raw, 'REMOTE_PRODUCT_INVALID');
  const compiled = own(amber, 'compiled'), revision = own(amber, 'revision'), template = own(amber, 'template');
  try { assertCompiled(compiled); } catch { return emptyResult('review_required', [{ code: 'EXACT_COMPILED_DEFINITION_REQUIRED' }]); }
  if (!revision || revision.state !== 'published' || !template || template.kind !== 'published'
    || template.versionId !== revision.templateVersionId || template.definitionHash !== compiled.hash
    || revision.definitionHash !== compiled.hash || typeof revision.id !== 'string'
    || revision.evaluatorVersion !== compiled.definition.evaluatorVersion
    || revision.outputContract !== compiled.definition.outputContract
    || revision.formatVersion !== compiled.definition.formatVersion) {
    return emptyResult('review_required', [{ code: 'PUBLISHED_DEFINITION_BINDING_IDENTITY_MISMATCH' }]);
  }
  const sku = own(product, 'public_sku') || own(product, 'full_sku');
  if (typeof sku !== 'string' || raw.sku !== sku || !Number.isSafeInteger(raw.id) || raw.id <= 0
    || !Number.isSafeInteger(raw.attribute_set_id) || raw.attribute_set_id <= 0) {
    return emptyResult('review_required', [{ code: 'EXACT_REMOTE_PRODUCT_IDENTITY_REQUIRED' }]);
  }
  const ownerIssue = ownership.issue(amber, raw);
  if (ownerIssue) return emptyResult('review_required', [{ code: ownerIssue }]);
  if (input.report !== undefined) {
    object(input.report, 'REPORT_INVALID');
    if (input.report.bindingRevision?.id && input.report.bindingRevision.id !== revision.id) {
      return emptyResult('review_required', [{ code: 'REPORT_BINDING_REVISION_MISMATCH' }]);
    }
  }
  let schema, pinned, bindings, plans, validation, drift;
  try {
    schema = normalizeSchema(input.observation.schema);
    pinned = normalizeSchema(revision.schema);
    bindings = normalizeBindings(revision.bindings);
    if (schema.storeCode !== 'all' || pinned.storeCode !== 'all'
      || hash(pinned) !== revision.schemaFingerprint
      || hash(pinned.storeTopology) !== revision.topologyFingerprint) {
      return emptyResult('review_required', [{ code: 'PUBLISHED_SCHEMA_INTEGRITY_OR_SCOPE_INVALID' }]);
    }
    plans = requirements(compiled.definition, pinned);
    validation = validateBindings(bindings, compiled.definition, pinned, { publish: true });
    drift = compareSchema({ ...revision, bindings }, schema);
  } catch {
    return emptyResult('review_required', [{ code: 'BINDING_OR_SCHEMA_EVIDENCE_INVALID' }]);
  }
  const category = own(product, 'category');
  const routePlans = plans.filter(plan => plan.amberGroup === category && plan.predicates.every(predicate => {
    const value = own(own(own(product, 'details'), 'answers'), predicate.questionKey);
    // A missing/unknown semantic source cannot prove the negative branch.
    return ['string','number'].includes(typeof value) && /^(0|-?[1-9][0-9]*)$/.test(String(value))
      && Number.isSafeInteger(Number(value)) && (String(value) === predicate.valueId) === predicate.equal;
  }));
  if (routePlans.length !== 1) return emptyResult('review_required', [{
    code: routePlans.length ? 'CATEGORY_REMOTE_ROUTE_AMBIGUOUS' : 'CATEGORY_REMOTE_ROUTE_NOT_APPROVED', category }]);
  const routes = bindings.routes.filter(route => route.enabled && route.reviewState === 'approved'
    && route.setId === raw.attribute_set_id && routePlans.some(plan => plan.routeKey === route.routeKey));
  if (routes.length !== 1) return emptyResult('review_required', [{
    code: routes.length ? 'CATEGORY_REMOTE_ROUTE_AMBIGUOUS' : 'CATEGORY_REMOTE_ROUTE_NOT_APPROVED',
    category, remoteAttributeSetId: raw.attribute_set_id }]);
  const route = routes[0], routePlan = plans.find(plan => plan.routeKey === route.routeKey);
  const group = compiled.definition.groups.find(candidate => candidate.route === category);
  const evidence = object(input.observation.domainEvidence, 'DOMAIN_EVIDENCE_INVALID');
  if (evidence.failures !== undefined) {
    denseArray(evidence.failures, 20, 'DOMAIN_FAILURES_INVALID');
    evidence.failures.forEach(failure => object(failure, 'DOMAIN_FAILURE_INVALID'));
  }
  const enReason = englishKnown(schema, pinned, evidence, raw);
  const getRemote = nativeValues(raw);
  // Do not spread product: its private immutable-schema proof is object-owned.
  let evaluated;
  try { evaluated = evaluateProduct(compiled, product); }
  catch { evaluated = { errors: [{ code: 'LOCAL_FORWARD_EVALUATION_UNAVAILABLE' }] }; }
  const fields = [], projection = [], coverage = [], blockers = [];
  const routeReasons = [...validation.diagnostics, ...drift.diagnostics]
    .filter(issue => issue.routeKey === route.routeKey && !issue.bindingKey);
  const errors = evaluated.errors || [];
  const forward = (target, scope) => {
    const row = scope === 'all' ? evaluated.base : evaluated.english;
    const relevant = errors.some(issue => issue.field === target || issue.field === 'sourceSupport'
      || issue.code === 'LOCAL_FORWARD_EVALUATION_UNAVAILABLE');
    return row && Object.hasOwn(row, target) && !relevant ? { verified: true, value: row[target] }
      : { verified: false, reason: 'PROSPECTIVE_CANONICAL_INPUTS_NOT_PROVEN' };
  };
  for (const row of group.rows) for (const [target, cell] of Object.entries(row.cells)) {
    const scope = row.id === 'english' ? 'en' : 'all';
    if (CONTROLS.has(target)) {
      coverage.push({ target, scope, state: 'ignored', reason: target === 'weight'
        ? 'NATIVE_MAGENTO_WEIGHT_NOT_A_CANONICAL_GRAM_SOURCE' : 'IDENTITY_ARCHIVE_INVENTORY_OR_TRANSPORT_CONTROL' }); continue;
    }
    if (PHOTOS.has(target)) {
      coverage.push({ target, scope, state: 'unsupported', reason: 'PHOTO_URL_IMPORT_NOT_IMPLEMENTED' }); continue;
    }
    const expected = routePlan.attributes.find(attribute => attribute.target === target && attribute.rowId === row.id);
    // A frozen literal empty column has no business mapping in this route.
    if (!expected && cell.op === 'literal' && cell.value === '') {
      coverage.push({ target, scope, state: 'ignored', reason: 'UNMAPPED_EMPTY_COLUMN' }); continue;
    }
    const binding = bindings.attributes.find(attribute => attribute.bindingKey === expected?.bindingKey);
    const policy = bindings.policies.find(candidate => candidate.bindingKey === expected?.bindingKey
      && candidate.storeCode === scope);
    const attr = schema.attributes.find(attribute => attribute.attribute_code === target);
    const pinnedAttr = pinned.attributes.find(attribute => attribute.attribute_code === target);
    let reason = routeReasons[0]?.code || null;
    if (attr && pinnedAttr && attr.is_required !== pinnedAttr.is_required) reason ||= 'ATTRIBUTE_REQUIREDNESS_CHANGED';
    if (!expected || !binding || binding.reviewState !== 'approved'
      || binding.attributeCode !== target || binding.strategy !== expected.strategy) reason ||= 'FIELD_BINDING_NOT_APPROVED';
    if (!policy || policy.reviewState !== 'approved' || policy.policy === 'blocked') reason ||= 'FIELD_POLICY_NOT_APPROVED';
    const relevant = [...validation.diagnostics, ...drift.diagnostics]
      .filter(issue => issue.bindingKey === expected?.bindingKey);
    reason ||= relevant[0]?.code || null;
    if (scope === 'en' && (!attr || attr.scope !== 'store' || !['text', 'textarea'].includes(attr.frontend_input))) {
      reason ||= 'STORE_SCOPE_ATTRIBUTE_UNSUPPORTED';
    }
    const remoteValue = scope === 'all' ? getRemote(target) : evidence.english?.fields
      && own(evidence.english.fields, target);
    const remote = scope === 'en' && enReason ? { known: false } : state(remoteValue);
    if (!remote.known && !enReason) reason ||= 'REMOTE_VALUE_TYPE_UNSUPPORTED';
    const direct = directSource(cell, compiled.definition);
    let descriptor = direct && compiled.definition.sources[direct.id];
    if (direct?.trimmed && !(descriptor?.kind === 'information' && descriptor.category === category
      && INFORMATION[category]?.includes(descriptor.key) && !descriptor.aliases.length && scope === 'all'
      && direct.wrappers.every(wrapper => wrapper === 'text'))) descriptor = null;
    let persistence = 'derived', local = { known: true, present: false }, kind = 'derived', type = 'text';
    let unit, scale, constraints, prospective, reverseCandidates, importBlocker = null;
    if (target === 'name') {
      persistence = 'name'; kind = 'name'; local = effectiveLocalName(product, evaluated, scope);
      descriptor = { kind: 'name', field: scope === 'all' ? 'magento_name_override.values.all' : 'magento_name_override.values.en' };
    } else if (expected?.strategy === 'semantic_option') {
      const semanticSources = expected.semanticSources.filter(source => source.amberGroup === category);
      if (expected.unsupportedSemanticOutput || semanticSources.length !== 1) reason ||= 'SEMANTIC_SOURCE_NOT_UNIQUE';
      const source = semanticSources[0];
      descriptor = source && Object.values(compiled.definition.sources).find(candidate => candidate.kind === 'semantic'
        && candidate.category === source.amberGroup && candidate.key === source.questionKey);
      if (!descriptor) reason ||= 'SEMANTIC_SOURCE_NOT_PROVEN';
      persistence = 'characteristic'; kind = 'option'; type = 'option';
      local = descriptor ? sourceState(descriptor, product) : { known: false };
      const options = bindings.options.filter(option => option.bindingKey === expected.bindingKey
        && option.reviewState === 'approved' && option.sourceKind === 'semantic'
        && expected.options.some(candidate => candidate.sourceKey === option.sourceKey
          && candidate.evaluatedOutput === option.evaluatedOutput) && option.optionId?.length <= 128);
      reverseCandidates = options.map(option => ({ value: option.valueId, optionId: option.optionId }));
      const value = local.present && String(local.value);
      const candidate = options.find(option => option.valueId === value
        && option.amberGroup === descriptor?.category && option.questionKey === descriptor?.key);
      const output = forward(target, scope);
      if (candidate && output.verified && output.value === candidate.evaluatedOutput) local.forwardOptionId = candidate.optionId;
      else if (local.present) reason ||= 'LOCAL_FORWARD_OPTION_NOT_PROVEN';
      importBlocker = descriptor?.key === 'is_calibrated' ? 'FIRST_SYNC_CANONICAL_CALIBRATION_REVIEW_REQUIRED'
        : isLegacySv(product) ? local.present ? 'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED' : null
        : product.characteristic_version_id != null && !product.full_sku ? null
        : 'HISTORICAL_IDENTITY_CHARACTERISTIC_IMPORT_UNSUPPORTED';
    } else if (descriptor?.kind === 'product' && descriptor.field === 'total_price_uah' && target === 'price') {
      persistence = 'price'; kind = 'scalar'; type = 'decimal'; unit = 'UAH'; scale = 2;
      constraints = { min: '0', minInclusive: false };
      local = sourceState(descriptor, product, unit);
      if (input.currencyEvidence?.verified !== true || input.currencyEvidence.currency !== 'UAH') {
        reason ||= 'PRICE_CURRENCY_UAH_NOT_PROVEN';
      }
    } else if ((descriptor?.kind === 'product' && descriptor.field === 'weight'
      || descriptor?.kind === 'information' && descriptor.category === 'SV' && descriptor.key === 'weight')
      && ['decor_weight', 'vaha_vyrobu'].includes(target) && scope === 'all') {
      persistence = 'weight'; kind = 'scalar'; type = 'decimal'; unit = 'g'; scale = 3;
      if (!isLegacySv(product) && (!product.characteristic_version_id || product.full_sku)) importBlocker = 'FIRST_SYNC_CANONICAL_NATIVE_VERSION_REQUIRED';
      constraints = { min: '0', minInclusive: false };
      const physical = own(product, 'weight'), answer = own(own(product, 'details'), 'answers');
      const answerWeight = answer && own(answer, 'weight');
      const a = present(physical) ? normalizeDecimal(physical, 3) : null;
      const b = present(answerWeight) ? normalizeDecimal(answerWeight, 3) : null;
      if (present(physical) && a === null || present(answerWeight) && b === null || a !== null && b !== null && a !== b) {
        reason ||= 'CANONICAL_WEIGHT_ANSWER_INCOHERENT';
      }
      local = state(present(physical) ? physical : answerWeight, unit);
      if (isLegacySv(product) && (present(physical) || present(answerWeight))) importBlocker = 'FIRST_SYNC_LEGACY_MISSING_ONLY_REVIEW_REQUIRED';
    } else if (descriptor?.kind === 'information' && descriptor.category === category
      && INFORMATION[category]?.includes(descriptor.key) && !descriptor.aliases.length) {
      persistence = 'information'; kind = 'scalar'; type = 'text';
      local = sourceState(descriptor, product);
      if (local.known && local.present) local.value = String(local.value);
      if (direct?.trimmed && remote.known && remote.present && (typeof remote.value !== 'string'
        || remote.value.trim() !== remote.value)) reason ||= 'CANONICAL_INFORMATION_VALUE_NORMALIZED';
    } else {
      if (direct) reason ||= 'CANONICAL_SOURCE_SETTER_UNSUPPORTED';
      prospective = forward(target, scope);
      if (expected?.strategy?.endsWith('_option') && prospective.verified && present(prospective.value)) {
        const matches = bindings.options.filter(option => option.bindingKey === expected.bindingKey
          && option.reviewState === 'approved' && option.evaluatedOutput === prospective.value);
        const optionIds = [...new Set(matches.map(option => option.optionId))];
        prospective = optionIds.length === 1 && optionIds[0] ? { verified: true, value: optionIds[0] }
          : { verified: false, reason: 'DERIVED_FORWARD_OPTION_NOT_UNIQUE' };
      }
    }
    if (kind === 'derived' && target === 'price' && scope === 'all') {
      // Native price has a proven base-currency contract. This only compares
      // the published forward output; it cannot reconstruct a canonical price.
      if (attr?.frontend_input !== 'price' || pinnedAttr?.frontend_input !== 'price') {
        reason ||= 'PRICE_NATIVE_DECIMAL_CONTRACT_NOT_PROVEN';
      } else if (input.currencyEvidence?.verified !== true || input.currencyEvidence.currency !== 'UAH') {
        reason ||= 'PRICE_CURRENCY_UAH_NOT_PROVEN';
      } else {
        type = 'decimal'; unit = 'UAH'; scale = 2; constraints = { min: '0', minInclusive: false };
      }
    }
    if (kind === 'derived' && target === 'price' && scope === 'all') {
      // The native price target carries the proven store base currency. Its
      // forward output can be compared exactly without recovering its inputs.
      if (attr?.frontend_input !== 'price' || pinnedAttr?.frontend_input !== 'price') {
        reason ||= 'PRICE_NATIVE_DECIMAL_CONTRACT_NOT_PROVEN';
      } else if (input.currencyEvidence?.verified !== true || input.currencyEvidence.currency !== 'UAH') {
        reason ||= 'PRICE_CURRENCY_UAH_NOT_PROVEN';
      } else {
        type = 'decimal'; unit = 'UAH'; scale = 2;
        constraints = { min: '0', minInclusive: false };
      }
    }
    // Derived store fields only compare a fresh forward result. They never
    // reverse or import an English canonical value; direct setters remain gated.
    if (scope === 'en' && !['name', 'derived'].includes(persistence)) reason ||= 'LOCALIZED_CANONICAL_SETTER_NOT_PROVEN';
    if (unit && remote.known) remote.unit = unit;
    const receipt = receipts.get(scope + '/' + target);
    if (!receipt && importBlocker && local.known && !local.present && remote.known && remote.present) reason ||= importBlocker;
    const outwardPresent = kind === 'derived' ? prospective?.verified && present(prospective.value)
      : local.known && local.present;
    if (!receipt && outwardPresent && remote.known && !remote.present
      && policy?.policy !== 'authoritative_create_update') reason ||= 'OUTWARD_POLICY_NOT_AUTHORITATIVE';
    if (reverseCandidates?.length > 256) { reason ||= 'REVERSE_DOMAIN_LIMIT_EXCEEDED'; reverseCandidates = []; }
    const field = { target, scope, kind, type, required: target === 'name' || target === 'price' || persistence === 'price'
      || persistence === 'weight' || Boolean(direct?.required) || attr?.is_required === true, mapping: { proven: !reason, ...(reason ? { reason } : {}) },
    local, remote, ...(unit ? { unit } : {}), ...(scale !== undefined ? { scale, constraints } : {}),
    ...(receipt ? { receipt } : {}), ...(reverseCandidates ? { reverseCandidates } : {}),
    ...(kind === 'derived' ? { prospective: prospective || { verified: false } } : {}) };
    fields.push(field);
    const source = { kind: descriptor?.kind || 'derived', ...(descriptor?.key ? { key: descriptor.key } : {}),
      ...(descriptor?.field ? { field: descriptor.field } : {}), bindingRevisionId: revision.id,
      definitionHash: compiled.hash, routeKey: route.routeKey };
    projection.push({ target, scope, persistence, source,
      mappingHash: hash({ definitionHash: compiled.hash, routeKey: route.routeKey, cell,
        binding: binding || null, policy: policy || null, attributeRequired: pinnedAttr?.is_required ?? null,
        options: bindings.options.filter(option => option.bindingKey === expected?.bindingKey) }),
      outwardPolicy: policy?.policy || null,
      storagePath: persistence === 'information' || persistence === 'characteristic'
        ? 'details.answers.' + descriptor?.key : persistence === 'weight' ? 'weight'
          : persistence === 'price' ? 'total_price_uah' : descriptor?.field || null,
      requiresRuntimeValidation: ['information', 'weight', 'price', 'characteristic', 'name'].includes(persistence),
      ...(persistence === 'weight' ? { mirrorAnswerKey: 'weight', setterContract: 'canonical-g-scale3-and-answer-coherence' } : {}),
      ...(persistence === 'price' ? { setterContract: 'manual-UAH-scale2-preserve-server-pricing-baseline' } : {}),
      ...(importBlocker ? { importBlocker } : {}), ...(enReason && scope === 'en' ? { readReason: enReason } : {}),
      ...(reason ? { reason } : {}) });
    coverage.push({ target, scope, state: 'projected', persistence });
    if (reason) blockers.push({ code: reason, target, scope });
    if (scope === 'en' && enReason) blockers.push({ code: enReason, target, scope });
  }
  if (!fields.length) return emptyResult('review_required', [{ code: 'MAPPED_BUSINESS_FIELDS_REQUIRED' }], coverage);
  const plan = planFirstSyncFields({ fields });
  // Names, weights and prices stay independent of unrelated local evaluator errors.
  return { mode: 'plan_only', route: { routeKey: route.routeKey, category, remoteAttributeSetId: route.setId },
    fields, projection, coverage: { fields: coverage, fullProductAdoption: false,
      photos: 'unsupported_without_url_import' }, blockers, plan,
    readyForOutbound: blockers.length === 0 && plan.readyForOutbound, complete: plan.complete };
}
module.exports = { projectFirstSyncFields };
