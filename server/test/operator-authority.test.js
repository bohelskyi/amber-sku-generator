'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { authorize, guardPool } = require('../scripts/operator-authority');
const { APPLICATION_USER_ADMIN_LOCK_KEY: key } = require('../src/services/access-admin-transaction');

function fixture(settings = {}) {
  const calls = [];
  const state = { status: 'active', allowed: true, administrator: true, ...settings };
  const client = {
    async query(sql, values) {
      const text = typeof sql === 'string' ? sql : sql.text;
      calls.push({ sql: text, values: values || sql.values });
      if (text.includes('pg_advisory_unlock_shared') && state.unlockFails) throw new Error('connection lost');
      if (/pg_advisory_(?:xact_lock|lock_shared)\(/.test(text) && state.onLock) state.onLock(state);
      if (text.includes('FROM application_users u')) return { rows: state.missing ? [] : [{ status: state.status, has_permission: state.allowed }] };
      if (text.includes("r.role_key='administrator'")) return { rowCount: state.administrator ? 1 : 0, rows: [] };
      return { rows: [], rowCount: 0 };
    },
    release(discard) { assert.equal(this, client); calls.push({ release: Boolean(discard) }); },
  };
  const pool = { async connect() { assert.equal(this, pool); return client; }, query: (...args) => client.query(...args),
    async end() { assert.equal(this, pool); calls.push({ end: true }); } };
  return { calls, state, pool, client };
}

test('operator authority uses active-user and every UI permission plus the active Administrator role', async () => {
  const f = fixture();
  await authorize(f.pool, 7, ['exports.create', 'exports.view']);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.slice(0, 2).map(call => call.values), [[7, 'exports.create'], [7, 'exports.view']]);
  assert.ok(f.calls.every(call => !call.sql.includes('FOR KEY SHARE')));
  assert.deepEqual(f.calls[2].values, [7]);
});

test('operator authority refuses missing, inactive, unauthorized and non-Administrator actors', async () => {
  for (const settings of [{ missing: true }, { status: 'pending' }, { status: 'disabled' }, { allowed: false }]) {
    const f = fixture(settings);
    await assert.rejects(authorize(f.pool, 7, ['exports.create']), { code: 'ADMIN_PERMISSION_REVOKED' });
    assert.equal(f.calls.length, 1);
  }
  await assert.rejects(authorize(fixture({ administrator: false }).pool, 7, ['exports.create']),
    { code: 'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED' });
  for (const [actor, permissions] of [[0, ['exports.create']], [7, []], [7, [null]], ['7', ['exports.create']]]) {
    const f = fixture();
    await assert.rejects(authorize(f.pool, actor, permissions), { code: 'OPERATOR_AUTHORITY_INVALID' });
    assert.equal(f.calls.length, 0);
  }
});

test('transaction authority lock rechecks Administrator after acquisition before the caller can write', async () => {
  const f = fixture({ onLock: state => { state.administrator = false; } });
  await authorize(f.pool, 7, ['exports.create']);
  const client = await guardPool(f.pool, 7, ['exports.create']).connect();
  let wrote = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    wrote = true;
  } catch (cause) {
    assert.equal(cause.code, 'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED');
    await client.query('ROLLBACK');
  } finally { client.release(); }
  assert.equal(wrote, false);
  assert.equal(f.calls.at(-2).sql, 'ROLLBACK');
  assert.deepEqual(f.calls.at(-1), { release: false });
});

test('session authority lock is released when refusal occurs before the service sets its cleanup flag', async () => {
  const f = fixture({ onLock: state => { state.allowed = false; } });
  const client = await guardPool(f.pool, 7, ['exports.reconcile']).connect();
  await assert.rejects(client.query('SELECT pg_advisory_lock_shared(hashtext($1))', [key]), { code: 'ADMIN_PERMISSION_REVOKED' });
  assert.equal(f.calls.at(-1).sql, 'SELECT pg_advisory_unlock_shared(hashtext($1))');
  assert.deepEqual(f.calls.at(-1).values, [key]);
  client.release();
  assert.deepEqual(f.calls.at(-1), { release: false });
});

test('an unreleasable session authority lock discards the connection instead of returning it to the pool', async () => {
  const f = fixture({ administrator: false, unlockFails: true });
  const client = await guardPool(f.pool, 7, ['exports.reconcile']).connect();
  await assert.rejects(client.query('SELECT pg_advisory_lock_shared(hashtext($1))', [key]),
    { code: 'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED' });
  client.release();
  assert.deepEqual(f.calls.at(-1), { release: true });
});

test('guard forwards the pool and queries, ignores unrelated locks and checks query-object authority locks', async () => {
  const f = fixture(), guarded = guardPool(f.pool, 7, ['exports.view']);
  await guarded.query('SELECT 1');
  const client = await guarded.connect();
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['different_lock']);
  assert.equal(f.calls.length, 2);
  await client.query({ text: 'SELECT pg_advisory_xact_lock(hashtext($1));', values: [key] });
  assert.equal(f.calls.length, 5);
  assert.deepEqual(f.calls.at(-1).values, [7]);
  client.release(); await guarded.end();
  assert.deepEqual(f.calls.slice(-2), [{ release: false }, { end: true }]);
});
