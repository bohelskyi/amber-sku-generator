const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { createCategory, PATH, PARENT } = require('../src/services/magento/category-create');
const { createInclusionCategory } = require('../src/services/magento/category-create-client');
const { signCategoryCreateRequest, signGetRequest } = require('../src/services/magento/oauth');
const { runCategory, parseArguments } = require('../scripts/magento-category');
const { TARGETS } = require('../src/services/magento/category-create-target');
const { originHash } = require('../src/services/magento/binding-contract');

const config = { configured: true, baseUrl: 'https://category.example.invalid', consumerKey: 'key', consumerSecret: 'cs',
  accessToken: 'token', accessTokenSecret: 'ts' };
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const request = { id, path: PATH, expectedRevision: '1', apply: true };
const response = (v) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });
function fixture({ exists = false, timeout = false, visible = true, failSave = false, target = TARGETS[0] } = {}) {
  let revision = { id, state: 'draft', revision: '1', originHash: originHash(config.baseUrl), schema: { storeCode: 'all' },
    bindings: { routes: [{ routeKey: target.routeKey, enabled: true, reviewState: 'approved' }], attributes: [{ bindingKey: 'key', routeKey: target.routeKey,
      rowId: 'base', target: 'categories', reviewState: 'approved', evidence: { categories: [
        { requestedPath: target.parent, normalizedPath: target.parent, categoryId: '5', reviewState: 'approved' },
        { requestedPath: target.path, normalizedPath: target.path, categoryId: null, candidates: [], reviewState: 'blocked' },
      ] } }], policies: [{ bindingKey: 'key', storeCode: 'all', policy: 'authoritative_create_update', reviewState: 'approved' }] } };
  let reserved = false; let creates = 0; let saves = 0;
  const trees = () => ({ id: 2, name: 'Default', parent_id: 1, children_data: [
    { id: 5, name: target.parent.split('/').at(-1), parent_id: 2, children_data: exists ? [{ id: 99, name: target.name, parent_id: 5, children_data: [] }] : [] },
    { id: 6, name: 'Other', parent_id: 2, children_data: [{ id: 77, name: target.name, parent_id: 6, children_data: [] }] },
  ] });
  const f = { config, request: { ...request, path: target.path }, trees, calls: [], options: {
    reserveAttempt: async () => {
      if (reserved) throw Object.assign(new Error(), { code: 'MAGENTO_CATEGORY_PREVIOUS_ATTEMPT_UNRESOLVED' });
      reserved = true;
    },
    bindingService: { getRevision: async () => structuredClone(revision), updateDraft: async (_id, change) => {
      saves++;
      if (failSave) { failSave = false; throw Object.assign(new Error(), { code: 'MAGENTO_BINDING_CONFLICT' }); }
      assert.equal(change.expectedRevision, revision.revision);
      revision = { ...revision, revision: String(Number(revision.revision) + 1), bindings: change.bindings };
      return revision;
    } },
    fetchImpl: async (url, init) => {
      f.calls.push({ url, method: init.method });
      assert.equal(init.redirect, 'manual');
      if (init.method === 'POST') {
        assert.equal(reserved, true, 'intent is durable before dispatch'); creates++;
        assert.equal(url, config.baseUrl + '/rest/all/V1/categories');
        assert.deepEqual(JSON.parse(init.body), { category: { parent_id: 5, name: target.name, is_active: true, include_in_menu: false } });
        exists = visible;
        if (timeout) throw new Error('sensitive server error');
        return response({ id: 99, name: target.name, parent_id: 5 });
      }
      assert.equal(init.method, 'GET');
      return response(url.includes('store/storeGroups') ? [{ root_category_id: 2 }] : f.trees());
    },
  }, stats: () => ({ creates, saves, reserved }), revision: () => revision };
  return f;
}

test('SV stone category is a closed exact-path preview/apply with read-after-write, CAS recovery and no repeat POST', async () => {
  const target = TARGETS[1];
  assert.equal(parseArguments(['--revision', id, '--path', target.path]).apply, undefined);
  for (const flags of [{}, { timeout: true }, { exists: true }, { failSave: true }]) {
    const f = fixture({ ...flags, target });
    const preview = await createCategory(config, { ...f.request, apply: false }, f.options);
    assert.equal(preview.source, 'SV.souvenir=value_id:5');
    assert.equal(preview.parentPath, 'Default/Камінь');
    assert.deepEqual(f.stats(), { creates: 0, saves: 0, reserved: false });
    if (!flags.exists) assert.equal(preview.operation.body.category.name, 'Камінь сувенірний');
    if (flags.failSave) await assert.rejects(createCategory(config, f.request, f.options), { code: 'MAGENTO_BINDING_CONFLICT' });
    const applied = await createCategory(config, f.request, f.options);
    assert.equal(applied.categoryId, '99');
    await createCategory(config, f.request, f.options);
    assert.equal(f.stats().creates, flags.exists ? 0 : 1);
  }
  const wrongParent = fixture({ target }); const tree = wrongParent.trees();
  tree.children_data[0].name = 'Other'; wrongParent.trees = () => tree;
  await assert.rejects(createCategory(config, wrongParent.request, wrongParent.options), { code: 'MAGENTO_CATEGORY_PARENT_NOT_EXACT' });
  assert.equal(wrongParent.stats().creates, 0);
  const f = fixture({ target, timeout: true, visible: false });
  await assert.rejects(createCategory(config, f.request, f.options), { code: 'MAGENTO_CATEGORY_CREATE_UNCERTAIN' });
  await assert.rejects(createCategory(config, f.request, f.options), { code: 'MAGENTO_CATEGORY_PREVIOUS_ATTEMPT_UNRESOLVED' });
  assert.equal(f.stats().creates, 1);
  await assert.rejects(createCategory(config, { ...f.request, path: 'Default/Сувеніри/Камінь сувенірний' }, f.options), { code: 'MAGENTO_CATEGORY_PATH_UNSUPPORTED' });
});

test('default category command previews exact create, with no local or Magento writes; leaf in other branch is ignored', async () => {
  const f = fixture();
  const r = await createCategory(config, { ...request, apply: false }, f.options);
  assert.equal(r.categoryId, null); assert.equal(r.parentId, 5); assert.equal(r.status, 'would_create');
  assert.equal(r.source, 'KL.addit=value_id:1');
  assert.equal(r.operation.body.category.name, 'З інклюзом');
  assert.deepEqual(f.stats(), { creates: 0, saves: 0, reserved: false });
  assert.ok(f.calls.every((c) => c.method === 'GET'));
});
test('apply creates only one child, verifies GET after POST, binds exact ID, and identical retry does not write', async () => {
  const f = fixture();
  const r = await createCategory(config, request, f.options);
  assert.equal(r.categoryId, '99'); assert.equal(r.applied, true);
  assert.equal(f.calls.at(-1).method, 'GET');
  assert.equal(f.revision().bindings.attributes[0].evidence.categories[1].reviewState, 'approved');
  assert.equal((await createCategory(config, request, f.options)).categoryId, '99');
  assert.deepEqual(f.stats(), { creates: 1, saves: 1, reserved: true });
});
test('existing exact full path binds without POST, or merely reports ID in default preview', async () => {
  const f = fixture({ exists: true });
  assert.equal((await createCategory(config, { ...request, apply: false }, f.options)).categoryId, '99');
  assert.equal(f.stats().saves, 0);
  assert.equal((await createCategory(config, request, f.options)).status, 'existing_bound');
  assert.deepEqual(f.stats(), { creates: 0, saves: 1, reserved: false });
});
test('missing, renamed, ambiguous parent or duplicate full child paths fail closed', async () => {
  for (const kind of ['missing', 'ambiguous-parent', 'ambiguous-child', 'different-id']) {
    const f = fixture({ exists: true }); const tree = f.trees();
    if (kind === 'missing') tree.children_data[0].name = 'Not pendants';
    if (kind === 'ambiguous-parent') tree.children_data.push({ id: 8, parent_id: 2, name: 'Кулони', children_data: [] });
    if (kind === 'ambiguous-child') tree.children_data[0].children_data.push({ id: 88, parent_id: 5, name: 'З інклюзом', children_data: [] });
    if (kind === 'different-id') { tree.children_data[0].id = 55; tree.children_data[0].children_data[0].parent_id = 55; }
    f.trees = () => tree;
    await assert.rejects(createCategory(config, request, f.options));
    assert.equal(f.stats().creates, 0);
  }
});
test('timeout recovery is GET-only; uncertain missing results and crash receipts never re-POST', async () => {
  const recovered = fixture({ timeout: true });
  assert.equal((await createCategory(config, request, recovered.options)).categoryId, '99');
  const uncertain = fixture({ timeout: true, visible: false });
  await assert.rejects(createCategory(config, request, uncertain.options), { code: 'MAGENTO_CATEGORY_CREATE_UNCERTAIN' });
  await assert.rejects(createCategory(config, request, uncertain.options), { code: 'MAGENTO_CATEGORY_PREVIOUS_ATTEMPT_UNRESOLVED' });
  assert.equal(uncertain.stats().creates, 1);
  const crashed = fixture();
  await crashed.options.reserveAttempt();
  await assert.rejects(createCategory(config, request, crashed.options), { code: 'MAGENTO_CATEGORY_PREVIOUS_ATTEMPT_UNRESOLVED' });
  assert.equal(crashed.stats().creates, 0);
});
test('local save failure after remote success recovers by exact lookup without another create', async () => {
  const f = fixture({ failSave: true });
  await assert.rejects(createCategory(config, request, f.options), { code: 'MAGENTO_BINDING_CONFLICT' });
  assert.equal((await createCategory(config, request, f.options)).categoryId, '99');
  assert.equal(f.stats().creates, 1);
});
test('second precheck adopts an external exact child without creating; wrong POST identity never binds', async () => {
  const f = fixture(); const exists = fixture({ exists: true });
  f.options.reserveAttempt = async () => { f.trees = exists.trees; };
  assert.equal((await createCategory(config, request, f.options)).status, 'existing_bound');
  assert.equal(f.stats().creates, 0);
  const wrong = fixture(); const original = wrong.options.fetchImpl;
  wrong.options.fetchImpl = async (url, init) => {
    const r = await original(url, init);
    return init.method === 'POST' ? response({ id: 123, name: 'Other', parent_id: 5 }) : r;
  };
  await assert.rejects(createCategory(config, request, wrong.options), { code: 'MAGENTO_CATEGORY_VERIFICATION_FAILED' });
  assert.equal(wrong.stats().saves, 0);
});
test('closed POST client requires apply and approved shape; signer uses POST HMAC and keeps GET unchanged', async () => {
  await assert.rejects(createInclusionCategory(config, {}, {}), { code: 'MAGENTO_CATEGORY_APPLY_REQUIRED' });
  await assert.rejects(createInclusionCategory(config, { category: { name: 'arbitrary' } }, { apply: true }), { code: 'MAGENTO_CATEGORY_OPERATION_INVALID' });
  const url = config.baseUrl + '/rest/all/V1/categories';
  const fixed = { nonce: 'nonce', timestamp: 1700000000 };
  const normalized = 'oauth_consumer_key=key&oauth_nonce=nonce&oauth_signature_method=HMAC-SHA256&oauth_timestamp=1700000000&oauth_token=token&oauth_version=1.0';
  const expected = createHmac('sha256', 'cs&ts').update(['POST', url, normalized].map(encodeURIComponent).join('&')).digest('base64');
  const header = signCategoryCreateRequest(url, config, fixed);
  assert.ok(header.includes(`oauth_signature="${encodeURIComponent(expected)}"`));
  assert.notEqual(header, signGetRequest(url, config, fixed));
  assert.throws(() => signCategoryCreateRequest(config.baseUrl + '/rest/all/V1/products', config));
});
test('CLI apply is explicit and bounded; JSON stdout remains parseable on success and failure', async () => {
  const args = ['--revision', id, '--path', PATH, '--json'];
  assert.equal(parseArguments(args).apply, undefined);
  for (const extra of [['--apply'], ['--apply', '--actor-user-id', '1'], ['--path', 'Other'], ['--delete']]) {
    assert.throws(() => parseArguments([...args, ...extra]));
  }
  const env = { MAGENTO_BASE_URL: config.baseUrl, MAGENTO_CONSUMER_KEY: 'key', MAGENTO_CONSUMER_SECRET: 'cs',
    MAGENTO_ACCESS_TOKEN: 'token', MAGENTO_ACCESS_TOKEN_SECRET: 'ts' };
  const logs = []; const errors = [];
  assert.equal(await runCategory({ args, env, databasePool: {}, execute: async (_c, input) => {
    assert.equal(input.apply, undefined); return { status: 'preview' };
  }, print: (s) => logs.push(s), printError: (s) => errors.push(s) }), 0);
  assert.equal(JSON.parse(logs[0]).ok, true);
  logs.length = 0;
  assert.equal(await runCategory({ args: [...args, '--apply'], print: (s) => logs.push(s), printError: (s) => errors.push(s) }), 1);
  assert.deepEqual(JSON.parse(logs[0]), { ok: false }); assert.equal(errors.length, 1);
});
