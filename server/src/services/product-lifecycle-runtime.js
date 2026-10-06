const { Pool } = require('pg');
const { processPending } = require('./magento/product-visibility-worker');

// One independent lane per runtime; public-identity/SKU session locks coordinate
// replicas and native/name/media work. No archived history is enrolled on startup.
function startProductLifecycle(config, logger, { databasePool, intervalMs = 5000, workerOptions = {} } = {}) {
  const db = databasePool || new Pool({ ...config.databaseOptions, max: 3,
    ssl: config.useSsl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: config.pgConnectTimeoutMs, idleTimeoutMillis: config.pgIdleTimeoutMs,
    query_timeout: config.pgQueryTimeoutMs, statement_timeout: config.pgStatementTimeoutMs });
  let stopped = false, active, timer;
  const options = { ...workerOptions, databasePool: db, logger, stopping: () => stopped };
  const loop = () => {
    timer = null;
    if (stopped) return;
    active = processPending(config.magento, options).catch(() =>
      logger.error('product.visibility.poll_failed', { code: 'LOCAL_VISIBILITY_WORKER_FAILED' }))
      .finally(() => { active = null; if (!stopped) { timer = setTimeout(loop, intervalMs); timer.unref(); } });
  };
  if (!databasePool) db.on('error', () => logger.error('product.visibility.pool_failed', { code: 'LOCAL_VISIBILITY_POOL_FAILED' }));
  timer = setTimeout(loop, intervalMs); timer.unref();
  return { async stop() {
    stopped = true; clearTimeout(timer); await active;
    if (!databasePool) await db.end();
  } };
}
module.exports = { startProductLifecycle };
