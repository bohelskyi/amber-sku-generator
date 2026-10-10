// SELECT-only assessment of permanent optional_empty receipts. The caller owns
// its transaction and any delivery gate; this module never repairs a receipt.
const { compileDefinition } = require('../export-templates/definition');
const { hash, normalizeSchema } = require('./binding-contract');
const { requirements, normalizeBindings } = require('./binding-validation');
const repository = require('./binding-repository');

const CODE = 'FIRST_SYNC_OPTIONAL_EMPTY_RECEIPT_REVIEW_REQUIRED';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const TARGET = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const own = (value, key) => Object.hasOwn(value || {}, key);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const invalid = reason => { throw Object.assign(new Error(reason), { auditReason: reason }); };
const empty = value => value === null || typeof value === 'string' && value.trim() === '';
function emptyObservation(value) {
  return plain(value) && value.known === true && value.present === false
    && (!own(value, 'value') || empty(value.value));
}
function provenance(field, session, parent = false) {
  if (!plain(field) || !TARGET.test(field.target) || !['all', 'en'].includes(field.scope)
    || !plain(field.source) || !UUID.test(field.source.bindingRevisionId || '')
    || !['semantic', 'information', 'product', 'derived', 'name'].includes(field.source.kind)
    || own(field.source, 'key') === own(field.source, 'field')
    || typeof (field.source.key ?? field.source.field) !== 'string' || !LABEL.test(field.source.key ?? field.source.field)
    || !HEX.test(field.source.definitionHash || '') || typeof field.source.routeKey !== 'string'
    || !field.source.routeKey || field.source.routeKey.length > 500
    || !HEX.test(field.source.manifestHash || '') || own(field.source, 'decision')
      && (!parent || !['keep_local', 'accept_remote'].includes(field.source.decision))
    || !Number.isSafeInteger(field.source.productId) || field.source.productId < 1 || field.source.productId > 2147483647
    || !HEX.test(field.mappingHash || '') || !plain(session)
    || !HEX.test(session.origin_hash || '') || typeof session.installation_key !== 'string'
    || !/^[1-9][0-9]{0,18}$/.test(String(session.public_product_identity_id || ''))) {
    invalid('ORIGINAL_RECEIPT_PROVENANCE_UNPROVEN');
  }
  if (!parent && (!emptyObservation(field.before) || !emptyObservation(field.remote) || !empty(field.after))) {
    invalid('ORIGINAL_EMPTY_OBSERVATION_UNPROVEN');
  }
}
async function publication(client, id) {
  const loaded = await repository.load(client, id);
  if (!loaded || loaded.row.state !== 'published') invalid('ORIGINAL_PUBLISHED_BINDING_UNAVAILABLE');
  const { row } = loaded;
  const version = (await client.query('SELECT * FROM export_template_versions WHERE id=$1', [row.template_version_id])).rows[0];
  if (!version) invalid('ORIGINAL_PUBLISHED_TEMPLATE_UNAVAILABLE');
  let compiled, schema, bindings, plans;
  try {
    compiled = compileDefinition(version.definition);
    schema = normalizeSchema(loaded.schema);
    bindings = normalizeBindings(loaded.bindings);
    plans = requirements(compiled.definition, schema);
  } catch { invalid('ORIGINAL_PUBLICATION_INVALID'); }
  if (version.id !== row.template_version_id || version.template_id !== row.template_id
    || compiled.hash !== version.definition_hash || compiled.hash !== row.template_definition_hash
    || version.evaluator_version !== compiled.definition.evaluatorVersion || row.evaluator_version !== version.evaluator_version
    || version.output_contract !== compiled.definition.outputContract || row.output_contract !== version.output_contract
    || version.format_version !== compiled.definition.formatVersion || row.format_version !== version.format_version
    || hash(schema) !== row.schema_fingerprint || hash(schema.storeTopology) !== row.topology_fingerprint
    || schema.storeCode !== 'all') invalid('ORIGINAL_PUBLICATION_IDENTITY_MISMATCH');
  return { row, compiled, schema, bindings, plans };
}
function originalMapping(field, session, saved) {
  const { row, compiled, schema, bindings, plans } = saved, source = field.source;
  if (row.id !== source.bindingRevisionId || row.origin_hash !== session.origin_hash
    || row.installation_key !== session.installation_key || compiled.hash !== source.definitionHash) {
    invalid('ORIGINAL_RECEIPT_PUBLICATION_MISMATCH');
  }
  const routes = plans.filter(plan => plan.routeKey === source.routeKey);
  const decisions = bindings.routes.filter(route => route.routeKey === source.routeKey
    && route.enabled && route.reviewState === 'approved');
  if (routes.length !== 1 || decisions.length !== 1) invalid('ORIGINAL_ROUTE_UNPROVEN');
  const route = routes[0], rowId = field.scope === 'en' ? 'english' : 'base';
  const group = compiled.definition.groups.find(candidate => candidate.route === route.amberGroup);
  const expression = group?.rows.find(candidate => candidate.id === rowId)?.cells[field.target];
  const attribute = schema.attributes.find(candidate => candidate.attribute_code === field.target);
  if (!expression || !attribute) invalid('ORIGINAL_FIELD_UNPROVEN');
  const expected = route.attributes.find(candidate => candidate.rowId === rowId && candidate.target === field.target);
  const binding = bindings.attributes.find(candidate => candidate.bindingKey === expected?.bindingKey);
  const policy = bindings.policies.find(candidate => candidate.bindingKey === expected?.bindingKey
    && candidate.storeCode === field.scope);
  const mappingHash = hash({ definitionHash: compiled.hash, routeKey: source.routeKey, cell: expression,
    binding: binding || null, policy: policy || null, attributeRequired: attribute.is_required ?? null,
    options: bindings.options.filter(candidate => candidate.bindingKey === expected?.bindingKey) });
  if (mappingHash !== field.mappingHash) invalid('ORIGINAL_MAPPING_FINGERPRINT_MISMATCH');
  return { expression, attribute };
}
function originalField(field, session, saved, source = field.source) {
  const { attribute } = originalMapping(field, session, saved);
  const { compiled } = saved;
  const physicalWeight = ['decor_weight', 'vaha_vyrobu'].includes(field.target)
    && (source.kind === 'product' && source.field === 'weight' || source.kind === 'information' && source.key === 'weight');
  if (attribute.is_required === true || ['name', 'price'].includes(field.target) || physicalWeight) {
    return { state: 'required', reason: 'ORIGINAL_REQUIRED_FIELD_EMPTY', questionIds: [] };
  }
  return require('./first-sync-semantic-requirement').classifySemanticRequirement({
    compiled, target: field.target, scope: field.scope, source,
  });
}
async function assessOnClient(client, progress) {
  const blockers = [], evidence = [];
  if (!progress) return { blockers, evidence, evidenceHash: hash(evidence) };
  if (!Array.isArray(progress.fields) || progress.fields.length > 500) {
    const issue = { state: 'unproven', reason: 'ORIGINAL_RECEIPT_SET_UNPROVEN' };
    evidence.push(issue); blockers.push({ code: CODE, reason: issue.reason });
    return { blockers, evidence, evidenceHash: hash(evidence) };
  }
  const publications = new Map(), products = new Map(), seen = new Set(), revisions = new Map();
  for (const field of progress.fields.filter(candidate => candidate?.state === 'optional_empty')) {
    let assessment;
    try {
      provenance(field, progress.session);
      const key = field.scope + '/' + field.target;
      if (seen.has(key)) invalid('ORIGINAL_RECEIPT_DUPLICATE');
      seen.add(key);
      const productId = field.source.productId;
      if (!products.has(productId)) products.set(productId, client.query(
        'SELECT public_product_identity_id FROM products WHERE id=$1', [productId]));
      const product = (await products.get(productId)).rows[0];
      if (!product || String(product.public_product_identity_id) !== String(progress.session.public_product_identity_id)) {
        invalid('ORIGINAL_RECEIPT_PRODUCT_IDENTITY_MISMATCH');
      }
      const id = field.source.bindingRevisionId;
      if (!publications.has(id) && publications.size >= 32) invalid('ORIGINAL_PUBLICATION_AUDIT_LIMIT');
      if (!publications.has(id)) publications.set(id, publication(client, id));
      const saved = await publications.get(id);
      assessment = originalField(field, progress.session, saved);
      if (assessment.state === 'unproven' && assessment.reason === 'SEMANTIC_REQUIREMENT_UNPROVEN'
        && !own(field.source, 'requirednessEvidence')) {
        const proof = await require('./first-sync-original-evidence').readOriginalEvidence(client,
          field, progress.session, saved.compiled, revisions, parent => {
            provenance(parent, progress.session, true);
            return originalMapping(parent, progress.session, saved).expression;
          });
        assessment = originalField(field, progress.session, saved, { ...field.source, requirednessEvidence: proof });
      }
      if (!assessment || !['required', 'optional', 'inactive', 'unproven'].includes(assessment.state)) {
        invalid('ORIGINAL_REQUIREDNESS_UNPROVEN');
      }
    } catch (cause) {
      assessment = { state: 'unproven', reason: cause.auditReason || 'ORIGINAL_PUBLICATION_READ_UNPROVEN', questionIds: [] };
    }
    const item = { target: field.target, scope: field.scope, state: assessment.state, reason: assessment.reason,
      questionIds: assessment.questionIds || [],
      bindingRevisionId: field.source?.bindingRevisionId || null,
      definitionHash: field.source?.definitionHash || null, routeKey: field.source?.routeKey || null,
      receiptHash: hash(Object.fromEntries(['target', 'scope', 'state', 'before', 'remote', 'after', 'source', 'mappingHash']
        .map(key => [key, field[key]]))) };
    evidence.push(item);
    if (!['optional', 'inactive'].includes(assessment.state)) blockers.push({
      code: CODE, target: field.target, scope: field.scope, reason: assessment.reason,
      bindingRevisionId: item.bindingRevisionId, definitionHash: item.definitionHash, routeKey: item.routeKey,
    });
  }
  return { blockers, evidence, evidenceHash: hash(evidence) };
}
module.exports = { assessOnClient, CODE };
