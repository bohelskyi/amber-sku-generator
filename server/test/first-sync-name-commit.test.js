'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runNameCommit } = require('../scripts/first-sync-name-commit');
const access = require('../src/services/access-admin-transaction');
const publication = require('../src/services/magento/binding-publication');
const gate = require('../src/services/full-product-cutover-gate');
const problem = code => Object.assign(new Error(code), { code });

function fixture(settings = {}) {
  const events = [], releases = [], result = { sessionId: 'synthetic-session', revision: '2', localChanged: true };
  let connects = 0, borrowedPool, borrowedClient;
  const client = {
    async query(sql, values) {
      events.push({ sql, values });
      await settings.onQuery?.(sql, values);
      const failure = settings.failQuery?.(sql, values);
      if (failure) throw failure;
      if (sql === 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked')
        return { rows: [{ unlocked: settings.unlockResult ?? true }] };
      if (sql.includes("to_regclass('full_product_export_activation')")) return { rows: [{ present: true }] };
      if (sql === 'SELECT * FROM full_product_export_activation WHERE singleton=TRUE')
        return { rows: [{ phase: 'active', required_writer_version: 1 }] };
      if (sql.includes('FROM user_role_assignments')) return { rowCount: settings.admin === false ? 0 : 1, rows: [] };
      return { command: settings.commandTag?.(sql) || sql.trim().toUpperCase(), rows: [] };
    },
    release(cause) {
      releases.push(cause);
      if (settings.releaseFailure) throw settings.releaseFailure;
    },
  };
  const options = { actorUserId: 7, sensitiveValues: [], installation: 'synthetic', databasePool: {
    async connect() { connects++; if (settings.connectFailure) throw settings.connectFailure; return client; },
    async query() { throw problem('REAL_POOL_QUERY_FORBIDDEN'); },
  } };
  const config = Object.freeze({ baseUrl: 'https://magento.invalid/rest' });
  const state = Object.freeze({ publicSku: 'NM-SYNTHETIC' });
  const inspection = Object.freeze({ mode: 'first', prepared: Object.freeze({ rows: [] }) });
  const runtime = { access, publication, first: {
    async commit(receivedConfig, receivedInspection, receivedState, receivedOptions) {
      assert.equal(receivedConfig, config); assert.equal(receivedInspection, inspection); assert.equal(receivedState, state);
      assert.equal(receivedOptions.actorUserId, options.actorUserId);
      assert.equal(receivedOptions.sensitiveValues, options.sensitiveValues);
      assert.equal(Object.hasOwn(receivedOptions, 'firstSyncDecision'), false);
      borrowedPool = receivedOptions.databasePool;
      await settings.beforeConnect?.(borrowedPool);
      const tx = borrowedClient = await borrowedPool.connect();
      try {
        await settings.beforeBegin?.(borrowedPool, tx);
        await tx.query('BEGIN');
        await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [access.APPLICATION_USER_ADMIN_LOCK_KEY]);
        await gate.enterExisting(tx);
        await settings.inTransaction?.(borrowedPool, tx);
        await tx.query('SELECT synthetic_canonical_work');
        await gate.commit(tx);
        await settings.afterCommit?.(borrowedPool, tx);
        return result;
      } catch (cause) {
        await gate.rollback(tx).catch(() => {});
        throw cause;
      } finally {
        await gate.release(tx).catch(() => {});
        tx.release();
      }
    },
  } };
  return { runtime, config, state, inspection, options, events, releases, result,
    run: () => runNameCommit(runtime, config, state, inspection, options),
    get connects() { return connects; }, get borrowedPool() { return borrowedPool; }, get borrowedClient() { return borrowedClient; } };
}
const sqls = f => f.events.map(event => event.sql);
const code = (value, flags = {}) => ({ code: value, ...flags });

test('one borrowed client preserves canonical arguments, gate ownership and exact result', async () => {
  const f = fixture(), originalPool = f.options.databasePool;
  assert.equal(await f.run(), f.result);
  assert.equal(f.connects, 1); assert.equal(f.options.databasePool, originalPool);
  assert.deepEqual(f.releases, [undefined]);
  assert.deepEqual(Object.keys(f.borrowedPool).sort(), ['connect', 'query']);
  assert.deepEqual(Object.keys(f.borrowedClient).sort(), ['query', 'release']);
  assert.notEqual(f.borrowedPool, originalPool);
  const sequence = sqls(f), admin = sequence.findIndex(sql => sql.includes('FROM user_role_assignments'));
  assert.equal(sequence[0], 'SELECT pg_advisory_lock(hashtext($1))');
  assert.ok(admin > 0 && admin < sequence.indexOf('BEGIN'));
  assert.equal(sequence.filter(sql => sql === 'BEGIN').length, 1);
  assert.equal(sequence.filter(sql => sql === 'COMMIT').length, 1);
  assert.equal(sequence.filter(sql => sql === 'ROLLBACK').length, 0);
  assert.equal(sequence.filter(sql => sql === 'SELECT pg_advisory_lock_shared(hashtext($1))').length, 1);
  assert.equal(sequence.filter(sql => sql === 'SELECT pg_advisory_unlock_shared(hashtext($1))').length, 1);
  assert.equal(sequence.at(-1), 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked');
  assert.deepEqual(f.events[0].values, [access.APPLICATION_USER_ADMIN_LOCK_KEY]);
  assert.deepEqual(f.events.at(-1).values, [access.APPLICATION_USER_ADMIN_LOCK_KEY]);
});

test('borrowed pool and client cannot be reused after the canonical call', async () => {
  const f = fixture(); await f.run(); const count = f.events.length;
  await assert.rejects(f.borrowedPool.connect(), code('CAMPAIGN_NAME_COMMIT_CLIENT_CONTRACT'));
  await assert.rejects(f.borrowedPool.query('SELECT 1'), code('CAMPAIGN_NAME_COMMIT_CLIENT_CONTRACT'));
  await assert.rejects(f.borrowedClient.query('SELECT 1'), code('CAMPAIGN_NAME_COMMIT_CLIENT_CONTRACT'));
  assert.throws(() => f.borrowedClient.release(), code('CAMPAIGN_NAME_COMMIT_CLIENT_CONTRACT'));
  assert.equal(f.events.length, count); assert.equal(f.releases.length, 1);
});

test('invalid actor, mode, runtime and forbidden context fail before leasing a client', async t => {
  const mutations = {
    actor: f => { f.options.actorUserId = 0; },
    mode: f => { f.inspection = { mode: 'ordinary', prepared: {} }; },
    decision: f => { f.options.firstSyncDecision = []; },
    automatic: f => { f.options.automatic = {}; },
    recovery: f => { f.options.firstSyncRecoveryProof = {}; },
    stopping: f => { f.options.stopping = true; },
    runtime: f => { f.runtime.access = {}; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const f = fixture(); mutate(f);
    await assert.rejects(runNameCommit(f.runtime, f.config, f.state, f.inspection, f.options),
      code('CAMPAIGN_NAME_COMMIT_INPUT_INVALID', { nameCommitNotStarted: true }));
    assert.equal(f.connects, 0); assert.deepEqual(f.events, []);
  });
});

test('lease failure is known not started and needs no release', async () => {
  const f = fixture({ connectFailure: problem('CONNECT_FAILED') });
  await assert.rejects(f.run(), code('CONNECT_FAILED', { nameCommitNotStarted: true }));
  assert.deepEqual(f.releases, []); assert.deepEqual(f.events, []);
});

test('non-administrator is rejected under the pin before BEGIN and cleanly unlocked', async () => {
  const f = fixture({ admin: false });
  await assert.rejects(f.run(), code('MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED', { nameCommitNotStarted: true }));
  assert.ok(!sqls(f).includes('BEGIN')); assert.deepEqual(f.releases, [undefined]);
  assert.equal(sqls(f).at(-1), 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked');
});

test('stop before lease, after lock wait, or after administrator check prevents commit', async t => {
  for (const phase of ['initial', 'lock', 'administrator']) await t.test(phase, async () => {
    let stopped = phase === 'initial';
    const f = fixture({ onQuery: async sql => {
      if (phase === 'lock' && sql === 'SELECT pg_advisory_lock(hashtext($1))'
        || phase === 'administrator' && sql.includes('FROM user_role_assignments')) stopped = true;
    } });
    f.options.stopping = () => stopped;
    await assert.rejects(f.run(), code('CAMPAIGN_NAME_COMMIT_INTERRUPTED', { nameCommitNotStarted: true }));
    assert.ok(!sqls(f).includes('BEGIN'));
    assert.equal(f.connects, phase === 'initial' ? 0 : 1);
    assert.deepEqual(f.releases, phase === 'initial' ? [] : [undefined]);
  });
});

test('lost pin acquisition and administrator query failures destroy the connection', async t => {
  for (const phase of ['pin', 'administrator']) await t.test(phase, async () => {
    const failure = problem('QUERY_LOST');
    const f = fixture({ failQuery: sql => phase === 'pin' && sql === 'SELECT pg_advisory_lock(hashtext($1))'
      || phase === 'administrator' && sql.includes('FROM user_role_assignments') ? failure : null });
    await assert.rejects(f.run(), code('QUERY_LOST', { nameCommitNotStarted: true }));
    assert.ok(!sqls(f).includes('BEGIN')); assert.deepEqual(f.releases, [failure]);
    assert.equal(sqls(f).at(-1), 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked');
  });
});

test('domain rejection with proven rollback remains blocked, not an unknown commit', async () => {
  const failure = problem('MAGENTO_SYNC_AMBER_CHANGED');
  const f = fixture({ inTransaction: async () => { throw failure; } });
  await assert.rejects(f.run(), code(failure.code, { nameCommitRolledBack: true }));
  assert.ok(!sqls(f).includes('COMMIT')); assert.ok(sqls(f).includes('ROLLBACK'));
  assert.deepEqual(f.releases, [undefined]);
});

test('SQL failure is rolled back and destroys the connection even when rollback succeeds', async () => {
  const failure = problem('23514'), f = fixture({ failQuery: sql => sql === 'SELECT synthetic_canonical_work' ? failure : null });
  await assert.rejects(f.run(), code('23514', { nameCommitRolledBack: true }));
  assert.ok(!sqls(f).includes('COMMIT')); assert.deepEqual(f.releases, [failure]);
});

test('second connect, pool query and nested transaction fail closed without another real lease', async t => {
  const actions = {
    connect: pool => pool.connect(), query: pool => pool.query('SELECT bypass'),
    nested: (_pool, tx) => tx.query('BEGIN'), changedTransaction: (_pool, tx) => tx.query('COMMIT AND CHAIN'),
  };
  for (const [name, action] of Object.entries(actions)) await t.test(name, async () => {
    const f = fixture({ inTransaction: action });
    await assert.rejects(f.run(), code('CAMPAIGN_NAME_COMMIT_CLIENT_CONTRACT', { nameCommitRolledBack: true }));
    assert.equal(f.connects, 1); assert.equal(f.releases.length, 1); assert.ok(f.releases[0]);
    assert.ok(!sqls(f).includes('COMMIT')); assert.ok(!sqls(f).includes('SELECT bypass'));
  });
});

test('swallowed client misuse cannot produce a successful commit receipt', async () => {
  const f = fixture({ inTransaction: async pool => { await pool.connect().catch(() => {}); } });
  await assert.rejects(f.run(), code('CAMPAIGN_NAME_COMMIT_UNCONFIRMED', { unconfirmed: true }));
  assert.equal(f.connects, 1); assert.ok(f.releases[0]);
});

test('lost COMMIT response always remains unconfirmed despite a successful later rollback', async () => {
  const failure = problem('COMMIT_RESPONSE_LOST'), f = fixture({ failQuery: sql => sql === 'COMMIT' ? failure : null });
  await assert.rejects(f.run(), code('CAMPAIGN_NAME_COMMIT_UNCONFIRMED', { unconfirmed: true }));
  assert.equal(sqls(f).filter(sql => sql === 'COMMIT').length, 1);
  assert.ok(sqls(f).includes('ROLLBACK')); assert.deepEqual(f.releases, [failure]);
});

test('COMMIT returning a ROLLBACK tag is never confirmed', async () => {
  const f = fixture({ commandTag: sql => sql === 'COMMIT' ? 'ROLLBACK' : null });
  await assert.rejects(f.run(), code('CAMPAIGN_NAME_COMMIT_UNCONFIRMED', { unconfirmed: true }));
  assert.ok(f.releases[0]);
});

test('a post-commit failure remains unconfirmed with no replay', async () => {
  const f = fixture({ afterCommit: async () => { throw problem('POST_COMMIT_FAILED'); } });
  await assert.rejects(f.run(), code('CAMPAIGN_NAME_COMMIT_UNCONFIRMED', { unconfirmed: true }));
  assert.equal(sqls(f).filter(sql => sql === 'COMMIT').length, 1);
});

test('failed canonical rollback is retried only as cleanup, and never retried as a commit', async t => {
  for (const recovers of [true, false]) await t.test(String(recovers), async () => {
    let rollbacks = 0; const failure = problem('ROLLBACK_FAILED');
    const f = fixture({ inTransaction: async () => { throw problem('SOURCE_CHANGED'); },
      failQuery: sql => sql === 'ROLLBACK' && (++rollbacks === 1 || !recovers) ? failure : null });
    await assert.rejects(f.run(), recovers ? code('SOURCE_CHANGED', { nameCommitRolledBack: true })
      : code('CAMPAIGN_NAME_COMMIT_UNCONFIRMED', { unconfirmed: true }));
    assert.equal(rollbacks, 2); assert.ok(!sqls(f).includes('COMMIT')); assert.deepEqual(f.releases, [failure]);
  });
});

test('canonical lifecycle unlock failure is remembered even if later cleanup swallows it', async () => {
  const failure = problem('GATE_UNLOCK_FAILED');
  const f = fixture({ failQuery: sql => sql === 'SELECT pg_advisory_unlock_shared(hashtext($1))' ? failure : null });
  await assert.rejects(f.run(), code('CAMPAIGN_NAME_COMMIT_UNCONFIRMED', { unconfirmed: true }));
  assert.deepEqual(f.releases, [failure]);
});

test('admin unlock false, SQL error, or release error cannot confirm a successful commit', async t => {
  for (const kind of ['false', 'query', 'release']) await t.test(kind, async () => {
    const failure = problem('CLEANUP_FAILED');
    const f = fixture({ unlockResult: kind === 'false' ? false : true,
      failQuery: sql => kind === 'query' && sql === 'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked' ? failure : null,
      releaseFailure: kind === 'release' ? failure : null });
    await assert.rejects(f.run(), code('CAMPAIGN_NAME_COMMIT_UNCONFIRMED', { unconfirmed: true }));
    assert.equal(f.releases.length, 1); if (kind !== 'release') assert.ok(f.releases[0]);
  });
});

test('empty canonical return without leasing or COMMIT is refused', async () => {
  const f = fixture(); f.runtime.first.commit = async () => f.result;
  await assert.rejects(f.run(), code('CAMPAIGN_NAME_COMMIT_CLIENT_CONTRACT', { nameCommitNotStarted: true }));
  assert.equal(f.releases.length, 1); assert.ok(f.releases[0]);
});
