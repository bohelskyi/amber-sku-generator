const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSkuSuffixDecodeAttempts,
  decodeSkuAnswers,
  parseVariationSku,
} = require('../src/utils/sku');

const arQuestions = [
  {
    key: 'raw_type',
    label: 'Raw type',
    sku_index: 0,
    sku_separator: '',
    required: 1,
    options: [{ id: 1, label: 'Natural' }],
  },
  {
    key: 'category',
    label: 'Category',
    sku_index: 1,
    sku_separator: '',
    required: 1,
    options: [{ id: 2, label: 'Category 2' }],
  },
  {
    key: 'size',
    label: 'Size',
    sku_index: 2,
    sku_separator: '-',
    required: 1,
    options: [{ id: 3, label: 'Size 3' }],
  },
];

function decodeFirstMatchingAttempt(questions, skuWithoutCategory) {
  for (const attempt of buildSkuSuffixDecodeAttempts(skuWithoutCategory)) {
    const decodedAnswers = decodeSkuAnswers(questions, attempt.encodedPart);
    if (decodedAnswers) return { attempt, decodedAnswers };
  }

  return null;
}

test('does not treat a separated sequence SKU as a variation', () => {
  assert.deepEqual(parseVariationSku('AR12-3-001'), {
    normalizedSku: 'AR12-3-001',
    baseFullSku: 'AR12-3-001',
    variationNumber: null,
  });
});

test('treats a separated SKU with a trailing variation as a variation', () => {
  assert.deepEqual(parseVariationSku('AR12-3-001-002'), {
    normalizedSku: 'AR12-3-001-002',
    baseFullSku: 'AR12-3-001',
    variationNumber: 2,
  });
});

test('decodes a SKU with question separators and a three digit suffix', () => {
  const result = decodeFirstMatchingAttempt(arQuestions, '12-3-001');

  assert.equal(result.attempt.encodedPart, '12-3-');
  assert.equal(result.attempt.suffixRaw, '001');
  assert.deepEqual(
    result.decodedAnswers.map((answer) => [answer.key, answer.value_id]),
    [
      ['raw_type', 1],
      ['category', 2],
      ['size', 3],
    ]
  );
});

test('decodes a SKU with question separators and a suffix over 999', () => {
  const result = decodeFirstMatchingAttempt(arQuestions, '12-3-1000');

  assert.equal(result.attempt.encodedPart, '12-3-');
  assert.equal(result.attempt.suffixRaw, '1000');
  assert.deepEqual(
    result.decodedAnswers.map((answer) => [answer.key, answer.value_id]),
    [
      ['raw_type', 1],
      ['category', 2],
      ['size', 3],
    ]
  );
});
