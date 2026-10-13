const pool = require('../db/pool');
const { fetchJson } = require('../utils/http');
const { nbuRateOverride, nbuMaxStaleMs } = require('../config/env');
const { getRatePeriod, normalizeStrictRateDate } = require('./currency-rate-policy');
const { performance } = require('node:perf_hooks');

// Process-local evidence belongs to the exact returned snapshot, not its public
// age/clock fields. Serialization or cloning cannot transfer this clock proof.
const rateEvidence = new WeakMap();
function rememberRateEvidence(rateInfo, startedAt, wallStartedAt) {
  rateEvidence.set(rateInfo, { snapshot: { ...rateInfo }, startedAt, wallStartedAt,
    ageMs: rateInfo.ageMs, elapsed: 0 });
  return rateInfo;
}

const NBU_USD_URL =
  'https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json';
const DEFAULT_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function getKyivDateString(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Kyiv' });
}

function normalizeRateDate(value, fallback = getKyivDateString()) {
  const text = String(value || '').trim();
  const nbuMatch = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (nbuMatch) return `${nbuMatch[3]}-${nbuMatch[2]}-${nbuMatch[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function normalizeRateInfo(value, { source = 'unknown', stale = false, error = null, now = new Date() } = {}) {
  if (!value) return null;
  const rate = Number(value.rate);
  const fetchedAt = value.fetchedAt || value.fetched_at;
  if (!Number.isFinite(rate) || rate <= 0 || !fetchedAt) return null;
  const timestamp = new Date(fetchedAt);
  if (Number.isNaN(timestamp.getTime())) return null;
  return {
    rate,
    rateDate: normalizeRateDate(
      value.rateDate || value.rate_date,
      getKyivDateString(timestamp)
    ),
    fetchedAt: timestamp.toISOString(),
    source,
    stale,
    ageMs: Math.max(0, now.getTime() - timestamp.getTime()),
    error: error ? String(error.message || error) : null,
  };
}

function createUsdRateProvider({
  fetchLive,
  loadLastKnown = async () => null,
  saveLastKnown = async () => {},
  now = () => new Date(),
  maxStaleMs = DEFAULT_MAX_STALE_MS,
} = {}) {
  let cached = null;
  let inFlight = null;

  async function getRateInfo() {
    const currentDate = now();
    const today = getKyivDateString(currentDate);
    if (cached && cached.rateDate === today && !cached.stale) {
      return normalizeRateInfo(cached, { source: cached.source, now: currentDate });
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const liveValue = await fetchLive();
        const live = normalizeRateInfo({
          rate: liveValue.rate,
          rateDate: liveValue.rateDate || today,
          fetchedAt: liveValue.fetchedAt || currentDate.toISOString(),
        }, { source: 'nbu', now: currentDate });
        if (!live) {
          const invalidError = new Error('NBU rate payload is invalid');
          invalidError.code = 'ERR_INVALID_RATE';
          throw invalidError;
        }
        cached = live;
        await saveLastKnown(live);
        return live;
      } catch (error) {
        let persistedValue = null;
        try {
          persistedValue = await loadLastKnown();
        } catch {
          // An in-memory last-known-good value is still usable during a DB outage.
        }
        const persisted = normalizeRateInfo(persistedValue, {
          source: 'last_known_good',
          stale: true,
          error,
          now: currentDate,
        });
        const fallback = cached || persisted;
        if (!fallback) throw error;
        const fallbackAge = Math.max(0, currentDate.getTime() - new Date(fallback.fetchedAt).getTime());
        if (fallbackAge > maxStaleMs) {
          const staleError = new Error(`Last-known-good USD/UAH rate is too old (${fallbackAge}ms)`);
          staleError.code = 'ERR_RATE_TOO_OLD';
          staleError.cause = error;
          throw staleError;
        }
        cached = {
          ...fallback,
          source: 'last_known_good',
          stale: true,
          ageMs: fallbackAge,
          error: String(error.message || error),
        };
        return cached;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return { getRateInfo, reset: () => { cached = null; inFlight = null; } };
}

async function fetchLiveUsdRate({ date = getKyivDateString(), signal, fetchJsonImpl = fetchJson,
  rateOverride = nbuRateOverride } = {}) {
  if (rateOverride !== null) {
    return {
      rate: rateOverride,
      rateDate: getKyivDateString(),
      fetchedAt: new Date().toISOString(),
    };
  }
  if (normalizeStrictRateDate(date) !== date) {
    throw Object.assign(new Error('NBU request date is invalid'), { code: 'ERR_INVALID_RATE' });
  }
  const url = new URL(NBU_USD_URL);
  url.searchParams.set('date', date.replaceAll('-', ''));
  const data = await fetchJsonImpl(url.toString(), { signal });
  const rate = data && data[0] && data[0].rate ? Number(data[0].rate) : null;
  const rateDate = normalizeStrictRateDate(data?.[0]?.exchangedate);
  if (!Array.isArray(data) || data.length !== 1 || data[0].cc !== 'USD'
      || !Number.isFinite(rate) || rate <= 0 || !rateDate || rateDate > date) {
    const error = new Error('NBU rate missing');
    error.code = 'ERR_INVALID_RATE';
    throw error;
  }
  return {
    rate,
    rateDate,
    fetchedAt: new Date().toISOString(),
  };
}

async function saveLastKnownRate(rateInfo) {
  try {
    await pool.query(
      `INSERT INTO exchange_rate_cache (currency_pair, rate, rate_date, fetched_at)
       VALUES ('USD_UAH', $1, $2, $3)
       ON CONFLICT (currency_pair)
       DO UPDATE SET rate = EXCLUDED.rate,
                     rate_date = EXCLUDED.rate_date,
                     fetched_at = EXCLUDED.fetched_at
       WHERE exchange_rate_cache.fetched_at <= EXCLUDED.fetched_at`,
      [rateInfo.rate, rateInfo.rateDate, rateInfo.fetchedAt]
    );
  } catch (error) {
    if (error?.code !== '42P01') throw error;
  }
}

// Business readers never refresh or write the cache. A background runtime owns
// NBU retrieval; each call returns a detached, timestamped snapshot for pricing.
async function getUsdUahRateInfo({ databasePool = pool, now, rateOverride = nbuRateOverride } = {}) {
  const startedAt = performance.now(), wallStartedAt = Date.now();
  if (rateOverride !== null) {
    const current = now ? now() : new Date();
    return rememberRateEvidence(normalizeRateInfo({ rate: rateOverride, rateDate: getKyivDateString(current), fetchedAt: current.toISOString() },
      { source: 'nbu', now: current }), startedAt, wallStartedAt);
  }
  const value = (await databasePool.query(`SELECT r.rate,r.rate_date::text,r.fetched_at,
      s.last_attempt_at,s.last_error,clock_timestamp() AS observed_at
    FROM exchange_rate_cache r
    LEFT JOIN exchange_rate_refresh_state s USING (currency_pair)
    WHERE r.currency_pair='USD_UAH'`)).rows[0];
  // Validate against the read's clock, not request start: a refresh may commit
  // while this SELECT waits for a connection. Production uses the DB clock,
  // matching the background publisher's timestamps.
  const current = now ? now() : new Date(value?.observed_at || NaN);
  const rateDate = normalizeStrictRateDate(value?.rate_date);
  const fetchedAt = new Date(value?.fetched_at || NaN);
  if (!(current instanceof Date) || !Number.isFinite(current.getTime())
      || !rateDate || rateDate > getKyivDateString(current) || !Number.isFinite(fetchedAt.getTime())
      || fetchedAt > current) {
    throw Object.assign(new Error('Stored USD/UAH rate is unavailable; background refresh is required'), { code: 'ERR_RATE_UNAVAILABLE' });
  }
  const stale = getRatePeriod(fetchedAt) < getRatePeriod(current);
  const rateInfo = normalizeRateInfo({ ...value, rateDate }, {
    source: stale ? 'last_known_good' : 'nbu', stale, now: current,
    error: stale ? (value.last_error || 'Scheduled USD/UAH rate refresh is pending') : null,
  });
  if (!rateInfo) {
    throw Object.assign(new Error('Stored USD/UAH rate is invalid'), { code: 'ERR_RATE_UNAVAILABLE' });
  }
  assertUsdRateObservationCurrent({ rateInfo }, current);
  return rememberRateEvidence(rateInfo, startedAt, wallStartedAt);
}

async function getUsdUahRate() {
  return (await getUsdUahRateInfo()).rate;
}

function assertUsdRateObservationCurrent(observation, now) {
  const rate = observation?.rateInfo;
  if (!rate) return;
  const invalid = () => Object.assign(new Error('Observed USD/UAH rate timestamp is invalid'), { code: 'ERR_RATE_UNAVAILABLE' });
  const evidence = rateEvidence.get(rate);
  let ageMs = 0, elapsedAtCheck;
  if (evidence) {
    if (Object.keys(evidence.snapshot).some(key => {
      const field = Object.getOwnPropertyDescriptor(rate, key);
      return !field || !Object.hasOwn(field, 'value') || !Object.is(field.value, evidence.snapshot[key]);
    })) throw invalid();
    const elapsed = performance.now() - evidence.startedAt;
    const wallElapsed = Date.now() - evidence.wallStartedAt;
    if (!Number.isFinite(elapsed) || elapsed < evidence.elapsed || !Number.isFinite(wallElapsed)) throw invalid();
    // DB age and process elapsed time share no absolute wall-clock comparison.
    // Starting before SELECT conservatively includes waiting/response latency.
    // A wall-clock rollback cannot extend validity; a forward jump/suspend can
    // only expire it sooner. Neither a public ageMs nor stale flag grants trust.
    ageMs = Math.max(evidence.ageMs + elapsed - evidence.elapsed,
      evidence.snapshot.ageMs + Math.max(elapsed, wallElapsed));
    elapsedAtCheck = elapsed;
  }
  if (!evidence || now !== undefined) {
    const fetchedAt = new Date(evidence ? evidence.snapshot.fetchedAt : rate.fetchedAt).getTime();
    const current = now === undefined ? new Date() : now;
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())
        || !Number.isFinite(fetchedAt) || fetchedAt > current.getTime()) throw invalid();
    // An explicit clock may tighten a proven observation, never extend it.
    ageMs = Math.max(ageMs, current.getTime() - fetchedAt);
  }
  // A wall-clock correction cannot rejuvenate an already consumed observation.
  // Keep this high-water age private; the public snapshot stays unchanged.
  if (evidence) { evidence.ageMs = ageMs; evidence.elapsed = elapsedAtCheck; }
  // Even an observation that was fresh when captured can expire while waiting
  // for a lock. The stored stale flag must never extend the existing age limit.
  if (ageMs > nbuMaxStaleMs) {
    throw Object.assign(new Error('Observed USD/UAH fallback expired before use'), { code: 'ERR_RATE_TOO_OLD' });
  }
}

// Observe before opening a business transaction, without HTTP or cache writes.
async function observeUsdRate(options = {}) {
  try { return { rateInfo: await getUsdUahRateInfo(options), rateError: null }; }
  catch (error) { return { rateInfo: null, rateError: String(error.message || error) }; }
}

module.exports = {
  DEFAULT_MAX_STALE_MS,
  NBU_USD_URL,
  createUsdRateProvider,
  fetchLiveUsdRate,
  getKyivDateString,
  getUsdUahRate,
  getUsdUahRateInfo,
  normalizeRateInfo,
  normalizeRateDate,
  observeUsdRate,
  assertUsdRateObservationCurrent,
  saveLastKnownRate,
};
