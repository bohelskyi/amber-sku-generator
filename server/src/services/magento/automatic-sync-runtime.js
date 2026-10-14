const { Pool } = require('pg');
const { createAutomaticSyncWorker } = require('./automatic-sync-worker');

function startAutomaticSync(config, logger) {
  // Remote latency cannot exhaust the HTTP request pool. Each product lane uses
  // at most four simultaneous connections (claim, SKU guard, preview, ledger).
  // Bounded name discovery uses one session guard plus one short local read or
  // transaction; keep all lanes within this pool, isolated from HTTP traffic.
  const concurrency = config.magentoAutoSyncConcurrency || 1;
  const databasePool = new Pool({ ...config.databaseOptions, max: 2 + 4 * concurrency,
    ssl: config.useSsl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: config.pgConnectTimeoutMs,
    idleTimeoutMillis: config.pgIdleTimeoutMs,
    query_timeout: config.pgQueryTimeoutMs, statement_timeout: config.pgStatementTimeoutMs });
  databasePool.on('error', () => logger.error('magento.auto_sync.pool_failed', { code: 'LOCAL_POOL_FAILURE' }));
  const worker = createAutomaticSyncWorker(config.magento, { databasePool, logger, concurrency });
  const names = require('./name-discovery').createNameDiscovery(config.magento, { databasePool, logger });
  worker.start();
  names.start();
  return { async stop() { await Promise.all([worker.stop(), names.stop()]); await databasePool.end(); } };
}
module.exports = { startAutomaticSync };
