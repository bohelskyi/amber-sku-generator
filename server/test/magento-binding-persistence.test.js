const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBindings, validateBindings, requirements, stableRoute, bindingKey } = require('../src/services/magento/binding-validation');
const { hash, originHash, normalizeSchema, safeData } = require('../src/services/magento/binding-contract');
const { compareSchema } = require('../src/services/magento/binding-drift');
const { schema, definition, approvedBindings } = require('./fixtures/magento-bindings');
const valid = (b, publish = true) => validateBindings(normalizeBindings(b), definition(), schema(), { publish });
test('binding: complete synthetic scope covers semantic, dynamic, numeric, scalar and transport identities', () => {
  const result = valid(approvedBindings()); assert.deepEqual(result.diagnostics, []);
  const b = normalizeBindings(approvedBindings());
  const semantic = b.options.find((o) => o.valueId === '7');
  assert.equal(semantic.valueId, '7'); assert.equal(semantic.skuCodeEvidence, '91'); assert.equal(semantic.optionId, 'red-id');
  assert.match(semantic.sourceKey, /value_id:7$/); assert.ok(!semantic.sourceKey.includes('91'));
  assert.deepEqual(new Set(b.attributes.map((a) => a.strategy)), new Set(['scalar','semantic_option','dynamic_exact_label_option','numeric_band_option','transport_control']));
});
test('binding: explicit semantic many-to-one preserves provenance and requires evaluator proof', () => {
  const b = approvedBindings(); const semantic = b.options.filter((o) => o.optionId === 'red-id');
  assert.deepEqual(semantic.map((o) => o.valueId).sort(), ['7', '9']);
  assert.ok(semantic.every((o) => o.evaluatedOutput === 'Red output'));
  assert.equal(valid(b).valid, true);
  const conflicting = structuredClone(b); conflicting.options.push({ ...semantic[0], optionId: 'blue-id' });
  assert.throws(() => normalizeBindings(conflicting), { code: 'MAGENTO_BINDING_INVALID' });
  const invented = structuredClone(b); invented.options.find((o) => o.valueId === '8').evaluatedOutput = 'Red output';
  invented.options.find((o) => o.valueId === '8').optionId = 'red-id';
  assert.ok(valid(invented).diagnostics.some((d) => d.code === 'OPTION_SOURCE_INVALID'));
  const divergent = structuredClone(b); divergent.options.find((o) => o.valueId === '9').optionId = 'blue-id';
  assert.throws(() => normalizeBindings(divergent), { code: 'MAGENTO_BINDING_INVALID' });
});
test('binding: semantic IDs, dynamic domains, unknown fields and duplicate identities fail closed', () => {
  for (const alter of [
    (b) => { delete b.options.find((o) => o.sourceKind === 'semantic').valueId; },
    (b) => { b.options[0].sku_code = '7'; },
    (b) => { b.options.find((o) => o.sourceKind === 'evaluated').valueId = '7'; },
    (b) => { b.options.push(structuredClone(b.options[0])); },
    (b) => { b.routes.push(structuredClone(b.routes[0])); },
    (b) => { const o = b.options.filter((o) => o.sourceKind === 'semantic'); o[1].optionId = o[0].optionId; },
    (b) => { b.attributes.find((a) => a.strategy === 'transport_control').attributeCode = 'name'; },
  ]) { const b = approvedBindings(); alter(b); assert.throws(() => normalizeBindings(b), { code: 'MAGENTO_BINDING_INVALID' }); }
  const b = approvedBindings(); b.options.find((o) => o.sourceKind === 'semantic').valueId = '91'; assert.equal(valid(b).valid, false);
  const dynamic = approvedBindings(); dynamic.options.find((o) => o.domainKey).domainKey = 'a'.repeat(64);
  assert.ok(valid(dynamic).diagnostics.some((d) => d.code === 'OPTION_SOURCE_INVALID'));
});
test('binding: missing and review-required mappings or policies cannot publish by omission or candidate label', () => {
  for (const alter of [
    (b) => { b.routes[0].reviewState = 'review_required'; },
    (b) => { b.options[0].reviewState = 'proposed'; },
    (b) => { b.options[0].reviewState = 'review_required'; b.options[0].optionId = null; },
    (b) => { b.options.shift(); },
    (b) => { b.policies = []; },
    (b) => { b.policies[0].storeCode = 'unknown_view'; },
  ]) { const b = approvedBindings(); alter(b); assert.equal(valid(b).valid, false); }
  const b = approvedBindings(); b.options[0].optionId = 'Remote red'; assert.equal(valid(b).valid, false);
  const omitted = approvedBindings(); const key = requirements(definition(), schema())[0].attributes[0].bindingKey;
  omitted.attributes.shift(); omitted.options = omitted.options.filter((o) => o.bindingKey !== key); omitted.policies = omitted.policies.filter((p) => p.bindingKey !== key);
  assert.ok(valid(omitted).diagnostics.some((d) => d.code === 'ATTRIBUTE_BINDING_REQUIRED'));
});
test('binding: explicit blocked decisions publish; review-required decisions and invented sources do not', () => {
  for (const alter of [
    (b) => { Object.assign(b.options[0], { optionId: null, reviewState: 'blocked' }); },
    (b) => { Object.assign(b.policies[0], { policy: 'blocked', reviewState: 'blocked' }); },
    (b) => { b.attributes[0].reviewState = 'blocked'; b.policies = b.policies.filter((p) => p.bindingKey !== bindingKey(b.attributes[0].routeKey, b.attributes[0].rowId, b.attributes[0].target)); },
    (b) => { Object.assign(b.routes[0], { reviewState: 'blocked', setId: null }); b.attributes = []; b.options = []; b.policies = []; },
    (b) => { b.options.push({ ...b.options.find((o) => o.sourceKind === 'semantic'), valueId: '29', evaluatedOutput: null, optionId: null, reviewState: 'blocked' }); },
  ]) { const b = approvedBindings(); alter(b); assert.deepEqual(valid(b).diagnostics, []); }
  const unknown = approvedBindings(); unknown.options.push({ ...unknown.options.find((o) => o.sourceKind === 'semantic'),
    questionKey: 'invented_source', valueId: '29', evaluatedOutput: null, optionId: null, reviewState: 'blocked' });
  assert.ok(valid(unknown).diagnostics.some((d) => d.code === 'OPTION_SOURCE_INVALID'));
  const policy = approvedBindings(); policy.policies[0].policy = 'blocked';
  assert.ok(valid(policy).diagnostics.some((d) => d.code === 'FIELD_POLICY_STATE_INVALID'));
});
test('binding: unresolved unenumerated semantic values are representable but never publish for enabled scope', () => {
  const b = approvedBindings(); Object.assign(b.options.find((o) => o.sourceKind === 'semantic'), { valueId: '29', evaluatedOutput: null, optionId: null, reviewState: 'review_required' });
  assert.equal(valid(b, false).valid, true); assert.equal(valid(b).valid, false);
});
test('binding: renaming and mixed semantic domains remain fail-closed, distinct from many-to-one', () => {
  const renamed = approvedBindings(); renamed.attributes.find((a) => a.target === 'kolir').attributeCode = 'decor_weight';
  // The duplicate destination is rejected before any target renaming can be approved.
  assert.throws(() => normalizeBindings(renamed), { code: 'MAGENTO_BINDING_INVALID' });
  const d = structuredClone(definition()); const cell = d.groups[0].rows[0].cells.kolir;
  cell.otherwise = { op: 'literal', value: 'Unproven semantic output' };
  const b = normalizeBindings(approvedBindings());
  assert.ok(validateBindings(b, d, schema(), { publish: true }).diagnostics.some((v) => v.code === 'SEMANTIC_OUTPUT_DOMAIN_UNRESOLVED'));
});
test('binding: stable semantic routes ignore audit index and historical CSV output names', () => {
  const plan = { id: 'SV:5', amberGroup: 'SV', attributeSetName: 'old', predicates: [{ sourceId: 'SV.souvenir', key: 'souvenir', value: '5', equal: true }] };
  assert.equal(stableRoute(plan).routeKey, 'SV.souvenir=value_id:5');
  assert.deepEqual(stableRoute(plan), stableRoute({ ...plan, id: 'SV:99', attributeSetName: 'new' }));
  const second = { sourceId: 'SV.type', key: 'type', value: '2', equal: false };
  assert.deepEqual(stableRoute({ ...plan, predicates: [...plan.predicates, second] }), stableRoute({ ...plan, predicates: [second, ...plan.predicates] }));
  const d = structuredClone(definition()); const original = requirements(d, schema()); d.groups.reverse();
  assert.deepEqual(requirements(d, schema()).map((r) => r.routeKey).sort(), original.map((r) => r.routeKey).sort());
  const br = original.find((r) => r.amberGroup === 'BR');
  assert.equal(br.evaluatorSetName, 'Historical CSV name');
  assert.notEqual(br.evaluatorSetName, schema().attributeSets[0].attribute_set_name);
  assert.throws(() => stableRoute({ ...plan, analysis: 'runtime_evaluation_required' }));
});
test('binding: drift retains option identity on label change and detects missing sets, attributes, options and topology', () => {
  const s = schema(); const b = normalizeBindings(approvedBindings());
  const revision = { id: 'fixture', revision: '3', bindings: b, schema: s, schemaFingerprint: hash(s), topologyFingerprint: hash(s.storeTopology) };
  assert.equal(compareSchema(revision, s).drifted, false);
  const next = structuredClone(s); next.attributes.find((a) => a.attribute_code === 'kolir').options[0].label = 'Renamed';
  next.attributes.find((a) => a.attribute_code === 'kolir').default_frontend_label = 'Renamed attribute';
  next.attributes.find((a) => a.attribute_code === 'decor_weight').options = [];
  next.attributeSets[0].attributeCodes = next.attributeSets[0].attributeCodes.filter((c) => c !== 'name' && c !== 'price');
  next.attributes = next.attributes.filter((a) => a.attribute_code !== 'price');
  next.storeTopology.storeViews[0].name = 'New view name';
  const result = compareSchema(revision, next); const codes = result.diagnostics.map((d) => d.code);
  for (const code of ['SCHEMA_FINGERPRINT_CHANGED','STORE_TOPOLOGY_CHANGED','ATTRIBUTE_LABEL_CHANGED','OPTION_ID_LABEL_CHANGED','OPTION_ID_MISSING','ATTRIBUTE_MISSING','ATTRIBUTE_NOT_IN_EXPECTED_SET']) assert.ok(codes.includes(code), code);
  assert.equal(result.diagnostics.find((d) => d.code === 'OPTION_ID_LABEL_CHANGED').identityUnchanged, true);
  assert.deepEqual(revision.schema, s);
  assert.equal(result.diagnostics.find((d) => d.code === 'OPTION_ID_MISSING').severity, 'missing_identity');
  next.attributes.find((a) => a.attribute_code === 'kolir').attribute_id = 9999;
  const replaced = compareSchema(revision, next);
  assert.ok(replaced.diagnostics.some((d) => d.code === 'ATTRIBUTE_ID_CHANGED'));
  assert.ok(!replaced.diagnostics.some((d) => d.code === 'OPTION_ID_LABEL_CHANGED'));
  next.attributeSets = []; assert.ok(compareSchema(revision, next).diagnostics.some((d) => d.code === 'ATTRIBUTE_SET_MISSING'));
});
test('binding: observation hashes ignore ordering and credentials are rejected before persistence', () => {
  const s = schema(); const reordered = structuredClone(s); reordered.attributes.reverse(); reordered.attributeSets[0].attributeCodes.reverse();
  assert.equal(hash(normalizeSchema(s)), hash(normalizeSchema(reordered)));
  assert.equal(originHash('https://fixture.example.invalid/'), originHash('https://fixture.example.invalid'));
  assert.throws(() => originHash('https://user:password@example.invalid'));
  assert.throws(() => safeData({ note: 'synthetic-credential' }, ['synthetic-credential']));
  assert.throws(() => safeData({ consumerSecret: 'never store' }));
});
