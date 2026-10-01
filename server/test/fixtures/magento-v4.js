// Synthetic future-category contract, never an installation default.
const { CONTRACT, REQUIRED } = require('../../src/services/export-templates/column-contract');
const { requirements, normalizeBindings } = require('../../src/services/magento/binding-validation');
const { schema } = require('./magento-bindings');
const literal = (value) => ({ op: 'literal', value });
const text = (id) => ({ op: 'text', input: { op: 'source', id }, trim: false, format: 'scalar-v1', onAbsent: 'empty' });
function definition(categories = ['XG']) {
  return { formatVersion: 1, evaluatorVersion: 'magento-declarative-4', outputContract: CONTRACT,
    sourceContractVersion: 'public-product-identity-v1',
    sources: { sku: { kind: 'product', field: 'public_sku', type: 'text' },
      price: { kind: 'product', field: 'total_price_uah', type: 'scalar' },
      color: { kind: 'semantic', category: 'XG', key: 'new_color', type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] },
      note: { kind: 'information', category: 'XG', key: 'new_note', type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] } },
    tables: { colors: { 7: 'Red output' } }, bindings: [],
    questionContracts: { color: { source: 'color', exists: true, required: true, rule: {}, allowed: ['7'] },
      note: { source: 'note', exists: true, required: false, rule: {}, allowed: [] } },
    groups: categories.map((route) => ({ route, name: route, columns: [...REQUIRED, ...(route === 'XG' ? ['kolir', 'new_note'] : [])], evaluate: [],
      rows: ['base', 'english'].map((id) => ({ id, default: '', cells: { sku: text('sku'),
        store_view_code: literal(id === 'base' ? '' : 'en'), name: literal(id === 'base' ? 'Тестова назва' : 'Test name'),
        attribute_set_code: literal('Fixture set'), product_type: literal('simple'), price: text('price'),
        ...(route === 'XG' && id === 'base' ? { kolir: { op: 'lookup', input: { op: 'semanticKey', input: { op: 'source', id: 'color' } },
          table: 'colors', otherwise: { op: 'error', field: 'kolir', message: literal('Missing semantic value') } }, new_note: text('note') } : {}) } })) })) };
}
function observation() {
  const s = schema(); s.attributes.push({ attribute_id: 999, attribute_code: 'new_note', frontend_input: 'text', options: [] });
  s.attributeSets[0].attributeCodes.push('new_note'); return s;
}
function approvedBindings(d = definition(), s = observation()) {
  const plans = requirements(d, s); const b = { routes: [], attributes: [], options: [], policies: [] };
  for (const r of plans) {
    b.routes.push({ routeKey: r.routeKey, enabled: true, setId: 8001, reviewState: 'approved' });
    for (const a of r.attributes) {
      b.attributes.push({ routeKey: a.routeKey, rowId: a.rowId, target: a.target, strategy: a.strategy,
        attributeCode: a.strategy === 'transport_control' ? null : a.target,
        transportTarget: a.strategy === 'transport_control' ? `product.${a.target}` : null, reviewState: 'approved' });
      for (const o of a.options) b.options.push({ ...o, bindingKey: a.bindingKey, optionId: 'red-id', skuCodeEvidence: '91', reviewState: 'approved' });
      b.policies.push({ bindingKey: a.bindingKey, storeCode: a.rowId === 'base' ? 'all' : 'en', policy: 'magento_managed', reviewState: 'approved' });
    }
  }
  return normalizeBindings(b);
}
module.exports = { definition, observation, approvedBindings };
