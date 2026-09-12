function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(3));
}

function summarizeSamples(samples) {
  const numeric = (key) => samples.map((sample) => Number(sample[key] || 0));
  const queryCounts = numeric('dbQueryCount');
  return {
    sampleCount: samples.length,
    requestMs: { p50: percentile(numeric('durationMs'), 0.5), p95: percentile(numeric('durationMs'), 0.95) },
    databaseMs: { p50: percentile(numeric('dbDurationMs'), 0.5), p95: percentile(numeric('dbDurationMs'), 0.95) },
    maxQueryMs: { p50: percentile(numeric('dbMaxDurationMs'), 0.5), p95: percentile(numeric('dbMaxDurationMs'), 0.95) },
    queryCount: { min: Math.min(...queryCounts), p50: percentile(queryCounts, 0.5), max: Math.max(...queryCounts) },
    responseBytes: { p50: percentile(numeric('responseBytes'), 0.5), p95: percentile(numeric('responseBytes'), 0.95) },
    cpuMs: { p50: percentile(numeric('cpuMs'), 0.5), p95: percentile(numeric('cpuMs'), 0.95) },
    heapDeltaBytes: { p50: percentile(numeric('heapDeltaBytes'), 0.5), p95: percentile(numeric('heapDeltaBytes'), 0.95) },
    peakHeapBytes: Math.max(...numeric('heapUsedBytes')),
    peakRssBytes: Math.max(...numeric('rssBytes')),
    eventLoopDelayMs: { p50: percentile(numeric('eventLoopDelayMs'), 0.5), p95: percentile(numeric('eventLoopDelayMs'), 0.95) },
    fingerprints: mergeFingerprints(samples),
    phases: mergePhases(samples),
  };
}

function mergePhases(samples) {
  const names = [...new Set(samples.flatMap((sample) => Object.keys(sample.performancePhases || {})))];
  return Object.fromEntries(names.map((name) => {
    const durations = samples.map((sample) => Number(sample.performancePhases?.[name]?.durationMs || 0));
    return [name, {
      observedSamples: durations.filter((value) => value > 0).length,
      durationMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95) },
      maxDurationMs: Math.max(...samples.map((sample) => Number(sample.performancePhases?.[name]?.maxDurationMs || 0))),
    }];
  }));
}

function mergeFingerprints(samples) {
  const totals = new Map();
  for (const sample of samples) {
    for (const item of sample.dbQueryFingerprints || []) {
      const current = totals.get(item.fingerprint) || { ...item, count: 0, durationMs: 0 };
      current.count += Number(item.count || 0);
      current.durationMs += Number(item.durationMs || 0);
      current.maxDurationMs = Math.max(current.maxDurationMs || 0, item.maxDurationMs || 0);
      totals.set(item.fingerprint, current);
    }
  }
  return [...totals.values()]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 12)
    .map((item) => ({ ...item, durationMs: Number(item.durationMs.toFixed(3)) }));
}

module.exports = { mergePhases, percentile, summarizeSamples };
