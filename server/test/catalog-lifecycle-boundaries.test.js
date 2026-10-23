const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogDb, mutationOptions } = require('./helpers/catalog-command-db');
const commands = require('../src/services/catalog/catalog-lifecycle-commands');

const rows = (...values) => ({ rows: values });
const question = { id: 7, category_code: 'SV', key: 'shape', label: 'Форма', archived: false, option_count: '3' };
const option = { id: 8, category_code: 'SV', question_id: 7, question_key: 'shape', key: 'shape',
  value_id: '0', sku_code: '2', label: 'Варіант', archived: false, product_count: 0 };

for (const method of ['setOptionArchived', 'setQuestionArchived']) {
  test(`${method} refuses coercible or missing archive decisions before connecting`, async t => {
    const db = catalogDb(t);
    for (const archived of [undefined, null, 0, 1, 'false', 'true', {}]) {
      await assert.rejects(commands[method]({ id: 7, archived }, mutationOptions), { statusCode: 400 });
    }
    assert.equal(db.connections, 0);
  });
  test(`${method} refuses a missing row and releases its lock`, async t => {
    const db = catalogDb(t, { respond: sql => sql.startsWith('SELECT ') ? rows() : undefined });
    await assert.rejects(commands[method]({ id: 7, archived: true }, mutationOptions), { statusCode: 404 });
    assert.deepEqual(db.writes(), []);
    db.assertFinished('ROLLBACK');
  });
  test(`${method} keeps an already archived item as a no-op without another audit`, async t => {
    const item = method === 'setOptionArchived' ? option : question;
    const db = catalogDb(t, { respond: sql => sql.startsWith('SELECT ') ? rows({ ...item, archived: true }) : undefined });
    await commands[method]({ id: item.id, archived: true }, mutationOptions);
    assert.deepEqual(db.writes(), []);
    assert.deepEqual(db.events, []);
    db.assertFinished();
  });
  for (const archived of [true, false]) {
    test(`${method} records the ${archived ? 'archive' : 'restore'} transition without changing semantic identity`, async t => {
      const isOption = method === 'setOptionArchived';
      const item = isOption ? option : question;
      const table = isOption ? 'options' : 'questions';
      const db = catalogDb(t, { respond(sql, values) {
        if (sql.startsWith('SELECT ')) return rows({ ...item, archived: !archived });
        assert.match(sql, new RegExp(`^UPDATE ${table} SET archived\\s*=\\s*\\$1 WHERE id\\s*=\\s*\\$2$`));
        assert.deepEqual(values, [archived, item.id]);
        return rows();
      } });
      await commands[method]({ id: String(item.id), archived }, mutationOptions);
      assert.equal(db.writes().length, 1);
      assert.equal(db.events[0].key, `catalog.${isOption ? 'option' : 'question'}.${archived ? 'archived' : 'unarchived'}`);
      assert.equal(db.events[0].actor, 42);
      assert.equal(db.events[0].subjectId, String(item.id));
      if (isOption) assert.deepEqual(db.events[0].details, { categoryCode: 'SV', questionId: 7, questionKey: 'shape', valueId: 0, label: 'Варіант' });
      db.assertFinished();
    });
  }
}

test('archive audit failure cannot commit an item change', async t => {
  const failure = new Error('audit unavailable');
  const db = catalogDb(t, { auditError: failure, respond(sql) {
    if (sql.startsWith('SELECT ')) return rows(question);
    if (sql.startsWith('UPDATE questions SET archived=')) return rows();
    return undefined;
  } });
  await assert.rejects(commands.setQuestionArchived({ id: 7, archived: true }, mutationOptions), error => error === failure);
  db.assertFinished('ROLLBACK');
  assert.deepEqual(db.events, []);
});

test('question reorder refuses missing scope and non-finite coordinates before connecting', async t => {
  const db = catalogDb(t);
  for (const input of [
    { category_code: '', questions: [{ id: 7, display_order: 1 }] },
    { category_code: 'SV', questions: [] }, { category_code: 'SV', questions: {} },
    ...[{ id: 'wrong', display_order: 1 }, { id: 7, display_order: Infinity },
      { id: 7, display_order: 1, sku_index: 'wrong' }].map(value => ({ category_code: 'SV', questions: [value] })),
  ]) await assert.rejects(commands.updateQuestionsOrder(input, mutationOptions), { statusCode: 400 });
  assert.equal(db.connections, 0);
});

for (const [label, questions] of [
  ['null', [null]],
  ['undefined', [undefined]],
  ['a sparse entry', new Array(1)],
  ['a string', ['question']],
  ['a number', [7]],
  ['a boolean', [false]],
  ['an array', [[]]],
  ['a nested array of questions', [[{ id: 7, display_order: 1 }]]],
  ['a valid question followed by null', [{ id: 7, display_order: 1 }, null]],
  ['null followed by a valid question', [null, { id: 7, display_order: 1 }]],
]) {
  test(`question reorder rejects ${label} before any database access`, async t => {
    const db = catalogDb(t);
    await assert.rejects(commands.updateQuestionsOrder({ category_code: 'SV', questions }, mutationOptions), {
      statusCode: 400,
      message: 'Некоректні дані порядку питань',
    });
    assert.equal(db.connections, 0);
    assert.deepEqual(db.queries, []);
    assert.deepEqual(db.events, []);
  });
}

test('question reorder preserves omitted SKU positions and audits only actual changes', async t => {
  const db = catalogDb(t, { respond(sql, values) {
    if (sql.startsWith('SELECT id, display_order, sku_index ')) {
      assert.deepEqual(values, ['SV', [7, 8, 9]]);
      return rows({ id: '7', display_order: 0, sku_index: 0 }, { id: '8', display_order: 3, sku_index: 2 },
        { id: '9', display_order: 4, sku_index: 3 });
    }
    assert.match(sql, /^UPDATE questions SET display_order = \$1, sku_index = COALESCE\(\$2, sku_index\) WHERE id = \$3$/);
    assert.ok([[1, 4, 8], [2, null, 9]].some(expected => JSON.stringify(expected) === JSON.stringify(values)));
    return rows();
  } });
  assert.deepEqual(await commands.updateQuestionsOrder({ category_code: ' sv ', questions: [
    { id: '7', display_order: '0', sku_index: '' }, { id: 8, display_order: 1, sku_index: 4 },
    { id: 9, display_order: 2 },
  ] }, mutationOptions), { success: true });
  assert.equal(db.writes().length, 2);
  assert.deepEqual(db.events[0].details, { categoryCode: 'SV', changedQuestionIds: [8, 9], changedCount: 2 });
  db.assertFinished();
});

test('an unchanged question order performs no writes and emits no success audit', async t => {
  const db = catalogDb(t, { respond: sql => sql.startsWith('SELECT id, display_order, sku_index ')
    ? rows({ id: 7, display_order: 0, sku_index: 2 }) : undefined });
  await commands.updateQuestionsOrder({ category_code: 'SV', questions: [{ id: 7, display_order: 0, sku_index: null }] }, mutationOptions);
  assert.deepEqual(db.writes(), []);
  assert.deepEqual(db.events, []);
  db.assertFinished();
});

test('a reorder write failure rolls back and releases the lifecycle boundary', async t => {
  const failure = new Error('write failed');
  const db = catalogDb(t, { respond(sql) {
    if (sql.startsWith('SELECT id, display_order, sku_index ')) return rows({ id: 7, display_order: 0, sku_index: 2 });
    if (sql.startsWith('UPDATE questions SET display_order ')) throw failure;
    return undefined;
  } });
  await assert.rejects(commands.updateQuestionsOrder({ category_code: 'SV', questions: [{ id: 7, display_order: 1 }] }, mutationOptions), error => error === failure);
  assert.deepEqual(db.events, []);
  db.assertFinished('ROLLBACK');
});

test('catalog deletion refuses an unsupported type before acquiring a connection', async t => {
  const db = catalogDb(t);
  await assert.rejects(commands.deleteCatalogItem('products; DROP TABLE products', 7, mutationOptions), { statusCode: 400 });
  assert.equal(db.connections, 0);
});

for (const type of ['question', 'option']) {
  test(`${type} deletion cannot turn local deletion into a remote operation`, async t => {
    const db = catalogDb(t);
    await assert.rejects(commands.deleteCatalogItem(type, 7, { ...mutationOptions, scope: 'both' }), { statusCode: 501 });
    assert.deepEqual(db.writes(), []);
    assert.deepEqual(db.events, []);
    db.assertFinished('ROLLBACK');
  });
}

function impactFixture(t, { type = 'question', auditError } = {}) {
  const item = { ...(type === 'question' ? question : option) };
  const counts = { products: 0, category_products: 0, published_schemas: 0, characteristic_versions: 0,
    magento_bindings: 0, published_templates: 0, template_drafts: 0, options: 3 };
  const db = catalogDb(t, { auditError, respond(sql, values) {
    if (sql.startsWith('SELECT (SELECT COUNT(*)::int FROM products ')) return rows({ ...counts });
    if (sql.startsWith("SELECT 'question' AS kind")) return rows();
    if (sql.startsWith('SELECT ')) { assert.deepEqual(values, [item.id]); return rows({ ...item }); }
    if (sql === `DELETE FROM ${type === 'question' ? 'questions' : 'options'} WHERE id = $1`) {
      assert.deepEqual(values, [item.id]); return rows();
    }
    return undefined;
  } });
  return { db, counts, item,
    async preview() {
      const impact = await commands.getCatalogItemImpact(type, item.id, db.client);
      return { ...mutationOptions, confirmation: impact.confirmation, impactHash: impact.impactHash };
    },
  };
}

test('a newly discovered catalog dependency invalidates an earlier deletion review', async t => {
  const f = impactFixture(t);
  const reviewed = await f.preview();
  f.counts.category_products = 1;
  await assert.rejects(commands.deleteCatalogItem('question', 7, reviewed), error => error.statusCode === 409 && error.impact.canDeleteLocal === false);
  assert.deepEqual(f.db.writes(), []);
  f.db.assertFinished('ROLLBACK');
});

for (const change of ['confirmation', 'impactHash']) {
  test(`local deletion requires the exact reviewed ${change}`, async t => {
    const f = impactFixture(t);
    const reviewed = await f.preview();
    await assert.rejects(commands.deleteCatalogItem('question', 7, { ...reviewed, [change]: 'stale' }), { statusCode: 409 });
    assert.deepEqual(f.db.writes(), []);
    assert.deepEqual(f.db.events, []);
    f.db.assertFinished('ROLLBACK');
  });
}

test('an option used after impact review is rechecked under its lock and cannot be deleted', async t => {
  const f = impactFixture(t, { type: 'option' });
  const reviewed = await f.preview();
  f.item.product_count = 2;
  await assert.rejects(commands.deleteCatalogItem('option', 8, reviewed), { statusCode: 409 });
  assert.deepEqual(f.db.writes(), []);
  assert.deepEqual(f.db.events, []);
  f.db.assertFinished('ROLLBACK');
});

for (const type of ['question', 'option']) {
  test(`an exact unused ${type} deletion records immutable semantic evidence`, async t => {
    const f = impactFixture(t, { type });
    await commands.deleteCatalogItem(type, f.item.id, await f.preview());
    assert.equal(f.db.writes().length, 1);
    assert.equal(f.db.events[0].key, `catalog.${type}.deleted`);
    assert.deepEqual(f.db.events[0].details.affectedCounts, type === 'question' ? { options: 3 } : { products: 0 });
    if (type === 'option') {
      assert.equal(f.db.events[0].details.valueId, 0);
      assert.equal(f.db.events[0].details.skuCode, '2');
    }
    f.db.assertFinished();
  });
}

test('local deletion cannot commit without its durable audit', async t => {
  const failure = new Error('audit insert failed');
  const f = impactFixture(t, { auditError: failure });
  await assert.rejects(commands.deleteCatalogItem('question', 7, await f.preview()), error => error === failure);
  assert.deepEqual(f.db.events, []);
  f.db.assertFinished('ROLLBACK');
});

for (const [type, item, expected] of [
  ['category', { code: 'ZZ', name: 'Тимчасова' }, { questions: 2, options: 3, scenarios: 1, matrixCells: 4, weightBands: 2, modifiers: 1 }],
  ['modifier', { id: 7, category_code: 'SV', trigger_key: 'shape', trigger_val: null, factor: '1.25' }, {}],
  ['scenario', { id: 7, category_code: 'SV', name: 'Сценарій', matrix_cell_count: '4', weight_band_count: '2' }, { matrixCells: 4, weightBands: 2 }],
]) {
  test(`${type} deletion records the actual affected counts`, async t => {
    const id = type === 'category' ? 'ZZ' : 7;
    const db = catalogDb(t, { respond(sql, values) {
      assert.deepEqual(values, [id]);
      if (sql.startsWith('SELECT (SELECT COUNT(*)::int FROM questions ')) return rows({ questions: '2', options: '3', scenarios: '1', matrix_cells: '4', weight_bands: '2', modifiers: '1' });
      if (sql.startsWith('SELECT ')) return rows(item);
      if (sql.startsWith('DELETE FROM ')) return rows();
      return undefined;
    } });
    await commands.deleteCatalogItem(type, id, mutationOptions);
    assert.equal(db.writes().length, 1);
    assert.deepEqual(db.events[0].details.affectedCounts, expected);
    if (type === 'modifier') { assert.equal(db.events[0].details.triggerValue, null); assert.equal(db.events[0].details.factor, 1.25); }
    db.assertFinished();
  });
  test(`deleting an absent ${type} emits no false success audit`, async t => {
    const db = catalogDb(t, { respond: sql => sql.startsWith('SELECT ') ? rows() : undefined });
    await commands.deleteCatalogItem(type, type === 'category' ? 'ZZ' : 7, mutationOptions);
    assert.deepEqual(db.writes(), []);
    assert.deepEqual(db.events, []);
    db.assertFinished();
  });
}
