'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Socket } = require('node:net');
const { Pool } = require('pg');
const { guardPool } = require('../scripts/operator-authority');
const { runAccessAdminMutation } = require('../src/services/access-admin-transaction');

function transactionFixture(t, { demoteAtLock = false } = {}) {
  const unexpectedIo = [];
  const forbid = operation => () => {
    unexpectedIo.push(operation);
    throw new Error(`Unexpected ${operation}`);
  };
  t.mock.method(Socket.prototype, 'connect', forbid('network connection'));
  t.mock.method(globalThis, 'fetch', forbid('fetch'));
  t.mock.method(Pool.prototype, 'query', forbid('database query'));
  t.mock.method(Pool.prototype, 'connect', forbid('database connection'));
  t.after(() => assert.deepEqual(unexpectedIo, []));

  const events = [];
  let authorityLocked = false;
  let administrator = true;
  const empty = { rows: [], rowCount: 0 };
  const client = {
    async query(statement, parameters) {
      assert.equal(this, client);
      const sql = typeof statement === 'string' ? statement : statement.text;
      const values = typeof statement === 'string' ? parameters : statement.values;
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) {
        events.push(sql);
        return empty;
      }
      // The lower pool models acquisition independently of guardPool's exact matcher.
      // In particular it accepts an equivalent bigint cast, so missed interception
      // cannot be hidden by the fake rejecting the producer's SQL first.
      if (/^SELECT\s+pg_advisory_xact_lock\(hashtext\(\$1\)(?:::bigint)?\)\s*;?$/i.test(sql.trim())) {
        assert.deepEqual(values, ['amber_application_user_admin_active_administrators']);
        authorityLocked = true;
        if (demoteAtLock) administrator = false;
        events.push('authority-lock-acquired');
        return empty;
      }
      if (sql.includes('FROM application_users u') && sql.includes('AS has_permission')) {
        assert.equal(authorityLocked, true, 'Permission revalidation must follow lock acquisition');
        assert.deepEqual(values, [7, 'exports.create']);
        events.push(sql.includes('FOR KEY SHARE') ? 'service-permission' : 'operator-permission');
        // This delegable UI permission deliberately survives Administrator demotion.
        return { rows: [{ status: 'active', has_permission: true }], rowCount: 1 };
      }
      if (sql.includes('FROM user_role_assignments a JOIN roles r') && sql.includes("r.role_key='administrator'")) {
        assert.equal(authorityLocked, true, 'Administrator revalidation must follow lock acquisition');
        assert.deepEqual(values, [7]);
        events.push('operator-administrator');
        return { rows: [], rowCount: administrator ? 1 : 0 };
      }
      if (sql === 'SELECT pg_advisory_lock_shared(hashtext($1))'
        || sql === 'SELECT pg_advisory_unlock_shared(hashtext($1))') {
        assert.deepEqual(values, ['amber_full_product_cutover']);
        events.push(sql.includes('unlock_shared') ? 'lifecycle-unlock' : 'lifecycle-lock');
        return empty;
      }
      if (sql === "SET LOCAL amber.lifecycle_writer_version = '1'") {
        events.push('lifecycle-writer');
        return empty;
      }
      if (sql === "SELECT to_regclass('full_product_export_activation') IS NOT NULL AS present") {
        events.push('lifecycle-read');
        return { rows: [{ present: false }], rowCount: 1 };
      }
      assert.fail(`Unexpected SQL: ${sql}`);
    },
    release(discard) {
      assert.equal(this, client);
      assert.equal(Boolean(discard), false);
      events.push('release');
    },
  };
  const pool = {
    async connect() { assert.equal(this, pool); events.push('connect'); return client; },
    query: forbid('query outside the checked-out transaction'),
  };
  const run = operation => runAccessAdminMutation({
    databasePool: guardPool(pool, 7, ['exports.create']),
    actorUserId: 7,
    requiredPermission: 'exports.create',
    createError: (status, code, message) => Object.assign(new Error(message), { status, code }),
    operation,
  });
  return { events, run };
}

test('real access-admin mutation rechecks CLI Administrator inside its actual authority lock before the operation', async t => {
  const f = transactionFixture(t);
  const result = { receipt: 'synthetic-operation' };
  assert.equal(await f.run(async () => {
    assert.deepEqual(f.events.slice(0, 6), [
      'connect', 'BEGIN', 'authority-lock-acquired',
      'operator-permission', 'operator-administrator', 'service-permission',
    ]);
    f.events.push('operation');
    return result;
  }), result);
  assert.deepEqual(f.events, [
    'connect', 'BEGIN', 'authority-lock-acquired',
    'operator-permission', 'operator-administrator', 'service-permission',
    'lifecycle-lock', 'lifecycle-writer', 'lifecycle-read', 'operation',
    'COMMIT', 'lifecycle-unlock', 'release',
  ]);
});

test('real access-admin mutation refuses post-lock Administrator demotion even when the UI permission survives', async t => {
  const f = transactionFixture(t, { demoteAtLock: true });
  let operationCalls = 0;
  await assert.rejects(f.run(async () => { operationCalls += 1; }), {
    code: 'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED',
  });
  assert.equal(operationCalls, 0);
  assert.deepEqual(f.events, [
    'connect', 'BEGIN', 'authority-lock-acquired',
    'operator-permission', 'operator-administrator', 'ROLLBACK', 'release',
  ]);
});
