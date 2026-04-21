const { Pool } = require('pg');
const { DATABASE_URL, useSsl } = require('../config/env');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message || err);
});

module.exports = pool;
