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

test('timeline omits only placeholder-backed semantic no-op changes', () => {
  const changes = normalizeStoredChanges({
    oldPayload: {
      answers: { extra: 0, is_calibrated: 0, legacy_zero: 0 },
      decodedAnswers: [
        {
          key: 'extra',
          label: 'Додатково',
          value_id: null,
          value_label: 'Не обрано',
          is_placeholder: true,
        },
        {
          key: 'is_calibrated',
          label: 'Калібрування',
          value_id: 0,
          value_label: 'Некалібрована',
          is_placeholder: false,
        },
      ],
    },
    newPayload: { answers: { is_calibrated: 2 } },
    oldSchema: null,
    newSchema: null,
    storedChanges: [
      { key: 'extra', from: 0, to: null },
      { key: 'is_calibrated', from: 0, to: 2 },
      { key: 'legacy_zero', from: 0, to: null },
    ],
  });

  assert.deepEqual(changes.map((change) => change.fieldKey), [
    'is_calibrated',
    'legacy_zero',
  ]);
  assert.deepEqual(changes[0].before, { value: 0, label: 'Некалібрована' });
  assert.deepEqual(changes[0].after, { value: 2, label: 'Напівкалібрована' });
  assert.deepEqual(changes[1].before, { value: 0, label: 'Не вказано' });
  assert.deepEqual(changes[1].after, { value: null, label: null });
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

test('timeline presents complete logical configuration snapshots for applied answer changes', () => {
  const result = presentProductTimeline('BR1002', {
    products: [
      {
        id: 1,
        full_sku: 'BR1001',
        base_sku: 'BR1',
        category: 'BR',
        status: 'corrected',
        created_at: '2026-01-01T08:00:00.000Z',
        corrected_from_product_id: null,
        corrected_to_product_id: 2,
        sku_schema_version_id: 4,
        details: { answers: { kind: 1, is_calibrated: 0 } },
      },
      {
        id: 2,
        full_sku: 'BR2001',
        base_sku: 'BR2',
        category: 'BR',
        status: 'corrected',
        created_at: '2026-01-02T08:00:00.000Z',
        corrected_from_product_id: 1,
        corrected_to_product_id: 3,
        sku_schema_version_id: 4,
        details: { answers: { kind: 2, is_calibrated: 1 } },
      },
      {
        id: 3,
        full_sku: 'BR1002',
        base_sku: 'BR1',
        category: 'BR',
        status: 'active',
        created_at: '2026-01-03T08:00:00.000Z',
        corrected_from_product_id: 2,
        corrected_to_product_id: null,
        sku_schema_version_id: 4,
        details: { answers: { kind: 1, is_calibrated: 2 } },
      },
    ],
    corrections: [
      {
        id: 10,
        source_product_id: 1,
        corrected_product_id: 2,
        source_sku: 'BR1001',
        corrected_sku: 'BR2001',
        old_payload: { answers: { kind: 1, is_calibrated: 0 }, skuSchemaVersionId: 4 },
        new_payload: { answers: { kind: 2, is_calibrated: 1 }, skuSchemaVersionId: 4 },
        created_at: '2026-01-02T08:00:00.000Z',
      },
      {
        id: 11,
        source_product_id: 2,
        corrected_product_id: 3,
        source_sku: 'BR2001',
        corrected_sku: 'BR1002',
        old_payload: { answers: { kind: 2, is_calibrated: 1 }, skuSchemaVersionId: 4 },
        new_payload: { answers: { kind: 1, is_calibrated: 2 }, skuSchemaVersionId: 4 },
        created_at: '2026-01-03T08:00:00.000Z',
      },
    ],
    requests: [{
      id: 20,
      source_product_id: 2,
      corrected_product_id: 3,
      source_sku: 'BR2001',
      proposed_sku: 'BR1002',
      old_payload: { answers: { kind: 2, is_calibrated: 1 } },
      proposed_payload: { answers: { kind: 1, is_calibrated: 2 } },
      changes: [],
      status: 'completed',
      created_at: '2026-01-02T12:00:00.000Z',
      completed_at: '2026-01-03T08:00:00.000Z',
    }],
    repricingItems: [],
    audits: [{
      id: 30,
      event_key: 'product.recounted',
      subject_type: 'product',
      subject_id: '2',
      details: { productCorrectionId: 11, correctionRequestId: 20 },
      occurred_at: '2026-01-03T08:00:00.000Z',
      actor_snapshot: { displayName: 'Worker' },
    }],
    schemaRows: [1, 2].map((valueId) => ({
      schema_version_id: 4,
      schema_version: 1,
      schema_marker: '',
      schema_status: 'archived',
      question_key: 'kind',
      question_label: 'Вид',
      sku_index: 1,
      display_order: 1,
      required: 1,
      sku_separator: '',
      question_visible_if: null,
      option_id: valueId,
      value_id: valueId,
      sku_code: String(valueId),
      option_label: valueId === 1 ? 'Перший' : 'Другий',
      visible_if_json: null,
      hidden_if_json: null,
      option_archived: valueId === 2,
    })),
  });

  assert.equal(result.configurationEvolution.status, 'complete');
  assert.deepEqual(
    result.configurationEvolution.snapshots.map((snapshot) => snapshot.establishingSku),
    ['BR1001', 'BR2001', 'BR1002']
  );
  assert.deepEqual(result.configurationEvolution.snapshots.map((snapshot) => snapshot.source), [
    'product_created',
    'direct_recount',
    'correction_request',
  ]);
  assert.equal(result.configurationEvolution.snapshots[0].isInitial, true);
  assert.equal(result.configurationEvolution.snapshots[2].isCurrent, true);
  assert.equal(result.configurationEvolution.snapshots[2].currentSku, 'BR1002');
  assert.deepEqual(result.configurationEvolution.snapshots[0].fields.map((field) => (
    [field.key, field.value.value, field.value.label]
  )), [
    ['kind', 1, 'Перший'],
    ['is_calibrated', 0, 'Некалібрована'],
  ]);
  assert.deepEqual(result.configurationEvolution.snapshots[2].changes.map((change) => (
    [change.fieldKey, change.before.value, change.after.value]
  )), [
    ['kind', 2, 1],
    ['is_calibrated', 1, 2],
  ]);
});

test('timeline collapses non-answer successors without reinterpreting the establishing schema', () => {
  const result = presentProductTimeline('BR2/1001', {
    products: [
      {
        id: 1,
        full_sku: 'BR1001',
        base_sku: 'BR1',
        category: 'BR',
        weight: 10,
        status: 'corrected',
        created_at: '2026-02-01T08:00:00.000Z',
        corrected_from_product_id: null,
        corrected_to_product_id: 2,
        sku_schema_version_id: 4,
        details: { answers: { kind: 1 } },
      },
      {
        id: 2,
        full_sku: 'BR2/1001',
        base_sku: 'BR2/1',
        category: 'BR',
        weight: 11,
        status: 'active',
        created_at: '2026-02-02T08:00:00.000Z',
        corrected_from_product_id: 1,
        corrected_to_product_id: null,
        sku_schema_version_id: 5,
        details: { answers: { kind: 1 } },
      },
    ],
    corrections: [{
      id: 12,
      source_product_id: 1,
      corrected_product_id: 2,
      source_sku: 'BR1001',
      corrected_sku: 'BR2/1001',
      old_payload: { answers: { kind: 1 }, weight: 10, skuSchemaVersionId: 4 },
      new_payload: { answers: { kind: 1 }, weight: 11, skuSchemaVersionId: 5 },
      created_at: '2026-02-02T08:00:00.000Z',
    }],
    requests: [],
    repricingItems: [],
    audits: [],
    schemaRows: [{
      schema_version_id: 4,
      schema_version: 1,
      schema_marker: '',
      schema_status: 'archived',
      question_key: 'kind',
      question_label: 'Історичний вид',
      sku_index: 1,
      display_order: 1,
      required: 1,
      sku_separator: '',
      question_visible_if: null,
      option_id: 1,
      value_id: 1,
      sku_code: '1',
      option_label: 'Історичне значення',
      visible_if_json: null,
      hidden_if_json: null,
      option_archived: false,
    }, {
      schema_version_id: 5,
      schema_version: 2,
      schema_marker: '2/',
      schema_status: 'active',
      question_key: 'kind',
      question_label: 'Нова назва виду',
      sku_index: 1,
      display_order: 1,
      required: 1,
      sku_separator: '',
      question_visible_if: null,
      option_id: 2,
      value_id: 1,
      sku_code: '1',
      option_label: 'Нова назва значення',
      visible_if_json: null,
      hidden_if_json: null,
      option_archived: false,
    }],
  });

  assert.equal(result.configurationEvolution.snapshots.length, 1);
  const snapshot = result.configurationEvolution.snapshots[0];
  assert.equal(snapshot.establishingSku, 'BR1001');
  assert.deepEqual(snapshot.establishingSchemaVersion, { id: 4, version: 1, marker: '' });
  assert.equal(snapshot.currentSku, 'BR2/1001');
  assert.deepEqual(snapshot.currentSchemaVersion, { id: 5, version: 2, marker: '2/' });
  assert.equal(snapshot.fields[0].fieldLabel, 'Історичний вид');
  assert.equal(snapshot.fields[0].value.label, 'Історичне значення');
  assert.equal(snapshot.occurredAt, '2026-02-01T08:00:00.000Z');
  assert.equal(snapshot.source, 'product_created');
});

test('timeline marks immutable-SKU-only legacy reconstruction as partial and ambiguity unavailable', () => {
  const legacy = presentProductTimeline('BR1001', {
    products: [{
      id: 1,
      full_sku: 'BR1001',
      base_sku: 'BR1',
      category: 'BR',
      status: 'active',
      created_at: null,
      corrected_from_product_id: null,
      corrected_to_product_id: null,
      sku_schema_version_id: 4,
      details: {},
    }],
    corrections: [], requests: [], repricingItems: [], audits: [],
    schemaRows: [{
      schema_version_id: 4,
      schema_version: 1,
      schema_marker: '',
      schema_status: 'active',
      question_key: 'kind',
      question_label: 'Вид',
      sku_index: 1,
      display_order: 1,
      required: 1,
      sku_separator: '',
      question_visible_if: null,
      option_id: 1,
      value_id: 1,
      sku_code: '1',
      option_label: 'Перший',
      visible_if_json: null,
      hidden_if_json: null,
      option_archived: false,
    }],
  });
  assert.equal(legacy.configurationEvolution.status, 'partial');
  assert.equal(legacy.configurationEvolution.snapshots[0].completeness, 'partial');
  assert.deepEqual(legacy.configurationEvolution.snapshots[0].fields[0].value, {
    value: 1,
    label: 'Перший',
  });

  const ambiguous = presentProductTimeline('DUPLICATE', {
    products: [
      { id: 1, full_sku: 'DUPLICATE', category: 'BR', created_at: '2026-01-01' },
      { id: 2, full_sku: 'DUPLICATE', category: 'BR', created_at: '2026-01-02' },
      { id: 3, full_sku: 'TARGET', category: 'BR', created_at: '2026-01-03' },
    ],
    corrections: [{
      id: 13,
      source_product_id: null,
      corrected_product_id: null,
      source_sku: 'DUPLICATE',
      corrected_sku: 'TARGET',
    }],
    requests: [], repricingItems: [], audits: [], schemaRows: [],
  });
  assert.equal(ambiguous.configurationEvolution.status, 'unavailable');
  assert.deepEqual(ambiguous.configurationEvolution.snapshots, []);
});

test('configuration evidence fills missing keys but omits conflicts and never borrows another schema', () => {
  const result = presentProductTimeline('BR1001', {
    products: [{
      id: 1, full_sku: 'BR1001', base_sku: 'BR1', category: 'BR',
      sku_schema_version_id: 4, status: 'active', created_at: '2026-01-01',
      details: { answers: { kind: 1, disputed: 1 } },
    }, {
      id: 2, full_sku: 'BR2001', base_sku: 'BR2', category: 'BR',
      sku_schema_version_id: 5, status: 'active', created_at: '2026-01-02',
      details: { answers: { kind: 2, disputed: 2 } },
    }],
    corrections: [{
      id: 9, source_product_id: 1, corrected_product_id: 2,
      source_sku: 'BR1001', corrected_sku: 'BR2001',
      old_payload: { skuSchemaVersionId: 4, answers: { kind: 1, extra: 0, disputed: 2 } },
      new_payload: { skuSchemaVersionId: 99, answers: { kind: 2, disputed: 1 } },
    }],
    requests: [], repricingItems: [], audits: [],
    schemaRows: [{
      schema_version_id: 5, schema_version: 2, schema_marker: '2/',
      question_key: 'kind', question_label: 'New schema kind',
      option_id: 2, value_id: 2, sku_code: '2', option_label: 'New schema label',
    }],
  });
  const [initial, successor] = result.configurationEvolution.snapshots;
  assert.equal(result.configurationEvolution.status, 'partial');
  assert.deepEqual(initial.fields.map((field) => [field.key, field.value.value]), [
    ['extra', 0], ['kind', 1],
  ]);
  assert.equal(initial.fields.some((field) => field.key === 'disputed'), false);
  assert.deepEqual(initial.establishingSchemaVersion, { id: 4, version: null, marker: null });
  assert.equal(initial.fields.find((field) => field.key === 'kind').value.label, null);
  assert.equal(successor.establishingSchemaVersion.id, 5);
  assert.equal(successor.fields.find((field) => field.key === 'kind').value.label, null);
  assert.equal(successor.fields.some((field) => field.key === 'disputed'), false);
  assert.ok(result.configurationEvolution.warnings.some((item) => (
    item.code === 'CONFIGURATION_EVIDENCE_CONFLICT'
  )));
  assert.ok(result.configurationEvolution.warnings.some((item) => (
    item.code === 'HISTORICAL_SCHEMA_MISSING'
  )));
});

test('configuration evolution derives a legacy answer transition from stored products when correction payload answers are missing', () => {
  const result = presentProductTimeline('BR2001', {
    products: [{
      id: 1, full_sku: 'BR1001', category: 'BR', sku_schema_version_id: 4,
      details: { answers: { kind: 1 } }, corrected_to_product_id: 2,
    }, {
      id: 2, full_sku: 'BR2001', category: 'BR', sku_schema_version_id: 4,
      details: { answers: { kind: 2 } }, corrected_from_product_id: 1,
    }],
    corrections: [{
      id: 9, source_product_id: 1, corrected_product_id: 2,
      source_sku: 'BR1001', corrected_sku: 'BR2001', old_payload: {}, new_payload: {},
    }],
    requests: [], repricingItems: [], audits: [],
    schemaRows: [1, 2].map((value) => ({
      schema_version_id: 4, schema_version: 1, schema_marker: '',
      question_key: 'kind', question_label: 'Kind', sku_index: 1,
      option_id: value, value_id: value, sku_code: String(value),
      option_label: `Value ${value}`,
    })),
  });
  assert.deepEqual(result.configurationEvolution.snapshots.map((snapshot) => (
    snapshot.establishingSku
  )), ['BR1001', 'BR2001']);
  assert.deepEqual(result.configurationEvolution.snapshots[1].changes.map((change) => [
    change.fieldKey, change.before.value, change.after.value,
  ]), [['kind', 1, 2]]);
  assert.deepEqual(result.configurationEvolution.snapshots[1].fields[0].value, {
    value: 2, label: 'Value 2',
  });
});

test('legacy SKU-only reconstruction refuses ambiguous parses and visibility-dependent questions', () => {
  const product = {
    id: 1, full_sku: 'BR111001', base_sku: 'BR111', category: 'BR',
    sku_schema_version_id: 4, details: {}, status: 'active',
  };
  const schemaRows = [
    ['first', 1, 1, '1'], ['first', 1, 11, '11'],
    ['second', 2, 1, '1'], ['second', 2, 11, '11'],
  ].map(([key, index, value, code], optionIndex) => ({
    schema_version_id: 4, schema_version: 1, schema_marker: '',
    question_key: key, question_label: key, sku_index: index, required: 1,
    option_id: optionIndex + 1, value_id: value, sku_code: code, option_label: code,
  }));
  const data = { products: [product], corrections: [], requests: [],
    repricingItems: [], audits: [], schemaRows };
  const ambiguous = presentProductTimeline(product.full_sku, data);
  assert.equal(ambiguous.configurationEvolution.status, 'unavailable');
  assert.deepEqual(ambiguous.configurationEvolution.snapshots[0].fields, []);

  const visibilityDependent = presentProductTimeline(product.full_sku, {
    ...data,
    schemaRows: schemaRows.map((row) => ({
      ...row, question_visible_if: row.question_key === 'first' ? { kind: 1 } : null,
    })),
  });
  assert.equal(visibilityDependent.configurationEvolution.status, 'unavailable');
  assert.deepEqual(visibilityDependent.configurationEvolution.snapshots[0].fields, []);
});

test('configuration evolution refuses a dangling successor even if its loaded products appear linear', () => {
  const result = presentProductTimeline('BR1001', {
    products: [{
      id: 1, full_sku: 'BR1001', category: 'BR',
      status: 'corrected', corrected_to_product_id: 999,
      details: { answers: { kind: 1 } },
    }],
    corrections: [], requests: [], repricingItems: [], audits: [], schemaRows: [],
  });
  assert.equal(result.configurationEvolution.status, 'unavailable');
  assert.deepEqual(result.configurationEvolution.snapshots, []);
});

test('configuration snapshots keep genuine and hidden historical zero values but omit placeholder no-ops', () => {
  const states = [
    { kind: 1, option_zero: 0, optional: 0, is_calibrated: 0 },
    { kind: 1, option_zero: 1, optional: null, is_calibrated: 1 },
    { kind: 1, option_zero: 1, optional: null, is_calibrated: 2 },
  ];
  const schemaOptions = [
    ['kind', 1, '1', 'Archived hidden kind', true, { flag: 1 }],
    ['option_zero', 0, '0', 'Real zero', false, null],
    ['option_zero', 1, '1', 'Other', false, null],
    ['optional', 1, '1', 'Selected', false, null],
  ];
  const result = presentProductTimeline('BR3001', {
    products: states.map((answers, index) => ({
      id: index + 1, full_sku: `BR${index + 1}001`, category: 'BR',
      sku_schema_version_id: 4, details: { answers },
      corrected_from_product_id: index || null,
      corrected_to_product_id: index < 2 ? index + 2 : null,
    })),
    corrections: [0, 1].map((index) => ({
      id: index + 10, source_product_id: index + 1, corrected_product_id: index + 2,
      source_sku: `BR${index + 1}001`, corrected_sku: `BR${index + 2}001`,
      old_payload: {
        skuSchemaVersionId: 4, answers: states[index],
        decodedAnswers: index === 0 ? [{
          key: 'optional', value_id: null, is_placeholder: true, value_label: 'Не обрано',
        }] : [],
      },
      new_payload: { skuSchemaVersionId: 4, answers: states[index + 1] },
    })),
    requests: [], repricingItems: [], audits: [],
    schemaRows: schemaOptions.map(([key, value, code, label, archived, hidden], index) => ({
      schema_version_id: 4, schema_version: 1, schema_marker: '',
      question_key: key, question_label: key, sku_index: index + 1,
      option_id: index + 1, value_id: value, sku_code: code,
      option_label: label, option_archived: archived, hidden_if_json: hidden,
    })),
  });
  const snapshots = result.configurationEvolution.snapshots;
  assert.equal(result.configurationEvolution.status, 'complete');
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[0].fields.find((field) => field.key === 'kind').value.label, 'Archived hidden kind');
  assert.deepEqual(snapshots[0].fields.find((field) => field.key === 'option_zero').value, {
    value: 0, label: 'Real zero',
  });
  assert.equal(snapshots[0].fields.find((field) => field.key === 'optional').value.label, 'Не обрано');
  assert.deepEqual(snapshots[1].changes.map((change) => change.fieldKey), [
    'option_zero', 'is_calibrated',
  ]);
  assert.deepEqual(snapshots.map((snapshot) => (
    snapshot.fields.find((field) => field.key === 'is_calibrated').value.value
  )), [0, 1, 2]);
});

test('SKU-only legacy evidence keeps a proven value without guessing among contextual labels', () => {
  const result = presentProductTimeline('BR1001', {
    products: [{
      id: 1, full_sku: 'BR1001', base_sku: 'BR1', category: 'BR',
      status: 'active', sku_schema_version_id: 4, details: {},
    }],
    corrections: [], requests: [], repricingItems: [], audits: [],
    schemaRows: ['Context A', 'Context B'].map((label, index) => ({
      schema_version_id: 4, schema_version: 1, schema_marker: '',
      question_key: 'kind', question_label: 'Kind', sku_index: 1, required: 1,
      option_id: index + 1, value_id: 1, sku_code: '1', option_label: label,
      visible_if_json: { other: index + 1 },
    })),
  });
  assert.equal(result.configurationEvolution.status, 'partial');
  assert.deepEqual(result.configurationEvolution.snapshots[0].fields[0].value, {
    value: 1, label: null,
  });
});
