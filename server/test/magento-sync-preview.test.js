const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { planPreview, previewProduct, comparison } = require('../src/services/magento/sync-preview');
const { indexTrees, resolveCategories, currentAssignments } = require('../src/services/magento/sync-preview-categories');
const { parseArguments, runSyncPreview, artifactPath } = require('../scripts/magento-sync-preview');
const { writeArtifact } = require('../scripts/magento-schema-audit');
const { parseMagentoConfig } = require('../src/config/magento');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { requirements, normalizeBindings } = require('../src/services/magento/binding-validation');
const { hash, originHash } = require('../src/services/magento/binding-contract');
const { describeMapper, CSV_FIELDS } = require('../src/services/magento/mapper-schema');
const { evaluate } = require('../src/services/magento/binding-evidence-products');
const bindingFixture = require('./fixtures/magento-bindings');
const { catalog, product } = require('./fixtures/magento-v1/contract');

const env = { MAGENTO_BASE_URL: 'https://preview.example.invalid', MAGENTO_CONSUMER_KEY: 'synthetic-consumer-key',
  MAGENTO_CONSUMER_SECRET: 'synthetic-consumer-secret', MAGENTO_ACCESS_TOKEN: 'synthetic-access-token',
  MAGENTO_ACCESS_TOKEN_SECRET: 'synthetic-access-secret' };
const config = parseMagentoConfig(env);
const now = () => '2026-09-27T11:22:33.000Z';
const literal = (value) => ({ op: 'literal', value });
const nodes = indexTrees([{ id: 803, name: 'Default', parent_id: 1, children_data: [
  { id: 901, parent_id: 803, name: 'Amber', children_data: [{ id: 902, parent_id: 901, name: 'Gifts', children_data: [] }] },
  { id: 903, parent_id: 803, name: 'Sale', children_data: [{ id: 904, parent_id: 903, name: 'Gifts', children_data: [] }] },
] }]);
function fixture({ approved = false, status = '2' } = {}) {
  const d = structuredClone(bindingFixture.definition());
  Object.assign(d.groups[0].rows[0].cells, { categories: literal('Default/Amber/Gifts'), product_online: literal(status),
    visibility: literal('Catalog, Search'), product_websites: literal('fixture'), qty: literal('1'), is_in_stock: literal('1'),
    meta_title: literal('Template SEO'), meta_description: literal('Template summary') });
  const compiled = compileDefinition(d); const schema = bindingFixture.schema();
  schema.attributeSets[0].attribute_set_name = 'Historical CSV name';
  schema.attributes.find((a) => a.attribute_code === 'kolir').options.find((o) => o.value === 'red-id').label = 'Red output';
  for (const code of ['description', 'short_description', 'meta_title', 'meta_description']) {
    schema.attributes.push({ attribute_code: code, attribute_id: schema.attributes.length + 1000, frontend_input: 'text', options: [] });
    schema.attributeSets[0].attributeCodes.push(code);
  }
  const amber = { compiled, template: { kind: 'system', definitionHash: compiled.hash }, observedAt: now(), revision: null,
    product: { id: 17, full_sku: 'BR2/TEST-SYNC', category: 'BR', status: 'active', exclude_from_export: 0,
      weight: 5, details: { answers: { binding_test_semantic: 7, binding_test_size: '17' } } } };
  const raw = { id: 123, sku: amber.product.full_sku, attribute_set_id: 8001, name: 'Fixture name',
    price: 40, status: 1, visibility: 4, type_id: 'simple', extension_attributes: {
      category_links: [{ category_id: '904', position: 8 }], website_ids: [801], stock_item: { qty: 4, is_in_stock: true } },
    custom_attributes: [{ attribute_code: 'kolir', value: 'blue-id' }, { attribute_code: 'meta_title', value: 'Maintained SEO' },
      { attribute_code: 'meta_description', value: 'Maintained summary' }, { attribute_code: 'description', value: 'Maintained description' },
      { attribute_code: 'short_description', value: 'Maintained short' }, { attribute_code: 'unrelated', value: 'should not be retained' }] };
  if (approved) {
    const bindings = bindingFixture.approvedBindings(compiled.definition, schema);
    bindings.policies = bindings.policies.map((p) => ({ ...p, policy: 'authoritative_create_update' }));
    const native = { attribute_set_code: 'attribute_set_id', product_type: 'type_id', product_online: 'status', visibility: 'visibility',
      categories: 'extension_attributes.category_links', product_websites: 'extension_attributes.website_ids',
      qty: 'inventory.qty', is_in_stock: 'inventory.is_in_stock', store_view_code: 'store_view_code' };
    for (const a of bindings.attributes) if (a.strategy === 'transport_control') a.transportTarget = `product.${native[a.target]}`;
    amber.revision = { id: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), revision: '2', state: 'draft',
      schema: structuredClone(schema), schemaFingerprint: hash(schema), topologyFingerprint: hash(schema.storeTopology),
      originHash: originHash(config.baseUrl), bindings: normalizeBindings(bindings) };
  }
  return { amber, schema, raw };
}
const run = (f, raw = f.raw) => planPreview(f.amber, f.schema, raw, nodes, { generatedAt: now() });
const field = (r, target) => r.attributes.find((a) => a.target === target);
const custom = (r, target) => r.candidatePayload.product.custom_attributes.find((a) => a.attribute_code === target)?.value;
const has = (r, code) => r.blockers.some((b) => b.code === code);

test('UPDATE produces native payload, option labels, scalar diff and preserves merchandising and Magento-only taxonomy', () => {
  const f = fixture(); const before = structuredClone(f.raw); const r = run(f);
  assert.equal(r.mode, 'update'); assert.equal(r.candidatePayload.product.visibility, 4);
  assert.equal(r.candidatePayload.product.status, 2); assert.equal(r.candidatePayload.product.type_id, 'simple');
  assert.equal(r.candidatePayload.product.attribute_set_id, 8001);
  assert.equal(field(r, 'kolir').magentoOptionId, 'red-id'); assert.equal(field(r, 'kolir').currentResolvedOptions[0].label, 'Remote blue');
  assert.equal(field(r, 'kolir').authority, 'candidate_only');
  assert.ok(r.candidatePayload.product.custom_attributes.every((a) => !CSV_FIELDS.has(a.attribute_code)));
  for (const target of ['description', 'short_description', 'meta_title', 'meta_description']) {
    assert.equal(custom(r, target), undefined);
    assert.equal(r.fieldOwnership.find((f) => f.target === target).action, 'preserve');
  }
  assert.deepEqual(r.candidatePayload.product.extension_attributes.category_links,
    [{ category_id: '904', position: 8 }, { category_id: '902', position: 0 }]);
  assert.equal(r.categories.preservedMagentoOnly[0].action, 'preserve_by_safe_preview');
  assert.equal(r.categories.wouldRemoveIfAuthoritative[0].categoryId, '904');
  assert.equal(r.sendable, false); assert.equal(r.sendability.sendable, false);
  assert.ok(r.untouchedMagentoFields.some((f) => f.field === 'unrelated'));
  assert.ok(!JSON.stringify(r).includes('should not be retained')); assert.deepEqual(f.raw, before);
});
test('approved status policy creates disabled independently of evaluator and preserves existing status', () => {
  const f = fixture({ approved: true, status: '1' });
  const a = f.amber.revision.bindings.attributes.find((a) => a.target === 'product_online' && a.rowId === 'base');
  const p = f.amber.revision.bindings.policies.find((p) => p.bindingKey === a.bindingKey);
  Object.assign(p, { policy: 'initialize_create_only', evidence: { createValue: 2 } });
  const created = run(f, null);
  assert.equal(field(created, 'product_online').evaluatedValue, '1');
  assert.equal(created.candidatePayload.product.status, 2);
  const updated = run(f);
  assert.equal(updated.candidatePayload.product.status, undefined);
  assert.equal(updated.fieldOwnership.find((p) => p.target === 'product_online').action, 'preserve');
  assert.ok(!updated.sendability.operations.coreProduct.blockers.some((b) => b.target === 'product_online'));
  assert.equal(updated.candidatePayload.product.name, 'Fixture name');
  assert.equal(custom(updated, 'meta_title'), 'Template SEO');
  assert.ok(updated.untouchedMagentoFields.some((f) => f.field === 'unrelated'));
  f.raw.sku = 'DIFFERENT-SKU';
  assert.ok(has(run(f), 'CURRENT_PRODUCT_SKU_MISMATCH'));
});

test('CREATE uses evaluator name and separates optional merchandising and inventory/website intents', () => {
  const r = run(fixture(), null);
  assert.equal(r.mode, 'create'); assert.equal(r.candidatePayload.product.name, 'Fixture name');
  assert.equal(custom(r, 'meta_title'), undefined);
  assert.equal(field(r, 'meta_title').evaluatedValue, 'Template SEO');
  assert.equal(r.transport.inventory.status, 'unresolved');
  assert.equal(r.transport.websites.requested[0].websiteId, 801);
  assert.equal(r.candidatePayload.product.extension_attributes.website_ids, undefined);
});
test('approved semantic, dynamic and numeric-band bindings retain semantic identities and exact option IDs', () => {
  const r = run(fixture({ approved: true }));
  assert.equal(r.attributeSet.status, 'resolved_authoritative');
  for (const [target, strategy, option] of [['kolir', 'semantic_option', 'red-id'],
    ['dovzhyna_brasletu_diuimiv', 'dynamic_exact_label_option', 'size-id'], ['decor_weight', 'numeric_band_option', 'small-id']]) {
    assert.equal(field(r, target).strategy, strategy); assert.equal(field(r, target).authority, 'authoritative');
    assert.equal(custom(r, target), option);
  }
  assert.equal(field(r, 'kolir').optionDecision.valueId, '7');
  assert.equal(field(r, 'kolir').optionDecision.skuCodeEvidence, '91');
  assert.equal(field(r, 'kolir').magentoOptionId, 'red-id');
});
test('blocked, proposed, review-required, missing and ambiguous option decisions fail closed', () => {
  for (const state of ['blocked', 'proposed', 'review_required']) {
    const f = fixture({ approved: true });
    f.amber.revision.bindings.options.find((o) => o.valueId === '7').reviewState = state;
    const r = run(f);
    assert.equal(field(r, 'kolir').authority, state === 'blocked' ? 'blocked' : 'candidate_only');
    assert.equal(custom(r, 'kolir'), state === 'blocked' ? undefined : 'red-id');
    assert.equal(r.sendable, false);
  }
  for (const options of [[], [{ value: 'a', label: 'Red output' }, { value: 'b', label: 'Red output' }]]) {
    const f = fixture(); f.schema.attributes.find((a) => a.attribute_code === 'kolir').options = options;
    const r = run(f); assert.equal(field(r, 'kolir').authority, 'unresolved'); assert.equal(custom(r, 'kolir'), undefined);
    assert.ok(has(r, 'OPTION_UNRESOLVED')); assert.ok(r.candidatePayload.product.price);
  }
});
test('attribute-set mismatch, missing membership and schema identity drift remain decisions', () => {
  const f = fixture(); f.raw.attribute_set_id = 222;
  f.schema.attributeSets[0].attributeCodes = f.schema.attributeSets[0].attributeCodes.filter((c) => c !== 'kolir');
  let r = run(f); assert.ok(r.attributeSet.diagnostics.includes('PRODUCT_ATTRIBUTE_SET_MISMATCH'));
  assert.equal(field(r, 'kolir').applicability, 'absent'); assert.ok(has(r, 'ATTRIBUTE_NOT_IN_SELECTED_SET'));
  const approved = fixture({ approved: true }); approved.schema.attributes.find((a) => a.attribute_code === 'kolir').attribute_id = 9999;
  r = run(approved); assert.ok(has(r, 'BINDING_DRIFT_REVIEW_REQUIRED'));
});
test('category paths use full hierarchy, never leaf names; duplicates remain ambiguous', () => {
  const resolve = (text, tree = nodes) => resolveCategories(text, tree, { known: true, source: 'test', links: [] });
  assert.equal(resolve(' Default / Amber / Gifts ').requested[0].categoryId, '902');
  assert.equal(resolve('Default/Sale/Gifts').requested[0].categoryId, '904');
  assert.equal(resolve('Gifts').requested[0].status, 'missing');
  assert.equal(resolve('Default/Missing/Gifts').requested[0].status, 'missing');
  assert.equal(resolve('Default/Amber/Gifts', [...nodes, { ...nodes[2], categoryId: '999' }]).requested[0].status, 'ambiguous');
  const f = fixture(); f.amber.compiled = compileDefinition({ ...f.amber.compiled.definition,
    groups: f.amber.compiled.definition.groups.map((g, i) => i ? g : { ...g, rows: g.rows.map((r, j) => j ? r
      : { ...r, cells: { ...r.cells, categories: literal('Default/Missing') } }) }) });
  const r = run(f); assert.ok(has(r, 'CATEGORY_PATH_MISSING')); assert.equal(r.candidatePayload.product.price, 42);
});
test('missing category assignment evidence does not imply empty assignments; contradictory contracts reject', () => {
  const f = fixture(); delete f.raw.extension_attributes.category_links;
  const r = run(f); assert.ok(has(r, 'CURRENT_CATEGORY_ASSIGNMENTS_UNAVAILABLE'));
  assert.equal(r.candidatePayload.product.extension_attributes, undefined);
  f.raw.extension_attributes.category_links = [{ category_id: '902', position: 1 }];
  f.raw.custom_attributes.push({ attribute_code: 'category_ids', value: ['904'] });
  assert.throws(() => currentAssignments(f.raw), { code: 'MAGENTO_PREVIEW_CATEGORIES_INVALID' });
});
test('live category-link regression: signed positions survive UPDATE preview alongside unresolved template paths', () => {
  const f = systemFixture('KL');
  // Same response shape/negative ordering values as the failed live preview;
  // installation IDs and taxonomy below are synthetic.
  const links = [901, 902, 903, 904, 905, 906].map((id, i) => ({ category_id: String(id),
    position: [-183, -181, -135, -59, -148, -51][i] }));
  f.raw.extension_attributes.category_links = links;
  f.raw.custom_attributes.push({ attribute_code: 'category_ids', value: links.map((l) => l.category_id) });
  const before = structuredClone(f);
  const evaluatedPaths = evaluate(f.amber, f.amber.product).base.categories.split(',');
  const r = run(f);
  assert.equal(r.mode, 'update');
  assert.equal(r.sendable, false);
  assert.ok(has(r, 'CATEGORY_PATH_MISSING'));
  assert.deepEqual(r.categories.requested.map((c) => c.requestedPath), evaluatedPaths, 'keep all export paths unchanged');
  assert.ok(r.categories.requested.every((c) => c.categoryId === null && c.status === 'missing'));
  assert.deepEqual(r.candidatePayload.product.extension_attributes.category_links, links, 'retain IDs and exact signed positions');
  assert.deepEqual(r.categories.preservedMagentoOnly.map((c) => [c.categoryId, c.position]), links.map((l) => [l.category_id, l.position]));
  assert.equal(r.categories.wouldAdd.length, 0);
  assert.ok(r.diff.some((d) => d.target === 'price'));
  assert.ok(r.fieldOwnership.some((f) => f.target === 'description' && f.action === 'preserve'));
  assert.ok(r.blockers.some((b) => b.code !== 'CATEGORY_PATH_MISSING'));
  assert.deepEqual(f.raw, before.raw);
});
test('category positions may be unknown but never coerced or invented; invalid identities still reject', () => {
  for (const position of [null, undefined]) {
    const f = fixture(); f.raw.extension_attributes.category_links[0].position = position;
    const r = run(f);
    assert.equal(r.categories.current[0].position, null);
    assert.equal(r.categories.current[0].categoryId, '904');
    assert.equal(r.categories.preservedMagentoOnly[0].action, 'preserve_by_safe_preview');
    assert.equal(r.candidatePayload.product.extension_attributes, undefined);
    assert.ok(has(r, 'CATEGORY_NATIVE_PAYLOAD_UNRESOLVED')); assert.equal(r.sendable, false);
  }
  for (const position of ['-183', 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => currentAssignments({ extension_attributes: { category_links: [{ category_id: '901', position }] } }),
      { code: 'MAGENTO_PREVIEW_CATEGORIES_INVALID' });
  }
  assert.throws(() => currentAssignments({ extension_attributes: { category_links: [{ category_id: '-1', position: -183 }] } }),
    { code: 'MAGENTO_PREVIEW_CATEGORIES_INVALID' });
});
test('differing names preserve remote value without approved ownership; approved policy permits change', () => {
  const f = fixture(); f.raw.name = 'Maintained name';
  const r = run(f); assert.equal(r.candidatePayload.product.name, undefined); assert.ok(has(r, 'ownership_review_required'));
  assert.equal(r.diff.find((d) => d.target === 'name').evaluated, 'Fixture name');
  const a = fixture({ approved: true }); a.raw.name = 'Maintained name';
  assert.equal(run(a).candidatePayload.product.name, 'Fixture name');
});
test('numeric comparisons distinguish exact, formatting, legacy integer rounding and semantic changes', () => {
  assert.equal(comparison('12.50', '12.50'), 'exact');
  assert.equal(comparison('12.50', '12,5'), 'numeric_equivalent_formatting');
  assert.equal(comparison('12.6', '13'), 'rounded_legacy_value');
  assert.equal(comparison('12.6', '14'), 'semantic_difference');
});

function systemFixture(group, answers = {}) {
  const compiled = compileDefinition(materializeMagentoV1(catalog()));
  const mapper = describeMapper(compiled.definition);
  const attributes = mapper.targets.filter((t) => !CSV_FIELDS.has(t.target)).map((t, i) => ({ attribute_id: 10 + i,
    attribute_code: t.target, frontend_input: t.usages.some((u) => u.values.some((v) => v.kind === 'dictionary')) ? 'select' : 'text',
    options: [...new Set(t.usages.flatMap((u) => u.values.map((v) => v.label)))].filter(Boolean)
      .map((label, j) => ({ value: String(j + 1000), label, isEmpty: false })) }));
  const schema = { storeCode: 'all', attributes, attributeSets: mapper.attributeSets.map((s, i) => ({
    attribute_set_id: 600 + i, attribute_set_name: s.attribute_set_code, attributeCodes: attributes.map((a) => a.attribute_code) })),
  storeTopology: { websites: [], storeGroups: [], storeViews: [] } };
  const amber = { compiled, template: { kind: 'system' }, observedAt: now(), revision: null,
    product: product(group, answers, { status: 'active', magento_name_subject_ua: 'Sample', magento_name_subject_en: 'Sample' }) };
  const base = evaluate(amber, amber.product).base;
  const raw = { id: 12, sku: amber.product.full_sku, attribute_set_id: schema.attributeSets.find((s) => s.attribute_set_name === base.attribute_set_code)?.attribute_set_id || 600,
    name: base.name, price: 42, type_id: 'simple', status: 1, visibility: 4, custom_attributes: [], extension_attributes: { category_links: [] } };
  return { amber, schema, raw };
}
test('CH reversed legacy dimensions are a diff; evaluator semantics and valid size text remain the payload', () => {
  const f = systemFixture('CH', { bead_length: '12.5', bead_width: '8.2', rosary_length: '32' });
  f.raw.custom_attributes = [{ attribute_code: 'dovzhyna_namystyny', value: '8.2' },
    { attribute_code: 'diametr_namystyny', value: '12.5' }, { attribute_code: 'rozmir_kameniu', value: '=12.5*8.2' }];
  const r = run(f);
  assert.equal(custom(r, 'dovzhyna_namystyny'), '12.5'); assert.equal(custom(r, 'diametr_namystyny'), '8.2');
  assert.equal(custom(r, 'rozmir_kameniu'), '12.5×8.2');
  assert.equal(r.diff.find((d) => d.target === 'dovzhyna_namystyny').compatibility, 'legacy_remote_mismatch');
  assert.ok(r.warnings.some((w) => w.code === 'LEGACY_REMOTE_DIMENSIONS_REVERSED'));
});

test('CH.texture=8 reviewed dictionary refusal still blocks emission if a product later uses it', () => {
  const f = systemFixture('CH', { texture: 8, bead_length: '12.5', bead_width: '8.2', rosary_length: '32' });
  const bindings = require('../src/services/magento/binding-bootstrap').buildCandidates({
    ...f.amber, products: [], current: [],
  }, f.schema, [], { group: 'CH' });
  const refusal = bindings.options.find((o) => o.questionKey === 'texture' && o.valueId === '8');
  Object.assign(refusal, { reviewState: 'blocked', evidence: { note: 'Dictionary-only refusal' } });
  f.amber.revision = { schema: f.schema, schemaFingerprint: hash(f.schema),
    topologyFingerprint: hash(f.schema.storeTopology), bindings };
  const r = run(f);
  assert.equal(r.sendable, false);
  assert.ok(r.blockers.some((b) => b.code === 'MAPPING_EXPLICITLY_BLOCKED' && b.target === 'faktura_namystyn'));
  assert.equal(custom(r, 'faktura_namystyn'), undefined);
});

test('AR glass empty-source fallback and glass=1 require separate exact approvals; unknown glass stays blocked', () => {
  for (const glass of [undefined, 1, 9]) {
    const f = systemFixture('AR', { glass });
    const bindings = require('../src/services/magento/binding-bootstrap').buildCandidates({ ...f.amber,
      products: [], current: [] }, f.schema, [], { group: 'AR' });
    const attribute = bindings.attributes.find((a) => a.target === 'sklo');
    attribute.reviewState = 'approved';
    const options = bindings.options.filter((o) => o.bindingKey === attribute.bindingKey);
    options.forEach((o) => { o.reviewState = 'approved'; });
    f.amber.revision = { schema: f.schema, schemaFingerprint: hash(f.schema),
      topologyFingerprint: hash(f.schema.storeTopology), bindings };
    const r = run(f);
    if (glass === 9) {
      assert.equal(r.sendable, false); assert.equal(r.evaluation.ready, false);
      assert.equal(custom(r, 'sklo'), undefined);
    } else {
      const expected = options.find((o) => o.evaluatedOutput === (glass === 1 ? 'Зі склом' : 'Без скла'));
      assert.equal(custom(r, 'sklo'), expected.optionId);
      expected.reviewState = 'blocked';
      const blocked = run(f);
      assert.ok(blocked.blockers.some((b) => b.code === 'MAPPING_EXPLICITLY_BLOCKED' && b.target === 'sklo'));
      assert.equal(custom(blocked, 'sklo'), undefined);
    }
  }
});
test('AR size 28 has no invented option; unused 29–31 also fail closed; AR maintained name is preserved', () => {
  for (const size of [28, 29, 30, 31]) {
    const f = systemFixture('AR', { size });
    f.schema.attributes.find((a) => a.attribute_code === 'rozmir_kartyny').options = [];
    f.raw.name = 'Maintained AR name'; const r = run(f);
    assert.equal(r.sendable, false); assert.equal(custom(r, 'rozmir_kartyny'), undefined);
    assert.ok(has(r, size === 28 ? 'OPTION_UNRESOLVED' : 'PRODUCT_EVALUATION_NOT_READY'));
    assert.equal(r.candidatePayload.product.name, undefined);
    if (size === 28) assert.equal(field(r, 'rozmir_kartyny').evaluatedValue, '15×15');
  }
});
test('SV literal question 2 resolves only its exact reviewed identity and explicit set override preserves evaluator semantics', () => {
  for (const souvenir of [1, 5]) {
    const f = systemFixture('SV', { souvenir, statuette: 1, '2': 2, bird: 4, weight: '12', size: '3/4' });
    const bindings = require('../src/services/magento/binding-bootstrap').buildCandidates({ ...f.amber,
      products: [], current: [] }, f.schema, [], { group: 'SV' });
    const set = f.schema.attributeSets.find((s) => s.attribute_set_name === 'Сувеніри');
    bindings.routes.filter((r) => r.enabled).forEach((r) => { r.setId = set.attribute_set_id; r.reviewState = 'approved'; });
    const attribute = bindings.attributes.find((a) => a.target === 'tematyka_vyrobu'
      && a.routeKey === `SV.souvenir${souvenir === 5 ? '=' : '!='}value_id:5`);
    attribute.reviewState = 'approved';
    const option = bindings.options.find((o) => o.bindingKey === attribute.bindingKey && o.valueId === '2');
    assert.equal(option.sourceKey, 'SV.2=value_id:2'); option.reviewState = 'approved';
    f.amber.revision = { schema: f.schema, schemaFingerprint: hash(f.schema), topologyFingerprint: hash(f.schema.storeTopology), bindings };
    const r = run(f);
    assert.equal(custom(r, 'tematyka_vyrobu'), option.optionId);
    assert.equal(r.candidatePayload.product.attribute_set_id, set.attribute_set_id);
    assert.equal(evaluate(f.amber, f.amber.product).base.attribute_set_code, souvenir === 5 ? 'Камінь' : 'Сувеніри');
    option.reviewState = 'blocked';
    assert.equal(custom(run(f), 'tematyka_vyrobu'), undefined);
  }
});

test('KL typo evidence stays candidate-only and SV compatibility statistics never choose a route', () => {
  const f = systemFixture('KL', { addit: 1 });
  f.schema.attributes.find((a) => a.attribute_code === 'kulony_dodatkovo').options = [{ value: '6047', label: 'Інзклюз', isEmpty: false }];
  const r = run(f); assert.equal(custom(r, 'kulony_dodatkovo'), '6047');
  assert.equal(field(r, 'kulony_dodatkovo').authority, 'candidate_only'); assert.ok(has(r, 'OPTION_BINDING_REVIEW_REQUIRED'));
  const sv = systemFixture('SV', { souvenir: 5 }); const report = run(sv);
  assert.equal(report.attributeSet.compatibilityEvidence.usedToSelectSet, false);
  assert.equal(report.attributeSet.status, 'candidate_only'); assert.notEqual(report.attributeSet.selected.id, 151);
});
test('cohesive network pipeline uses real GET-only client and exact SKU query for UPDATE and CREATE', async () => {
  for (const exists of [true, false]) {
    const f = fixture(); const calls = [];
    const r = await previewProduct(config, { readAmber: async () => f.amber, discover: async () => f.schema, now,
      fetchImpl: async (url, request) => {
        assert.equal(request.method, 'GET'); assert.equal(request.body, undefined);
        const u = new URL(url); calls.push(u.pathname);
        let response;
        if (u.pathname.endsWith('/products')) {
          assert.equal(u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'), f.amber.product.full_sku);
          assert.equal(u.searchParams.get('searchCriteria[filter_groups][0][filters][0][condition_type]'), 'eq');
          response = { total_count: exists ? 1 : 0, items: exists ? [f.raw] : [] };
        } else if (u.pathname.includes('/inventory/')) {
          response = u.pathname.includes('/stock-resolver/') ? { stock_id: 1, extension_attributes: { sales_channels: [{ type: 'website', code: 'base' }] } }
            : u.pathname.includes('/source-items') ? { items: [], total_count: 0 } : [{ source_code: 'default', enabled: true }];
        } else {
          assert.equal(u.pathname, '/rest/all/V1/categories'); assert.equal(u.searchParams.get('rootCategoryId'), '803');
          response = { id: 803, name: 'Default', parent_id: 1, children_data: [] };
        }
        return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
      } });
    assert.equal(r.mode, exists ? 'update' : 'create'); assert.equal(calls.length, exists ? 6 : 5);
  }
});
test('full discovery-to-payload pipeline performs only named GETs, and denied category reads retain the product preview', async () => {
  for (const categoryDenied of [false, true]) {
    const f = fixture(); const calls = [];
    const r = await previewProduct(config, { readAmber: async () => f.amber, now, fetchImpl: async (url, request) => {
      assert.equal(request.method, 'GET'); assert.equal(request.body, undefined);
      const u = new URL(url); const route = u.pathname.split('/V1/')[1]; calls.push(route);
      const routes = {
        'store/websites': f.schema.storeTopology.websites, 'store/storeGroups': f.schema.storeTopology.storeGroups,
        'store/storeViews': f.schema.storeTopology.storeViews,
        'products/attribute-sets/sets/list': { total_count: 1, items: f.schema.attributeSets },
        'products/attribute-sets/8001/attributes': f.schema.attributes,
        'products/attributes': { total_count: f.schema.attributes.length, items: f.schema.attributes },
        products: { total_count: 1, items: [f.raw] },
        'inventory/stock-resolver/website/base': { stock_id: 1, extension_attributes: { sales_channels: [{ type: 'website', code: 'base' }] } },
        'inventory/get-sources-assigned-to-stock-ordered-by-priority/1': [{ source_code: 'default', enabled: true }],
        'inventory/source-items': { items: [], total_count: 0 },
        categories: { id: 803, name: 'Default', parent_id: 1, children_data: [] },
      };
      for (const a of f.schema.attributes) routes[`products/attributes/${a.attribute_code}/options`] = a.options;
      assert.ok(Object.hasOwn(routes, route), route);
      return new Response(JSON.stringify(routes[route]), { status: categoryDenied && route === 'categories' ? 403 : 200,
        headers: { 'content-type': 'application/json' } });
    } });
    assert.equal(r.mode, 'update'); assert.equal(custom(r, 'kolir'), 'red-id');
    assert.ok(calls.includes('products/attributes/kolir/options'));
    assert.equal(calls.filter((c) => c === 'products').length, 2);
    assert.equal(has(r, 'CATEGORY_TREE_UNAVAILABLE'), categoryDenied);
    assert.equal(r.sendability.blockers, r.blockers);
  }
});
test('disabled draft routes still show downstream candidates without silently approving the route', () => {
  const f = fixture({ approved: true });
  const route = f.amber.revision.bindings.routes.find((r) => r.enabled);
  route.enabled = false; route.reviewState = 'review_required'; route.setId = null;
  const r = run(f);
  assert.equal(r.attributeSet.status, 'blocked'); assert.equal(r.sendable, false);
  assert.equal(field(r, 'kolir').magentoOptionId, 'red-id');
});
test('approved ownership preserves managed fields and booleans use live native option values', () => {
  const f = fixture({ approved: true });
  const name = f.amber.revision.bindings.attributes.find((a) => a.target === 'name' && a.rowId === 'base');
  f.amber.revision.bindings.policies.find((p) => p.bindingKey === name.bindingKey).policy = 'magento_managed';
  f.raw.name = 'Remote'; assert.equal(run(f).candidatePayload.product.name, undefined);
  const b = systemFixture('BR');
  const boolean = b.schema.attributes.find((a) => a.attribute_code === 'is_ownproduction');
  boolean.frontend_input = 'boolean'; boolean.options = [{ value: '1', label: 'Yes' }, { value: '0', label: 'No' }];
  const r = run(b);
  assert.equal(custom(r, 'is_ownproduction'), '1'); assert.equal(field(r, 'is_ownproduction').strategy, 'transport_control');
  assert.equal(field(r, 'is_ownproduction').magentoOptionId, '1');
});
test('required attributes respect live apply_to, while simple, universal and unknown requirements fail closed', () => {
  const f = fixture();
  const domains = { links_purchased_separately: ['downloadable'], links_title: ['downloadable'], samples_title: ['downloadable'],
    price_type: ['bundle'], price_view: ['bundle'], shipment_type: ['bundle'], other_type_specific: ['virtual'],
    required_simple: ['simple'], required_all: [], required_unknown: undefined };
  for (const [attribute_code, apply_to] of Object.entries(domains)) {
    f.schema.attributes.push({ attribute_code, attribute_id: 2000 + f.schema.attributes.length,
      frontend_input: null, is_required: true, ...(apply_to ? { apply_to } : {}) });
    f.schema.attributeSets[0].attributeCodes.push(attribute_code);
  }
  for (const raw of [f.raw, null]) {
    const r = run(f, raw);
    assert.deepEqual(r.blockers.filter((b) => b.code === 'REQUIRED_ATTRIBUTE_VALUE_MISSING').map((b) => b.target),
      ['required_simple', 'required_all', 'required_unknown']);
    assert.equal(r.requiredAttributes.find((a) => a.attributeCode === 'price_type').applicability, 'not_applicable');
  }
});
test('fixed controls translate standard Boolean source IDs regardless of localized labels, without semantic bindings', () => {
  for (const frontend_input of ['boolean', 'select']) {
    const f = systemFixture('KL', { addit: 1 });
    for (const [code, value] of [['old_product', '0'], ['is_ownproduction', '1']]) {
      Object.assign(f.schema.attributes.find((a) => a.attribute_code === code), { frontend_input,
        source_model: 'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Boolean',
        options: [{ value: '0', label: 'Ні' }, { value: '1', label: 'Так' }] });
      f.raw.custom_attributes.push({ attribute_code: code, value });
    }
    const r = run(f);
    for (const [code, value] of [['old_product', '0'], ['is_ownproduction', '1']]) {
      assert.equal(custom(r, code), value);
      assert.equal(field(r, code).authority, 'scalar');
      assert.equal(field(r, code).strategy, 'transport_control');
      assert.equal(field(r, code).optionDecision, null);
      assert.equal(r.diff.find((d) => d.target === code).comparison, 'exact');
      assert.deepEqual(r.blockers.filter((b) => b.target === code), []);
    }
    assert.equal(field(r, 'kulony_dodatkovo').authority, 'candidate_only');
    assert.ok(r.blockers.some((b) => b.code === 'OPTION_BINDING_REVIEW_REQUIRED' && b.target === 'kulony_dodatkovo'));
    f.schema.attributes.find((a) => a.attribute_code === 'old_product').options = [];
    assert.ok(has(run(f), 'NATIVE_BOOLEAN_VALUE_UNRESOLVED'));
    f.schema.attributes.find((a) => a.attribute_code === 'is_ownproduction').source_model = 'CustomSource';
    assert.equal(custom(run(f), 'is_ownproduction'), undefined);
  }
});
test('operation sendability isolates category and deferred transport blockers from the approved core payload', () => {
  const r = run(fixture({ approved: true }));
  assert.deepEqual(r.sendability.operations.coreProduct.blockers, []);
  assert.equal(r.sendability.operations.coreProduct.sendable, true);
  assert.equal(r.sendable, false); assert.equal(r.sendability.overall.sendable, false);
  assert.equal(r.sendability.operations.websites.sendable, true);
  for (const domain of ['categories', 'inventory', 'storeViews']) {
    assert.equal(r.sendability.operations[domain].sendable, false);
    assert.ok(r.sendability.operations[domain].blockers.every((b) => b.operation === domain));
  }
  assert.equal(r.sendability.operations.coreProduct.candidatePayload.product.extension_attributes, undefined);
  assert.ok(r.sendability.operations.categories.candidateLinks.length);
  const candidate = run(fixture());
  assert.equal(candidate.sendability.operations.coreProduct.sendable, false);
  assert.ok(candidate.sendability.operations.coreProduct.blockers.some((b) => b.code === 'OPTION_BINDING_REVIEW_REQUIRED'));
});
test('exact-SKU UPDATE separates prior exposure from sync eligibility without changing legacy state', () => {
  const f = fixture({ approved: true });
  f.amber.product.exclude_from_export = 1;
  f.amber.product.exportState = { route: 'hold', hold_reason: 'prior_exposure', source_correction_id: null,
    business_exclusion_state: 'unknown', recount_compatibility_excluded: false };
  const before = structuredClone(f.amber.product);
  const r = run(f);
  assert.equal(r.syncEligibility.eligible, true);
  assert.equal(r.syncEligibility.reasonCode, 'EXACT_SKU_UPDATE_PRIOR_EXPOSURE_ALLOWED');
  assert.equal(r.syncEligibility.legacyExport.priorExposureIgnoredForUpdate, true);
  assert.equal(r.sendability.operations.coreProduct.sendable, true);
  assert.deepEqual(f.amber.product, before);
  assert.equal(run(f, null).syncEligibility.eligible, false, 'CREATE cannot use the UPDATE exception');
  assert.equal(run(f, { ...f.raw, sku: 'other' }).syncEligibility.eligible, false);
});

test('real exclusions and unresolved lifecycle states still block all sync operations, even with prior exposure', () => {
  const cases = [
    [{ status: 'archived' }, {}, 'products.status = archived'],
    [{ status: 'corrected' }, {}, 'products.status = corrected'],
    [{ corrected_to_product_id: 99 }, {}, 'products.corrected_to_product_id IS NOT NULL'],
    [{}, { route: 'retired' }, 'product_full_export_state.route = retired'],
    [{ exclude_from_export: 0 }, { business_exclusion_state: 'excluded' }, 'product_full_export_state.business_exclusion_state = excluded'],
    [{}, { hold_reason: 'intentional_exclusion' }, 'product_full_export_state.hold_reason = intentional_exclusion'],
    [{}, { independentExclusion: true }, 'product_full_export_state.evidence.independentExclusion = true'],
    [{}, { recount_compatibility_excluded: true }, 'product_full_export_state.recount_compatibility_excluded = true'],
    [{}, { hold_reason: 'invalid_lineage' }, 'hold_reason = invalid_lineage'],
    [{}, { hold_reason: 'historical_ambiguity' }, 'hold_reason = historical_ambiguity'],
    [{}, { route: 'normal', hold_reason: null }, 'business_exclusion_state = unknown'],
  ];
  for (const [product, state, rule] of cases) {
    const f = fixture({ approved: true });
    Object.assign(f.amber.product, { exclude_from_export: 1, ...product, exportState: {
      route: 'hold', hold_reason: 'prior_exposure', business_exclusion_state: 'unknown',
      recount_compatibility_excluded: false, ...state } });
    const r = run(f);
    assert.equal(r.syncEligibility.eligible, false, rule);
    assert.ok(r.syncEligibility.reasons.some((r) => r.rule.includes(rule)), rule);
    assert.ok(Object.values(r.sendability.operations).every((op) => !op.sendable));
  }
  const f = fixture({ approved: true });
  f.amber.product.exclude_from_export = 1;
  assert.equal(run(f).syncEligibility.eligible, false, 'untyped exclusion cannot be discarded');
});
test('CLI requires one selection, has no apply flag, help is offline and prints a compact report', async () => {
  for (const args of [[], ['--sku', 'a', '--product-id', '1'], ['--product-id', '0'], ['--product-id', '1e2'],
    ['--sku', 'a', '--apply'], ['--sku', 'a', '--sku', 'b']]) assert.throws(() => parseArguments(args));
  assert.equal(parseArguments(['--product-id', '17']).productId, 17);
  let called = false;
  assert.equal(await runSyncPreview({ args: ['--help'], env: {}, preview: () => { called = true; }, print: () => {} }), 0);
  assert.equal(called, false);
  const r = run(fixture()); const logs = [];
  assert.equal(await runSyncPreview({ args: ['--sku', r.amberProduct.sku], env, databasePool: {},
    preview: async () => r, write: async (output, report) => { assert.equal(output, artifactPath(r)); assert.equal(report, r); },
    print: (message) => logs.push(message) }), 0);
  assert.match(logs.join(''), /UPDATE/); assert.match(logs.join(''), /SENDABLE NO/); assert.match(logs.join(''), /BLOCKER/);
});
test('artifact writer never overwrites and reflected credentials never reach artifact or output', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-sync-preview-'));
  const file = path.join(dir, 'preview.json');
  try {
    await writeArtifact(file, { original: true });
    await assert.rejects(writeArtifact(file, { original: false }), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { original: true });
  } finally { await fs.unlink(file); await fs.rmdir(dir); }
  const r = run(fixture()); r.attributes[0].evaluatedValue = env.MAGENTO_ACCESS_TOKEN;
  let written = false; const logs = [];
  assert.equal(await runSyncPreview({ args: ['--sku', 'X'], env, databasePool: {}, preview: async () => r,
    write: async () => { written = true; }, print: (v) => logs.push(v) }), 1);
  assert.equal(written, false); assert.ok(!logs.join('').includes(env.MAGENTO_ACCESS_TOKEN));
});
