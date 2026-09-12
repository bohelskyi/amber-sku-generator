const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createRequestMetrics,
  instrumentPostgresClient,
  runWithRequestMetrics,
  summarizeRequestMetrics,
} = require('../src/observability/performance-metrics');
const { percentile } = require('./statistics');

const WARMUPS = 100;
const SAMPLES = 500;
const ROUNDS = 5;

function createDelayedClient() {
  return {
    async query() {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { rowCount: 1, rows: [{ ok: true }] };
    },
  };
}

async function timeOperation(operation) {
  for (let index = 0; index < WARMUPS; index += 1) await operation();
  const samples = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const startedAt = process.hrtime.bigint();
    await operation();
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  return percentile(samples, 0.5);
}

async function measureMode(mode) {
  const raw = createDelayedClient();
  const client = mode === 'raw' ? raw : instrumentPostgresClient(raw);
  return timeOperation(async () => {
    if (mode === 'raw') return client.query('SELECT $1', [1]);
    const metrics = createRequestMetrics('overhead', { enabled: mode === 'enabled' });
    return runWithRequestMetrics(metrics, async () => {
      const result = await client.query('SELECT $1', [1]);
      summarizeRequestMetrics(metrics, { slowQueryThresholdMs: Number.MAX_VALUE });
      return result;
    });
  });
}

async function measureInstrumentationOverhead(outputDirectory) {
  const rounds = [];
  for (let round = 1; round <= ROUNDS; round += 1) {
    const rawMs = await measureMode('raw');
    const disabledMs = await measureMode('disabled');
    const enabledMs = await measureMode('enabled');
    rounds.push({
      round,
      rawMs,
      disabledMs,
      enabledMs,
      disabledPercent: ((disabledMs - rawMs) / rawMs) * 100,
      enabledPercent: ((enabledMs - rawMs) / rawMs) * 100,
    });
  }
  const result = {
    method: `${ROUNDS} rounds; ${WARMUPS} warm-ups and ${SAMPLES} samples per mode; requested 2ms asynchronous PostgreSQL-shaped delay (observed raw median about 15.5ms on this Windows host)`,
    disabledPercent: Math.max(0, percentile(rounds.map((item) => item.disabledPercent), 0.5)),
    enabledPercent: Math.max(0, percentile(rounds.map((item) => item.enabledPercent), 0.5)),
    thresholds: { disabledPercent: 2, enabledPercent: 5 },
    rounds,
  };
  result.passed = result.disabledPercent < result.thresholds.disabledPercent
    && result.enabledPercent < result.thresholds.enabledPercent;
  await fs.writeFile(
    path.join(outputDirectory, 'instrumentation-overhead.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8'
  );
  return result;
}

module.exports = { measureInstrumentationOverhead };
