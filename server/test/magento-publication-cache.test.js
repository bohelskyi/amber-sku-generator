const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { cachedReads } = require('../src/services/magento/binding-publication');
const { createMagentoClient, MAX_RESPONSE_BYTES } = require('../src/services/magento/client');

const config = { configured: true, baseUrl: 'https://cache-fixture.invalid', consumerKey: 'test',
  consumerSecret: 'test', accessToken: 'test', accessTokenSecret: 'test' };

test('publication GET cache detaches native response bodies from the completed caller signal', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET'); requests++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url.includes('/categories?') ? { id: 2, name: 'Default', children_data: [] } : []));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const signals = [];
  try {
    const fetchImpl = cachedReads((url, options) => {
      signals.push(options.signal);
      const path = new URL(url);
      return fetch(`http://127.0.0.1:${server.address().port}${path.pathname}${path.search}`, options);
    });
    const client = createMagentoClient(config, { fetchImpl });
    const first = await client.getCategoryTree(2);
    assert.equal(signals[0].aborted, true, 'client aborts after successfully consuming its response');
    assert.deepEqual(await client.getCategoryTree(2), first);
    assert.deepEqual(await client.getCategoryTree(2), first);
    assert.equal(requests, 1);
    for (const read of [() => client.getWebsites(), () => client.getStoreViews(), () => client.getProductAttributeOptions('color')]) {
      const value = await read();
      assert.deepEqual(await read(), value);
    }
    assert.equal(requests, 4, 'all repeated GET routes use detached evidence');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('cache shares one pending GET and returns independent bodies, status and headers', async () => {
  let requests = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const cached = cachedReads(async () => {
    requests++; await gate;
    return new Response('{"value":"Бурштин"}', { status: 201, statusText: 'Created',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Evidence': 'exact' } });
  });
  const one = cached('https://cache-fixture.invalid/resource', { method: 'GET' });
  const two = cached('https://cache-fixture.invalid/resource', { method: 'GET' });
  release();
  const [first, second] = await Promise.all([one, two]);
  assert.equal(requests, 1); assert.notEqual(first, second);
  assert.equal(second.status, 201); assert.equal(second.statusText, 'Created');
  first.headers.set('X-Evidence', 'changed');
  assert.equal(second.headers.get('X-Evidence'), 'exact');
  assert.equal(second.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(await first.text(), await second.text());
});

test('failed GETs and HTTP failures can retry without poisoning publication evidence', async () => {
  let requests = 0;
  const cached = cachedReads(async () => {
    requests++;
    if (requests === 1) throw new TypeError('Synthetic network failure');
    return new Response('{}', { status: requests === 2 ? 503 : 200, headers: { 'Content-Type': 'application/json' } });
  });
  const url = config.baseUrl + '/resource', options = { method: 'GET' };
  await assert.rejects(cached(url, options), TypeError);
  const unavailable = await cached(url, options);
  assert.equal(unavailable.status, 503); assert.equal(await unavailable.text(), '{}');
  assert.equal((await cached(url, options)).status, 200);
  assert.equal((await cached(url, options)).status, 200); assert.equal(requests, 3);
});

test('failed in-flight response snapshots are evicted and clients remain fail closed', async () => {
  let requests = 0;
  const cached = cachedReads(async (url, { signal }) => {
    if (++requests > 1) return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('{'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      setImmediate(() => controller.error(new TypeError('Synthetic broken response body')));
    } }), { headers: { 'Content-Type': 'application/json' } });
  });
  const client = createMagentoClient(config, { fetchImpl: cached });
  await assert.rejects(client.getCategoryTree(2), { code: 'MAGENTO_NETWORK_ERROR' });
  assert.deepEqual(await client.getCategoryTree(2), {});
  assert.equal(requests, 2);
});

test('aborting a streamed snapshot does not poison the next logical GET', async () => {
  let requests = 0;
  const controller = new AbortController();
  const cached = cachedReads(async (url, { signal }) => {
    if (++requests > 1) return new Response('{}');
    return new Response(new ReadableStream({ start(body) {
      body.enqueue(Buffer.from('{'));
      signal.addEventListener('abort', () => body.error(signal.reason), { once: true });
      setImmediate(() => controller.abort());
    } }));
  });
  await assert.rejects(cached(config.baseUrl, { method: 'GET', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(await (await cached(config.baseUrl, { method: 'GET', signal: new AbortController().signal })).text(), '{}');
  assert.equal(requests, 2);
});

test('cache uses the client 8 MiB bound and cancels oversized streamed bodies before retry', async () => {
  let cancelled = false, requests = 0;
  const cached = cachedReads(async () => {
    requests++;
    if (requests === 1) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.alloc(MAX_RESPONSE_BYTES)); controller.enqueue(Buffer.from('x'));
    }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } });
    return new Response(Buffer.alloc(MAX_RESPONSE_BYTES, 'x'), { headers: { 'Content-Type': 'application/json' } });
  });
  const url = config.baseUrl + '/bounded', options = { method: 'GET' };
  await assert.rejects(cached(url, options), { code: 'MAGENTO_RESPONSE_TOO_LARGE' });
  assert.equal(cancelled, true);
  assert.equal((await (await cached(url, options)).arrayBuffer()).byteLength, MAX_RESPONSE_BYTES);
  assert.equal((await (await cached(url, options)).arrayBuffer()).byteLength, MAX_RESPONSE_BYTES);
  assert.equal(requests, 2);
});

test('publication cache retains GET-only and deadline restrictions and empty HTTP statuses', async t => {
  let requests = 0;
  const originalNow = Date.now(), cached = cachedReads(async () => { requests++; return new Response(null, { status: 204 }); });
  await assert.rejects(cached(config.baseUrl, { method: 'POST' }));
  assert.equal(requests, 0);
  assert.equal((await cached(config.baseUrl, { method: 'GET' })).status, 204);
  assert.equal(await (await cached(config.baseUrl, { method: 'GET' })).text(), '');
  t.mock.method(Date, 'now', () => originalNow + 60001);
  await assert.rejects(cached(config.baseUrl, { method: 'GET' }), { code: 'MAGENTO_DISCOVERY_LIMIT' });
  assert.equal(requests, 1);
});
