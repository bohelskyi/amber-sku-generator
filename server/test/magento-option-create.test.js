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

const fixtureConfig = { configured: true, baseUrl: 'https://option-fixture.invalid', consumerKey: 'synthetic-key',
  consumerSecret: 'synthetic-secret', accessToken: 'synthetic-token', accessTokenSecret: 'synthetic-token-secret' };
async function observedMetadata(raw) {
  return option.observe(fixtureConfig, 'fixture_choice', { fetchImpl: async (url, request) => {
    assert.equal(request.method, 'GET');
    const path = new URL(url).pathname;
    const value = path.endsWith('/fixture_choice') ? raw : path.endsWith('/store/storeViews') ? []
      : [{ value: '', label: ' ' }, { value: '5738', label: 'Скриньки' }];
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  } });
}
function firstNonDefaultIntent(raw = attribute) {
  return { metadataFingerprint: option.characterize(raw).metadataFingerprint,
    before: [{ value: '', label: ' ', isEmpty: true }], body: { option: { is_default: false } } };
}
test('first non-default option verifies only the exact absent-to-empty default metadata preimage', async () => {
  const intent = firstNonDefaultIntent(), frozen = structuredClone(intent);
  const observed = await observedMetadata({ ...attribute, default_value: '' });
  assert.notEqual(observed.metadataFingerprint, intent.metadataFingerprint);
  const evidence = option.verifyOptionMetadata(intent, observed);
  assert.equal(evidence.mode, 'first_non_default_option_empty_default_added');
  assert.equal(evidence.sealedFingerprint, intent.metadataFingerprint);
  assert.equal(evidence.observedFingerprint, observed.metadataFingerprint);
  assert.deepEqual(intent, frozen, 'verification must not rewrite an immutable intent or attestation');
});
test('real default values and additional metadata drift never satisfy the first-option preimage', async () => {
  const intent = firstNonDefaultIntent();
  for (const default_value of ['5738', '0', 0, null, false]) {
    assert.throws(() => option.verifyOptionMetadata(intent, option.characterize({ ...attribute, default_value })),
      { code: 'MAGENTO_OPTION_METADATA_DRIFT' });
  }
  for (const change of [{ is_required: true }, { default_frontend_label: 'Changed' }, { validation_rules: ['changed'] }]) {
    const observed = await observedMetadata({ ...attribute, default_value: '', ...change });
    assert.throws(() => option.verifyOptionMetadata(intent, observed),
      { code: 'MAGENTO_OPTION_METADATA_DRIFT' });
  }
});
test('no-default metadata preimage is unavailable to existing-option or default-setting actions', async () => {
  const observed = await observedMetadata({ ...attribute, default_value: '' });
  for (const intent of [{ ...firstNonDefaultIntent(), before: [{ value: '10', label: 'Existing', isEmpty: false }] },
    { ...firstNonDefaultIntent(), body: { option: { is_default: true } } },
    { ...firstNonDefaultIntent(), body: { option: {} } }]) {
    assert.throws(() => option.verifyOptionMetadata(intent, observed), { code: 'MAGENTO_OPTION_METADATA_DRIFT' });
  }
  for (const change of [{ source_model: 'Custom\\Source' }, { additional_data: '{"swatch_input_type":"visual"}' }]) {
    await assert.rejects(observedMetadata({ ...attribute, default_value: '', ...change }), { code: 'MAGENTO_OPTION_CAPABILITY_UNSUPPORTED' });
  }
});
test('legacy exact metadata fingerprints remain exact, including an originally observable empty default', async () => {
  const raw = { ...attribute, default_value: '' }, intent = firstNonDefaultIntent(raw);
  assert.equal(option.verifyOptionMetadata(intent, await observedMetadata(raw)), null);
  assert.equal(option.verifyOptionMetadata(firstNonDefaultIntent(), await observedMetadata(attribute)), null);
});
