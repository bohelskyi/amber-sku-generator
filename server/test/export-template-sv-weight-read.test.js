const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/legacy-sv-schema6');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const { readSource } = require('../src/services/export-templates/input-projection');
const compiled = compileDefinition(fixture.publication().definition);
const descriptor = { kind: 'information', category: 'SV', key: 'weight', aliases: [] };

// Only the reported weight/price/route are acceptance facts. Other fields below
// are controlled copies, not a reconstruction of the live product's full row.
function product(weight = '132.300', answer = '132,3') {
  const result = fixture.product(2198);
  Object.assign(result, { id: 1488, full_sku: 'SV11500004', public_sku: 'SV11500004',
    status: 'active', weight, total_price_uah: '2950.00', magento_name_subject_ua: 'Тестовий камінь',
    magento_name_subject_en: 'Test stone' });
  result.details.answers.weight = answer;
  result.details.answers.souvenir = 5;
  return result;
}

test('schema6 comma mirror evaluates the same 132.3g and fraction as the dot mirror without rewriting data', () => {
  const input = product(), before = structuredClone(input), hash = compiled.hash;
  const expected = evaluateProduct(compiled, product('132.300', '132.3'));
  const actual = evaluateProduct(compiled, input);
  assert.equal(actual.base.decor_weight, '132.3');
  assert.equal(actual.base.fraction, '100-200');
  assert.deepEqual(actual, expected);
  assert.deepEqual(input, before);
  assert.equal(compiled.hash, hash);
  assert.equal(input.total_price_uah, '2950.00');
});

test('schema6 sub-gram comma weights stay grams in the original 0-2 fraction band', () => {
  for (const value of ['0.9', '0.3', '0.001', '1.999', '2', '1000']) {
    const input = product(value, value.replace('.', ',')), before = structuredClone(input);
    const actual = evaluateProduct(compiled, input);
    assert.equal(actual.base.decor_weight, value);
    assert.equal(actual.base.fraction, Number(value) < 2 ? '0-2' : value === '2' ? '2-5' : '1000+');
    assert.deepEqual(input, before);
  }
});

test('comma normalization cannot guess units, grouping, precision or a conflicting physical weight', () => {
  const invalid = input => {
    const before = structuredClone(input);
    assert.equal(readSource(descriptor, input), input.details.answers.weight);
    const result = evaluateProduct(compiled, input);
    assert.equal(result.base.decor_weight, '');
    assert.equal(result.base.fraction, '');
    assert.ok(result.errors.some(error => error.field === 'decor_weight'));
    assert.deepEqual(input, before);
  };
  for (const answer of ['1.234,56', '1,234.56', '132,3г', '1,2,3', '-0,9', '0,0',
    '0,0001', ',9', '1,', '1e2,0', '0x1,2', '999999999999,0', '1,0001']) {
    invalid(product('132.300', answer));
  }
  for (const physical of [null, undefined, '', '0.000', '132.301', true, '1,234.56']) {
    const input = product(); input.weight = physical;
    invalid(input);
  }
  // A single comma is decimal only when the independently stored grams agree.
  assert.equal(evaluateProduct(compiled, product('1.234', '1,234')).base.decor_weight, '1.234');
  invalid(product('1234.000', '1,234'));
});

test('frozen text and catalog conditions keep the raw comma source while numeric weight alone is normalized', () => {
  const definition = structuredClone(compiled.definition);
  const sourceId = Object.keys(definition.sources).find(id => definition.sources[id].kind === 'information'
    && definition.sources[id].category === 'SV' && definition.sources[id].key === 'weight');
  definition.groups.find(group => group.route === 'SV').rows[0].cells.short_description = {
    op: 'text', input: { op: 'source', id: sourceId }, trim: false, format: 'string-only-v1', onAbsent: 'empty',
  };
  definition.questionContracts['SV.color'].rule = { [sourceId]: '132,3' };
  const input = product(), before = structuredClone(input);
  const mapped = evaluateProduct(compileDefinition(definition), input);
  assert.equal(mapped.base.short_description, '132,3');
  assert.equal(mapped.base.kolir, evaluateProduct(compiled, input).base.kolir);
  assert.equal(mapped.base.decor_weight, '132.3');
  assert.equal(mapped.base.fraction, '100-200');
  assert.equal(readSource(descriptor, input), '132,3');
  assert.deepEqual(input, before);
});

test('absence and unsupported sources retain their original observation and alias guards', () => {
  for (const value of [undefined, null, '', ' ', 0, false]) {
    const input = product(); input.details.answers.weight = value;
    assert.equal(readSource(descriptor, input), value);
  }
  const other = product(); other.category = 'BR';
  assert.equal(readSource({ ...descriptor, category: 'BR' }, other), '132,3');
  assert.equal(readSource({ kind: 'product', field: 'weight', type: 'number' }, product('132,3')), '132,3');
  const aliased = product(); aliased.details.answers.old_weight = '132.3';
  assert.throws(() => readSource({ ...descriptor, aliases: [{ schemaId: '6', key: 'old_weight' }] }, aliased),
    { code: 'SOURCE_REFERENCE_AMBIGUOUS' });
});

test('archived, corrected and unknown lifecycle states keep their original guarded comma diagnostics', () => {
  for (const status of ['archived', 'corrected', 'voided', undefined, null]) {
    const input = product(); input.status = status;
    const before = structuredClone(input), result = evaluateProduct(compiled, input);
    assert.equal(result.base.decor_weight, '');
    assert.ok(result.errors.some(error => error.field === 'decor_weight'));
    assert.deepEqual(input, before);
  }
});

test('historical prospective active projection preserves reviewed comma repair and its original diagnostics', () => {
  const input = product(); input.status = 'archived';
  require('../src/services/magento/historical-standard-boundary').project({ product: input });
  assert.equal(input.status, 'active', 'Projection alone is not a stored activation');
  const before = structuredClone(input), result = evaluateProduct(compiled, input);
  assert.equal(result.base.decor_weight, '');
  assert.ok(result.errors.some(error => error.field === 'decor_weight'));
  assert.deepEqual(input, before);
  input.details.answers.weight = '132.3';
  assert.equal(evaluateProduct(compiled, input).base.decor_weight, '132.3');
});
