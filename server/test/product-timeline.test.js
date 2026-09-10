const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeLineage,
  buildSchemaMap,
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

test('timeline changes use immutable schema labels and preserve calibration zero, one, and two', () => {
  const schemas = buildSchemaMap([
    {
      schema_version_id: 4,
      question_key: 'quality',
      question_label: 'Historical quality',
      option_id: 1,
      value_id: 1,
      option_label: 'First',
      visible_if_json: null,
      hidden_if_json: null,
    },
    {
      schema_version_id: 4,
      question_key: 'quality',
      question_label: 'Historical quality',
      option_id: 2,
      value_id: 2,
      option_label: 'Second',
      visible_if_json: null,
      hidden_if_json: null,
    },
  ]);
  const changes = normalizeStoredChanges({
    oldPayload: { answers: { quality: 1, is_calibrated: 0 }, weight: 2 },
    newPayload: { answers: { quality: 2, is_calibrated: 2 }, weight: 3 },
    oldSchema: schemas.get(4),
    newSchema: schemas.get(4),
  });
  assert.deepEqual(changes[0], {
    kind: 'answer',
    fieldKey: 'quality',
    fieldLabel: 'Historical quality',
    before: { value: 1, label: 'First' },
    after: { value: 2, label: 'Second' },
    labelStatus: 'historical_schema',
  });
  assert.deepEqual(changes[1].before, { value: 0, label: null });
  assert.deepEqual(changes[1].after, { value: 2, label: null });
  assert.equal(changes[2].kind, 'weight');
});
