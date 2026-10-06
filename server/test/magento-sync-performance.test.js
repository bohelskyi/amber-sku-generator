const test = require('node:test');
const assert = require('node:assert/strict');
const { measurePhase } = require('../src/services/magento/sync-performance');

test('phase transport telemetry preserves the exact response and transport arguments without logging private material', async () => {
  const entries = [], controller = new AbortController();
  const headers = { Authorization: 'SENTINEL_PRIVATE_OAUTH' };
  const response = new Response('SENTINEL_PRIVATE_BODY', { status: 200 });
  const url = 'https://SENTINEL_PRIVATE_HOST.invalid/rest/all/V1/products?sku=SENTINEL_PRIVATE_SKU';
  const options = { automatic: { productId: 12, publicIdentityId: '9', generation: '7' }, telemetryStage: 'enqueue',
    fetchImpl: async (actualUrl, actualOptions) => { assert.equal(actualUrl, url); assert.equal(actualOptions.headers, headers); assert.equal(actualOptions.signal, controller.signal); return response; },
    logger: { info(event, value) { entries.push({ event, value }); } } };
  assert.equal(await measurePhase(options, 'observation', (read) => read(url, { method: 'GET', headers, signal: controller.signal })), response);
  const phase = entries[0].value;
  assert.equal(phase.stage, 'enqueue');
  assert.equal(phase.transportHeaders.count, 1);
  assert.equal(phase.transportHeaders.kinds[0].kind, 'product_lookup');
  assert.equal(phase.transportHeaders.kinds[0].method, 'GET');
  assert.ok(phase.startedUtc && phase.finishedUtc);
  assert.doesNotMatch(JSON.stringify(entries), /SENTINEL|Authorization|headers.*PRIVATE|sku=/i);
  assert.equal(await response.text(), 'SENTINEL_PRIVATE_BODY', 'telemetry must not consume or replace the response body');
});

test('nested and parallel phase collectors remain isolated and count each request once in each containing phase', async () => {
  const entries = [];
  const execute = (id) => {
    const options = { automatic: { productId: id, publicIdentityId: String(id), generation: '1' }, telemetryStage: 'apply',
      logger: { info(event, value) { entries.push({ event, value }); } },
      fetchImpl: async () => { await new Promise((resolve) => setImmediate(resolve)); return new Response('{}'); } };
    return measurePhase(options, 'observation', (outerRead) => measurePhase({ ...options, fetchImpl: outerRead }, 'schema_discovery',
      (read) => Promise.all([read('https://fixture.invalid/rest/all/V1/products/attributes/a/options', { method: 'GET' }),
        read('https://fixture.invalid/rest/all/V1/products/attributes/b/options', { method: 'GET' })])));
  };
  await Promise.all([execute(12), execute(13)]);
  assert.equal(entries.length, 4);
  for (const entry of entries) {
    assert.equal(entry.value.transportHeaders.count, 2);
    assert.equal(entry.value.transportHeaders.kinds.length, 1);
    assert.equal(entry.value.transportHeaders.kinds[0].kind, 'attribute_options');
    assert.equal(entry.value.stage, 'apply');
  }
});

test('transport and logging failures preserve the exact original operation failure and never retry', async () => {
  const failure = new Error('SENTINEL_PRIVATE_NETWORK'); let calls = 0;
  const options = { automatic: { productId: 12, publicIdentityId: '9', generation: '7' },
    logger: { info: async () => { throw new Error('SENTINEL_PRIVATE_LOGGER'); } },
    fetchImpl: async () => { calls++; throw failure; } };
  await assert.rejects(measurePhase(options, 'dispatch', (write) => write('https://fixture.invalid/rest/all/V1/products',
    { method: 'POST', body: 'SENTINEL_PRIVATE_BODY' })), (cause) => cause === failure);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('unknown phases and invalid identities do not emit arbitrary input while the operation still runs', async () => {
  const entries = [], value = {};
  for (const [automatic, phase] of [[{ productId: 12, publicIdentityId: '9', generation: '7' }, 'SENTINEL_PRIVATE_PHASE'],
    [{ productId: 12, publicIdentityId: 'SENTINEL_PRIVATE_ID', generation: '7' }, 'observation']]) {
    assert.equal(await measurePhase({ automatic, logger: { info: (...args) => entries.push(args) } }, phase, async () => value), value);
  }
  assert.deepEqual(entries, []);
});

test('request claim telemetry distinguishes age since latest update from due delay without logging SQL or payload', () => {
  const { recordRequestClaim } = require('../src/services/magento/sync-performance');
  const entries = [];
  recordRequestClaim({ automatic: { productId: 12, publicIdentityId: '9', generation: '7' }, logger: { info: (event, value) => entries.push({ event, value }) } },
    { updated_at: new Date('2026-10-05T10:00:00Z'), next_attempt_at: new Date('2026-10-05T10:00:02Z'), payload: 'SENTINEL_PRIVATE_BODY' },
    Date.parse('2026-10-05T10:00:05Z'));
  assert.equal(entries[0].value.requestAgeAtClaimMs, 5000);
  assert.equal(entries[0].value.dueDelayAtClaimMs, 3000);
  assert.equal(entries[0].value.requestUpdatedAt, '2026-10-05T10:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(entries), /SENTINEL|payload|SQL/);
});

test('telemetry forwards actual abort failure once and ignores invalid diagnostic metadata', async () => {
  const { recordRequestClaim } = require('../src/services/magento/sync-performance');
  const controller = new AbortController(), abortFailure = new Error('SENTINEL_ABORT');
  const entries = []; let calls = 0, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const options = { automatic: { productId: 12, publicIdentityId: '9', generation: '7' },
    logger: { info: (event, value) => entries.push({ event, value }) },
    fetchImpl: async (_url, request) => { calls++; started(); return new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(abortFailure), { once: true });
    }); } };
  const pending = measurePhase(options, 'precondition_read', (read) => read('https://fixture.invalid/rest/all/V1/products',
    { method: 'GET', signal: controller.signal }));
  await ready; controller.abort(); await assert.rejects(pending, (cause) => cause === abortFailure);
  assert.equal(calls, 1); assert.equal(entries[0].value.transportHeaders.kinds[0].fetchFailures, 1);
  assert.doesNotThrow(() => recordRequestClaim(options, { updated_at: Symbol('bad timestamp') }));
  const result = {};
  const unavailableLogger = { get info() { throw new Error('SENTINEL_LOGGER_GETTER'); } };
  assert.equal(await measurePhase({ ...options, logger: unavailableLogger }, 'observation', async () => result), result);
  await assert.rejects(measurePhase(options, 'observation', async () => { throw null; }), (cause) => cause === null);
});

test('automatic phase telemetry records only safe identities/timings and preserves operation result', async () => {
  const entries = [];
  const options = { automatic: { productId: 12, publicIdentityId: '9', generation: '7' },
    logger: { info(event, value) { entries.push({ event, value }); } } };
  const privateResult = { secret: 'OAuth payload' };
  assert.equal(await measurePhase(options, 'schema_discovery', async () => privateResult), privateResult);
  const failure = Object.assign(new Error('OAuth secret remote body'), { code: 'MAGENTO_TIMEOUT' });
  await assert.rejects(measurePhase(options, 'step_readback', async () => { throw failure; }), (cause) => cause === failure);
  assert.equal(entries[0].value.durationMs >= 0, true);
  assert.equal(entries[1].value.code, 'MAGENTO_TIMEOUT');
  assert.doesNotMatch(JSON.stringify(entries), /OAuth|secret|payload|remote body/);
  options.logger.info = () => { throw new Error('Logging failed'); };
  assert.equal(await measurePhase(options, 'dispatch', async () => privateResult), privateResult);
  await assert.rejects(measurePhase(options, 'step_readback', async () => { throw failure; }), (cause) => cause === failure);
});
