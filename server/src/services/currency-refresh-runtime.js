const { Pool } = require('pg');
const currency = require('./currency.service');
const { getRatePeriod, normalizeStrictRateDate } = require('./currency-rate-policy');

const CURRENCY_PAIR = 'USD_UAH';
const REFRESH_LOCK = 'amber_currency_refresh:USD_UAH';
const RETRY_MS = 15 * 60 * 1000;
const QUERY_TIMEOUT_MS = 2000;
const failureCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
  'ENOTFOUND', 'ERR_INVALID_JSON', 'ERR_RESPONSE_TOO_LARGE', 'ERR_INVALID_RATE', 'ERR_INVALID_RATE_DATE']);
const failureCode = error => failureCodes.has(error?.code) ? error.code : 'NBU_RATE_REFRESH_FAILED';
const dateValue = value => {
  const date = value instanceof Date ? value : new Date(value);
  if (value == null || !Number.isFinite(date.getTime())) throw new Error('Invalid refresh clock');
  return date;
};

async function refreshUsdRate({ databasePool, logger, now, fetchLive = currency.fetchLiveUsdRate,
  retryMs = RETRY_MS, signal } = {}) {
  if (!Number.isSafeInteger(retryMs) || retryMs < RETRY_MS) throw new Error('Invalid refresh retry interval');
  if (signal?.aborted) return { status: 'stopped' };
  const client = await databasePool.connect();
  let held = false, broken = false, inTransaction = false;
  const onConnectionError = () => { broken = true; };
  client.on?.('error', onConnectionError);
  const query = (text, values) => client.query({ text, values, query_timeout: QUERY_TIMEOUT_MS });
  const clock = async () => dateValue(now ? now() : (await query('SELECT clock_timestamp() AS now')).rows[0].now);
  try {
    held = (await query('SELECT pg_try_advisory_lock(hashtext($1)) AS held', [REFRESH_LOCK])).rows[0]?.held === true;
    if (!held) return { status: 'busy' };
    if (signal?.aborted) return { status: 'stopped' };
    const at = await clock(), requestedDate = currency.getKyivDateString(at);
    const cache = (await query(`SELECT rate,rate_date::text AS rate_date,fetched_at
      FROM exchange_rate_cache WHERE currency_pair=$1`, [CURRENCY_PAIR])).rows[0];
    const state = (await query(`SELECT last_attempt_at,next_attempt_at,last_error
      FROM exchange_rate_refresh_state WHERE currency_pair=$1`, [CURRENCY_PAIR])).rows[0];
    const fetchedAt = cache?.fetched_at == null ? null : new Date(cache.fetched_at);
    const rateDate = normalizeStrictRateDate(cache?.rate_date);
    const cacheValid = !!cache && Number.isFinite(Number(cache.rate)) && Number(cache.rate) > 0
      && fetchedAt && Number.isFinite(fetchedAt.getTime()) && fetchedAt <= at
      && rateDate && rateDate <= requestedDate;
    if (cacheValid && getRatePeriod(fetchedAt) === getRatePeriod(at)) return { status: 'current' };
    if (state?.next_attempt_at != null && dateValue(state.next_attempt_at) > at) {
      return { status: 'deferred', nextAttemptAt: dateValue(state.next_attempt_at).toISOString() };
    }
    if (signal?.aborted) return { status: 'stopped' };
    // Autocommit before HTTP: a process death retains the global retry deadline.
    await query(`INSERT INTO exchange_rate_refresh_state(currency_pair,last_attempt_at,next_attempt_at,last_error)
      VALUES($1,$2,$3,NULL) ON CONFLICT(currency_pair) DO UPDATE
      SET last_attempt_at=EXCLUDED.last_attempt_at,next_attempt_at=EXCLUDED.next_attempt_at`,
    [CURRENCY_PAIR, at, new Date(at.getTime() + retryMs)]);
    if (signal?.aborted || broken) return { status: 'stopped' };
    const failed = async code => {
      await query('UPDATE exchange_rate_refresh_state SET last_error=$2 WHERE currency_pair=$1', [CURRENCY_PAIR, code]);
      logger?.warn?.('currency.refresh.failed', { code, lastSuccessfulAvailable: Boolean(cacheValid) });
      return { status: 'failed', code };
    };
    let value;
    try {
      value = await fetchLive({ date: requestedDate, signal });
      const liveDate = normalizeStrictRateDate(value?.rateDate);
      if (!liveDate || liveDate > requestedDate) {
        throw Object.assign(new Error('Invalid NBU rate date'), { code: 'ERR_INVALID_RATE_DATE' });
      }
      if (!Number.isFinite(Number(value?.rate)) || Number(value.rate) <= 0) {
        throw Object.assign(new Error('Invalid NBU rate'), { code: 'ERR_INVALID_RATE' });
      }
      value = { rate: Number(value.rate), rateDate: liveDate };
    } catch (error) {
      if (signal?.aborted || broken) return { status: 'stopped' };
      return await failed(failureCode(error));
    }
    if (signal?.aborted || broken) return { status: 'stopped' };
    const completedAt = await clock();
    if (completedAt < at || signal?.aborted || broken) return { status: 'stopped' };
    await query('BEGIN');
    inTransaction = true;
    const saved = await query(`INSERT INTO exchange_rate_cache(currency_pair,rate,rate_date,fetched_at)
      VALUES($1,$2,$3,$4) ON CONFLICT(currency_pair) DO UPDATE
      SET rate=EXCLUDED.rate,rate_date=EXCLUDED.rate_date,fetched_at=EXCLUDED.fetched_at
      WHERE exchange_rate_cache.fetched_at <= EXCLUDED.fetched_at RETURNING currency_pair`,
    [CURRENCY_PAIR, value.rate, value.rateDate, completedAt]);
    if (saved.rowCount !== 1) {
      await query('ROLLBACK'); inTransaction = false;
      return await failed('NBU_RATE_CACHE_CHANGED');
    }
    await query(`UPDATE exchange_rate_refresh_state SET next_attempt_at=NULL,last_error=NULL
      WHERE currency_pair=$1`, [CURRENCY_PAIR]);
    await query('COMMIT');
    inTransaction = false;
    logger?.info?.('currency.refresh.succeeded', { rateDate: value.rateDate, fetchedAt: completedAt.toISOString() });
    return { status: 'refreshed', rateDate: value.rateDate, fetchedAt: completedAt.toISOString() };
  } catch (error) {
    broken = true;
    if (inTransaction) await query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (held && !broken) {
      try {
        const unlocked = (await query('SELECT pg_advisory_unlock(hashtext($1)) AS unlocked', [REFRESH_LOCK])).rows[0]?.unlocked;
        if (unlocked !== true) broken = true;
      } catch { broken = true; }
    }
    client.removeListener?.('error', onConnectionError);
    client.release(broken);
  }
}

function startCurrencyRefresh(config, logger, { databasePool, now, fetchLive,
  intervalMs = 60000, retryMs = RETRY_MS } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('Invalid refresh poll interval');
  // A controlled/test override is never persisted as a real NBU observation.
  if (config.nbuRateOverride != null) return {
    tick: async () => ({ status: 'override' }), stop: async () => {},
  };
  const db = databasePool || new Pool({ ...config.databaseOptions, max: 1,
    ssl: config.useSsl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: Math.min(config.pgConnectTimeoutMs || QUERY_TIMEOUT_MS, QUERY_TIMEOUT_MS),
    idleTimeoutMillis: config.pgIdleTimeoutMs,
    query_timeout: QUERY_TIMEOUT_MS, statement_timeout: QUERY_TIMEOUT_MS });
  if (!databasePool) db.on('error', () => logger?.error?.('currency.refresh.pool_failed', { code: 'LOCAL_RATE_POOL_FAILED' }));
  const controller = new AbortController();
  let stopped = false, active = null, timer;
  function tick() {
    if (stopped) return Promise.resolve({ status: 'stopped' });
    if (active) return active;
    active = refreshUsdRate({ databasePool: db, logger, now, fetchLive, retryMs,
      signal: controller.signal })
      .finally(() => { active = null; });
    return active;
  }
  function loop() {
    timer = null;
    if (stopped) return;
    tick().catch(() => logger?.error?.('currency.refresh.poll_failed', { code: 'LOCAL_RATE_REFRESH_FAILED' }))
      .finally(() => { if (!stopped) { timer = setTimeout(loop, intervalMs); timer.unref(); } });
  }
  loop();
  return { tick, async stop() {
    stopped = true; clearTimeout(timer); controller.abort();
    await active?.catch(() => {});
    if (!databasePool) await db.end();
  } };
}

module.exports = { startCurrencyRefresh, refreshUsdRate, CURRENCY_PAIR, REFRESH_LOCK };
