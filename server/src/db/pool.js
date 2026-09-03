const { Pool } = require('pg');
const { DATABASE_URL, useSsl } = require('../config/env');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 5000),
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 30000),
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 30000),
});

pool.on('error', (err) => {
  require('../utils/logger').error('postgres.pool.error', {
    error: err.message,
    code: err.code,
  });
});

module.exports = pool;
