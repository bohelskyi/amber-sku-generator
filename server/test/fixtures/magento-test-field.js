const { fixture } = require('./magento-successor');
const { upgradeColumns } = require('../../src/services/export-templates/column-contract');
const literal = value => ({ op: 'literal', value });

// Synthetic IDs reproduce the approved scope without reading a live catalog.
function testFieldFixture() {
  const f = fixture(), definition = upgradeColumns(f.old), target = 'test_field', source = 'SV.test_field';
  definition.sources[source] = { kind: 'semantic', category: 'SV', key: target, type: 'scalar',
    provenance: 'supplied-stored-answers-v1', aliases: [] };
  definition.questionContracts[source] = { source, exists: true, required: false, rule: {}, allowed: ['33'] };
  definition.tables[source] = { 33: 'TEST варіант' };
  const group = definition.groups.find(g => g.route === 'SV');
  group.columns.push(target);
  group.rows.find(r => r.id === 'base').cells[target] = { op: 'questionValue', question: source,
    value: { op: 'lookup', input: { op: 'semanticKey', input: { op: 'source', id: source } }, table: source,
      otherwise: { op: 'error', field: target, message: literal('Unknown test option') } },
    missingQuestion: { op: 'error', field: target, message: literal('Missing test question') },
    missingAnswer: { op: 'error', field: target, message: literal('Missing test answer') } };
  group.rows.find(r => r.id === 'english').cells[target] = literal('');
  const schema = structuredClone(f.schema);
  const generalRoute = 'SV.souvenir!=value_id:5', stoneRoute = 'SV.souvenir=value_id:5';
  const plans = require('../../src/services/magento/binding-validation').requirements(definition, schema);
  schema.attributeSets.find(s => s.attribute_set_name === plans.find(r => r.routeKey === generalRoute).evaluatorSetName).attribute_set_id = 151;
  schema.attributeSets.find(s => s.attribute_set_name === plans.find(r => r.routeKey === stoneRoute).evaluatorSetName).attribute_set_id = 154;
  schema.attributes.push({ attribute_code: target, attribute_id: 1535, frontend_input: 'select', scope: 'global',
    options: [{ value: '6061', label: 'TEST варіант' }] });
  schema.attributeSets.find(s => s.attribute_set_id === 151).attributeCodes.push(target);
  return { ...f, definition, schema: require('../../src/services/magento/binding-contract').normalizeSchema(schema),
    target, sourceId: source, generalRoute, stoneRoute,
    scope: { category: 'SV', routeKey: generalRoute, setId: 151, target, publicSku: 'TEST-000001' } };
}

module.exports = { testFieldFixture };
