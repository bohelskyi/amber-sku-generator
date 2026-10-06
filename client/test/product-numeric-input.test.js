import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNumericAnswers, numericQuestionPolicy, validateNumericInput } from '../src/lib/product-numeric-input.js';

test('strict numeric fields accept comma/dot and semantic zero while refusing partial numeric syntax', () => {
  const decimal = { kind: 'decimal', min: 0, max: 12.3, minInclusive: true, maxInclusive: true, maxFractionDigits: 3 };
  for (const value of ['0', '12,3', '12.300']) assert.equal(validateNumericInput(value, decimal).valid, true);
  for (const value of ['12,3mm', '1e2', '0x10', '1,2.3', '.', '12.3000', '12.301', 'Infinity']) assert.equal(validateNumericInput(value, decimal).valid, false, value);
  assert.equal(validateNumericInput('2.0', { kind: 'integer' }).valid, false);
  assert.equal(validateNumericInput('-1', { kind: 'integer', min: 0, minInclusive: false }).valid, false);
  assert.equal(validateNumericInput('3', { kind: 'integer', max: 3, maxInclusive: false }).valid, false);
  assert.equal(validateNumericInput(0.0000001, { kind: 'decimal', maxFractionDigits: 7 }).valid, true);
  assert.equal(validateNumericInput('1e-7', { kind: 'decimal', maxFractionDigits: 7 }).valid, false);
});

test('numeric normalization preserves genuine text and applies the strict positive canonical weight policy', () => {
  const questions = [{ id: 'code', input_type: 'text' }, { id: 'size', input_type: 'text' }, { id: 'weight', input_type: 'text' }, { id: 'length', input_type: 'text', numeric_validation: { kind: 'decimal', maxFractionDigits: 1 } }];
  assert.deepEqual(normalizeNumericAnswers(questions, { code: '0012', size: '12,3mm', weight: '12,7', length: '0' }, 'SV'), { answers: { code: '0012', size: '12,3mm', weight: 12.7, length: 0 }, fieldErrors: {} });
  assert.equal(validateNumericInput('0', numericQuestionPolicy(questions[2], 'SV')).valid, false);
  assert.equal(validateNumericInput('12.3456', numericQuestionPolicy(questions[2], 'SV')).valid, false);
});


test('integer and decimal suffixes explain omitted units without confusing fractions or limits', () => {
  const integer = { kind: 'integer', unit: 'мм', min: 1, max: 30, maxInclusive: true };
  const decimal = { ...integer, kind: 'decimal', maxFractionDigits: 2 };
  for (const policy of [integer, decimal]) {
    for (const value of ['30мм', '30 мм', '30mm', '30,5мм', '30%', '30/2']) {
      const result = validateNumericInput(value, policy);
      assert.equal(result.valid, false);
      assert.match(result.error, /без одиниць виміру та зайвих символів/);
      assert.equal(Object.hasOwn(result, 'normalized'), false);
    }
  }
  assert.match(validateNumericInput('2,5', integer).error, /ціле число без дробової частини/);
  assert.equal(validateNumericInput('30', integer).normalized, 30);
  assert.match(validateNumericInput('31', integer).error, /не більшим за 30/);
  assert.equal(validateNumericInput('1,25', decimal).normalized, 1.25);
  assert.match(validateNumericInput('1,250', decimal).error, /Не більше 2/);
  assert.match(validateNumericInput('30', { ...decimal, maxInclusive: false }).error, /меншим за 30/);
  assert.deepEqual(normalizeNumericAnswers([{ id: 'dimension', input_type: 'text' }], { dimension: '30мм' }, 'QA'), { answers: { dimension: '30мм' }, fieldErrors: {} });
});
