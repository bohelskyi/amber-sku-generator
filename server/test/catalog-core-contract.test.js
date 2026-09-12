const assert = require('node:assert/strict');
const test = require('node:test');

const catalogService = require('../src/services/catalog.service');
const {
  normalizeInputType,
  normalizeEditableSkuSeparator,
  normalizeCategoryCode,
  normalizeQuestionKey,
  getNormalizedQuestionNumbers,
} = require('../src/services/catalog/catalog-input');
const {
  buildCategoryChanges,
  buildQuestionChanges,
  buildOptionChanges,
} = require('../src/services/catalog/catalog-audit');

test('catalog service keeps its ten-export compatibility surface', () => {
  assert.deepEqual(Object.keys(catalogService), [
    'getAppConfig',
    'createCategory',
    'updateCategory',
    'createQuestion',
    'updateQuestion',
    'createOption',
    'updateOption',
    'setOptionArchived',
    'updateQuestionsOrder',
    'deleteCatalogItem',
  ]);
});

test('catalog input normalization preserves defaults and validation contracts', () => {
  assert.equal(normalizeInputType(' TEXT '), 'text');
  assert.equal(normalizeInputType('unsupported'), 'options');
  assert.equal(normalizeEditableSkuSeparator(' / '), '/');
  assert.equal(normalizeCategoryCode(' br '), 'BR');
  assert.equal(normalizeQuestionKey(' material '), 'material');
  assert.deepEqual(getNormalizedQuestionNumbers({ sku_index: '4' }, 1), {
    skuIndex: 4,
    displayOrder: 4,
  });
  assert.deepEqual(getNormalizedQuestionNumbers({ sku_index: 'bad', display_order: '7' }, 0), {
    skuIndex: 0,
    displayOrder: 7,
  });
  assert.throws(
    () => normalizeEditableSkuSeparator('|'),
    (error) => error.statusCode === 400
      && error.message === 'Розділювач SKU може містити тільки -, _, . або /'
  );
});

test('catalog audit builders preserve semantic changes and sensitive rule markers', () => {
  assert.deepEqual(buildCategoryChanges({
    code: 'AA',
    name: 'Before',
    requires_weight: 1,
    skip_hidden_sku_questions: 0,
  }, {
    nextCode: 'AB',
    name: 'After',
    requiresWeight: 0,
    skipHiddenSkuQuestions: 1,
  }), {
    code: { from: 'AA', to: 'AB' },
    name: { from: 'Before', to: 'After' },
    requiresWeight: { from: 1, to: 0 },
    skipHiddenSkuQuestions: { from: 0, to: 1 },
  });

  assert.deepEqual(buildQuestionChanges({
    key: 'kind',
    label: 'Kind',
    sku_index: 1,
    display_order: 1,
    required: 1,
    include_in_sku: 1,
    input_type: 'options',
    sku_separator: '',
    visible_if_json: { material: 1 },
  }, {
    nextKey: 'kind',
    label: 'Kind',
    skuIndex: 1,
    displayOrder: 2,
    required: 1,
    includeInSku: 1,
    inputType: 'options',
    skuSeparator: '-',
    visibleRule: { material: 2 },
  }), {
    displayOrder: { from: 1, to: 2 },
    skuSeparator: { from: '', to: '-' },
    visibleRule: { changed: true },
  });

  assert.deepEqual(buildOptionChanges({
    value_id: 1,
    sku_code: '01',
    label: 'One',
    visible_if_json: null,
    hidden_if_json: null,
    archived: false,
  }, {
    valueId: 1,
    skuCode: '01',
    label: 'One',
    visibleRule: { material: 1 },
    hiddenRule: null,
    archived: true,
  }), {
    visibleRule: { changed: true },
    archived: { from: false, to: true },
  });
});
