const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareProgress, blockImports, TERMINAL } = require('../src/services/magento/first-sync-progress-plan');
const { planFirstSyncFields } = require('../src/services/magento/first-sync-field-plan');
const { hash, normalizeSchema } = require('../src/services/magento/binding-contract');
const { projectFirstSyncFields } = require('../src/services/magento/first-sync-projection');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { normalizeBindings } = require('../src/services/magento/binding-validation');
const fixtures = require('./fixtures/magento-bindings');
const present = value => ({ known: true, present: true, value });
const absent = () => ({ known: true, present: false });
const field = (target, patch = {}) => ({ target, scope: 'all', kind: 'scalar', type: 'text',
  required: true, mapping: { proven: true }, local: present('Local'), remote: present('Remote'), ...patch });
const row = (prepared, target, scope = 'all') => prepared.rows.find(item => item.target === target && item.scope === scope);
function projection(fields, metadata = {}, progress = null, blockers = []) {
  const resolved = fields.map(input => {
    const prior = progress?.fields.find(item => item.target === input.target && item.scope === input.scope);
    return { ...input, ...(prior && TERMINAL.has(prior.state) ? { receipt: { state: prior.state } } : {}) };
  });
  return { fields: resolved, plan: planFirstSyncFields({ fields: resolved }), blockers,
    projection: resolved.map(input => ({ target: input.target, scope: input.scope,
      persistence: input.kind === 'name' ? 'name' : 'information',
      outwardPolicy: 'authoritative_create_update', mappingHash: hash(input.scope + '/' + input.target),
      source: { kind: 'information', key: input.target, productId: 7,
        bindingRevisionId: '11111111-1111-4111-8111-111111111111',
        definitionHash: 'a'.repeat(64), routeKey: 'SV.souvenir=value_id:6' },
      ...(metadata[input.scope + '/' + input.target] || {}) })) };
}
function received(record) {
  return { fields: [{ ...structuredClone(record), revision: '3', recordedAt: '2026-10-09T00:00:00Z' }] };
}
function realProjection() {
  const definition = structuredClone(fixtures.definition());
  const text = id => ({ op: 'text', input: { op: 'source', id }, trim: false, format: 'scalar-v1', onAbsent: 'empty' });
  definition.sources.price = { kind: 'product', field: 'total_price_uah', type: 'scalar' };
  definition.sources.size.key = 'braclet_size';
  const br = definition.groups.find(group => group.route === 'BR');
  br.rows[0].cells.price = text('price'); br.rows[0].cells.decor_weight = text('weight');
  br.rows[0].cells.dovzhyna_brasletu_diuimiv = text('size');
  const compiled = compileDefinition(definition), rawSchema = structuredClone(fixtures.schema());
  rawSchema.attributes.find(a => a.attribute_code === 'name').scope = 'store';
  for (const target of ['decor_weight', 'dovzhyna_brasletu_diuimiv']) {
    const attribute = rawSchema.attributes.find(a => a.attribute_code === target);
    attribute.frontend_input = 'text'; attribute.options = [];
  }
  const schema = normalizeSchema(rawSchema), rawBindings = fixtures.approvedBindings(compiled.definition, schema, 'BR');
  for (const policy of rawBindings.policies) policy.policy = 'authoritative_create_update';
  const bindings = normalizeBindings(rawBindings);
  const revision = { id: '11111111-1111-4111-8111-111111111111', state: 'published',
    templateVersionId: '22222222-2222-4222-8222-222222222222', definitionHash: compiled.hash,
    evaluatorVersion: compiled.definition.evaluatorVersion, outputContract: compiled.definition.outputContract,
    formatVersion: compiled.definition.formatVersion, schemaFingerprint: hash(schema),
    topologyFingerprint: hash(schema.storeTopology), schema, bindings };
  const product = { id: 7, category: 'BR', full_sku: 'BR-fixture', weight: '5.000', total_price_uah: '42.00',
    details: { answers: { binding_test_semantic: 7, braclet_size: '17' } } };
  const raw = { id: 81, sku: product.full_sku, attribute_set_id: 8001, name: 'Remote UA', price: '43.00',
    custom_attributes: [{ attribute_code: 'kolir', value: 'red-id' }, { attribute_code: 'decor_weight', value: '5.0' },
      { attribute_code: 'dovzhyna_brasletu_diuimiv', value: '18' }] };
  return projectFirstSyncFields({ observation: { amber: { product, compiled, revision,
    template: { kind: 'published', versionId: revision.templateVersionId, definitionHash: compiled.hash } },
    raw, schema, domainEvidence: { english: { id: raw.id, sku: raw.sku, fields: { name: 'Remote EN' } }, failures: [] } },
  currencyEvidence: { verified: true, currency: 'UAH' } });
}

test('real published projector keeps the whole manifest when one conflict is accepted', () => {
  const projected = realProjection(), before = structuredClone(projected);
  assert.equal(projected.plan.fields.find(f => f.target === 'price').status, 'conflict');
  const initial = prepareProgress(projected, null);
  const chosen = prepareProgress(projected, null, { target: 'dovzhyna_brasletu_diuimiv', scope: 'all', choice: 'accept_remote' });
  assert.equal(row(chosen, 'dovzhyna_brasletu_diuimiv').record.state, 'imported');
  assert.equal(row(chosen, 'dovzhyna_brasletu_diuimiv').record.after, '18');
  assert.equal(row(chosen, 'price').status, 'conflict');
  assert.deepEqual(chosen.manifest, projected.fields.map(({ target, scope }) => ({ target, scope })));
  assert.ok(chosen.manifest.length > 2);
  assert.ok(chosen.manifest.some(f => f.target === 'name' && f.scope === 'en'));
  assert.equal(chosen.manifestHash, initial.manifestHash);
  assert.equal(chosen.readyForOutbound, false); assert.equal(chosen.complete, false);
  assert.ok(chosen.blockers.some(b => b.target === 'price' && b.scope === 'all'));
  assert.deepEqual(projected, before);
});

test('keeping authoritative local conflict permits outward but never claims completed readback', () => {
  const projected = projection([field('length')]);
  const prepared = prepareProgress(projected, null, { target: 'length', scope: 'all', choice: 'keep_local' });
  assert.equal(row(prepared, 'length').record.state, 'pending_outward_confirmation');
  assert.equal(row(prepared, 'length').record.after, 'Local');
  assert.equal(row(prepared, 'length').record.source.decision, 'keep_local');
  assert.equal(prepared.readyForOutbound, true); assert.equal(prepared.complete, false);
});

test('accepting one field leaves unrelated conflicts blocking whole-product outward work', () => {
  const prepared = prepareProgress(projection([field('length'), field('diameter')]), null,
    { target: 'length', scope: 'all', choice: 'accept_remote' });
  assert.equal(row(prepared, 'length').record.state, 'imported');
  assert.equal(row(prepared, 'diameter').record.state, 'conflict');
  assert.equal(prepared.readyForOutbound, false); assert.equal(prepared.complete, false);
  assert.deepEqual(prepared.manifest, [{ target: 'length', scope: 'all' }, { target: 'diameter', scope: 'all' }]);
  assert.equal(prepared.blockers.filter(b => b.target === 'diameter').length, 1);
});

test('received name keeps exact original evidence across later manager edits and publication changes', () => {
  const originalField = field('name', { kind: 'name', remote: present('Original remote name') });
  const original = row(prepareProgress(projection([originalField]), null), 'name').record;
  const progress = received(original), before = structuredClone(progress);
  const current = projection([field('name', { kind: 'name', local: present('Later manager edit'),
    remote: present('Later remote edit') })], {
    'all/name': { mappingHash: 'b'.repeat(64), source: { kind: 'product', field: 'name',
      bindingRevisionId: '33333333-3333-4333-8333-333333333333', definitionHash: 'c'.repeat(64), routeKey: 'SV:new' } }
  }, progress);
  const prepared = prepareProgress(current, progress), name = row(prepared, 'name');
  assert.deepEqual(name.record, original);
  assert.equal(name.canAcceptRemote, false); assert.equal(name.canKeepLocal, false);
  assert.equal(name.local.value, 'Later manager edit'); assert.equal(name.terminal, true);
  assert.equal(Object.hasOwn(name.record, 'revision'), false); assert.equal(Object.hasOwn(name.record, 'recordedAt'), false);
  assert.deepEqual(progress, before);
});

test('unknown current remote read blocks outbound despite a permanent received name receipt', () => {
  const original = row(prepareProgress(projection([field('name', { kind: 'name' })]), null), 'name').record;
  const progress = received(original);
  const prepared = prepareProgress(projection([field('name', { kind: 'name', remote: { known: false } })], {}, progress), progress);
  assert.equal(row(prepared, 'name').status, 'unknown');
  assert.deepEqual(row(prepared, 'name').record, original);
  assert.equal(prepared.readyForOutbound, false); assert.equal(prepared.complete, false);
  assert.ok(prepared.blockers.some(b => b.target === 'name' && b.reason === 'REMOTE_READ_UNKNOWN'));
});

test('pending outward becomes an outward_verified receipt only on fresh semantic equality', () => {
  const initialField = field('price', { type: 'decimal', scale: 2, local: present('42.00'), remote: absent() });
  const metadata = { 'all/price': { persistence: 'price' } };
  const pending = row(prepareProgress(projection([initialField], metadata), null), 'price').record;
  assert.equal(pending.state, 'pending_outward_confirmation');
  const progress = received(pending);
  const prepared = prepareProgress(projection([{ ...initialField, remote: present('042.000') }], metadata, progress), progress);
  assert.equal(row(prepared, 'price').status, 'equal');
  assert.equal(row(prepared, 'price').record.state, 'outward_verified');
  assert.deepEqual(row(prepared, 'price').record.remote, present('042.000'));
  assert.equal(prepared.readyForOutbound, true); assert.equal(prepared.complete, true);
});

test('old keep_local decision is reused only while before, remote and mapping evidence remain exact', () => {
  const input = field('length'), initial = projection([input]);
  const kept = row(prepareProgress(initial, null, { target: 'length', scope: 'all', choice: 'keep_local' }), 'length').record;
  const progress = received(kept);
  assert.equal(row(prepareProgress(projection([input], {}, progress), progress), 'length').status, 'pending_outward_confirmation');
  for (const [changedField, metadata] of [
    [{ ...input, local: present('New local') }, {}],
    [{ ...input, remote: present('New remote') }, {}],
    [input, { 'all/length': { mappingHash: 'e'.repeat(64) } }],
  ]) {
    const next = prepareProgress(projection([changedField], metadata, progress), progress);
    assert.equal(row(next, 'length').status, 'conflict');
    assert.equal(next.readyForOutbound, false);
    assert.equal(Object.hasOwn(row(next, 'length').record.source, 'decision'), false);
  }
});

test('unsupported canonical weight and generic import setters produce precise review without import', () => {
  for (const [target, persistence, expected] of [
    ['decor_weight', 'weight', 'CANONICAL_WEIGHT_SETTER_UNSUPPORTED'],
    ['unsupported', 'generic', 'CANONICAL_GENERIC_SETTER_UNSUPPORTED'],
  ]) {
    const prepared = prepareProgress(projection([field(target, { local: absent() })],
      { ['all/' + target]: { persistence } }), null);
    assert.equal(row(prepared, target).record.state, 'review_required');
    assert.equal(row(prepared, target).reason, expected);
    assert.equal(row(prepared, target).record.after, null);
    assert.equal(row(prepared, target).canAcceptRemote, false);
    assert.equal(prepared.readyForOutbound, false);
  }
  const specific = prepareProgress(projection([field('option', { local: absent() })],
    { 'all/option': { persistence: 'characteristic', importBlocker: 'IMMUTABLE_CHARACTERISTIC_VERSION_IMPORT_UNSUPPORTED' } }), null);
  assert.equal(row(specific, 'option').reason, 'IMMUTABLE_CHARACTERISTIC_VERSION_IMPORT_UNSUPPORTED');
});

test('keep_local requires the exact authoritative policy and proven mapping', () => {
  for (const policy of ['magento_managed', 'create_only', null]) {
    const projected = projection([field('length')], { 'all/length': { outwardPolicy: policy } });
    assert.equal(row(prepareProgress(projected, null), 'length').canKeepLocal, false);
    assert.throws(() => prepareProgress(projected, null, { target: 'length', scope: 'all', choice: 'keep_local' }),
      { code: 'MAGENTO_FIRST_SYNC_DECISION_NOT_AVAILABLE' });
  }
  const unknownMapping = projection([field('length', { mapping: { proven: false, reason: 'UNPROVEN' } })]);
  assert.throws(() => prepareProgress(unknownMapping, null, { target: 'length', scope: 'all', choice: 'keep_local' }),
    { code: 'MAGENTO_FIRST_SYNC_DECISION_NOT_AVAILABLE' });
});

test('one runtime validation failure preserves other safe imports and blocks whole outbound readiness', () => {
  const projected = projection([field('length', { local: absent() }), field('name', { kind: 'name', scope: 'en' })]);
  const prepared = prepareProgress(projected, null), safeName = structuredClone(row(prepared, 'name', 'en').record);
  const blocked = blockImports(prepared, [{ target: 'length', scope: 'all', code: 'CATALOG_VALUE_INVALID', reason: 'Length exceeds catalog limit' }]);
  assert.equal(row(blocked, 'length').record.state, 'review_required');
  assert.equal(row(blocked, 'length').record.after, null);
  assert.equal(row(blocked, 'length').canAcceptRemote, false);
  assert.deepEqual(row(blocked, 'name', 'en').record, safeName);
  assert.equal(row(blocked, 'name', 'en').record.state, 'name_received');
  assert.equal(blocked.readyForOutbound, false); assert.equal(blocked.complete, false);
  assert.ok(blocked.blockers.some(b => b.target === 'length' && b.code === 'FIRST_SYNC_FIELD_VALIDATION_REQUIRED'));
});

test('unknown selected scope and unknown decision fail closed without mutating projection', () => {
  const projected = projection([field('length')]), before = structuredClone(projected);
  assert.throws(() => prepareProgress(projected, null, { target: 'other', scope: 'all', choice: 'accept_remote' }),
    { code: 'MAGENTO_FIRST_SYNC_FIELD_NOT_MAPPED' });
  assert.throws(() => prepareProgress(projected, null, { target: 'length', scope: 'all', choice: 'overwrite_all' }),
    { code: 'MAGENTO_FIRST_SYNC_DECISION_INVALID' });
  assert.deepEqual(projected, before);
});

test('all outward-pending fields require authoritative policy even without an explicit keep decision', () => {
  for (const policy of ['magento_managed', 'create_only', null]) {
    const prepared = prepareProgress(projection([field('length', { remote: absent() })],
      { 'all/length': { outwardPolicy: policy } }), null);
    assert.equal(row(prepared, 'length').record.state, 'review_required');
    assert.equal(row(prepared, 'length').reason, 'OUTWARD_POLICY_NOT_AUTHORITATIVE');
    assert.equal(prepared.readyForOutbound, false); assert.equal(prepared.complete, false);
  }
  const allowed = prepareProgress(projection([field('length', { remote: absent() })]), null);
  assert.equal(row(allowed, 'length').record.state, 'pending_outward_confirmation');
  assert.equal(allowed.readyForOutbound, true); assert.equal(allowed.complete, false);
});

test('publication changes cannot drop unresolved prior scopes from the whole-product gate', () => {
  for (const state of ['conflict', 'unknown', 'pending_outward_confirmation', 'review_required']) {
    const old = { ...row(prepareProgress(projection([field('old_attribute')]), null), 'old_attribute').record, state };
    const progress = received(old);
    const prepared = prepareProgress(projection([field('current', { remote: present('Local') })], {}, progress), progress);
    assert.equal(prepared.readyForOutbound, false); assert.equal(prepared.complete, false);
    assert.ok(prepared.blockers.some(b => b.code === 'FIRST_SYNC_UNSETTLED_PRIOR_FIELD' && b.target === 'old_attribute' && b.reason === state));
  }
  const terminal = { ...row(prepareProgress(projection([field('old_attribute')]), null), 'old_attribute').record, state: 'equal' };
  const progress = received(terminal);
  const settled = prepareProgress(projection([field('current', { remote: present('Local') })], {}, progress), progress);
  assert.equal(settled.readyForOutbound, true); assert.equal(settled.complete, true);
});

test('a later validation result cannot rewrite a durable received-name record', () => {
  const original = row(prepareProgress(projection([field('name', { kind: 'name' })]), null), 'name').record;
  const progress = received(original);
  const prepared = prepareProgress(projection([field('name', { kind: 'name', local: present('Manager edit') })], {}, progress), progress);
  const result = blockImports(prepared, [{ target: 'name', scope: 'all', code: 'NEW_VALIDATION' }]);
  assert.deepEqual(row(result, 'name').record, original);
  assert.equal(row(result, 'name').terminal, true);
});

test('canonical import defers other new confirmations until a fresh observation while retaining received names', () => {
  const { deferAfterCanonicalImports } = require('../src/services/magento/first-sync-progress-plan');
  const original = row(prepareProgress(projection([field('name', { kind: 'name' })]), null), 'name').record;
  const progress = received(original);
  const projected = projection([
    field('length', { local: absent() }),
    field('derived', { kind: 'derived', local: present('Same'), remote: present('Same'), prospective: { verified: true, value: 'Same' } }),
    field('optional', { required: false, local: absent(), remote: absent() }),
    field('name', { kind: 'name', local: present('Manager edit') }),
  ], {}, progress);
  const prepared = deferAfterCanonicalImports(prepareProgress(projected, progress), projected);
  assert.equal(row(prepared, 'length').record.state, 'imported');
  for (const target of ['derived', 'optional']) {
    assert.equal(row(prepared, target).record.state, 'review_required');
    assert.equal(row(prepared, target).reason, 'POST_IMPORT_CANONICAL_RECHECK_REQUIRED');
  }
  assert.deepEqual(row(prepared, 'name').record, original);
  assert.equal(prepared.readyForOutbound, false); assert.equal(prepared.complete, false);
  assert.ok(prepared.blockers.some(b => b.code === 'FIRST_SYNC_POST_ADOPTION_RECHECK_REQUIRED'));
});
