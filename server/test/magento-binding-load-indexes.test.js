const test = require('node:test');
const assert = require('node:assert/strict');
const repository = require('../src/services/magento/binding-repository');
const tables = ['schema_sets','schema_attributes','schema_options','schema_members','schema_stores',
  'routes','attributes','options','field_policies'];
const rows = () => Object.fromEntries(tables.map(name => [name, []]));
function client(data, { absent = false, failureTable, failure } = {}) {
  const calls = [];
  return { calls, async query(sql, args) {
    calls.push({ sql, args });
    assert.match(sql, /^SELECT \* FROM magento_binding_[a-z_]+\s/);
    const table = /^SELECT \* FROM magento_binding_([a-z_]+)\s/.exec(sql)[1];
    if (table === 'revisions') return { rows: absent ? [] : [{ id: args[0], observation_store_code: 'all', revision: '1' }] };
    if (table === failureTable) throw failure;
    assert.ok(Object.hasOwn(data, table));
    return { rows: data[table] };
  } };
}

test('binding load preserves SQL option order, sorted membership, empty labels and metadata', async () => {
  const data = rows();
  data.schema_sets = [{ set_id: '7', name: 'Populated' }, { set_id: '8', name: 'Empty' }];
  data.schema_members = [{ set_id: '7', attribute_code: 'z' }, { set_id: '8', attribute_code: 'other' },
    { set_id: '7', attribute_code: 'a' }];
  data.schema_attributes = [{ code: 'weight', metadata: { attribute_code: 'weight', scope: 'store', options: 'overridden' } },
    { code: 'missing', metadata: { attribute_code: 'missing' } }];
  data.schema_options = [{ attribute_code: 'weight', option_id: '020', label: 'Unsorted second' },
    { attribute_code: 'other', option_id: '1', label: 'Unrelated' }, { attribute_code: 'weight', option_id: '', label: null },
    { attribute_code: 'weight', option_id: '010', label: '' }];
  data.schema_stores = [{ kind: 'storeViews', metadata: { id: 2, code: 'en' } },
    { kind: 'websites', metadata: { id: 1, code: 'base' } }, { kind: 'storeViews', metadata: { id: 1, code: 'all' } }];
  data.routes = [{ route_key: 'SV:all', evaluator_set_name: 'SV', enabled: true, set_id: null, review_state: 'approved', evidence: {} }];
  const db = client(data), result = await repository.load(db, 'revision');
  assert.deepEqual(result.schema, { storeCode: 'all', attributeSets: [
    { attribute_set_id: 7, attribute_set_name: 'Populated', attributeCodes: ['a','z'] },
    { attribute_set_id: 8, attribute_set_name: 'Empty', attributeCodes: ['other'] }], attributes: [
    { attribute_code: 'weight', scope: 'store', options: [{ value: '020', label: 'Unsorted second', isEmpty: false },
      { value: '', label: null, isEmpty: true }, { value: '010', label: '', isEmpty: false }] },
    { attribute_code: 'missing', options: [] }], storeTopology: { websites: [{ id: 1, code: 'base' }], storeGroups: [],
      storeViews: [{ id: 2, code: 'en' }, { id: 1, code: 'all' }] } });
  assert.equal(result.bindings.routes[0].setId, null);
  assert.deepEqual(data.schema_members.map(row => row.attribute_code), ['z','other','a']);
  assert.equal(db.calls.length, 10);
  assert.deepEqual(db.calls.map(({ sql }) => /^SELECT \* FROM magento_binding_([a-z_]+)\s/.exec(sql)[1]), ['revisions',...tables]);
  assert.ok(db.calls.every(({ args }) => args.length === 1 && args[0] === 'revision'));
});

test('membership retains exact raw BIGINT and string keys without merging them numerically', async () => {
  const data = rows();
  data.schema_sets = [{ set_id: '9007199254740992', name: 'Left' }, { set_id: '9007199254740993', name: 'Right' },
    { set_id: '1', name: 'String' }, { set_id: 1, name: 'Number' }];
  data.schema_members = [{ set_id: '9007199254740993', attribute_code: 'right' },
    { set_id: '9007199254740992', attribute_code: 'left' }, { set_id: 1, attribute_code: 'number' }, { set_id: '1', attribute_code: 'string' }];
  data.schema_attributes = [{ code: '__proto__', metadata: { attribute_code: '__proto__' } },
    { code: 'constructor', metadata: { attribute_code: 'constructor' } }, { code: 'Weight', metadata: { attribute_code: 'Weight' } }];
  data.schema_options = [{ attribute_code: 'constructor', option_id: '2', label: 'Constructor' },
    { attribute_code: '__proto__', option_id: '1', label: 'Prototype' }, { attribute_code: 'weight', option_id: '3', label: 'Lowercase' }];
  const result = await repository.load(client(data), 'revision');
  assert.deepEqual(result.schema.attributeSets.map(row => row.attributeCodes), [['left'],['right'],['string'],['number']]);
  assert.deepEqual(result.schema.attributes.map(row => row.options.map(option => option.value)), [['1'],['2'],[]]);
});

test('absent revision stops after its single parameterized locking read', async () => {
  const db = client(rows(), { absent: true }), id = "untrusted' OR true --";
  assert.equal(await repository.load(db, id, true), null);
  assert.equal(db.calls.length, 1);
  assert.equal(db.calls[0].sql, 'SELECT * FROM magento_binding_revisions WHERE id=$1 FOR UPDATE');
  assert.deepEqual(db.calls[0].args, [id]);
});

test('locking and nonlocking loads retain all ten reads and their caller-owned transaction', async () => {
  for (const lock of [false,true]) {
    const db = client(rows()); await repository.load(db, 'revision', lock);
    assert.equal(db.calls.length, 10);
    assert.equal(db.calls[0].sql.endsWith(' FOR UPDATE'), lock);
    assert.ok(db.calls.slice(1).every(({ sql }) => /WHERE revision_id=\$1 ORDER BY to_jsonb\(magento_binding_[a-z_]+\)::text$/.test(sql)));
  }
});

test('a failed child read preserves the original error and cannot return partial or cached bindings', async () => {
  const failure = new Error('Fixture database failure'), db = client(rows(), { failureTable: 'schema_options', failure });
  await assert.rejects(repository.load(db, 'revision'), cause => cause === failure);
  assert.equal(db.calls.length, 4);
});

test('every load reads fresh rows and returns independent option arrays', async () => {
  const data = rows();
  data.schema_attributes = [{ code: 'first', metadata: { attribute_code: 'first' } }, { code: 'second', metadata: { attribute_code: 'second' } }];
  const db = client(data), first = await repository.load(db, 'revision');
  first.schema.attributes[0].options.push({ value: 'client mutation' });
  assert.deepEqual(first.schema.attributes[1].options, []);
  data.schema_options = [{ attribute_code: 'first', option_id: 'new', label: 'Fresh observation' }];
  const next = await repository.load(db, 'revision');
  assert.equal(db.calls.length, 20);
  assert.deepEqual(next.schema.attributes[0].options, [{ value: 'new', label: 'Fresh observation', isEmpty: false }]);
  assert.deepEqual(next.schema.attributes[1].options, []);
});
