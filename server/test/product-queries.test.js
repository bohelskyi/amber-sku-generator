const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getProductBySku,
  getProductRegisterPage,
  getRecentProducts,
} = require('../src/services/product/product-queries');

test('single-product read normalizes the exact SKU and preserves its row shape', async () => {
  const calls = [];
  const row = { id: 7, full_sku: 'NM211', public_sku: 'NM211', created_at: new Date('2026-09-01T00:00:00Z') };
  const queryable = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ ...row, public_match: true, internal_match: true }] };
    },
  };

  assert.deepEqual(await getProductBySku(queryable, ' nm211 '), row);
  assert.deepEqual(calls[0].params, ['NM211']);
  assert.match(calls[0].sql, /ORDER BY p.id/);
  assert.match(calls[0].sql, /COALESCE\(\(to_jsonb\(i\)->>'is_test_product'\)::boolean,FALSE\) AS is_test_product/);
  assert.doesNotMatch(calls[0].sql, /i\.is_test_product/);
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
  assert.match(call.sql, /COALESCE\(status, 'active'\) NOT IN \('archived','voided'\)/);
  assert.match(call.sql, /ORDER BY p.created_at DESC\s+LIMIT 15/);
  assert.match(call.sql, /COALESCE\(\(to_jsonb\(i\)->>'is_test_product'\)::boolean,FALSE\) AS is_test_product/);
});

test('product register is bounded, explicitly projected, and returns a filter-bound cursor', async () => {
  const calls = [];
  const queryable = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT DISTINCT p\.category/.test(sql)) return { rows: [{ code: 'BR', name: 'Браслети' }] };
      return { rows: [
        { id: 3, publicSku: 'AG-000003', internalSku: 'BR3/2', categoryCode: 'BR',
          categoryName: 'Браслети', status: 'active', weight: '4.5', priceUah: '1200',
          createdAt: '2026-10-02T10:00:00.000Z' },
        { id: 2, publicSku: 'AG-000002', internalSku: 'BR3/1', categoryCode: 'BR',
          categoryName: 'Браслети', status: 'active', weight: '3.5', priceUah: '900',
          createdAt: '2026-10-02T09:00:00.000Z' },
      ] };
    },
  };

  const first = await getProductRegisterPage(queryable, {
    search: 'AG-', category: 'BR', lifecycle: 'current', limit: 1,
  });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].publicSku, 'AG-000003');
  assert.equal(first.pageInfo.hasMore, true);
  assert.ok(first.pageInfo.nextCursor);
  assert.deepEqual(first.filterOptions.categories, [{ code: 'BR', name: 'Браслети' }]);
  assert.match(calls[0].sql, /identity\.public_sku AS "publicSku"/);
  assert.doesNotMatch(calls[0].sql, /SELECT p\.\*/);
  assert.match(calls[0].sql, /COALESCE\(\(to_jsonb\(identity\)->>'is_test_product'\)::boolean,FALSE\) AS "isTestProduct"/);
  assert.match(calls[0].sql, /corrected_to_product_id IS NULL/);
  assert.match(calls[0].sql, /ORDER BY p\.id DESC/);
  assert.deepEqual(calls[0].params, ['BR', '%AG-%', 2]);

  calls.length = 0;
  await getProductRegisterPage(queryable, {
    search: 'AG-', category: 'BR', lifecycle: 'current', limit: 1,
    cursor: first.pageInfo.nextCursor,
  });
  assert.match(calls[0].sql, /p\.id </);
  assert.deepEqual(calls[0].params, [
    'BR', '%AG-%', 3, 2,
  ]);
});

test('product register rejects a cursor reused with different filters', async () => {
  const rows = [{ id: 3, publicSku: 'AG-000003' }, { id: 2, publicSku: 'AG-000002' }];
  const queryable = { query: async (sql) => ({ rows: /SELECT DISTINCT p\.category/.test(sql) ? [] : rows }) };
  const first = await getProductRegisterPage(queryable, { category: 'BR', limit: 1 });
  await assert.rejects(
    getProductRegisterPage(queryable, { category: 'SV', limit: 1, cursor: first.pageInfo.nextCursor }),
    (error) => error.statusCode === 422 && error.publicCode === 'PRODUCT_REGISTER_QUERY_INVALID'
  );
});

test('product register normalizes fractional limits and escapes literal search wildcards', async () => {
  const calls = [];
  const queryable = { query: async (sql, params = []) => {
    calls.push({ sql, params });
    return { rows: [] };
  } };

  await getProductRegisterPage(queryable, { search: 'AG_%\\', limit: '1.9' });
  assert.match(calls[0].sql, /ILIKE \$1 ESCAPE/);
  assert.deepEqual(calls[0].params, ['%AG\\_\\%\\\\%', 2]);

  await assert.rejects(
    getProductRegisterPage(queryable, { limit: 'Infinity' }),
    (error) => error.statusCode === 422 && error.publicCode === 'PRODUCT_REGISTER_QUERY_INVALID'
  );
});
