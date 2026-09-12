const assert = require('node:assert/strict');
const test = require('node:test');

const catalogService = require('../src/services/catalog.service');
const catalogReadModel = require('../src/services/catalog/catalog-read-model');
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
const {
  renameJsonObjectKey,
  renameAxisKey,
  rewriteRuleKeyForTarget,
} = require('../src/services/catalog/question-key-references');

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

test('catalog read facade resolves directly to the catalog read model', () => {
  assert.equal(catalogService.getAppConfig, catalogReadModel.getAppConfig);
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

test('question-key transforms preserve nested logical and composite-axis behavior', () => {
  assert.deepEqual(renameJsonObjectKey({
    $and: [
      { old_key: 1 },
      { $or: [{ old_key: [1, 2] }, { other_key: 2 }] },
    ],
    arbitrary: { old_key: 3 },
  }, 'old_key', 'new_key'), {
    $and: [
      { new_key: 1 },
      { $or: [{ new_key: [1, 2] }, { other_key: 2 }] },
    ],
    arbitrary: { old_key: 3 },
  });
  assert.deepEqual(renameJsonObjectKey([{ old_key: 1 }], 'old_key', 'new_key'), [
    { old_key: 1 },
  ]);
  assert.equal(renameAxisKey(' old_key + other_old_key ', 'old_key', 'new_key'),
    'new_key+other_old_key');
  assert.equal(renameAxisKey(null, 'old_key', 'new_key'), null);
});

test('question-key rule rewrites accept only complete static SQL targets', async () => {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  };

  await rewriteRuleKeyForTarget(
    client,
    'optionHidden',
    { id: 17, hidden_if_json: { old_key: 1 } },
    'old_key',
    'new_key'
  );
  assert.deepEqual(calls, [{
    sql: 'UPDATE options SET hidden_if_json = $1::jsonb WHERE id = $2',
    values: ['{"new_key":1}', 17],
  }]);

  await assert.rejects(
    rewriteRuleKeyForTarget(
      client,
      'options; DROP TABLE options',
      { id: 17, hidden_if_json: { old_key: 1 } },
      'old_key',
      'new_key'
    ),
    /Unsupported catalog rule rewrite target/
  );
  assert.equal(calls.length, 1);
});
