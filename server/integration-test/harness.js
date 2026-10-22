const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { Client, Pool } = require('pg');

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');

const configuredDatabaseName = new URL(TEST_DATABASE_URL).pathname.slice(1);
if (!configuredDatabaseName.endsWith('_test')) {
  throw new Error(`Refusing destructive integration setup for ${configuredDatabaseName}`);
}

const serverRoot = path.resolve(__dirname, '..');
const migrationsDirectory = path.join(serverRoot, 'migrations');
let applicationDatabaseUrl = TEST_DATABASE_URL;
let applicationConfigured = false;

// Database-only helpers must not load application config or change a caller's
// rate fixture. Legacy HTTP suites initialize their environment on first use.
function configureApplication() {
  if (applicationConfigured) return;
  applicationConfigured = true;
  process.env.DATABASE_URL = applicationDatabaseUrl;
  process.env.NBU_RATE_OVERRIDE = '40';
  process.env.APP_BASE_URL = 'http://localhost:5173';
  process.env.OIDC_ISSUER_URL = 'https://auth.example.invalid/realms/amber';
  process.env.OIDC_CLIENT_ID = 'amber-sku-manager-integration-test';
  process.env.OIDC_CLIENT_SECRET = 'integration-test-client-secret';
  process.env.OIDC_REDIRECT_URI = 'http://localhost:5000/api/auth/callback';
  process.env.SESSION_SECRET = 'integration-test-session-secret-0123456789abcdef';
  process.env.SESSION_COOKIE_SECURE = 'false';
  process.env.TRUST_PROXY = 'false';
  process.env.GOOGLE_TRANSLATION_API_KEY = '';
}

function applicationPool() {
  configureApplication();
  return require('../src/db/pool');
}

function useSuiteDatabase(databaseName) {
  if (applicationConfigured) throw new Error('Application database already configured');
  applicationDatabaseUrl = databaseUrlFor(databaseName);
}

async function assertDisposableTestDatabase(databasePool = applicationPool()) {
  const database = await databasePool.query('SELECT current_database() AS name');
  const databaseName = String(database.rows[0].name);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Refusing destructive integration setup for ${databaseName}`);
  }
  return databaseName;
}

function databaseUrlFor(databaseName) {
  if (!/^[a-z][a-z0-9_]*_test$/.test(databaseName) || databaseName.length > 63) {
    throw new Error(`Unsafe test database name: ${databaseName}`);
  }
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function withControlClient(operation) {
  const control = new Client({ connectionString: TEST_DATABASE_URL });
  await control.connect();
  try {
    await assertDisposableTestDatabase(control);
    return await operation(control);
  } finally {
    await control.end();
  }
}

async function migrationManifest(directory = migrationsDirectory) {
  const names = (await fs.readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  return Promise.all(names.map(async name => ({
    name,
    // Match the authoritative runner's CRLF/lone-CR normalization exactly.
    checksum: crypto.createHash('sha256').update(
      (await fs.readFile(path.join(directory, name), 'utf8')).replace(/\r\n?/g, '\n')
    ).digest('hex'),
  })));
}

function templateNameFor(manifest) {
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ control: configuredDatabaseName, manifest })).digest('hex');
  return `amber_template_${fingerprint.slice(0, 40)}_test`;
}

async function readTemplateManifest(databaseName) {
  const client = new Client({ connectionString: databaseUrlFor(databaseName) });
  await client.connect();
  try {
    return (await client.query('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows;
  } finally {
    await client.end();
  }
}

async function verifyTemplate(databaseName, expectedManifest) {
  if (JSON.stringify(await readTemplateManifest(databaseName)) !== JSON.stringify(expectedManifest)) {
    throw new Error(`Integration template migration list/checksum mismatch: ${databaseName}`);
  }
}

async function withTemplate(control, directory, operation) {
  const manifest = await migrationManifest(directory);
  const templateName = templateNameFor(manifest);
  // Every process takes this lock in the same configured control database.
  // Verification connections must close before another process clones the source.
  const lock = `amber_integration_template:${templateName}`;
  await control.query('SELECT pg_advisory_lock(hashtext($1))', [lock]);
  try {
    const existing = await control.query('SELECT 1 FROM pg_database WHERE datname = $1', [templateName]);
    if (!existing.rowCount) {
      await control.query(`CREATE DATABASE ${templateName} TEMPLATE template0`);
      try {
        await execFileAsync(process.execPath, ['--require', './test/setup-env.js', '-e',
          "require('./src/db/run-migrations').runMigrations({directory:process.env.INTEGRATION_TEMPLATE_MIGRATIONS}).catch(error=>{console.error(error);process.exitCode=1})"], {
          cwd: serverRoot,
          windowsHide: true,
          env: { ...process.env, DATABASE_URL: databaseUrlFor(templateName), INTEGRATION_TEMPLATE_MIGRATIONS: directory },
        });
        await verifyTemplate(templateName, manifest);
      } catch (error) {
        await control.query(`DROP DATABASE ${templateName}`);
        throw error;
      }
    } else {
      // Never overwrite checksums or silently rebuild a corrupt existing template.
      await verifyTemplate(templateName, manifest);
    }
    if (JSON.stringify(await migrationManifest(directory)) !== JSON.stringify(manifest)) {
      throw new Error('Migration files changed while preparing the integration template');
    }
    return await operation(templateName);
  } finally {
    await control.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]);
  }
}

async function ensureTemplateDatabase({ directory = migrationsDirectory } = {}) {
  return withControlClient(control => withTemplate(control, directory, name => name));
}

// Strict cluster-inventory tests allow only caches whose stored manifest hashes
// back to their exact owned name, including valid caches from an older checkout.
async function verifiedTemplateDatabaseNames() {
  await ensureTemplateDatabase();
  return withControlClient(async control => {
    const rows = (await control.query("SELECT datname FROM pg_database WHERE datname ~ '^amber_template_[0-9a-f]{40}_test$' ORDER BY datname")).rows;
    for (const { datname } of rows) {
      const lock = `amber_integration_template:${datname}`;
      await control.query('SELECT pg_advisory_lock(hashtext($1))', [lock]);
      try {
        const manifest = await readTemplateManifest(datname);
        if (templateNameFor(manifest) !== datname) {
          throw new Error(`Integration template migration list/checksum mismatch: ${datname}`);
        }
      } finally { await control.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]); }
    }
    return rows.map(row => row.datname);
  });
}

// This helper never replaces an existing database. Each caller owns its clone.
async function createTestDatabase(databaseName, { template = true, directory = migrationsDirectory } = {}) {
  const url = databaseUrlFor(databaseName);
  if (databaseName === configuredDatabaseName || databaseName.startsWith('amber_template_')) {
    throw new Error(`Refusing to replace the control/template database: ${databaseName}`);
  }
  await withControlClient(async control => {
    if (template) {
      await withTemplate(control, directory, name => control.query(`CREATE DATABASE ${databaseName} TEMPLATE ${name}`));
    } else {
      await control.query(`CREATE DATABASE ${databaseName} TEMPLATE template0`);
    }
  });
  return url;
}

// Existing migration/checkpoint cases intentionally retain a genuinely empty DB.
async function recreateTestDatabase(databaseName, { template = false } = {}) {
  await dropTestDatabase(databaseName, { force: true });
  return createTestDatabase(databaseName, { template });
}

async function dropTestDatabase(databaseName, { force = false } = {}) {
  databaseUrlFor(databaseName);
  if (databaseName === configuredDatabaseName || databaseName.startsWith('amber_template_')) {
    throw new Error(`Refusing to drop the control/template database: ${databaseName}`);
  }
  await withControlClient(control => control.query(`DROP DATABASE IF EXISTS ${databaseName}${force ? ' WITH (FORCE)' : ''}`));
}

// CI calls this after all test processes finish. Local runs may reuse the verified
// schema-only cache; a changed migration list/checksum selects a different cache.
async function cleanupTemplateDatabase({ directory = migrationsDirectory } = {}) {
  const name = templateNameFor(await migrationManifest(directory));
  await withControlClient(async control => {
    const lock = `amber_integration_template:${name}`;
    await control.query('SELECT pg_advisory_lock(hashtext($1))', [lock]);
    try { await control.query(`DROP DATABASE IF EXISTS ${name}`); }
    finally { await control.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]); }
  });
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
  get TEST_DATABASE_URL() { return applicationDatabaseUrl; },
  assertDisposableTestDatabase,
  cleanupTemplateDatabase,
  closeServer,
  get createApp() { configureApplication(); return require('../src/app').createApp; },
  createHttpRequester,
  createTestDatabase,
  databaseUrlFor,
  dropTestDatabase,
  ensureTemplateDatabase,
  execFileAsync,
  listen,
  migrationManifest,
  get pool() { return applicationPool(); },
  get recreateTestDatabase() { configureApplication(); return recreateTestDatabase; },
  runNodeInDatabase,
  serverRoot,
  templateNameFor,
  useSuiteDatabase,
  verifiedTemplateDatabaseNames,
};

if (require.main === module) {
  if (process.argv[2] !== 'cleanup-template') throw new Error('Expected cleanup-template');
  cleanupTemplateDatabase().catch(error => { console.error(error); process.exitCode = 1; });
}
