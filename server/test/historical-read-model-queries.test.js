const test = require('node:test');
const assert = require('node:assert/strict');

const {
  loadCorrectionHistoryReport,
} = require('../src/services/correction-history/correction-history-query');
const {
  normalizeHistoryFilters,
} = require('../src/services/correction-history/correction-history-filters');
const {
  loadProductTimelineData,
  loadTimelineSeedRows,
} = require('../src/services/product-timeline/product-timeline-query');
const {
  presentCorrectionHistoryReport,
} = require('../src/presenters/correction-history');

function correctionHistoryDatabase(calls) {
  return {
    query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('SELECT pc.*')) return Promise.resolve({ rows: [{ id: 7 }] });
      if (sql.includes('COUNT(*)::int AS total_count')) {
        return Promise.resolve({ rows: [{
          total_count: 1,
          increased_count: 1,
          decreased_count: 0,
          unchanged_count: 0,
          net_price_delta_uah: '25.50',
          first_at: '2026-01-01T00:00:00.000Z',
          last_at: '2026-01-02T00:00:00.000Z',
        }] });
      }
      return Promise.resolve({ rows: [{ category_code: 'BR', count: 1 }] });
    },
  };
}

test('correction-history loader preserves filter order and offset pagination contract', async () => {
  const calls = [];
  const filters = normalizeHistoryFilters({
    category: 'br',
    search: 'needle',
    from: '2026-01-01',
    to: '2026-01-31',
  });

  const data = await loadCorrectionHistoryReport(
    filters,
    { forExport: false, limit: 25, offset: 50 },
    correctionHistoryDatabase(calls)
  );

  assert.equal(calls.length, 3);
  assert.match(calls[0].sql, /ORDER BY pc\.created_at DESC, pc\.id DESC/);
  assert.match(calls[0].sql, /LIMIT \$5 OFFSET \$6/);
  assert.deepEqual(calls[0].values, [
    'BR', '%needle%', '2026-01-01', '2026-01-31', 25, 50,
  ]);
  assert.deepEqual(calls[1].values, ['BR', '%needle%', '2026-01-01', '2026-01-31']);
  assert.equal(calls[2].values, undefined);
  assert.deepEqual(data.itemRows, [{ id: 7 }]);
});

test('correction-history export loader omits pagination and presenter preserves response shape', async () => {
  const calls = [];
  const data = await loadCorrectionHistoryReport(
    normalizeHistoryFilters({ search: 'SKU' }),
    { forExport: true, limit: 200, offset: 0 },
    correctionHistoryDatabase(calls)
  );

  assert.doesNotMatch(calls[0].sql, /\bLIMIT\b|\bOFFSET\b/);
  assert.deepEqual(calls[0].values, ['%SKU%']);

  data.itemRows = [];
  const response = presentCorrectionHistoryReport(
    data,
    { categories: { BR: { name: 'Браслети' } } },
    { limit: 200, offset: 0 }
  );
  assert.deepEqual(response, {
    items: [],
    summary: {
      totalCount: 1,
      increasedCount: 1,
      decreasedCount: 0,
      unchangedCount: 0,
      netPriceDeltaUah: 25.5,
      firstAt: '2026-01-01T00:00:00.000Z',
      lastAt: '2026-01-02T00:00:00.000Z',
    },
    categories: [{ code: 'BR', name: 'Браслети', count: 1 }],
    limit: 200,
    offset: 0,
  });
});

test('timeline loader keeps batched query inputs and loads every referenced immutable schema', async () => {
  const calls = [];
  const database = {
    query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('WITH RECURSIVE edges')) {
        return Promise.resolve({ rows: [{
          id: 5,
          full_sku: 'SKU-A',
          sku_schema_version_id: 3,
        }, {
          id: 6,
          full_sku: 'SKU-B',
          sku_schema_version_id: null,
        }] });
      }
      if (sql.includes('SELECT * FROM product_corrections')) {
        return Promise.resolve({ rows: [{
          id: 10,
          old_payload: { skuSchemaVersionId: 9 },
          new_payload: {},
        }] });
      }
      if (sql.includes('SELECT * FROM correction_requests')) {
        return Promise.resolve({ rows: [{
          id: 11,
          old_payload: {},
          proposed_payload: { skuSchemaVersionId: 10 },
        }] });
      }
      if (sql.includes('FROM repricing_items')) {
        return Promise.resolve({ rows: [{ batch_id: 12 }] });
      }
      if (sql.includes('FROM audit_events')) return Promise.resolve({ rows: [{ id: 13 }] });
      if (sql.includes('FROM sku_schema_questions')) return Promise.resolve({ rows: [{ schema_version_id: 3 }] });
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const data = await loadProductTimelineData(5, database);

  assert.deepEqual(calls[0].values, [5]);
  assert.deepEqual(calls[1].values, [[5, 6], ['SKU-A', 'SKU-B']]);
  assert.deepEqual(calls[2].values, [[5, 6]]);
  assert.deepEqual(calls[3].values, [[5, 6]]);
  assert.deepEqual(calls[4].values, [['5', '6'], ['11'], ['12']]);
  assert.deepEqual(calls[5].values, [[3, 9, 10]]);
  assert.deepEqual(data, {
    products: [
      { id: 5, full_sku: 'SKU-A', sku_schema_version_id: 3 },
      { id: 6, full_sku: 'SKU-B', sku_schema_version_id: null },
    ],
    corrections: [{ id: 10, old_payload: { skuSchemaVersionId: 9 }, new_payload: {} }],
    requests: [{ id: 11, old_payload: {}, proposed_payload: { skuSchemaVersionId: 10 } }],
    repricingItems: [{ batch_id: 12 }],
    audits: [{ id: 13 }],
    schemaRows: [{ schema_version_id: 3 }],
  });
});

test('timeline seed lookup keeps exact SKU equality and ordered ambiguity evidence', async () => {
  const calls = [];
  const rows = await loadTimelineSeedRows('BR2/123-001', {
    query(sql, values) {
      calls.push({ sql, values });
      return Promise.resolve({ rows: [{ id: 1 }, { id: 2 }] });
    },
  });

  assert.deepEqual(rows, [{ id: 1 }, { id: 2 }]);
  assert.match(calls[0].sql, /full_sku = \$1 ORDER BY id/);
  assert.deepEqual(calls[0].values, ['BR2/123-001']);
});
