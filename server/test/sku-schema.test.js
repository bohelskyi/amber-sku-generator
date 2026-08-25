const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getVersionMarker,
  parseVersionedSkuPart,
  validateSnapshot,
} = require('../src/services/sku-schema.service');

test('legacy SKU without a marker resolves to V1', () => {
  assert.deepEqual(parseVersionedSkuPart('11111012001'), {
    version: 1,
    marker: '',
    encodedWithSuffix: '11111012001',
  });
});

test('versioned SKU marker is removed before decoding', () => {
  assert.deepEqual(parseVersionedSkuPart('2/11161012001'), {
    version: 2,
    marker: '2/',
    encodedWithSuffix: '11161012001',
  });
});

test('decoder keeps compatibility with the pre-release version marker', () => {
  assert.deepEqual(parseVersionedSkuPart('V2-11161012001'), {
    version: 2,
    marker: 'V2-',
    encodedWithSuffix: '11161012001',
  });
});

test('only V1 has no explicit marker', () => {
  assert.equal(getVersionMarker(1), '');
  assert.equal(getVersionMarker(2), '2/');
  assert.equal(getVersionMarker(52), '52/');
});

test('one SKU code may have contextual labels for the same semantic value', () => {
  assert.doesNotThrow(() => validateSnapshot([{
    label: 'Quality',
    options: [
      { value_id: 1, sku_code: '1', label: 'Natural grade 1' },
      { value_id: 1, sku_code: '1', label: 'Formed grade 1' },
    ],
  }]));
});

test('one schema cannot map a SKU code to different semantic values', () => {
  assert.throws(() => validateSnapshot([{
    label: 'Style',
    options: [
      { value_id: 3, sku_code: '3', label: 'Old style' },
      { value_id: 6, sku_code: '3', label: 'New style' },
    ],
  }]), /різним внутрішнім значенням/);
});
