const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getContextualOption,
  inspectNonSkuAnswer,
  inspectSkuAnswer,
} = require('../src/services/product/product-validation');

test('contextual option selection preserves semantic value IDs and prefers specific rules', () => {
  const generic = { value_id: 7, sku_code: 'A', label: 'generic' };
  const contextual = {
    value_id: 7,
    sku_code: 'A',
    label: 'calibrated',
    visible_if_json: { is_calibrated: 2 },
  };

  assert.equal(getContextualOption({ options: [generic, contextual] }, 7, {
    is_calibrated: 2,
  }), contextual);
});

test('normal SKU validation keeps required, unavailable, and placeholder outcomes distinct', () => {
  const required = { key: 'shape', label: 'Shape', required: 1, options: [] };
  assert.equal(inspectSkuAnswer(required, {}, 0).issue, 'required');

  const archived = {
    key: 'shape',
    required: 1,
    options: [{ value_id: 4, sku_code: '9', archived: true }],
  };
  assert.equal(inspectSkuAnswer(archived, { shape: 4 }, 0).issue, 'unavailable');

  const optional = { key: 'size', required: 0, options: [] };
  const placeholder = inspectSkuAnswer(optional, { size: 0 }, 0);
  assert.equal(placeholder.issue, null);
  assert.equal(placeholder.isPlaceholder, true);
});

test('target visibility uses calibration state 2 without boolean normalization', () => {
  const question = {
    key: 'certificate',
    required: 1,
    input_type: 'select',
    visible_if_json: { is_calibrated: 1 },
    options: [{ value_id: 3 }],
  };

  assert.deepEqual(inspectNonSkuAnswer(question, {}, 2), {
    issue: null,
    visible: false,
  });
  assert.equal(inspectNonSkuAnswer(question, {}, 1).issue, 'required');
});
