const app = require('./src/app');
const { PORT } = require('./src/config/env');
const { seedDefaultData } = require('./src/db/init-db');
const { runMigrations } = require('./src/db/run-migrations');
const { ensureLegacySkuSchemas } = require('./src/services/sku-schema.service');
const pool = require('./src/db/pool');
const logger = require('./src/utils/logger');

async function start() {
  await runMigrations();
  await seedDefaultData();
  await ensureLegacySkuSchemas();
  const server = app.listen(PORT, () => {
    logger.info('server.started', { port: PORT });
  });
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.shutdown.started', { signal });
    const forceTimer = setTimeout(() => {
      logger.error('server.shutdown.timeout', { timeoutMs: 10000 });
      process.exit(1);
    }, 10000);
    forceTimer.unref();
    server.close(async (error) => {
      if (error) logger.error('server.http.close_failed', { error: error.message });
      try {
        await pool.end();
        clearTimeout(forceTimer);
        logger.info('server.shutdown.completed', { signal });
        process.exit(error ? 1 : 0);
      } catch (poolError) {
        logger.error('server.pool.close_failed', { error: poolError.message });
        process.exit(1);
      }
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('server.startup.failed', { error: err.message, code: err.code });
  process.exit(1);
});
