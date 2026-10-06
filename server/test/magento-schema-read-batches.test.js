const test = require('node:test');
const assert = require('node:assert/strict');
const { readBatches, withReadBudget } = require('../src/services/magento/schema-read-batches');

test('schema batch drains failures, consumes in input order and starts no later batch', async () => {
  const reads = [], consumed = []; let active = 0;
  await assert.rejects(readBatches([1, 2, 3, 4, 5], 4, async (id) => {
    reads.push(id); active++;
    try { await new Promise((resolve) => setImmediate(resolve)); if (id === 2) throw new Error('failed'); return id; }
    finally { active--; }
  }, (id) => consumed.push(id)), /failed/);
  assert.equal(active, 0); assert.deepEqual(reads, [1, 2, 3, 4]); assert.deepEqual(consumed, []);
  await readBatches([1, 2, 3, 4, 5], 4, async (id) => id, (id) => consumed.push(id));
  assert.deepEqual(consumed, [1, 2, 3, 4, 5]);
});

test('schema budget caps the entire audit at 512 GETs and has no write path or response cache', async () => {
  let requests = 0; const signals = [];
  await withReadBudget(async (url, options) => { requests++; signals.push(options.signal); return new Response('{}'); }, async (read) => {
    await assert.rejects(read('https://fixture.invalid', { method: 'PUT' }), { code: 'MAGENTO_DISCOVERY_LIMIT' });
    for (let index = 0; index < 512; index++) await read('https://fixture.invalid', { method: 'GET' });
    await assert.rejects(read('https://fixture.invalid', { method: 'GET' }), { code: 'MAGENTO_DISCOVERY_LIMIT' });
  });
  assert.equal(requests, 512); assert.equal(signals.every((signal) => signal.aborted), true);
});

test('schema deadline aborts pending reads and retains a caller cancellation signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let active = 0; let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const controller = new AbortController();
  const pending = withReadBudget(async (url, options) => {
    active++; started();
    try { await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); }
    finally { active--; }
  }, (read) => read('https://fixture.invalid', { method: 'GET', signal: controller.signal }));
  await ready; t.mock.timers.tick(60000);
  await assert.rejects(pending, { code: 'MAGENTO_DISCOVERY_LIMIT' }); assert.equal(active, 0);
  t.mock.timers.reset();
  await assert.rejects(withReadBudget(async (url, options) => {
    const pending = new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('caller cancelled')), { once: true }));
    controller.abort(); return pending;
  }, (read) => read('https://fixture.invalid', { method: 'GET', signal: controller.signal })), /caller cancelled/);
});

test('schema deadline remains effective while a received response body is streaming', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let received; let aborted = false;
  const ready = new Promise((resolve) => { received = resolve; });
  const pending = withReadBudget(async (url, options) => new Response(new ReadableStream({ start(body) {
    body.enqueue(Buffer.from('{'));
    options.signal.addEventListener('abort', () => { aborted = true; body.error(options.signal.reason); }, { once: true });
    received();
  } })), async (read) => (await read('https://fixture.invalid', { method: 'GET' })).json());
  await ready; t.mock.timers.tick(60000);
  await assert.rejects(pending, { code: 'MAGENTO_DISCOVERY_LIMIT' }); assert.equal(aborted, true);
});
