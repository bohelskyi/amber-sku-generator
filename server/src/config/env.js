const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({
  path: path.resolve(__dirname, '../../../.env'),
  override: false,
  quiet: true,
});

const DEFAULT_NBU_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const MIN_SESSION_SECRET_BYTES = 32;

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

function parseHttpUrl(env, name, { rootOnly = false } = {}) {
  const raw = readValue(env, name);
  if (!raw) throw new Error(`${name} is required`);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid absolute HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} must use the http or https scheme`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain credentials, query parameters, or a fragment`);
  }
  if (rootOnly && parsed.pathname !== '/') {
    throw new Error(`${name} must contain only an origin without a path`);
  }
  if (
    parsed.protocol === 'http:'
    && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  ) {
    throw new Error(`${name} may use plain HTTP only for local development`);
  }
  return parsed;
}

function parseRequiredRawValue(env, name) {
  const value = readRawValue(env, name);
  if (!value || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function parseSessionSecret(env) {
  const secret = parseRequiredRawValue(env, 'SESSION_SECRET');
  if (Buffer.byteLength(secret, 'utf8') < MIN_SESSION_SECRET_BYTES) {
    throw new Error(`SESSION_SECRET must contain at least ${MIN_SESSION_SECRET_BYTES} bytes`);
  }
  if (new Set(secret).size < 8) {
    throw new Error('SESSION_SECRET must be cryptographically random and varied');
  }
  return secret;
}

function parseTrustProxy(env) {
  const raw = readValue(env, 'TRUST_PROXY').toLowerCase();
  if (!raw || raw === 'false') return false;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) {
    throw new Error('TRUST_PROXY must be false or an integer between 1 and 10');
  }
  return hops;
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
  const databaseOptions = parseDatabaseOptions(env);
  const appBaseUrl = parseHttpUrl(env, 'APP_BASE_URL', { rootOnly: true });
  const oidcIssuerUrl = parseHttpUrl(env, 'OIDC_ISSUER_URL');
  const oidcRedirectUri = parseHttpUrl(env, 'OIDC_REDIRECT_URI');
  const oidcClientId = readValue(env, 'OIDC_CLIENT_ID');
  if (!oidcClientId) throw new Error('OIDC_CLIENT_ID is required');
  const sessionCookieSecure = parseBoolean(
    env,
    'SESSION_COOKIE_SECURE',
    appBaseUrl.protocol === 'https:'
  );
  if (sessionCookieSecure !== (appBaseUrl.protocol === 'https:')) {
    throw new Error('SESSION_COOKIE_SECURE must match the APP_BASE_URL scheme');
  }

  return {
    PORT: parseInteger(env, 'PORT', 5000, { min: 1, max: 65535 }),
    databaseOptions,
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
    appBaseUrl: appBaseUrl.toString(),
    oidcIssuerUrl: oidcIssuerUrl.toString(),
    oidcClientId,
    oidcClientSecret: parseRequiredRawValue(env, 'OIDC_CLIENT_SECRET'),
    oidcRedirectUri: oidcRedirectUri.toString(),
    sessionSecret: parseSessionSecret(env),
    sessionMaxAgeMs: parseInteger(
      env,
      'SESSION_MAX_AGE_MS',
      DEFAULT_SESSION_MAX_AGE_MS,
      { min: 60 * 1000, max: 30 * 24 * 60 * 60 * 1000 }
    ),
    sessionCookieSecure,
    trustProxy: parseTrustProxy(env),
  };
}

module.exports = {
  ...loadConfig(),
  DEFAULT_NBU_MAX_STALE_MS,
  DEFAULT_SESSION_MAX_AGE_MS,
  MIN_SESSION_SECRET_BYTES,
  loadConfig,
};
