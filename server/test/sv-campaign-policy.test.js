const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const policy = require('../scripts/sv-campaign-policy').createPolicy(path.resolve(__dirname, '..'));
const fixtures = require('./fixtures/magento-bindings');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { normalizeSchema, hash, originHash } = require('../src/services/magento/binding-contract');
const { bindingKey, normalizeBindings } = require('../src/services/magento/binding-validation');
const { planPreview } = require('../src/services/magento/sync-preview');
const { indexTrees } = require('../src/services/magento/sync-preview-categories');
const { projectFirstSyncFields } = require('../src/services/magento/first-sync-projection');
const { prepareProgress } = require('../src/services/magento/first-sync-progress-plan');
const jobPlan = require('../src/services/magento/sync-job-plan');
const config = { baseUrl: 'https://sv-policy.example.invalid' };
const literal = value => ({ op: 'literal', value });
const text = id => ({ op: 'text', input: { op: 'source', id }, trim: false, format: 'scalar-v1', onAbsent: 'empty' });
const currencyEvidence = { verified: true, currency: 'UAH' };

// Compile and plan with the real canonical services; no handwritten report,
// projection, prepared-row or intent fixtures stand in for their contracts.
function fixture({ sku = 'SV-fixture', price = '42.00', remotePrice = 40, weight = '5.400', remoteWeight = '5', size, remoteSize, changeDefinition } = {}) {
  const definition = structuredClone(fixtures.definition());
  definition.sources.price = { kind: 'product', field: 'total_price_uah', type: 'scalar' };
  definition.sources.svWeight = { kind: 'information', category: 'SV', key: 'weight', type: 'scalar',
    provenance: 'supplied-stored-answers-v1', aliases: [] };
  const sv = definition.groups.find(group => group.route === 'SV');
  sv.rows[0].cells.price = text('price');
  sv.rows[0].cells.decor_weight = text('svWeight');
  sv.rows[1].cells.price = literal('');
  if (size !== undefined) {
    definition.sources.svSize = { kind: 'information', category: 'SV', key: 'size', type: 'scalar',
      provenance: 'supplied-stored-answers-v1', aliases: [] };
    sv.rows[0].cells.rozmir_suveniriv = text('svSize');
  }
  changeDefinition?.(definition, sv);
  const compiled = compileDefinition(definition), rawSchema = structuredClone(fixtures.schema());
  rawSchema.attributes.find(row => row.attribute_code === 'name').scope = 'store';
  Object.assign(rawSchema.attributes.find(row => row.attribute_code === 'decor_weight'), { frontend_input: 'text', options: [] });
  rawSchema.attributes.push({ attribute_id: 999, attribute_code: 'rozmir_suveniriv', frontend_input: 'text', options: [] });
  rawSchema.attributeSets[0].attributeCodes.push('rozmir_suveniriv');
  const schema = normalizeSchema(rawSchema), binding = fixtures.approvedBindings(compiled.definition, schema, 'SV');
  for (const row of binding.attributes) if (row.strategy === 'transport_control') {
    row.transportTarget = 'product.' + ({ attribute_set_code: 'attribute_set_id', product_type: 'type_id' }[row.target] || row.target);
  }
  for (const row of binding.policies) {
    const attribute = binding.attributes.find(candidate => bindingKey(candidate.routeKey, candidate.rowId, candidate.target) === row.bindingKey);
    row.policy = row.storeCode === 'en' && ['sku', 'attribute_set_code', 'product_type', 'store_view_code'].includes(attribute?.target)
      || attribute?.strategy === 'transport_control' ? 'magento_managed' : 'authoritative_create_update';
  }
  const revision = { id: '11111111-1111-1111-1111-111111111111', state: 'published', revision: '1', installationKey: 'amber',
    templateVersionId: '22222222-2222-2222-2222-222222222222', definitionHash: compiled.hash,
    evaluatorVersion: compiled.definition.evaluatorVersion, outputContract: compiled.definition.outputContract,
    formatVersion: compiled.definition.formatVersion, originHash: originHash(config.baseUrl),
    schema, schemaFingerprint: hash(schema), topologyFingerprint: hash(schema.storeTopology), bindings: normalizeBindings(binding) };
  const product = { id: 7, public_product_identity_id: '17', category: 'SV', full_sku: sku, public_sku: sku,
    status: 'active', is_test_product: false, exclude_from_export: 0, weight, total_price_uah: price,
    exportState: { route: 'normal', business_exclusion_state: 'none', recount_compatibility_excluded: false },
    details: { answers: { souvenir: 5, weight, ...(size === undefined ? {} : { size }) } } };
  const raw = { id: 81, sku, attribute_set_id: 8001, name: 'Fixture name', price: remotePrice,
    type_id: 'simple', status: 1, visibility: 4, extension_attributes: { category_links: [], website_ids: [801] },
    custom_attributes: [{ attribute_code: 'decor_weight', value: remoteWeight }] };
  if (remoteSize !== undefined) raw.custom_attributes.push({ attribute_code: 'rozmir_suveniriv', value: remoteSize });
  const observation = { amber: { product, compiled, revision,
    template: { kind: 'published', versionId: revision.templateVersionId, definitionHash: compiled.hash } },
  raw, schema, domainEvidence: { failures: [], english: { id: raw.id, sku, fields: { name: 'Fixture name' } } }, categoryFailures: [] };
  return { observation, currencyEvidence, report: planPreview(observation.amber, schema, raw, indexTrees([]), { domainEvidence: observation.domainEvidence }) };
}
const fails = (fn, suffix) => assert.throws(fn, { code: 'SV_CAMPAIGN_POLICY_' + suffix });
function inspectedProgress(projection, progress, choices, productId) {
  const prepared = prepareProgress(projection, progress, choices);
  // first-sync.service.inspect/prepareDecision stamp these server-owned records
  // before local validation; include the real service provenance contract.
  for (const row of prepared.rows.filter(field => !field.received)) row.record.source.productId = productId;
  return prepared;
}
function baseFor(f, progress = null) {
  const projection = projectFirstSyncFields({ observation: { amber: f.observation.amber, raw: f.observation.raw,
    schema: f.observation.schema, domainEvidence: f.observation.domainEvidence }, currencyEvidence,
  receipts: (progress?.fields || []).filter(row => ['name_received', 'equal', 'optional_empty', 'outward_verified', 'imported'].includes(row.state))
    .map(({ target, scope, state }) => ({ target, scope, state })) });
  const prepared = inspectedProgress(projection, progress, null, f.observation.amber.product.id);
  return { mode: 'first', first: { mode: 'first', progress }, observation: f.observation, projection, prepared };
}
function namedBase(f) {
  const initial = baseFor(f);
  const fields = initial.prepared.rows.filter(row => row.target === 'name').map(row => row.record);
  return baseFor(f, { fields });
}

test('real canonical SV and AG observations allow saved Manager price and coherent physical rounding without mutation', () => {
  for (const sku of ['SV-fixture', 'AG-000123']) {
    const f = fixture({ sku }), before = JSON.stringify(f);
    assert.equal(f.report.sendable, true, JSON.stringify(f.report.blockers));
    assert.equal(policy.assertObservation(config, f).policyVersion, 'sv-manager-v1');
    const intent = jobPlan.intent(f.report), baseline = jobPlan.baseline(f.observation, f.report);
    assert.equal(policy.assertIntent(config, { ...f, intent, baseline }), true);
    assert.equal(JSON.stringify(f), before);
  }
});
test('equal price requires no fabricated currency evidence; changed price requires verified UAH', () => {
  const equal = fixture({ remotePrice: 42 }); delete equal.currencyEvidence;
  assert.doesNotThrow(() => policy.assertObservation(config, equal));
  const changed = fixture(); delete changed.currencyEvidence;
  fails(() => policy.assertObservation(config, changed), 'PRICE_CURRENCY_UNPROVEN');
  fails(() => policy.assertObservation(config, { ...changed, currencyEvidence: { verified: true, currency: 'USD' } }), 'PRICE_CURRENCY_UNPROVEN');
});
test('zero, absent, invalid and divergent physical sources are quarantined without fallback', () => {
  for (const [physical, answer] of [[0, '5.4'], ['5.4', 0], [undefined, '5.4'], ['5.4', undefined], ['5.4', '5.5'], ['bad', 'bad']]) {
    const f = fixture(); f.observation.amber.product.weight = physical; f.observation.amber.product.details.answers.weight = answer;
    fails(() => policy.assertObservation(config, f), 'PHYSICAL_WEIGHT_INCOHERENT');
  }
});
test('Manager price must already be saved, positive and valid to UAH scale', () => {
  for (const value of [0, -1, undefined, 'bad', '42.001']) {
    const f = fixture(); f.observation.amber.product.total_price_uah = value;
    fails(() => policy.assertObservation(config, f), 'MANAGER_PRICE_REQUIRED');
  }
});
test('only exact numeric equality or the canonical historical rounding predicate permits decor_weight', () => {
  for (const remoteWeight of ['5.4', '5.400', '5']) assert.doesNotThrow(() => policy.assertObservation(config, fixture({ remoteWeight })));
  for (const remoteWeight of ['5.1', '6', '-5', 'bad']) fails(() => policy.assertObservation(config, fixture({ remoteWeight })), 'WEIGHT_NOT_ROUNDING_ONLY');
  assert.doesNotThrow(() => policy.assertObservation(config, fixture({ weight: '5.5', remoteWeight: '5' })));
  assert.doesNotThrow(() => policy.assertObservation(config, fixture({ weight: '5.5', remoteWeight: '6' })));
});
test('price and weight must be direct saved physical sources, not coincidentally equal literals or shipping controls', () => {
  fails(() => policy.assertObservation(config, fixture({ changeDefinition: (_d, sv) => { sv.rows[0].cells.price = literal('42'); } })), 'PRICE_SOURCE_PROVENANCE');
  fails(() => policy.assertObservation(config, fixture({ changeDefinition: (_d, sv) => { sv.rows[0].cells.decor_weight = literal('5.4'); } })), 'WEIGHT_SOURCE_PROVENANCE');
});
test('payload checks quarantine genuine extra custom attributes and forbid SEO keys even equal', () => {
  const f = fixture();
  f.report.sendability.operations.coreProduct.candidatePayload.product.custom_attributes.push({ attribute_code: 'material', value: 'new' });
  fails(() => policy.assertObservation(config, f), 'OTHER_FIELD_CHANGE');
  for (const english of [false, true]) {
    const s = fixture();
    if (english) s.report.transport.storeViews.candidatePayload = { product: { sku: s.observation.raw.sku, custom_attributes: [] } };
    const payload = english ? s.report.transport.storeViews.candidatePayload : s.report.sendability.operations.coreProduct.candidatePayload;
    payload.product.custom_attributes.push({ attribute_code: 'meta_title', value: '' });
    fails(() => policy.assertObservation(config, s), 'SEO_PAYLOAD_DENIED');
  }
});
test('approved published missing-remote fills pass while populated material differences require review', () => {
  for (const remoteSize of [undefined, '', 'Large']) {
    const f = fixture({ size: 'Large', remoteSize });
    assert.equal(f.report.sendable, true, JSON.stringify(f.report.blockers));
    assert.doesNotThrow(() => policy.assertObservation(config, f));
  }
  fails(() => policy.assertObservation(config, fixture({ size: 'Large', remoteSize: 'Small' })), 'OTHER_FIELD_CHANGE');
});
test('ordinary names are exact; only the separate initial-name stage can inspect a name baseline', () => {
  const f = fixture(); f.report.sendability.operations.coreProduct.candidatePayload.product.name = 'Changed';
  fails(() => policy.assertObservation(config, f), 'NAME_CHANGE');
  assert.doesNotThrow(() => policy.assertObservation(config, { ...f, stage: 'names' }));
  f.report.blockers.push({ code: 'NAME_BASELINE_REQUIRED' }); f.report.sendable = false;
  assert.doesNotThrow(() => policy.assertObservation(config, { ...f, stage: 'names' }));
  fails(() => policy.assertObservation(config, f), 'CANONICAL_BLOCKER');
  f.report.blockers.push({ code: 'NAME_CONFLICT' });
  fails(() => policy.assertObservation(config, { ...f, stage: 'names' }), 'CANONICAL_BLOCKER');
});
test('canonical full-product domains remain authorized rather than becoming a price-only transport', () => {
  const f = fixture();
  f.report.transport.websites.operations.push({ candidatePayload: { productWebsiteLink: { sku: f.observation.raw.sku, website_id: 802 } } });
  f.report.transport.websites.requested.push({ websiteId: 802 });
  f.report.categories.wouldAdd.push({ categoryId: '9' });
  f.report.sendability.operations.categories.candidateLinks = [{ category_id: '9', position: 0 }];
  const intent = jobPlan.intent(f.report), baseline = jobPlan.baseline(f.observation, f.report);
  assert.ok(intent.operations.some(row => row.domain === 'categoryLinkSave'));
  assert.ok(intent.operations.some(row => row.domain === 'websites'));
  assert.equal(policy.assertIntent(config, { ...f, intent, baseline }), true);
});
test('native identity-bearing and shipping weight changes are not granted decor-weight authority', () => {
  for (const [name, before, after] of [['attribute_set_id', 8001, 8002], ['type_id', 'simple', 'virtual'], ['weight', 5, 5.4]]) {
    const f = fixture(); f.observation.raw[name] = before;
    f.report.sendability.operations.coreProduct.candidatePayload.product[name] = before;
    assert.doesNotThrow(() => policy.assertObservation(config, f));
    f.report.sendability.operations.coreProduct.candidatePayload.product[name] = after;
    fails(() => policy.assertObservation(config, f), 'OTHER_FIELD_CHANGE');
  }
});
test('identity, current lifecycle, read failures and changed intent fail closed', () => {
  for (const mutate of [f => { f.observation.amber.product.is_test_product = true; }, f => { f.observation.amber.product.corrected_from_product_id = 1; },
    f => { f.observation.amber.product.exportState.route = 'hold'; }]) {
    const f = fixture(); mutate(f); fails(() => policy.assertObservation(config, f), 'IDENTITY_OR_LIFECYCLE');
  }
  const f = fixture(); f.observation.domainEvidence.failures.push({ code: 'STORE_VIEW_READ_UNAVAILABLE' });
  fails(() => policy.assertObservation(config, f), 'REMOTE_READ_INCOMPLETE');
  const other = fixture(), intent = jobPlan.intent(other.report); intent.operations[0].payload.product.price = 99;
  fails(() => policy.assertIntent(config, { ...other, intent, baseline: jobPlan.baseline(other.observation, other.report) }), 'INTENT_CHANGED');
});
test('first-sync local choices are limited to price/decor all keep_local and preserve names receipts', () => {
  const f = fixture(), base = namedBase(f), choices = policy.selectChoices(base);
  assert.deepEqual(choices, [{ target: 'decor_weight', scope: 'all', choice: 'keep_local' }, { target: 'price', scope: 'all', choice: 'keep_local' }]);
  const prepared = inspectedProgress(base.projection, base.first.progress, choices, base.observation.amber.product.id);
  assert.equal(policy.assertPrepared(prepared, { base, choices }), true);
  const resumed = baseFor(f, { fields: prepared.rows.map(row => row.record) });
  assert.deepEqual(policy.selectChoices(resumed), []);
  assert.equal(policy.assertPrepared(resumed.prepared, { base: resumed, stage: 'equal' }), true);
  const bad = structuredClone(prepared);
  bad.rows.find(row => row.target === 'price').record.source.field = 'some_other_price';
  fails(() => policy.assertPrepared(bad, { base, choices }), 'CHOICE_CHANGED');
});
test('names receipts preserve unchanged unresolved price and weight for the later field stage', () => {
  const base = baseFor(fixture());
  assert.ok(base.prepared.rows.some(row => row.target === 'price' && row.record.state === 'conflict'));
  assert.equal(policy.assertPrepared(base.prepared, { base, stage: 'names' }), true);
});
test('full names-stage ledger evidence still selects unresolved Manager price and physical weight decisions', () => {
  const f = fixture(), namesBase = baseFor(f);
  assert.equal(policy.assertPrepared(namesBase.prepared, { base: namesBase, stage: 'names' }), true);
  // Canonical names commit records the complete manifest, including unresolved
  // conflicts. Persisted observation evidence is not a keep-local decision.
  const afterNames = baseFor(f, { fields: structuredClone(namesBase.prepared.rows.map(row => row.record)) });
  for (const target of ['price', 'decor_weight']) {
    const row = afterNames.prepared.rows.find(field => field.target === target);
    assert.equal(row.record.state, 'conflict'); assert.equal(row.received, false);
    assert.deepEqual(row.record, afterNames.first.progress.fields.find(field => field.target === target));
  }
  const choices = policy.selectChoices(afterNames);
  assert.deepEqual(choices, [{ target: 'decor_weight', scope: 'all', choice: 'keep_local' },
    { target: 'price', scope: 'all', choice: 'keep_local' }]);
  const prepared = inspectedProgress(afterNames.projection, afterNames.first.progress, choices, f.observation.amber.product.id);
  assert.equal(policy.assertPrepared(prepared, { base: afterNames, choices }), true);
  assert.equal(prepared.readyForOutbound, true); assert.deepEqual(prepared.blockers, []);
  const resumed = baseFor(f, { fields: prepared.rows.map(row => row.record) });
  assert.deepEqual(policy.selectChoices(resumed), []);
  assert.equal(policy.assertPrepared(resumed.prepared, { base: resumed, stage: 'equal' }), true);
});
test('persisted unresolved non-allowlisted evidence still requires review after names', () => {
  const f = fixture({ size: 'Large', remoteSize: 'Small' }), namesBase = baseFor(f);
  const afterNames = baseFor(f, { fields: structuredClone(namesBase.prepared.rows.map(row => row.record)) });
  const row = afterNames.prepared.rows.find(field => field.target === 'rozmir_suveniriv');
  assert.equal(row.record.state, 'conflict'); assert.equal(row.received, false);
  fails(() => policy.selectChoices(afterNames), 'OTHER_FIELD_CONFLICT');
});
test('canonical automatic pending fills create no explicit local choice and survive exact receipt validation', () => {
  const f = fixture({ size: 'Large', remotePrice: 42, remoteWeight: '5.4' }), base = namedBase(f);
  assert.doesNotThrow(() => policy.assertObservation(config, f));
  assert.ok(base.prepared.rows.some(row => row.target === 'rozmir_suveniriv' && row.record.state === 'pending_outward_confirmation'));
  assert.deepEqual(policy.selectChoices(base), []);
  assert.equal(policy.assertPrepared(base.prepared, { base, stage: 'equal' }), true);
  const bad = structuredClone(base.prepared);
  bad.rows.find(row => row.target === 'rozmir_suveniriv').record.source.decision = 'keep_local';
  fails(() => policy.assertPrepared(bad, { base, stage: 'equal' }), 'PREPARED_CHANGED');
  const withChoices = namedBase(fixture({ size: 'Large' })), choices = policy.selectChoices(withChoices);
  assert.equal(choices.length, 2);
  assert.equal(policy.assertPrepared(inspectedProgress(withChoices.projection, withChoices.first.progress, choices, withChoices.observation.amber.product.id), { base: withChoices, choices }), true);
  const missingPrice = fixture({ remotePrice: null, remoteWeight: '5.4' }), priceBase = namedBase(missingPrice);
  assert.doesNotThrow(() => policy.assertObservation(config, missingPrice));
  assert.deepEqual(policy.selectChoices(priceBase), []);
  assert.equal(policy.assertPrepared(priceBase.prepared, { base: priceBase, stage: 'equal' }), true);
});
test('equal-only receipt stage admits canonical equality but never a new automatic price or information import', () => {
  const f = fixture({ remotePrice: 42, remoteWeight: '5.4' }), base = namedBase(f);
  assert.deepEqual(policy.selectChoices(base), []);
  assert.equal(policy.assertPrepared(base.prepared, { base, stage: 'equal' }), true);
  const bad = structuredClone(base.prepared); bad.rows.find(row => row.target === 'price').record.state = 'imported';
  fails(() => policy.assertPrepared(bad, { base, stage: 'equal' }), 'PREPARED_CHANGED');
  const freshNames = baseFor(f);
  fails(() => policy.assertPrepared(freshNames.prepared, { base: freshNames, stage: 'equal' }), 'UNAPPROVED_IMPORT_OR_DECISION');
  assert.equal(policy.assertPrepared(freshNames.prepared, { base: freshNames, stage: 'names' }), true);
});
test('a canonical automatic information import is rejected even during names-only receipt processing', () => {
  const base = baseFor(fixture({ size: '', remoteSize: 'Large', remotePrice: 42, remoteWeight: '5.4' }));
  assert.ok(base.prepared.rows.some(row => row.target === 'rozmir_suveniriv' && row.record.state === 'imported'));
  fails(() => policy.assertPrepared(base.prepared, { base, stage: 'names' }), 'UNAPPROVED_IMPORT_OR_DECISION');
});
