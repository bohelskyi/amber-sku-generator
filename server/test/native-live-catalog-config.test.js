const test = require('node:test');
const assert = require('node:assert/strict');
const { getPublicConfig } = require('../src/services/sku-schema.service');

function database(enabled) {
  const queries = [];
  const live = (key, value, extra = {}) => ({ q_db_id: key === 'kind' ? 11 : 12,
    category_code: 'XX', key, q_label: 'Live ' + key, sku_index: 1,
    display_order: key === 'kind' ? 1 : 2, required: 1, include_in_sku: 1,
    input_type: 'options', o_db_id: value + 20, value_id: value,
    o_label: 'Live ' + value, o_label_en: 'English ' + value, sku_code: null, ...extra });
  return { queries, async query(sql) {
    queries.push(sql);
    if (sql.includes('FROM public_sku_activation')) return { rows: [{ enabled }] };
    if (sql.includes('FROM categories c')) return { rows: [{ code: 'XX', name: 'Live category', requires_weight: 0, code_mutable: false }] };
    if (sql.includes('FROM questions q')) return { rows: [live('kind', 1, { q_archived: true, o_archived: true }), live('kind', 2), live('new_question', 3)] };
    if (sql.includes('SELECT version FROM sku_schema_versions')) return { rows: [{ version: 1 }] };
    if (sql.includes('SELECT * FROM sku_schema_versions')) return { rows: [{ id: 80, version: 1, marker: '', category_code: 'XX' }] };
    if (sql.includes('FROM sku_schema_questions sq')) return { rows: [{ question_id: 81, question_key: 'kind',
      question_label: 'Frozen kind', sku_index: 1, display_order: 1, required: 1,
      value_id: 1, sku_code: '1', option_label: 'Frozen one', archived: false }] };
    assert.fail('Unexpected query: ' + sql);
  } };
}

test('native public config exposes unpublished live questions, values and archive/English metadata', async () => {
  const db = database(true);
  const config = await getPublicConfig(db);
  assert.deepEqual(config.questions.XX.map(q => q.id), ['kind', 'new_question']);
  assert.deepEqual(config.questions.XX[0].options.map(o => o.id), [1, 2]);
  assert.equal(config.questions.XX[0].archived, 1);
  assert.equal(config.questions.XX[0].options[0].archived, 1);
  assert.equal(config.questions.XX[0].options[1].label_en, 'English 2');
  assert.equal(config.questions.XX[0].options[1].sku_code, null);
  assert.equal(config.categories.XX.sku_schema_version_id, undefined);
  assert.ok(!db.queries.some(sql => sql.includes('SELECT version FROM sku_schema_versions')));
});

test('gate-off public config retains frozen SKU questions and values instead of live encoded changes', async () => {
  const config = await getPublicConfig(database(false));
  assert.deepEqual(config.questions.XX.map(q => q.id), ['kind']);
  assert.equal(config.questions.XX[0].label, 'Frozen kind');
  assert.deepEqual(config.questions.XX[0].options.map(o => o.id), [1]);
  assert.equal(config.questions.XX[0].options[0].label, 'Frozen one');
  assert.equal(config.questions.XX[0].options[0].archived, 0);
  assert.equal(config.categories.XX.sku_schema_version_id, 80);
});
