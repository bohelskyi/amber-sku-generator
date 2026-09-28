const { Pool } = require('pg');
const { createAutomaticSyncWorker } = require('./automatic-sync-worker');

function startAutomaticSync(config, logger) {
  // Remote latency cannot exhaust the HTTP request pool. One worker lane uses
  // at most four simultaneous connections (claim, SKU guard, preview, ledger).
  const databasePool = new Pool({ ...config.databaseOptions, max: 5,
    ssl: config.useSsl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: config.pgConnectTimeoutMs,
    idleTimeoutMillis: config.pgIdleTimeoutMs,
    query_timeout: config.pgQueryTimeoutMs, statement_timeout: config.pgStatementTimeoutMs });
  databasePool.on('error', () => logger.error('magento.auto_sync.pool_failed', { code: 'LOCAL_POOL_FAILURE' }));
  const worker = createAutomaticSyncWorker(config.magento, { databasePool, logger });
  worker.start();
  return { async stop() { await worker.stop(); await databasePool.end(); } };
}
module.exports = { startAutomaticSync };
