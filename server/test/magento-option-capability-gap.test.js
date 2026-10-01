const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAttribute } = require('../src/services/magento/schema-audit');

// Magento 2.4.6 SwatchAttributeType reads swatch_input_type from additional_data;
// ProductAttributeInterface/EavAttributeInterface do not promise that field in REST.
// This is a characterization gap, not permission to add a writer for all selects.
test('H4 safety characterization: current normalized select metadata cannot exclude swatches', () => {
  const ordinary = { attribute_id: 1471, attribute_code: 'fixture_choice', frontend_input: 'select',
    backend_type: 'int', is_user_defined: true, source_model: 'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table',
    additional_data: '{"swatch_input_type":"dropdown"}' };
  const swatch = { ...ordinary, additional_data: '{"swatch_input_type":"visual"}' };
  assert.deepEqual(normalizeAttribute(ordinary), normalizeAttribute(swatch));
  assert.equal(Object.hasOwn(normalizeAttribute(swatch), 'additional_data'), false);
  assert.equal(Object.hasOwn(normalizeAttribute(swatch), 'swatch_input_type'), false);
});
