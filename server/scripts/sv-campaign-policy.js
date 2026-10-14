'use strict';

// A narrower operation policy over the unchanged canonical planner. This module
// neither reads data nor grants lineage, admission, locking or dispatch authority.
const path = require('node:path');
const { createRequire } = require('node:module');
const POLICY = 'sv-manager-v1';
function createPolicy(serverRoot) {
const local = createRequire(path.join(path.resolve(serverRoot), 'package.json'));
const c = local('./src/services/magento/binding-contract');
const { normalizeDecimal } = local('./src/services/magento/first-sync-field-plan');
const { projectFirstSyncFields } = local('./src/services/magento/first-sync-projection');
const { roundedWeight } = local('./src/services/magento/first-sync-batch-preflight');
const { intent: canonicalIntent } = local('./src/services/magento/sync-job-plan');
const svDimensions = local('./src/services/magento/sv-dimensions');
const SEO = new Set(['meta_title', 'meta_description']);
const NATIVE_CONTROLS = new Set(['status', 'visibility']);
const RECORD = ['target', 'scope', 'state', 'before', 'remote', 'after', 'source', 'mappingHash'];
const key = row => row.scope + '/' + row.target;
const same = (a, b) => a !== undefined && b !== undefined && c.hash(a) === c.hash(b);
const fail = code => { throw c.error(409, 'SV_CAMPAIGN_POLICY_' + code, 'SV campaign requires a new exact review.'); };
const dense = (rows, maximum = 1000) => Array.isArray(rows) && rows.length <= maximum
  && Object.keys(rows).length === rows.length && Array.from({ length: rows.length }, (_, index) => Object.hasOwn(rows, index)).every(Boolean);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const decimal = (value, scale) => normalizeDecimal(value, scale);
const positive = (value, scale) => { const result = decimal(value, scale); return result !== null && result !== '0' && !result.startsWith('-'); };
const equivalentDecimal = (a, b, scale) => decimal(a, scale) !== null && decimal(a, scale) === decimal(b, scale);
const allowed = row => row?.scope === 'all' && ['price', 'decor_weight'].includes(row.target);
const record = row => Object.fromEntries(RECORD.map(name => [name, row[name]]));

function unique(rows, name) {
  if (!dense(rows) || rows.some(row => !row || typeof row[name] !== 'string')
    || new Set(rows.map(row => row[name])).size !== rows.length) fail('EVIDENCE_INVALID');
  return new Map(rows.map(row => [row[name], row]));
}
function fieldMap(rows) {
  if (!dense(rows, 500) || rows.some(row => !row || typeof row.target !== 'string' || typeof row.scope !== 'string')
    || new Set(rows.map(key)).size !== rows.length) fail('PREPARED_INVALID');
  return new Map(rows.map(row => [key(row), row]));
}
function equivalent(a, b, attribute) {
  if (a === undefined || b === undefined) return false;
  if (same(a, b)) return true;
  if (['select', 'multiselect', 'boolean'].includes(attribute?.frontend_input)) return String(a) === String(b);
  if (['string', 'number'].includes(typeof a) && ['string', 'number'].includes(typeof b)) {
    return String(a) === String(b) || equivalentDecimal(a, b, 18);
  }
  return false;
}
function assertIdentity(config, observation, report) {
  const { amber, raw } = observation || {}, product = amber?.product, revision = amber?.revision;
  if (!product || !raw || !positiveId(product.id) || !positiveId(raw.id) || product.category !== 'SV'
    || product.is_test_product !== false || product.status !== 'active' || product.corrected_from_product_id != null
    || product.corrected_to_product_id != null || Number(product.exclude_from_export) !== 0
    || product.exportState?.route !== 'normal' || product.exportState.business_exclusion_state !== 'none'
    || product.exportState.recount_compatibility_excluded !== false || product.exportState.independentExclusion === true)
    fail('IDENTITY_OR_LIFECYCLE');
  if (typeof product.public_sku !== 'string' || !product.public_sku || raw.sku !== product.public_sku
    || report?.mode !== 'update' || report.identity?.state !== 'found'
    || report.identity.article !== product.public_sku || report.identity.observedMagentoId !== raw.id
    || report.amberProduct?.id !== product.id || report.amberProduct.publicSku !== product.public_sku
    || revision?.state !== 'published' || revision.originHash !== c.originHash(config.baseUrl)
    || revision.definitionHash !== amber.compiled?.hash || report.bindingRevision?.id !== revision.id
    || report.bindingRevision.state !== 'published') fail('IDENTITY_OR_PUBLICATION');
  if (!dense(observation.categoryFailures || [], 100) || observation.categoryFailures?.length
    || !dense(observation.domainEvidence?.failures, 100) || observation.domainEvidence.failures.length)
    fail('REMOTE_READ_INCOMPLETE');
  return product;
}
function sources(observation, currencyEvidence, report) {
  const product = observation.amber.product;
  if (!positive(product.total_price_uah, 2)) fail('MANAGER_PRICE_REQUIRED');
  if (!positive(product.weight, 3) || !positive(product.details?.answers?.weight, 3)
    || !equivalentDecimal(product.weight, product.details.answers.weight, 3)) fail('PHYSICAL_WEIGHT_INCOHERENT');
  let projected;
  try { projected = projectFirstSyncFields({ observation: { amber: observation.amber, raw: observation.raw,
    schema: observation.schema, domainEvidence: observation.domainEvidence }, ...(currencyEvidence ? { currencyEvidence } : {}) }); }
  catch { fail('SOURCE_PROVENANCE'); }
  const fields = fieldMap(projected.fields || []), metadata = fieldMap(projected.projection || []);
  const price = metadata.get('all/price'), weight = metadata.get('all/decor_weight');
  if (price?.persistence !== 'price' || price.source?.kind !== 'product' || price.source.field !== 'total_price_uah'
    || price.source.definitionHash !== observation.amber.compiled.hash
    || price.reason && price.reason !== 'PRICE_CURRENCY_UAH_NOT_PROVEN') fail('PRICE_SOURCE_PROVENANCE');
  if (weight?.persistence !== 'weight' || weight.storagePath !== 'weight' || weight.mirrorAnswerKey !== 'weight'
    || weight.setterContract !== 'canonical-g-scale3-and-answer-coherence' || weight.reason
    || !fields.get('all/decor_weight')?.mapping?.proven
    || !['product', 'information'].includes(weight.source?.kind)
    || (weight.source.kind === 'product' ? weight.source.field !== 'weight' : weight.source.key !== 'weight')
    || weight.source.definitionHash !== observation.amber.compiled.hash) fail('WEIGHT_SOURCE_PROVENANCE');
  return { product, fields, metadata, currencyEvidence, report };
}
function approvedFill(name, value, source, english) {
  if (english) return source.report.transport.storeViews.diff.some(row => row.target === name
    && row.authority === 'authoritative' && row.action === 'would_add' && same(row.candidate, value));
  return source.report.attributes.some(row => row.magentoAttributeCode === name && row.authority === 'authoritative'
    && row.persistedDecision?.reviewState === 'approved' && row.wouldChange === true && !row.diagnostics?.length)
    && source.report.diff.some(row => row.includedInPayload === true && row.action === 'would_add'
      && same(row.candidate, value) && source.report.attributes.some(attribute => attribute.target === row.target
        && attribute.magentoAttributeCode === name));
}
function permittedChange(target, candidate, current, source) {
  if (target === 'price') {
    if (!equivalentDecimal(candidate, source.product.total_price_uah, 2)) fail('PRICE_NOT_SAVED_MANAGER_VALUE');
    if (!equivalentDecimal(candidate, current, 2)
      && (source.currencyEvidence?.verified !== true || source.currencyEvidence.currency !== 'UAH')) fail('PRICE_CURRENCY_UNPROVEN');
    return true;
  }
  if (target === 'decor_weight') {
    if (!equivalentDecimal(candidate, source.product.weight, 3)) fail('WEIGHT_NOT_PHYSICAL_VALUE');
    if (!equivalentDecimal(candidate, current, 3) && !roundedWeight(source.product.weight, current)) fail('WEIGHT_NOT_ROUNDING_ONLY');
    return true;
  }
  return false;
}
function assertPayload(payload, observation, source, { english = false, initialNames = false } = {}) {
  if (!payload || Object.keys(payload).some(name => name !== 'product') || !payload.product
    || typeof payload.product !== 'object' || Array.isArray(payload.product)) fail('PAYLOAD_INVALID');
  const product = payload.product, raw = english ? observation.domainEvidence?.english : observation.raw;
  if (!raw || raw.id !== observation.raw.id || raw.sku !== observation.raw.sku || product.sku !== raw.sku) fail('PAYLOAD_IDENTITY');
  const attributes = unique(observation.schema.attributes, 'attribute_code');
  const values = english ? raw.fields : Object.fromEntries([...unique(raw.custom_attributes || [], 'attribute_code')].map(([name, row]) => [name, row.value]));
  for (const [name, value] of Object.entries(product)) {
    if (name === 'sku' || name === 'custom_attributes') continue;
    if (SEO.has(name)) fail('SEO_PAYLOAD_DENIED');
    if (name === 'extension_attributes') {
      if (english || !value || Object.keys(value).some(field => field !== 'category_links')) fail('DOMAIN_CHANGE');
      if (!dense(value.category_links)) fail('DOMAIN_EVIDENCE_INVALID');
      continue;
    }
    const before = english ? raw.fields?.[name] : raw[name];
    if (name === 'name') {
      if (typeof value !== 'string' || (!initialNames && value !== before)) fail('NAME_CHANGE');
    } else if (!english && name === 'price') permittedChange(name, value, before, source);
    else if (!english && NATIVE_CONTROLS.has(name)) continue;
    else if (!equivalent(value, before, attributes.get(name))) fail('OTHER_FIELD_CHANGE');
  }
  if (product.custom_attributes !== undefined) {
    for (const [name, row] of unique(product.custom_attributes, 'attribute_code')) {
      if (SEO.has(name)) fail('SEO_PAYLOAD_DENIED');
      if (!Object.hasOwn(row, 'value') || Object.keys(row).some(field => !['attribute_code', 'value'].includes(field))) fail('PAYLOAD_INVALID');
      if (!english && name === 'decor_weight') permittedChange(name, row.value, values[name], source);
      else if (!(!english && name === 'rozmir_suveniriv'
        && source.fields.get('all/rozmir_suveniriv')?.comparison === svDimensions.COMPARISON
        && source.fields.get('all/rozmir_suveniriv').mapping.proven
        && svDimensions.equivalent(row.value, values[name]))
        && !equivalent(row.value, values[name], attributes.get(name))
        && !((values[name] === undefined || values[name] === null || values[name] === '')
          && approvedFill(name, row.value, source, english))) fail('OTHER_FIELD_CHANGE');
    }
  }
}
function assertObservation(config, data) {
  const { observation, report, currencyEvidence, stage = 'fields' } = data || {};
  const product = assertIdentity(config, observation, report);
  if (!['history', 'names', 'fields', 'equal', 'enqueue'].includes(stage)) fail('STAGE_INVALID');
  const initialNames = ['history', 'names'].includes(stage);
  if (report.evaluation?.ready !== true || report.syncEligibility?.eligible !== true || !dense(report.blockers, 500)
    || report.blockers.some(row => !initialNames || row.code !== 'NAME_BASELINE_REQUIRED')) fail('CANONICAL_BLOCKER');
  if (!initialNames && report.sendable !== true) fail('CANONICAL_BLOCKER');
  const source = sources(observation, currencyEvidence, report);
  assertPayload(report.sendability?.operations?.coreProduct?.candidatePayload, observation, source, { initialNames });
  const categories = report.categories, transport = report.transport;
  // Published canonical transport/domain decisions remain ordinary full-product
  // sync. This policy limits local field decisions, not those existing domains.
  if (!categories || categories.currentKnown !== true || !dense(categories.wouldAdd)
    || !dense(categories.wouldRemoveIfAuthoritative) || !transport?.inventory
    || !dense(transport?.websites?.operations)) fail('DOMAIN_EVIDENCE_INVALID');
  if (transport?.storeViews?.candidatePayload) assertPayload(transport.storeViews.candidatePayload, observation, source, { english: true, initialNames });
  return { policyVersion: POLICY, productId: product.id, sku: product.public_sku, remoteProductId: observation.raw.id };
}
function selectChoices(base) {
  if (base?.mode !== 'first' || base.first?.mode !== 'first' || !base.prepared || !base.projection) fail('FIRST_INSPECTION_REQUIRED');
  const prior = fieldMap(base.first.progress?.fields || []), choices = [];
  for (const row of fieldMap(base.prepared.rows).values()) {
    if (!row.record) fail('PREPARED_INVALID');
    const saved = prior.get(key(row));
    // A names commit persists unresolved evidence alongside its name receipts.
    // Only received or pending outward records settle an unchanged prior row.
    if (saved && same(record(saved), record(row.record)) && (row.received === true
      || row.status === 'pending_outward_confirmation' && row.record.state === 'pending_outward_confirmation')) continue;
    if (automaticFill(base, row)) continue;
    if (['equal', 'optional_empty', 'outward_verified'].includes(row.record.state)) continue;
    if (row.record.state === 'name_received') fail('INITIAL_NAMES_REQUIRED');
    if (!allowed(row) || row.canKeepLocal !== true || !['conflict', 'review_required'].includes(row.status)) fail('OTHER_FIELD_CONFLICT');
    if (row.target === 'decor_weight' && !roundedWeight(row.local?.value, row.remote?.value)) fail('WEIGHT_NOT_ROUNDING_ONLY');
    choices.push({ target: row.target, scope: row.scope, choice: 'keep_local' });
  }
  return choices;
}
function automaticFill(base, row) {
  if (row.status !== 'pending_outward_confirmation' || row.record?.state !== 'pending_outward_confirmation'
    || !positiveId(base.observation?.amber?.product?.id)) return false;
  const id = key(row), field = fieldMap(base.projection.fields).get(id), meta = fieldMap(base.projection.projection).get(id);
  const result = fieldMap(base.projection.plan.fields).get(id), value = row.record;
  if (!field || !meta || !result || row.target === 'name' || SEO.has(row.target)
    || row.status !== 'pending_outward_confirmation' || value.state !== 'pending_outward_confirmation'
    || value.source?.decision || result.status !== 'pending_outward_confirmation' || result.reason !== 'REMOTE_EMPTY_LOCAL_POPULATED'
    || meta.reason || meta.readReason || meta.outwardPolicy !== 'authoritative_create_update' || field.mapping?.proven !== true
    || field.local?.known !== true || field.local.present !== true || field.remote?.known !== true || field.remote.present !== false
    || !same(row.local, field.local) || !same(row.remote, field.remote)
    || !same(value.before, field.local) || !same(value.remote, field.remote)
    || !same(value.after, field.local.value ?? null) || value.mappingHash !== meta.mappingHash) return false;
  return same(value.source, { ...meta.source, ...(!meta.source.key && !meta.source.field ? { field: field.target } : {}),
    manifestHash: base.prepared.manifestHash, productId: base.observation.amber.product.id });
}
function assertPrepared(prepared, { stage = 'fields', choices = [], base } = {}) {
  if (!['fields', 'names', 'equal'].includes(stage) || !base?.prepared || !base?.projection
    || !dense(choices, 2) || choices.some(choice => !allowed(choice) || choice.choice !== 'keep_local')
    || new Set(choices.map(key)).size !== choices.length || stage !== 'fields' && choices.length) fail('PREPARED_INVALID');
  const rows = fieldMap(prepared?.rows), manifest = fieldMap(prepared?.manifest), original = fieldMap(base.prepared.rows);
  const prior = fieldMap(base.first?.progress?.fields || []), selected = new Map(choices.map(choice => [key(choice), choice]));
  if (!rows.size || rows.size !== manifest.size || rows.size !== original.size
    || [...rows.keys()].some(id => !manifest.has(id) || !original.has(id))
    || prepared.manifestHash !== base.prepared.manifestHash || !dense(prepared.blockers, 2000)
    || stage !== 'names' && (prepared.blockers.length || prepared.readyForOutbound !== true)) fail('PREPARED_INCOMPLETE');
  for (const [id, row] of rows) {
    const previous = prior.get(id), before = original.get(id), value = row.record;
    if (!value || key(value) !== id || !same(row.local, before.local) || !same(row.remote, before.remote)) fail('PREPARED_CHANGED');
    if (previous && same(record(previous), record(value))) continue;
    if (selected.has(id)) {
      if (row.received || value.state !== 'pending_outward_confirmation' || value.source?.decision !== 'keep_local'
        || !same(value.before, before.record.before) || !same(value.remote, before.record.remote)
        || !same(value.after, before.record.after) || value.mappingHash !== before.record.mappingHash
        || !same(value.source, { ...before.record.source, decision: 'keep_local' })) fail('CHOICE_CHANGED');
    } else {
      if (!same(record(value), record(before.record))) fail('PREPARED_CHANGED');
      if (stage === 'names' && row.target === 'name' && ['all', 'en'].includes(row.scope) && value.state === 'name_received') continue;
      // The names validator owns imports. Unchanged unresolved evidence is kept
      // for the subsequent explicit field stage; it grants no new decision.
      if (stage === 'names' && ['conflict', 'review_required', 'unknown', 'pending_outward_confirmation'].includes(value.state)
        && !value.source?.decision) continue;
      if (automaticFill(base, row)) continue;
      if (!['equal', 'optional_empty', 'outward_verified'].includes(value.state)) fail('UNAPPROVED_IMPORT_OR_DECISION');
      if (value.state === 'outward_verified' && previous?.state !== 'pending_outward_confirmation') fail('RECEIPT_UNPROVEN');
      if (value.state === 'optional_empty' && (row.local?.known !== true || row.local.present !== false
        || row.remote?.known !== true || row.remote.present !== false)) fail('RECEIPT_UNPROVEN');
    }
  }
  return true;
}
function assertIntent(config, data) {
  const { observation, report, intent, baseline, currencyEvidence } = data || {};
  assertObservation(config, { observation, report, currencyEvidence, stage: 'enqueue' });
  if (!intent || intent.mode !== 'update' || !same(intent, canonicalIntent(report, intent.version))) fail('INTENT_CHANGED');
  if (!baseline?.raw || baseline.raw.id !== observation.raw.id || baseline.raw.sku !== observation.raw.sku) fail('BASELINE_IDENTITY');
  const source = sources(observation, currencyEvidence, report);
  if (!dense(intent.operations, 20) || !intent.operations.length || intent.operations[0]?.domain !== 'coreProduct') fail('INTENT_INVALID');
  for (const operation of intent.operations) {
    if (operation.domain === 'coreProduct') assertPayload(operation.payload, observation, source);
    else if (operation.domain === 'storeViews') assertPayload(operation.payload, observation, source, { english: true });
    else if (!['categories', 'categoryLinkDelete', 'categoryLinkSave', 'inventory', 'websites'].includes(operation.domain)) fail('DOMAIN_CHANGE');
  }
  return true;
}
function assertOutbound(config, data) { return assertObservation(config, { ...data, stage: 'enqueue' }); }
return { POLICY, assertObservation, selectChoices, assertPrepared, assertIntent, assertOutbound };
}
module.exports = { POLICY, createPolicy };
