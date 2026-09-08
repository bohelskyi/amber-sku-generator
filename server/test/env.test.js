const assert = require('node:assert/strict');
const test = require('node:test');

const { loadConfig } = require('../src/config/env');

const validDatabaseUrl =
  'postgresql://example_user:example_password@db.example.invalid:5432/amber';

test('runtime configuration requires explicit PostgreSQL credentials', () => {
  assert.throws(
    () => loadConfig({}),
    /Database configuration is required/
  );
});

test('runtime configuration accepts a complete PostgreSQL URL', () => {
  const config = loadConfig({ DATABASE_URL: validDatabaseUrl });

  assert.deepEqual(config.databaseOptions, { connectionString: validDatabaseUrl });
  assert.equal(config.PORT, 5000);
});

test('runtime configuration accepts individual PostgreSQL settings', () => {
  const config = loadConfig({
    PGHOST: 'postgres',
    PGPORT: '5432',
    PGDATABASE: 'amber',
    PGUSER: 'amber_app',
    PGPASSWORD: 'example_password',
  });

  assert.deepEqual(config.databaseOptions, {
    host: 'postgres',
    port: 5432,
    database: 'amber',
    user: 'amber_app',
    password: 'example_password',
  });
});

test('runtime configuration reuses Compose PostgreSQL settings for local server startup', () => {
  const config = loadConfig({
    POSTGRES_DB: 'amber',
    POSTGRES_USER: 'amber_app',
    POSTGRES_PASSWORD: 'example password with spaces',
  });

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
    () => loadConfig({ DATABASE_URL: validDatabaseUrl, PORT: '5000x' }),
    /PORT must be an integer/
  );
  assert.throws(
    () => loadConfig({ DATABASE_URL: validDatabaseUrl, PGSSL: 'yes' }),
    /PGSSL must be either true or false/
  );
  assert.throws(
    () => loadConfig({ DATABASE_URL: validDatabaseUrl, NBU_RATE_OVERRIDE: '0' }),
    /NBU_RATE_OVERRIDE must be a positive number/
  );
});
