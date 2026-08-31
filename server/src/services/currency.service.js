const pool = require('../db/pool');
const { fetchJson } = require('../utils/http');

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

async function fetchLiveUsdRate() {
  const override = Number(process.env.NBU_RATE_OVERRIDE);
  if (Number.isFinite(override) && override > 0) {
    return { rate: override, rateDate: getKyivDateString(), fetchedAt: new Date().toISOString() };
  }
  const data = await fetchJson(NBU_USD_URL);
  const rate = data && data[0] && data[0].rate ? Number(data[0].rate) : null;
  if (!Number.isFinite(rate) || rate <= 0) {
    const error = new Error('NBU rate missing');
    error.code = 'ERR_INVALID_RATE';
    throw error;
  }
  return {
    rate,
    rateDate: normalizeRateDate(data[0].exchangedate),
    fetchedAt: new Date().toISOString(),
  };
}

async function loadLastKnownRate() {
  try {
    const result = await pool.query(
      `SELECT rate, rate_date, fetched_at
       FROM exchange_rate_cache
       WHERE currency_pair = 'USD_UAH'
       LIMIT 1`
    );
    return result.rows[0] || null;
  } catch (error) {
    if (error?.code === '42P01') return null;
    throw error;
  }
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

const provider = createUsdRateProvider({
  fetchLive: fetchLiveUsdRate,
  loadLastKnown: loadLastKnownRate,
  saveLastKnown: saveLastKnownRate,
  maxStaleMs: Number(process.env.NBU_MAX_STALE_MS || DEFAULT_MAX_STALE_MS),
});

async function getUsdUahRateInfo() {
  return provider.getRateInfo();
}

async function getUsdUahRate() {
  return (await getUsdUahRateInfo()).rate;
}

module.exports = {
  DEFAULT_MAX_STALE_MS,
  NBU_USD_URL,
  createUsdRateProvider,
  getKyivDateString,
  getUsdUahRate,
  getUsdUahRateInfo,
  normalizeRateInfo,
  normalizeRateDate,
  saveLastKnownRate,
};
