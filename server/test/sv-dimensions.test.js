const test = require('node:test');
const assert = require('node:assert/strict');
const { components, equivalent } = require('../src/services/magento/sv-dimensions');

test('ordered dimensions use exact decimal strings and preserve order and component count', () => {
  assert.equal(equivalent('8/4/3,5', '8/4/3.5'), true);
  assert.equal(equivalent('9/3,5/2', '9/3.5/2'), true);
  assert.equal(equivalent('08.00/04/3,500', '8/4.0/3.5'), true);
  assert.equal(equivalent('9007199254740993/1', '9007199254740992/1'), false);
  assert.equal(equivalent('1.000000000000000001', '1'), false);
  assert.equal(equivalent('8/4', '4/8'), false);
  assert.equal(equivalent('8/4', '8/4/1'), false);
});
test('units, rounding, exponents, malformed separators and unbounded components are not normalized', () => {
  for (const value of ['', '1cm', '1 cm', '1/2/3/4', '1x2', '1 /2', ' 1/2', '1/2 ',
    '+1', '-1', '0/2', '1e2', '1,2.3', '1//2', '.5', '1.', '1\n/2', '1.0000000000000000001', '9'.repeat(129), null, 1]) {
    assert.equal(components(value), null, String(value));
    assert.equal(equivalent(value, value), false, String(value));
  }
  assert.equal(equivalent('1.234', '1.23'), false);
  assert.equal(equivalent('16,2/9', '1.6/0.8'), false);
});
