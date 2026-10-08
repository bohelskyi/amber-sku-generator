const PHASES = new Set(['authority_lock', 'actor_check', 'lifecycle_gate', 'binding_read',
  'binding_lock', 'binding_check', 'product_lookup', 'product_lock', 'lifecycle_lock',
  'historical_check', 'automatic_check', 'snapshot_check', 'job_state', 'job_audit',
  'dispatch_marker']);
async function phase(name, operation) {
  try { return await operation(); }
  catch (error) {
    if (error && typeof error === 'object' && !error.syncPhase && PHASES.has(name)) error.syncPhase = name;
    throw error;
  }
}
function diagnostic(error) {
  const sqlState = /^[0-9A-Z]{5}$/.test(error?.sqlState || error?.code || '')
    ? error.sqlState || error.code : null;
  if (!sqlState) return null;
  return { code: 'LOCAL_DATABASE_FAILURE', sqlState,
    phase: PHASES.has(error.syncPhase || error.phase) ? error.syncPhase || error.phase : 'unknown' };
}
function log(error, options = {}, context = {}) {
  const detail = diagnostic(error);
  if (!detail) return;
  (options.logger || require('../../utils/logger')).error('magento.sync.local_failure', {
    ...detail, ...Object.fromEntries(['jobId', 'publicIdentityId'].filter(key => context[key] != null)
      .map(key => [key, String(context[key]).slice(0, 100)])),
    ...(['enqueue','apply'].includes(options.telemetryStage) ? { stage: options.telemetryStage } : {}),
  });
}
module.exports = { phase, diagnostic, log, PHASES };
