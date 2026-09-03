const assert = require('node:assert/strict');
const test = require('node:test');

const { createUsdRateProvider, normalizeRateDate } = require('../src/services/currency.service');

const NOW = new Date('2026-08-31T10:00:00.000Z');

test('NBU date format is normalized for PostgreSQL and daily caching', () => {
  assert.equal(normalizeRateDate('31.08.2026'), '2026-08-31');
  assert.equal(normalizeRateDate('2026-08-31'), '2026-08-31');
});

test('rate provider fails explicitly when NBU and fallback are unavailable', async () => {
  const provider = createUsdRateProvider({
    fetchLive: async () => { throw new Error('NBU unavailable'); },
    now: () => NOW,
  });
  await assert.rejects(provider.getRateInfo(), /NBU unavailable/);
});

test('rate provider rejects invalid NBU payload', async () => {
  const provider = createUsdRateProvider({
    fetchLive: async () => ({ rate: 0 }),
    now: () => NOW,
  });
  await assert.rejects(provider.getRateInfo(), (error) => error.code === 'ERR_INVALID_RATE');
});

test('rate provider returns timestamped last-known-good fallback', async () => {
  const provider = createUsdRateProvider({
    fetchLive: async () => { throw new Error('HTTP 503'); },
    loadLastKnown: async () => ({
      rate: '41.250000',
      rate_date: '2026-08-30',
      fetched_at: '2026-08-30T10:00:00.000Z',
    }),
    now: () => NOW,
  });
  const result = await provider.getRateInfo();
  assert.equal(result.rate, 41.25);
  assert.equal(result.source, 'last_known_good');
  assert.equal(result.stale, true);
  assert.equal(result.ageMs, 24 * 60 * 60 * 1000);
  assert.equal(result.fetchedAt, '2026-08-30T10:00:00.000Z');
  assert.match(result.error, /HTTP 503/);
});

test('rate provider deduplicates concurrent live requests and caches the result', async () => {
  let calls = 0;
  let release;
  const live = new Promise((resolve) => { release = resolve; });
  const provider = createUsdRateProvider({
    fetchLive: async () => {
      calls += 1;
      return live;
    },
    now: () => NOW,
  });

  const first = provider.getRateInfo();
  const second = provider.getRateInfo();
  release({ rate: 42, rateDate: '2026-08-31', fetchedAt: NOW.toISOString() });
  const [a, b] = await Promise.all([first, second]);
  const third = await provider.getRateInfo();

  assert.equal(calls, 1);
  assert.equal(a.rate, 42);
  assert.equal(b.rate, 42);
  assert.equal(third.rate, 42);
});

test('rate provider rejects fallback older than configured maximum age', async () => {
  const provider = createUsdRateProvider({
    fetchLive: async () => { throw new Error('timeout'); },
    loadLastKnown: async () => ({
      rate: 40,
      rate_date: '2026-08-01',
      fetched_at: '2026-08-01T10:00:00.000Z',
    }),
    now: () => NOW,
    maxStaleMs: 2 * 24 * 60 * 60 * 1000,
  });
  await assert.rejects(provider.getRateInfo(), (error) => error.code === 'ERR_RATE_TOO_OLD');
});
