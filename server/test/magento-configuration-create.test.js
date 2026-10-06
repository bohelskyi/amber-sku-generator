const { test } = require('node:test');
const assert = require('node:assert/strict');
const { categoryTarget, verifyCategory, plannedTarget, plan } = require('../src/services/magento/configuration-category');
const revision = { id: '00000000-0000-0000-0000-000000000001', state: 'draft', revision: '1',
  bindings: { attributes: [{ bindingKey: 'new-path', target: 'categories', evidence: { categories: [
    { requestedPath: 'Default/Сувеніри/Нова підкатегорія', normalizedPath: 'Default/Сувеніри/Нова підкатегорія' },
  ] } }] } };
const input = { bindingRevisionId: revision.id, expectedRevision: '1', bindingKey: 'new-path',
  path: 'Default/Сувеніри/Нова підкатегорія', parentId: 10 };
const nodes = [{ categoryId: '10', path: 'Default/Сувеніри', normalizedPath: 'Default/Сувеніри', comparable: true }];
test('reviewed category creation extends beyond the two historical CLI paths, with fixed menu defaults', () => {
  const result = categoryTarget(revision, input, nodes);
  assert.deepEqual(result.body, { category: { parent_id: 10, name: 'Нова підкатегорія', is_active: true, include_in_menu: false } });
  assert.equal(revision.bindings.attributes[0].evidence.categories[0].categoryId, undefined);
});
test('unrelated paths, wrong parents, duplicate paths and stale draft revisions cannot create categories', () => {
  for (const command of [{ ...input, path: 'Default/Other' }, { ...input, parentId: 20 }, { ...input, expectedRevision: '2' }]) {
    assert.throws(() => categoryTarget(revision, command, nodes));
  }
  assert.throws(() => categoryTarget(revision, input, [...nodes, { ...nodes[0], categoryId: '20' }]));
});
test('verification requires returned exact ID, hierarchy and both reviewed flags; equal labels are insufficient', () => {
  const target = categoryTarget(revision, input, nodes);
  const created = { id: 6001, parent_id: 10, name: 'Нова підкатегорія', is_active: true, include_in_menu: false };
  const after = [...nodes, { categoryId: '6001', path: input.path, normalizedPath: input.path, comparable: true }];
  assert.equal(verifyCategory(target, '6001', created, after), true);
  for (const changed of [{ ...created, id: 6002 }, { ...created, include_in_menu: true }, { ...created, parent_id: 11 }]) {
    assert.throws(() => verifyCategory(target, '6001', changed, after));
  }
  assert.throws(() => verifyCategory(target, null, created, after));
});

test('general planning accepts arbitrary verified parents, including nested ones, and distinguishes exact existing children', () => {
  const tree = [...nodes, { categoryId: '25', normalizedPath: 'Default/Other/Deep', comparable: true },
    { categoryId: '26', normalizedPath: 'Default/Other/Deep/Новий розділ', comparable: true }];
  const existing = plannedTarget(tree, { parentId: 25, name: 'Новий розділ' });
  assert.equal(existing.status, 'existing'); assert.equal(existing.categoryId, '26');
  const fresh = plannedTarget(tree, { parentId: 10, name: 'Новий розділ' });
  assert.equal(fresh.status, 'would_create'); assert.equal(fresh.path, 'Default/Сувеніри/Новий розділ');
  assert.throws(() => plannedTarget([...tree, { ...tree[1], categoryId: '27' }], { parentId: 25, name: 'Child' }), { code: 'MAGENTO_CATEGORY_PARENT_NOT_EXACT' });
  assert.throws(() => plannedTarget([...tree, { ...tree[2], categoryId: '28' }], { parentId: 25, name: 'Новий розділ' }), { code: 'MAGENTO_CATEGORY_PATH_AMBIGUOUS' });
});
test('general planning rejects invalid names, unsafe IDs and unrepresentable depth before observing the store', async () => {
  for (const name of ['', ' leading', 'trailing ', 'a/b', 'a,b', 'a\nb', 'e\u0301', 'x'.repeat(256)]) {
    assert.throws(() => plannedTarget(nodes, { parentId: 10, name }), { code: 'MAGENTO_CATEGORY_NAME_INVALID' });
  }
  for (const parentId of [0, -1, '10', 1.5, NaN]) assert.throws(() => plannedTarget(nodes, { parentId, name: 'Child' }));
  assert.throws(() => plannedTarget([{ ...nodes[0], normalizedPath: Array(30).fill('Deep').join('/') }], { parentId: 10, name: 'Child' }));
  let observed = 0;
  const options = { databasePool: { connect: async () => { throw Error('unexpected DB read'); } }, fetchImpl: async () => { ++observed; throw Error('unexpected GET'); } };
  await assert.rejects(plan({}, { categoryCode: 'XG', parentId: 10, name: 'Child', apply: true }, options));
  await assert.rejects(plan({}, { categoryCode: '../XG', parentId: 10, name: 'Child' }, options));
  await assert.rejects(plan({}, { categoryCode: 'XG', parentId: 10, name: 'a/b' }, options));
  assert.equal(observed, 0);
});
test('category authoring preview uses a read-only local snapshot and bounded remote GETs, with no allocation or binding publication', async () => {
  const queries = [], requests = [];
  const databasePool = { connect: async () => ({ release() {}, query: async (sql, args) => {
    queries.push({ sql, args });
    if (sql.startsWith('SELECT code,name')) return { rows: [{ code: 'XG', name: 'Довільний тип' }] };
    if (sql.startsWith('SELECT count')) return { rows: [{ count: 17 }] };
    assert.match(sql, /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|COMMIT|ROLLBACK)$/); return { rows: [] };
  } }) };
  const config = { configured: true, baseUrl: 'https://category.example.invalid', consumerKey: 'key', consumerSecret: 'secret', accessToken: 'token', accessTokenSecret: 'token-secret' };
  const fetchImpl = async (url, options) => {
    requests.push({ url, method: options.method }); assert.equal(options.method, 'GET');
    const body = new URL(url).pathname.endsWith('/store/storeGroups') ? [{ root_category_id: 2 }] :
      { id: 2, parent_id: 1, name: 'Default', children_data: [{ id: 10, parent_id: 2, name: 'Сувеніри', children_data: [] }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await plan(config, { categoryCode: 'XG', parentId: 10, name: 'Новий довільний розділ' }, { databasePool, fetchImpl });
  assert.equal(result.path, 'Default/Сувеніри/Новий довільний розділ'); assert.equal(result.categoryCode, 'XG');
  assert.equal(result.status, 'would_create'); assert.equal(result.magentoWriteAttempted, false);
  assert.deepEqual(result.impact, { categoryCreates: 1, productWrites: 0, bindingPublished: false, menuVisible: false, activeProductUpperBound: 17, publicationReviewRequired: true });
  assert.equal(requests.length, 2); assert.match(queries[0].sql, /READ ONLY/);
  assert.deepEqual(queries.filter(q => q.args).map(q => q.args), [['XG'], ['XG']]);
});
test('a missing local category cannot create an invented Manager code or make a remote request', async () => {
  let reads = 0;
  const options = { databasePool: { connect: async () => ({ release() {}, query: async () => ({ rows: [] }) }) }, fetchImpl: async () => { ++reads; throw Error('unexpected remote read'); } };
  await assert.rejects(plan({}, { categoryCode: 'NEW', parentId: 10, name: 'Child' }, options), { code: 'MAGENTO_CATEGORY_NOT_FOUND' });
  assert.equal(reads, 0);
});
