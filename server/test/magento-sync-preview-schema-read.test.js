'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { previewProduct } = require('../src/services/magento/sync-preview');
const { auditMagentoSchema } = require('../src/services/magento/schema-audit');
const { parseMagentoConfig } = require('../src/config/magento');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { hash, normalizeSchema } = require('../src/services/magento/binding-contract');
const bindingFixture = require('./fixtures/magento-bindings');

const config = parseMagentoConfig({ MAGENTO_BASE_URL: 'https://schema-preview.example.invalid',
  MAGENTO_CONSUMER_KEY: 'synthetic-consumer', MAGENTO_CONSUMER_SECRET: 'synthetic-consumer-secret',
  MAGENTO_ACCESS_TOKEN: 'synthetic-access', MAGENTO_ACCESS_TOKEN_SECRET: 'synthetic-access-secret' });
const TABLE = 'Magento\\Eav\\Model\\Entity\\Attribute\\Source\\Table';
const now = () => '2026-10-13T12:00:00.000Z';
const tick = () => new Promise(resolve => setImmediate(resolve));
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const routeOf = url => new URL(url).pathname.split('/V1/')[1];
const schemaRoute = route => route.startsWith('store/') || route.startsWith('products/attribute');

// Synthetic source and schema reuse the ordinary-preview contract fixture. No DB,
// app startup, production input, or real HTTP is involved in these tests.
function fixture({ inventory = false } = {}) {
  const definition = structuredClone(bindingFixture.definition());
  definition.groups[0].rows[0].cells.categories = { op: 'literal', value: 'Default/Amber/Gifts' };
  if (inventory) Object.assign(definition.groups[0].rows[0].cells, {
    qty: { op: 'literal', value: '1' }, is_in_stock: { op: 'literal', value: '1' },
  });
  const compiled = compileDefinition(definition), schema = bindingFixture.schema();
  schema.attributeSets[0].attribute_set_name = 'Historical CSV name';
  schema.attributes.find(a => a.attribute_code === 'kolir').options.find(option => option.value === 'red-id').label = 'Red output';
  for (const attribute of schema.attributes) {
    if (attribute.frontend_input === 'select') attribute.source_model = TABLE;
  }
  const sets = Array.from({ length: 6 }, (_, index) => ({
    attribute_set_id: 8001 + index, attribute_set_name: index ? 'Unused synthetic set ' + index : 'Historical CSV name' }));
  const amber = { compiled, template: { kind: 'system', definitionHash: compiled.hash }, observedAt: now(), revision: null,
    product: { id: 17, full_sku: 'BR2/SYNTHETIC-SCHEMA', category: 'BR', status: 'active', exclude_from_export: 0,
      weight: 5, details: { answers: { binding_test_semantic: 7, binding_test_size: '17' } } } };
  const raw = { id: 123, sku: amber.product.full_sku, attribute_set_id: 8001, name: 'Fixture name',
    price: 40, status: 1, visibility: 4, type_id: 'simple', extension_attributes: {
      category_links: [{ category_id: '902', position: 0 }], website_ids: [801] },
    custom_attributes: [{ attribute_code: 'kolir', value: 'blue-id' }] };
  const routes = {
    'store/websites': schema.storeTopology.websites,
    'store/storeGroups': schema.storeTopology.storeGroups,
    'store/storeViews': schema.storeTopology.storeViews,
    'products/attribute-sets/sets/list': { total_count: sets.length, items: sets },
    'products/attributes': { total_count: schema.attributes.length, items: schema.attributes },
    products: { total_count: 1, items: [raw] },
    categories: { id: 803, parent_id: 1, name: 'Default', children_data: [
      { id: 901, parent_id: 803, name: 'Amber', children_data: [
        { id: 902, parent_id: 901, name: 'Gifts', children_data: [] }] }] },
    'inventory/stock-resolver/website/base': { stock_id: 1,
      extension_attributes: { sales_channels: [{ type: 'website', code: 'base' }] } },
    'inventory/get-sources-assigned-to-stock-ordered-by-priority/1': [{ source_code: 'default', enabled: true }],
    'inventory/source-items': { total_count: 1,
      items: [{ sku: amber.product.full_sku, source_code: 'default', quantity: 1, status: 1 }] },
  };
  for (const set of sets) routes['products/attribute-sets/' + set.attribute_set_id + '/attributes'] = schema.attributes;
  for (const a of schema.attributes) routes['products/attributes/' + a.attribute_code + '/options'] = structuredClone(a.options);
  return { amber, schema, routes };
}
function transport(f, { calls = [], signals = [], productScopes = [], storeCode = 'all', before } = {}) {
  return async (url, options) => {
    const parsed = new URL(url), route = routeOf(url);
    assert.equal(parsed.origin, config.baseUrl);
    const scope = parsed.pathname.split('/')[2];
    assert.equal(parsed.pathname.startsWith('/rest/'), true);
    assert.equal(scope === storeCode || route === 'products' && scope === 'en', true);
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'manual');
    assert.ok(Object.hasOwn(f.routes, route), 'Unexpected GET ' + route);
    if (route === 'products') {
      productScopes.push(scope);
      assert.equal(parsed.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'), f.amber.product.full_sku);
      assert.equal(parsed.searchParams.get('searchCriteria[filter_groups][0][filters][0][condition_type]'), 'eq');
      assert.equal(parsed.searchParams.get('searchCriteria[pageSize]'), '2');
    }
    calls.push(route); if (schemaRoute(route)) signals.push(options.signal);
    const supplied = before && await before(route, options, parsed);
    if (supplied) return supplied;
    const body = typeof f.routes[route] === 'function' ? f.routes[route](parsed) : f.routes[route];
    return json(body);
  };
}
const preview = (f, options = {}) => previewProduct(config, {
  readAmber: async () => f.amber, fetchImpl: transport(f), now, ...options });

test('ordinary preview preserves the injected discover transport and scope contract', async () => {
  const f = fixture(), fetchImpl = () => assert.fail('Discovery sentinel must stop HTTP');
  const sentinel = Error('synthetic stop'); let captured;
  await assert.rejects(preview(f, { fetchImpl, storeCode: 'en_custom', discover: async (actual, options) => {
    assert.equal(actual, config); captured = options; throw sentinel;
  } }), cause => cause === sentinel);
  assert.deepEqual(captured, { fetchImpl, storeCode: 'en_custom' });
});

test('actual default preview preserves sequential audit, fingerprints and full payload with fewer GETs', async () => {
  const f = fixture(), baselineCalls = [], optimizedCalls = [], observations = [], baselineScopes = [], optimizedScopes = [];
  const baseline = await preview(f, { fetchImpl: transport(f, { calls: baselineCalls, productScopes: baselineScopes }),
    discover: (actual, options) => auditMagentoSchema(actual, { ...options, concurrency: 1, preferInlineOptions: false }),
    onObservation: value => observations.push(value) });
  const optimized = await preview(f, { fetchImpl: transport(f, { calls: optimizedCalls, productScopes: optimizedScopes }),
    onObservation: value => observations.push(value) });
  assert.deepEqual(optimized, baseline);
  assert.deepEqual(observations[1], observations[0]);
  assert.equal(hash(normalizeSchema(observations[1].schema)), hash(normalizeSchema(observations[0].schema)));
  assert.equal(baselineCalls.length - optimizedCalls.length, 3);
  assert.equal(optimizedCalls.includes('products/attributes/kolir/options'), false);
  assert.deepEqual(optimizedCalls.filter(route => !schemaRoute(route)), baselineCalls.filter(route => !schemaRoute(route)));
  assert.deepEqual(baselineScopes, ['all', 'en']); assert.deepEqual(optimizedScopes, ['all', 'en']);
  assert.deepEqual(observations[1].domainEvidence.failures, []);
  assert.equal(observations[1].domainEvidence.english.id, 123);
  assert.equal(observations[1].domainEvidence.english.sku, f.amber.product.full_sku);
  assert.equal(optimized.mode, 'update'); assert.equal(optimized.identity.observedMagentoId, 123);
});

test('repeated actual previews reread schema/options in the requested store and observe changed live evidence', async () => {
  const f = fixture(), calls = [], observed = [], productScopes = [];
  const options = { storeCode: 'en_custom', fetchImpl: transport(f, { calls, productScopes, storeCode: 'en_custom' }),
    onObservation: value => observed.push(value) };
  await preview(f, options);
  f.schema.attributes.find(a => a.attribute_code === 'kolir').options = [{ value: 'new-option', label: 'Changed scoped label' }];
  await preview(f, options);
  assert.notEqual(hash(normalizeSchema(observed[0].schema)), hash(normalizeSchema(observed[1].schema)));
  assert.deepEqual(observed[1].schema.attributes.find(a => a.attribute_code === 'kolir').options,
    [{ value: 'new-option', label: 'Changed scoped label', isEmpty: false }]);
  for (const route of ['store/websites', 'store/storeGroups', 'store/storeViews', 'products/attributes',
    'products/attribute-sets/8001/attributes', 'products/attributes/name/options']) {
    assert.equal(calls.filter(value => value === route).length, 2, route);
  }
  assert.equal(calls.includes('products/attributes/kolir/options'), false);
  assert.deepEqual(productScopes, ['en_custom', 'en', 'en_custom', 'en']);
  for (const observation of observed) {
    assert.deepEqual(observation.domainEvidence.failures, []);
    assert.equal(observation.domainEvidence.english.id, 123);
    assert.equal(observation.domainEvidence.english.sku, f.amber.product.full_sku);
  }
});

test('actual preview retains dedicated fallback for missing/null options and unproven inline sources', async t => {
  for (const variant of ['missing options', 'null options', 'missing source', 'null source', 'custom source']) {
    await t.test(variant, async () => {
      const f = fixture(), calls = [], color = f.schema.attributes.find(a => a.attribute_code === 'kolir');
      if (variant === 'missing options') delete color.options;
      else if (variant === 'null options') color.options = null;
      else if (variant === 'missing source') delete color.source_model;
      else color.source_model = variant === 'null source' ? null : 'Vendor\\DynamicSource';
      let observation;
      await preview(f, { fetchImpl: transport(f, { calls }), onObservation: value => { observation = value; } });
      assert.equal(calls.filter(route => route === 'products/attributes/kolir/options').length, 1);
      assert.deepEqual(observation.schema.attributes.find(a => a.attribute_code === 'kolir').options,
        f.routes['products/attributes/kolir/options']);
    });
  }
});

test('malformed present inline evidence fails before product reads without hiding it behind fallback', async t => {
  for (const source of [TABLE, 'Vendor\\DynamicSource']) {
    for (const options of [{}, [{ value: '0', label: 'One' }, { value: 0, label: 'Duplicate' }]]) {
      await t.test(source + ': ' + JSON.stringify(options), async () => {
        const f = fixture(), calls = [], color = f.schema.attributes.find(a => a.attribute_code === 'kolir');
        color.source_model = source; color.options = options;
        await assert.rejects(preview(f, { fetchImpl: transport(f, { calls }) }), { code: 'MAGENTO_RESPONSE_INVALID' });
        assert.equal(calls.some(route => route === 'products' || route.endsWith('/options')), false);
      });
    }
  }
});

test('actual preview schema concurrency never exceeds four and all read signals finish aborted', async () => {
  const f = fixture(), signals = []; let active = 0, peak = 0;
  const read = transport(f, { signals });
  await preview(f, { fetchImpl: async (url, options) => {
    if (!schemaRoute(routeOf(url))) return read(url, options);
    active++; peak = Math.max(peak, active);
    try { await tick(); return await read(url, options); } finally { active--; }
  } });
  assert.equal(peak, 4); assert.equal(active, 0);
  assert.ok(signals.length > 0); assert.equal(signals.every(signal => signal.aborted), true);
});

test('schema failure drains the started four-read batch without retries, fallback or later product reads', async t => {
  for (const kind of ['network', '429', 'invalid response']) await t.test(kind, async () => {
    const f = fixture(), calls = [], signals = []; let release, started = 0, ready, settled = false, failure;
    const barrier = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { ready = resolve; });
    const pending = preview(f, { fetchImpl: transport(f, { calls, signals, before: async route => {
      if (!/^products\/attribute-sets\/\d+\/attributes$/.test(route)) return;
      if (++started === 1) ready();
      if (route.includes('/8001/')) {
        if (kind === 'network') throw new TypeError('synthetic private failure');
        return kind === '429' ? json({ message: 'synthetic rate limit' }, 429) : json({ invalid: true });
      }
      await barrier;
    } }) }).then(() => { settled = true; }, cause => { settled = true; failure = cause; });
    t.after(() => release());
    await entered; await tick();
    const beforeDrain = { settled, started }; release(); await pending;
    assert.deepEqual(beforeDrain, { settled: false, started: 4 });
    assert.equal(failure.code, kind === 'network' ? 'MAGENTO_NETWORK_ERROR' : kind === '429' ? 'MAGENTO_HTTP_ERROR' : 'MAGENTO_RESPONSE_INVALID');
    assert.equal(calls.some(route => route.includes('/8005/') || route === 'products' || route.endsWith('/options')), false);
    assert.equal(calls.filter(route => route.includes('/8001/')).length, 1);
    assert.equal(signals.every(signal => signal.aborted), true);
  });
});

test('dedicated fallback 429 fails closed after one read, with no product lookup or inline retry', async () => {
  const f = fixture(), calls = [];
  delete f.schema.attributes.find(a => a.attribute_code === 'kolir').options;
  await assert.rejects(preview(f, { fetchImpl: transport(f, { calls,
    before: route => route === 'products/attributes/kolir/options' ? json({}, 429) : undefined }) }), { code: 'MAGENTO_HTTP_ERROR' });
  assert.equal(calls.filter(route => route === 'products/attributes/kolir/options').length, 1);
  assert.equal(calls.includes('products'), false);
});

test('default preview propagates the existing whole-audit 512 GET cap and drains before rejection', async () => {
  const f = fixture(), calls = [], sets = Array.from({ length: 520 }, (_, i) => ({
    attribute_set_id: 8001 + i, attribute_set_name: 'Synthetic bounded set ' + i }));
  f.routes['products/attribute-sets/sets/list'] = parsed => {
    const page = Number(parsed.searchParams.get('searchCriteria[currentPage]'));
    return { total_count: sets.length, items: sets.slice((page - 1) * 100, page * 100) };
  };
  for (const set of sets) f.routes['products/attribute-sets/' + set.attribute_set_id + '/attributes'] = f.schema.attributes;
  let active = 0;
  const read = transport(f, { calls });
  await assert.rejects(preview(f, { fetchImpl: async (...args) => {
    active++; try { await tick(); return await read(...args); } finally { active--; }
  } }), { code: 'MAGENTO_DISCOVERY_LIMIT' });
  assert.equal(calls.length, 512); assert.equal(active, 0);
  assert.equal(calls.some(route => route === 'products' || route.endsWith('/options')), false);
});

test('client timeout and whole-audit deadline abort and drain actual preview reads', async t => {
  for (const [elapsed, code] of [[10000, 'MAGENTO_TIMEOUT'], [60000, 'MAGENTO_DISCOVERY_LIMIT']]) {
    await t.test(code, async sub => {
      sub.mock.timers.enable({ apis: ['setTimeout'] });
      const f = fixture(), calls = [], signals = []; let active = 0, release, settled = false, failure;
      const barrier = new Promise(resolve => { release = resolve; });
      const pending = preview(f, { fetchImpl: async (url, options) => {
        const route = routeOf(url); calls.push(route); signals.push(options.signal); active++;
        try { await new Promise((resolve, reject) => options.signal.addEventListener('abort', async () => {
          if (route === 'store/storeGroups') await barrier;
          reject(options.signal.reason);
        }, { once: true })); } finally { active--; }
      } }).then(() => { settled = true; }, cause => { settled = true; failure = cause; });
      await tick(); sub.mock.timers.tick(elapsed); await tick();
      const beforeDrain = { settled, active, aborted: signals.every(signal => signal.aborted) };
      release(); await pending;
      assert.deepEqual(beforeDrain, { settled: false, active: 1, aborted: true });
      assert.equal(failure.code, code); assert.equal(active, 0);
      assert.deepEqual(calls, ['store/websites', 'store/storeGroups', 'store/storeViews']);
    });
  }
});

test('fresh category and domain reads overlap with at most four GETs and preserve the report', async t => {
  const f = fixture({ inventory: true }), calls = [], signals = [];
  const categoryObservation = { trees: [f.routes.categories], categoryFailures: [] };
  const expected = await preview(f, { categoryObservation });
  let release, active = 0, peak = 0, settled = false;
  const barrier = new Promise(resolve => { release = resolve; });
  const read = transport(f, { calls });
  const pending = preview(f, { fetchImpl: async (url, options) => {
    active++; peak = Math.max(peak, active); signals.push(options.signal);
    try {
      const route = routeOf(url), scope = new URL(url).pathname.split('/')[2];
      if (route === 'categories' || route === 'products' && scope === 'en'
        || route.startsWith('inventory/') && !route.includes('stock-resolver')) await barrier;
      return await read(url, options);
    } finally { active--; }
  } }).finally(() => { settled = true; });
  t.after(release);
  await tick();
  const beforeDrain = { active, peak, settled };
  release();
  assert.deepEqual(await pending, expected);
  assert.deepEqual(beforeDrain, { active: 4, peak: 4, settled: false });
  assert.equal(peak, 4); assert.equal(active, 0);
  assert.equal(calls.filter(route => route === 'categories').length, 1);
  assert.equal(calls.filter(route => route === 'products').length, 2);
  assert.equal(calls.filter(route => route.startsWith('inventory/')).length, 3);
  assert.equal(signals.every(signal => signal.aborted), true);
});

test('fatal category evidence drains a started English read before rejecting and produces no observation', async t => {
  const f = fixture(), calls = [], signals = [];
  let release, settled = false, failure, observed = false, englishStarted = false;
  const barrier = new Promise(resolve => { release = resolve; });
  const pending = preview(f, { onObservation: () => { observed = true; },
    fetchImpl: transport(f, { calls, before: async (route, options, parsed) => {
      signals.push(options.signal);
      if (route === 'categories') return json({ ...f.routes.categories, id: 999 });
      if (route === 'products' && parsed.pathname.includes('/en/')) {
        englishStarted = true; await barrier;
      }
    } }) }).then(() => { settled = true; }, cause => { settled = true; failure = cause; });
  t.after(release);
  await tick();
  const beforeDrain = { settled, englishStarted };
  release(); await pending;
  assert.deepEqual(beforeDrain, { settled: false, englishStarted: true });
  assert.equal(failure.code, 'MAGENTO_PREVIEW_CATEGORIES_INVALID');
  assert.equal(observed, false);
  assert.equal(calls.filter(route => route === 'categories').length, 1);
  assert.equal(signals.every(signal => signal.aborted), true);
});

test('fatal category evidence also waits for a pending English response body', async t => {
  const f = fixture(); let body, englishSignal, settled = false, failure;
  const pending = preview(f, { fetchImpl: transport(f, { before: async (route, options, parsed) => {
    if (route === 'categories') return json({ ...f.routes.categories, id: 999 });
    if (route === 'products' && parsed.pathname.includes('/en/')) {
      englishSignal = options.signal;
      return new Response(new ReadableStream({ start(controller) { body = controller; } }),
        { headers: { 'content-type': 'application/json' } });
    }
  } }) }).then(() => { settled = true; }, cause => { settled = true; failure = cause; });
  const finishBody = () => { if (body) { body.enqueue(Buffer.from(JSON.stringify(f.routes.products))); body.close(); body = null; } };
  t.after(finishBody);
  await tick();
  const beforeDrain = { settled, bodyStarted: !!body, aborted: englishSignal?.aborted };
  finishBody(); await pending;
  assert.deepEqual(beforeDrain, { settled: false, bodyStarted: true, aborted: false });
  assert.equal(failure.code, 'MAGENTO_PREVIEW_CATEGORIES_INVALID');
  assert.equal(englishSignal.aborted, true);
});

test('category and domain failures keep stable blocker order without retries', async () => {
  const f = fixture({ inventory: true }), calls = [];
  const report = await preview(f, { fetchImpl: transport(f, { calls, before: async (route, _options, parsed) => {
    if (route === 'categories' || route.startsWith('inventory/')
      || route === 'products' && parsed.pathname.includes('/en/')) return json({}, 429);
  } }) });
  const codes = new Set(['INVENTORY_READ_UNAVAILABLE', 'STORE_VIEW_READ_UNAVAILABLE', 'CATEGORY_TREE_UNAVAILABLE']);
  assert.deepEqual(report.blockers.filter(blocker => codes.has(blocker.code)).map(blocker => blocker.code),
    ['INVENTORY_READ_UNAVAILABLE', 'STORE_VIEW_READ_UNAVAILABLE', 'CATEGORY_TREE_UNAVAILABLE']);
  assert.equal(report.sendable, false);
  assert.equal(calls.filter(route => route === 'categories').length, 1);
  assert.equal(calls.filter(route => route.startsWith('inventory/')).length, 1);
  assert.equal(calls.filter(route => route === 'products').length, 2);
});

test('supplied category observation retains its contract and performs no new category GET', async () => {
  const f = fixture(), calls = [];
  const categoryObservation = { trees: [f.routes.categories], categoryFailures: [] };
  const report = await preview(f, { categoryObservation, fetchImpl: transport(f, { calls }) });
  assert.equal(calls.includes('categories'), false);
  assert.equal(calls.filter(route => route === 'products').length, 2);
  assert.equal(report.identity.observedMagentoId, 123);
});

test('later observations reread category, product and English values without sharing evidence', async () => {
  const f = fixture(), calls = [], observations = [];
  const options = { fetchImpl: transport(f, { calls }), onObservation: value => observations.push(value) };
  await preview(f, options);
  f.routes.categories = { ...f.routes.categories, name: 'Changed root' };
  f.routes.products = { total_count: 1, items: [{ ...f.routes.products.items[0], name: 'Changed remote name' }] };
  await preview(f, options);
  assert.notDeepEqual(observations[0].categoryNodes, observations[1].categoryNodes);
  assert.equal(observations[0].raw.name, 'Fixture name');
  assert.equal(observations[1].raw.name, 'Changed remote name');
  assert.equal(observations[1].domainEvidence.english.fields.name, 'Changed remote name');
  assert.equal(calls.filter(route => route === 'categories').length, 2);
  assert.equal(calls.filter(route => route === 'products').length, 4);
});
