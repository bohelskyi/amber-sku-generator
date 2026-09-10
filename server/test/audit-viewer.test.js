const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AuditViewerError,
  MAX_PAGE_SIZE,
  getAuditEvents,
  normalizeAuditEvent,
  normalizeAuditFilters,
  normalizeDetails,
} = require('../src/services/audit-viewer.service');

function row(id, overrides = {}) {
  return {
    id: String(id),
    event_key: 'product.created',
    actor_user_id: '7',
    actor_snapshot: { displayName: 'Historical Name', preferredUsername: 'historical.user' },
    subject_type: 'product',
    subject_id: String(id),
    details: { fullSku: `SKU-${id}`, requestId: 'hidden', claimToken: 'hidden' },
    occurred_at: new Date('2026-09-10T12:00:00.000Z'),
    ...overrides,
  };
}

test('audit viewer validates filters and requires a subject type for subject IDs', () => {
  assert.deepEqual(normalizeAuditFilters({ domain: 'product', actorId: '7' }), {
    from: null, to: null, eventKey: null, domain: 'product', actorId: 7,
    subjectType: null, subjectId: null,
  });
  for (const query of [
    { domain: 'Product!' },
    { eventKey: 'invalid' },
    { actorId: '0' },
    { subjectId: '5' },
    { from: '2026-09-10' },
    { from: '2026-09-11T00:00:00Z', to: '2026-09-10T00:00:00Z' },
  ]) assert.throws(() => normalizeAuditFilters(query), AuditViewerError);
});

test('audit viewer normalizes immutable snapshot actors and explicit missing profile attribution', () => {
  assert.deepEqual(normalizeAuditEvent(row(1)).actor, {
    status: 'recorded', id: 7, displayName: 'Historical Name', preferredUsername: 'historical.user',
  });
  assert.deepEqual(normalizeAuditEvent(row(2, {
    actor_snapshot: { displayName: null, preferredUsername: null },
  })).actor, {
    status: 'recorded_reference', id: 7, displayName: null, preferredUsername: null,
  });
  assert.deepEqual(normalizeAuditEvent(row(3, {
    actor_user_id: null, actor_snapshot: null,
  })).actor, {
    status: 'not_recorded', id: null, displayName: null, preferredUsername: null,
  });
});

test('audit detail normalization allowlists business fields and strips operational or secret data', () => {
  assert.deepEqual(normalizeDetails('product.recounted', {
    sourceSku: 'A', correctedSku: 'B', correctionRequestId: 88,
    requestId: 'http-request', claimToken: 'secret', arbitrary: 'hidden',
    changes: { price: { before: 10, after: 20, sessionToken: 'hidden' } },
  }), {
    sourceSku: 'A', correctedSku: 'B', changes: { price: { before: 10, after: 20 } },
  });
  assert.deepEqual(normalizeDetails('future_domain.did_something', { name: 'must stay hidden' }), {});
});

test('audit listing uses deterministic keyset pagination and caps page size', async () => {
  const calls = [];
  const pages = [[row(5), row(4), row(3)], [row(2), row(1)]];
  const databasePool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: pages.shift() };
    },
  };
  const first = await getAuditEvents({ domain: 'product', limit: 2 }, { databasePool });
  assert.deepEqual(first.items.map((event) => event.subject.id), ['5', '4']);
  assert.equal(first.page.hasMore, true);
  assert.ok(first.page.nextCursor);
  const second = await getAuditEvents({
    domain: 'product', limit: 2, cursor: first.page.nextCursor,
  }, { databasePool });
  assert.deepEqual(second.items.map((event) => event.subject.id), ['2', '1']);
  assert.match(calls[0].sql, /ORDER BY occurred_at DESC, id DESC/);
  assert.match(calls[1].sql, /\(occurred_at, id\) </);
  await assert.rejects(
    getAuditEvents({ domain: 'role', limit: 2, cursor: first.page.nextCursor }, { databasePool }),
    (error) => error.code === 'INVALID_CURSOR'
  );

  const cappedPool = { query: async (_sql, values) => ({ rows: [], values }) };
  const capped = await getAuditEvents({ limit: 999 }, { databasePool: cappedPool });
  assert.equal(capped.page.limit, MAX_PAGE_SIZE);
});
