const test = require('node:test');
const assert = require('node:assert/strict');

const {
  analyzeLineage,
  buildSchemaMap,
  getPayloadSchema,
  normalizeStoredChanges,
  normalizeTimelineSku,
} = require('../src/services/product-timeline.service');
const { presentProductTimeline } = require('../src/presenters/product-timeline');

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

test('lineage analysis preserves explicit gaps when link and correction evidence disagree', () => {
  const products = [
    { id: 1, full_sku: 'A', corrected_from_product_id: null, corrected_to_product_id: 2, created_at: '2026-01-01' },
    { id: 2, full_sku: 'B', corrected_from_product_id: 1, corrected_to_product_id: null, created_at: '2026-01-02' },
    { id: 3, full_sku: 'C', corrected_from_product_id: null, corrected_to_product_id: null, created_at: '2026-01-03' },
  ];
  const corrections = [
    { id: 11, source_product_id: 2, corrected_product_id: 3, source_sku: 'B', corrected_sku: 'C' },
  ];

  const result = analyzeLineage(products, corrections);

  assert.deepEqual(result.ordered.map((product) => product.full_sku), ['A', 'B', 'C']);
  assert.deepEqual(result.warnings.map((warning) => warning.code), [
    'MISSING_PRODUCT_LINK',
    'MISSING_CORRECTION_HISTORY',
  ]);
});

test('lineage analysis preserves ambiguous SKU evidence as a non-linear history', () => {
  const products = [
    { id: 1, full_sku: 'DUPLICATE', created_at: '2026-01-01' },
    { id: 2, full_sku: 'DUPLICATE', created_at: '2026-01-02' },
    { id: 3, full_sku: 'TARGET', created_at: '2026-01-03' },
  ];
  const corrections = [
    { id: 12, source_product_id: null, corrected_product_id: null, source_sku: 'DUPLICATE', corrected_sku: 'TARGET' },
  ];

  const result = analyzeLineage(products, corrections);

  assert.deepEqual(result.ordered.map((product) => product.id), [1, 2, 3]);
  assert.deepEqual(result.warnings.map((warning) => warning.code), [
    'NON_LINEAR_ROOTS',
    'NON_LINEAR_ENDPOINTS',
  ]);
});

test('lineage analysis preserves cycle and disconnected evidence warnings', () => {
  const products = [
    { id: 1, full_sku: 'A', corrected_to_product_id: 2, created_at: '2026-01-01' },
    { id: 2, full_sku: 'B', corrected_from_product_id: 1, created_at: '2026-01-02' },
    { id: 3, full_sku: 'C', corrected_to_product_id: 4, corrected_from_product_id: 4, created_at: '2026-01-03' },
    { id: 4, full_sku: 'D', corrected_to_product_id: 3, corrected_from_product_id: 3, created_at: '2026-01-04' },
  ];
  const corrections = [
    { id: 13, source_product_id: 1, corrected_product_id: 2, source_sku: 'A', corrected_sku: 'B' },
    { id: 14, source_product_id: 3, corrected_product_id: 4, source_sku: 'C', corrected_sku: 'D' },
    { id: 15, source_product_id: 4, corrected_product_id: 3, source_sku: 'D', corrected_sku: 'C' },
  ];

  const result = analyzeLineage(products, corrections);

  assert.deepEqual(result.ordered.map((product) => product.full_sku), ['A', 'B', 'C', 'D']);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['LINEAGE_CYCLE']);
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

test('timeline exposes missing historical labels instead of inventing current meanings', () => {
  const changes = normalizeStoredChanges({
    oldPayload: { answers: { removed_question: 7 } },
    newPayload: { answers: { removed_question: 8 } },
    oldSchema: null,
    newSchema: null,
  });

  assert.deepEqual(changes, [{
    kind: 'answer',
    fieldKey: 'removed_question',
    fieldLabel: null,
    before: { value: 7, label: null },
    after: { value: 8, label: null },
    labelStatus: 'not_recorded',
  }]);
});

test('timeline presenter keeps missing audit history explicit and groups legacy request completion', () => {
  const result = presentProductTimeline('SKU-A', {
    products: [{
      id: 1,
      full_sku: 'SKU-A',
      category: 'BR',
      status: 'corrected',
      created_at: '2026-01-01T00:00:00.000Z',
      corrected_from_product_id: null,
      corrected_to_product_id: 2,
      created_by_user_id: null,
      sku_schema_version_id: null,
    }, {
      id: 2,
      full_sku: 'SKU-B',
      category: 'BR',
      status: 'active',
      created_at: '2026-01-02T00:00:00.000Z',
      corrected_from_product_id: 1,
      corrected_to_product_id: null,
      sku_schema_version_id: null,
    }],
    corrections: [{
      id: 10,
      source_product_id: 1,
      corrected_product_id: 2,
      source_sku: 'SKU-A',
      corrected_sku: 'SKU-B',
      old_payload: { totalPriceUah: 100, answers: { removed: 1 } },
      new_payload: { totalPriceUah: 125, answers: { removed: 2 } },
      price_delta_uah: 25,
      reason: 'Legacy correction',
      created_at: '2026-01-02T00:00:00.000Z',
      performed_by_user_id: 7,
    }],
    requests: [{
      id: 20,
      source_product_id: 1,
      corrected_product_id: 2,
      source_sku: 'SKU-A',
      proposed_sku: 'SKU-B',
      old_payload: { answers: { removed: 1 } },
      proposed_payload: { answers: { removed: 2 } },
      changes: [{ key: 'removed', from: 1, to: 2 }],
      comment: '',
      status: 'completed',
      created_at: '2026-01-01T12:00:00.000Z',
      completed_at: '2026-01-02T00:00:00.000Z',
      created_by_user_id: null,
    }],
    repricingItems: [],
    audits: [],
    schemaRows: [],
  });

  assert.equal(result.lineage.integrity, 'ok');
  assert.equal(result.lineage.rootSku, 'SKU-A');
  assert.equal(result.lineage.currentSku, 'SKU-B');
  assert.deepEqual(result.events.map((event) => event.type), [
    'product.created',
    'correction_request.created',
    'correction_request.completed',
    'product.corrected',
  ]);
  assert.equal(result.events[0].actor.status, 'not_recorded');
  assert.equal(result.events[2].timestampStatus, 'recorded');
  assert.equal(result.events[2].actor.status, 'not_recorded');
  assert.equal(result.events[3].actor.status, 'recorded_reference');
  assert.equal(result.events[3].details.applicationMode, 'request');
  assert.equal(result.events[2].groupKey, result.events[3].groupKey);
  assert.equal(result.events[3].changes[0].labelStatus, 'not_recorded');
  assert.equal(JSON.stringify(result).includes('internalGroup'), false);
  assert.equal(JSON.stringify(result).includes('correctionRequestId'), false);
});
