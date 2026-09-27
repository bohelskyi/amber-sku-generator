const test = require('node:test');
const assert = require('node:assert/strict');
const { searchSampleProducts, sourceDetails } = require('../src/services/export-templates/display-reads');
test('sample SKU search is bounded, parameterized and exposes only its read projection', async () => {
  let calls = 0;
  const client = { query: async (sql, args) => { calls++; assert.match(sql, /^SELECT/); assert.ok(!sql.includes('BR2/')); assert.deepEqual(args, ['BR2/%_001', 21, 20]); return { rows: Array.from({ length: 21 }, (_, i) => ({ id: i })) }; } };
  const result = await searchSampleProducts(client, { q: 'BR2/%_001', offset: '20' });
  assert.equal(result.products.length, 20); assert.equal(result.nextOffset, 40); assert.equal(calls, 1);
  for (const input of [{ q: '' }, { q: 'a' }, { q: 'a'.repeat(161) }, { q: 'BR', offset: -1 }, { q: 'BR', offset: '2.5' }, { q: 'BR', offset: ['20'] }, { q: ['BR'] }, { q: 'BR', category: 'BR' }]) await assert.rejects(searchSampleProducts(client, input), { statusCode: 400 });
  assert.equal(calls, 1);
});
test('source display is exact-key bounded and truncation never claims missing historical proof', async () => {
  const calls = [];
  const client = { query: async (sql, args) => { calls.push([sql,args]); return { rows: calls.length === 1 ? [] : Array.from({ length: 21 }, () => ({ options: Array.from({ length: 513 }, (_, i) => ({ value_id: String(i), label: 'Evidence' })) })) }; } };
  const result = await sourceDetails(client, { category: 'NM', key: 'extra' });
  assert.equal(result.truncated, true); assert.equal(result.historical.length, 20); assert.equal(result.historical[0].options.length, 512);
  assert.ok(calls.every(([sql,args]) => sql.startsWith('SELECT') && JSON.stringify(args) === JSON.stringify(['NM','extra',513])));
  for (const input of [{ category: 'NO', key: 'extra' }, { category: ['NM'], key: 'extra' }, { category: 'NM', key: '__proto__' }, { category: 'NM', key: "a'" }, { category: 'NM', key: 'extra', repair: true }]) await assert.rejects(sourceDetails(client,input), { statusCode: 400 });
  assert.equal(calls.length, 2);
});
