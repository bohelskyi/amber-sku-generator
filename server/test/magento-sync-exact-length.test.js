const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('./fixtures/magento-bindings');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { normalizeSchema, hash } = require('../src/services/magento/binding-contract');
const { normalizeBindings } = require('../src/services/magento/binding-validation');
const { getExactLengthComparison } = require('../src/services/magento/first-sync-projection');
const { planPreview, comparison, exactLengthComparison } = require('../src/services/magento/sync-preview');
const { matches, verifyStep } = require('../src/services/magento/sync-job-plan');
const nativeOwnership = require('../src/services/magento/native-identity-ownership');

const TARGET = 'dovzhyna_namysta_tochna';
function fixture(local = '77,5', remote = '77.50', options = {}) {
  const definition = structuredClone(fixtures.definition());
  definition.sources.necklaceLength = { kind: 'information', category: 'NM', key: 'neckle_size',
    type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [], ...options.source };
  definition.groups.find(group => group.route === 'NM').rows[0].cells[TARGET] = {
    op: 'text', input: { op: 'source', id: 'necklaceLength' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' };
  const compiled = compileDefinition(definition);
  const schema = structuredClone(fixtures.schema());
  schema.attributes.find(attribute => attribute.attribute_code === 'name').scope = 'store';
  schema.attributes.push({ attribute_id: 990, attribute_code: TARGET,
    frontend_input: 'text', backend_type: 'varchar', scope: 'global', options: [] });
  schema.attributeSets[0].attributeCodes.push(TARGET);
  const normalizedSchema = normalizeSchema(schema);
  const bindings = fixtures.approvedBindings(compiled.definition, normalizedSchema, 'NM');
  bindings.policies.forEach(policy => { policy.policy = 'authoritative_create_update'; });
  const revision = { id: '11111111-1111-1111-1111-111111111111', state: 'published',
    templateVersionId: '22222222-2222-2222-2222-222222222222', definitionHash: compiled.hash,
    evaluatorVersion: compiled.definition.evaluatorVersion, outputContract: compiled.definition.outputContract,
    formatVersion: compiled.definition.formatVersion, schemaFingerprint: hash(normalizedSchema),
    topologyFingerprint: hash(normalizedSchema.storeTopology), schema: normalizedSchema,
    bindings: normalizeBindings(bindings) };
  const product = { id: 1, category: 'NM', full_sku: 'NM-exact-length-fixture', weight: '5.000',
    total_price_uah: '42.00', details: { answers: { neckle_size: local } } };
  const raw = { id: 81, sku: product.full_sku, attribute_set_id: 8001, name: 'Remote UA', price: '42.00',
    custom_attributes: [{ attribute_code: TARGET, value: remote }] };
  return { amber: { product, compiled, revision,
    template: { kind: 'published', versionId: revision.templateVersionId, definitionHash: compiled.hash } },
  raw, schema: normalizedSchema, categoryNodes: [],
  domainEvidence: { english: { id: raw.id, sku: raw.sku, fields: { name: 'Remote EN' } }, failures: [] } };
}
const operation = (observation, value = observation.amber.product.details.answers.neckle_size) => ({
  domain: 'coreProduct', payload: { product: { sku: observation.raw.sku,
    custom_attributes: [{ attribute_code: TARGET, value }] } } });
const preview = observation => planPreview(observation.amber, observation.schema, observation.raw,
  observation.categoryNodes, { domainEvidence: observation.domainEvidence });
const targetDiff = report => report.diff.find(field => field.target === TARGET);

test('ordinary preview and core readback use the real exact NM proof and retain the raw payload', () => {
  const observation = fixture(), before = structuredClone(observation);
  assert.equal(getExactLengthComparison(observation)?.comparison, 'nm-exact-length-cm-v1');
  const report = preview(observation), field = targetDiff(report);
  assert.equal(field.comparison, 'numeric_equivalent_formatting');
  assert.equal(field.action, 'unchanged');
  assert.equal(field.current, '77.50'); assert.equal(field.candidate, '77,5');
  assert.equal(report.candidatePayload.product.custom_attributes.find(a => a.attribute_code === TARGET).value, '77,5');
  assert.equal(matches(operation(observation), observation), true);
  assert.equal(verifyStep(operation(observation), observation), true);
  assert.deepEqual(observation, before);
});

for (const [local, remote] of [['32', '32.00'], ['00032,500', '32.5'], [32.5, '32.500'],
  ['0', '-0.00'], [' 77,5 ', '77.50'], ['77.5000000000000001', '77.500000000000000100']]) {
  test(`exact readback admits decimal formatting only: ${JSON.stringify(local)} / ${JSON.stringify(remote)}`, () => {
    const observation = fixture(local, remote);
    assert.equal(matches(operation(observation), observation), true);
    assert.ok(['exact', 'numeric_equivalent_formatting'].includes(targetDiff(preview(observation)).comparison));
  });
}
for (const [local, remote] of [['77.5000000000000001', '77.5000000000000002'], ['77.5', '77.51'],
  ['77.55', '77.6']]) {
  test(`exact readback rejects a genuine decimal difference: ${local} / ${remote}`, () => {
    const observation = fixture(local, remote);
    assert.equal(matches(operation(observation), observation), false);
    assert.equal(targetDiff(preview(observation)).comparison, 'semantic_difference');
    assert.equal(targetDiff(preview(observation)).action, 'would_update');
  });
}
for (const value of ['77 см', '77-78', '', null, 'not a number', '7.7e1', '77\n', '\t77', '0.0000000000000000001']) {
  test(`exact readback never accepts an invalid or empty identical value: ${JSON.stringify(value)}`, () => {
    const observation = fixture(value, value);
    assert.equal(matches(operation(observation), observation), false);
    if (value !== null && value !== '') assert.equal(targetDiff(preview(observation)).comparison, 'semantic_difference');
  });
}
test('missing remote length keeps the existing absent diagnostic and raw outward candidate', () => {
  const observation = fixture('77,5', null);
  const field = targetDiff(preview(observation));
  assert.equal(field.comparison, 'absent'); assert.equal(field.action, 'would_add');
  assert.equal(field.candidate, '77,5'); assert.equal(field.current, null);
  assert.equal(matches(operation(observation), observation), false);
});
test('proof is not borrowed for a payload different from the current local source', () => {
  const observation = fixture('77.5', '78.00');
  assert.equal(matches(operation(observation, '78'), observation), false);
  const proof = getExactLengthComparison(observation);
  assert.equal(exactLengthComparison('78', '78.00', proof), 'semantic_difference');
});
test('pure matching with unavailable metadata proof permits only strict valid raw equality', () => {
  const observation = fixture('77.5', '77.5');
  observation.schema = structuredClone(observation.schema);
  observation.schema.attributes.find(attribute => attribute.attribute_code === TARGET).backend_type = 'decimal';
  assert.equal(getExactLengthComparison(observation), null);
  assert.equal(matches(operation(observation), observation), true);
  observation.raw.custom_attributes[0].value = '77.50';
  assert.equal(matches(operation(observation), observation), false);
});
test('an unproven source keeps a strict ordinary diff and cannot confirm readback', () => {
  const observation = fixture('77.5000000000000001', '77.5000000000000002', { source: { key: 'other_length' } });
  observation.amber.product.details.answers.other_length = '77.5000000000000001';
  assert.equal(getExactLengthComparison(observation), null);
  assert.equal(targetDiff(preview(observation)).comparison, 'semantic_difference');
  assert.equal(matches(operation(observation), observation), false);
});
test('pure strict readback equality does not grant an unapproved mapping authority', () => {
  const observation = fixture('77.5', '77.5');
  observation.amber.revision.bindings.attributes.find(a => a.target === TARGET && a.rowId === 'base').reviewState = 'review_required';
  assert.equal(getExactLengthComparison(observation), null);
  assert.equal(matches(operation(observation), observation), true);
  assert.ok(preview(observation).blockers.some(blocker => blocker.code === 'ATTRIBUTE_BINDING_REVIEW_REQUIRED'
    && blocker.target === TARGET));
  observation.raw.custom_attributes[0].value = '77.50';
  assert.equal(matches(operation(observation), observation), false);
});
async function allocatedFixture(local, remote) {
  const observation = fixture(local, remote);
  Object.assign(observation.amber.product, { characteristic_version_id: '23',
    public_product_identity_id: '17', public_sku: observation.raw.sku });
  await nativeOwnership.load({ query: async () => ({ rows: [{ origin: 'allocated', remote_id: null }] }) },
    observation.amber, observation.amber.revision.originHash);
  assert.equal(nativeOwnership.issue(observation.amber, observation.raw), nativeOwnership.CODE);
  assert.equal(getExactLengthComparison(observation), null);
  return observation;
}
test('allocated CREATE readback with no acknowledged remote ID retains strict valid raw matching', async () => {
  const observation = await allocatedFixture('77.5', '77.5');
  assert.equal(matches(operation(observation), observation), true);
  assert.equal(verifyStep(operation(observation), observation), true);
  // This pure readback does not remove canonical identity/authorization guards.
  assert.ok(preview(observation).blockers.some(blocker => blocker.code === nativeOwnership.CODE));
});
for (const [local, remote] of [['77,5', '77.50'], [77.5, '77.5'],
  ['77.5000000000000001', '77.5000000000000002'], ['77 см', '77 см'], ['77-78', '77-78'],
  ['', ''], [null, null], ['77\n', '77\n'], ['0.0000000000000000001', '0.0000000000000000001']]) {
  test(`unproven CREATE readback rejects formatting, difference or invalid values: ${JSON.stringify(local)} / ${JSON.stringify(remote)}`, async () => {
    const observation = await allocatedFixture(local, remote);
    assert.equal(matches(operation(observation), observation), false);
    assert.equal(verifyStep(operation(observation), observation), false);
  });
}
test('schema/projection failure is a closed readback, not an exception or a numeric fallback', () => {
  const observation = fixture(); delete observation.amber.revision;
  assert.equal(matches(operation(observation), observation), false);
});
test('unrelated scalar fields retain the existing comparison behavior', () => {
  assert.equal(comparison('77.5000000000000001', '77.5000000000000002'), 'numeric_equivalent_formatting');
  const observation = fixture();
  observation.raw.custom_attributes.push({ attribute_code: 'unrelated_text', value: '32.00' });
  const unrelated = { domain: 'coreProduct', payload: { product: {
    custom_attributes: [{ attribute_code: 'unrelated_text', value: '32' }] } } };
  assert.equal(matches(unrelated, observation), true);
});
