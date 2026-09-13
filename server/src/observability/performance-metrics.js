const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const DEFAULT_SLOW_QUERY_MS = 100;
const MAX_SLOW_QUERIES = 5;
const TRANSACTION_COMMANDS = new Set([
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
]);
const INSTRUMENTED_CLIENT = Symbol('amber.instrumentedPostgresClient');
const requestMetricsStorage = new AsyncLocalStorage();

function roundMilliseconds(value) {
  return Number(Number(value || 0).toFixed(3));
}

function isMetricsEnabled(env = process.env) {
  return String(env.PERF_METRICS_ENABLED || 'true').trim().toLowerCase() !== 'false';
}

function getSlowQueryThresholdMs(env = process.env) {
  const parsed = Number(env.PERF_SLOW_QUERY_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SLOW_QUERY_MS;
}

function isFingerprintDetailEnabled(env = process.env) {
  return String(env.PERF_FINGERPRINT_DETAILS || 'false').trim().toLowerCase() === 'true';
}

function normalizeQueryText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getQueryText(config) {
  if (typeof config === 'string') return config;
  if (config && typeof config.text === 'string') return config.text;
  return '';
}

function getQueryCommand(queryText) {
  const match = normalizeQueryText(queryText).match(/^([A-Za-z]+)/);
  return match ? match[1].toUpperCase() : 'UNKNOWN';
}

function getQueryFingerprint(queryText) {
  return crypto
    .createHash('sha256')
    .update(normalizeQueryText(queryText))
    .digest('hex')
    .slice(0, 16);
}

function createRequestMetrics(requestId, { enabled = isMetricsEnabled() } = {}) {
  return {
    enabled,
    requestId,
    queryCount: 0,
    transactionControlCount: 0,
    databaseDurationMs: 0,
    databaseMaxDurationMs: 0,
    slowestQueries: [],
    queryFingerprints: new Map(),
    phases: new Map(),
  };
}

function runWithRequestMetrics(metrics, callback) {
  return requestMetricsStorage.run(metrics, callback);
}

function getCurrentRequestMetrics() {
  return requestMetricsStorage.getStore() || null;
}

function addSlowQuery(metrics, query) {
  metrics.slowestQueries.push(query);
  metrics.slowestQueries.sort((first, second) => second.durationMs - first.durationMs);
  if (metrics.slowestQueries.length > MAX_SLOW_QUERIES) {
    metrics.slowestQueries.length = MAX_SLOW_QUERIES;
  }
}

function recordQuery({ queryText, durationMs, rowCount, errorCode, requestMetrics }) {
  const metrics = requestMetrics || getCurrentRequestMetrics();
  if (!metrics?.enabled) return;

  const command = getQueryCommand(queryText);
  const normalizedDuration = roundMilliseconds(durationMs);
  metrics.queryCount += 1;
  metrics.databaseDurationMs += normalizedDuration;
  metrics.databaseMaxDurationMs = Math.max(
    metrics.databaseMaxDurationMs,
    normalizedDuration
  );
  if (TRANSACTION_COMMANDS.has(command)) metrics.transactionControlCount += 1;

  const fingerprint = getQueryFingerprint(queryText);
  const aggregate = metrics.queryFingerprints.get(fingerprint) || {
    fingerprint,
    command,
    count: 0,
    durationMs: 0,
    maxDurationMs: 0,
  };
  aggregate.count += 1;
  aggregate.durationMs += normalizedDuration;
  aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, normalizedDuration);
  metrics.queryFingerprints.set(fingerprint, aggregate);

  addSlowQuery(metrics, {
    fingerprint,
    command,
    durationMs: normalizedDuration,
    rowCount: Number.isInteger(rowCount) ? rowCount : null,
    ...(errorCode ? { errorCode: String(errorCode) } : {}),
  });
}

function recordPhase(name, durationMs) {
  const metrics = getCurrentRequestMetrics();
  if (!metrics?.enabled) return;
  const key = String(name || '').trim();
  if (!key) return;
  const current = metrics.phases.get(key) || { count: 0, durationMs: 0, maxDurationMs: 0 };
  const normalizedDuration = roundMilliseconds(durationMs);
  current.count += 1;
  current.durationMs += normalizedDuration;
  current.maxDurationMs = Math.max(current.maxDurationMs, normalizedDuration);
  metrics.phases.set(key, current);
}

function startPhase(name) {
  const startedAt = process.hrtime.bigint();
  let finished = false;
  return function finishPhase() {
    if (finished) return;
    finished = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    recordPhase(name, durationMs);
  };
}

function summarizeRequestMetrics(metrics, {
  pool,
  responseBytes = null,
  slowQueryThresholdMs = getSlowQueryThresholdMs(),
  includeFingerprintDetails = isFingerprintDetailEnabled(),
} = {}) {
  if (!metrics?.enabled) return {};
  return {
    responseBytes: Number.isFinite(Number(responseBytes)) ? Number(responseBytes) : null,
    dbQueryCount: metrics.queryCount,
    dbTransactionControlCount: metrics.transactionControlCount,
    dbDurationMs: roundMilliseconds(metrics.databaseDurationMs),
    dbMaxDurationMs: roundMilliseconds(metrics.databaseMaxDurationMs),
    dbPoolTotal: Number(pool?.totalCount || 0),
    dbPoolIdle: Number(pool?.idleCount || 0),
    dbPoolWaiting: Number(pool?.waitingCount || 0),
    ...(includeFingerprintDetails ? {
      dbQueryFingerprints: [...metrics.queryFingerprints.values()]
        .sort((first, second) => second.durationMs - first.durationMs)
        .map((query) => ({
          ...query,
          durationMs: roundMilliseconds(query.durationMs),
          maxDurationMs: roundMilliseconds(query.maxDurationMs),
        })),
    } : {}),
    slowQueries: metrics.slowestQueries
      .filter((query) => query.durationMs >= slowQueryThresholdMs),
    performancePhases: Object.fromEntries(
      [...metrics.phases.entries()].map(([name, phase]) => [name, {
        count: phase.count,
        durationMs: roundMilliseconds(phase.durationMs),
        maxDurationMs: roundMilliseconds(phase.maxDurationMs),
      }])
    ),
  };
}

function findCallbackIndex(args) {
  if (typeof args[2] === 'function') return 2;
  if (typeof args[1] === 'function') return 1;
  return -1;
}

function instrumentPostgresClient(client) {
  if (!client || typeof client.query !== 'function' || client[INSTRUMENTED_CLIENT]) {
    return client;
  }
  Object.defineProperty(client, INSTRUMENTED_CLIENT, { value: true });
  const originalQuery = client.query;

  client.query = function instrumentedQuery(...args) {
    const metrics = getCurrentRequestMetrics();
    if (!metrics?.enabled) return originalQuery.apply(this, args);

    const queryText = getQueryText(args[0]);
    const startedAt = process.hrtime.bigint();
    let completed = false;
    const finish = (error, result) => {
      if (completed) return;
      completed = true;
      recordQuery({
        queryText,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        rowCount: result?.rowCount,
        errorCode: error?.code,
        requestMetrics: metrics,
      });
    };

    const callbackIndex = findCallbackIndex(args);
    if (callbackIndex >= 0) {
      const callback = args[callbackIndex];
      args[callbackIndex] = function instrumentedCallback(error, result) {
        finish(error, result);
        return callback.apply(this, arguments);
      };
      try {
        return originalQuery.apply(this, args);
      } catch (error) {
        finish(error);
        throw error;
      }
    }

    let result;
    try {
      result = originalQuery.apply(this, args);
    } catch (error) {
      finish(error);
      throw error;
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => {
          finish(null, value);
          return value;
        },
        (error) => {
          finish(error);
          throw error;
        }
      );
    }
    return result;
  };
  return client;
}

function instrumentPostgresPool(pool) {
  if (!pool || typeof pool.on !== 'function') return pool;
  pool.on('connect', instrumentPostgresClient);
  return pool;
}

module.exports = {
  DEFAULT_SLOW_QUERY_MS,
  MAX_SLOW_QUERIES,
  createRequestMetrics,
  getCurrentRequestMetrics,
  getQueryCommand,
  getQueryFingerprint,
  getSlowQueryThresholdMs,
  instrumentPostgresClient,
  instrumentPostgresPool,
  isFingerprintDetailEnabled,
  isMetricsEnabled,
  normalizeQueryText,
  recordPhase,
  runWithRequestMetrics,
  startPhase,
  summarizeRequestMetrics,
};
