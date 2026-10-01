const test = require('node:test');
const assert = require('node:assert/strict');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const { validateBindings } = require('../src/services/magento/binding-validation');
const fixture = require('./fixtures/magento-v4');
const legacy = require('./fixtures/magento-bindings');
const { loadSourceEvidence, validateSourceReferences } = require('../src/services/export-templates/source-references');
const { upgradeSourceSupport } = require('../src/services/export-templates/source-support');
const { HEADERS } = require('../src/services/export-templates/magento-v1-data');

test('legacy six-group/category limitation is explicit and retained', () => {
  const d = structuredClone(legacy.definition());
  d.groups.push({ ...structuredClone(d.groups[0]), route: 'XG' });
  assert.throws(() => compileDefinition(d), /List limit 6/);
  const source = structuredClone(legacy.definition()); source.sources.color.category = 'XG';
  assert.throws(() => compileDefinition(source), /Answer location/);
  const partial = structuredClone(legacy.definition()); partial.groups.pop();
  assert.throws(() => compileDefinition(partial), /Six groups required/);
});

test('v4 supports a seventh catalog category and its new semantic/information sources', () => {
  const compiled = compileDefinition(fixture.definition(['BR', 'NM', 'KL', 'CH', 'AR', 'SV', 'XG']));
  const result = evaluateProduct(compiled, { category: 'XG', full_sku: 'XG91001', public_sku: 'AG-000003',
    total_price_uah: 123, details: { answers: { new_color: 7, new_note: 'Exact stored information' } } });
  assert.deepEqual(result.errors, []); assert.equal(result.base.sku, 'AG-000003');
  assert.equal(result.base.kolir, 'Red output'); assert.equal(result.base.new_note, 'Exact stored information');
});
test('v4 supports bounded partial category sets and explicit semantic bindings', () => {
  const d = fixture.definition(); compileDefinition(d);
  const b = fixture.approvedBindings(d); const result = validateBindings(b, d, fixture.observation(), { publish: true });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(b.options[0].sourceKey, 'XG.new_color=value_id:7');
  assert.equal(b.options[0].optionId, 'red-id'); assert.equal(b.options[0].skuCodeEvidence, '91');
});

test('existing Magento planner consumes v4 sources and exact reviewed remote option identities', () => {
  const { planPreview } = require('../src/services/magento/sync-preview');
  const { indexTrees } = require('../src/services/magento/sync-preview-categories');
  const { hash } = require('../src/services/magento/binding-contract');
  const compiled = compileDefinition(fixture.definition()); const schema = fixture.observation();
  const b = fixture.approvedBindings();
  b.policies.forEach((p) => { p.policy = 'authoritative_create_update'; });
  for (const a of b.attributes.filter((a) => a.strategy === 'transport_control')) {
    a.transportTarget = `product.${{ attribute_set_code: 'attribute_set_id', product_type: 'type_id' }[a.target] || a.target}`;
  }
  const amber = { compiled, template: { definitionHash: compiled.hash },
    product: { id: 3, category: 'XG', full_sku: 'XG91001', public_sku: 'AG-000003', status: 'active', exclude_from_export: 0,
      total_price_uah: 123, details: { answers: { new_color: 7, new_note: 'Exact information' } } },
    revision: { id: 'v4-fixture', revision: '1', state: 'published', schema, bindings: b,
      schemaFingerprint: hash(schema), topologyFingerprint: hash(schema.storeTopology) } };
  const p = planPreview(amber, schema, null, indexTrees([]));
  assert.equal(p.mode, 'create'); assert.equal(p.candidatePayload.product.sku, 'AG-000003');
  assert.equal(p.candidatePayload.product.price, 123);
  assert.equal(p.attributes.find((a) => a.target === 'kolir').magentoOptionId, 'red-id');
  assert.equal(p.candidatePayload.product.custom_attributes.find((a) => a.attribute_code === 'new_note').value, 'Exact information');
  assert.ok(!p.blockers.some((b) => b.code === 'ROUTE_ANALYSIS_UNSUPPORTED'));
});

test('v4 requires bounded declared scopes and the protected public identity contract', () => {
  const reject = (change) => { const d = fixture.definition(); change(d); assert.throws(() => compileDefinition(d), { code: 'TEMPLATE_INVALID' }); };
  reject((d) => { d.groups = []; });
  reject((d) => { d.groups.push(structuredClone(d.groups[0])); });
  reject((d) => { d.groups[0].route = '../XG'; });
  reject((d) => { d.groups = Array.from({ length: 65 }, (_, i) => ({ ...d.groups[0], route: `X${i}` })); });
  reject((d) => { d.sources.color.category = 'UNDECLARED'; });
  reject((d) => { d.bindings = [{ id: 'other', group: 'UNDECLARED', value: { op: 'literal', value: 'x' } }]; });
  reject((d) => { delete d.sourceContractVersion; });
  reject((d) => { d.outputContract = 'magento-products-v1'; });
  reject((d) => { d.groups[0].columns = d.groups[0].columns.filter((c) => c !== 'price'); });
});

test('v4 runtime protects public identity, required names, stores, type and positive price', () => {
  const p = { category: 'XG', full_sku: 'XG91001', public_sku: 'AG-000003', total_price_uah: 123,
    details: { answers: { new_color: 7, new_note: 'note' } } };
  const compiled = compileDefinition(fixture.definition());
  assert.ok(evaluateProduct(compiled, { ...p, public_sku: null }).errors.length);
  assert.ok(evaluateProduct(compiled, { ...p, total_price_uah: 0 }).errors.length);
  for (const [cell, value] of [['sku', 'XG91001'], ['name', ''], ['attribute_set_code', ''], ['store_view_code', 'wrong'], ['product_type', 'configurable']]) {
    const d = fixture.definition();
    // Non-literal branches cannot evade final protected-row checks.
    d.groups[0].rows[0].cells[cell] = { op: 'firstPresent', items: [{ op: 'literal', value }], policy: 'answer-v1' };
    assert.ok(evaluateProduct(compileDefinition(d), p).errors.length, cell);
  }
  const unknown = evaluateProduct(compiled, { ...p, category: 'UNDECLARED' });
  assert.equal(unknown.sku, p.public_sku); assert.ok(unknown.errors.length);
});

test('v4 publication evidence does not trust draft SKU options or alias claims', () => {
  const d = fixture.definition();
  const evidence = { categories: ['XG'], questions: [
    { category_code: 'XG', key: 'new_color', include_in_sku: 1, value_ids: ['7'] },
    { category_code: 'XG', key: 'new_note', include_in_sku: 0, value_ids: [] }], schemas: [] };
  assert.ok(validateSourceReferences(d, evidence).some((e) => e.sourceId === 'color' && e.code === 'SOURCE_REFERENCE_UNRESOLVED'));
  evidence.schemas.push({ id: '1', category_code: 'XG', questions: [{ key: 'new_color', value_ids: ['7'] }] });
  assert.deepEqual(validateSourceReferences(d, evidence), []);
  d.sources.color.aliases.push({ key: 'new_color', schemaId: '1', evidence: 'Operator claim' });
  assert.ok(validateSourceReferences(d, evidence).some((e) => e.requirement === 'alias_lineage'));
  evidence.questions[1].include_in_sku = 1;
  assert.ok(validateSourceReferences(d, evidence).some((e) => e.sourceId === 'note'));
});

test('source evidence expands only for v4; preparation preserves its evaluator and identity', async () => {
  const scopes = [];
  const db = { query: async (_sql, parameters) => { scopes.push(parameters[0]); return { rows: [{}] }; } };
  await loadSourceEvidence(db);
  await loadSourceEvidence(db, legacy.definition());
  await loadSourceEvidence(db, compileDefinition(fixture.definition(['XG', 'BR'])).definition);
  assert.deepEqual(scopes, [Object.keys(HEADERS), Object.keys(HEADERS), ['BR', 'XG']]);
  const d = fixture.definition(); const next = upgradeSourceSupport(d, { schemas: [] });
  assert.equal(next.evaluatorVersion, d.evaluatorVersion);
  assert.equal(next.sourceContractVersion, d.sourceContractVersion);
  assert.equal(Object.hasOwn(d, 'sourceSupport'), false);
});

test('evaluator 1–3 retain frozen definition/hash/output and public/internal identity boundaries', () => {
  const before = structuredClone(legacy.definition());
  const p = { category: 'BR', full_sku: 'BR91001', public_sku: 'AG-000003', total_price_uah: 42,
    weight: 1, details: { answers: { binding_test_semantic: 7, binding_test_size: '17' } } };
  for (const version of [1, 2, 3]) {
    const d = structuredClone(before); d.evaluatorVersion = `magento-declarative-${version}`;
    if (version === 2) d.sourceSupport = { version: 'historical-source-support-v1', sources: {} };
    if (version === 3) { d.sourceContractVersion = 'public-product-identity-v1'; d.sources.sku.field = 'public_sku'; }
    const original = structuredClone(d); const a = compileDefinition(d); const b = compileDefinition(original);
    assert.deepEqual(d, original); assert.deepEqual(a.definition, original); assert.equal(a.hash, b.hash);
    assert.equal(evaluateProduct(a, p).base.sku, version === 3 ? p.public_sku : p.full_sku);
    assert.deepEqual(evaluateProduct(a, p), evaluateProduct(b, p));
    d.groups.push({ ...structuredClone(d.groups[0]), route: 'XG' });
    assert.throws(() => compileDefinition(d), { code: 'TEMPLATE_INVALID' });
  }
  const d = fixture.definition(Object.keys(HEADERS));
  // The same declared data/program produces identical v3/v4 protected rows.
  delete d.sources.color; delete d.sources.note; d.questionContracts = {};
  const v4 = compileDefinition(d); d.evaluatorVersion = 'magento-declarative-3';
  assert.deepEqual(evaluateProduct(v4, p), evaluateProduct(compileDefinition(d), p));
});
