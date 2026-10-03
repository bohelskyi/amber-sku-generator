const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateNames, validateEvaluatedNames } = require('../src/services/magento/product-names.service');
const { ENDPOINT_MANIFEST } = require('../src/routes/endpoint-manifest');
test('full names remain exact and reject missing, empty, invalid or oversized language values', () => {
  const names = { all: ' Повна довільна назва. Арт: AG-000002 ', en: 'Arbitrary full name' };
  assert.deepEqual(validateNames(names), names);
  for (const invalid of [null, [], {}, { all: 'UA' }, { ...names, en: '' }, { ...names, all: '   ' },
    { ...names, en: 'line\nbreak' }, { ...names, all: '\u0000' }, { ...names, en: 'x'.repeat(1025) }, { ...names, subjectUa: 'forbidden' }]) {
    assert.throws(() => validateNames(invalid), { code: 'PRODUCT_NAMES_INVALID' });
  }
});
test('invalid generated names preserve 422 and expose conflict without offering repair', () => {
  assert.throws(() => validateEvaluatedNames({ all: '', en: '' }, {
    product: { category: 'SV' }, nameState: { state: 'conflict' },
  }, { issueFields: ['name'] }), (error) => {
    assert.equal(error.statusCode, 422);
    assert.equal(error.code, 'PRODUCT_NAMES_INVALID');
    assert.deepEqual(error.details, { nameConflict: true, repair: null });
    return true;
  });
});
test('name read/save retain typed permission, authentication and CSRF contracts', () => {
  const read = ENDPOINT_MANIFEST.find((item) => item.path === '/product-names/:productId');
  const save = ENDPOINT_MANIFEST.find((item) => item.path === '/product-names/save');
  assert.equal(read.permission, 'products.decode'); assert.equal(save.permission, 'exports.create');
  assert.equal(read.authenticated, true); assert.equal(save.activeUser, true); assert.equal(save.csrf, true);
});
