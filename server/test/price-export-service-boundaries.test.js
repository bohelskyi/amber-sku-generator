const test = require('node:test');
const assert = require('node:assert/strict');
const { Socket } = require('node:net');
const pool = require('../src/db/pool');
const service = require('../src/services/price-export.service');

const context = { actorUserId: 7, requestId: 'price-export-unit' };
const result = (rows = []) => ({ rows, rowCount: rows.length });
const step = (sql, rows = [], check) => ({ sql, rows, check });
const begin = () => [step(/^SELECT pg_advisory_lock_shared/), step('BEGIN'),
  step("SET LOCAL amber.lifecycle_writer_version = '1'"), step(/^SELECT to_regclass/, [{ present: false }])];
const finish = (command) => [step(command), step(/^SELECT pg_advisory_unlock_shared/)];

function fixture(t, queries = [], transaction = []) {
  let released = 0; let connected = 0;
  const observed = [];
  const consume = (queue) => async (sql, params = []) => {
    observed.push({ sql, params });
    const expected = queue.shift();
    assert.ok(expected, `Unexpected SQL: ${sql}`);
    if (expected.sql instanceof RegExp) assert.match(sql, expected.sql);
    else assert.equal(sql, expected.sql);
    expected.check?.(params, sql);
    if (expected.error) throw expected.error;
    return result(expected.rows);
  };
  const client = { query: consume(transaction), release() { released++; } };
  t.mock.method(pool, 'query', consume(queries));
  t.mock.method(pool, 'connect', async () => { connected++; return client; });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  t.mock.method(Socket.prototype, 'connect', () => { throw new Error('Unexpected network connection'); });
  t.after(() => { assert.equal(queries.length, 0); assert.equal(transaction.length, 0); assert.equal(released, connected); });
  return { observed, get connected() { return connected; } };
}

test('price export validates key and actor before any database work', async (t) => {
  const f = fixture(t);
  for (const key of ['', ' ', 'x'.repeat(201)]) {
    await assert.rejects(service.createPriceExportSnapshot({ idempotencyKey: key }, { mutationContext: context }), { statusCode: 400 });
  }
  await assert.rejects(service.createPriceExportSnapshot({ idempotencyKey: 'key' }), /actor user ID/);
  assert.equal(f.connected, 0);
});

test('completed price-export retry returns original bytes and attribution without a new transaction', async (t) => {
  const stored = { id: 'price-1', csv_content: 'original bytes', created_by_user_id: 3, status: 'confirmed' };
  const f = fixture(t, [step(/^SELECT \* FROM price_export_snapshots WHERE idempotency_key/, [stored], (p) => assert.deepEqual(p, ['same-key']))]);
  assert.strictEqual(await service.createPriceExportSnapshot({ idempotencyKey: ' same-key ' }, { mutationContext: context }), stored);
  assert.equal(f.connected, 0);
});

for (const emptiedAfterLock of [false, true]) {
  test(`price export refuses an empty ${emptiedAfterLock ? 'locked' : 'initial'} queue and rolls back`, async (t) => {
    const tx = [...begin(), step(/SELECT revisions.product_id/, emptiedAfterLock ? [{ product_id: 4 }] : [])];
    if (emptiedAfterLock) tx.push(step(/SELECT id[\s\S]*FOR SHARE/, [], (p) => assert.deepEqual(p, [[4]])),
      step(/SELECT product_id[\s\S]*FOR UPDATE/), step(/SELECT products.id, products.full_sku/, []));
    tx.push(...finish('ROLLBACK'));
    fixture(t, [step(/^SELECT \* FROM price_export_snapshots/)], tx);
    await assert.rejects(service.createPriceExportSnapshot({ idempotencyKey: 'empty' }, { mutationContext: context }),
      { statusCode: 409, publicCode: 'NO_PENDING_PRICE_EXPORTS' });
  });
}

function captureSteps({ insertError, auditError } = {}) {
  return [...begin(), step(/SELECT revisions.product_id/, [{ product_id: 4 }]),
    step(/SELECT id[\s\S]*FOR SHARE/, [], (p) => assert.deepEqual(p, [[4]])),
    step(/SELECT product_id[\s\S]*FOR UPDATE/, [], (p) => assert.deepEqual(p, [[4]])),
    step(/SELECT products.id, products.full_sku/, [{ id: 4, full_sku: 'BR-INTERNAL', public_sku: 'AG-000004', total_price_uah: '123.45', revision: '8' }]),
    { ...step(/INSERT INTO price_export_snapshots/, [{ id: 'captured', status: 'generated' }], (p) => {
      assert.equal(p[1], 'capture'); assert.equal(p[2], 1); assert.equal(p[6], 7);
      assert.match(p[4], /sku,price\r?\nAG-000004,123\.45/);
      assert.doesNotMatch(p[4], /BR-INTERNAL/);
      assert.deepEqual(JSON.parse(p[5]), [{ productId: 4, revision: 8, internalSku: 'BR-INTERNAL', publicSku: 'AG-000004' }]);
    }), ...(insertError ? { error: insertError } : {}) },
    ...(!insertError ? [step(/SELECT display_name, preferred_username/, [{ display_name: 'Operator', preferred_username: 'op' }]),
      { ...step(/INSERT INTO audit_events/, [{ id: 'audit-1' }], (p) => {
        assert.equal(p[0], 'price_export_snapshot.created'); assert.equal(p[1], 7);
        assert.deepEqual(JSON.parse(p[6]), { rowCount: 1 });
      }), ...(auditError ? { error: auditError } : {}) }] : []),
    ...finish(insertError || auditError ? 'ROLLBACK' : 'COMMIT')];
}

test('price capture stores exact public SKU, manual decimal price and revision evidence before audited commit', async (t) => {
  fixture(t, [step(/^SELECT \* FROM price_export_snapshots/)], captureSteps());
  assert.deepEqual(await service.createPriceExportSnapshot({ idempotencyKey: 'capture' }, { mutationContext: context }), { id: 'captured', status: 'generated' });
});

test('price capture audit failure rolls back the snapshot and releases its connection', async (t) => {
  const failure = new Error('audit unavailable');
  fixture(t, [step(/^SELECT \* FROM price_export_snapshots/)], captureSteps({ auditError: failure }));
  await assert.rejects(service.createPriceExportSnapshot({ idempotencyKey: 'capture' }, { mutationContext: context }), (error) => error === failure);
});

for (const hasWinner of [false, true]) {
  test(`injected price-capture uniqueness conflict ${hasWinner ? 'recovers committed original' : 'preserves error when no winner exists'} after rollback`, async (t) => {
    const failure = Object.assign(new Error('duplicate key'), { code: '23505' });
    const winner = { id: 'winner', created_by_user_id: 3, csv_content: 'immutable' };
    fixture(t, [step(/^SELECT \* FROM price_export_snapshots/),
      step(/^SELECT \* FROM price_export_snapshots/, hasWinner ? [winner] : [])], captureSteps({ insertError: failure }));
    const call = service.createPriceExportSnapshot({ idempotencyKey: 'capture' }, { mutationContext: context });
    if (hasWinner) assert.strictEqual(await call, winner);
    else await assert.rejects(call, (error) => error === failure);
  });
}

test('price confirmation rejects a missing immutable snapshot before acknowledgement writes', async (t) => {
  fixture(t, [], [...begin(), step(/^SELECT \* FROM price_export_snapshots/), ...finish('ROLLBACK')]);
  await assert.rejects(service.confirmPriceExportSnapshot('missing', { mutationContext: context }), { statusCode: 404 });
});

test('price confirmation audit failure rolls back acknowledgement and confirmation together', async (t) => {
  const failure = new Error('confirmation audit failed');
  fixture(t, [], [...begin(), step(/^SELECT \* FROM price_export_snapshots/, [{ row_count: 1, status: 'generated', captured_revisions: [{ productId: 4, revision: 8 }] }]),
    step(/SELECT product_id[\s\S]*FOR UPDATE/), step(/UPDATE product_export_revisions/), step(/UPDATE price_export_snapshots/),
    step(/SELECT display_name, preferred_username/, [{ display_name: 'Operator' }]),
    { ...step(/INSERT INTO audit_events/), error: failure }, ...finish('ROLLBACK')]);
  await assert.rejects(service.confirmPriceExportSnapshot('price-1', { mutationContext: context }), (error) => error === failure);
});

for (const alreadyConfirmed of [false, true]) {
  test(`price confirmation ${alreadyConfirmed ? 'retry preserves first attribution' : 'acknowledges only captured revisions'} in product order`, async (t) => {
    const tx = [...begin(), step(/^SELECT \* FROM price_export_snapshots/, [{ row_count: 2, status: alreadyConfirmed ? 'confirmed' : 'generated',
      captured_revisions: [{ productId: 8, revision: 4 }, { productId: 2, revision: 3 }] }]),
    step(/SELECT product_id[\s\S]*FOR UPDATE/, [], (p) => assert.deepEqual(p, [[2, 8]])),
    step(/UPDATE product_export_revisions/, [], (p, sql) => {
      assert.match(sql, /GREATEST/); assert.match(sql, /captured.revision <= revisions.revision/);
      assert.deepEqual(JSON.parse(p[0]), [{ productId: 2, revision: 3 }, { productId: 8, revision: 4 }]);
    })];
    if (!alreadyConfirmed) tx.push(step(/UPDATE price_export_snapshots/, [], (p) => assert.deepEqual(p, ['price-1', 7])),
      step(/SELECT display_name, preferred_username/, [{ display_name: 'Operator' }]),
      step(/INSERT INTO audit_events/, [], (p) => assert.equal(p[0], 'price_export_snapshot.confirmed')));
    fixture(t, [], [...tx, ...finish('COMMIT')]);
    assert.deepEqual(await service.confirmPriceExportSnapshot('price-1', { mutationContext: context }), { success: true, snapshotId: 'price-1', status: 'confirmed' });
  });
}

test('price preview is observational and uses stored public identity and finalized prices', async (t) => {
  const f = fixture(t, [step(/SELECT products.id, products.full_sku/, [{ public_sku: 'AG-000004', full_sku: 'INTERNAL', total_price_uah: '10.25', checked_at: 'checked' }])]);
  const preview = await service.previewPriceExport();
  assert.equal(preview.checkedAt, 'checked'); assert.equal(preview.rowCount, 1);
  assert.match(preview.csvContent, /AG-000004,10\.25/); assert.doesNotMatch(preview.csvContent, /INTERNAL/);
  assert.equal(f.connected, 0);
});

test('price snapshot metadata read omits CSV and preserves not-found errors', async (t) => {
  fixture(t, [step(/^SELECT id, status/, [{ id: 'stored' }], (p, sql) => {
    assert.deepEqual(p, ['stored']); assert.doesNotMatch(sql, /csv_content/);
  }), step(/^SELECT \* FROM price_export_snapshots/, [])]);
  assert.deepEqual(await service.getPriceExportSnapshot('stored', { includeRows: false }), { id: 'stored' });
  await assert.rejects(service.getPriceExportSnapshot('missing'), { statusCode: 404 });
});

test('price status separates excluded pending changes and safely normalizes latest metadata', async (t) => {
  fixture(t, [step(/COUNT\(\*\) FILTER/, [{ pending_count: '3', excluded_pending_count: '2' }]),
    step(/SELECT id, status, row_count/, [{ id: 'last', status: 'generated', row_count: '3', file_name: 'prices.csv', generated_at: 'then', confirmed_at: null }])]);
  assert.deepEqual(await service.getPriceExportStatus(), { pendingCount: 3, excludedPendingCount: 2,
    latestSnapshot: { id: 'last', status: 'generated', rowCount: 3, fileName: 'prices.csv', generatedAt: 'then', confirmedAt: null } });
});
