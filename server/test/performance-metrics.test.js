const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  MAX_SLOW_QUERIES,
  createRequestMetrics,
  getQueryFingerprint,
  instrumentPostgresClient,
  instrumentPostgresPool,
  isMetricsEnabled,
  runWithRequestMetrics,
  startPhase,
  summarizeRequestMetrics,
} = require('../src/observability/performance-metrics');

function promiseClient(handler) {
  return {
    query(...args) {
      return handler(...args);
    },
  };
}

test('query instrumentation preserves Promise results and counts transaction controls', async () => {
  const client = instrumentPostgresClient(promiseClient(async (text) => ({
    command: String(text).split(' ')[0],
    rowCount: text === 'SELECT 1' ? 1 : null,
    rows: [],
  })));
  const metrics = createRequestMetrics('request-1');

  await runWithRequestMetrics(metrics, async () => {
    await client.query('BEGIN');
    assert.equal((await client.query('SELECT 1')).rowCount, 1);
    await client.query('COMMIT');
  });

  const summary = summarizeRequestMetrics(metrics, { slowQueryThresholdMs: 0 });
  assert.equal(summary.dbQueryCount, 3);
  assert.equal(summary.dbTransactionControlCount, 2);
  assert.equal(summary.slowQueries.length, 3);
  assert.equal(Object.hasOwn(summary, 'dbQueryFingerprints'), false);
  assert.ok(summary.slowQueries.every((query) => /^[a-f0-9]{16}$/.test(query.fingerprint)));
});

test('query instrumentation preserves callback behavior and records errors once', async () => {
  const expected = Object.assign(new Error('failed'), { code: 'TEST_FAILURE' });
  const client = instrumentPostgresClient({
    query(_text, _values, callback) {
      setImmediate(() => callback(expected));
      return undefined;
    },
  });
  const metrics = createRequestMetrics('request-2');

  await runWithRequestMetrics(metrics, () => new Promise((resolve) => {
    client.query('SELECT secret FROM hidden WHERE value = $1', ['not-logged'], (error) => {
      assert.equal(error, expected);
      resolve();
    });
  }));

  const summary = summarizeRequestMetrics(metrics, { slowQueryThresholdMs: 0 });
  assert.equal(summary.dbQueryCount, 1);
  assert.equal(summary.slowQueries[0].errorCode, 'TEST_FAILURE');
  assert.equal(JSON.stringify(summary).includes('not-logged'), false);
  assert.equal(JSON.stringify(summary).includes('secret'), false);
});

test('callback completion records against the context captured at query invocation', async () => {
  let deferredCallback;
  const client = instrumentPostgresClient({
    query(_text, callback) {
      deferredCallback = callback;
    },
  });
  const metrics = createRequestMetrics('callback-context');
  runWithRequestMetrics(metrics, () => client.query('SELECT 1', () => {}));
  deferredCallback(null, { rowCount: 1, rows: [] });

  assert.equal(summarizeRequestMetrics(metrics).dbQueryCount, 1);
});

test('pool instrumentation wraps each physical client once without wrapping pool.query', async () => {
  const pool = new EventEmitter();
  instrumentPostgresPool(pool);
  const client = promiseClient(async () => ({ rowCount: 1, rows: [{ ok: true }] }));
  pool.emit('connect', client);
  pool.emit('connect', client);
  const metrics = createRequestMetrics('request-3');

  await runWithRequestMetrics(metrics, () => client.query('SELECT 1'));

  assert.equal(summarizeRequestMetrics(metrics).dbQueryCount, 1);
});

test('overlapping request contexts remain isolated and phases are request scoped', async () => {
  const client = instrumentPostgresClient(promiseClient(async (text) => {
    await new Promise((resolve) => setImmediate(resolve));
    return { rowCount: text === 'SELECT 1' ? 1 : 2, rows: [] };
  }));
  const first = createRequestMetrics('first');
  const second = createRequestMetrics('second');

  await Promise.all([
    runWithRequestMetrics(first, async () => {
      const finish = startPhase('first.phase');
      await client.query('SELECT 1');
      finish();
    }),
    runWithRequestMetrics(second, async () => {
      await client.query('SELECT 2');
      await client.query('SELECT 3');
    }),
  ]);

  assert.equal(summarizeRequestMetrics(first).dbQueryCount, 1);
  assert.equal(summarizeRequestMetrics(second).dbQueryCount, 2);
  assert.equal(summarizeRequestMetrics(first).performancePhases['first.phase'].count, 1);
  assert.deepEqual(summarizeRequestMetrics(second).performancePhases, {});
});

test('only the five slowest fingerprints are retained and summaries expose no query text', async () => {
  const client = instrumentPostgresClient(promiseClient(async () => ({ rowCount: 0, rows: [] })));
  const metrics = createRequestMetrics('request-4');
  await runWithRequestMetrics(metrics, async () => {
    for (let index = 0; index < 12; index += 1) {
      await client.query(`SELECT ${index}`);
    }
  });

  const summary = summarizeRequestMetrics(metrics, { slowQueryThresholdMs: 0 });
  assert.equal(summary.dbQueryCount, 12);
  assert.equal(summary.slowQueries.length, MAX_SLOW_QUERIES);
  assert.equal(JSON.stringify(summary).includes('SELECT 0'), false);
  assert.equal(JSON.stringify(summary).includes('queryText'), false);
});

test('disabled instrumentation is a direct pass-through', async () => {
  let calls = 0;
  const client = instrumentPostgresClient(promiseClient(async () => {
    calls += 1;
    return { rowCount: 1, rows: [] };
  }));
  const metrics = createRequestMetrics('disabled', { enabled: false });
  await runWithRequestMetrics(metrics, () => client.query('SELECT 1'));

  assert.equal(calls, 1);
  assert.deepEqual(summarizeRequestMetrics(metrics), {});
  assert.equal(isMetricsEnabled({ PERF_METRICS_ENABLED: 'false' }), false);
  assert.equal(isMetricsEnabled({}), true);
});

test('query fingerprints are stable without exposing parameter values', () => {
  assert.equal(
    getQueryFingerprint('SELECT *\nFROM products WHERE id = $1'),
    getQueryFingerprint('SELECT * FROM products WHERE id = $1')
  );
});

test('benchmark-only fingerprint detail is opt-in', async () => {
  const client = instrumentPostgresClient(promiseClient(async () => ({ rowCount: 1, rows: [] })));
  const metrics = createRequestMetrics('details');
  await runWithRequestMetrics(metrics, () => client.query('SELECT $1', ['hidden']));
  const summary = summarizeRequestMetrics(metrics, {
    includeFingerprintDetails: true,
    slowQueryThresholdMs: Number.MAX_VALUE,
  });
  assert.equal(summary.dbQueryFingerprints.length, 1);
  assert.doesNotMatch(JSON.stringify(summary), /hidden|SELECT \$1/);
});
