const assert = require('node:assert/strict');
const test = require('node:test');
const { parseStrictDecimal, normalizeNumericValidation, resolveProductWeight } = require('../src/utils/numbers');
const { normalizeProductInputAnswers } = require('../src/services/product/product-answers');
const { inspectSkuAnswer, inspectNonSkuAnswer, getContextualOption } = require('../src/services/product/product-validation');

test('whole grammar rejects numeric prefixes, exponent, hex, mixed separators and non-number objects', () => {
  for (const value of ['12kg', '12,3mm', '1e3', '0x10', '1,2.3', '1.2.3', '.5', '1.', '', true, null, {}, Infinity]) assert.throws(() => parseStrictDecimal(value), { statusCode: 422 });
  assert.equal(parseStrictDecimal(' 12,30 '), 12.3);
  assert.equal(parseStrictDecimal('12.30'), 12.3);
  assert.equal(parseStrictDecimal('0'), 0);
  assert.equal(parseStrictDecimal(0.0000001, { maxFractionDigits: 7 }), 0.0000001);
  assert.throws(() => parseStrictDecimal('1e-7', { maxFractionDigits: 7 }));
});
test('precision and bounds never round invalid input', () => {
  assert.equal(parseStrictDecimal('2', { kind: 'integer', min: 2, max: 2 }), 2);
  for (const value of ['2.0', '2,1']) assert.throws(() => parseStrictDecimal(value, { kind: 'integer' }));
  assert.equal(parseStrictDecimal('2,01', { maxFractionDigits: 2, min: 2, minInclusive: false }), 2.01);
  assert.throws(() => parseStrictDecimal('2.010', { maxFractionDigits: 2 }));
  assert.throws(() => parseStrictDecimal('2', { min: 2, minInclusive: false }));
  assert.throws(() => parseStrictDecimal('2', { max: 2, maxInclusive: false }));
  assert.throws(() => normalizeNumericValidation({ kind: 'decimal', min: 2, max: 1 }));
  assert.throws(() => normalizeNumericValidation({ kind: 'decimal', maxFractionDigits: -1 }));
  assert.deepEqual(normalizeNumericValidation({ kind: 'integer', unit: 'мм' }),
    { kind: 'integer', unit: 'мм', min: null, max: null, minInclusive: true, maxInclusive: true, maxFractionDigits: 0 });
});
test('one product weight accepts comma/dot parity and refuses contradictory sources', () => {
  assert.equal(resolveProductWeight('12,3', 12.3), 12.3);
  assert.equal(resolveProductWeight(null, '12,3'), 12.3);
  assert.equal(resolveProductWeight('12.3', null), 12.3);
  assert.equal(resolveProductWeight(null, null), 0);
  assert.throws(() => resolveProductWeight('12.3', '12.4'), { statusCode: 422, code: 'WEIGHT_CONFLICT' });
  assert.throws(() => resolveProductWeight('12kg', null), { statusCode: 422 });
  assert.throws(() => resolveProductWeight('12.3456', null), { statusCode: 422 });
});
test('numeric metadata preserves arbitrary text, semantic zero and calibration 2', () => {
  const questions = [
    { key: 'amount', input_type: 'text', numeric_validation: { kind: 'decimal', min: 0, max: 15, maxInclusive: false, maxFractionDigits: 2 } },
    { key: 'note', input_type: 'text' }, { key: 'dimension', input_type: 'text' },
    { key: 'is_calibrated', input_type: 'options' }, { key: 'zero', input_type: 'options' },
  ];
  assert.deepEqual(normalizeProductInputAnswers('ZZ', { amount: '12,3', note: '0012', dimension: '12,3mm', is_calibrated: '2', zero: '0' }, questions),
    { amount: 12.3, note: '0012', dimension: '12,3mm', is_calibrated: 2, zero: 0 });
  for (const amount of ['15', '12.345', '12mm', '0x10', '1e2']) assert.throws(() => normalizeProductInputAnswers('ZZ', { amount }, questions),
    (error) => error.statusCode === 422 && Boolean(error.fieldErrors.amount));
  assert.deepEqual(normalizeProductInputAnswers('ZZ', { amount: '0' }, questions), { amount: 0 });
});
test('question archive preserves exact inherited assignments and rejects new ones', () => {
  const questions = [{ key: 'old', archived: true, required: 1, input_type: 'text' }];
  assert.throws(() => normalizeProductInputAnswers('ZZ', { old: '0012' }, questions), { statusCode: 422 });
  assert.deepEqual(normalizeProductInputAnswers('ZZ', { old: '0012', note: 'changed' }, questions,
    { previousAnswers: { old: '0012' } }), { old: '0012', note: 'changed' });
  assert.throws(() => normalizeProductInputAnswers('ZZ', { old: '12' }, questions,
    { previousAnswers: { old: '0012' } }), { statusCode: 422 });
  assert.equal(inspectNonSkuAnswer(questions[0], {}, 2).visible, false);
  assert.equal(inspectSkuAnswer(questions[0], {}, 2).issue, null);
});
test('archived semantic zero is valid only when inherited; active aliases remain selectable', () => {
  const question = { key: 'shape', required: 1, options: [{ value_id: 0, archived: true }] };
  assert.equal(inspectSkuAnswer(question, { shape: 0 }, 2).issue, 'unavailable');
  assert.equal(inspectSkuAnswer(question, { shape: 0 }, 2, { previousAnswers: { shape: 0 } }).issue, null);
  assert.equal(inspectNonSkuAnswer(question, { shape: 0 }, 2, { previousAnswers: { shape: 0 } }).issue, null);
  assert.equal(inspectSkuAnswer(question, { shape: 0 }, 2, { previousAnswers: { shape: 1 } }).issue, 'unavailable');
  const archived = { value_id: 2, archived: true, visible_if_json: { is_calibrated: 2 } };
  const active = { value_id: 2, archived: false };
  assert.equal(getContextualOption({ options: [archived, active] }, 2, { is_calibrated: 2 }), active);
});

const { getCatalogItemImpact } = require('../src/services/catalog/catalog-impact');
test('dependency previews bind the exact state and prevent local cascading deletion with history or rules', async () => {
  const item = { id: 4, category_code: 'ZZ', key: 'shape', label: 'Shape', archived: false };
  const inspect = async (counts, rules = []) => {
    const responses = [[item], [counts], rules];
    const queryable = { async query(_sql, values) { assert.ok(Array.isArray(values)); return { rows: responses.shift() }; } };
    return getCatalogItemImpact('question', 4, queryable);
  };
  const empty = { products: 0, category_products: 0, published_schemas: 0, magento_bindings: 0, options: 1 };
  const clear = await inspect(empty);
  assert.equal(clear.canDeleteLocal, true);
  assert.equal(clear.localDeleteOnly, true);
  assert.equal(clear.confirmation, 'DELETE question:4');
  const used = await inspect({ ...empty, products: 1, category_products: 1 });
  assert.equal(used.canDeleteLocal, false);
  assert.notEqual(used.impactHash, clear.impactHash);
  const pricing = await inspect(empty, [{ kind: 'scenario', id: 8, rule: { $or: [{ shape: 0 }, { other: 1 }] } }]);
  assert.equal(pricing.canDeleteLocal, false);
  assert.equal(pricing.affectedCounts.rules, 1);
  assert.deepEqual(pricing.dependencies, [{ type: 'scenario', id: 8 }]);
});


test('invalid physical weight exposes the authoritative weight field error', () => {
  const { resolveProductWeight } = require('../src/utils/numbers');
  for (const weight of ['12,3mm', '1e3', '12.3456', -1]) {
    assert.throws(() => resolveProductWeight(weight, null), (error) => error.statusCode === 422
      && error.fieldErrors?.weight === error.message);
  }
});


test('numeric suffix errors explain units while integer fractions and bounds remain distinct', () => {
  const integer = { key: 'length', label: 'Розмір', input_type: 'text', numeric_validation: { kind: 'integer', unit: 'мм', min: 1, max: 30, maxInclusive: true } };
  const decimal = { ...integer, numeric_validation: { ...integer.numeric_validation, kind: 'decimal', maxFractionDigits: 2 } };
  for (const question of [integer, decimal]) {
    for (const length of ['30мм', '30 мм', '30mm', '30,5мм', '30%', '30/2']) {
      assert.throws(() => normalizeProductInputAnswers('QA', { length }, [question]), (error) => {
        assert.equal(error.statusCode, 422);
        assert.match(error.fieldErrors.length, /без одиниць виміру та зайвих символів/);
        return true;
      });
    }
  }
  assert.throws(() => normalizeProductInputAnswers('QA', { length: '2,5' }, [integer]), (error) => /ціле число/.test(error.fieldErrors.length));
  assert.deepEqual(normalizeProductInputAnswers('QA', { length: '30' }, [integer]), { length: 30 });
  assert.throws(() => normalizeProductInputAnswers('QA', { length: '31' }, [integer]), (error) => /не більшим за 30/.test(error.fieldErrors.length));
  assert.equal(parseStrictDecimal('1,25', decimal.numeric_validation), 1.25);
  assert.throws(() => parseStrictDecimal('1,250', decimal.numeric_validation), (error) => /не більше 2/.test(error.message));
  assert.throws(() => parseStrictDecimal('30', { ...decimal.numeric_validation, maxInclusive: false }), (error) => /меншим за 30/.test(error.message));
  assert.throws(() => resolveProductWeight('30г', null), (error) => /без одиниць виміру/.test(error.fieldErrors.weight));
  assert.deepEqual(normalizeProductInputAnswers('QA', { note: '0012', dimension: '30мм' }, [{ key: 'note', input_type: 'text' }, { key: 'dimension', input_type: 'text' }]), { note: '0012', dimension: '30мм' });
});
