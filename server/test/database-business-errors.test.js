const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { PublicHttpError, serializeHttpError } = require('../src/http/errors');
const { createRequestMetrics, runWithRequestMetrics, instrumentPostgresPool } = require('../src/observability/performance-metrics');
const { normalizeBusinessDatabaseError, instrumentBusinessDatabaseErrors } = require('../src/db/business-errors');

const fence = () => Object.assign(new Error('private SQL and row detail'), {
  code: 'P0651', constraint: 'product_media_native_input_fence', detail: 'private row data',
});

test('only the exact database media fence becomes a safe business conflict', () => {
  const original = fence();
  const mapped = normalizeBusinessDatabaseError(original);
  assert.ok(mapped instanceof PublicHttpError);
  assert.equal(mapped.statusCode, 409);
  assert.equal(mapped.code, 'PHOTO_MEDIA_RECONCILIATION_REQUIRED');
  assert.match(mapped.message, /передавання фото/);
  assert.equal(mapped.detail, undefined);
  assert.equal(mapped.constraint, undefined);
  assert.ok(!JSON.stringify(serializeHttpError(mapped, { includeCode: true, includeDetails: true })).includes('private'));
  for (const error of [Object.assign(fence(), { code: '23505' }), Object.assign(fence(), { constraint: 'other_fence' }), new Error('network'), mapped, null]) {
    assert.equal(normalizeBusinessDatabaseError(error), error);
  }
});

test('pool and acquired-client promises preserve results and unrelated errors', async () => {
  const ordinary = new Error('ordinary');
  const result = { rows: [{ id: 1 }], rowCount: 1 };
  const pool = Object.assign(new EventEmitter(), { async query(command) {
    if (command === 'fence') throw fence();
    if (command === 'ordinary') throw ordinary;
    return result;
  } });
  instrumentBusinessDatabaseErrors(pool);
  instrumentBusinessDatabaseErrors(pool);
  assert.equal(pool.listenerCount('connect'), 1);
  assert.equal(await pool.query('ok'), result);
  await assert.rejects(pool.query('fence'), { statusCode: 409, code: 'PHOTO_MEDIA_RECONCILIATION_REQUIRED' });
  await assert.rejects(pool.query('ordinary'), (error) => error === ordinary);
  const client = { query: pool.query };
  pool.emit('connect', client);
  await assert.rejects(client.query('fence'), { statusCode: 409 });
  assert.equal(await client.query('ok'), result);
});

test('positional and config callbacks retain caller configuration and successful results', async () => {
  const result = { rows: [], rowCount: 0 }, context = {};
  const pool = Object.assign(new EventEmitter(), { query(...args) {
    const callback = typeof args[2] === 'function' ? args[2] : typeof args[1] === 'function' ? args[1] : args[0].callback;
    const command = typeof args[0] === 'string' ? args[0] : args[0].text;
    callback.call(context, command === 'fence' ? fence() : null, result);
    return 'callback-return';
  } });
  instrumentBusinessDatabaseErrors(pool);
  for (const form of [1, 2, 3]) {
    await new Promise((resolve, reject) => {
      const callback = function(error, received) {
        try { assert.equal(this, context); assert.equal(error.statusCode, 409); assert.equal(received, result); resolve(); }
        catch (failure) { reject(failure); }
      };
      const config = { text: 'fence', values: [1], callback };
      const returned = form === 1 ? pool.query('fence', callback) : form === 2 ? pool.query('fence', [1], callback) : pool.query(config);
      assert.equal(returned, 'callback-return');
      assert.equal(config.callback, callback);
    });
  }
  pool.query('ok', (error, received) => { assert.equal(error, null); assert.equal(received, result); });
});

test('synchronous failures map narrowly and non-Promise query objects retain identity', () => {
  const ordinary = new Error('ordinary');
  const emitter = new EventEmitter();
  const pool = Object.assign(new EventEmitter(), { query(command) {
    if (command === 'fence') throw fence();
    if (command === 'ordinary') throw ordinary;
    return emitter;
  } });
  instrumentBusinessDatabaseErrors(pool);
  assert.throws(() => pool.query('fence'), { statusCode: 409 });
  assert.throws(() => pool.query('ordinary'), (error) => error === ordinary);
  assert.equal(pool.query('stream'), emitter);
});

test('database metrics still record the original SQLSTATE once before conversion', async () => {
  const pool = Object.assign(new EventEmitter(), { query() {} });
  instrumentPostgresPool(pool);
  instrumentBusinessDatabaseErrors(pool);
  const client = { async query() { throw fence(); } };
  pool.emit('connect', client);
  const metrics = createRequestMetrics('media-fence', { enabled: true });
  await runWithRequestMetrics(metrics, async () => {
    await assert.rejects(client.query('UPDATE products SET weight=$1', [1]), { statusCode: 409 });
  });
  assert.equal(metrics.queryCount, 1);
  const observed = [...metrics.queryFingerprints.values()][0];
  assert.equal(observed.count, 1);
  assert.equal(metrics.slowestQueries[0].errorCode, 'P0651');
});
