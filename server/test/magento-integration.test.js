const assert = require('node:assert/strict');
const test = require('node:test');
const { createHmac } = require('node:crypto');
const { parseMagentoConfig } = require('../src/config/magento');
const { signGetRequest, percentEncode } = require('../src/services/magento/oauth');
const { createMagentoClient, MAX_RESPONSE_BYTES } = require('../src/services/magento/client');
const { runProbe, parseArguments } = require('../scripts/magento-probe');

const env = {
  MAGENTO_BASE_URL: 'https://store.example.invalid/',
  MAGENTO_CONSUMER_KEY: 'test-key',
  MAGENTO_CONSUMER_SECRET: 'test-secret&',
  MAGENTO_ACCESS_TOKEN: 'test-token',
  MAGENTO_ACCESS_TOKEN_SECRET: 'test-token-secret/',
};
const config = parseMagentoConfig(env);
const fixed = { nonce: 'fixed-nonce', timestamp: 1700000000 };
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
});
const headerFields = (header) => Object.fromEntries(header.slice(6).split(', ').map((part) => {
  const [key, value] = part.split('=');
  return [key, decodeURIComponent(value.slice(1, -1))];
}));

function noSecrets(error) {
  const text = `${error.stack} ${JSON.stringify(error)}`;
  for (const secret of Object.values(env)) {
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes(percentEncode(secret)));
  }
  assert.equal(error.cause, undefined);
  return true;
}

test('Magento config is optional, complete, immutable and server-only', () => {
  assert.deepEqual(parseMagentoConfig({}), { configured: false });
  assert.deepEqual(parseMagentoConfig(Object.fromEntries(Object.keys(env).map((key) => [key, ' \t']))),
    { configured: false });
  assert.deepEqual(config, { configured: true, baseUrl: 'https://store.example.invalid',
    consumerKey: 'test-key', consumerSecret: 'test-secret&', accessToken: 'test-token', accessTokenSecret: 'test-token-secret/' });
  assert.equal(Object.isFrozen(config), true);
  assert.deepEqual(parseMagentoConfig({ VITE_MAGENTO_ACCESS_TOKEN: 'ignored' }), { configured: false });
});

test('every incomplete Magento config fails closed without echoing values', () => {
  const names = Object.keys(env);
  for (let mask = 1; mask < (1 << names.length) - 1; mask += 1) {
    const partial = Object.fromEntries(names.filter((_, index) => mask & (1 << index)).map((key) => [key, env[key]]));
    assert.throws(() => parseMagentoConfig(partial), (error) => {
      assert.equal(error.code, 'MAGENTO_CONFIG_INVALID');
      return noSecrets(error);
    });
  }
});

test('origin validation rejects unsafe schemes, admin paths, normalization tricks and URL secrets', () => {
  for (const baseUrl of ['http://store.example.invalid', 'ftp://localhost', 'not a URL',
    'https://store.example.invalid/admin/', 'https://store.example.invalid/rest/all',
    'https://store.example.invalid/admin/..', 'https://store.example.invalid/%2e/',
    'https://store.example.invalid/?', 'https://store.example.invalid/#',
    'https://test-key:test-token@store.example.invalid', 'https://store.example.invalid\\admin',
    'https://store.exa\nmple.invalid', 'https://store.example.invalid/?secret=test-secret&']) {
    assert.throws(() => parseMagentoConfig({ ...env, MAGENTO_BASE_URL: baseUrl }), (error) => {
      assert.equal(error.code, 'MAGENTO_BASE_URL_INVALID');
      return noSecrets(error);
    });
  }
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const local = { ...env, MAGENTO_BASE_URL: `http://${host}:8080`, NODE_ENV: 'development' };
    assert.equal(parseMagentoConfig(local).baseUrl, local.MAGENTO_BASE_URL);
    assert.throws(() => parseMagentoConfig({ ...local, NODE_ENV: 'production' }), { code: 'MAGENTO_BASE_URL_INVALID' });
  }
});

test('OAuth uses RFC3986 encoding including Unicode and reserved punctuation', () => {
  assert.equal(percentEncode("!'()* /+~я"), '%21%27%28%29%2A%20%2F%2B~%D1%8F');
});

test('fixed OAuth HMAC-SHA256 fixture includes sorted duplicate queries and encoded signing path', () => {
  const url = 'https://store.example.invalid/rest/all/V1/products/KL3%2F11131351005'
    + '?b=two+words&a=%2F&a=%21&empty=&unicode=%D1%8F';
  const header = signGetRequest(url, config, fixed);
  assert.ok(header.startsWith('OAuth '));
  assert.deepEqual(headerFields(header), {
    oauth_consumer_key: 'test-key', oauth_nonce: 'fixed-nonce',
    oauth_signature: 'YBlaXWw5Gms4UkoUQRiljUczJ2RMo0cMx5WrovDKer4=',
    oauth_signature_method: 'HMAC-SHA256', oauth_timestamp: '1700000000',
    oauth_token: 'test-token', oauth_version: '1.0',
  });
  // Fixture independently calculated with Python hmac/hashlib, using a literal
  // normalized parameter string (not this signer's normalization).
  assert.equal(signGetRequest(url.replace('b=two+words&a=%2F&a=%21', 'a=%21&b=two%20words&a=%2F'), config, fixed), header);
  assert.notEqual(signGetRequest(url.replace('empty=', 'empty=changed'), config, fixed), header);
  assert.notEqual(signGetRequest(url.replace('KL3%2F', 'KL3/'), config, fixed), header);
});

test('OAuth defaults generate fresh cryptographic nonces and current Unix seconds', () => {
  const before = Math.floor(Date.now() / 1000);
  const a = headerFields(signGetRequest('https://store.example.invalid/', config));
  const b = headerFields(signGetRequest('https://store.example.invalid/', config));
  assert.match(a.oauth_nonce, /^[a-f0-9]{48}$/);
  assert.notEqual(a.oauth_nonce, b.oauth_nonce);
  assert.ok(Number(a.oauth_timestamp) >= before && Number(a.oauth_timestamp) <= Math.floor(Date.now() / 1000));
});

test('signing errors do not retain unsafe URL, credentials or crypto errors', () => {
  for (const url of ['test-secret&', 'https://test-key:test-token@store.example.invalid', 'https://store.example.invalid/#test-token']) {
    assert.throws(() => signGetRequest(url, config, fixed), noSecrets);
  }
  assert.throws(() => signGetRequest('https://store.example.invalid', { ...config, consumerKey: '\ud800' }, fixed), noSecrets);
});

test('GET-only API covers every discovery endpoint with explicit all/store scope and pagination', async () => {
  const calls = [];
  const client = createMagentoClient(config, { fetchImpl: async (url, options) => {
    calls.push({ url, options }); return json([]);
  } });
  const cases = [
    ['getWebsites', [], 'store/websites'], ['getStoreGroups', [], 'store/storeGroups'],
    ['getStoreViews', [], 'store/storeViews'], ['getStoreConfigs', [], 'store/storeConfigs'],
    ['listAttributeSets', [2], 'products/attribute-sets/sets/list?searchCriteria%5BpageSize%5D=100&searchCriteria%5BcurrentPage%5D=2'],
    ['getAttributeSet', [17], 'products/attribute-sets/17'],
    ['getAttributeSetAttributes', [17], 'products/attribute-sets/17/attributes'],
    ['listProductAttributes', [], 'products/attributes?searchCriteria%5BpageSize%5D=100&searchCriteria%5BcurrentPage%5D=1'],
    ['getProductAttribute', ['stone_color'], 'products/attributes/stone_color'],
    ['getProductAttributeOptions', ['stone_color'], 'products/attributes/stone_color/options'],
    ['getProductBySku', ['KL3/11131351005'], 'products/KL3%2F11131351005'],
  ];
  assert.deepEqual(Object.keys(client).sort(), cases.map(([method]) => method).sort());
  assert.equal(Object.isFrozen(client), true);
  for (const [method, args, path] of cases) {
    await client[method](...args);
    const call = calls.at(-1);
    assert.equal(call.url, `https://store.example.invalid/rest/all/V1/${path}`);
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'manual');
    assert.equal(call.options.body, undefined);
    assert.equal(call.options.headers.Accept, 'application/json');
  }
  const scoped = createMagentoClient(config, { storeCode: 'en', fetchImpl: async (url) => {
    assert.equal(url, 'https://store.example.invalid/rest/en/V1/store/storeViews'); return json([]);
  } });
  await scoped.getStoreViews();
});

test('SKU URL sent to fetch preserves exactly one encoded route value and matches independent signature reconstruction', async () => {
  for (const sku of ['KL3/11131351005', 'NM4/113120611026-001', "space ?#%/+!'()*я", '%2F', '../SKU']) {
    const client = createMagentoClient(config, { oauthOptions: fixed, fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      const segment = parsed.pathname.split('/').at(-1);
      assert.equal(decodeURIComponent(segment), sku);
      assert.equal(parsed.pathname.split('/').length, 6);
      assert.equal(parsed.search, '');
      const oauth = headerFields(options.headers.Authorization);
      const signature = oauth.oauth_signature;
      delete oauth.oauth_signature;
      const pairs = [...parsed.searchParams, ...Object.entries(oauth)].map(([k, v]) => [percentEncode(k), percentEncode(v)]);
      pairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
      const base = ['GET', parsed.origin + parsed.pathname, pairs.map((pair) => pair.join('=')).join('&')].map(percentEncode).join('&');
      assert.equal(signature, createHmac('sha256', 'test-secret%26&test-token-secret%2F').update(base).digest('base64'));
      return json({ sku });
    } });
    assert.deepEqual(await client.getProductBySku(sku), { sku });
  }
});

test('request validation prevents path traversal and arbitrary request options', async () => {
  let calls = 0;
  const client = createMagentoClient(config, { fetchImpl: () => { calls += 1; throw new Error(); } });
  for (const value of ['', '.', '..', '\ud800', 'x\ny', 'x'.repeat(257), null]) {
    assert.throws(() => client.getProductBySku(value), { code: 'MAGENTO_INPUT_INVALID' });
  }
  for (const value of ['../evil', 'https://evil.invalid', 'x?override=PUT']) {
    assert.throws(() => client.getProductAttribute(value), { code: 'MAGENTO_INPUT_INVALID' });
    assert.throws(() => createMagentoClient(config, { storeCode: value }), { code: 'MAGENTO_INPUT_INVALID' });
  }
  for (const value of [0, -1, 1.5, '1/../2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => client.getAttributeSet(value), { code: 'MAGENTO_INPUT_INVALID' });
  }
  assert.throws(() => client.listProductAttributes(101), { code: 'MAGENTO_INPUT_INVALID' });
  assert.throws(() => createMagentoClient(config, { timeoutMs: 60001 }), { code: 'MAGENTO_INPUT_INVALID' });
  assert.throws(() => createMagentoClient({ configured: false }), { code: 'MAGENTO_NOT_CONFIGURED' });
  assert.equal(calls, 0);
});

test('non-2xx including redirects are not followed/retried and never surface response secrets', async () => {
  for (const status of [301, 302, 307, 400, 401, 403, 404, 429, 500]) {
    let calls = 0;
    const client = createMagentoClient(config, { fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.redirect, 'manual');
      return new Response(JSON.stringify({ secrets: env, authorization: options.headers.Authorization }), {
        status, headers: { Location: 'https://evil.invalid', 'Content-Type': 'application/json' },
      });
    } });
    await assert.rejects(client.getWebsites(), (error) => {
      assert.equal(error.code, 'MAGENTO_HTTP_ERROR'); assert.equal(error.status, status); return noSecrets(error);
    });
    assert.equal(calls, 1);
  }
});

test('transport and invalid JSON/content-type errors are sanitized', async () => {
  for (const [fetchImpl, code] of [
    [async () => { throw new Error(JSON.stringify(env)); }, 'MAGENTO_NETWORK_ERROR'],
    [async () => new Response(JSON.stringify(env)), 'MAGENTO_RESPONSE_INVALID'],
    [async () => new Response('test-secret&', { headers: { 'Content-Type': 'application/json' } }), 'MAGENTO_RESPONSE_INVALID'],
    [async () => new Response(null, { status: 204 }), 'MAGENTO_RESPONSE_INVALID'],
  ]) {
    await assert.rejects(createMagentoClient(config, { fetchImpl }).getWebsites(), (error) => {
      assert.equal(error.code, code); return noSecrets(error);
    });
  }
});

test('response bytes are bounded', async () => {
  const client = createMagentoClient(config, { fetchImpl: async () => json('x'.repeat(MAX_RESPONSE_BYTES)) });
  await assert.rejects(client.getWebsites(), { code: 'MAGENTO_RESPONSE_TOO_LARGE' });
});

test('AbortController bounds both response headers and slow JSON body reads', async () => {
  for (const bodyPhase of [false, true]) {
    let signal;
    const client = createMagentoClient(config, { timeoutMs: 10, fetchImpl: async (_url, options) => {
      signal = options.signal;
      if (!bodyPhase) return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error(JSON.stringify(env))), { once: true });
      });
      const stream = new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(new Error(JSON.stringify(env))), { once: true });
      } });
      return new Response(stream, { headers: { 'Content-Type': 'application/json' } });
    } });
    await assert.rejects(client.getWebsites(), (error) => {
      assert.equal(error.code, 'MAGENTO_TIMEOUT'); return noSecrets(error);
    });
    assert.equal(signal.aborted, true);
  }
});

function captureLog() {
  const entries = [];
  return { entries, log: { info: (event, context) => entries.push({ event, ...context }),
    error: (event, context) => entries.push({ event, ...context }) } };
}

function discoveryFetch(calls, overrides = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.method, 'GET');
    const parsed = new URL(url);
    const route = parsed.pathname.split('/V1/')[1];
    if (overrides[route]) return overrides[route](parsed, options);
    if (route.startsWith('store/')) return json([{ id: 9, secret: env, reflectedHeader: options.headers.Authorization }]);
    if (route === 'products/attribute-sets/sets/list') return json({ items: [{ attribute_set_id: 17 }], total_count: 1 });
    if (route === 'products/attributes') return json({ items: [{ attribute_code: 'stone_color' }], total_count: 1 });
    if (route === 'products/attribute-sets/17/attributes') return json([{ attribute_code: 'stone_color' }]);
    if (route === 'products/attributes/stone_color') return json({ attribute_id: 11, attribute_code: 'stone_color' });
    if (route === 'products/attributes/stone_color/options') return json([{ label: JSON.stringify(env), value: '99' }]);
    if (route.startsWith('products/')) return json({ id: 42, sku: decodeURIComponent(route.slice(9)),
      attribute_set_id: 17, status: 1, name: JSON.stringify(env), extension_attributes: { authorization: options.headers.Authorization } });
    throw new Error('Unexpected endpoint');
  };
}

test('unconfigured/help probes require no application/DB config and make no network requests', async () => {
  for (const args of [[], ['--help']]) {
    const { log, entries } = captureLog();
    const code = await runProbe({ env: {}, args, log, fetchImpl: () => assert.fail('Unexpected network request') });
    assert.equal(code, 0);
    if (!args.length) assert.deepEqual(entries, [{ event: 'magento.probe.configuration', configured: false }]);
  }
});

test('default probe prints bounded discovery counts and performs no product read', async () => {
  const calls = [];
  const { log, entries } = captureLog();
  assert.equal(await runProbe({ env, log, fetchImpl: discoveryFetch(calls) }), 0);
  assert.equal(calls.length, 6);
  assert.deepEqual(entries[1], { event: 'magento.probe.discovery', websites: 1, storeGroups: 1,
    storeViews: 1, storeConfigs: 1, attributeSets: 1, attributeSetIdsSample: [17], productAttributes: 1 });
  assert.ok(JSON.stringify(entries).length < 500);
});

test('explicit product/set/option probe prints safe subset without headers or remote text', async () => {
  const calls = [];
  const { log, entries } = captureLog();
  assert.equal(await runProbe({ env, args: ['--sku', 'KL3/11131351005', '--attribute-set', '17', '--attribute', 'stone_color'],
    log, fetchImpl: discoveryFetch(calls) }), 0);
  assert.equal(calls.length, 10);
  assert.deepEqual(entries.at(-1), { event: 'magento.probe.product', requestedSku: 'KL3/11131351005',
    returnedSkuMatches: true, productId: 42, attributeSetId: 17, status: 1 });
  const output = JSON.stringify(entries);
  for (const secret of Object.values(env)) assert.ok(!output.includes(secret));
  assert.ok(!/Authorization|oauth_signature|extension_attributes/.test(output));
  assert.equal(entries.find((entry) => entry.event === 'magento.probe.attribute').options, 1);
});

test('probe redacts credentials even if explicitly supplied as SKU, and sanitizes errors', async () => {
  for (const sku of ['test-secret&', 'test-secret%26', 'test-token-secret/']) {
    const { log, entries } = captureLog();
    assert.equal(await runProbe({ env, args: ['--sku', sku], log, fetchImpl: discoveryFetch([]) }), 0);
    assert.ok(!JSON.stringify(entries).includes(sku));
    assert.ok(entries.at(-1).requestedSku.includes('[redacted]'));
  }
  for (const options of [
    { env: { MAGENTO_CONSUMER_SECRET: env.MAGENTO_CONSUMER_SECRET } },
    { env, fetchImpl: async () => { throw new Error(JSON.stringify(env)); } },
    { env, args: ['--unknown', JSON.stringify(env)] },
  ]) {
    const { log, entries } = captureLog();
    assert.equal(await runProbe({ ...options, log }), 1);
    for (const secret of Object.values(env)) assert.ok(!JSON.stringify(entries).includes(secret));
  }
});

test('probe pagination counts all pages without dumping records', async () => {
  const calls = [];
  const { log, entries } = captureLog();
  const fetchImpl = discoveryFetch(calls, { 'products/attributes': (url) => {
    const page = Number(url.searchParams.get('searchCriteria[currentPage]'));
    return json({ items: Array.from({ length: page === 1 ? 100 : 1 }, (_, i) => ({ attribute_code: `attribute_${page}_${i}` })), total_count: 101 });
  } });
  assert.equal(await runProbe({ env, log, fetchImpl }), 0);
  assert.equal(calls.length, 7);
  assert.equal(entries[1].productAttributes, 101);
});

test('probe fails on inconsistent/repeated pages, unexpected shapes, or discovery bounds', async () => {
  for (const body of [[], { items: [], total_count: 1 }, { items: [], total_count: 10001 },
    { items: [{ attribute_code: 'repeated' }], total_count: 2 },
    { items: [], total_count: 'secret-test-token' }]) {
    const { log, entries } = captureLog();
    assert.equal(await runProbe({ env, log, fetchImpl: discoveryFetch([], { 'products/attributes': () => json(body) }) }), 1);
    assert.match(entries.at(-1).code, /^MAGENTO_(RESPONSE_INVALID|DISCOVERY_LIMIT)$/);
  }
});

test('probe does not claim SKU support for a mismatched product response', async () => {
  const { log, entries } = captureLog();
  assert.equal(await runProbe({ env, args: ['--sku', 'KL3/11131351005'], log,
    fetchImpl: discoveryFetch([], { 'products/KL3%2F11131351005': () => json({ id: 1, sku: 'OTHER' }) }) }), 1);
  assert.equal(entries.at(-1).code, 'MAGENTO_RESPONSE_INVALID');
  assert.equal(entries.some((entry) => entry.event === 'magento.probe.product'), false);
});

test('CLI arguments are bounded and reject unsupported writes/raw diagnostics', () => {
  for (const args of [['--sku'], ['--json'], ['--method', 'POST'], ['--sku', 'a', '--sku', 'b'],
    ['--store-code', '../admin'], ['--attribute-set', '-1'], ['--attribute', '../x'], ['--sku', '..'],
    Array.from({ length: 21 }, () => ['--attribute-set', '1']).flat()]) {
    assert.throws(() => parseArguments(args), { code: 'MAGENTO_PROBE_ARGUMENTS' });
  }
});
