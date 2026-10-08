const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizedWeight, targetProduct, verify } = require('../src/services/sv-readiness-repair');
const { parseArguments } = require('../scripts/sv-readiness-repair');
test('SV readiness repairs only an exact positive saved decimal-comma representation', () => {
  for (const bad of [undefined, null, 123, '', '0,0', '-1,2', '1,2,3', '1.2', '1,2 g', ' 1,2', '1e3,0']) assert.equal(normalizedWeight(bad), null);
  assert.equal(normalizedWeight('52,20'), '52.20');
  const p = { id: 1, full_sku: 'SV-fixture', weight: '0.000', total_price_uah: '2600.00',
    details: { manualPriceUah: 2600, answers: { souvenir: 5, weight: '52,20' } } };
  const target = targetProduct(p);
  assert.deepEqual(target, { ...p, details: { ...p.details, answers: { ...p.details.answers, weight: '52.20' } } });
  assert.equal(p.details.answers.weight, '52,20');
  assert.equal(targetProduct({ details: { answers: {} }, weight: 52.2 }), null);
});

test('archived comma representation requires exact positive canonical equality without floating point rounding', () => {
  const { equivalentCommaWeight, equivalentDotWeight } = require('../src/services/sv-readiness-repair');
  const product = (answer, weight = '517.000') => ({ weight, details: { answers: { weight: answer } } });
  assert.equal(equivalentCommaWeight(product('517,0')), '517.0');
  assert.equal(equivalentCommaWeight(product('00517,000')), '00517.000');
  assert.equal(equivalentCommaWeight(product('0,1250', '0.125')), '0.1250');
  for (const raw of [undefined, null, '', 517, '517.0', '517,0 ', ' 517,0', '517,0 g', '517,0,0', '5e2,0', '-517,0', '0,0', '518,0', '517,000000000000000001'])
    assert.equal(equivalentCommaWeight(product(raw)), null, String(raw));
  for (const canonical of [undefined, null, '', '0.000', '517,0', '-517', 'NaN', Infinity, '516.999', '517.000000000000000001']) {
    const p = product('517,0'); p.weight = canonical;
    assert.equal(equivalentCommaWeight(p), null, String(canonical));
  }
  assert.equal(equivalentDotWeight(product('517.0')), true);
  assert.equal(equivalentDotWeight(product('517,0')), false);
  assert.equal(equivalentDotWeight(product('517.000000000000000001')), false);
});

test('SV CLI defaults to preview and rejects implicit apply, scope mixing and unsigned plans', () => {
  const base = ['--expected-database','amber_test','--output','plan.json'];
  assert.equal(parseArguments([...base,'--binding-revision','00000000-0000-0000-0000-000000000001']).apply, undefined);
  assert.throws(() => parseArguments([...base,'--apply']), /SV_REPAIR_ARGUMENTS/);
  assert.throws(() => parseArguments([...base,'--plan','plan.json']), /SV_REPAIR_ARGUMENTS/);
  assert.throws(() => verify({}, '0'.repeat(64), 'amber_test'), { code: 'SV_REPAIR_CONFLICT' });
});
