const test = require('node:test');
const assert = require('node:assert/strict');
const { catalogDb, mutationOptions } = require('./helpers/catalog-command-db');
const { createCategory, updateCategory } = require('../src/services/catalog/category-commands');

const current = { code: 'SV', name: 'Сувеніри', requires_weight: 1, skip_hidden_sku_questions: 0,
  marketing_rounding_enabled: 0, sku_publication_mode: 'explicit' };
const edit = { code: 'SV', name: current.name };
const rows = (...values) => ({ rows: values });

test('category creation refuses ambiguous marketing flags before acquiring a connection', async t => {
  const db = catalogDb(t);
  for (const value of [null, '0', '1', 2, -1, NaN, {}]) {
    await assert.rejects(createCategory({ code: 'SV', name: 'Сувеніри', marketing_rounding_enabled: value }, mutationOptions), { statusCode: 400 });
  }
  assert.equal(db.connections, 0);
});

test('category writes require a local mutation actor before acquiring a connection', async t => {
  const db = catalogDb(t);
  for (const command of [createCategory, updateCategory]) await assert.rejects(command(edit), /actor user ID/);
  assert.equal(db.connections, 0);
});

for (const [name, flags, expected] of [
  ['defaults', {}, [1, 0, 1]],
  ['explicit false', { requires_weight: false, skip_hidden_sku_questions: true, marketing_rounding_enabled: false }, [0, 1, 0]],
  ['explicit true', { requires_weight: '1', skip_hidden_sku_questions: '0', marketing_rounding_enabled: true }, [1, 0, 1]],
]) {
  test(`new category ${name} uses explicit publication and an atomic attributed audit`, async t => {
    const db = catalogDb(t, { respond(sql, values) {
      assert.match(sql, /^INSERT INTO categories .*'explicit'\)$/);
      assert.deepEqual(values, ['ZZ', 'Нова', ...expected]);
      return rows();
    } });
    assert.deepEqual(await createCategory({ code: ' zz ', name: 'Нова', ...flags }, mutationOptions), { id: 'ZZ', name: 'Нова' });
    assert.deepEqual(db.events, [{ key: 'catalog.category.created', actor: 42, subjectType: 'catalog_category', subjectId: 'ZZ',
      requestId: 'catalog-unit-request', details: { code: 'ZZ', name: 'Нова', requiresWeight: expected[0],
        skipHiddenSkuQuestions: expected[1], marketingRoundingEnabled: expected[2] } }]);
    db.assertFinished();
  });
}

test('category creation never commits when its audit insert fails', async t => {
  const failure = new Error('audit storage failed');
  const db = catalogDb(t, { auditError: failure, respond: sql => /^INSERT INTO categories /.test(sql) ? rows() : undefined });
  await assert.rejects(createCategory({ code: 'ZZ', name: 'Нова' }, mutationOptions), error => error === failure);
  assert.equal(db.events.length, 0);
  db.assertFinished('ROLLBACK');
});

test('an unchanged category retains disabled marketing rounding without a write or audit', async t => {
  const db = catalogDb(t, { respond(sql, values) {
    assert.match(sql, /^SELECT \* FROM categories .*FOR UPDATE$/);
    assert.deepEqual(values, ['SV']);
    return rows(current);
  } });
  assert.deepEqual(await updateCategory({ ...edit, code: ' sv ' }, mutationOptions), { code: 'SV' });
  assert.deepEqual(db.writes(), []);
  assert.deepEqual(db.events, []);
  db.assertFinished();
});

test('ordinary category edits preserve omitted rounding and audit only changed fields', async t => {
  const db = catalogDb(t, { respond(sql, values) {
    if (sql.startsWith('SELECT * FROM categories ')) return rows(current);
    assert.match(sql, /^UPDATE categories SET name = \$1/);
    assert.deepEqual(values, ['Оновлена', 1, 0, 0, 'SV']);
    return rows();
  } });
  await updateCategory({ ...edit, name: 'Оновлена' }, mutationOptions);
  assert.deepEqual(db.events[0].details, { code: 'SV', changes: { name: { from: current.name, to: 'Оновлена' } } });
  assert.equal(db.writes().length, 1);
  db.assertFinished();
});

test('an invalid category edit rolls back the locked read before any update', async t => {
  const db = catalogDb(t, { respond: sql => sql.startsWith('SELECT * FROM categories ') ? rows(current) : undefined });
  await assert.rejects(updateCategory({ ...edit, marketing_rounding_enabled: 'false' }, mutationOptions), { statusCode: 400 });
  assert.deepEqual(db.writes(), []);
  assert.deepEqual(db.events, []);
  db.assertFinished('ROLLBACK');
});

test('a missing same-code compatibility update remains a no-op without inventing an audit', async t => {
  const db = catalogDb(t, { respond: sql => sql.startsWith('SELECT * FROM categories ') ? rows() : undefined });
  assert.deepEqual(await updateCategory(edit, mutationOptions), { code: 'SV' });
  assert.deepEqual(db.writes(), []);
  assert.deepEqual(db.events, []);
  db.assertFinished();
});

test('renaming a missing category is refused and releases the transaction', async t => {
  const db = catalogDb(t, { respond: sql => sql.startsWith('SELECT * FROM categories ') ? rows() : undefined });
  await assert.rejects(updateCategory({ ...edit, next_code: 'ZZ' }, mutationOptions), { statusCode: 404 });
  assert.deepEqual(db.writes(), []);
  db.assertFinished('ROLLBACK');
});

test('a used category code is immutable even when the proposed replacement is otherwise valid', async t => {
  const db = catalogDb(t, { respond(sql, values) {
    if (sql.startsWith('SELECT * FROM categories ')) return rows(current);
    assert.match(sql, /^SELECT EXISTS/);
    assert.match(sql, /sku_registry/);
    assert.match(sql, /published_at IS NOT NULL/);
    assert.deepEqual(values, ['SV']);
    return rows({ used: true });
  } });
  await assert.rejects(updateCategory({ ...edit, next_code: 'ZZ' }, mutationOptions), { statusCode: 409 });
  assert.deepEqual(db.writes(), []);
  assert.deepEqual(db.events, []);
  db.assertFinished('ROLLBACK');
});

test('renaming to an existing category is refused before copying any dependency', async t => {
  const db = catalogDb(t, { respond(sql, values) {
    if (sql.startsWith('SELECT * FROM categories ')) return rows(current);
    if (sql.startsWith('SELECT EXISTS')) return rows({ used: false });
    assert.equal(sql, 'SELECT code FROM categories WHERE code = $1');
    assert.deepEqual(values, ['ZZ']);
    return rows({ code: 'ZZ' });
  } });
  await assert.rejects(updateCategory({ ...edit, next_code: 'ZZ' }, mutationOptions), { statusCode: 400 });
  assert.deepEqual(db.writes(), []);
  db.assertFinished('ROLLBACK');
});

test('an unused category rename preserves publication mode and moves its dependencies before audit', async t => {
  const db = catalogDb(t, { respond(sql, values) {
    if (sql.startsWith('SELECT * FROM categories ')) return rows(current);
    if (sql.startsWith('SELECT EXISTS')) return rows({ used: false });
    if (sql.startsWith('SELECT code FROM categories ')) return rows();
    if (sql.startsWith('INSERT INTO categories ')) {
      assert.match(sql, /SELECT \$1, \$2, \$3, sku_separator, \$4, \$5, sku_publication_mode/);
      assert.deepEqual(values, ['ZZ', current.name, 1, 0, 0, 'SV']);
    } else if (sql.startsWith('UPDATE ')) assert.deepEqual(values, ['ZZ', 'SV']);
    else { assert.equal(sql, 'DELETE FROM categories WHERE code = $1'); assert.deepEqual(values, ['SV']); }
    return rows();
  } });
  assert.deepEqual(await updateCategory({ ...edit, next_code: ' zz ' }, mutationOptions), { code: 'ZZ' });
  assert.deepEqual(db.writes().map(q => q.sql.split(' ')[1]), ['INTO', 'questions', 'price_scenarios', 'price_modifiers', 'products', 'sku_schema_versions', 'FROM']);
  assert.deepEqual(db.events[0].details, { code: 'ZZ', previousCode: 'SV', changes: { code: { from: 'SV', to: 'ZZ' } } });
  db.assertFinished();
});

test('a category dependency-copy failure prevents commit and success audit', async t => {
  const failure = new Error('dependency update failed');
  const db = catalogDb(t, { respond(sql) {
    if (sql.startsWith('SELECT * FROM categories ')) return rows(current);
    if (sql.startsWith('SELECT EXISTS')) return rows({ used: false });
    if (sql.startsWith('SELECT code FROM categories ')) return rows();
    if (sql.startsWith('INSERT INTO categories ')) return rows();
    if (sql.startsWith('UPDATE questions ')) throw failure;
    return undefined;
  } });
  await assert.rejects(updateCategory({ ...edit, next_code: 'ZZ' }, mutationOptions), error => error === failure);
  assert.deepEqual(db.events, []);
  db.assertFinished('ROLLBACK');
});
