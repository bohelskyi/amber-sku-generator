// Entirely synthetic. These IDs and decisions are not deployment recommendations.
const { materializeMagentoV1 } = require('../../src/services/export-templates/magento-v1-definition');
const { compileDefinition } = require('../../src/services/export-templates/definition');
const { requirements, normalizeBindings } = require('../../src/services/magento/binding-validation');
const { normalizeSchema } = require('../../src/services/magento/binding-contract');
const literal = (value) => ({ op: 'literal', value });
function definition() {
  const d = materializeMagentoV1(new Map());
  d.sources = { sku: { kind: 'product', field: 'full_sku', type: 'text' },
    weight: { kind: 'product', field: 'weight', type: 'scalar' },
    color: { kind: 'semantic', category: 'BR', key: 'binding_test_semantic', type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] },
    size: { kind: 'information', category: 'BR', key: 'binding_test_size', type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] } };
  // Like BR styles: distinct semantic identities intentionally collapse in the evaluator.
  d.tables = { fixtureColors: { 7: 'Red output', 8: 'Blue output', 9: 'Red output' } }; d.bindings = []; d.questionContracts = {};
  for (const g of d.groups) {
    g.evaluate = [];
    for (const row of g.rows) row.cells = { sku: { op: 'text', input: { op: 'source', id: 'sku' }, trim: false, format: 'string-only-v1', onAbsent: 'empty' },
      store_view_code: literal(row.id === 'base' ? '' : 'en'), name: literal('Fixture name'),
      attribute_set_code: literal('Historical CSV name'), product_type: literal('simple'), price: literal('42') };
  }
  Object.assign(d.groups[0].rows[0].cells, {
    kolir: { op: 'lookup', input: { op: 'semanticKey', input: { op: 'source', id: 'color' } }, table: 'fixtureColors', otherwise: literal('') },
    dovzhyna_brasletu_diuimiv: { op: 'text', input: { op: 'source', id: 'size' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' },
    decor_weight: { op: 'numericBand', input: { op: 'text', input: { op: 'source', id: 'weight' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' }, format: 'number-v1', onInvalid: 'error', outside: literal('large'),
      bands: [{ min: 0, max: 10, minInclusive: true, maxInclusive: true, value: 'small' }] },
  });
  return compileDefinition(d).definition;
}
function schema() {
  const definitions = [['sku','text',[]], ['name','text',[]], ['price','price',[]],
    ['kolir','select',[['red-id','Remote red'],['blue-id','Remote blue']]],
    ['dovzhyna_brasletu_diuimiv','select',[['size-id','17']]],
    ['decor_weight','select',[['small-id','small'],['large-id','large']]]];
  return normalizeSchema({ storeCode: 'all',
    storeTopology: { websites: [{ id: 801, code: 'fixture', name: 'Fixture' }],
      storeGroups: [{ id: 802, name: 'Group', website_id: 801, root_category_id: 803, default_store_id: 804 }],
      storeViews: [{ id: 804, code: 'en', name: 'English', website_id: 801, store_group_id: 802, is_active: true }] },
    attributes: definitions.map(([attribute_code, frontend_input, opts], i) => ({ attribute_id: 900 + i,
      attribute_code, frontend_input, options: opts.map(([value,label]) => ({ value, label })) })),
    attributeSets: [{ attribute_set_id: 8001, attribute_set_name: 'Explicit fixture decision', attributeCodes: definitions.map(([c]) => c) }] });
}
function approvedBindings(d = definition(), s = schema()) {
  const plans = requirements(d, s); const selected = plans.find((p) => p.amberGroup === 'BR');
  const bindings = { routes: plans.map((r) => ({ routeKey: r.routeKey, enabled: r === selected,
    setId: r === selected ? 8001 : null, reviewState: r === selected ? 'approved' : 'review_required' })),
  attributes: [], options: [], policies: [] };
  const remote = { 'Red output': 'red-id', 'Blue output': 'blue-id', small: 'small-id', large: 'large-id' };
  for (const a of selected.attributes) {
    bindings.attributes.push({ routeKey: a.routeKey, rowId: a.rowId, target: a.target, strategy: a.strategy,
      attributeCode: a.strategy === 'transport_control' ? null : a.target,
      transportTarget: a.strategy === 'transport_control' ? `product.${a.target}` : null, reviewState: 'approved' });
    for (const { sourceKey: _sourceKey, ...o } of a.options) bindings.options.push({ ...o, bindingKey: a.bindingKey,
      optionId: remote[o.evaluatedOutput], reviewState: 'approved', ...(o.sourceKind === 'semantic' ? { skuCodeEvidence: '91' } : {}) });
    if (a.strategy === 'dynamic_exact_label_option') bindings.options.push({ bindingKey: a.bindingKey, sourceKind: 'evaluated',
      domainKey: a.domainKey, outputKey: '17', evaluatedOutput: '17', optionId: 'size-id', reviewState: 'approved' });
    bindings.policies.push({ bindingKey: a.bindingKey, storeCode: a.rowId === 'base' ? 'all' : 'en', policy: 'magento_managed', reviewState: 'approved' });
  }
  return bindings;
}
function editable(bindings) {
  const result = structuredClone(bindings);
  result.attributes.forEach((a) => { delete a.bindingKey; });
  result.options.forEach((o) => { delete o.sourceKey; delete o.strategy; });
  return result;
}
module.exports = { definition, schema, approvedBindings, editable, normalized: () => normalizeBindings(approvedBindings()) };
