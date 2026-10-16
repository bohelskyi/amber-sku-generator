const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/magento-bindings');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { normalizeSchema, hash } = require('../src/services/magento/binding-contract');
const { requirements, normalizeBindings } = require('../src/services/magento/binding-validation');
const { projectFirstSyncFields } = require('../src/services/magento/first-sync-projection');
const { prepareProgress } = require('../src/services/magento/first-sync-progress-plan');
const literal = value => ({ op: 'literal', value });
const source = id => ({ op: 'source', id });
const ref = id => ({ op: 'ref', id });
const present = input => ({ op: 'present', input, policy: 'answer-v1' });
const error = (field, message) => ({ op: 'error', field, message: literal(message) });
const DIMENSIONS = [['bead_length', 'dovzhyna_namystyny'], ['bead_width', 'diametr_namystyny'], ['rosary_length', 'dovzhyna_vyrobu']];
const TEXT = ['dovzhyna_namystyny', 'diametr_namystyny', 'dovzhyna_vyrobu', 'rozmir_kameniu', 'meta_title'];

// Synthetic CH route shaped like the published Magento v1 CH expressions.
function chFixture(options = {}) {
  const definition = structuredClone(fixtures.definition());
  const ch = definition.groups.find(group => group.route === 'CH');
  const cells = ch.rows[0].cells;
  for (const [key, target] of DIMENSIONS) {
    definition.sources[`CH.${key}`] = { kind: 'information', category: 'CH', key, type: 'scalar',
      provenance: 'supplied-stored-answers-v1', aliases: [] };
    const answer = source(`CH.${key}`);
    definition.bindings.push({ id: `CH.raw.${target}`, group: 'CH', value: { op: 'when', if: present(answer),
      then: { op: 'text', input: answer, trim: true, format: 'scalar-v1', onAbsent: 'empty' },
      else: error(target, `Немає відповіді ${key}.`) } });
    cells[target] = { op: 'decimalText', input: ref(`CH.raw.${target}`), format: 'unsigned-comma-dot-v1',
      error: error(target, 'Некоректне числове значення для Magento.') };
  }
  const length = ref('CH.raw.dovzhyna_namystyny'), width = ref('CH.raw.diametr_namystyny');
  cells.rozmir_kameniu = { op: 'when', if: { op: 'all', items: [present(length), present(width)] },
    then: { op: 'interpolate', template: '{length}×{width}', slots: { length, width } }, else: literal('') };
  cells.meta_title = literal('Amber CH title');
  for (const group of definition.groups) group.rows[1].cells.price = literal('');
  options.changeDefinition?.(definition);
  const compiled = compileDefinition(definition);
  const schema = structuredClone(fixtures.schema());
  schema.attributes.find(attribute => attribute.attribute_code === 'name').scope = 'store';
  TEXT.forEach((code, i) => schema.attributes.push({ attribute_id: 950 + i, attribute_code: code,
    frontend_input: code === 'meta_title' ? 'textarea' : 'text', options: [] }));
  schema.attributeSets[0].attributeCodes.push(...TEXT);
  const normalizedSchema = normalizeSchema(schema);
  const plans = requirements(compiled.definition, normalizedSchema);
  const selected = plans.filter(plan => plan.amberGroup === 'CH');
  const bindings = { routes: plans.map(plan => ({ routeKey: plan.routeKey, enabled: selected.includes(plan),
    setId: selected.includes(plan) ? 8001 : null, reviewState: selected.includes(plan) ? 'approved' : 'review_required' })),
  attributes: [], options: [], policies: [] };
  for (const plan of selected) for (const attribute of plan.attributes) {
    bindings.attributes.push({ routeKey: plan.routeKey, rowId: attribute.rowId, target: attribute.target,
      strategy: attribute.strategy, attributeCode: attribute.strategy === 'transport_control' ? null : attribute.target,
      transportTarget: attribute.strategy === 'transport_control' ? 'product.' + attribute.target : null, reviewState: 'approved' });
    bindings.policies.push({ bindingKey: attribute.bindingKey, storeCode: attribute.rowId === 'english' ? 'en' : 'all',
      policy: attribute.strategy === 'transport_control' ? 'magento_managed'
        : options.policies?.[attribute.target] || 'authoritative_create_update', reviewState: 'approved' });
  }
  const revision = { id: '11111111-1111-1111-1111-111111111111', state: 'published',
    templateVersionId: '22222222-2222-2222-2222-222222222222', definitionHash: compiled.hash,
    evaluatorVersion: compiled.definition.evaluatorVersion, outputContract: compiled.definition.outputContract,
    formatVersion: compiled.definition.formatVersion, schemaFingerprint: hash(normalizedSchema),
    topologyFingerprint: hash(normalizedSchema.storeTopology), schema: normalizedSchema, bindings: normalizeBindings(bindings) };
  const product = { id: 1, category: 'CH', full_sku: 'CH-fixture', weight: '19.500', total_price_uah: '42.00',
    details: { answers: { bead_length: '14,7', bead_width: '7.4', rosary_length: '33', ...options.answers } } };
  const remoteValues = { dovzhyna_namystyny: '7.400000', diametr_namystyny: '14.700000', dovzhyna_vyrobu: '33.000000',
    rozmir_kameniu: '7.4×14.7', meta_title: 'Magento CH title', ...options.remote };
  const raw = { id: 81, sku: product.full_sku, attribute_set_id: 8001, name: 'Remote UA', price: '42.000',
    custom_attributes: Object.entries(remoteValues).map(([attribute_code, value]) => ({ attribute_code, value })) };
  return { observation: { amber: { product, compiled, revision,
    template: { kind: 'published', versionId: revision.templateVersionId, definitionHash: compiled.hash } },
  raw, schema: normalizedSchema,
  domainEvidence: { english: { id: raw.id, sku: raw.sku, fields: { name: 'Remote EN' } }, failures: [] } },
  currencyEvidence: { verified: true, currency: 'UAH' } };
}
const field = (result, target) => result.plan.fields.find(value => value.target === target && value.scope === 'all');
const metadata = (result, target) => result.projection.find(value => value.target === target && value.scope === 'all');
const row = (prepared, target) => prepared.rows.find(value => value.target === target && value.scope === 'all');

test('CH bead dimensions compare numerically as forward-only derived decimals', () => {
  const result = projectFirstSyncFields(chFixture());
  assert.equal(field(result, 'dovzhyna_vyrobu').status, 'equal');
  assert.equal(field(result, 'dovzhyna_vyrobu').reason, 'DERIVED_FORWARD_EQUAL');
  for (const target of ['dovzhyna_namystyny', 'diametr_namystyny', 'rozmir_kameniu']) {
    assert.equal(field(result, target).status, 'review_required');
    assert.equal(field(result, target).reason, 'DERIVED_FORWARD_MISMATCH');
    assert.equal(metadata(result, target).persistence, 'derived');
    assert.equal(metadata(result, target).localAuthority, 'ch-bead-dimensions-v1');
    assert.equal(metadata(result, target).reason, undefined);
  }
  const length = result.fields.find(value => value.target === 'dovzhyna_namystyny');
  assert.deepEqual([length.type, length.scale, length.local.value], ['decimal', 6, '14.7']);
});

test('Amber may keep its CH bead dimensions; Magento never imports into the answers', () => {
  const projected = projectFirstSyncFields(chFixture());
  const open = prepareProgress(projected, null);
  for (const target of ['dovzhyna_namystyny', 'diametr_namystyny', 'rozmir_kameniu']) {
    assert.equal(row(open, target).canKeepLocal, true);
    assert.equal(row(open, target).canAcceptRemote, false);
    assert.equal(row(open, target).canRetainRemote, false);
  }
  const choices = ['dovzhyna_namystyny', 'diametr_namystyny', 'rozmir_kameniu']
    .map(target => ({ target, scope: 'all', choice: 'keep_local' }));
  const kept = prepareProgress(projected, null, choices);
  for (const { target } of choices) {
    assert.equal(row(kept, target).record.state, 'pending_outward_confirmation');
    assert.equal(row(kept, target).record.source.decision, 'keep_local');
    assert.equal(row(kept, target).record.after, target === 'rozmir_kameniu' ? '14,7×7.4' : row(kept, target).local.value);
  }
  assert.throws(() => prepareProgress(projected, null, [{ target: 'diametr_namystyny', scope: 'all', choice: 'accept_remote' }]),
    { code: 'MAGENTO_FIRST_SYNC_DECISION_NOT_AVAILABLE' });
  // After guarded delivery Magento reads back the decimal with its own scale.
  const delivered = projectFirstSyncFields(chFixture({ remote: { dovzhyna_namystyny: '14.700000',
    diametr_namystyny: '7.400000', rozmir_kameniu: '14,7×7.4' } }));
  const prior = choices.map(({ target }) => row(kept, target).record);
  const verified = prepareProgress(delivered, { fields: prior });
  for (const { target } of choices) assert.equal(row(verified, target).record.state, 'outward_verified');
});

test('CH decimal comparison stays fail-closed for invalid, empty and unproven inputs', () => {
  const invalid = projectFirstSyncFields(chFixture({ remote: { dovzhyna_vyrobu: '33 cm' } }));
  assert.equal(field(invalid, 'dovzhyna_vyrobu').reason, 'REMOTE_DECIMAL_INVALID_OR_SCALE_EXCEEDED');
  const empty = projectFirstSyncFields(chFixture({ answers: { rosary_length: undefined } }));
  assert.notEqual(field(empty, 'dovzhyna_vyrobu').status, 'equal');
  assert.equal(prepareProgress(empty, null).rows.find(value => value.target === 'dovzhyna_vyrobu').canKeepLocal, false);
  const other = projectFirstSyncFields(chFixture({ changeDefinition: definition => {
    const cells = definition.groups.find(group => group.route === 'CH').rows[0].cells;
    cells.dovzhyna_vyrobu = { op: 'decimalText', input: ref('CH.raw.diametr_namystyny'), format: 'unsigned-comma-dot-v1',
      error: error('dovzhyna_vyrobu', 'bad') };
  } }));
  assert.equal(metadata(other, 'dovzhyna_vyrobu').reason, 'CANONICAL_SOURCE_SETTER_UNSUPPORTED');
  assert.equal(metadata(other, 'dovzhyna_vyrobu').localAuthority, undefined);
});

test('approved magento_managed CH SEO is left to Magento instead of blocking first sync', () => {
  const owned = projectFirstSyncFields(chFixture());
  assert.equal(field(owned, 'meta_title').reason, 'DERIVED_FORWARD_MISMATCH');
  const managed = projectFirstSyncFields(chFixture({ policies: { meta_title: 'magento_managed' } }));
  assert.equal(field(managed, 'meta_title'), undefined);
  assert.deepEqual(managed.coverage.fields.find(value => value.target === 'meta_title'),
    { target: 'meta_title', scope: 'all', state: 'ignored', reason: 'MAGENTO_MANAGED_DERIVED_SEO' });
  assert.equal(managed.blockers.some(blocker => blocker.target === 'meta_title'), false);
  // A non-terminal earlier decision for the field still blocks completion.
  const prior = prepareProgress(owned, null).rows.find(value => value.target === 'meta_title').record;
  assert.equal(prepareProgress(managed, { fields: [prior] }).blockers
    .some(blocker => blocker.code === 'FIRST_SYNC_UNSETTLED_PRIOR_FIELD' && blocker.target === 'meta_title'), true);
});
