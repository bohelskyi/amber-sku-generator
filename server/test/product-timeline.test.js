const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeLineage,
  buildSchemaMap,
  getPayloadSchema,
  normalizeStoredChanges,
  normalizeTimelineSku,
} = require('../src/services/product-timeline.service');

test('timeline SKU lookup normalizes exact product identifiers and rejects invalid input', () => {
  assert.equal(normalizeTimelineSku(' br2/123-001 '), 'BR2/123-001');
  assert.throws(() => normalizeTimelineSku(''), (error) => (
    error.statusCode === 400 && error.code === 'INVALID_SKU'
  ));
});

test('lineage analysis orders a bidirectional A to B to C chain', () => {
  const products = [
    { id: 2, full_sku: 'B', corrected_from_product_id: 1, corrected_to_product_id: 3, created_at: '2026-01-02' },
    { id: 3, full_sku: 'C', corrected_from_product_id: 2, corrected_to_product_id: null, created_at: '2026-01-03' },
    { id: 1, full_sku: 'A', corrected_from_product_id: null, corrected_to_product_id: 2, created_at: '2026-01-01' },
  ];
  const corrections = [
    { id: 10, source_product_id: 1, corrected_product_id: 2, source_sku: 'A', corrected_sku: 'B' },
    { id: 11, source_product_id: 2, corrected_product_id: 3, source_sku: 'B', corrected_sku: 'C' },
  ];
  const result = analyzeLineage(products, corrections);
  assert.deepEqual(result.ordered.map((product) => product.full_sku), ['A', 'B', 'C']);
  assert.equal(result.roots[0].full_sku, 'A');
  assert.equal(result.endpoints[0].full_sku, 'C');
  assert.deepEqual(result.warnings, []);
});

test('lineage analysis returns proven non-linear history with integrity warnings', () => {
  const products = [
    { id: 1, full_sku: 'A', corrected_from_product_id: null, corrected_to_product_id: 2, created_at: '2026-01-01' },
    { id: 2, full_sku: 'B', corrected_from_product_id: 1, corrected_to_product_id: null, created_at: '2026-01-02' },
    { id: 3, full_sku: 'C', corrected_from_product_id: 1, corrected_to_product_id: null, created_at: '2026-01-03' },
  ];
  const corrections = [
    { id: 10, source_product_id: 1, corrected_product_id: 2, source_sku: 'A', corrected_sku: 'B' },
    { id: 11, source_product_id: 1, corrected_product_id: 3, source_sku: 'A', corrected_sku: 'C' },
  ];
  const result = analyzeLineage(products, corrections);
  assert.equal(result.ordered.length, 3);
  assert.ok(result.warnings.some((warning) => warning.code === 'MULTIPLE_SUCCESSORS'));
  assert.ok(result.warnings.some((warning) => warning.code === 'NON_LINEAR_ENDPOINTS'));
});

test('timeline changes decode semantic value IDs through each recorded immutable schema', () => {
  const schemas = buildSchemaMap([
    {
      schema_version_id: 4,
      question_key: 'discount',
      question_label: 'Знижка на момент створення',
      option_id: 10,
      value_id: 3,
      option_label: '50%',
      visible_if_json: null,
      hidden_if_json: null,
    },
    {
      schema_version_id: 4,
      question_key: 'material',
      question_label: 'Матеріал',
      option_id: 11,
      value_id: 7,
      option_label: 'Бурштин',
      visible_if_json: null,
      hidden_if_json: null,
    },
    ...[0, 1].map((valueId) => ({
      schema_version_id: 4,
      question_key: 'zero_option',
      question_label: 'Нульове значення',
      option_id: 15 + valueId,
      value_id: valueId,
      option_label: ['Явний нуль', 'Один'][valueId],
      visible_if_json: null,
      hidden_if_json: null,
    })),
    ...[0, 1, 2].map((valueId) => ({
      schema_version_id: 4,
      question_key: 'is_calibrated',
      question_label: 'Історичне калібрування',
      option_id: 20 + valueId,
      value_id: valueId,
      option_label: ['Ні', 'Так', 'Напівкалібрована'][valueId],
      visible_if_json: null,
      hidden_if_json: null,
    })),
    {
      schema_version_id: 5,
      question_key: 'material',
      question_label: 'Матеріал нової схеми',
      option_id: 30,
      value_id: 8,
      option_label: 'Срібло',
      visible_if_json: null,
      hidden_if_json: null,
    },
    {
      schema_version_id: 5,
      question_key: 'is_calibrated',
      question_label: 'Калібрування нової схеми',
      option_id: 31,
      value_id: 2,
      option_label: 'Напівкалібрована нової схеми',
      visible_if_json: null,
      hidden_if_json: null,
    },
  ]);
  const changes = normalizeStoredChanges({
    oldPayload: {
      skuSchemaVersionId: 4,
      answers: {
        discount: 3, size: 2, material: 7, zero_option: 0, is_calibrated: 0, unknown: 9,
      },
    },
    newPayload: {
      skuSchemaVersionId: 5,
      answers: {
        discount: 0, size: 0, material: 8, zero_option: 1, is_calibrated: 2, unknown: 10,
      },
    },
    oldSchema: schemas.get(4),
    newSchema: schemas.get(5),
  });
  const byKey = new Map(changes.map((change) => [change.fieldKey, change]));
  assert.deepEqual(byKey.get('discount').before, { value: 3, label: '50%' });
  assert.deepEqual(byKey.get('discount').after, { value: 0, label: 'Не вказано' });
  assert.deepEqual(byKey.get('size').after, { value: 0, label: 'Не вказано' });
  assert.deepEqual(byKey.get('material').before, { value: 7, label: 'Бурштин' });
  assert.deepEqual(byKey.get('material').after, { value: 8, label: 'Срібло' });
  assert.deepEqual(byKey.get('zero_option').before, { value: 0, label: 'Явний нуль' });
  assert.deepEqual(byKey.get('is_calibrated').before, { value: 0, label: 'Ні' });
  assert.deepEqual(byKey.get('is_calibrated').after, {
    value: 2,
    label: 'Напівкалібрована нової схеми',
  });
  assert.deepEqual(byKey.get('unknown').before, { value: 9, label: null });
  assert.deepEqual(byKey.get('unknown').after, { value: 10, label: null });
});

test('timeline uses payload schema versions before product-row fallbacks', () => {
  const schemas = new Map([[4, 'payload schema'], [3, 'product schema']]);
  assert.equal(getPayloadSchema(schemas, { skuSchemaVersionId: 4 }, 3), 'payload schema');
  assert.equal(getPayloadSchema(schemas, {}, 3), 'product schema');
});

test('timeline preserves calibration states when an old schema did not snapshot the question', () => {
  const changes = normalizeStoredChanges({
    oldPayload: { answers: { is_calibrated: 0 } },
    newPayload: { answers: { is_calibrated: 1 } },
    oldSchema: null,
    newSchema: null,
  });
  assert.equal(changes[0].fieldLabel, 'Калібрування');
  assert.deepEqual(changes[0].before, { value: 0, label: 'Некалібрована' });
  assert.deepEqual(changes[0].after, { value: 1, label: 'Калібрована' });
});
