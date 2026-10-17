'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { schemaReadCache, schemaRoute, parseSeconds } = require('../scripts/magento-schema-read-cache');
const base = 'https://shop.example.invalid/rest/all/V1/';

function upstream() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (String(url).includes('fail')) return new Response('{"message":"no"}', { status: 500 });
    return new Response(JSON.stringify({ url: String(url), n: calls.length }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('only schema and topology GETs are cached; products, inventory and writes are always fresh', async () => {
  for (const path of ['store/websites', 'store/storeGroups', 'store/storeViews', 'store/storeConfigs', 'products/attribute-sets/sets/list?x=1',
    'products/attribute-sets/151/attributes', 'products/attributes?searchCriteria=1', 'products/attributes/kolir/options', 'categories?rootCategoryId=2'])
    assert.equal(schemaRoute(base + path), true, path);
  for (const path of ['products?searchCriteria[filter_groups][0][filters][0][value]=SV1', 'products/SV1', 'inventory/source-items',
    'inventory/stock-resolver/website/base', 'categories/44', 'products/attributes/kolir'])
    assert.equal(schemaRoute(base + path), false, path);
  let now = 0; const u = upstream(), cached = schemaReadCache(u.fetchImpl, 120, () => now);
  const one = await (await cached(base + 'products/attributes/kolir/options', { method: 'GET' })).json();
  const two = await (await cached(base + 'products/attributes/kolir/options', { method: 'GET' })).json();
  assert.deepEqual(one, two); assert.equal(u.calls.length, 1);
  await cached(base + 'products/SV1', { method: 'GET' }); await cached(base + 'products/SV1', { method: 'GET' });
  await cached(base + 'products/attributes/kolir/options', { method: 'POST', body: '{}' });
  assert.equal(u.calls.length, 4);
  now = 120000;
  await cached(base + 'products/attributes/kolir/options', { method: 'GET' });
  assert.equal(u.calls.length, 5, 'expired entries are observed again');
});

test('failed responses are never reused and zero seconds leaves the transport unchanged', async () => {
  const u = upstream(), cached = schemaReadCache(u.fetchImpl, 60);
  assert.equal((await cached(base + 'products/attributes/fail/options', {})).status, 500);
  assert.equal((await cached(base + 'products/attributes/fail/options', {})).status, 500);
  assert.equal(u.calls.length, 2);
  assert.equal(schemaReadCache(u.fetchImpl, 0), u.fetchImpl);
  assert.throws(() => schemaReadCache(u.fetchImpl, 601), /SCHEMA_CACHE_TTL_INVALID/);
  assert.deepEqual(['0', '60', '600', undefined].map(parseSeconds), [0, 60, 600, 0]);
  assert.deepEqual(['601', '-1', '1.5', '060', ''].map(parseSeconds), [null, null, null, null, null]);
});
