const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { refreshUsdRate, startCurrencyRefresh } = require('../src/services/currency-refresh-runtime');

const NOW = new Date('2026-10-13T08:00:00Z');
const rate = { rate: 41.25, rateDate: '2026-10-13' };
const config = { nbuRateOverride: null };
function fixture({ cache = null, state = null, held = true, saved = 1, clock = NOW, failQuery } = {}) {
  const client = new EventEmitter(), queries = [], releases = [], logs = [];
  let transaction = false, connects = 0;
  client.query = async command => {
    assert.ok(command.query_timeout > 0 && command.query_timeout <= 2000);
    const { text, values } = command;
    queries.push({ text, values });
    if (failQuery?.(text)) throw Error('Synthetic database failure');
    if (text.includes('pg_try_advisory_lock')) return { rows: [{ held }] };
    if (text.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (text.includes('clock_timestamp')) return { rows: [{ now: clock }] };
    if (text.startsWith('SELECT rate,')) return { rows: cache ? [cache] : [] };
    if (text.startsWith('SELECT last_attempt_at')) return { rows: state ? [state] : [] };
    if (text === 'BEGIN') transaction = true;
    if (text === 'ROLLBACK' || text === 'COMMIT') transaction = false;
    return { rows: [], rowCount: text.startsWith('INSERT INTO exchange_rate_cache(') ? saved : 1 };
  };
  client.release = broken => releases.push(broken);
  const databasePool = { connect: async () => { connects++; return client; } };
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (...args) => logs.push({ level, args })]));
  return { client, databasePool, logger, queries, releases, logs,
    get transaction() { return transaction; }, get connects() { return connects; } };
}
const work = (f, extra = {}) => refreshUsdRate({ databasePool: f.databasePool,
  logger: f.logger, now: () => NOW, fetchLive: async () => rate, ...extra });
const contains = (f, text) => f.queries.some(query => query.text.includes(text));

test('cold-start runtime immediately persists retry before HTTP and coalesces overlapping ticks', async () => {
  const f = fixture(); let resolveFetch, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const runtime = startCurrencyRefresh(config, f.logger, { databasePool: f.databasePool, now: () => NOW,
    fetchLive: ({ date }) => {
      assert.equal(date, '2026-10-13'); assert.equal(f.transaction, false);
      const attempt = f.queries.find(query => query.text.startsWith('INSERT INTO exchange_rate_refresh_state'));
      assert.ok(attempt); assert.equal(attempt.values[2].getTime() - attempt.values[1].getTime(), 900000);
      entered(); return new Promise(resolve => { resolveFetch = resolve; });
    } });
  try {
    const first = runtime.tick(); assert.equal(runtime.tick(), first);
    await started; assert.equal(f.connects, 1);
    resolveFetch(rate); assert.equal((await first).status, 'refreshed');
    assert.ok(contains(f, 'COMMIT')); assert.deepEqual(f.releases, [false]);
  } finally { await runtime.stop(); }
});

test('stop aborts and drains in-flight HTTP without opening a transaction or losing durable retry', { timeout: 1500 }, async () => {
  const f = fixture(); let entered, observedSignal;
  const started = new Promise(resolve => { entered = resolve; });
  const runtime = startCurrencyRefresh(config, f.logger, { databasePool: f.databasePool, now: () => NOW,
    fetchLive: ({ signal }) => new Promise((resolve, reject) => {
      observedSignal = signal; entered();
      signal.addEventListener('abort', () => reject(Object.assign(Error('Stopped'), { code: 'ABORT_ERR' })), { once: true });
    }) });
  await started;
  const start = performance.now(); await runtime.stop();
  assert.ok(performance.now() - start < 1000);
  assert.equal(observedSignal.aborted, true); assert.deepEqual(f.releases, [false]);
  assert.ok(contains(f, 'INSERT INTO exchange_rate_refresh_state'));
  assert.equal(contains(f, 'BEGIN'), false); assert.equal(contains(f, 'SET last_error='), false);
  assert.equal((await runtime.tick()).status, 'stopped'); assert.equal(f.connects, 1);
});

test('controlled override starts no background connection or synthetic cache write', async () => {
  const f = fixture();
  const runtime = startCurrencyRefresh({ nbuRateOverride: 40 }, f.logger, { databasePool: f.databasePool,
    fetchLive: () => { throw Error('Unexpected HTTP'); } });
  assert.equal((await runtime.tick()).status, 'override'); await runtime.stop();
  assert.equal(f.connects, 0); assert.deepEqual(f.queries, []);
});

test('before 04:00 Kyiv previous scheduled period remains current despite source rate date', async () => {
  const f = fixture({ cache: { rate: '41.250000', rate_date: '2026-10-09', fetched_at: '2026-10-12T01:00:00Z' } });
  const result = await work(f, { now: () => new Date('2026-10-13T00:59:59Z'),
    fetchLive: () => { throw Error('Unexpected HTTP'); } });
  assert.equal(result.status, 'current'); assert.equal(contains(f, 'INSERT'), false);
});

test('daily success crossing 04:00 uses actual completion clock and explicit current Kyiv date', async () => {
  const f = fixture(); const times = [new Date('2026-10-13T00:59:59Z'), new Date('2026-10-13T01:00:02Z')];
  const result = await work(f, { now: () => times.shift(), fetchLive: async ({ date }) => {
    assert.equal(date, '2026-10-13'); return rate;
  } });
  assert.equal(result.status, 'refreshed'); assert.equal(result.fetchedAt, '2026-10-13T01:00:02.000Z');
  const saved = f.queries.find(query => query.text.startsWith('INSERT INTO exchange_rate_cache('));
  assert.equal(saved.values[3].toISOString(), result.fetchedAt);
});

test('durable next attempt survives a new worker invocation even without cached rate', async () => {
  const f = fixture({ state: { next_attempt_at: '2026-10-13T08:15:00Z' } });
  const result = await work(f, { fetchLive: () => { throw Error('Unexpected HTTP'); } });
  assert.equal(result.status, 'deferred'); assert.equal(result.nextAttemptAt, '2026-10-13T08:15:00.000Z');
  assert.equal(contains(f, 'INSERT'), false);
});

test('future cached timestamp cannot cause false refresh success when monotonic upsert writes nothing', async () => {
  const f = fixture({ cache: { rate: '41', rate_date: '2026-10-13', fetched_at: '2026-10-14T08:00:00Z' }, saved: 0 });
  const result = await work(f);
  assert.deepEqual(result, { status: 'failed', code: 'NBU_RATE_CACHE_CHANGED' });
  assert.ok(contains(f, 'ROLLBACK')); assert.equal(contains(f, 'COMMIT'), false);
  assert.equal(contains(f, 'SET next_attempt_at=NULL'), false);
  assert.equal(f.queries.find(query => query.text.startsWith('UPDATE exchange_rate_refresh_state SET last_error')).values[1], 'NBU_RATE_CACHE_CHANGED');
  assert.equal(f.logs.some(log => log.args[0] === 'currency.refresh.succeeded'), false);
});

test('HTTP failure stores only a bounded code and preserves previous success unchanged', async () => {
  const f = fixture({ cache: { rate: '41', rate_date: '2026-10-12', fetched_at: '2026-10-12T01:00:00Z' } });
  const result = await work(f, { fetchLive: async () => { throw Error('private upstream payload must not be stored'); } });
  assert.deepEqual(result, { status: 'failed', code: 'NBU_RATE_REFRESH_FAILED' });
  assert.equal(contains(f, 'BEGIN'), false); assert.equal(contains(f, 'INSERT INTO exchange_rate_cache('), false);
  assert.doesNotMatch(JSON.stringify([f.queries, f.logs]), /private upstream/);
  assert.deepEqual(f.releases, [false]);
});

test('source date must be a real date no later than requested day', async t => {
  for (const rateDate of ['2026-02-30', '2026-10-14', null]) await t.test(String(rateDate), async () => {
    const f = fixture(); const result = await work(f, { fetchLive: async () => ({ ...rate, rateDate }) });
    assert.equal(result.code, 'ERR_INVALID_RATE_DATE'); assert.equal(contains(f, 'BEGIN'), false);
  });
});

test('production clock comes from PostgreSQL for both attempt and completion', async () => {
  const f = fixture(); const result = await work(f, { now: undefined });
  assert.equal(result.status, 'refreshed');
  assert.equal(f.queries.filter(query => query.text.includes('clock_timestamp')).length, 2);
});

test('backwards clock leaves durable retry and does not claim a success', async () => {
  const f = fixture(); const times = [NOW, new Date(NOW.getTime() - 1)];
  assert.equal((await work(f, { now: () => times.shift() })).status, 'stopped');
  assert.equal(contains(f, 'BEGIN'), false); assert.equal(contains(f, 'SET next_attempt_at=NULL'), false);
});

test('another scheduler owns the session lock: no rate read, attempt write or HTTP', async () => {
  const f = fixture({ held: false });
  assert.equal((await work(f, { fetchLive: () => { throw Error('Unexpected HTTP'); } })).status, 'busy');
  assert.equal(f.queries.length, 1); assert.deepEqual(f.releases, [false]);
});

test('unlock failure destroys the connection so a pooled session lock cannot leak', async () => {
  const f = fixture({ failQuery: text => text.includes('pg_advisory_unlock') });
  assert.equal((await work(f)).status, 'refreshed'); assert.deepEqual(f.releases, [true]);
});

test('ambiguous lock-acquisition failure destroys the connection', async () => {
  const f = fixture({ failQuery: text => text.includes('pg_try_advisory_lock') });
  await assert.rejects(work(f), /Synthetic database failure/); assert.deepEqual(f.releases, [true]);
});

test('invalid shorter retry interval cannot connect or fetch', async () => {
  const f = fixture(); await assert.rejects(work(f, { retryMs: 100 }), /Invalid refresh retry interval/);
  assert.equal(f.connects, 0);
});
