const { Pool } = require('pg');
const { processPending:processAtomic } = require('./magento/historical-reactivation-worker');
const { processPending:processStandard } = require('./magento/historical-standard-worker');
const { processPending:processReviews } = require('./historical-review-operations');
async function processPending(config,options) {
  await processReviews(config,{...options,signal:options.reviewSignal});
  if(!options.stopping?.())await processAtomic(config,options);
  if(!options.stopping?.())await processStandard(config,options);
}

// Empty on installation. Only an explicit confirmed Administrator batch creates
// work. One independent lane; stop drains before its owned pool is closed.
function startHistoricalReactivation(config, logger, { databasePool, intervalMs = 5000, workerOptions = {} } = {}) {
  const db = databasePool || new Pool({ ...config.databaseOptions, max: 3,
    ssl: config.useSsl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: config.pgConnectTimeoutMs, idleTimeoutMillis: config.pgIdleTimeoutMs,
    query_timeout: config.pgQueryTimeoutMs, statement_timeout: config.pgStatementTimeoutMs });
  let stopped = false, active, timer;
  const controller = new AbortController();
  const options = { ...workerOptions, databasePool: db, logger, stopping: () => stopped, reviewSignal:controller.signal };
  const loop = () => {
    timer = null;
    if (stopped) return;
    active = processPending(config.magento, options).catch(() => logger.error('historical.reactivation.poll_failed', { code: 'LOCAL_HISTORICAL_WORKER_FAILED' }))
      .finally(() => { active = null; if (!stopped) { timer = setTimeout(loop, intervalMs); timer.unref(); } });
  };
  if (!databasePool) db.on('error', () => logger.error('historical.reactivation.pool_failed', { code: 'LOCAL_HISTORICAL_POOL_FAILED' }));
  timer = setTimeout(loop, intervalMs); timer.unref();
  return { async stop() { stopped = true; controller.abort(); clearTimeout(timer); await active; if (!databasePool) await db.end(); } };
}
module.exports = { startHistoricalReactivation };
