const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, runAudit, main } = require('../scripts/magento-first-sync-optional-audit');

const id = number => `aaaaaaaa-aaaa-aaaa-aaaa-${String(number).padStart(12, '0')}`;
const originHash = 'a'.repeat(64);
const savedSession = number => ({ id: id(number), origin_hash: originHash,
  public_product_identity_id: String(number), public_sku: `SV-AUDIT-${number}`,
  remote_product_id: String(1000 + number), initial_product_id: number,
  initial_binding_revision_id: id(900), revision: '2', completed_at: null });
const field = { target: 'kamin_obrobka', scope: 'all', state: 'optional_empty', source: { kind: 'semantic' } };

function fixture(numbers = [1], { failSelect = false } = {}) {
  const calls = [], sessions = numbers.map(savedSession);
  let released = 0, connected = 0, ended = 0;
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      // A write or lock added to any default ledger/CLI read fails this fixture.
      assert.match(sql, /^(?:BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL |SELECT |COMMIT$|ROLLBACK$)/);
      assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|FOR\s+(?:UPDATE|SHARE)|pg_advisory)\b/i);
      if (sql.startsWith('SELECT s.id')) {
        if (failSelect) throw new Error('connect postgresql://operator:secret@private.invalid/amber');
        const [after, exact, limit] = parameters;
        return { rows: sessions.filter(session => (!after || session.id > after) && (!exact || session.id === exact)).slice(0, limit) };
      }
      if (sql.startsWith('SELECT * FROM magento_first_sync_sessions')) {
        return { rows: sessions.filter(session => session.origin_hash === parameters[0]
          && session.public_product_identity_id === parameters[1]) };
      }
      if (sql.startsWith('SELECT DISTINCT ON')) {
        assert.deepEqual(parameters, [sessions.find(session => session.id === parameters[0]).id, '2']);
        return { rows: [{ evidence: field, revision: '1', recorded_at: '2026-01-01T00:00:00.000Z' }] };
      }
      return { rows: [] };
    },
    release() { released++; },
  };
  const pool = { async connect() { connected++; return client; }, async end() { ended++; } };
  return { client, pool, calls, counts: () => ({ released, connected, ended }) };
}

const assessment = (blockers = []) => ({ blockers,
  evidence: [{ target: 'kamin_obrobka', scope: 'all', required: true }], evidenceHash: 'b'.repeat(64) });

test('optional receipt audit parser bounds scope and rejects ambiguous or repeated arguments', () => {
  assert.deepEqual(parseArgs([]), { limit: 100, afterSession: null, session: null });
  assert.deepEqual(parseArgs(['--limit', '500', '--after-session', id(1).toUpperCase()]),
    { limit: 500, afterSession: id(1), session: null });
  assert.deepEqual(parseArgs(['--session', id(2), '--limit', '1']), { limit: 1, afterSession: null, session: id(2) });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  for (const args of [
    ['--limit', '0'], ['--limit', '501'], ['--limit', '-1'], ['--limit', '1.5'], ['--limit', '01'],
    ['--limit', '1e2'], ['--limit'], ['--limit', '2', '--limit', '3'], ['--session'],
    ['--session', 'not-a-uuid'], ['--session', id(1), '--after-session', id(2)],
    ['--session', id(1), '--session', id(1)], ['--apply'], ['--help', '--limit', '1'],
  ]) assert.throws(() => parseArgs(args), { code: 'FIRST_SYNC_OPTIONAL_AUDIT_ARGUMENTS_INVALID' }, JSON.stringify(args));
});

test('optional receipt audit uses only saved ledger evidence in one bounded read-only snapshot', async () => {
  const f = fixture();
  const blockers = [{ code: 'FIRST_SYNC_OPTIONAL_EMPTY_RECEIPT_REVIEW_REQUIRED', target: 'kamin_obrobka', scope: 'all' }];
  let assessed = 0;
  const report = await runAudit(f.pool, {}, { assess: async (client, progress) => {
    assert.equal(client, f.client);
    assert.equal(progress.session.id, id(1));
    assert.deepEqual(progress.fields, [{ ...field, revision: '1', recordedAt: '2026-01-01T00:00:00.000Z' }]);
    assessed++;
    return assessment(blockers);
  } });
  assert.equal(assessed, 1);
  assert.equal(report.readOnly, true);
  assert.equal(report.sessionCount, 1);
  assert.equal(report.blockedSessionCount, 1);
  assert.equal(report.truncated, false);
  assert.equal(report.scopeComplete, true);
  assert.equal(report.nextAfterSession, null);
  assert.deepEqual(report.sessions[0], { sessionId: id(1), originHash, publicIdentityId: '1',
    publicSku: 'SV-AUDIT-1', remoteProductId: '1001', initialProductId: 1,
    initialBindingRevisionId: id(900), revision: '2', completedAt: null, ...assessment(blockers) });
  assert.equal(f.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(f.calls.slice(1, 4).map(call => call.sql), ["SET LOCAL statement_timeout = '10000ms'",
    "SET LOCAL lock_timeout = '2000ms'", "SET LOCAL idle_in_transaction_session_timeout = '15000ms'"]);
  const selection = f.calls[4];
  assert.deepEqual(selection.parameters, [null, null, 101]);
  assert.match(selection.sql, /SELECT DISTINCT ON \(f.target,f.scope\) f.state/);
  assert.match(selection.sql, /f.revision<=s.revision/);
  assert.match(selection.sql, /ORDER BY f.target,f.scope,f.revision DESC/);
  assert.match(selection.sql, /latest.state='optional_empty'/);
  assert.match(selection.sql, /ORDER BY s.id LIMIT \$3/);
  assert.equal(f.calls.at(-1).sql, 'COMMIT');
  assert.deepEqual(f.counts(), { released: 1, connected: 1, ended: 0 });
  assert.doesNotMatch(f.calls.map(call => call.sql).join('\n'), /\b(?:products|magento_binding_revisions)\b/);
});

test('optional receipt audit paginates by session and never assesses the lookahead row', async () => {
  const f = fixture([1, 2, 3]);
  const assessed = [];
  const dependencies = { assess: async (_client, progress) => { assessed.push(progress.session.id); return assessment(); } };
  const first = await runAudit(f.pool, { limit: 1, afterSession: id(1) }, dependencies);
  assert.deepEqual(assessed, [id(2)]);
  assert.equal(first.truncated, true);
  assert.equal(first.scopeComplete, false);
  assert.equal(first.nextAfterSession, id(2));
  const second = await runAudit(f.pool, { limit: 1, afterSession: first.nextAfterSession }, dependencies);
  assert.deepEqual(assessed, [id(2), id(3)]);
  assert.equal(second.truncated, false);
  assert.equal(second.scopeComplete, true);
  assert.equal(second.nextAfterSession, null);
  assert.deepEqual(f.calls.filter(call => call.sql.startsWith('SELECT s.id')).map(call => call.parameters),
    [[id(1), null, 2], [id(2), null, 2]]);
});

test('optional receipt audit exact session filter and empty result do not broaden scope', async () => {
  const f = fixture([1, 2]);
  const assessed = [];
  const dependencies = { assess: async (_client, progress) => { assessed.push(progress.session.id); return assessment(); } };
  const exact = await runAudit(f.pool, { session: id(2) }, dependencies);
  assert.deepEqual(exact.sessions.map(session => session.sessionId), [id(2)]);
  const absent = await runAudit(f.pool, { session: id(3) }, dependencies);
  assert.equal(absent.sessionCount, 0);
  assert.equal(absent.blockedSessionCount, 0);
  assert.equal(absent.truncated, false);
  assert.equal(absent.scopeComplete, true);
  assert.deepEqual(assessed, [id(2)]);
  assert.deepEqual(f.calls.filter(call => call.sql.startsWith('SELECT s.id')).map(call => call.parameters),
    [[null, id(2), 101], [null, id(3), 101]]);
});

test('optional receipt audit rolls back and releases on assessment failure or inconsistent session', async () => {
  for (const mismatch of [false, true]) {
    const f = fixture();
    const expected = mismatch ? 'FIRST_SYNC_OPTIONAL_AUDIT_SESSION_MISMATCH' : 'ASSESSMENT_FAILED';
    await assert.rejects(runAudit(f.pool, {}, {
      ...(mismatch ? { readProgress: async () => ({ session: savedSession(2), fields: [] }) } : {}),
      assess: async () => { throw Object.assign(new Error('hidden details'), { code: 'ASSESSMENT_FAILED' }); },
    }), { code: expected });
    assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
    assert.equal(f.calls.some(call => call.sql === 'COMMIT'), false);
    assert.equal(f.counts().released, 1);
  }
});

test('optional receipt audit bounds elapsed work and validates direct callers before connecting', async () => {
  const f = fixture();
  await assert.rejects(runAudit(f.pool, { limit: 1000 }, { assess: assert.fail }),
    { code: 'FIRST_SYNC_OPTIONAL_AUDIT_ARGUMENTS_INVALID' });
  assert.equal(f.counts().connected, 0);
  let clock = 0;
  await assert.rejects(runAudit(f.pool, {}, { assess: assert.fail, now: () => (clock++ === 0 ? 0 : 60000) }),
    { code: 'FIRST_SYNC_OPTIONAL_AUDIT_TIME_LIMIT' });
  assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(f.counts().released, 1);
});

test('optional receipt CLI help and argument errors never create a connection', async () => {
  const printed = [], errors = [];
  const dependencies = { env: {}, print: text => printed.push(text), printError: text => errors.push(JSON.parse(text)),
    createPool: assert.fail };
  assert.equal(await main(['--help'], dependencies), 0);
  assert.match(printed[0], /No repair or Magento requests/);
  assert.equal(await main(['--apply'], dependencies), 1);
  assert.equal(await main([], dependencies), 1);
  assert.deepEqual(errors, [{ code: 'FIRST_SYNC_OPTIONAL_AUDIT_ARGUMENTS_INVALID' }, { code: 'DATABASE_URL_REQUIRED' }]);
});

test('optional receipt CLI returns review status and leaves caller-owned pools open', async () => {
  const f = fixture(), printed = [];
  const code = await main(['--session', id(1)], { pool: f.pool, print: text => printed.push(JSON.parse(text)),
    printError: assert.fail, assess: async () => assessment([{ code: 'FIRST_SYNC_OPTIONAL_EMPTY_RECEIPT_REVIEW_REQUIRED' }]) });
  assert.equal(code, 2);
  assert.equal(printed[0].blockedSessionCount, 1);
  assert.deepEqual(f.counts(), { released: 1, connected: 1, ended: 0 });
});

test('optional receipt CLI distinguishes truncated results and gives review blockers precedence', async () => {
  for (const blocked of [false, true]) {
    const f = fixture([1, 2]), printed = [];
    const code = await main(['--limit', '1'], { pool: f.pool, print: text => printed.push(JSON.parse(text)),
      printError: assert.fail, assess: async () => assessment(blocked
        ? [{ code: 'FIRST_SYNC_OPTIONAL_EMPTY_RECEIPT_REVIEW_REQUIRED' }] : []) });
    assert.equal(code, blocked ? 2 : 3);
    assert.equal(printed[0].truncated, true);
    assert.equal(printed[0].scopeComplete, false);
    assert.equal(printed[0].nextAfterSession, id(1));
    assert.equal(printed[0].blockedSessionCount, blocked ? 1 : 0);
  }
});

test('optional receipt CLI owns one bounded pool, closes it and hides database errors', async () => {
  const connectionString = 'postgresql://operator:secret@private.invalid/amber';
  for (const failSelect of [false, true]) {
    const f = fixture([], { failSelect }), errors = [];
    const code = await main([], { env: { DATABASE_URL: connectionString }, print() {},
      printError: text => errors.push(text), assess: assert.fail,
      createPool: options => {
        assert.deepEqual(options, { connectionString, max: 1, connectionTimeoutMillis: 5000,
          query_timeout: 12000, statement_timeout: 10000, options: '-c default_transaction_read_only=on' });
        return f.pool;
      } });
    assert.equal(code, failSelect ? 1 : 0);
    assert.equal(f.calls.at(-1).sql, failSelect ? 'ROLLBACK' : 'COMMIT');
    assert.deepEqual(f.counts(), { released: 1, connected: 1, ended: 1 });
    assert.deepEqual(errors, failSelect ? [JSON.stringify({ code: 'FIRST_SYNC_OPTIONAL_AUDIT_FAILED' })] : []);
    assert.doesNotMatch(errors.join(''), /operator|secret|private\.invalid|postgresql/);
  }
});
