'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { performance } = require('node:perf_hooks');
const currency = require('../src/services/currency.service');
const { getRatePeriod, normalizeStrictRateDate } = require('../src/services/currency-rate-policy');

const NOW = new Date('2026-10-13T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const stored = (patch = {}) => ({ rate: '41.250000', rate_date: '2026-10-13',
  fetched_at: '2026-10-13T01:00:00.000Z', last_attempt_at: '2026-10-13T01:00:00.000Z',
  last_error: null, ...patch });

function reader(t, initial = stored()) {
  let row = initial;
  const queries = [];
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('Business rate reads must not call HTTP'));
  const request = t.mock.method(https, 'request', () => assert.fail('Business rate reads must not call HTTPS'));
  const databasePool = { async query(sql) {
    queries.push(sql);
    assert.match(sql, /^\s*SELECT\b/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|CALL|COPY)\b/i);
    assert.match(sql, /exchange_rate_cache/);
    assert.match(sql, /LEFT\s+JOIN\s+exchange_rate_refresh_state/i);
    assert.match(sql, /rate_date\s*::\s*text/i);
    return { rows: row ? [row] : [] };
  } };
  return { queries, databasePool, options: { databasePool, now: () => NOW, rateOverride: null },
    setRow(value) { row = value; },
    noHttp() { assert.equal(fetch.mock.callCount(), 0); assert.equal(request.mock.callCount(), 0); } };
}

test('100 concurrent business reads use the stored daily rate with no HTTP, cache writes or process-owned quote', async t => {
  const f = reader(t);
  const quotes = await Promise.all(Array.from({ length: 100 }, (_, i) => i % 2
    ? currency.getUsdUahRateInfo(f.options)
    : currency.observeUsdRate(f.options).then(result => { assert.equal(result.rateError, null); return result.rateInfo; })));
  for (const quote of quotes) {
    assert.equal(quote.rate, 41.25); assert.equal(quote.rateDate, '2026-10-13');
    assert.equal(quote.source, 'nbu'); assert.equal(quote.stale, false);
    assert.equal(quote.fetchedAt, '2026-10-13T01:00:00.000Z');
    assert.equal(quote.ageMs, 9 * 60 * 60 * 1000); assert.equal(quote.error, null);
  }
  assert.equal(f.queries.length, 100); f.noHttp();
  f.setRow(stored({ rate: '42.000000', fetched_at: '2026-10-13T09:59:00.000Z' }));
  assert.equal((await currency.getUsdUahRateInfo(f.options)).rate, 42, 'Later readers must see the current stored value');
  f.noHttp();
});

test('the daily refresh period changes exactly at 04:00 Kyiv across summer, winter and both DST transitions', () => {
  for (const [instant, period] of [
    ['2026-10-13T00:59:59.999Z', '2026-10-12'], ['2026-10-13T01:00:00.000Z', '2026-10-13'],
    ['2026-01-13T01:59:59.999Z', '2026-01-12'], ['2026-01-13T02:00:00.000Z', '2026-01-13'],
    ['2026-03-29T00:59:59.999Z', '2026-03-28'], ['2026-03-29T01:00:00.000Z', '2026-03-29'],
    ['2026-10-25T00:59:59.999Z', '2026-10-24'], ['2026-10-25T01:59:59.999Z', '2026-10-24'],
    ['2026-10-25T02:00:00.000Z', '2026-10-25'],
    ['2026-12-31T22:00:00.000Z', '2026-12-31'], ['2027-01-01T02:00:00.000Z', '2027-01-01'],
  ]) assert.equal(getRatePeriod(new Date(instant)), period, instant);
});

test('strict rate dates accept only real calendar dates rather than JavaScript date rollover', () => {
  for (const [value, expected] of [
    ['2026-10-13', '2026-10-13'], ['13.10.2026', '2026-10-13'],
    ['2024-02-29', '2024-02-29'], ['29.02.2024', '2024-02-29'],
  ]) assert.equal(normalizeStrictRateDate(value), expected);
  for (const value of [null, undefined, '', '2026-02-29', '29.02.2026', '2026-04-31', '2026-13-01',
    '2026-00-10', '2026-10-00', '2026-10-32', '2026-1-3', '2026-10-13T00:00:00Z', 'invalid']) {
    assert.equal(normalizeStrictRateDate(value), null, String(value));
  }
});

test('a previous cycle remains current before 04:00, then becomes explicit last-known-good without fetching', async t => {
  const f = reader(t, stored({ rate_date: '2026-10-12', fetched_at: '2026-10-12T01:00:00.000Z',
    last_attempt_at: '2026-10-12T01:00:00.000Z' }));
  const before = await currency.getUsdUahRateInfo({ ...f.options, now: () => new Date('2026-10-13T00:59:59.999Z') });
  assert.equal(before.source, 'nbu'); assert.equal(before.stale, false);
  const after = await currency.getUsdUahRateInfo({ ...f.options, now: () => new Date('2026-10-13T01:00:00.000Z') });
  assert.equal(after.rate, before.rate); assert.equal(after.source, 'last_known_good'); assert.equal(after.stale, true);
  assert.equal(typeof after.error, 'string'); assert.ok(after.error.length > 0); f.noHttp();
});

test('a successfully fetched weekend rate is current even when the NBU rate date is Friday', async t => {
  const f = reader(t, stored({ rate_date: '2026-10-09', fetched_at: '2026-10-11T01:00:00.000Z',
    last_attempt_at: '2026-10-11T01:00:00.000Z' }));
  const rate = await currency.getUsdUahRateInfo({ ...f.options, now: () => new Date('2026-10-11T10:00:00.000Z') });
  assert.equal(rate.rateDate, '2026-10-09'); assert.equal(rate.source, 'nbu'); assert.equal(rate.stale, false); f.noHttp();
});

test('an unsuccessful refresh retains the exact quote with overdue source, age and failure metadata', async t => {
  const f = reader(t, stored({ rate_date: '2026-10-12', fetched_at: '2026-10-12T01:00:00.000Z',
    last_attempt_at: '2026-10-13T01:00:00.000Z', last_error: 'NBU HTTP 503' }));
  const result = await currency.observeUsdRate(f.options);
  assert.equal(result.rateError, null); assert.equal(result.rateInfo.rate, 41.25);
  assert.equal(result.rateInfo.source, 'last_known_good'); assert.equal(result.rateInfo.stale, true);
  assert.equal(result.rateInfo.ageMs, DAY + 9 * 60 * 60 * 1000); assert.match(result.rateInfo.error, /503/); f.noHttp();
});

test('missing stored rate fails closed for required pricing and remains a nullable observation for optional callers', async t => {
  const f = reader(t, null);
  await assert.rejects(currency.getUsdUahRateInfo(f.options), { code: 'ERR_RATE_UNAVAILABLE' });
  const observation = await currency.observeUsdRate(f.options);
  assert.equal(observation.rateInfo, null); assert.equal(typeof observation.rateError, 'string');
  assert.ok(observation.rateError.length > 0); assert.equal(f.queries.length, 2); f.noHttp();
});

test('seven-day maximum age is inclusive and older stored rates fail without a live fallback', async t => {
  const f = reader(t, stored({ rate_date: '2026-10-06', fetched_at: '2026-10-06T10:00:00.000Z' }));
  const atLimit = await currency.getUsdUahRateInfo(f.options);
  assert.equal(atLimit.ageMs, 7 * DAY); assert.equal(atLimit.stale, true);
  const options = { ...f.options, now: () => new Date(NOW.getTime() + 1) };
  await assert.rejects(currency.getUsdUahRateInfo(options), { code: 'ERR_RATE_TOO_OLD' });
  assert.equal((await currency.observeUsdRate(options)).rateInfo, null); f.noHttp();
});

test('invalid, malformed and future database rate evidence is never accepted as current or last-known-good', async t => {
  for (const [label, patch] of [
    ['zero', { rate: 0 }], ['negative', { rate: '-1' }], ['NaN', { rate: 'NaN' }],
    ['infinite', { rate: Infinity }], ['missing rate', { rate: null }], ['malformed rate', { rate: 'forty' }],
    ['missing rate date', { rate_date: null }], ['invalid calendar date', { rate_date: '2026-02-29' }],
    ['future rate date', { rate_date: '2026-10-14' }],
    ['missing fetched time', { fetched_at: null }], ['invalid fetched time', { fetched_at: 'invalid' }],
    ['future fetched time', { fetched_at: '2026-10-13T10:00:00.001Z' }],
  ]) await t.test(label, async sub => {
    const f = reader(sub, stored(patch));
    await assert.rejects(currency.getUsdUahRateInfo(f.options), { code: 'ERR_RATE_UNAVAILABLE' });
    const result = await currency.observeUsdRate(f.options);
    assert.equal(result.rateInfo, null); assert.ok(result.rateError); f.noHttp();
  });
});

test('database failure is not replaced with an old process quote or a business-request HTTP fetch', async t => {
  const f = reader(t); const prior = await currency.observeUsdRate(f.options);
  assert.equal(prior.rateInfo.rate, 41.25);
  const databasePool = { query: async () => { throw Object.assign(Error('database unavailable'), { code: '08006' }); } };
  const failed = await currency.observeUsdRate({ ...f.options, databasePool });
  assert.equal(failed.rateInfo, null); assert.ok(failed.rateError); assert.equal(prior.rateInfo.rate, 41.25); f.noHttp();
});

test('an issued rate observation remains unchanged across a later stored refresh and is revalidated by its own age', async t => {
  const row = stored(), f = reader(t, row), first = await currency.observeUsdRate(f.options);
  const snapshot = structuredClone(first);
  row.rate = '50'; row.rate_date = '2026-10-14'; row.fetched_at = '2026-10-14T01:00:00.000Z';
  const second = await currency.observeUsdRate({ ...f.options, now: () => new Date('2026-10-14T10:00:00.000Z') });
  assert.equal(second.rateInfo.rate, 50); assert.equal(second.rateInfo.stale, false);
  assert.deepEqual(first, snapshot); assert.equal(first.rateInfo.stale, false);
  assert.doesNotThrow(() => currency.assertUsdRateObservationCurrent(first, new Date('2026-10-20T01:00:00.000Z')));
  assert.throws(() => currency.assertUsdRateObservationCurrent(first, new Date('2026-10-20T01:00:00.001Z')),
    { code: 'ERR_RATE_TOO_OLD' });
  assert.equal(f.queries.length, 2, 'Observation validation must not replace its captured quote'); f.noHttp();
});

test('an explicit deterministic override does not read the database or call HTTP', async t => {
  const f = reader(t, null);
  const info = await currency.getUsdUahRateInfo({ ...f.options, rateOverride: 40 });
  assert.equal(info.rate, 40); assert.equal(info.stale, false); assert.equal(info.fetchedAt, NOW.toISOString());
  const observation = await currency.observeUsdRate({ ...f.options, rateOverride: 40 });
  assert.equal(observation.rateInfo.rate, 40); assert.equal(observation.rateError, null);
  assert.equal(f.queries.length, 0); f.noHttp();
});

test('a previously issued observation cannot bypass timestamp validation through its stale flag', () => {
  for (const stale of [false, true]) {
    for (const fetchedAt of ['invalid', '2026-10-13T10:00:00.001Z']) {
      assert.throws(() => currency.assertUsdRateObservationCurrent({ rateInfo: {
        rate: 40, rateDate: '2026-10-13', fetchedAt, stale, source: stale ? 'last_known_good' : 'nbu',
      } }, NOW), { code: 'ERR_RATE_UNAVAILABLE' });
    }
  }
});

test('rate validation uses the clock after SELECT so a refresh committed during the read is accepted', async t => {
  const f = reader(t);
  let clock = new Date('2026-10-13T10:00:00.000Z'), queryFinished = false;
  const databasePool = { async query(sql) {
    await f.databasePool.query(sql);
    clock = new Date('2026-10-13T10:00:02.000Z'); queryFinished = true;
    return { rows: [stored({ fetched_at: '2026-10-13T10:00:01.000Z' })] };
  } };
  const rate = await currency.getUsdUahRateInfo({ databasePool, rateOverride: null, now: () => {
    assert.equal(queryFinished, true, 'The clock must be captured after the rate SELECT resolves'); return clock;
  } });
  assert.equal(rate.rate, 41.25); assert.equal(rate.ageMs, 1000); assert.equal(rate.stale, false); f.noHttp();
});

test('the production reader validates against SQL observed_at rather than the application wall clock', async t => {
  const f = reader(t, stored({ fetched_at: '2024-07-01T01:00:00.000Z', rate_date: '2024-07-01',
    observed_at: '2024-07-01T01:00:02.000Z' }));
  const rate = await currency.getUsdUahRateInfo({ databasePool: f.databasePool, rateOverride: null });
  assert.equal(rate.ageMs, 2000); assert.equal(rate.rateDate, '2024-07-01'); assert.equal(rate.stale, false);
  assert.match(f.queries[0], /clock_timestamp\(\)\s+AS\s+observed_at/i);
  f.setRow(stored({ fetched_at: '2024-07-01T01:00:02.001Z', rate_date: '2024-07-01',
    observed_at: '2024-07-01T01:00:02.000Z' }));
  await assert.rejects(currency.getUsdUahRateInfo({ databasePool: f.databasePool, rateOverride: null }),
    { code: 'ERR_RATE_UNAVAILABLE' });
  f.noHttp();
});

function processClock(t) {
  const clock = { wall: NOW.getTime(), monotonic: 1000 };
  t.mock.method(Date, 'now', () => clock.wall);
  t.mock.method(performance, 'now', () => clock.monotonic);
  return clock;
}

test('trusted snapshots expire by elapsed age despite fixed DB/host skew and subsequent wall-clock rollback', async t => {
  for (const skew of [-60_000, 60_000]) await t.test(`DB offset ${skew}ms`, async sub => {
    const clock = processClock(sub), observedAt = new Date(NOW.getTime() + skew);
    const fetchedAt = new Date(observedAt.getTime() - 7 * DAY + 1000);
    const f = reader(sub, stored({ fetched_at: fetchedAt.toISOString(), rate_date: '2026-10-06', observed_at: observedAt }));
    const observation = await currency.observeUsdRate({ databasePool: f.databasePool, rateOverride: null });
    assert.equal(observation.rateError, null);
    const original = structuredClone(observation);
    clock.wall -= DAY; clock.monotonic += 1000;
    assert.doesNotThrow(() => currency.assertUsdRateObservationCurrent(observation), 'Inclusive bound uses DB age plus elapsed time');
    clock.monotonic += 1;
    assert.throws(() => currency.assertUsdRateObservationCurrent(observation), { code: 'ERR_RATE_TOO_OLD' });
    assert.throws(() => currency.assertUsdRateObservationCurrent(observation, observedAt),
      { code: 'ERR_RATE_TOO_OLD' }, 'An explicit earlier clock cannot extend the proven lifetime');
    assert.deepEqual(observation, original, 'Validation never renews or changes captured evidence');
    assert.equal(f.queries.length, 1); f.noHttp();
  });
});

test('response delay and a forward wall jump consume the existing lifetime rather than grant a grace period', async t => {
  const clock = processClock(t), observedAt = new Date(NOW.getTime() + 60_000);
  const f = reader(t, stored({ fetched_at: new Date(observedAt.getTime() - 7 * DAY + 1000).toISOString(),
    rate_date: '2026-10-06', observed_at: observedAt }));
  const databasePool = { async query(sql) {
    const result = await f.databasePool.query(sql);
    clock.monotonic += 400; clock.wall += 400;
    return result;
  } };
  const observation = await currency.observeUsdRate({ databasePool, rateOverride: null });
  assert.equal(observation.rateError, null);
  clock.wall += 600;
  assert.doesNotThrow(() => currency.assertUsdRateObservationCurrent(observation));
  clock.wall += 1; // Wall time also covers a suspend where monotonic time did not advance.
  assert.throws(() => currency.assertUsdRateObservationCurrent(observation), { code: 'ERR_RATE_TOO_OLD' });
  clock.wall = NOW.getTime(); clock.monotonic += 1;
  assert.throws(() => currency.assertUsdRateObservationCurrent(observation),
    { code: 'ERR_RATE_TOO_OLD' }, 'A wall correction cannot revive an expired observation');
  assert.equal(f.queries.length, 1); f.noHttp();
});

test('a previously checked forward wall jump remains part of age after the wall clock rolls back', async t => {
  const clock = processClock(t), observedAt = new Date(NOW.getTime() + 60_000);
  const f = reader(t, stored({ fetched_at: new Date(observedAt.getTime() - 7 * DAY + 1000).toISOString(),
    rate_date: '2026-10-06', observed_at: observedAt }));
  const observation = await currency.observeUsdRate({ databasePool: f.databasePool, rateOverride: null });
  clock.wall += 600;
  assert.doesNotThrow(() => currency.assertUsdRateObservationCurrent(observation));
  clock.wall = NOW.getTime(); clock.monotonic += 400;
  assert.doesNotThrow(() => currency.assertUsdRateObservationCurrent(observation));
  clock.monotonic += 1;
  assert.throws(() => currency.assertUsdRateObservationCurrent(observation), { code: 'ERR_RATE_TOO_OLD' });
  f.noHttp();
});

test('mutating any captured scalar invalidates private clock evidence', async t => {
  const changes = { rate: 99, rateDate: '2026-10-12', fetchedAt: '2026-10-13T10:00:00.000Z',
    source: 'last_known_good', stale: true, ageMs: 0, error: 'forged' };
  for (const [field, value] of Object.entries(changes)) await t.test(field, async sub => {
    processClock(sub);
    const f = reader(sub);
    const observation = await currency.observeUsdRate(f.options);
    observation.rateInfo[field] = value;
    assert.throws(() => currency.assertUsdRateObservationCurrent(observation), { code: 'ERR_RATE_UNAVAILABLE' });
    f.noHttp();
  });
});

test('clones and public clock or age fields cannot forge a proof or bypass future/expiry checks', async t => {
  processClock(t);
  const f = reader(t, stored({ fetched_at: '2026-10-13T10:00:01.000Z', observed_at: '2026-10-13T10:00:01.100Z' }));
  const observation = await currency.observeUsdRate({ databasePool: f.databasePool, rateOverride: null });
  assert.equal(observation.rateError, null);
  assert.doesNotThrow(() => currency.assertUsdRateObservationCurrent(observation));
  for (const rateInfo of [{ ...observation.rateInfo }, JSON.parse(JSON.stringify(observation.rateInfo))]) {
    rateInfo.ageMs = 0; rateInfo.observedAt = '2026-10-13T10:00:01.100Z';
    assert.throws(() => currency.assertUsdRateObservationCurrent({ rateInfo }, NOW), { code: 'ERR_RATE_UNAVAILABLE' });
  }
  assert.throws(() => currency.assertUsdRateObservationCurrent({ rateInfo: { ...observation.rateInfo,
    fetchedAt: '2026-10-06T09:59:59.999Z', ageMs: 0, stale: false, observedAt: NOW.toISOString(),
  } }, NOW), { code: 'ERR_RATE_TOO_OLD' });
  assert.throws(() => currency.assertUsdRateObservationCurrent(observation, NOW),
    { code: 'ERR_RATE_UNAVAILABLE' }, 'An explicit clock preserves the original absolute future guard');
  f.noHttp();
});

test('accessors and inherited fields cannot impersonate the sealed snapshot during validation', async t => {
  for (const field of ['rate', 'rateDate', 'fetchedAt', 'source', 'stale', 'ageMs', 'error']) {
    await t.test(field, async sub => {
      processClock(sub); const f = reader(sub);
      const observation = await currency.observeUsdRate(f.options), value = observation.rateInfo[field];
      let reads = 0;
      Object.defineProperty(observation.rateInfo, field, { get() { reads += 1; return value; }, configurable: true });
      assert.throws(() => currency.assertUsdRateObservationCurrent(observation), { code: 'ERR_RATE_UNAVAILABLE' });
      assert.equal(reads, 0, 'Proof validation must inspect data descriptors without executing accessors');
      delete observation.rateInfo[field];
      Object.setPrototypeOf(observation.rateInfo, { [field]: value });
      assert.throws(() => currency.assertUsdRateObservationCurrent(observation), { code: 'ERR_RATE_UNAVAILABLE' });
      f.noHttp();
    });
  }
});

test('invalid clock evidence fails closed without falling back to a host timestamp', async t => {
  for (const observed_at of [undefined, null, 'invalid']) await t.test(String(observed_at), async sub => {
    const f = reader(sub, stored({ observed_at }));
    await assert.rejects(currency.getUsdUahRateInfo({ databasePool: f.databasePool, rateOverride: null }),
      { code: 'ERR_RATE_UNAVAILABLE' }); f.noHttp();
  });
  for (const invalidClock of ['backwards', 'nonfinite monotonic', 'nonfinite wall']) await t.test(invalidClock, async sub => {
    const clock = processClock(sub), f = reader(sub);
    const observation = await currency.observeUsdRate(f.options);
    if (invalidClock === 'backwards') clock.monotonic -= 1;
    if (invalidClock === 'nonfinite monotonic') clock.monotonic = NaN;
    if (invalidClock === 'nonfinite wall') clock.wall = NaN;
    assert.throws(() => currency.assertUsdRateObservationCurrent(observation), { code: 'ERR_RATE_UNAVAILABLE' });
    f.noHttp();
  });
});
