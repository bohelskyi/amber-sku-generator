const assert = require('node:assert/strict');
const test = require('node:test');

const { loadConfig } = require('../src/config/env');

const validDatabaseUrl =
  'postgresql://example_user:example_password@db.example.invalid:5432/amber';
const validAuthEnv = {
  APP_BASE_URL: 'http://localhost:5173',
  OIDC_ISSUER_URL: 'https://auth.example.invalid/realms/amber',
  OIDC_CLIENT_ID: 'amber-sku-manager',
  OIDC_CLIENT_SECRET: 'example-client-secret',
  OIDC_REDIRECT_URI: 'http://localhost:5000/api/auth/callback',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef',
  SESSION_COOKIE_SECURE: 'false',
  TRUST_PROXY: 'false',
};

function withAuth(env) {
  return { ...validAuthEnv, ...env };
}

test('runtime configuration requires explicit PostgreSQL credentials', () => {
  assert.throws(
    () => loadConfig({}),
    /Database configuration is required/
  );
});

test('runtime configuration accepts a complete PostgreSQL URL', () => {
  const config = loadConfig(withAuth({ DATABASE_URL: validDatabaseUrl }));

  assert.deepEqual(config.databaseOptions, { connectionString: validDatabaseUrl });
  assert.equal(config.PORT, 5000);
  assert.equal(config.sessionMaxAgeMs, 8 * 60 * 60 * 1000);
  assert.equal(config.sessionCookieSecure, false);
  assert.equal(config.trustProxy, false);
});

test('runtime configuration accepts individual PostgreSQL settings', () => {
  const config = loadConfig(withAuth({
    PGHOST: 'postgres',
    PGPORT: '5432',
    PGDATABASE: 'amber',
    PGUSER: 'amber_app',
    PGPASSWORD: 'example_password',
  }));

  assert.deepEqual(config.databaseOptions, {
    host: 'postgres',
    port: 5432,
    database: 'amber',
    user: 'amber_app',
    password: 'example_password',
  });
});

test('runtime configuration reuses Compose PostgreSQL settings for local server startup', () => {
  const config = loadConfig(withAuth({
    POSTGRES_DB: 'amber',
    POSTGRES_USER: 'amber_app',
    POSTGRES_PASSWORD: 'example password with spaces',
  }));

  assert.deepEqual(config.databaseOptions, {
    host: 'localhost',
    port: 5432,
    database: 'amber',
    user: 'amber_app',
    password: 'example password with spaces',
  });
});

test('runtime configuration rejects invalid optional values', () => {
  assert.throws(
    () => loadConfig(withAuth({ DATABASE_URL: validDatabaseUrl, PORT: '5000x' })),
    /PORT must be an integer/
  );
  assert.throws(
    () => loadConfig(withAuth({ DATABASE_URL: validDatabaseUrl, PGSSL: 'yes' })),
    /PGSSL must be either true or false/
  );
  assert.throws(
    () => loadConfig(withAuth({ DATABASE_URL: validDatabaseUrl, NBU_RATE_OVERRIDE: '0' })),
    /NBU_RATE_OVERRIDE must be a positive number/
  );
});

test('runtime configuration requires complete OIDC and session settings', () => {
  for (const name of [
    'APP_BASE_URL',
    'OIDC_ISSUER_URL',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'OIDC_REDIRECT_URI',
    'SESSION_SECRET',
  ]) {
    const env = withAuth({ DATABASE_URL: validDatabaseUrl });
    delete env[name];
    assert.throws(() => loadConfig(env), new RegExp(`${name} is required`));
  }
});

test('runtime configuration validates session secret strength and lifetime', () => {
  assert.throws(
    () => loadConfig(withAuth({ DATABASE_URL: validDatabaseUrl, SESSION_SECRET: 'too-short' })),
    /SESSION_SECRET must contain at least 32 bytes/
  );
  assert.throws(
    () => loadConfig(withAuth({ DATABASE_URL: validDatabaseUrl, SESSION_SECRET: 'x'.repeat(64) })),
    /SESSION_SECRET must be cryptographically random and varied/
  );
  assert.throws(
    () => loadConfig(withAuth({ DATABASE_URL: validDatabaseUrl, SESSION_MAX_AGE_MS: '59999' })),
    /SESSION_MAX_AGE_MS must be an integer/
  );
});

test('runtime configuration requires cookie security to match the public scheme', () => {
  assert.throws(
    () => loadConfig(withAuth({
      DATABASE_URL: validDatabaseUrl,
      APP_BASE_URL: 'https://skumanager.example.invalid',
      SESSION_COOKIE_SECURE: 'false',
    })),
    /SESSION_COOKIE_SECURE must match the APP_BASE_URL scheme/
  );
  assert.throws(
    () => loadConfig(withAuth({
      DATABASE_URL: validDatabaseUrl,
      APP_BASE_URL: 'http://localhost:5173',
      SESSION_COOKIE_SECURE: 'true',
    })),
    /SESSION_COOKIE_SECURE must match the APP_BASE_URL scheme/
  );

  const production = loadConfig(withAuth({
    DATABASE_URL: validDatabaseUrl,
    APP_BASE_URL: 'https://skumanager.example.invalid',
    OIDC_REDIRECT_URI: 'https://skumanager.example.invalid/api/auth/callback',
    SESSION_COOKIE_SECURE: 'true',
    TRUST_PROXY: '1',
  }));
  assert.equal(production.sessionCookieSecure, true);
  assert.equal(production.trustProxy, 1);
});

test('runtime configuration rejects unsafe public URLs and proxy trust values', () => {
  assert.throws(
    () => loadConfig(withAuth({
      DATABASE_URL: validDatabaseUrl,
      APP_BASE_URL: 'http://public.example.invalid',
    })),
    /plain HTTP only for local development/
  );
  assert.throws(
    () => loadConfig(withAuth({ DATABASE_URL: validDatabaseUrl, TRUST_PROXY: 'true' })),
    /TRUST_PROXY must be false or an integer/
  );
});
