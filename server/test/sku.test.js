const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSkuSuffixDecodeAttempts,
  decodeSkuAnswers,
  decodeStoredSkuAnswers,
  diagnoseSkuAttempts,
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

test('diagnoses the first option code that does not match the configuration', () => {
  const diagnosis = diagnoseSkuAttempts(
    arQuestions,
    buildSkuSuffixDecodeAttempts('19-3-001')
  );

  assert.equal(diagnosis.type, 'invalid_option');
  assert.equal(diagnosis.questionKey, 'category');
  assert.equal(diagnosis.questionLabel, 'Category');
  assert.equal(diagnosis.received, '9');
  assert.deepEqual(diagnosis.expected, [{ code: '2', label: 'Category 2' }]);
});

test('diagnoses characters left after all configured parameters', () => {
  const diagnosis = diagnoseSkuAttempts(
    arQuestions,
    buildSkuSuffixDecodeAttempts('12-3-X001')
  );

  assert.equal(diagnosis.type, 'extra_characters');
  assert.equal(diagnosis.received, 'X');
  assert.equal(diagnosis.questionLabel, null);
});

test('decodes a required historical placeholder from stored product answers', () => {
  const questions = [
    {
      key: 'raw_type',
      label: 'Raw type',
      sku_index: 0,
      sku_separator: '',
      required: 1,
      options: [{ id: 1, label: 'Natural' }],
    },
    {
      key: 'size',
      label: 'Size',
      sku_index: 1,
      sku_separator: '',
      required: 1,
      options: [{ id: 1, label: '5-10' }],
    },
    {
      key: 'shape',
      label: 'Shape',
      sku_index: 2,
      sku_separator: '',
      required: 1,
      options: [{ id: 6, label: 'Round' }],
    },
  ];

  const decoded = decodeStoredSkuAnswers(questions, '106', {
    raw_type: 1,
    shape: 6,
  });

  assert.deepEqual(
    decoded.map((answer) => [answer.key, answer.value_id, answer.is_placeholder]),
    [
      ['raw_type', 1, false],
      ['size', null, true],
      ['shape', 6, false],
    ]
  );
});

test('rejects stored answers that do not reproduce the SKU', () => {
  assert.equal(
    decodeStoredSkuAnswers(arQuestions, '12-4-', {
      raw_type: 1,
      category: 2,
      size: 3,
    }),
    null
  );
});
