const test = require('node:test');
const assert = require('node:assert/strict');
const { ruleProof, stableReviewedSource } = require('../src/services/magento/integration-successor');
const { carryReviewedBindings } = require('../src/services/magento/binding-carry-forward');
const { fixture } = require('./fixtures/magento-successor');

test('successor carry requires unchanged expression and transitive source/table proof', () => {
  const definition = { sources: { color: { kind: 'semantic', category: 'XX', key: 'color' } },
    questionContracts: {}, tables: { labels: { 8: 'Скриньки' } },
    bindings: [{ id: 'mapped', group: 'XX', value: { op: 'lookup', input: { op: 'source', id: 'color' }, table: 'labels' } }],
    groups: [{ route: 'XX', rows: [{ id: 'base', cells: { suveniry: { op: 'ref', id: 'mapped' }, name: { op: 'literal', value: 'Old' } } }] }] };
  const revision = { bindings: { routes: [], attributes: [{ routeKey: 'XX:default', rowId: 'base', target: 'suveniry', bindingKey: 'k', reviewState: 'approved', evidence: {} }],
    options: [{ bindingKey: 'k', reviewState: 'approved' }], policies: [{ bindingKey: 'k', reviewState: 'approved' }] } };
  const original = structuredClone(revision);
  const unrelated = structuredClone(definition); unrelated.groups[0].rows[0].cells.name.value = 'New';
  assert.equal(stableReviewedSource(revision, definition, unrelated).bindings.attributes[0].reviewState, 'approved');
  const changed = structuredClone(definition); changed.tables.labels[8] = 'Лампа';
  const result = stableReviewedSource(revision, definition, changed);
  for (const kind of ['attributes', 'options', 'policies']) assert.equal(result.bindings[kind][0].reviewState, 'review_required');
  assert.deepEqual(revision, original);
  changed.sources.color.key = 'other';
  assert.equal(stableReviewedSource(revision, definition, changed).bindings.attributes[0].reviewState, 'review_required');
});

test('fixed-column and editable-column size changes affect only the size proof, including route publication proof', () => {
  const { old, next } = fixture();
  const { upgradeColumns } = require('../src/services/export-templates/column-contract');
  for (const [before, after] of [[old, next], [upgradeColumns(old), upgradeColumns(next)]]) {
    const changed = [];
    for (const group of before.groups) for (const row of group.rows) for (const target of Object.keys(row.cells)) {
      if (ruleProof(before, group.route, row.id, target) !== ruleProof(after, group.route, row.id, target)) {
        changed.push(`${group.route}/${row.id}/${target}`);
      }
    }
    assert.deepEqual(changed, ['SV/base/rozmir_suveniriv']);
  }
});

test('decision proofs include scoped sources, captured rules, source support, row scope and unknown checks', () => {
  const { old } = fixture();
  const proof = (d, target = 'kolir', row = 'base', group = 'SV') => ruleProof(d, group, row, target);
  const change = mutate => { const d = structuredClone(old); mutate(d); return d; };
  for (const mutate of [
    d => { d.evaluatorVersion = 'magento-declarative-4'; },
    d => { d.sourceContractVersion = 'incompatible'; },
    d => { d.outputContract = 'magento-products-columns-v2'; },
    d => { d.sources['SV.color'].key = 'different_color'; },
    d => { d.questionContracts['SV.color'].required = true; },
    d => { d.questionContracts['SV.color'].allowed.push('99'); },
    d => { d.questionContracts['SV.color'].rule = { 'SV.souvenir': [6] }; },
    d => { d.groups.find(g => g.route === 'SV').rows[0].cells.store_view_code.value = 'uk'; },
    d => { d.groups.find(g => g.route === 'SV').rows[0].cells.product_type.value = 'virtual'; },
    d => { d.groups.find(g => g.route === 'SV').evaluate.push({ op: 'source', id: 'SV.size' }); },
    d => { d.groups.find(g => g.route === 'SV').evaluate.push({ op: 'error', field: 'unknown_field', message: { op: 'literal', value: 'Stop' } }); },
  ]) assert.notEqual(proof(old), proof(change(mutate)));
  const gated = change(d => { d.questionContracts['SV.color'].rule = { $and: [{ 'SV.material': [1] }] }; });
  const moved = structuredClone(gated); moved.sources['SV.material'].key = 'other_material';
  assert.notEqual(proof(gated), proof(moved), 'captured rule dependencies must be followed even without an AST source node');
  assert.equal(proof(gated, 'price'), proof(moved, 'price'));
  const supported = change(d => {
    d.sourceSupport = { version: 'historical-source-support-v1', sources: {
      'NM.extra': { semanticValues: ['1', '2'], deferredValues: [], placeholder: 'numeric-zero-v1' },
      'AR.size': { semanticValues: d.questionContracts['AR.size'].allowed, deferredValues: [], placeholder: 'none' },
    } };
  });
  const drift = structuredClone(supported); drift.sourceSupport.sources['NM.extra'].placeholder = 'none';
  assert.equal(proof(supported), proof(drift), 'unrelated source support cannot reset SV');
  assert.notEqual(proof(supported, 'dodatkovo_namysta', 'base', 'NM'), proof(drift, 'dodatkovo_namysta', 'base', 'NM'));
  const english = change(d => { d.groups.find(g => g.route === 'SV').rows[1].cells.store_view_code.value = 'uk'; });
  assert.equal(proof(old, 'name'), proof(english, 'name'));
  assert.notEqual(proof(old, 'name', 'english'), proof(english, 'name', 'english'));
});

test('successor carry leaves changed contracts and remote evidence unresolved', () => {
  const f = fixture();
  const route = 'SV.souvenir!=value_id:5';
  const svColor = a => a.routeKey === route && a.rowId === 'base' && a.target === 'kolir';
  function run({ definition = f.next, schema = f.schema, candidates = f.candidates(definition, schema) } = {}) {
    return carryReviewedBindings(stableReviewedSource(f.source, f.old, definition, schema),
      { originHash: f.source.originHash, schema, bindings: candidates }, definition);
  }
  function unresolved(result, predicate = svColor) {
    const attributes = result.bindings.attributes.filter(predicate);
    assert.ok(attributes.length);
    for (const a of attributes) {
      assert.notEqual(a.reviewState, 'approved', `${a.routeKey}/${a.target}`);
      assert.ok(result.bindings.options.filter(o => o.bindingKey === a.bindingKey).every(o => o.reviewState !== 'approved'));
      assert.ok(result.bindings.policies.filter(p => p.bindingKey === a.bindingKey).every(p => p.reviewState !== 'approved'));
    }
  }
  for (const mutate of [
    d => { d.sources['SV.color'].key = 'different_color'; },
    d => { d.questionContracts['SV.color'].required = true; },
    d => { d.groups.find(g => g.route === 'SV').rows[0].cells.attribute_set_code.then.value = 'Another set'; },
  ]) {
    const definition = structuredClone(f.next); mutate(definition);
    unresolved(run({ definition }));
  }
  for (const mutate of [
    s => { s.attributes.find(a => a.attribute_code === 'kolir').attribute_id += 1; },
    s => { s.attributes.find(a => a.attribute_code === 'kolir').frontend_input = 'text'; },
    s => { s.attributes.find(a => a.attribute_code === 'kolir').is_required = true; },
    s => { const setId = f.source.bindings.routes.find(r => r.routeKey === route).setId;
      s.attributeSets.find(s => s.attribute_set_id === setId).attributeCodes = []; },
    s => { const setId = f.source.bindings.routes.find(r => r.routeKey === route).setId;
      s.attributeSets.find(s => s.attribute_set_id === setId).attribute_set_name = 'Changed set'; },
    s => { s.storeTopology.storeViews[0].id += 1; },
    s => { s.storeTopology.storeViews[0].is_active = false; },
    s => { s.storeTopology.storeGroups[0].root_category_id += 1; },
  ]) { const schema = structuredClone(f.schema); mutate(schema); unresolved(run({ schema })); }
  for (const mutate of [
    s => { s.attributes.find(a => a.attribute_code === 'kolir').options[0].value = '999999'; },
    s => { s.attributes.find(a => a.attribute_code === 'kolir').options[0].label += ' changed'; },
    s => { const attr = s.attributes.find(a => a.attribute_code === 'kolir'); attr.options.push({ ...attr.options[0], value: '999999' }); },
  ]) {
    const schema = structuredClone(f.schema); mutate(schema);
    const result = run({ schema });
    const a = result.bindings.attributes.find(svColor);
    const original = f.source.bindings.options.find(o => o.bindingKey === a.bindingKey && o.optionId === f.schema.attributes.find(a => a.attribute_code === 'kolir').options[0].value);
    assert.notEqual(result.bindings.options.find(o => o.bindingKey === a.bindingKey && o.sourceKey === original.sourceKey).reviewState, 'approved');
  }
  // Fresh candidate defaults are not new reviewed ownership decisions. The only
  // policy values reused are those attached to proven unchanged source decisions.
  const result = run();
  const oldPolicy = f.source.bindings.policies.find(p => p.policy === 'initialize_create_only');
  const policy = result.bindings.policies.find(p => p.bindingKey === oldPolicy.bindingKey);
  assert.equal(policy.policy, oldPolicy.policy); assert.equal(policy.evidence.createValue, 2);
});
