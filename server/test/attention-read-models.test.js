const assert = require('node:assert/strict');
const test = require('node:test');

const {
  getCorrectionRequestForView,
  getCorrectionRequestPage,
  getCorrectionRequests,
} = require('../src/services/correction-request.service');
const { problemPage } = require('../src/services/magento/sync-problems');
const { getRepricingBatchPage } = require('../src/services/repricing/batch-read-model');

test('correction queue page is bounded, searchable with literal wildcards, and keeps full summary counts', async () => {
  const calls = [];
  const queryable = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes('COUNT(*)::int AS all_count')) return { rows: [{ all_count: 9, pending_count: 3, in_progress_count: 2, completed_count: 3, rejected_count: 1 }] };
    if (sql.includes('COUNT(*)::int AS count')) return { rows: [{ count: 5 }] };
    return { rows: [{
      id: 7,
      request_type: 'recount',
      source_product_id: 11,
      source_sku: 'BR7/1',
      proposed_sku: 'BR7/2',
      source_public_sku: 'AG-000007',
      corrected_public_sku: null,
      old_payload: { publicSku: 'AG-000007' },
      proposed_payload: { publicSku: 'AG-000007' },
      changes: [],
      status: 'pending',
      claim_version: 0,
    }] };
  } };

  const result = await getCorrectionRequestPage({
    status: 'active', search: 'AG_%\\', limit: '1.9', offset: 2,
  }, queryable);

  assert.equal(result.items[0].sourceArticle, 'AG-000007');
  assert.equal(result.items[0].sourceInternalSku, 'BR7/1');
  assert.deepEqual(result.summary, { all: 9, active: 5, pending: 3, inProgress: 2, completed: 3, rejected: 1 });
  assert.deepEqual(result.pageInfo, { limit: 1, offset: 2, total: 5, hasPrevious: true, hasNext: true });
  const list = calls.find((call) => call.sql.includes('LIMIT $3'));
  assert.ok(list);
  assert.match(list.sql, /COALESCE\(cr\.comment, ''\) ILIKE/);
  assert.match(list.sql, /ESCAPE '\\'/);
  assert.deepEqual(list.values, [['pending', 'in_progress'], '%AG\\_\\%\\\\%', 1, 2]);
});

test('correction detail returns an exact independently addressable request', async () => {
  const calls = [];
  const request = await getCorrectionRequestForView('13', { async query(sql, values) {
    calls.push({ sql, values });
    return { rows: [{ id: 13, source_product_id: 21, source_sku: 'NM13', proposed_sku: 'NM14',
      source_public_sku: null, old_payload: {}, proposed_payload: {}, changes: [], status: 'completed', claim_version: 4 }] };
  } });
  assert.equal(request.id, 13);
  assert.equal(request.sourceArticle, null);
  assert.equal(request.sourceInternalSku, 'NM13');
  assert.match(calls[0].sql, /WHERE cr\.id = \$1/);
  assert.deepEqual(calls[0].values, [13]);
});

test('legacy correction list preserves its 300/1000 bounds and wildcard search contract', async () => {
  const calls = [];
  const queryable = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql.includes('COUNT(*)::int AS all_count')) return { rows: [{}] };
    if (sql.includes('COUNT(*)::int AS count')) return { rows: [{ count: 0 }] };
    return { rows: [] };
  } };
  await getCorrectionRequests({ search: 'AG_%' }, queryable);
  const defaultList = calls.find((call) => call.sql.includes('LIMIT $3'));
  assert.deepEqual(defaultList.values, [['pending', 'in_progress'], '%AG_%%', 300, 0]);
  assert.doesNotMatch(defaultList.sql, /COALESCE\(cr\.comment/);
  assert.doesNotMatch(defaultList.sql, /ESCAPE/);

  calls.length = 0;
  await getCorrectionRequests({ status: 'all', limit: 5000 }, queryable);
  const maximumList = calls.find((call) => call.sql.includes('LIMIT $1'));
  assert.deepEqual(maximumList.values, [1000, 0]);
});

test('synchronization problems page applies category and bounded offset without changing diagnostics', async () => {
  const calls = [];
  const result = await problemPage({ configured: false }, { category: 'BR', limit: 1, offset: 1 }, {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('COUNT(*)::int')) return { rows: [{ count: 3 }] };
      return { rows: [{ productId: 22, article: 'AG-000022', category: 'BR', reason_code: 'reconciliation_required', diagnostics: [] }] };
    },
  });
  assert.equal(result.items[0].problems[0].resolution, 'administrator');
  assert.deepEqual(result.pageInfo, { limit: 1, offset: 1, total: 3, hasPrevious: true, hasNext: true });
  assert.deepEqual(calls[0].values, ['unconfigured', 'BR', 1, 1]);
  assert.deepEqual(calls[1].values, ['BR']);
});

test('repricing history page preserves authoritative rollback eligibility and exact page bounds', async () => {
  const calls = [];
  const result = await getRepricingBatchPage({ limit: 1, offset: 2 }, {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('COUNT(*)::int')) return { rows: [{ count: 4 }] };
      return { rows: [{ id: '9', scope: 'global', scenario_id: null, status: 'completed', changed_count: '3', can_rollback: false }] };
    },
  });
  assert.equal(result.items[0].id, 9);
  assert.equal(result.items[0].can_rollback, false);
  assert.deepEqual(result.pageInfo, { limit: 1, offset: 2, total: 4, hasPrevious: true, hasNext: true });
  assert.match(calls[0].sql, /IS DISTINCT FROM ri\.new_payload/);
  assert.deepEqual(calls[0].values, [1, 2]);
});

test('new attention read projections reject invalid paging before querying', async () => {
  const queryable = { query: async () => { throw new Error('must not query'); } };
  await assert.rejects(getCorrectionRequestPage({ limit: 'Infinity' }, queryable), (error) => error.statusCode === 422);
  await assert.rejects(problemPage({ configured: false }, { offset: -1 }, queryable), (error) => error.statusCode === 422);
  await assert.rejects(getRepricingBatchPage({ limit: 'bad' }, queryable), (error) => error.statusCode === 422);
});
