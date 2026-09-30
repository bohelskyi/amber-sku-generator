const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, run } = require('../scripts/magento-sync');
const { dispatch } = require('../src/services/magento/sync-write-client');
const { signSyncRequest } = require('../src/services/magento/oauth');
const { parseMagentoConfig } = require('../src/config/magento');
const { intent, matches, verifyAll } = require('../src/services/magento/sync-job-plan');
const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const env = { MAGENTO_BASE_URL: 'https://sync.example.invalid', MAGENTO_CONSUMER_KEY: 'fake-key',
  MAGENTO_CONSUMER_SECRET: 'fake-secret', MAGENTO_ACCESS_TOKEN: 'fake-access', MAGENTO_ACCESS_TOKEN_SECRET: 'fake-access-secret' };
const config = parseMagentoConfig(env);

test('sync CLI defaults to enqueue only, requires an actor/exact selection, and has no force retry', async () => {
  for (const args of [[], ['--apply'], ['--sku', 'X', '--binding-revision', id],
    ['--job', id, '--actor-user-id', '1'], ['--job', id, '--sku', 'X', '--actor-user-id', '1', '--apply'],
    ['--sku', 'X', '--binding-revision', id, '--actor-user-id', '1', '--force']]) assert.throws(() => parse(args));
  const args = ['--sku', 'KL3/11131351005', '--binding-revision', id, '--actor-user-id', '1', '--json'];
  let writes = 0; const output = [];
  const job = { id, state: 'queued', intent: { operations: [] } };
  const service = { enqueue: async () => job, applyJob: async () => { writes++; return { ...job, state: 'succeeded' }; } };
  const options = { args, env, databasePool: {}, service, print: (s) => output.push(s) };
  assert.equal(await run(options), 0); assert.equal(writes, 0); assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0]).magentoMutationEnabled, false);
  assert.equal(await run({ ...options, args: [...args, '--apply'] }), 0); assert.equal(writes, 1);
  service.enqueue = async () => { throw Object.assign(new Error('do not leak'), { code: 'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED' }); };
  const errors = []; output.length = 0;
  assert.equal(await run({ ...options, printError: (s) => errors.push(s) }), 1);
  assert.equal(JSON.parse(output[0]).ok, false); assert.equal(errors.length, 1); assert.ok(!output.join('').includes('do not leak'));
});
test('separate write transport gates apply, uses native bounded routes and never retries or follows redirects', async () => {
  let calls = 0;
  await assert.rejects(dispatch(config, {}, { fetchImpl: () => { calls++; } }), { code: 'MAGENTO_SYNC_APPLY_REQUIRED' });
  assert.equal(calls, 0);
  for (const [domain, payload, route] of [
    ['coreProduct', { product: { sku: 'KL3/1', name: 'Name' } }, '/rest/all/V1/products'],
    ['categories', { product: { sku: 'KL3/1', extension_attributes: { category_links: [] } } }, '/rest/all/V1/products'],
    ['inventory', { sourceItems: [{ sku: 'KL3/1', source_code: 'default', quantity: 1, status: 1 }] }, '/rest/all/V1/inventory/source-items'],
    ['websites', { productWebsiteLink: { sku: 'KL3/1', website_id: 1 } }, '/rest/all/V1/products/KL3%2F1/websites'],
    ['storeViews', { product: { sku: 'KL3/1', name: 'English' } }, '/rest/en/V1/products'],
  ]) {
    await dispatch(config, { domain, payload }, { apply: true, fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, route); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'manual');
      assert.deepEqual(JSON.parse(options.body), payload); assert.match(options.headers.Authorization, /^OAuth /);
      return new Response('true', { headers: { 'content-type': 'application/json' } });
    } });
  }
  await assert.rejects(dispatch(config, { domain: 'coreProduct', payload: { product: { sku: 'X' } } }, {
    apply: true, fetchImpl: async () => { calls++; return new Response('secret remote error', { status: 302 }); },
  }), { code: 'MAGENTO_SYNC_MUTATION_UNCERTAIN' });
  assert.equal(calls, 1);
  for (const path of ['/rest/all/V1/categories', '/rest/all/V1/products/X', '/rest/ua/V1/products', '/rest/en/V1/products?secret=1']) {
    assert.throws(() => signSyncRequest(config.baseUrl + path, config), { code: 'MAGENTO_INPUT_INVALID' });
  }
  for (const [method, path] of [['DELETE', '/rest/all/V1/products'],
    ['DELETE', '/rest/all/V1/categories/375/products'], ['POST', '/rest/all/V1/categories/375/products/X'],
    ['POST', '/rest/all/V1/categories/0/products']]) {
    assert.throws(() => signSyncRequest(config.baseUrl + path, config, method), { code: 'MAGENTO_INPUT_INVALID' });
  }
});
test('bound plan refuses enabled CREATE and status-setting UPDATE; verification is semantic but never accepts legacy rounding', () => {
  const r = { sendable: true, mode: 'create', sendability: { operations: {
    coreProduct: { candidatePayload: { product: { sku: 'X', status: 1 } } }, categories: { candidateLinks: null } } },
  transport: { inventory: {}, websites: { operations: [], requested: [] }, storeViews: { diff: [] } } };
  assert.throws(() => intent(r), { code: 'MAGENTO_SYNC_CREATE_MUST_BE_DISABLED' });
  r.mode = 'update'; assert.throws(() => intent(r), { code: 'MAGENTO_SYNC_UPDATE_STATUS_MUST_BE_PRESERVED' });
  const op = { domain: 'coreProduct', payload: { product: { sku: 'X', custom_attributes: [{ attribute_code: 'decor_weight', value: '4.7' }] } } };
  const observation = { raw: { sku: 'X', custom_attributes: [{ attribute_code: 'decor_weight', value: '4.7000' }] }, domainEvidence: {} };
  assert.equal(matches(op, observation), true);
  observation.raw.custom_attributes[0].value = '5'; assert.equal(matches(op, observation), false);
  assert.throws(() => verifyAll({ sku: 'X', intent: { mode: 'create', operations: [op] }, baseline: { preservation: {}, domainEvidence: {} } }, observation),
    { code: 'MAGENTO_SYNC_VERIFICATION_MISMATCH' });
});

test('authoritative category replacement uses independent native links and rejects the old additive product result', async () => {
  const link = (category_id, position = 0) => ({ category_id, position });
  const baseline = [link('10'), link('375')];
  const desired = [link('10'), link('377')];
  const report = { sendable: true, mode: 'update', sendability: { operations: {
    coreProduct: { candidatePayload: { product: { sku: 'AG-000002' } } }, categories: { candidateLinks: desired },
  } }, categories: { current: baseline.map((v) => ({ categoryId: v.category_id, position: v.position })) },
  transport: { inventory: {}, websites: { operations: [], requested: [] }, storeViews: { diff: [] } } };
  const legacy = intent(report, 1);
  const raw = (category_links) => ({ id: 5794, sku: 'AG-000002', extension_attributes: { category_links } });
  const observed = (category_links) => ({ raw: raw(category_links), domainEvidence: { inventory: null } });
  assert.equal(matches(legacy.operations[1], observed([...baseline, link('377')])), false);
  assert.throws(() => verifyAll({ sku: 'AG-000002', intent: legacy,
    baseline: { preservation: {}, domainEvidence: { inventory: null } } }, observed([...baseline, link('377')])),
  { code: 'MAGENTO_SYNC_VERIFICATION_MISMATCH' });
  const next = intent(report);
  assert.equal(next.version, 2);
  assert.deepEqual(next.operations.map((o) => o.domain), ['coreProduct', 'categoryLinkDelete', 'categoryLinkSave']);
  assert.deepEqual(next.operations[1].beforeLinks, baseline);
  assert.deepEqual(next.operations[1].afterLinks, [link('10')]);
  assert.deepEqual(next.operations[2].afterLinks, desired);
  const remote = [...baseline]; const calls = [];
  for (const operation of next.operations.slice(1)) {
    await dispatch(config, operation, { apply: true, fetchImpl: async (url, options) => {
      calls.push([options.method, new URL(url).pathname]);
      const categoryId = operation.domain === 'categoryLinkDelete' ? operation.payload.categoryId
        : operation.payload.productLink.category_id;
      const index = remote.findIndex((v) => v.category_id === categoryId);
      if (options.method === 'DELETE') remote.splice(index, 1);
      else remote.push({ category_id: categoryId, position: operation.payload.productLink.position });
      return new Response('true', { headers: { 'content-type': 'application/json' } });
    } });
    assert.equal(matches(operation, observed(remote)), true);
  }
  assert.deepEqual(calls, [['DELETE', '/rest/all/V1/categories/375/products/AG-000002'],
    ['POST', '/rest/all/V1/categories/377/products']]);
  assert.deepEqual(remote, desired);
  verifyAll({ sku: 'AG-000002', intent: next, baseline: { preservation: {}, domainEvidence: { inventory: null } } }, observed(remote));
  assert.equal(intent({ ...report, categories: { current: desired.map((v) => ({ categoryId: v.category_id, position: v.position })) } })
    .operations.length, 1);
  const casePlan = (current, target) => intent({ ...report,
    categories: { current: current.map((v) => ({ categoryId: v.category_id, position: v.position })) },
    sendability: { operations: { ...report.sendability.operations, categories: { candidateLinks: target } } } });
  assert.deepEqual(casePlan([link('10')], desired).operations.map((o) => o.domain), ['coreProduct', 'categoryLinkSave']);
  assert.deepEqual(casePlan([link('10'), link('375')], [link('10')]).operations.map((o) => o.domain),
    ['coreProduct', 'categoryLinkDelete']);
  assert.deepEqual(casePlan(baseline, [...baseline, link('377')]).operations.map((o) => o.domain),
    ['coreProduct', 'categoryLinkSave'], 'preserved Magento-only category has no delete');
  const positionPlan = casePlan([link('10', 3)], [link('10', 5)]);
  assert.deepEqual(positionPlan.operations.map((o) => o.domain), ['coreProduct', 'categoryLinkSave']);
  assert.equal(matches(positionPlan.operations[1], observed([link('10', 3)])), false);
  assert.equal(matches(positionPlan.operations[1], observed([link('10', 5)])), true);
});
