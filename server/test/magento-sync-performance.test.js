const test = require('node:test');
const assert = require('node:assert/strict');
const { measurePhase, measureLocalPhase } = require('../src/services/magento/sync-performance');

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

test('local phase emits only its allowlisted identity and timing fields without observing private arguments or results', async () => {
  const entries = [], result = { token: 'SENTINEL_PRIVATE_RESULT' }; let calls = 0, fetches = 0;
  const options = { automatic: { productId: 12, publicIdentityId: '9', generation: '7', sku: 'SENTINEL_PRIVATE_SKU' },
    telemetryStage: 'apply', jobId: 'SENTINEL_PRIVATE_JOB', credentials: 'SENTINEL_PRIVATE_SECRET',
    fetchImpl: async () => { fetches++; throw Error('Unexpected HTTP'); },
    logger: { info: (event, value) => entries.push({ event, value }) } };
  for (const phase of ['first_sync_enforce', 'first_sync_commit', 'dispatch_admission', 'finalization', 'retained_capture', 'store_configs']) {
    assert.equal(await measureLocalPhase(options, phase, (...args) => {
      calls++; assert.deepEqual(args, []); return result;
    }), result);
  }
  assert.equal(calls, 6); assert.equal(fetches, 0); assert.equal(entries.length, 6);
  for (const entry of entries) {
    assert.equal(entry.event, 'magento.auto_sync.local_phase');
    assert.deepEqual(Object.keys(entry.value).sort(), ['code', 'durationMs', 'finishedUtc', 'generation', 'phase',
      'productId', 'publicIdentityId', 'stage', 'startedUtc'].sort());
    assert.equal(entry.value.stage, 'apply'); assert.equal(entry.value.code, null);
    assert.ok(Number.isFinite(entry.value.durationMs) && entry.value.durationMs >= 0);
  }
  assert.doesNotMatch(JSON.stringify(entries), /SENTINEL|token|credentials|jobId|sku|transportHeaders/);
});

test('private retained-capture timing inherits automatic context through nested commit without returning timing evidence', async () => {
  const entries = [], result = Object.freeze({ private: 'SENTINEL_RETAINED_CONTENT' });
  const options = { automatic: { productId: 12, publicIdentityId: '9', generation: '7' }, telemetryStage: 'enqueue',
    logger: { info: (event, value) => entries.push({ event, value }) } };
  const actual = await measureLocalPhase(options, 'first_sync_enforce', () =>
    measureLocalPhase(options, 'first_sync_commit', () => measureLocalPhase(null, 'retained_capture', async () => {
      await new Promise(resolve => setImmediate(resolve)); return result;
    })));
  assert.equal(actual, result);
  assert.deepEqual(entries.map(entry => entry.value.phase), ['retained_capture', 'first_sync_commit', 'first_sync_enforce']);
  assert.ok(entries[2].value.durationMs >= entries[1].value.durationMs);
  assert.ok(entries[1].value.durationMs >= entries[0].value.durationMs);
  assert.ok(entries.every(entry => entry.value.productId === 12 && entry.value.stage === 'enqueue'));
  const before = entries.length;
  assert.equal(await measureLocalPhase(null, 'retained_capture', () => result), result);
  assert.equal(entries.length, before, 'Context must not leak into an unrelated later caller');
  assert.doesNotMatch(JSON.stringify(entries), /SENTINEL|private/);
});

test('overlapping automatic operations keep inherited capture identities and stages isolated', async () => {
  const entries = []; let readyCount = 0, release;
  const bothReady = new Promise(resolve => { release = resolve; });
  const execute = (id, stage) => {
    const options = { automatic: { productId: id, publicIdentityId: String(id), generation: String(id + 1) }, telemetryStage: stage,
      logger: { info: (event, value) => entries.push({ event, value }) } };
    return measureLocalPhase(options, 'dispatch_admission', async () => {
      if (++readyCount === 2) release(); await bothReady;
      return measureLocalPhase(null, 'retained_capture', async () => {
        await new Promise(resolve => setImmediate(resolve)); return id;
      });
    });
  };
  assert.deepEqual(await Promise.all([execute(12, 'enqueue'), execute(13, 'apply')]), [12, 13]);
  assert.equal(entries.length, 4);
  for (const id of [12, 13]) {
    const own = entries.filter(entry => entry.value.productId === id).map(entry => entry.value);
    assert.deepEqual(own.map(entry => entry.phase), ['retained_capture', 'dispatch_admission']);
    assert.ok(own.every(entry => entry.publicIdentityId === String(id) && entry.generation === String(id + 1)
      && entry.stage === (id === 12 ? 'enqueue' : 'apply')));
  }
});

test('local phase preserves exact sync and async failures, including null and hostile diagnostic properties', async () => {
  const entries = [], options = { automatic: { productId: 12, publicIdentityId: '9', generation: '7' },
    logger: { info: (event, value) => entries.push({ event, value }) } };
  const known = Object.assign(Error('SENTINEL_PRIVATE_ERROR'), { code: 'MAGENTO_TIMEOUT' });
  const unknown = Object.assign(Error('SENTINEL_PRIVATE_SQL'), { code: 'SENTINEL_PRIVATE_CODE', sql: 'SENTINEL_PRIVATE_QUERY' });
  const hostile = { get code() { throw Error('SENTINEL_CODE_GETTER'); } };
  for (const failure of [known, unknown, hostile, null]) {
    let calls = 0;
    await assert.rejects(measureLocalPhase(options, 'dispatch_admission', () => { calls++; throw failure; }), cause => cause === failure);
    assert.equal(calls, 1);
    await assert.rejects(measureLocalPhase(options, 'first_sync_commit', async () => { throw failure; }), cause => cause === failure);
  }
  assert.deepEqual(entries.map(entry => entry.value.code), ['MAGENTO_TIMEOUT', 'MAGENTO_TIMEOUT',
    ...Array(6).fill('LOCAL_OPERATION_FAILED')]);
  assert.doesNotMatch(JSON.stringify(entries), /SENTINEL|sql|message|stack/);
});

test('logger failure or unavailable metadata never changes local operation success, rejection or call count', async () => {
  const result = {}, failure = Error('Original operation failure');
  const loggers = [
    { info() { throw Error('Logger unavailable'); } },
    { info: async () => { throw Error('Logger unavailable'); } },
    { get info() { throw Error('Logger getter unavailable'); } },
  ];
  for (const logger of loggers) {
    let calls = 0;
    const options = { automatic: { productId: 12, publicIdentityId: '9', generation: '7' }, logger };
    assert.equal(await measureLocalPhase(options, 'finalization', () => { calls++; return result; }), result);
    await assert.rejects(measureLocalPhase(options, 'finalization', () => { calls++; throw failure; }), cause => cause === failure);
    assert.equal(calls, 2);
  }
  await new Promise(resolve => setImmediate(resolve));
  const options = { automatic: { productId: 12, publicIdentityId: '9', generation: '7' }, logger: loggers[0],
    get telemetryStage() { throw Error('Unavailable stage'); } };
  assert.equal(await measureLocalPhase(options, 'finalization', () => result), result);
});

test('manual, invalid and unknown local phases cannot inherit another product context into deep hooks', async () => {
  const entries = [], result = {}, logger = { info: (event, value) => entries.push({ event, value }) };
  const options = { automatic: { productId: 12, publicIdentityId: '9', generation: '7' }, logger };
  await measureLocalPhase(options, 'first_sync_enforce', async () => {
    for (const [input, phase] of [[{ logger }, 'first_sync_commit'],
      [{ logger, automatic: { productId: 12, publicIdentityId: 'SENTINEL_PRIVATE_ID', generation: '7' } }, 'first_sync_commit'],
      [options, 'SENTINEL_PRIVATE_PHASE']]) {
      assert.equal(await measureLocalPhase(input, phase, () => measureLocalPhase(null, 'retained_capture', () => result)), result);
    }
  });
  assert.deepEqual(entries.map(entry => entry.value.phase), ['first_sync_enforce']);
  assert.doesNotMatch(JSON.stringify(entries), /SENTINEL/);
});

test('local context coexists with transport collectors without changing HTTP arguments or counts', async () => {
  const entries = [], response = new Response('{}'), signal = new AbortController().signal;
  const request = { method: 'GET', signal, headers: { Authorization: 'SENTINEL_PRIVATE_AUTH' } };
  const url = 'https://fixture.invalid/rest/all/V1/products?sku=SENTINEL_PRIVATE_SKU'; let calls = 0;
  const options = { automatic: { productId: 12, publicIdentityId: '9', generation: '7' }, telemetryStage: 'apply',
    logger: { info: (event, value) => entries.push({ event, value }) },
    fetchImpl: async (actualUrl, actualRequest) => {
      calls++; assert.equal(actualUrl, url); assert.equal(actualRequest, request); return response;
    } };
  const actual = await measureLocalPhase(options, 'first_sync_enforce', () => measurePhase(options, 'observation', read =>
    measureLocalPhase(null, 'store_configs', () => read(url, request))));
  assert.equal(actual, response); assert.equal(calls, 1);
  const transport = entries.filter(entry => entry.event === 'magento.auto_sync.phase');
  assert.equal(transport.length, 1); assert.equal(transport[0].value.transportHeaders.count, 1);
  assert.equal(entries.filter(entry => entry.event === 'magento.auto_sync.local_phase').length, 2);
  assert.doesNotMatch(JSON.stringify(entries), /SENTINEL|Authorization|headers.*AUTH/);
});
