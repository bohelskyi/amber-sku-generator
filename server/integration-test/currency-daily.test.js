require('../test/setup-env');
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { Pool, pool: controlPool, recreateTestDatabase, dropTestDatabase } = require('./harness');
const { insertProductFixture } = require('./product-fixture');
const currency = require('../src/services/currency.service');
const { startCurrencyRefresh, refreshUsdRate } = require('../src/services/currency-refresh-runtime');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const config = { nbuRateOverride: null };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Actual PostgreSQL connections, real advisory lock and committed retry state;
// only NBU responses and the clock are synthetic. No business HTTP is permitted.
test('persisted daily currency refresh is shared, restart-safe and isolated from business writes', async t => {
  const name = `amber_currency_daily_${process.pid}_test`;
  const url = await recreateTestDatabase(name, { template: true });
  const db = new Pool({ connectionString: url, max: 3 });
  const workerA = new Pool({ connectionString: url, max: 1, application_name: 'currency_worker_a' });
  const workerB = new Pool({ connectionString: url, max: 1, application_name: 'currency_worker_b' });
  const active = new Set();
  let timestamp = Date.parse('2026-01-10T02:00:00Z'); // Saturday, 04:00 Kyiv.
  const now = () => new Date(timestamp);
  const warnings = [];
  const logger = { info() {}, warn: (...args) => warnings.push(args), error() {} };
  const start = (databasePool, fetchLive) => {
    const runtime = startCurrencyRefresh(config, logger, { databasePool, fetchLive, now });
    active.add(runtime);
    return runtime;
  };
  const stop = async runtime => { await runtime.stop(); active.delete(runtime); };
  const reset = async () => {
    timestamp = Date.parse('2026-01-10T02:00:00Z');
    warnings.length = 0;
    await db.query('DELETE FROM exchange_rate_refresh_state');
    await db.query('DELETE FROM exchange_rate_cache');
  };
  const seed = async (fetchedAt, rateDate = '2026-01-09', rate = 40) => db.query(
    `INSERT INTO exchange_rate_cache(currency_pair,rate,rate_date,fetched_at) VALUES('USD_UAH',$1,$2,$3)`,
    [rate, rateDate, new Date(fetchedAt)]);
  const cache = async () => (await db.query('SELECT * FROM exchange_rate_cache ORDER BY currency_pair')).rows;
  const state = async () => (await db.query('SELECT * FROM exchange_rate_refresh_state ORDER BY currency_pair')).rows[0];
  const read = () => currency.getUsdUahRateInfo({ databasePool: db, now, rateOverride: null });
  const business = async () => {
    const tables = (await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND tablename NOT IN ('exchange_rate_cache','exchange_rate_refresh_state') ORDER BY tablename`)).rows;
    const rows = {};
    for (const { tablename } of tables) {
      assert.match(tablename, /^[a-z][a-z0-9_]*$/);
      rows[tablename] = (await db.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS data FROM "${tablename}" t`)).rows[0].data;
    }
    return rows;
  };
  try {
    await db.query("INSERT INTO categories(code,name) VALUES('NM','Currency test necklace')");
    const product = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,weight,total_price_uah,details)
      VALUES('NM-DAILY-RATE','NM',5,1234.56,'{"answers":{},"manualPriceUah":1234.56}') RETURNING *`)).rows[0];
    assert.equal(Number(product.total_price_uah), 1234.56);
    const beforeBusiness = await business();
    const nbuHttp = t.mock.method(https, 'request', () => assert.fail('daily currency tests must not call live NBU'));
    const remoteHttp = t.mock.method(globalThis, 'fetch', () => assert.fail('business rate reads must not dispatch HTTP'));

    await t.test('cold readers fail closed with SELECT only and never initiate refresh', async () => {
      await reset();
      let selects = 0;
      const readOnly = { query: (sql, values) => {
        assert.match(typeof sql === 'string' ? sql : sql.text, /^\s*SELECT\b/i);
        selects++;
        return db.query(sql, values);
      } };
      const options = { databasePool: readOnly, rateOverride: null, now };
      await assert.rejects(currency.getUsdUahRateInfo(options), { code: 'ERR_RATE_UNAVAILABLE' });
      const observed = await currency.observeUsdRate(options);
      assert.equal(observed.rateInfo, null);
      assert.match(observed.rateError, /unavailable/i);
      assert.equal(selects, 2);
      assert.deepEqual(await cache(), []);
      assert.equal(await state(), undefined);
    });

    await t.test('two independent workers fetch once, hold no transaction over HTTP and cold-start cache atomically', async () => {
      await reset();
      const entered = deferred(), release = deferred();
      let calls = 0;
      const fetchLive = async ({ date, signal }) => {
        calls++;
        assert.equal(date, '2026-01-10');
        assert.equal(signal.aborted, false);
        entered.resolve();
        await release.promise;
        return { rate: 42.125, rateDate: '2026-01-09' }; // Friday is valid on Saturday.
      };
      const a = start(workerA, fetchLive), first = a.tick();
      let b;
      try {
        await entered.promise;
        b = start(workerB, fetchLive);
        assert.equal((await b.tick()).status, 'busy');
        const connections = (await db.query(`SELECT pid,application_name,state,xact_start FROM pg_stat_activity
          WHERE datname=current_database() AND application_name IN ('currency_worker_a','currency_worker_b') ORDER BY application_name`)).rows;
        assert.equal(connections.length, 2);
        assert.notEqual(connections[0].pid, connections[1].pid);
        assert.ok(connections.every(row => row.xact_start === null && row.state === 'idle'));
        assert.equal((await state()).next_attempt_at.toISOString(), '2026-01-10T02:15:00.000Z');
        assert.deepEqual(await cache(), []);
        assert.equal(calls, 1);
      } finally { release.resolve(); }
      assert.equal((await first).status, 'refreshed');
      assert.equal((await b.tick()).status, 'current');
      assert.equal(calls, 1);
      const current = await read();
      assert.equal(current.rate, 42.125);
      assert.equal(current.rateDate, '2026-01-09');
      assert.equal(current.fetchedAt, now().toISOString());
      assert.equal(current.stale, false);
      assert.equal(current.error, null);
      assert.equal((await state()).next_attempt_at, null);
      assert.equal((await state()).last_error, null);
      const before = await cache();
      const observations = await Promise.all(Array.from({ length: 30 }, () => currency.observeUsdRate({ databasePool: db, now, rateOverride: null })));
      assert.ok(observations.every(row => row.rateInfo.rate === 42.125 && row.rateError === null));
      assert.deepEqual(await cache(), before);
      await stop(a); await stop(b);
      assert.equal((await a.tick()).status, 'stopped');
      assert.equal((await workerA.query('SELECT 1 AS value')).rows[0].value, 1); // Caller still owns pool.
    });

    await t.test('failed fetch preserves last success and durable backoff survives runtime restart', async () => {
      await reset();
      await seed(timestamp - DAY);
      const original = await cache();
      let calls = 0;
      const fail = async () => { calls++; throw Object.assign(new Error('synthetic private upstream error'), { code: 'ETIMEDOUT' }); };
      const a = start(workerA, fail);
      assert.deepEqual(await a.tick(), { status: 'failed', code: 'ETIMEDOUT' });
      await stop(a);
      assert.deepEqual(await cache(), original);
      assert.equal((await state()).last_error, 'ETIMEDOUT');
      const fallback = await read();
      assert.equal(fallback.rate, 40);
      assert.equal(fallback.stale, true);
      assert.equal(fallback.source, 'last_known_good');
      assert.equal(fallback.error, 'ETIMEDOUT');
      assert.equal(warnings.length, 1);
      assert.ok(!JSON.stringify(warnings).includes('private upstream'));
      const oldObservation = await currency.observeUsdRate({ databasePool: db, now, rateOverride: null });
      const captured = structuredClone(oldObservation);
      const b = start(workerB, async () => { calls++; return { rate: 43, rateDate: '2026-01-10' }; });
      assert.equal((await b.tick()).status, 'deferred');
      timestamp += 15 * MINUTE - 1;
      assert.equal((await b.tick()).status, 'deferred');
      assert.equal(calls, 1);
      timestamp++;
      assert.equal((await b.tick()).status, 'refreshed');
      assert.equal(calls, 2);
      assert.equal((await read()).rate, 43);
      assert.equal((await state()).next_attempt_at, null);
      assert.equal((await state()).last_error, null);
      assert.deepEqual(oldObservation, captured); // A captured business calculation is never rewritten by refresh.
      await stop(b);
    });

    await t.test('a queued reader uses the database observation clock after a concurrent cache publication', async () => {
      await reset();
      const held = await workerA.connect();
      const requestedAt = Date.now();
      const pending = currency.getUsdUahRateInfo({ databasePool: workerA, rateOverride: null });
      assert.equal(workerA.waitingCount, 1);
      let row;
      try {
        // Independent publisher commits after the reader requested a connection.
        await db.query('SELECT pg_sleep(0.01)');
        row = (await db.query(`INSERT INTO exchange_rate_cache(currency_pair,rate,rate_date,fetched_at)
          VALUES('USD_UAH',44,(clock_timestamp() AT TIME ZONE 'Europe/Kyiv')::date,clock_timestamp()) RETURNING *`)).rows[0];
        assert.ok(row.fetched_at.getTime() > requestedAt);
      } finally { held.release(); }
      const result = await pending;
      assert.equal(result.rate, 44);
      assert.equal(result.fetchedAt, row.fetched_at.toISOString());
      assert.equal(result.stale, false);
      assert.ok(result.ageMs >= 0);
      assert.equal(result.error, null);
    });

    for (const { offsetMs, ageMs, label } of [
      { offsetMs: -MINUTE, ageMs: 0, label: '60 seconds behind PostgreSQL with a fresh quote' },
      { offsetMs: MINUTE, ageMs: 7 * DAY - 30_000, label: '60 seconds ahead of PostgreSQL near hard expiry' },
    ]) await t.test(`real pricing accepts DB-proven currency when the application clock is ${label}`, async () => {
      await reset();
      const stored = (await db.query(`WITH captured AS (SELECT clock_timestamp() AS observed_at)
        INSERT INTO exchange_rate_cache(currency_pair,rate,rate_date,fetched_at)
        SELECT 'USD_UAH',42,((observed_at-($1::bigint*INTERVAL '1 millisecond')) AT TIME ZONE 'Europe/Kyiv')::date,
          observed_at-($1::bigint*INTERVAL '1 millisecond') FROM captured RETURNING *`, [ageMs])).rows[0];
      const databaseClock = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
      const before = await cache(), RealDate = Date;
      const skew = databaseClock - RealDate.now() + offsetMs;
      const context = { categoryCode: 'NM', category: { requires_weight: 1, marketing_rounding_enabled: 0 },
        scenarios: [{ id: 1, category_code: 'NM', name: 'Clock fixture', match_json: {}, axis_x_key: null,
          axis_y_key: null, price_mode: 'per_gram_usd', status: 'active', apply_modifiers: false }],
        matrixByCell: new Map([['1:0:0', { price: '2' }]]), weightBandsByScenario: new Map(), modifiers: [] };
      // Only the application's wall clock is shifted. PostgreSQL and both
      // pricing services stay real; no reader clock or rate service is injected.
      globalThis.Date = class OffsetDate extends RealDate {
        constructor(...args) { super(...(args.length ? args : [RealDate.now() + skew])); }
        static now() { return RealDate.now() + skew; }
      };
      try {
        const observation = await currency.observeUsdRate({ databasePool: db, rateOverride: null });
        assert.equal(observation.rateError, null);
        assert.equal(observation.rateInfo.rate, 42);
        assert.equal(observation.rateInfo.fetchedAt, stored.fetched_at.toISOString());
        if (ageMs > 0) assert.equal(observation.rateInfo.stale, true);
        // A newly fetched quote may cross the daily 04:00 boundary during SELECT;
        // both pricing callers must preserve its actual DB-derived metadata.
        const apparentAge = Date.now() - stored.fetched_at.getTime();
        assert.ok(offsetMs < 0 ? apparentAge < 0 : apparentAge > 7 * DAY,
          'The fixture must reproduce the invalid result of comparing DB time with application wall time');
        const captured = structuredClone(observation);
        const automatic = await require('../src/services/pricing.service').calculatePricing('NM', {}, 5, 0,
          { queryable: db, context, rateObservation: observation });
        const decision = await require('../src/services/product/correction-pricing-decision').calculateDecisionPricing(
          { mode: 'usd_per_gram', usdPerGram: 2, marketingRoundingEnabled: false }, 5, null, observation, db);
        for (const result of [automatic, decision]) {
          assert.equal(result.currencyPayload.uahRate, 42);
          assert.equal(result.currencyPayload.totalPriceUah, 420);
          assert.equal(result.currencyPayload.uahRateFetchedAt, stored.fetched_at.toISOString());
          assert.equal(result.currencyPayload.uahRateStale, observation.rateInfo.stale);
        }
        assert.deepEqual(observation, captured);
      } finally { globalThis.Date = RealDate; }
      assert.deepEqual(await cache(), before);
    });

    await t.test('seven-day hard expiry remains, including a formerly fresh observation waiting for use', async () => {
      await reset();
      await seed(timestamp - 7 * DAY, '2026-01-03');
      const atLimit = await read();
      assert.equal(atLimit.stale, true);
      assert.equal(atLimit.ageMs, 7 * DAY);
      timestamp++;
      await assert.rejects(read(), { code: 'ERR_RATE_TOO_OLD' });
      assert.throws(() => currency.assertUsdRateObservationCurrent({ rateInfo: { ...atLimit, stale: false } }, now()), { code: 'ERR_RATE_TOO_OLD' });
      const before = await cache();
      const result = await refreshUsdRate({ databasePool: workerA, now, fetchLive: async () => { throw new Error('offline'); } });
      assert.equal(result.status, 'failed');
      assert.deepEqual(await cache(), before);
      assert.equal((await currency.observeUsdRate({ databasePool: db, now, rateOverride: null })).rateInfo, null);
    });

    await t.test('future effective dates are rejected and a fresh valid fetch repairs them', async () => {
      await reset();
      await seed(timestamp, '2026-01-11');
      await assert.rejects(read(), { code: 'ERR_RATE_UNAVAILABLE' });
      let calls = 0;
      const result = await refreshUsdRate({ databasePool: workerA, now, fetchLive: async () => { calls++; return { rate: 41, rateDate: '2026-01-10' }; } });
      assert.equal(result.status, 'refreshed');
      assert.equal(calls, 1);
      assert.equal((await read()).rateDate, '2026-01-10');
      await assert.rejects(db.query("UPDATE exchange_rate_cache SET rate_date='2026-02-30'"), { code: '22008' });
    });

    await t.test('future fetched timestamp cannot be overwritten or reported as successful refresh', async () => {
      await reset();
      await seed(timestamp + MINUTE, '2026-01-10');
      const original = await cache();
      await assert.rejects(read(), { code: 'ERR_RATE_UNAVAILABLE' });
      const result = await refreshUsdRate({ databasePool: workerA, now, fetchLive: async () => ({ rate: 41, rateDate: '2026-01-10' }) });
      assert.deepEqual(result, { status: 'failed', code: 'NBU_RATE_CACHE_CHANGED' });
      assert.deepEqual(await cache(), original);
      assert.equal((await state()).last_error, 'NBU_RATE_CACHE_CHANGED');
      assert.equal((await state()).next_attempt_at.toISOString(), '2026-01-10T02:15:00.000Z');
    });

    await t.test('cache transaction failure rolls back cache and preserves retry admission across connections', async () => {
      await reset();
      await seed(timestamp - DAY);
      const original = await cache();
      await db.query(`CREATE FUNCTION currency_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic cache write failure'; END $$`);
      await db.query('CREATE TRIGGER currency_fixture_fail BEFORE INSERT OR UPDATE ON exchange_rate_cache FOR EACH ROW EXECUTE FUNCTION currency_fixture_fail()');
      try {
        await assert.rejects(refreshUsdRate({ databasePool: workerA, now, fetchLive: async () => ({ rate: 41, rateDate: '2026-01-10' }) }), /synthetic cache write failure/);
        assert.deepEqual(await cache(), original);
        assert.equal((await state()).next_attempt_at.toISOString(), '2026-01-10T02:15:00.000Z');
        const other = await refreshUsdRate({ databasePool: workerB, now, fetchLive: async () => assert.fail('durable retry must prevent another fetch') });
        assert.equal(other.status, 'deferred'); // Proves failed owner's session lock was released.
      } finally {
        await db.query('DROP TRIGGER currency_fixture_fail ON exchange_rate_cache');
        await db.query('DROP FUNCTION currency_fixture_fail()');
      }
    });

    await t.test('same effective weekend rate still records one successful fetch per new 04:00 Kyiv period', async () => {
      await reset();
      timestamp = Date.parse('2026-01-11T01:59:59.999Z'); // Sunday, 03:59:59 Kyiv.
      await seed(Date.parse('2026-01-10T02:00:00Z'));
      let calls = 0;
      const fetchLive = async ({ date }) => { calls++; assert.equal(date, '2026-01-11'); return { rate: 40, rateDate: '2026-01-09' }; };
      assert.equal((await refreshUsdRate({ databasePool: workerA, now, fetchLive })).status, 'current');
      assert.equal((await read()).stale, false);
      timestamp++;
      assert.equal((await read()).stale, true);
      assert.equal((await refreshUsdRate({ databasePool: workerB, now, fetchLive })).status, 'refreshed');
      assert.equal((await refreshUsdRate({ databasePool: workerA, now, fetchLive })).status, 'current');
      assert.equal(calls, 1);
      assert.equal((await read()).stale, false);
      assert.equal((await read()).rateDate, '2026-01-09');
    });

    assert.equal(nbuHttp.mock.callCount(), 0);
    assert.equal(remoteHttp.mock.callCount(), 0);
    assert.deepEqual(await business(), beforeBusiness, 'refresh/read paths must not alter products, prices, audit, previews, ledgers or sync requests');
  } finally {
    await Promise.all([...active].map(runtime => runtime.stop()));
    await Promise.all([workerA.end(), workerB.end(), db.end()]);
    await dropTestDatabase(name);
    await controlPool.end();
  }
});
