const test = require('node:test');
const assert = require('node:assert/strict');
const { Socket } = require('node:net');
const pool = require('../src/db/pool');
const service = require('../src/services/export-sessions.service');
const exportsService = require('../src/services/export.service');
const binding = require('../src/services/export-templates/snapshot-binding');

const id = '11111111-1111-4111-8111-111111111111';
const attemptId = '22222222-2222-4222-8222-222222222222';
const context = { actorUserId: 7, requestId: 'session-unit' };
const settings = binding.normalizeIntent({ requestContract: 'template-v1', mode: 'new', selection: { mode: 'active' } });
const session = { id, title: 'Reviewed export', owner_user_id: 7, configuration_revision: '3', settings,
  current_attempt_id: null, snapshot_id: null };
const command = { expectedRevision: '3', expectedAccessEpoch: 'owner' };
const step = (sql, rows = [], check) => ({ sql, rows, check });
const permission = (allowed = true, capability = 'exports.view') => step(/SELECT u.status/, [{ status: 'active', has_permission: allowed }],
  (p) => assert.deepEqual(p, [7, capability]));
const authority = (write = true) => [step(/^SELECT pg_advisory_lock_shared/, [], (p) => assert.deepEqual(p, ['amber_application_user_admin_active_administrators'])),
  permission(), ...(write ? [permission(true, 'exports.create')] : [])];
const releaseAuthority = () => step(/^SELECT pg_advisory_unlock_shared/, [], (p) => assert.deepEqual(p, ['amber_application_user_admin_active_administrators']));
const begin = () => [step(/^SELECT pg_advisory_lock_shared/, [], (p) => assert.deepEqual(p, ['amber_full_product_cutover'])),
  step('BEGIN'), step("SET LOCAL amber.lifecycle_writer_version = '1'"), step(/^SELECT to_regclass/, [{ present: false }])];
const finish = (command) => [step(command), step(/^SELECT pg_advisory_unlock_shared/, [], (p) => assert.deepEqual(p, ['amber_full_product_cutover']))];
const sessionTrace = (row, inside = [], write = true) => [...authority(write),
  step(/^SELECT pg_advisory_lock\(/, [], (p) => assert.deepEqual(p, ['amber:export-session:v1', id])),
  step(/FROM export_sessions s/, row ? [row] : [], (p) => assert.deepEqual(p, [id, 7])), ...inside,
  step(/^SELECT pg_advisory_unlock\(/), releaseAuthority()];
const audit = (event, failure) => [step(/SELECT display_name, preferred_username/, [{ display_name: 'Operator' }]),
  { ...step(/INSERT INTO audit_events/, [{ id: 'event' }], (p) => {
    assert.equal(p[0], `export_session.${event}`); assert.equal(p[1], 7); assert.equal(p[4], id);
    assert.doesNotMatch(p[6], /opaque-proof|original-key/);
  }), ...(failure ? { error: failure } : {}) }];

function fixture(t, queries = [], transaction = []) {
  let connected = 0; let released = 0;
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
  for (const method of ['previewExport', 'createExportSnapshot', 'getExportSnapshot']) {
    t.mock.method(exportsService, method, async () => { throw new Error(`Unexpected capture operation: ${method}`); });
  }
  t.after(() => { assert.equal(queries.length, 0); assert.equal(transaction.length, 0); assert.equal(released, connected); });
  return { client, options: { databasePool, mutationContext: context }, get connected() { return connected; } };
}

test('session creation validates title, template intent and creation key without opening a connection', async (t) => {
  const f = fixture(t);
  const valid = { title: session.title, settings, creationKey: 'new-session' };
  for (const [change, code] of [[{ title: ' ' }, 'EXPORT_TITLE_INVALID'], [{ title: 'x'.repeat(161) }, 'EXPORT_TITLE_INVALID'],
    [{ title: 'bad\0title' }, 'EXPORT_TITLE_INVALID'], [{ settings: {} }, 'EXPORT_CONTRACT_INVALID'],
    [{ settings: { requestContract: 'template-v1', mode: 'manual' } }, 'EXPORT_SETTINGS_INVALID'],
    [{ creationKey: '' }, 'EXPORT_CREATION_KEY_REQUIRED'], [{ creationKey: 'x'.repeat(201) }, 'EXPORT_CREATION_KEY_REQUIRED']]) {
    await assert.rejects(service.createSession({ ...valid, ...change }, f.options), { code });
  }
  await assert.rejects(service.invite(id, { userId: '../7' }, f.options), { code: 'EXPORT_RECIPIENT_INVALID' });
  await assert.rejects(service.membership(id, { action: 'become-owner' }, f.options), { code: 'EXPORT_MEMBERSHIP_ACTION_INVALID' });
  assert.equal(f.connected, 0);
});

for (const changed of [false, true]) {
  test(`session creation retry ${changed ? 'rejects changed original intent' : 'returns original owner and configuration without writes'}`, async (t) => {
    const original = { title: session.title, settings };
    const f = fixture(t, [], [...authority(), ...begin(), step(/^SELECT pg_advisory_xact_lock/),
      step(/^SELECT \* FROM export_sessions WHERE owner_user_id/, [{ ...session, creation_intent: original }]),
      ...finish(changed ? 'ROLLBACK' : 'COMMIT'), releaseAuthority()]);
    const call = service.createSession({ ...original, title: changed ? 'Another intent' : ` ${session.title} `, creationKey: 'original-key' }, f.options);
    if (changed) await assert.rejects(call, { code: 'EXPORT_SESSION_CONFLICT' });
    else { const saved = await call; assert.equal(saved.id, id); assert.equal(saved.configurationRevision, '3'); assert.equal(saved.accessEpoch, 'owner'); }
  });
}

test('session creation audit failure rolls back metadata before releasing authority', async (t) => {
  const fault = new Error('audit failed');
  const f = fixture(t, [], [...authority(), ...begin(), step(/^SELECT pg_advisory_xact_lock/),
    step(/^SELECT \* FROM export_sessions WHERE owner_user_id/), step(/INSERT INTO export_sessions/, [session]),
    ...audit('created', fault), ...finish('ROLLBACK'), releaseAuthority()]);
  await assert.rejects(service.createSession({ title: session.title, settings, creationKey: 'new-session' }, f.options), (error) => error === fault);
});

test('revoked create permission fails before the session or lifecycle lock is acquired', async (t) => {
  const f = fixture(t, [], [...authority(false), permission(false, 'exports.create'), releaseAuthority()]);
  await assert.rejects(service.createSession({ title: session.title, settings, creationKey: 'new-session' }, f.options), { code: 'ADMIN_PERMISSION_REVOKED', statusCode: 403 });
});

test('pending invitation lists expose only minimal relationship metadata and page by returned rows', async (t) => {
  const row = { ...session, epoch: '8', owner_user_id: 2, owner_username: 'owner', preview_proof: 'opaque-proof', idempotency_key: 'original-key' };
  const f = fixture(t, [permission(), step(/FROM export_sessions s/, [row, { ...row, id: attemptId }], (p, sql) => {
    assert.deepEqual(p, [7, 'invitations', '', 2]); assert.match(sql, /m.state='pending'/);
  })]);
  assert.deepEqual(await service.listSessions({ scope: 'invitations', limit: 1 }, f.options), {
    items: [{ id, title: session.title, ownerUserId: 2, ownerName: 'owner', accessEpoch: '8', state: 'pending' }], next: id,
  });
});

for (const input of [{ scope: 'all-users' }, { order: 'activity' }, { limit: 0 }, { limit: 51 }, { after: 'untrusted' }]) {
  test(`session list rejects unsupported selection ${JSON.stringify(input)} after current access recheck`, async (t) => {
    const f = fixture(t, [permission()]);
    await assert.rejects(service.listSessions(input, f.options), { code: input.scope ? 'EXPORT_SCOPE_INVALID' : 'EXPORT_PAGE_INVALID' });
  });
}

test('revoked membership blocks preview without invoking the export engine', async (t) => {
  const f = fixture(t, [], sessionTrace({ ...session, owner_user_id: 2, membership_state: 'revoked', membership_epoch: '9' }, [], false));
  await assert.rejects(service.previewSession(id, f.options), { code: 'EXPORT_NOT_FOUND', statusCode: 404 });
});

for (const state of ['stale-revision', 'frozen', 'no-op']) {
  test(`session save ${state} preserves existing operation identity`, async (t) => {
    const row = { ...session, ...(state === 'frozen' ? { snapshot_id: 'stored' } : {}) };
    const f = fixture(t, [], sessionTrace(row, [...begin(), ...finish(state === 'no-op' ? 'COMMIT' : 'ROLLBACK')]));
    const call = service.saveSession(id, { ...command, expectedRevision: state === 'stale-revision' ? '2' : '3', title: session.title, settings }, f.options);
    if (state === 'no-op') assert.equal((await call).configurationRevision, '3');
    else await assert.rejects(call, { code: state === 'frozen' ? 'EXPORT_SESSION_FROZEN' : 'EXPORT_SESSION_CONFLICT' });
  });
}

test('session save rejects a stale membership epoch before transaction or superseding work', async (t) => {
  const f = fixture(t, [], sessionTrace({ ...session, owner_user_id: 2, membership_state: 'accepted', membership_epoch: '9' }));
  await assert.rejects(service.saveSession(id, { ...command, expectedAccessEpoch: '8', title: 'changed', settings }, f.options), { code: 'EXPORT_MEMBERSHIP_CHANGED' });
});

test('session save audit failure rolls back both superseding and configuration changes', async (t) => {
  const fault = new Error('audit failed');
  const f = fixture(t, [], sessionTrace({ ...session, current_attempt_id: attemptId }, [...begin(),
    step(/UPDATE export_session_attempts SET state='superseded'/, [], (p) => assert.deepEqual(p, [attemptId])),
    step(/UPDATE export_sessions SET title/, [{ ...session, title: 'Changed', configuration_revision: '4' }]),
    ...audit('updated', fault), ...finish('ROLLBACK')]));
  await assert.rejects(service.saveSession(id, { ...command, title: 'Changed', settings }, f.options), (error) => error === fault);
});

test('existing preparation returns its safe summary without a new preview or replacement proof', async (t) => {
  const attempt = { id: attemptId, state: 'prepared', configuration_revision: '3', preview_proof: 'opaque-proof',
    idempotency_key: 'original-key', binding_evidence: { original: true }, preview_summary: { representedCount: 2 } };
  const f = fixture(t, [], sessionTrace({ ...session, current_attempt_id: attemptId }, [step(/^SELECT \* FROM export_session_attempts/, [attempt])]));
  const prepared = await service.prepare(id, { ...command, expectedPreviewFingerprint: binding.fingerprint(attempt.binding_evidence) }, f.options);
  assert.equal(prepared.id, attemptId); assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.preparationIssue, 'unavailable');
  assert.deepEqual(prepared.preview, { representedCount: 2 });
  assert.doesNotMatch(JSON.stringify(prepared), /opaque-proof|original-key/);
});

test('preparation rejects a changed displayed fingerprint without superseding the existing attempt', async (t) => {
  const f = fixture(t, [], sessionTrace({ ...session, current_attempt_id: attemptId }, [step(/^SELECT \* FROM export_session_attempts/, [{ binding_evidence: { original: true } }])]));
  await assert.rejects(service.prepare(id, { ...command, expectedPreviewFingerprint: 'different' }, f.options), { code: 'EXPORT_PREVIEW_STALE' });
});

test('not-ready session preview cannot prepare an attempt or expose a proof', async (t) => {
  const f = fixture(t, [], sessionTrace(session));
  t.mock.method(exportsService, 'previewExport', async (intent, options) => {
    assert.deepEqual(intent, settings); assert.equal(options.mutationContext.actorUserId, 7);
    return { previewToken: null, errors: [{ code: 'MAGENTO_NOT_READY' }], representedCount: 1 };
  });
  const prepared = await service.prepare(id, command, f.options);
  assert.equal(prepared.state, 'not-ready');
  assert.deepEqual(prepared.preview.errors, [{ code: 'MAGENTO_NOT_READY' }]);
  assert.equal(JSON.stringify(prepared).includes('previewToken'), false);
});

test('ready session preparation stores exact proof with bounded metadata and omits it from the response', async (t) => {
  const evidence = { intent: settings, effective: { templateId: id, versionId: attemptId,
    evaluatorVersion: 'magento-declarative-3', definitionHash: 'a'.repeat(64), outputContract: 'magento-products-v1', formatVersion: 1, activationGeneration: '1' },
  inputFingerprint: 'b'.repeat(64), range: { fromSku: 'AG-000001', toSku: 'AG-000001', resolvedToSku: 'AG-000001', exportedToProductId: 4 }, cursor: '0' };
  const proof = binding.makeSigner(require('../src/config/env').sessionSecret).sign(evidence);
  const artifact = { groupCode: 'BR', groupName: 'Bracelets', profileVersion: 'magento-products-v1', fileName: 'review.csv', productCount: 1, rowCount: 2, csvContent: 'private preview bytes' };
  const preview = { previewToken: proof, mode: 'new', range: evidence.range, representedCount: 1, readyCount: 1,
    artifacts: [artifact], template: evidence.effective, tableFingerprint: 'reviewed-table', rows: [{ private: true }] };
  const storedAttempt = { id: attemptId, state: 'prepared', configuration_revision: '3', preview_proof: proof };
  const f = fixture(t, [], sessionTrace(session, [step(/SELECT t.display_name, v.version_number/, [{ display_name: 'Published', version_number: '4' }]),
    ...begin(), step(/INSERT INTO export_session_attempts/, [storedAttempt], (p) => {
      assert.equal(p[1], id); assert.equal(p[2], '3'); assert.equal(p[3], 7);
      assert.deepEqual(JSON.parse(p[4]), settings); assert.deepEqual(JSON.parse(p[5]), evidence); assert.equal(p[6], proof);
      const safe = JSON.parse(p[7]); assert.equal(safe.template.displayName, 'Published');
      assert.equal(safe.template.versionNumber, '4'); assert.equal(safe.artifacts[0].csvContent, undefined);
      assert.equal(safe.rows, undefined); assert.equal(safe.previewToken, undefined);
    }), step(/^UPDATE export_sessions SET current_attempt_id/, [], (p) => assert.deepEqual(p, [id, attemptId])),
    ...audit('prepared'), ...finish('COMMIT')]));
  t.mock.method(exportsService, 'previewExport', async () => preview);
  const prepared = await service.prepare(id, { ...command, expectedPreviewFingerprint: 'reviewed-table' }, f.options);
  assert.equal(prepared.id, attemptId); assert.equal(prepared.preparationIssue, null);
  assert.equal(prepared.preview.configurationRevision, '3'); assert.equal(JSON.stringify(prepared).includes(proof), false);
});

test('generation rejects a stale attempt before execution metadata or capture', async (t) => {
  const f = fixture(t, [], sessionTrace({ ...session, current_attempt_id: attemptId }));
  await assert.rejects(service.generate(id, { ...command, attemptId: id }, f.options), { code: 'EXPORT_ATTEMPT_CHANGED' });
});

test('completed session generation reads the original snapshot without checking proof freshness or recapturing', async (t) => {
  const f = fixture(t, [], sessionTrace({ ...session, current_attempt_id: attemptId, snapshot_id: 'stored' },
    [step(/^SELECT \* FROM export_session_attempts/, [{ id: attemptId, state: 'succeeded', preview_proof: 'expired' }])]));
  t.mock.method(exportsService, 'getExportSnapshot', async (snapshotId) => { assert.equal(snapshotId, 'stored'); return { id: snapshotId, csv_content: 'original bytes' }; });
  assert.deepEqual(await service.generate(id, { ...command, attemptId }, f.options), { id: 'stored', csv_content: 'original bytes' });
});

test('session result linking uses the capture-supplied transaction without an independent commit', async (t) => {
  const attempt = { id: attemptId, state: 'executing', request_intent: settings, preview_proof: 'opaque-proof', idempotency_key: 'original-key' };
  const f = fixture(t, [], sessionTrace({ ...session, current_attempt_id: attemptId }, [
    step(/^SELECT \* FROM export_session_attempts/, [attempt]), ...begin(), step(/UPDATE export_session_attempts SET state='executing'/), ...finish('COMMIT'),
    step(/UPDATE export_session_attempts SET state='succeeded'/, [], (p) => assert.deepEqual(p, [attemptId, 'stored'])),
    step(/^UPDATE export_sessions SET snapshot_id/, [], (p) => assert.deepEqual(p, [id, 'stored'])), ...audit('generated'),
  ]));
  let linkQueries = 0;
  t.mock.method(exportsService, 'createExportSnapshot', async (_input, options) => {
    const captureTransaction = { async query(sql, params) { linkQueries++; return f.client.query(sql, params); } };
    await options.linkSessionResult(captureTransaction, { id: 'stored' });
    return { id: 'stored' };
  });
  assert.deepEqual(await service.generate(id, { ...command, attemptId }, f.options), { id: 'stored' });
  assert.equal(linkQueries, 4);
});

for (const committed of [false, true]) {
  test(`uncertain generation ${committed ? 'recovers a committed result' : 'records bounded failure'} while retaining the original command`, async (t) => {
    const fault = Object.assign(new Error('capture response lost'), { code: 'CONNECTION_LOST' });
    const attempt = { id: attemptId, state: 'prepared', request_intent: settings, preview_proof: 'opaque-proof', idempotency_key: 'original-key' };
    const inside = [step(/^SELECT \* FROM export_session_attempts/, [attempt]), ...begin(),
      step(/UPDATE export_session_attempts SET state='executing'/), ...audit('started'), ...finish('COMMIT'),
      step(/^SELECT snapshot_id FROM export_sessions/, [{ snapshot_id: committed ? 'stored' : null }])];
    if (!committed) inside.push(...begin(), step(/UPDATE export_session_attempts SET state='failed'/, [], (p) => assert.deepEqual(p, [attemptId, 'CONNECTION_LOST'])), ...finish('COMMIT'));
    const f = fixture(t, [], sessionTrace({ ...session, current_attempt_id: attemptId }, inside));
    let captures = 0;
    t.mock.method(exportsService, 'createExportSnapshot', async (input, options) => {
      captures++; assert.deepEqual(input, { ...settings, previewToken: 'opaque-proof', idempotencyKey: 'original-key' });
      assert.deepEqual(options.sessionAttempt, { sessionId: id, attemptId }); throw fault;
    });
    t.mock.method(exportsService, 'getExportSnapshot', async (snapshotId) => { assert.equal(snapshotId, 'stored'); return { id: snapshotId }; });
    const call = service.generate(id, { ...command, attemptId }, f.options);
    if (committed) assert.deepEqual(await call, { id: 'stored' });
    else await assert.rejects(call, (error) => error === fault);
    assert.equal(captures, 1);
  });
}

test('owner cannot invite themselves and repeated pending invitations emit no new event', async (t) => {
  const f = fixture(t, [], [
    ...sessionTrace(session, [...begin(), ...finish('ROLLBACK')]),
    ...sessionTrace(session, [...begin(), step(/^SELECT id FROM application_users/, [{ id: 9 }]),
      step(/^SELECT \* FROM export_session_members/, [{ state: 'pending', epoch: '4' }]), ...finish('COMMIT')]),
  ]);
  await assert.rejects(service.invite(id, { ...command, userId: 7 }, f.options), { code: 'EXPORT_RECIPIENT_INVALID' });
  assert.deepEqual(await service.invite(id, { ...command, userId: 9 }, f.options), { state: 'pending', epoch: '4' });
});

test('accepted participant cannot revoke another member by supplying the owner epoch', async (t) => {
  const f = fixture(t, [], sessionTrace({ ...session, owner_user_id: 2, membership_state: 'accepted', membership_epoch: '9' }));
  await assert.rejects(service.membership(id, { action: 'revoke', userId: 10, expectedAccessEpoch: 'owner', expectedMemberEpoch: '1' }, f.options), { code: 'EXPORT_NOT_FOUND' });
});

test('owner revocation rejects a stale target epoch without ending newer membership', async (t) => {
  const f = fixture(t, [], sessionTrace(session, [...begin(), step(/^SELECT \* FROM export_session_members/, [{ state: 'accepted', epoch: '5' }]), ...finish('ROLLBACK')]));
  await assert.rejects(service.membership(id, { action: 'revoke', userId: 10, expectedAccessEpoch: 'owner', expectedMemberEpoch: '4' }, f.options), { code: 'EXPORT_MEMBERSHIP_CHANGED' });
});

test('invited target acceptance advances its epoch and audits the same transaction without create permission', async (t) => {
  const f = fixture(t, [], sessionTrace({ ...session, owner_user_id: 2, membership_state: 'pending', membership_epoch: '4' },
    [...begin(), step(/^SELECT \* FROM export_session_members/, [{ state: 'pending', epoch: '4' }]),
      step(/UPDATE export_session_members SET state/, [{ state: 'accepted', epoch: '5' }], (p) => assert.deepEqual(p, [id, '7', 'accepted', 7])),
      ...audit('accepted'), ...finish('COMMIT')], false));
  assert.deepEqual(await service.membership(id, { action: 'accept', expectedAccessEpoch: '4' }, f.options), { state: 'accepted', epoch: '5' });
});
