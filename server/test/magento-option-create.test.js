const { test } = require('node:test');
const assert = require('node:assert/strict');
const option = require('../src/services/magento/configuration-option');
const attribute = { attribute_id: 1471, attribute_code: 'fixture_choice', frontend_input: 'select',
  backend_type: 'int', is_user_defined: true, source_model: 'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table' };
test('ordinary option capability still requires explicit review; metadata never proves non-swatch', () => {
  assert.equal(option.characterize(attribute).requiresAttestation, true);
  for (const change of [{ is_user_defined: false }, { frontend_input: 'boolean' }, { frontend_input: 'swatch_visual' },
    { source_model: 'Custom\\Source' }, { backend_type: 'unknown' }]) {
    assert.throws(() => option.characterize({ ...attribute, ...change }), { code: 'MAGENTO_OPTION_CAPABILITY_UNSUPPORTED' });
  }
  const missing = { ...attribute }; delete missing.source_model;
  assert.throws(() => option.characterize(missing));
  assert.throws(() => option.characterize({ ...attribute, additional_data: '{"swatch_input_type":"visual"}' }));
  assert.notEqual(option.characterize({ ...attribute, frontend_labels: [] }).metadataFingerprint, option.characterize(attribute).metadataFingerprint);
});
test('option verification uses exact returned ID and rejects duplicate labels and existing IDs', () => {
  const before = [{ value: '10', label: 'Існуюче' }]; const after = [...before, { value: '5738', label: 'Скриньки' }];
  assert.equal(option.verifyOption({ before, label: 'Скриньки' }, '5738', after), true);
  for (const rows of [before, [...after, { value: '5740', label: 'Скриньки' }], [{ value: '5738', label: 'Інше' }]]) {
    assert.throws(() => option.verifyOption({ before, label: 'Скриньки' }, '5738', rows));
  }
  assert.throws(() => option.verifyOption({ before: after, label: 'Скриньки' }, '5738', after));
});
