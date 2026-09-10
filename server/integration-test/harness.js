const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { Pool } = require('pg');

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');

const configuredDatabaseName = new URL(TEST_DATABASE_URL).pathname.slice(1);
if (!configuredDatabaseName.endsWith('_test')) {
  throw new Error(`Refusing destructive integration setup for ${configuredDatabaseName}`);
}

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NBU_RATE_OVERRIDE = '40';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.OIDC_ISSUER_URL = 'https://auth.example.invalid/realms/amber';
process.env.OIDC_CLIENT_ID = 'amber-sku-manager-integration-test';
process.env.OIDC_CLIENT_SECRET = 'integration-test-client-secret';
process.env.OIDC_REDIRECT_URI = 'http://localhost:5000/api/auth/callback';
process.env.SESSION_SECRET = 'integration-test-session-secret-0123456789abcdef';
process.env.SESSION_COOKIE_SECURE = 'false';
process.env.TRUST_PROXY = 'false';

const pool = require('../src/db/pool');
const { createApp } = require('../src/app');
const serverRoot = path.resolve(__dirname, '..');

async function assertDisposableTestDatabase(databasePool = pool) {
  const database = await databasePool.query('SELECT current_database() AS name');
  const databaseName = String(database.rows[0].name);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Refusing destructive integration setup for ${databaseName}`);
  }
  return databaseName;
}

function databaseUrlFor(databaseName) {
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error(`Unsafe test database name: ${databaseName}`);
  }
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function recreateTestDatabase(databaseName) {
  await pool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await pool.query(`CREATE DATABASE ${databaseName}`);
  return databaseUrlFor(databaseName);
}

async function dropTestDatabase(databaseName) {
  await pool.query(`DROP DATABASE IF EXISTS ${databaseName}`);
}

async function runNodeInDatabase(databaseUrl, source, extraEnv = {}) {
  return execFileAsync(process.execPath, ['-e', source], {
    cwd: serverRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      NBU_RATE_OVERRIDE: '40',
      ...extraEnv,
    },
  });
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

async function closeServer(server) {
  if (server) await new Promise((resolve) => server.close(resolve));
}

function createHttpRequester({ getBaseUrl, getDefaultAuthentication }) {
  return async function request(url, {
    method = 'GET',
    body,
    headers = {},
    authentication = getDefaultAuthentication(),
    csrfToken,
  } = {}) {
    const normalizedMethod = method.toUpperCase();
    const authenticatedHeaders = authentication
      ? { Cookie: authentication.cookie }
      : {};
    if (
      authentication
      && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)
      && csrfToken !== null
    ) {
      authenticatedHeaders['X-CSRF-Token'] = csrfToken ?? authentication.csrfToken;
    }
    const response = await fetch(`${getBaseUrl()}${url}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...authenticatedHeaders,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const text = await response.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { response, data, text };
  };
}

module.exports = {
  Pool,
  TEST_DATABASE_URL,
  assertDisposableTestDatabase,
  closeServer,
  createApp,
  createHttpRequester,
  databaseUrlFor,
  dropTestDatabase,
  execFileAsync,
  listen,
  pool,
  recreateTestDatabase,
  runNodeInDatabase,
  serverRoot,
};
