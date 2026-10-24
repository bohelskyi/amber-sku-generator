const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/magento-bindings');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { normalizeSchema, hash } = require('../src/services/magento/binding-contract');
const { requirements, normalizeBindings } = require('../src/services/magento/binding-validation');
const { projectFirstSyncFields } = require('../src/services/magento/first-sync-projection');
const { prepareProgress } = require('../src/services/magento/first-sync-progress-plan');
const TARGET = 'rozmir_iuvelirnoho_vyrobu';
const source = id => ({ op: 'source', id });

// Synthetic KL route shaped like the published Magento v1 KL size expression.
function klFixture(options = {}) {
  const definition = structuredClone(fixtures.definition());
  for (const key of ['pedant_size', 'exact_size']) definition.sources[`KL.${key}`] = { kind: 'information', category: 'KL', key,
    type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] };
  definition.bindings.push({ id: `KL.${TARGET}`, group: 'KL', value: { op: 'text', trim: true, format: 'scalar-v1', onAbsent: 'empty',
    input: { op: 'firstPresent', items: [source('KL.pedant_size'), source('KL.exact_size')], policy: 'answer-v1' } } });
  definition.groups.find(group => group.route === 'KL').rows[0].cells[TARGET] = { op: 'ref', id: `KL.${TARGET}` };
  for (const group of definition.groups) group.rows[1].cells.price = { op: 'literal', value: '' };
  const compiled = compileDefinition(definition);
  const schema = structuredClone(fixtures.schema());
  schema.attributes.find(attribute => attribute.attribute_code === 'name').scope = 'store';
  schema.attributes.push({ attribute_id: 960, attribute_code: TARGET, frontend_input: 'text', options: [] });
  schema.attributeSets[0].attributeCodes.push(TARGET);
  const normalizedSchema = normalizeSchema(schema);
  const plans = requirements(compiled.definition, normalizedSchema);
  const selected = plans.filter(plan => plan.amberGroup === 'KL');
  const bindings = { routes: plans.map(plan => ({ routeKey: plan.routeKey, enabled: selected.includes(plan),
    setId: selected.includes(plan) ? 8001 : null, reviewState: selected.includes(plan) ? 'approved' : 'review_required' })),
  attributes: [], options: [], policies: [] };
  for (const plan of selected) for (const attribute of plan.attributes) {
    bindings.attributes.push({ routeKey: plan.routeKey, rowId: attribute.rowId, target: attribute.target,
      strategy: attribute.strategy, attributeCode: attribute.strategy === 'transport_control' ? null : attribute.target,
      transportTarget: attribute.strategy === 'transport_control' ? 'product.' + attribute.target : null, reviewState: 'approved' });
    bindings.policies.push({ bindingKey: attribute.bindingKey, storeCode: attribute.rowId === 'english' ? 'en' : 'all',
      policy: attribute.strategy === 'transport_control' ? 'magento_managed'
        : options.policy && attribute.target === TARGET ? options.policy : 'authoritative_create_update', reviewState: 'approved' });
  }
  const revision = { id: '11111111-1111-1111-1111-111111111111', state: 'published',
    templateVersionId: '22222222-2222-2222-2222-222222222222', definitionHash: compiled.hash,
    evaluatorVersion: compiled.definition.evaluatorVersion, outputContract: compiled.definition.outputContract,
    formatVersion: compiled.definition.formatVersion, schemaFingerprint: hash(normalizedSchema),
    topologyFingerprint: hash(normalizedSchema.storeTopology), schema: normalizedSchema, bindings: normalizeBindings(bindings) };
  const product = { id: 1, category: options.category || 'KL', full_sku: 'KL-fixture', weight: '6.800', total_price_uah: '42.00',
    details: { answers: { pedant_size: options.local ?? '3/1.8' } } };
  const raw = { id: 81, sku: product.full_sku, attribute_set_id: 8001, name: 'Remote UA', price: '42.000',
    custom_attributes: [{ attribute_code: TARGET, value: options.remote ?? '3/1,8' }] };
  return { observation: { amber: { product, compiled, revision,
    template: { kind: 'published', versionId: revision.templateVersionId, definitionHash: compiled.hash } },
  raw, schema: normalizedSchema,
  domainEvidence: { english: { id: raw.id, sku: raw.sku, fields: { name: 'Remote EN' } }, failures: [] } },
  currencyEvidence: { verified: true, currency: 'UAH' } };
}
const row = (prepared) => prepared.rows.find(value => value.target === TARGET && value.scope === 'all');
const meta = (result) => result.projection.find(value => value.target === TARGET && value.scope === 'all');

test('Amber may keep its KL size when Magento differs only by decimal commas', () => {
  const projected = projectFirstSyncFields(klFixture());
  assert.equal(meta(projected).localAuthority, 'kl-jewelry-size-decimal-point-v1');
  const open = prepareProgress(projected, null);
  assert.equal(row(open).status, 'review_required');
  assert.equal(row(open).reason, 'DERIVED_FORWARD_MISMATCH');
  assert.equal(row(open).canKeepLocal, true);
  assert.equal(row(open).canAcceptRemote, false);
  const choices = [{ target: TARGET, scope: 'all', choice: 'keep_local' }];
  const kept = prepareProgress(projected, null, choices);
  assert.equal(row(kept).record.state, 'pending_outward_confirmation');
  assert.equal(row(kept).record.after, '3/1.8');
  // Guarded delivery writes the dotted value; the readback then matches exactly.
  const verified = prepareProgress(projectFirstSyncFields(klFixture({ remote: '3/1.8' })), { fields: [row(kept).record] });
  assert.equal(row(verified).record.state, 'outward_verified');
});

for (const [label, options] of [
  ['other separators', { local: '3-1.5', remote: '3/1,5' }],
  ['other digits', { local: '3/1.8', remote: '3/1,9' }],
  ['Amber comma', { local: '3/1,8', remote: '3/1.8' }],
  ['both commas', { local: '3/1,8', remote: '3/1,7' }],
  ['empty Magento', { remote: '' }],
  ['create-only policy', { policy: 'initialize_create_only' }],
]) test('KL size keep_local stays unavailable: ' + label, () => {
  const open = prepareProgress(projectFirstSyncFields(klFixture(options)), null);
  assert.notEqual(row(open).canKeepLocal, true);
  assert.throws(() => prepareProgress(projectFirstSyncFields(klFixture(options)), null, [{ target: TARGET, scope: 'all', choice: 'keep_local' }]));
});
