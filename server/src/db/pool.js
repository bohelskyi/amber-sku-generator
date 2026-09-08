const { Pool } = require('pg');
const {
  databaseOptions,
  useSsl,
  pgPoolMax,
  pgIdleTimeoutMs,
  pgConnectTimeoutMs,
  pgQueryTimeoutMs,
  pgStatementTimeoutMs,
} = require('../config/env');

const pool = new Pool({
  ...databaseOptions,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: pgPoolMax,
  idleTimeoutMillis: pgIdleTimeoutMs,
  connectionTimeoutMillis: pgConnectTimeoutMs,
  query_timeout: pgQueryTimeoutMs,
  statement_timeout: pgStatementTimeoutMs,
});

pool.on('error', (err) => {
  require('../utils/logger').error('postgres.pool.error', {
    error: err.message,
    code: err.code,
  });
});

module.exports = pool;
