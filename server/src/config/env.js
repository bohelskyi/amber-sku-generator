const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({
  path: path.resolve(__dirname, '../../../.env'),
  override: false,
  quiet: true,
});

const DEFAULT_NBU_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function readValue(env, name) {
  const value = env[name];
  return value === undefined || value === null ? '' : String(value).trim();
}

function readRawValue(env, name) {
  const value = env[name];
  return value === undefined || value === null ? '' : String(value);
}

function parseInteger(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = readValue(env, name);
  const value = raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseBoolean(env, name, fallback = false) {
  const raw = readValue(env, name).toLowerCase();
  if (raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be either true or false`);
}

function parseOptionalPositiveNumber(env, name) {
  const raw = readValue(env, name);
  if (raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number when set`);
  }
  return value;
}

function parseDatabaseOptions(env) {
  const connectionString = readValue(env, 'DATABASE_URL');
  if (connectionString) {
    let parsed;
    try {
      parsed = new URL(connectionString);
    } catch {
      throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      throw new Error('DATABASE_URL must use the postgres or postgresql scheme');
    }
    if (!parsed.hostname || !parsed.username || !parsed.password || parsed.pathname === '/') {
      throw new Error('DATABASE_URL must include host, database, user, and password');
    }
    return { connectionString };
  }

  const database = readValue(env, 'PGDATABASE') || readValue(env, 'POSTGRES_DB');
  const user = readValue(env, 'PGUSER') || readValue(env, 'POSTGRES_USER');
  const password = readRawValue(env, 'PGPASSWORD') || readRawValue(env, 'POSTGRES_PASSWORD');
  if (!database || !user || !password) {
    throw new Error(
      'Database configuration is required: set DATABASE_URL or database, user, and password via PG*/POSTGRES_* variables'
    );
  }

  return {
    host: readValue(env, 'PGHOST') || 'localhost',
    port: parseInteger(env, 'PGPORT', 5432, { min: 1, max: 65535 }),
    database,
    user,
    password,
  };
}

function loadConfig(env = process.env) {
  return {
    PORT: parseInteger(env, 'PORT', 5000, { min: 1, max: 65535 }),
    databaseOptions: parseDatabaseOptions(env),
    useSsl: parseBoolean(env, 'PGSSL', false),
    pgPoolMax: parseInteger(env, 'PG_POOL_MAX', 10, { min: 1, max: 1000 }),
    pgIdleTimeoutMs: parseInteger(env, 'PG_IDLE_TIMEOUT_MS', 30000),
    pgConnectTimeoutMs: parseInteger(env, 'PG_CONNECT_TIMEOUT_MS', 5000),
    pgQueryTimeoutMs: parseInteger(env, 'PG_QUERY_TIMEOUT_MS', 30000),
    pgStatementTimeoutMs: parseInteger(env, 'PG_STATEMENT_TIMEOUT_MS', 30000),
    nbuRateOverride: parseOptionalPositiveNumber(env, 'NBU_RATE_OVERRIDE'),
    nbuMaxStaleMs: parseInteger(env, 'NBU_MAX_STALE_MS', DEFAULT_NBU_MAX_STALE_MS, {
      min: 1,
    }),
  };
}

module.exports = {
  ...loadConfig(),
  DEFAULT_NBU_MAX_STALE_MS,
  loadConfig,
};
