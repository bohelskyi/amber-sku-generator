const test = require('node:test');
const assert = require('node:assert/strict');
const { Socket } = require('node:net');
const pool = require('../src/db/pool');
const service = require('../src/services/export.service');
const binding = require('../src/services/export-templates/snapshot-binding');

const context = { actorUserId: 7, requestId: 'export-unit' };
const step = (sql, rows = [], check) => ({ sql, rows, check });
const begin = (phase = 'legacy', command = 'BEGIN ISOLATION LEVEL REPEATABLE READ') => [
  step(/^SELECT pg_advisory_lock_shared/), step(command), step("SET LOCAL amber.lifecycle_writer_version = '1'"),
  step(/^SELECT to_regclass/, [{ present: true }]), step(/^SELECT \* FROM full_product_export_activation/, [{ phase, required_writer_version: 1 }])];
const finish = (command) => [step(command), step(/^SELECT pg_advisory_unlock_shared/)];
const legacy = { id: 'stored', from_sku: 'AG-000001', to_sku: null, created_by_user_id: 2, csv_content: 'original bytes' };
const input = { fromSku: 'AG-000001', idempotencyKey: 'original-key' };

function fixture(t, queries = [], transaction = []) {
  let released = 0; let connected = 0;
  const consume = (queue) => async (sql, params = []) => {
    const expected = queue.shift(); assert.ok(expected, `Unexpected SQL: ${sql}`);
    if (expected.sql instanceof RegExp) assert.match(sql, expected.sql); else assert.equal(sql, expected.sql);
    expected.check?.(params, sql);
    if (expected.error) throw expected.error;
    return { rows: expected.rows, rowCount: expected.rows.length };
  };
  const client = { query: consume(transaction), release() { released++; } };
  const databasePool = { query: consume(queries), async connect() { connected++; return client; } };
  t.mock.method(pool, 'query', async () => { throw new Error('Unexpected default pool query'); });
  t.mock.method(pool, 'connect', async () => { throw new Error('Unexpected default pool connection'); });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
  t.mock.method(Socket.prototype, 'connect', () => { throw new Error('Unexpected network connection'); });
  t.after(() => { assert.equal(queries.length, 0); assert.equal(transaction.length, 0); assert.equal(released, connected); });
  return { options: { databasePool, mutationContext: context }, get connected() { return connected; } };
}

test('product snapshot rejects invalid commands before any query or connection', async (t) => {
  const f = fixture(t);
  for (const [change, code] of [[{ requestContract: 'future' }, 422], [{ profile: 'arbitrary' }, 422],
    [{ mode: 'update' }, 422], [{ mode: 'new' }, 422], [{ idempotencyKey: '' }, 400],
    [{ idempotencyKey: 'x'.repeat(201) }, 400], [{ previewExpectation: 'untrusted' }, 422]]) {
    await assert.rejects(service.createExportSnapshot({ ...input, ...change }, f.options), { statusCode: code });
  }
  await assert.rejects(service.getExportRows('', null, { queryable: f.options.databasePool }), /артикул/);
  assert.equal(f.connected, 0);
});

test('completed product snapshot retry normalizes anchors and returns original capture without regeneration', async (t) => {
  const f = fixture(t, [step(/^SELECT \* FROM export_snapshots WHERE idempotency_key/, [legacy], (p) => assert.deepEqual(p, ['original-key'])),
    step(/^SELECT 1 FROM magento_export_artifacts/, [{}], (p) => assert.deepEqual(p, ['stored']))]);
  assert.strictEqual(await service.createExportSnapshot({ ...input, fromSku: ' ag-000001 ', toSku: '' }, f.options), legacy);
  assert.equal(f.connected, 0);
});

test('completed template retry needs current export authority but no token, activation lookup or recompilation', async (t) => {
  const intent = binding.normalizeIntent({ requestContract: 'template-v1', mode: 'new' });
  const stored = { id: 'template-stored', request_contract: 'template-v1', request_intent: intent, created_by_user_id: 2, csv_content: 'immutable template bytes' };
  const f = fixture(t, [step(/SELECT u.status/, [{ status: 'active', has_permission: true }], (p) => assert.deepEqual(p, [7, 'exports.create'])),
    step(/^SELECT \* FROM export_snapshots WHERE idempotency_key/, [stored])]);
  assert.strictEqual(await service.createExportSnapshot({ ...intent, idempotencyKey: 'original' }, f.options), stored);
  assert.equal(f.connected, 0);
});

test('template retry rejects revoked current authority and untrusted proof before reading a stored result', async (t) => {
  const f = fixture(t, [step(/SELECT u.status/, [{ status: 'disabled', has_permission: true }]),
    step(/SELECT u.status/, [{ status: 'active', has_permission: true }])]);
  const intent = { requestContract: 'template-v1', mode: 'new', idempotencyKey: 'original' };
  await assert.rejects(service.createExportSnapshot(intent, f.options), { code: 'ADMIN_PERMISSION_REVOKED' });
  await assert.rejects(service.createExportSnapshot({ ...intent, previewToken: 'untrusted' }, f.options), { code: 'EXPORT_PREVIEW_INVALID' });
  assert.equal(f.connected, 0);
});

for (const variant of ['range', 'profile', 'contract', 'session-attempt']) {
  test(`completed product retry rejects changed ${variant} instead of reusing unrelated evidence`, async (t) => {
    const stored = { ...legacy, ...(variant === 'contract' ? { request_contract: 'template-v1' } : {}) };
    const queries = [step(/^SELECT \* FROM export_snapshots WHERE idempotency_key/, [stored])];
    if (variant === 'profile') queries.push(step(/^SELECT 1 FROM magento_export_artifacts/, []));
    const f = fixture(t, queries);
    const options = { ...f.options, ...(variant === 'session-attempt' ? { sessionAttempt: { sessionId: 'session', attemptId: 'attempt' } } : {}) };
    await assert.rejects(service.createExportSnapshot({ ...input, ...(variant === 'range' ? { fromSku: 'AG-000002' } : {}) }, options), { statusCode: 409 });
    assert.equal(f.connected, 0);
  });
}

test('a server-owned session preparation key cannot become a direct capture entrance', async (t) => {
  const f = fixture(t, [step(/^SELECT \* FROM export_snapshots WHERE idempotency_key/), step(/^SELECT 1 FROM export_session_attempts/, [{}])]);
  await assert.rejects(service.createExportSnapshot(input, f.options), { statusCode: 404, code: 'EXPORT_NOT_FOUND' });
  assert.equal(f.connected, 0);
});

for (const phase of ['legacy', 'active']) {
  test(`product capture refuses ${phase === 'legacy' ? 'retired CSV delivery' : 'unreviewed active lifecycle selection'} and releases the transaction`, async (t) => {
    const f = fixture(t, [step(/^SELECT \* FROM export_snapshots/), step(/^SELECT 1 FROM export_session_attempts/)],
      [...begin(phase), step(/SELECT legacy_product_csv_enabled/, [{ legacy_product_csv_enabled: phase === 'active' }]), ...finish('ROLLBACK')]);
    await assert.rejects(service.createExportSnapshot(input, f.options),
      { code: phase === 'legacy' ? 'MAGENTO_PRODUCT_CSV_RETIRED' : 'EXPORT_PREVIEW_REQUIRED' });
  });
}

test('capture finds a committed idempotent result after coordination and commits without rereading products', async (t) => {
  const f = fixture(t, [step(/^SELECT \* FROM export_snapshots/), step(/^SELECT 1 FROM export_session_attempts/)],
    [...begin(), step(/SELECT legacy_product_csv_enabled/, [{ legacy_product_csv_enabled: true }]),
      step(/^SELECT pg_advisory_xact_lock/, [], (p) => assert.deepEqual(p, ['amber:export-snapshot:v1', 'original-key'])),
      step(/^SELECT \* FROM export_snapshots/, [legacy]), step(/^SELECT 1 FROM magento_export_artifacts/, [{}]), ...finish('COMMIT')]);
  assert.strictEqual(await service.createExportSnapshot(input, f.options), legacy);
});

for (const hasWinner of [false, true]) {
  test(`serialization failure ${hasWinner ? 'recovers an exact stored winner' : 'reports stale preview'} only after rollback`, async (t) => {
    const fault = Object.assign(new Error('serialization failure'), { code: '40001' });
    const tx = [...begin(), { ...step(/SELECT legacy_product_csv_enabled/), error: fault }, ...finish('ROLLBACK'),
      step(/^SELECT \* FROM export_snapshots/, hasWinner ? [legacy] : [])];
    if (hasWinner) tx.push(step(/^SELECT 1 FROM magento_export_artifacts/, [{}]));
    const f = fixture(t, [step(/^SELECT \* FROM export_snapshots/), step(/^SELECT 1 FROM export_session_attempts/)], tx);
    const call = service.createExportSnapshot(input, f.options);
    if (hasWinner) assert.strictEqual(await call, legacy);
    else await assert.rejects(call, { code: 'EXPORT_PREVIEW_STALE', statusCode: 409 });
  });
}

test('private snapshot and its artifacts remain inaccessible after membership revocation', async (t) => {
  const id = '11111111-1111-4111-8111-111111111111';
  const f = fixture(t, [step(/^SELECT id, status/, [{ ...legacy, export_session_id: id }]),
    step(/SELECT u.status/, [{ status: 'active', has_permission: true }], (p) => assert.deepEqual(p, [7, 'exports.view'])),
    step(/FROM export_sessions s/, [{ owner_user_id: 2, membership_state: 'revoked', membership_epoch: '9' }], (p) => assert.deepEqual(p, [id, 7]))]);
  await assert.rejects(service.getMagentoArtifacts('stored', f.options), { statusCode: 404, code: 'EXPORT_NOT_FOUND' });
});

test('authorized private snapshot metadata retains current epoch without fetching stored CSV', async (t) => {
  const id = '11111111-1111-4111-8111-111111111111';
  const f = fixture(t, [step(/^SELECT id, status/, [{ id: 'stored', export_session_id: id }], (_p, sql) => assert.doesNotMatch(sql, /csv_content/)),
    step(/SELECT u.status/, [{ status: 'active', has_permission: true }]),
    step(/FROM export_sessions s/, [{ owner_user_id: 2, membership_state: 'accepted', membership_epoch: '9' }]),
    step(/FROM export_snapshot_products m/, [{ product_id: 4, status: 'archived' }])]);
  const snapshot = await service.getExportSnapshot('stored', { ...f.options, includeRows: false });
  assert.equal(snapshot.session_access_epoch, '9');
  assert.deepEqual(snapshot.full_product_warnings, [{ product_id: 4, status: 'archived' }]);
  assert.equal(Object.hasOwn(snapshot, 'csv_content'), false);
});

test('artifact group validation never permits arbitrary identifiers after authorized snapshot lookup', async (t) => {
  const f = fixture(t, [step(/^SELECT id, status/, [{ id: 'stored' }]), step(/FROM export_snapshot_products m/)]);
  await assert.rejects(service.getMagentoArtifact('stored', "BR'; DROP TABLE products;--", f.options), { statusCode: 404 });
});

test('missing product snapshot confirmation rolls back before any acknowledgement', async (t) => {
  const f = fixture(t, [step(/^SELECT export_session_id FROM export_snapshots/)],
    [...begin('legacy', 'BEGIN'), step(/^SELECT \* FROM export_snapshots WHERE id = \$1 FOR UPDATE/), ...finish('ROLLBACK')]);
  await assert.rejects(service.confirmExportSnapshot('missing', f.options), { statusCode: 404, code: 'EXPORT_NOT_FOUND' });
});

test('repeat historical confirmation preserves first confirmer and monotonic cursor', async (t) => {
  const f = fixture(t, [step(/^SELECT export_session_id FROM export_snapshots/, [{}])],
    [...begin('legacy', 'BEGIN'), step(/^SELECT \* FROM export_snapshots/, [{ id: 'stored', status: 'confirmed', exported_to_product_id: 8 }]),
      step(/INSERT INTO export_state/, [], (p, sql) => {
        assert.deepEqual(p, [8, 'stored']); assert.match(sql, /GREATEST/);
        assert.match(sql, /WHEN EXCLUDED.exported_to_product_id >= export_state.exported_to_product_id/);
      }), ...finish('COMMIT')]);
  assert.deepEqual(await service.confirmExportSnapshot('stored', f.options), { success: true, snapshotId: 'stored', status: 'confirmed' });
});

test('product confirmation audit failure rolls back before moving the export cursor', async (t) => {
  const fault = new Error('audit insertion failed');
  const f = fixture(t, [step(/^SELECT export_session_id FROM export_snapshots/, [{}])],
    [...begin('legacy', 'BEGIN'), step(/^SELECT \* FROM export_snapshots/, [{ id: 'stored', status: 'generated', exported_to_product_id: 8 }]),
      step(/UPDATE export_snapshots/, [], (p) => assert.deepEqual(p, ['stored', 7])),
      step(/SELECT display_name, preferred_username/, [{ display_name: 'Operator' }]),
      { ...step(/INSERT INTO audit_events/), error: fault }, ...finish('ROLLBACK')]);
  await assert.rejects(service.confirmExportSnapshot('stored', f.options), (error) => error === fault);
});
