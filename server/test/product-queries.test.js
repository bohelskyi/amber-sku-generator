const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getProductBySku,
  getRecentProducts,
} = require('../src/services/product/product-queries');

test('single-product read normalizes the exact SKU and preserves its row shape', async () => {
  const calls = [];
  const row = { id: 7, full_sku: 'NM211', created_at: new Date('2026-09-01T00:00:00Z') };
  const queryable = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [row] };
    },
  };

  assert.equal(await getProductBySku(queryable, ' nm211 '), row);
  assert.deepEqual(calls[0].params, ['NM211']);
  assert.match(calls[0].sql, /ORDER BY id ASC LIMIT 1/);
});

test('single-product read returns null when no product exists', async () => {
  const queryable = { query: async () => ({ rows: [] }) };
  assert.equal(await getProductBySku(queryable, 'missing'), null);
});

test('recent-product read preserves database order and archived filtering', async () => {
  const rows = [{ id: 2 }, { id: 1 }];
  let call;
  const queryable = {
    async query(sql, params) {
      call = { sql, params };
      return { rows };
    },
  };

  assert.equal(await getRecentProducts(queryable), rows);
  assert.deepEqual(call.params, []);
  assert.match(call.sql, /COALESCE\(status, 'active'\) <> 'archived'/);
  assert.match(call.sql, /ORDER BY created_at DESC\s+LIMIT 15/);
});
