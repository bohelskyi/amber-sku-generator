const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DATABASE_NAME_QUERY,
  resetDisposableSchema,
  verifyConnectedTestDatabase,
} = require('../performance-test/database-safety');
const { sanitizePlan } = require('../performance-test/plan-sanitizer');

function fakeClient(databaseNames) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async query(text) {
      calls.push(text);
      if (text === DATABASE_NAME_QUERY) {
        return { rows: [{ database_name: databaseNames[index++] }] };
      }
      return { rows: [] };
    },
  };
}

test('URL text is insufficient when the connected database is not disposable', async () => {
  const client = fakeClient(['inventory']);
  await assert.rejects(
    verifyConnectedTestDatabase(client, 'postgresql://localhost/apparently_test'),
    /must end in _test/
  );
  assert.deepEqual(client.calls, [DATABASE_NAME_QUERY]);
});

test('a connected database ending in _test is accepted', async () => {
  const client = fakeClient(['amber_test']);
  assert.equal(await verifyConnectedTestDatabase(client), 'amber_test');
  assert.deepEqual(client.calls, [DATABASE_NAME_QUERY]);
});

test('the connected database check is the first SQL statement', async () => {
  const client = fakeClient(['amber_test']);
  await verifyConnectedTestDatabase(client);
  await client.query('SELECT 1');
  assert.equal(client.calls[0], DATABASE_NAME_QUERY);
});

test('fixture reset performs a fresh mandatory database-name check', async () => {
  const client = fakeClient(['amber_test', 'inventory']);
  await verifyConnectedTestDatabase(client);
  let resetCalled = false;
  await assert.rejects(
    resetDisposableSchema(client, async () => { resetCalled = true; }),
    /must end in _test/
  );
  assert.equal(resetCalled, false);
  assert.deepEqual(client.calls, [DATABASE_NAME_QUERY, DATABASE_NAME_QUERY]);
});

test('sanitized plans contain no literal parameters or payload content', () => {
  const raw = [{ Plan: {
    'Node Type': 'Index Scan',
    'Index Cond': "((sku = 'REAL-SKU-SECRET') AND (id = 42))",
    Filter: "(details @> '{\"identity\":\"sensitive\"}'::jsonb)",
    'Actual Rows': 3,
  } }];
  const serialized = JSON.stringify(sanitizePlan(raw));
  assert.doesNotMatch(serialized, /REAL-SKU-SECRET|sensitive|42/);
  assert.match(serialized, /Index Scan/);
  assert.match(serialized, /Actual Rows/);
});
