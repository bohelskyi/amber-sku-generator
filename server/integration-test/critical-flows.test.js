const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
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
const express = require('express');
const { createSessionMiddleware } = require('../src/auth/session');
const { createAuthRouter } = require('../src/routes/auth.routes');
const {
  getApplicationAccess,
  resolveOrCreateApplicationUser,
} = require('../src/auth/application-users');
const { bootstrapAdministrator } = require('../scripts/bootstrap-admin');
const { runMigrations } = require('../src/db/run-migrations');
const { seedDefaultData } = require('../src/db/init-db');
const { ensureLegacySkuSchemas } = require('../src/services/sku-schema.service');
const { saveLastKnownRate } = require('../src/services/currency.service');

let server;
let baseUrl;
let authenticatedSession = null;
const schemas = {};
let primarySku;
const serverRoot = path.resolve(__dirname, '..');

const integrationAuthCalls = { authorization: [], exchange: [] };
const integrationOidcAdapter = {
  issuer: process.env.OIDC_ISSUER_URL,
  redirectUri: process.env.OIDC_REDIRECT_URI,
  async buildAuthorizationRedirect(transaction) {
    integrationAuthCalls.authorization.push({ ...transaction });
    const url = new URL('https://auth.example.invalid/authorize');
    url.searchParams.set('state', transaction.state);
    return url;
  },
  async exchangeAuthorizationCode(parameters) {
    integrationAuthCalls.exchange.push(parameters);
    return {
      iss: this.issuer,
      sub: 'critical-flows-subject',
      preferred_username: 'critical.flows',
      name: 'Critical Flows',
      access_token: 'must-not-be-exposed',
      refresh_token: 'must-not-be-exposed',
      id_token: 'must-not-be-exposed',
    };
  },
  async buildLogoutRedirect() {
    return new URL(
      'https://auth.example.invalid/logout?client_id=amber-sku-manager-integration-test&post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F'
    );
  },
};
const app = createApp({ oidcAdapter: integrationOidcAdapter });

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

async function request(url, {
  method = 'GET',
  body,
  headers = {},
  authentication = authenticatedSession,
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
  const response = await fetch(`${baseUrl}${url}`, {
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
}

async function activateApplicationUserForTest(issuer, subject, roleKey = 'administrator') {
  const result = await pool.query(
    `WITH target_user AS (
       SELECT u.id
       FROM application_external_identities e
       JOIN application_users u ON u.id = e.application_user_id
       WHERE e.issuer = $1 AND e.subject = $2
     ), target_role AS (
       SELECT id FROM roles WHERE role_key = $3 AND status = 'active'
     ), assigned AS (
       INSERT INTO user_role_assignments (application_user_id, role_id)
       SELECT target_user.id, target_role.id
       FROM target_user CROSS JOIN target_role
       ON CONFLICT (application_user_id, role_id) WHERE revoked_at IS NULL DO NOTHING
     )
     UPDATE application_users u
     SET status = 'active',
         activated_at = COALESCE(activated_at, CURRENT_TIMESTAMP),
         deactivated_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     FROM target_user
     WHERE u.id = target_user.id
     RETURNING u.id`,
    [issuer, subject, roleKey]
  );
  assert.equal(result.rows.length, 1, `Could not activate ${issuer} ${subject}`);
  return Number(result.rows[0].id);
}

async function authenticateApplicationSession(returnTo = '/', { activate = true } = {}) {
  const loginResponse = await fetch(
    `${baseUrl}/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
    { redirect: 'manual' }
  );
  assert.equal(loginResponse.status, 302);
  const loginCookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(loginCookie);
  const transaction = integrationAuthCalls.authorization.at(-1);
  assert.ok(transaction?.state);

  const callbackResponse = await fetch(
    `${baseUrl}/api/auth/callback?code=integration-code&state=${transaction.state}`,
    { redirect: 'manual', headers: { Cookie: loginCookie } }
  );
  assert.equal(callbackResponse.status, 303);
  assert.equal(callbackResponse.headers.get('location'), `http://localhost:5173${returnTo}`);
  const cookie = callbackResponse.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);

  const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  assert.equal(meResponse.status, 200);
  let me = await meResponse.json();
  assert.equal(me.identity.issuer, integrationOidcAdapter.issuer);
  assert.equal(me.identity.sub, 'critical-flows-subject');
  assert.ok(['pending', 'active', 'disabled'].includes(me.applicationUser.status));
  assert.equal(typeof me.csrfToken, 'string');
  assert.doesNotMatch(
    JSON.stringify(me),
    /access_token|refresh_token|id_token|must-not-be-exposed|client-secret/
  );
  if (activate) {
    await activateApplicationUserForTest(
      integrationOidcAdapter.issuer,
      'critical-flows-subject'
    );
    const activeMeResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    assert.equal(activeMeResponse.status, 200);
    me = await activeMeResponse.json();
    assert.equal(me.applicationUser.status, 'active');
  }
  return { cookie, csrfToken: me.csrfToken, applicationUser: me.applicationUser };
}

async function createFixtureCategory(code, requiresWeight, withPrices) {
  await pool.query(
    `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
     VALUES ($1, $2, $3, 0)`,
    [code, `Test ${code}`, requiresWeight ? 1 : 0]
  );
  const question = await pool.query(
    `INSERT INTO questions
     (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
     VALUES ($1, 'kind', 'Kind', 1, 1, 1, 1, 'options') RETURNING id`,
    [code]
  );
  await pool.query(
    `INSERT INTO options (question_id, value_id, sku_code, label)
     VALUES ($1, 1, '1', 'One'), ($1, 2, '2', 'Two')`,
    [question.rows[0].id]
  );
  if (withPrices) {
    const scenario = await pool.query(
      `INSERT INTO price_scenarios
       (category_code, name, match_json, axis_x_key, axis_y_key, price_mode, status)
       VALUES ($1, 'Test fixed', '{}'::jsonb, 'kind', NULL, 'fixed_uah', 'active')
       RETURNING id`,
      [code]
    );
    await pool.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       VALUES ($1, 1, 0, 1000), ($1, 2, 0, 1500)`,
      [scenario.rows[0].id]
    );
    return Number(scenario.rows[0].id);
  }
  return null;
}

async function createOptionalRecountFixtureCategory() {
  await pool.query(
    `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
     VALUES ('OC', 'Optional recount', 0, 0)`
  );
  const questions = await pool.query(`
    INSERT INTO questions
      (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
    VALUES
      ('OC', 'kind', 'Kind', 1, 1, 1, 1, 'options'),
      ('OC', 'discount', 'Знижка', 0, 2, 0, 0, 'options'),
      ('OC', 'packaging', 'Пакування', 0, 3, 0, 0, 'options'),
      ('OC', 'required_choice', 'Обов’язковий вибір', 0, 4, 1, 0, 'options'),
      ('OC', 'zero_option', 'Нульове значення', 0, 5, 0, 0, 'options'),
      ('OC', 'is_calibrated', 'Калібрування', 0, 6, 1, 0, 'options')
    RETURNING id, key
  `);
  const questionIds = Object.fromEntries(
    questions.rows.map((question) => [question.key, Number(question.id)])
  );
  await pool.query(
    `INSERT INTO options (question_id, value_id, sku_code, label)
     VALUES
       ($1, 1, '1', 'One'),
       ($1, 2, '2', 'Two'),
       ($2, 1, '1', '10%'),
       ($2, 2, '2', '20%'),
       ($3, 1, '1', 'Box'),
       ($3, 2, '2', 'Bag'),
       ($4, 1, '1', 'Required'),
       ($5, 0, '0', 'Real zero'),
       ($5, 1, '1', 'One'),
       ($6, 0, '0', 'Not calibrated'),
       ($6, 1, '1', 'Calibrated'),
       ($6, 2, '2', 'Semi-calibrated')`,
    [
      questionIds.kind,
      questionIds.discount,
      questionIds.packaging,
      questionIds.required_choice,
      questionIds.zero_option,
      questionIds.is_calibrated,
    ]
  );
  const scenario = await pool.query(
    `INSERT INTO price_scenarios
       (category_code, name, match_json, axis_x_key, axis_y_key, price_mode, status)
     VALUES ('OC', 'Optional fixed', '{}'::jsonb, 'kind', NULL, 'fixed_uah', 'active')
     RETURNING id`
  );
  await pool.query(
    `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
     VALUES ($1, 1, 0, 1000), ($1, 2, 0, 1500)`,
    [scenario.rows[0].id]
  );
}

async function createLegacySemiCalibratedNecklaceFixture() {
  await pool.query(
    `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
     VALUES ('LN', 'Legacy necklace', 1, 0)`
  );
  const questions = await pool.query(`
    INSERT INTO questions
      (category_code, key, label, sku_index, display_order, required,
       include_in_sku, input_type, visible_if_json)
    VALUES
      ('LN', 'raw_type', 'Тип сировини', 1, 1, 1, 1, 'options', NULL),
      ('LN', 'size', 'Розмір', 2, 2, 1, 1, 'options', '{"is_calibrated":[0,1]}'::jsonb),
      ('LN', 'shape', 'Форма', 3, 3, 1, 1, 'options', NULL),
      ('LN', 'is_calibrated', 'Калібрування', 0, 4, 1, 0, 'options', NULL)
    RETURNING id, key
  `);
  const questionIds = Object.fromEntries(
    questions.rows.map((question) => [question.key, Number(question.id)])
  );
  await pool.query(
    `INSERT INTO options (question_id, value_id, sku_code, label, visible_if_json)
     VALUES
       ($1, 1, '1', 'Натуральне', NULL),
       ($2, 1, '1', '40 см', '{"is_calibrated":[0,1]}'::jsonb),
       ($2, 3, '3', '50 см', '{"is_calibrated":[0,1]}'::jsonb),
       ($3, 6, '6', 'Кругла', NULL),
       ($3, 7, '7', 'Овальна', NULL),
       ($4, 0, '0', 'Некаліброване', NULL),
       ($4, 1, '1', 'Каліброване', NULL),
       ($4, 2, '2', 'Напівкаліброване', NULL)`,
    [
      questionIds.raw_type,
      questionIds.size,
      questionIds.shape,
      questionIds.is_calibrated,
    ]
  );
  const scenario = await pool.query(
    `INSERT INTO price_scenarios
       (category_code, name, match_json, axis_x_key, axis_y_key, price_mode, status)
     VALUES
       ('LN', 'Напівкаліброване намисто', '{"is_calibrated":2}'::jsonb,
        'shape', NULL, 'per_gram_usd', 'active')
     RETURNING id`
  );
  await pool.query(
    `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
     VALUES ($1, 6, 0, 4.5), ($1, 7, 0, 5)`,
    [scenario.rows[0].id]
  );
  const calibratedScenario = await pool.query(
    `INSERT INTO price_scenarios
       (category_code, name, match_json, axis_x_key, axis_y_key, price_mode, status)
     VALUES
       ('LN', 'Каліброване намисто', '{"is_calibrated":1}'::jsonb,
        'shape', NULL, 'per_gram_usd', 'active')
     RETURNING id`
  );
  await pool.query(
    `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
     VALUES ($1, 6, 0, 6), ($1, 7, 0, 6.5)`,
    [calibratedScenario.rows[0].id]
  );
}

test.before(async () => {
  const database = await pool.query('SELECT current_database() AS name');
  if (!String(database.rows[0].name).endsWith('_test')) {
    throw new Error(`Refusing destructive integration setup for ${database.rows[0].name}`);
  }
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations();
  await seedDefaultData();
  schemas.ZZScenario = await createFixtureCategory('ZZ', false, true);
  await createFixtureCategory('MM', false, false);
  await createFixtureCategory('WW', true, false);
  await createOptionalRecountFixtureCategory();
  await createLegacySemiCalibratedNecklaceFixture();
  await ensureLegacySkuSchemas();
  for (const code of ['ZZ', 'MM', 'WW', 'OC', 'LN']) {
    const result = await pool.query(
      `SELECT id FROM sku_schema_versions WHERE category_code = $1 AND status = 'active'`,
      [code]
    );
    schemas[code] = Number(result.rows[0].id);
  }
  await pool.query(
    `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price,
        total_price_uah, price_per_gram, uah_rate, details, sku_schema_version_id)
     VALUES
       ('LN106020', 'LN106', 20, 'LN', 20.3, 91.35, 3654, 4.5, 40,
        '{"answers":{"raw_type":1,"shape":6,"is_calibrated":2},"isCalibrated":2}'::jsonb,
        $1),
       ('LN136021', 'LN136', 21, 'LN', 20.6, 123.6, 4944, 6, 40,
        '{"answers":{"raw_type":1,"size":3,"shape":6,"is_calibrated":1},"isCalibrated":1}'::jsonb,
        $1)`,
    [schemas.LN]
  );
  await pool.query(
    `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price,
        total_price_uah, price_per_gram, uah_rate, details, sku_schema_version_id)
     VALUES
       ('OC1001', 'OC1', 1, 'OC', 0, 25, 1000, 0, 40,
        '{"answers":{"kind":1,"discount":1,"packaging":1,"required_choice":1,"zero_option":0,"is_calibrated":0},"isCalibrated":0}'::jsonb,
        $1),
       ('OC1002', 'OC1', 2, 'OC', 0, 25, 1000, 0, 40,
        '{"answers":{"kind":1,"discount":1,"packaging":1,"required_choice":1,"zero_option":0,"is_calibrated":0},"isCalibrated":0}'::jsonb,
        $1)`,
    [schemas.OC]
  );
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('health endpoints report liveness and DB readiness', async () => {
  const live = await request('/health/live');
  const ready = await request('/health/ready');
  assert.equal(live.response.status, 200);
  assert.equal(ready.response.status, 200);
  assert.deepEqual(live.data, { status: 'ok' });
  assert.deepEqual(ready.data, { status: 'ready' });
  assert.equal(live.response.headers.get('set-cookie'), null);
  assert.equal(ready.response.headers.get('set-cookie'), null);
});

test('Phase 1D leaves health and auth public while rejecting both business router trees', async () => {
  const productCountBefore = await pool.query('SELECT count(*)::int AS count FROM products');
  const checks = [
    await request('/api/config', { authentication: null }),
    await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0 },
      authentication: null,
    }),
    await request('/api/admin/config', { authentication: null }),
    await request('/api/admin/category', {
      method: 'POST',
      body: { code: 'UA', name: 'Unauthorized category' },
      authentication: null,
    }),
  ];
  for (const check of checks) {
    assert.equal(check.response.status, 401, check.text);
    assert.deepEqual(check.data, { error: 'Authentication required' });
    assert.equal(check.response.headers.get('location'), null);
  }
  const productCountAfter = await pool.query('SELECT count(*)::int AS count FROM products');
  assert.equal(productCountAfter.rows[0].count, productCountBefore.rows[0].count);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS count FROM categories WHERE code = 'UA'"))
      .rows[0].count,
    0
  );

  const me = await request('/api/auth/me', { authentication: null });
  assert.equal(me.response.status, 401);
  assert.deepEqual(me.data, { error: 'Authentication required' });
});

test('migration 019 matches the connect-pg-simple 10.0.0 table contract', async () => {
  const columns = await pool.query(`
    SELECT column_name, data_type, is_nullable, datetime_precision
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'session'
    ORDER BY ordinal_position
  `);
  assert.deepEqual(columns.rows, [
    { column_name: 'sid', data_type: 'character varying', is_nullable: 'NO', datetime_precision: null },
    { column_name: 'sess', data_type: 'json', is_nullable: 'NO', datetime_precision: null },
    { column_name: 'expire', data_type: 'timestamp without time zone', is_nullable: 'NO', datetime_precision: 6 },
  ]);

  const constraints = await pool.query(`
    SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'public.session'::regclass
    ORDER BY conname
  `);
  assert.deepEqual(constraints.rows, [
    { conname: 'session_pkey', definition: 'PRIMARY KEY (sid)' },
  ]);

  const indexes = await pool.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'session'
    ORDER BY indexname
  `);
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    'IDX_session_expire',
    'session_pkey',
  ]);
});

test('migration 020 creates normalized RBAC schema and the approved built-in mappings', async () => {
  const requiredTables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name
  `, [[
    'application_external_identities',
    'application_users',
    'permissions',
    'role_permissions',
    'roles',
    'security_bootstrap_state',
    'user_role_assignments',
  ]]);
  assert.deepEqual(requiredTables.rows.map((row) => row.table_name), [
    'application_external_identities',
    'application_users',
    'permissions',
    'role_permissions',
    'roles',
    'security_bootstrap_state',
    'user_role_assignments',
  ]);

  const permissionKeys = [
    'catalog.manage',
    'catalog.view',
    'corrections.claim',
    'corrections.complete',
    'corrections.create',
    'corrections.force_release',
    'corrections.reject',
    'corrections.view',
    'exports.create',
    'history.view',
    'pricing.manage',
    'pricing.view',
    'products.archive',
    'products.create',
    'products.decode',
    'products.view',
    'repricing.apply',
    'repricing.prepare',
    'repricing.rollback',
    'repricing.view',
    'roles.manage',
    'sku_schemas.publish',
    'users.manage',
  ];
  const permissions = await pool.query(
    'SELECT permission_key FROM permissions ORDER BY permission_key'
  );
  assert.deepEqual(permissions.rows.map((row) => row.permission_key), permissionKeys);

  const mappings = await pool.query(`
    SELECT r.role_key, r.display_name, r.is_system, r.status,
           ARRAY_AGG(rp.permission_key ORDER BY rp.permission_key) AS permission_keys
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id
    GROUP BY r.id
    ORDER BY r.role_key
  `);
  const byRole = Object.fromEntries(mappings.rows.map((row) => [row.role_key, row]));
  assert.deepEqual(Object.keys(byRole), ['administrator', 'manager', 'storekeeper']);
  for (const role of mappings.rows) {
    assert.equal(role.is_system, true);
    assert.equal(role.status, 'active');
  }
  assert.deepEqual(byRole.administrator.permission_keys, permissionKeys);
  assert.deepEqual(byRole.manager.permission_keys, [
    'corrections.claim',
    'corrections.complete',
    'corrections.create',
    'corrections.reject',
    'corrections.view',
    'history.view',
    'pricing.view',
    'products.decode',
    'products.view',
    'repricing.prepare',
    'repricing.view',
  ]);
  assert.deepEqual(byRole.storekeeper.permission_keys, [
    'corrections.claim',
    'corrections.complete',
    'corrections.create',
    'corrections.reject',
    'corrections.view',
    'history.view',
    'products.create',
    'products.decode',
    'products.view',
    'repricing.prepare',
    'repricing.view',
  ]);

  assert.equal(
    (await pool.query('SELECT count(*)::int AS count FROM user_role_assignments')).rows[0].count,
    0
  );
  assert.deepEqual(
    (await pool.query(
      `SELECT completed_at, administrator_user_id
       FROM security_bootstrap_state WHERE singleton = TRUE`
    )).rows[0],
    { completed_at: null, administrator_user_id: null }
  );
});

test('OIDC identities resolve exactly, refresh mutable profiles, and provision concurrently once', async () => {
  const baseIdentity = {
    issuer: 'https://identity-a.example/realms/amber',
    sub: 'concurrent-rbac-subject',
    preferred_username: 'first.username',
    name: 'First Display',
    email: 'first@example.invalid',
    authenticatedAt: '2026-09-09T10:00:00.000Z',
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => resolveOrCreateApplicationUser(baseIdentity))
  );
  assert.equal(new Set(results.map((user) => user.id)).size, 1);
  assert.equal(results[0].status, 'pending');

  const refreshed = await resolveOrCreateApplicationUser({
    ...baseIdentity,
    preferred_username: 'renamed.username',
    name: 'Renamed Display',
    email: 'renamed@example.invalid',
    authenticatedAt: '2026-09-09T11:00:00.000Z',
  });
  assert.equal(refreshed.id, results[0].id);
  assert.equal(refreshed.preferredUsername, 'renamed.username');
  assert.equal(refreshed.displayName, 'Renamed Display');

  const clearedOptionalProfile = await resolveOrCreateApplicationUser({
    ...baseIdentity,
    preferred_username: 'renamed.username',
    name: 'Renamed Display',
    email: undefined,
    authenticatedAt: '2026-09-09T11:30:00.000Z',
  });
  assert.equal(clearedOptionalProfile.id, refreshed.id);
  assert.equal(clearedOptionalProfile.email, null);

  const otherIssuer = await resolveOrCreateApplicationUser({
    ...baseIdentity,
    issuer: 'https://identity-b.example/realms/amber',
    preferred_username: 'same-sub-different-issuer',
    authenticatedAt: '2026-09-09T12:00:00.000Z',
  });
  assert.notEqual(otherIssuer.id, refreshed.id);

  const exactDifferentSubject = await resolveOrCreateApplicationUser({
    ...baseIdentity,
    sub: ` ${baseIdentity.sub}`,
    preferred_username: 'exact-different-subject',
    authenticatedAt: '2026-09-09T12:30:00.000Z',
  });
  assert.notEqual(exactDifferentSubject.id, refreshed.id);

  const stored = await pool.query(
    `SELECT u.id, u.status, u.preferred_username, u.display_name,
            COUNT(a.id)::int AS assignment_count
     FROM application_external_identities e
     JOIN application_users u ON u.id = e.application_user_id
     LEFT JOIN user_role_assignments a ON a.application_user_id = u.id
     WHERE e.issuer = $1 AND e.subject = $2
     GROUP BY u.id`,
    [baseIdentity.issuer, baseIdentity.sub]
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].preferred_username, 'renamed.username');
  assert.equal(stored.rows[0].display_name, 'Renamed Display');
  assert.equal(stored.rows[0].assignment_count, 0);

  const identityRow = await pool.query(
    `SELECT id FROM application_external_identities
     WHERE issuer = $1 AND subject = $2`,
    [baseIdentity.issuer, baseIdentity.sub]
  );
  await pool.query(
    `UPDATE application_external_identities
     SET last_authenticated_at = last_authenticated_at
     WHERE id = $1`,
    [identityRow.rows[0].id]
  );
  await assert.rejects(
    pool.query(
      'UPDATE application_external_identities SET subject = $1 WHERE id = $2',
      ['replacement-subject', identityRow.rows[0].id]
    ),
    /immutable/
  );
  await assert.rejects(
    pool.query('DELETE FROM application_external_identities WHERE id = $1', [
      identityRow.rows[0].id,
    ]),
    /cannot be deleted/
  );
});

test('PostgreSQL session middleware persists a fixed non-secure local session', async () => {
  const sessionApp = express();
  sessionApp.use('/api', createSessionMiddleware());
  sessionApp.get('/api/session-foundation-test', (req, res) => {
    req.session.visits = Number(req.session.visits || 0) + 1;
    res.json({ visits: req.session.visits });
  });

  const sessionServer = await new Promise((resolve) => {
    const listening = sessionApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const sessionBaseUrl = `http://127.0.0.1:${sessionServer.address().port}`;
  try {
    const first = await fetch(`${sessionBaseUrl}/api/session-foundation-test`);
    assert.deepEqual(await first.json(), { visits: 1 });
    const setCookie = first.headers.get('set-cookie');
    assert.match(setCookie, /^amber\.sid=/);
    assert.match(setCookie, /Path=\/api/i);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.doesNotMatch(setCookie, /;\s*Secure/i);
    assert.doesNotMatch(setCookie, /;\s*Domain=/i);

    const cookie = setCookie.split(';', 1)[0];
    const second = await fetch(`${sessionBaseUrl}/api/session-foundation-test`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual(await second.json(), { visits: 2 });

    const stored = await pool.query('SELECT sess FROM "session"');
    assert.equal(stored.rows.some((row) => Number(row.sess?.visits) === 2), true);
  } finally {
    await new Promise((resolve) => sessionServer.close(resolve));
    await pool.query('DELETE FROM "session"');
  }
});

test('fake OIDC flow persists, regenerates, exposes, and destroys PostgreSQL sessions', async () => {
  const calls = { authorization: [], exchange: [] };
  const fakeOidcAdapter = {
    issuer: 'https://auth.example.invalid/realms/amber',
    redirectUri: 'http://localhost:5000/api/auth/callback',
    async buildAuthorizationRedirect(transaction) {
      calls.authorization.push({ ...transaction });
      const url = new URL('https://auth.example.invalid/authorize');
      url.searchParams.set('state', transaction.state);
      return url;
    },
    async exchangeAuthorizationCode(parameters) {
      calls.exchange.push(parameters);
      return {
        iss: this.issuer,
        sub: 'postgres-backed-subject',
        preferred_username: 'postgres.user',
        email: 'postgres.user@example.invalid',
        access_token: 'must-not-be-stored',
        refresh_token: 'must-not-be-stored',
        id_token: 'must-not-be-stored',
      };
    },
    async buildLogoutRedirect() {
      return new URL(
        'https://auth.example.invalid/logout?client_id=amber-sku-manager-integration-test&post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F'
      );
    },
  };
  const authApp = express();
  authApp.use('/api', createSessionMiddleware());
  authApp.use('/api/auth', createAuthRouter({
    oidcAdapter: fakeOidcAdapter,
    applicationBaseUrl: 'http://localhost:5173/',
  }));
  const authServer = await new Promise((resolve) => {
    const listening = authApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const authBaseUrl = `http://127.0.0.1:${authServer.address().port}`;
  try {
    const loginResponse = await fetch(
      `${authBaseUrl}/api/auth/login?returnTo=${encodeURIComponent('/admin')}`,
      { redirect: 'manual' }
    );
    assert.equal(loginResponse.status, 302);
    const loginCookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];
    const transaction = calls.authorization[0];
    const storedTransaction = await pool.query('SELECT sess FROM "session"');
    assert.equal(storedTransaction.rows.some(
      (row) => row.sess?.oidcTransaction?.state === transaction.state
    ), true);

    const callbackResponse = await fetch(
      `${authBaseUrl}/api/auth/callback?code=fake-code&state=${transaction.state}`,
      { redirect: 'manual', headers: { Cookie: loginCookie } }
    );
    assert.equal(callbackResponse.status, 303);
    assert.equal(callbackResponse.headers.get('location'), 'http://localhost:5173/admin');
    const authenticatedCookie = callbackResponse.headers.get('set-cookie').split(';', 1)[0];
    assert.notEqual(authenticatedCookie, loginCookie);
    assert.equal(calls.exchange.length, 1);

    const authenticatedRows = await pool.query('SELECT sess FROM "session"');
    assert.equal(authenticatedRows.rowCount, 1);
    assert.deepEqual(Object.keys(authenticatedRows.rows[0].sess).sort(), [
      'cookie',
      'csrfToken',
      'identity',
    ]);
    assert.deepEqual(authenticatedRows.rows[0].sess.identity, {
      issuer: fakeOidcAdapter.issuer,
      sub: 'postgres-backed-subject',
      preferred_username: 'postgres.user',
      email: 'postgres.user@example.invalid',
      authenticatedAt: authenticatedRows.rows[0].sess.identity.authenticatedAt,
    });
    assert.equal(typeof authenticatedRows.rows[0].sess.csrfToken, 'string');
    assert.doesNotMatch(
      JSON.stringify(authenticatedRows.rows[0].sess),
      /access_token|refresh_token|id_token|must-not-be-stored/
    );

    const meResponse = await fetch(`${authBaseUrl}/api/auth/me`, {
      headers: { Cookie: authenticatedCookie },
    });
    assert.equal(meResponse.status, 200);
    const me = await meResponse.json();
    assert.equal(me.identity.issuer, fakeOidcAdapter.issuer);
    assert.equal(me.identity.sub, 'postgres-backed-subject');

    const logoutResponse = await fetch(`${authBaseUrl}/api/auth/logout`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: authenticatedCookie,
        'X-CSRF-Token': me.csrfToken,
      },
    });
    assert.equal(logoutResponse.status, 200);
    assert.equal(logoutResponse.headers.get('location'), null);
    const logoutBody = await logoutResponse.json();
    assert.equal(
      logoutBody.logoutUrl,
      'https://auth.example.invalid/logout?client_id=amber-sku-manager-integration-test&post_logout_redirect_uri=http%3A%2F%2Flocalhost%3A5173%2F'
    );
    assert.doesNotMatch(JSON.stringify(logoutBody), /access_token|refresh_token|id_token/);
    assert.match(logoutResponse.headers.get('set-cookie'), /Path=\/api/i);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM "session"')).rows[0].count, 0);
  } finally {
    await new Promise((resolve) => authServer.close(resolve));
    await pool.query('DELETE FROM "session"');
  }
});

test('pending and disabled local access returns stable 403 while /me and logout remain available', async () => {
  const calls = { authorization: [] };
  const accessAdapter = {
    issuer: 'https://access-state.example/realms/amber',
    redirectUri: 'http://localhost:5000/api/auth/callback',
    async buildAuthorizationRedirect(transaction) {
      calls.authorization.push(transaction);
      const url = new URL('https://auth.example.invalid/authorize');
      url.searchParams.set('state', transaction.state);
      return url;
    },
    async exchangeAuthorizationCode() {
      return {
        iss: this.issuer,
        sub: 'phase-2a-access-user',
        preferred_username: 'phase2a.user',
        name: 'Phase 2A User',
      };
    },
    async buildLogoutRedirect() {
      return null;
    },
  };
  const accessApp = createApp({ oidcAdapter: accessAdapter });
  const accessServer = await new Promise((resolve) => {
    const listening = accessApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const accessBaseUrl = `http://127.0.0.1:${accessServer.address().port}`;
  try {
    const loginResponse = await fetch(`${accessBaseUrl}/api/auth/login`, { redirect: 'manual' });
    const loginCookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];
    const callbackResponse = await fetch(
      `${accessBaseUrl}/api/auth/callback?code=code&state=${calls.authorization[0].state}`,
      { redirect: 'manual', headers: { Cookie: loginCookie } }
    );
    assert.equal(callbackResponse.status, 303);
    const cookie = callbackResponse.headers.get('set-cookie').split(';', 1)[0];

    let meResponse = await fetch(`${accessBaseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(meResponse.status, 200);
    let me = await meResponse.json();
    assert.equal(me.applicationUser.status, 'pending');
    assert.deepEqual(me.roles, []);
    assert.deepEqual(me.permissions, []);

    let business = await fetch(`${accessBaseUrl}/api/config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(business.status, 403);
    assert.deepEqual(await business.json(), {
      code: 'APP_ACCESS_PENDING',
      error: 'Application access is pending approval',
    });

    await pool.query(
      `UPDATE application_users u
       SET status = 'disabled', deactivated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       FROM application_external_identities e
       WHERE e.application_user_id = u.id AND e.issuer = $1 AND e.subject = $2`,
      [accessAdapter.issuer, 'phase-2a-access-user']
    );

    meResponse = await fetch(`${accessBaseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(meResponse.status, 200);
    me = await meResponse.json();
    assert.equal(me.applicationUser.status, 'disabled');
    business = await fetch(`${accessBaseUrl}/api/config`, {
      headers: { Cookie: cookie },
    });
    assert.equal(business.status, 403);
    assert.equal((await business.json()).code, 'APP_ACCESS_DISABLED');

    const missingCsrfLogout = await fetch(`${accessBaseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(missingCsrfLogout.status, 403);
    const logout = await fetch(`${accessBaseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': me.csrfToken },
    });
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(`${accessBaseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(afterLogout.status, 401);
  } finally {
    await new Promise((resolve) => accessServer.close(resolve));
  }
});

test('authenticated business boundary requires CSRF only for unsafe methods', async () => {
  authenticatedSession = await authenticateApplicationSession('/admin');

  const config = await request('/api/config');
  const adminConfig = await request('/api/admin/config');
  const head = await request('/api/config', { method: 'HEAD' });
  const options = await request('/api/config', { method: 'OPTIONS' });
  assert.equal(config.response.status, 200, config.text);
  assert.equal(adminConfig.response.status, 200, adminConfig.text);
  assert.equal(head.response.status, 200, head.text);
  assert.notEqual(options.response.status, 403, options.text);

  const unauthenticatedOptions = await request('/api/config', {
    method: 'OPTIONS',
    authentication: null,
  });
  assert.equal(unauthenticatedOptions.response.status, 401);

  const missingCsrfChecks = [
    await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0 },
      csrfToken: null,
    }),
    await request('/api/admin/category', {
      method: 'PUT',
      body: { code: 'ZZ', next_code: 'ZZ', name: 'Test ZZ', requires_weight: 0 },
      csrfToken: null,
    }),
    await request('/api/admin/option/999999/archive', {
      method: 'PATCH',
      body: { archived: true },
      csrfToken: null,
    }),
    await request('/api/admin/repricing/drafts/999999', {
      method: 'DELETE',
      csrfToken: null,
    }),
  ];
  for (const check of missingCsrfChecks) {
    assert.equal(check.response.status, 403, check.text);
    assert.deepEqual(check.data, { error: 'Invalid CSRF token' });
    assert.equal(check.response.headers.get('location'), null);
  }

  const wrongCsrf = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0 },
    csrfToken: 'wrong-csrf-token',
  });
  assert.equal(wrongCsrf.response.status, 403, wrongCsrf.text);
  assert.deepEqual(wrongCsrf.data, { error: 'Invalid CSRF token' });

  const validCsrf = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0 },
  });
  assert.equal(validCsrf.response.status, 200, validCsrf.text);
  assert.equal(typeof validCsrf.data.previewToken, 'string');
});

test('role revocation is reflected immediately without replacing the active session', async () => {
  const userId = authenticatedSession.applicationUser.id;
  await pool.query(
    `UPDATE user_role_assignments
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE application_user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  const meWithoutRole = await request('/api/auth/me');
  assert.equal(meWithoutRole.response.status, 200, meWithoutRole.text);
  assert.deepEqual(meWithoutRole.data.roles, []);
  assert.deepEqual(meWithoutRole.data.permissions, []);
  const stillActive = await request('/api/config');
  assert.equal(stillActive.response.status, 200, stillActive.text);

  const administratorRole = await pool.query(
    "SELECT id FROM roles WHERE role_key = 'administrator'"
  );
  await pool.query(
    `INSERT INTO user_role_assignments (application_user_id, role_id)
     VALUES ($1, $2)`,
    [userId, administratorRole.rows[0].id]
  );
  const restoredMe = await request('/api/auth/me');
  assert.equal(restoredMe.data.permissions.length, 23);
});

test('an expired PostgreSQL application session returns JSON 401', async () => {
  await pool.query(`
    UPDATE "session"
    SET expire = NOW() - INTERVAL '1 minute'
    WHERE sess->'identity'->>'sub' = 'critical-flows-subject'
  `);
  const expired = await request('/api/config');
  assert.equal(expired.response.status, 401, expired.text);
  assert.deepEqual(expired.data, { error: 'Authentication required' });
  assert.equal(expired.response.headers.get('location'), null);

  authenticatedSession = await authenticateApplicationSession('/');
});

test('recount preview authoritatively reprices a changed weight in UAH and USD', async () => {
  const preview = await request('/api/recount/preview', {
    method: 'POST',
    body: {
      sourceSku: 'LN136021',
      answers: {},
      weight: 22.2,
      reason: '',
    },
  });

  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(preview.data.source.totalPrice, 123.6);
  assert.equal(preview.data.source.totalPriceUah, 4944);
  assert.equal(preview.data.corrected.weight, 22.2);
  assert.equal(Number(preview.data.corrected.totalPrice), 133.2);
  assert.equal(preview.data.corrected.totalPriceUah, 5300);
  assert.equal(preview.data.priceDeltaUsd, 9.6);
  assert.equal(preview.data.priceDeltaUah, 356);
  assert.deepEqual(
    preview.data.changes.find((change) => change.key === 'weight'),
    { key: 'weight', from: 20.6, to: 22.2 }
  );

  const invalid = await request('/api/recount/preview', {
    method: 'POST',
    body: { sourceSku: 'LN136021', answers: {}, weight: 0 },
  });
  assert.equal(invalid.response.status, 422, invalid.text);
  assert.match(invalid.data.error, /вага/i);
});

test('complete Size target previews identically for blank and null manual prices', async () => {
  const target = {
    sourceSku: 'LN136021',
    answers: {
      raw_type: 1,
      size: 1,
      shape: 6,
      is_calibrated: 1,
    },
    isCalibrated: 1,
    weight: 20.6,
    reason: '',
  };
  const livePreview = await request('/api/recount/preview', {
    method: 'POST',
    body: { ...target, manualPriceUah: null },
  });
  const continuePreview = await request('/api/recount/preview', {
    method: 'POST',
    body: { ...target, manualPriceUah: '' },
  });

  assert.equal(livePreview.response.status, 200, livePreview.text);
  assert.equal(continuePreview.response.status, 200, continuePreview.text);
  assert.deepEqual(livePreview.data.corrected, continuePreview.data.corrected);
  assert.deepEqual(livePreview.data.changes, continuePreview.data.changes);
  assert.equal(livePreview.data.priceDeltaUah, continuePreview.data.priceDeltaUah);
  assert.equal(livePreview.data.priceDeltaUsd, continuePreview.data.priceDeltaUsd);
});

test('recount removes a valid inherited size when the target configuration hides it', async () => {
  const correctionPayload = {
    sourceSku: 'LN136021',
    answers: { is_calibrated: 2 },
    isCalibrated: 2,
    reason: 'calibrated to semi-calibrated',
  };
  const preview = await request('/api/recount/preview', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(preview.data.corrected.fullSku, 'LN106021');
  assert.equal(Object.hasOwn(preview.data.corrected.answers, 'size'), false);

  const applied = await request('/api/recount/apply', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(applied.response.status, 200, applied.text);
  const correctedState = await pool.query(
    `SELECT source.status AS source_status, corrected.full_sku,
            corrected.details->'answers' AS answers
     FROM products source
     JOIN products corrected ON corrected.id = source.corrected_to_product_id
     WHERE source.full_sku = 'LN136021'`
  );
  assert.equal(correctedState.rows[0].source_status, 'corrected');
  assert.equal(correctedState.rows[0].full_sku, 'LN106021');
  assert.equal(Object.hasOwn(correctedState.rows[0].answers, 'size'), false);
});

test('recount still validates size when the target configuration makes it visible', async () => {
  const missingSize = await request('/api/recount/preview', {
    method: 'POST',
    body: {
      sourceSku: 'LN106020',
      answers: { is_calibrated: 1 },
      isCalibrated: 1,
      reason: 'semi-calibrated to calibrated',
    },
  });
  assert.equal(missingSize.response.status, 422, missingSize.text);
  assert.match(missingSize.data.error, /Розмір/);

  const invalidSize = await request('/api/recount/preview', {
    method: 'POST',
    body: {
      sourceSku: 'LN106020',
      answers: { is_calibrated: 1, size: 999 },
      isCalibrated: 1,
      reason: 'semi-calibrated to calibrated',
    },
  });
  assert.equal(invalidSize.response.status, 422, invalidSize.text);
  assert.match(invalidSize.data.error, /Розмір/);
});

test('legacy hidden size placeholder remains recountable without weakening new-product validation', async () => {
  const decoded = await request('/api/decode', {
    method: 'POST',
    body: { sku: 'LN106020' },
  });
  assert.equal(decoded.response.status, 200, decoded.text);
  assert.equal(decoded.data.existsInDb, true);
  const decodedSize = decoded.data.decodedAnswers.find((answer) => answer.key === 'size');
  assert.deepEqual(
    { valueId: decodedSize.value_id, isPlaceholder: decodedSize.is_placeholder },
    { valueId: null, isPlaceholder: true }
  );

  const correctionPayload = {
    sourceSku: 'LN106020',
    answers: { shape: 7 },
    isCalibrated: 2,
    reason: 'legacy hidden size compatibility',
  };
  const preview = await request('/api/recount/preview', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(preview.data.corrected.fullSku, 'LN107020');
  assert.equal(Object.hasOwn(preview.data.corrected.answers, 'size'), false);

  const applied = await request('/api/recount/apply', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(applied.response.status, 200, applied.text);
  const correctedState = await pool.query(
    `SELECT source.status AS source_status, corrected.full_sku,
            corrected.total_price_uah, corrected.details->'answers' AS answers
     FROM products source
     JOIN products corrected ON corrected.id = source.corrected_to_product_id
     WHERE source.full_sku = 'LN106020'`
  );
  assert.equal(correctedState.rows[0].source_status, 'corrected');
  assert.equal(correctedState.rows[0].full_sku, 'LN107020');
  assert.ok(Number(correctedState.rows[0].total_price_uah) > 0);
  assert.equal(Object.hasOwn(correctedState.rows[0].answers, 'size'), false);

  const hiddenZeroOnNewProduct = await request('/api/preview', {
    method: 'POST',
    body: {
      categoryCode: 'LN',
      answers: { raw_type: 1, size: 0, shape: 6, is_calibrated: 2 },
      weight: 20.3,
      isCalibrated: 2,
    },
  });
  assert.equal(hiddenZeroOnNewProduct.response.status, 422, hiddenZeroOnNewProduct.text);
  assert.match(hiddenZeroOnNewProduct.data.error, /Розмір/);

  const visibleMissingOnNewProduct = await request('/api/preview', {
    method: 'POST',
    body: {
      categoryCode: 'LN',
      answers: { raw_type: 1, shape: 6, is_calibrated: 1 },
      weight: 20.3,
      isCalibrated: 1,
    },
  });
  assert.equal(visibleMissingOnNewProduct.response.status, 422, visibleMissingOnNewProduct.text);
  assert.match(visibleMissingOnNewProduct.data.error, /Розмір/);

  const visibleInvalid = await request('/api/preview', {
    method: 'POST',
    body: {
      categoryCode: 'LN',
      answers: { raw_type: 1, size: 0, shape: 6, is_calibrated: 1 },
      weight: 20.3,
      isCalibrated: 1,
    },
  });
  assert.equal(visibleInvalid.response.status, 422, visibleInvalid.text);
  assert.match(visibleInvalid.data.error, /Розмір/);
});

test('recount explicitly clears optional answers without weakening real zero or required values', async () => {
  const correctionPayload = {
    sourceSku: 'OC1001',
    answers: { discount: null, packaging: 2, zero_option: 0, is_calibrated: 0 },
    isCalibrated: 0,
    reason: 'clear optional discount',
  };
  const preview = await request('/api/recount/preview', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(Object.hasOwn(preview.data.corrected.answers, 'discount'), false);
  assert.equal(preview.data.corrected.answers.packaging, 2);
  assert.equal(preview.data.corrected.answers.zero_option, 0);
  assert.equal(preview.data.corrected.answers.is_calibrated, 0);

  const applied = await request('/api/recount/apply', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(applied.response.status, 200, applied.text);
  const corrected = await pool.query(
    `SELECT corrected.details->'answers' AS answers
     FROM products source
     JOIN products corrected ON corrected.id = source.corrected_to_product_id
     WHERE source.full_sku = 'OC1001'`
  );
  assert.equal(Object.hasOwn(corrected.rows[0].answers, 'discount'), false);
  assert.equal(corrected.rows[0].answers.zero_option, 0);
  assert.equal(corrected.rows[0].answers.is_calibrated, 0);

  const anotherOptional = await request('/api/recount/preview', {
    method: 'POST',
    body: {
      sourceSku: 'OC1002',
      answers: { packaging: null },
      isCalibrated: 0,
      reason: 'clear another optional answer',
    },
  });
  assert.equal(anotherOptional.response.status, 200, anotherOptional.text);
  assert.equal(Object.hasOwn(anotherOptional.data.corrected.answers, 'packaging'), false);

  const requiredCleared = await request('/api/recount/preview', {
    method: 'POST',
    body: {
      sourceSku: 'OC1002',
      answers: { required_choice: null, discount: 2 },
      isCalibrated: 0,
      reason: 'required must remain strict',
    },
  });
  assert.equal(requiredCleared.response.status, 422, requiredCleared.text);
  assert.match(requiredCleared.data.error, /Обов’язковий вибір/);
});

test('parallel replica bootstrap is idempotent through calibrated questions and SKU schemas', async () => {
  const databaseName = 'amber_startup_race_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const bootstrapSource = `
    const db = require('./src/db/pool');
    const { seedDefaultData } = require('./src/db/init-db');
    const { ensureLegacySkuSchemas } = require('./src/services/sku-schema.service');
    (async () => {
      try {
        await seedDefaultData();
        await ensureLegacySkuSchemas();
      } finally {
        await db.end();
      }
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  try {
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    const bootstrapOutcomes = await Promise.allSettled(Array.from(
      { length: 4 },
      () => runNodeInDatabase(databaseUrl, bootstrapSource)
    ));
    const bootstrapFailures = bootstrapOutcomes
      .filter((outcome) => outcome.status === 'rejected')
      .map((outcome) => outcome.reason);
    if (bootstrapFailures.length > 0) {
      throw new AggregateError(bootstrapFailures, 'One or more replica bootstraps failed');
    }

    const replicaPool = new Pool({ connectionString: databaseUrl });
    try {
      const [categoryResult, duplicateQuestions, calibratedQuestions, schemaCounts] =
        await Promise.all([
          replicaPool.query('SELECT count(*)::int AS count FROM categories'),
          replicaPool.query(`
            SELECT category_code, key, count(*)::int AS count
            FROM questions
            GROUP BY category_code, key
            HAVING count(*) > 1
          `),
          replicaPool.query(`
            SELECT raw.category_code
            FROM questions raw
            LEFT JOIN questions calibrated
              ON calibrated.category_code = raw.category_code
             AND calibrated.key = 'is_calibrated'
            WHERE raw.key = 'raw_type'
            GROUP BY raw.category_code
            HAVING count(calibrated.id) <> 1
          `),
          replicaPool.query(`
            SELECT category_code, count(*)::int AS count
            FROM sku_schema_versions
            GROUP BY category_code
            HAVING count(*) <> 1
          `),
        ]);
      assert.ok(Number(categoryResult.rows[0].count) > 0);
      assert.deepEqual(duplicateQuestions.rows, []);
      assert.deepEqual(calibratedQuestions.rows, []);
      assert.deepEqual(schemaCounts.rows, []);
    } finally {
      await replicaPool.end();
    }
  } finally {
    await dropTestDatabase(databaseName);
  }
});

test('calibrated-question seeding rolls back a partial failure and succeeds on retry', async () => {
  const databaseName = 'amber_seed_failure_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const seedPool = new Pool({ connectionString: databaseUrl });
  try {
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    const rawQuestion = await seedPool.query(
      `INSERT INTO categories (code, name, requires_weight) VALUES ('QQ', 'Seed retry', 0);
       INSERT INTO questions
       (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
       VALUES ('QQ', 'raw_type', 'Raw type', 1, 1, 1, 1, 'options')
       RETURNING id`
    );
    await seedPool.query(
      `INSERT INTO options (question_id, value_id, sku_code, label)
       VALUES ($1, 1, '1', 'Natural')`,
      [rawQuestion[1].rows[0].id]
    );
    await seedPool.query(`
      CREATE OR REPLACE FUNCTION fail_calibrated_option_seed()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM questions q
          WHERE q.id = NEW.question_id
            AND q.category_code = 'QQ'
            AND q.key = 'is_calibrated'
        ) THEN
          RAISE EXCEPTION 'seed option failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_calibrated_option_seed
      BEFORE INSERT ON options
      FOR EACH ROW EXECUTE FUNCTION fail_calibrated_option_seed();
    `);
    const seedSource = `
      const db = require('./src/db/pool');
      const { seedDefaultData } = require('./src/db/init-db');
      seedDefaultData()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    await assert.rejects(runNodeInDatabase(databaseUrl, seedSource));
    const afterFailure = await seedPool.query(
      `SELECT count(*)::int AS count FROM questions
       WHERE category_code = 'QQ' AND key = 'is_calibrated'`
    );
    assert.equal(afterFailure.rows[0].count, 0);

    await seedPool.query('DROP TRIGGER fail_calibrated_option_seed ON options');
    await seedPool.query('DROP FUNCTION fail_calibrated_option_seed()');
    await runNodeInDatabase(databaseUrl, seedSource);
    const afterRetry = await seedPool.query(
      `SELECT count(DISTINCT q.id)::int AS questions, count(o.id)::int AS options
       FROM questions q
       LEFT JOIN options o ON o.question_id = q.id
       WHERE q.category_code = 'QQ' AND q.key = 'is_calibrated'`
    );
    assert.equal(afterRetry.rows[0].questions, 1);
    assert.equal(afterRetry.rows[0].options, 3);
  } finally {
    await seedPool.end();
    await dropTestDatabase(databaseName);
  }
});

test('migrations ignore request query timeouts for legitimate long DDL', async () => {
  const databaseName = 'amber_migration_timeout_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const migrationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-migrations-'));
  try {
    await fs.writeFile(
      path.join(migrationDirectory, '001_slow.sql'),
      'SELECT pg_sleep(0.2); CREATE TABLE slow_migration_completed (id INTEGER PRIMARY KEY);\n'
    );
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(migrationDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `, {
      PG_QUERY_TIMEOUT_MS: '50',
      PG_STATEMENT_TIMEOUT_MS: '50',
    });
    const migrationPool = new Pool({ connectionString: databaseUrl });
    try {
      const result = await migrationPool.query(
        "SELECT to_regclass('public.slow_migration_completed') AS table_name"
      );
      assert.equal(result.rows[0].table_name, 'slow_migration_completed');
    } finally {
      await migrationPool.end();
    }
  } finally {
    await fs.rm(migrationDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration failure rolls back only the failing file and leaves it unapplied', async () => {
  const databaseName = 'amber_migration_failure_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const migrationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-failing-migrations-'));
  try {
    await fs.writeFile(
      path.join(migrationDirectory, '001_success.sql'),
      'CREATE TABLE successful_migration (id INTEGER PRIMARY KEY);\n'
    );
    await fs.writeFile(
      path.join(migrationDirectory, '002_failure.sql'),
      'CREATE TABLE rolled_back_migration (id INTEGER); SELECT * FROM table_that_does_not_exist;\n'
    );
    await assert.rejects(runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(migrationDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `));

    const migrationPool = new Pool({ connectionString: databaseUrl });
    try {
      const state = await migrationPool.query(`
        SELECT to_regclass('public.successful_migration') AS successful,
               to_regclass('public.rolled_back_migration') AS rolled_back,
               array_agg(name ORDER BY name) AS applied
        FROM schema_migrations
      `);
      assert.equal(state.rows[0].successful, 'successful_migration');
      assert.equal(state.rows[0].rolled_back, null);
      assert.deepEqual(state.rows[0].applied, ['001_success.sql']);
    } finally {
      await migrationPool.end();
    }
  } finally {
    await fs.rm(migrationDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration checksums are stable across LF and CRLF but reject SQL changes', async () => {
  const databaseName = 'amber_migration_checksum_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const migrationDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-checksum-migrations-')
  );
  const migrationPath = path.join(migrationDirectory, '001_checksum.sql');
  const lfSql = 'CREATE TABLE migration_checksum_probe (\n  id INTEGER PRIMARY KEY\n);\n';
  const runMigrationSource = `
    const db = require('./src/db/pool');
    const { runMigrations } = require('./src/db/run-migrations');
    runMigrations({ directory: ${JSON.stringify(migrationDirectory)} })
      .finally(() => db.end())
      .catch((error) => { console.error(error); process.exitCode = 1; });
  `;

  try {
    await fs.writeFile(migrationPath, lfSql);
    await runNodeInDatabase(databaseUrl, runMigrationSource);

    const checksumPool = new Pool({ connectionString: databaseUrl });
    let linuxChecksum;
    try {
      const stored = await checksumPool.query(
        "SELECT checksum FROM schema_migrations WHERE name = '001_checksum.sql'"
      );
      linuxChecksum = stored.rows[0].checksum;
    } finally {
      await checksumPool.end();
    }

    await fs.writeFile(migrationPath, lfSql.replace(/\n/g, '\r\n'));
    await runNodeInDatabase(databaseUrl, runMigrationSource);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      const stored = await verifiedPool.query(
        "SELECT checksum FROM schema_migrations WHERE name = '001_checksum.sql'"
      );
      assert.equal(stored.rows[0].checksum, linuxChecksum);
    } finally {
      await verifiedPool.end();
    }

    const changedSql = lfSql.replace('INTEGER', 'BIGINT').replace(/\n/g, '\r\n');
    await fs.writeFile(migrationPath, changedSql);
    await assert.rejects(
      runNodeInDatabase(databaseUrl, runMigrationSource),
      (error) => {
        assert.match(String(error.stderr || error.message), /Migration checksum mismatch: 001_checksum\.sql/);
        return true;
      }
    );
  } finally {
    await fs.rm(migrationDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('fresh, pre-checksum, and checkpoint upgrade paths produce equivalent database topology', async () => {
  const freshName = 'amber_fresh_schema_test';
  const upgradeName = 'amber_upgrade_schema_test';
  const checkpointName = 'amber_checkpoint_schema_test';
  const freshUrl = await recreateTestDatabase(freshName);
  const upgradeUrl = await recreateTestDatabase(upgradeName);
  const checkpointUrl = await recreateTestDatabase(checkpointName);
  const oldMigrationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-old-migrations-'));
  const checkpointMigrationDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-checkpoint-migrations-')
  );
  try {
    const allMigrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => fileName.endsWith('.sql'));
    const migrationFiles = allMigrationFiles
      .filter((fileName) => /^(00[1-9]|010|011)_/.test(fileName));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(serverRoot, 'migrations', fileName),
      path.resolve(oldMigrationDirectory, fileName)
    )));
    await Promise.all(allMigrationFiles
      .filter((fileName) => (
         !fileName.startsWith('015_')
         && !fileName.startsWith('016_')
         && !fileName.startsWith('017_')
         && !fileName.startsWith('018_')
         && !fileName.startsWith('019_')
         && !fileName.startsWith('020_')
      ))
      .map((fileName) => fs.copyFile(
        path.resolve(serverRoot, 'migrations', fileName),
        path.resolve(checkpointMigrationDirectory, fileName)
      )));

    await runNodeInDatabase(freshUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      (async () => {
        await runMigrations();
        await runMigrations();
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    await runNodeInDatabase(upgradeUrl, `
      const db = require('./src/db/pool');
      const { legacyInitDb } = require('./src/db/init-db');
      const { runMigrations } = require('./src/db/run-migrations');
      const { ensureLegacySkuSchemas } = require('./src/services/sku-schema.service');
      (async () => {
        await legacyInitDb();
        await runMigrations({ directory: ${JSON.stringify(oldMigrationDirectory)} });
        await db.query('UPDATE schema_migrations SET checksum = NULL');
        await ensureLegacySkuSchemas();
        await runMigrations();
        await runMigrations();
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    await runNodeInDatabase(checkpointUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      (async () => {
        await runMigrations({ directory: ${JSON.stringify(checkpointMigrationDirectory)} });
        await runMigrations();
        await runMigrations();
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const topologyQueries = [
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default,
              numeric_precision, numeric_scale
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, column_name`,
      `SELECT c.conrelid::regclass::text AS table_name, c.conname,
              pg_get_constraintdef(c.oid) AS definition, c.convalidated
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = 'public'
       ORDER BY table_name, c.conname`,
      `SELECT tablename, indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = 'public'
       ORDER BY tablename, indexname`,
    ];
    const freshPool = new Pool({ connectionString: freshUrl });
    const upgradePool = new Pool({ connectionString: upgradeUrl });
    const checkpointPool = new Pool({ connectionString: checkpointUrl });
    try {
      for (const query of topologyQueries) {
        const [fresh, upgraded, checkpoint] = await Promise.all([
          freshPool.query(query),
          upgradePool.query(query),
          checkpointPool.query(query),
        ]);
        assert.deepEqual(upgraded.rows, fresh.rows);
        assert.deepEqual(checkpoint.rows, fresh.rows);
      }
      const checksums = await upgradePool.query(
        'SELECT count(*)::int AS count FROM schema_migrations WHERE checksum IS NULL'
      );
      assert.equal(checksums.rows[0].count, 0);
      const checkpointMigration = await checkpointPool.query(
        "SELECT count(*)::int AS count FROM schema_migrations WHERE name ~ '^(015|016|017|018|019|020)_'"
      );
      assert.equal(checkpointMigration.rows[0].count, 6);
    } finally {
      await freshPool.end();
      await upgradePool.end();
      await checkpointPool.end();
    }
  } finally {
    await fs.rm(oldMigrationDirectory, { recursive: true, force: true });
    await fs.rm(checkpointMigrationDirectory, { recursive: true, force: true });
    await dropTestDatabase(freshName);
    await dropTestDatabase(upgradeName);
    await dropTestDatabase(checkpointName);
  }
});

test('migration 020 upgrades a database at migration 019 and repeated startup stays safe', async () => {
  const databaseName = 'amber_rbac_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preRbacDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-pre-rbac-migrations-'));
  try {
    const migrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => fileName.endsWith('.sql') && !fileName.startsWith('020_'));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(serverRoot, 'migrations', fileName),
      path.resolve(preRbacDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      (async () => {
        await runMigrations({ directory: ${JSON.stringify(preRbacDirectory)} });
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    const upgradePool = new Pool({ connectionString: databaseUrl });
    try {
      assert.equal(
        (await upgradePool.query("SELECT to_regclass('public.application_users') AS name"))
          .rows[0].name,
        null
      );
      assert.equal(
        (await upgradePool.query(
          "SELECT count(*)::int AS count FROM schema_migrations WHERE name = '019_postgres_session_store.sql'"
        )).rows[0].count,
        1
      );
    } finally {
      await upgradePool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      (async () => {
        await runMigrations();
        await runMigrations();
        const counts = await db.query(
          'SELECT (SELECT count(*) FROM permissions)::int AS permissions, '
            + '(SELECT count(*) FROM roles)::int AS roles, '
            + '(SELECT count(*) FROM role_permissions)::int AS mappings'
        );
        if (counts.rows[0].permissions !== 23
            || counts.rows[0].roles !== 3
            || counts.rows[0].mappings !== 45) {
          throw new Error('Unexpected RBAC seed counts: ' + JSON.stringify(counts.rows[0]));
        }
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);
  } finally {
    await fs.rm(preRbacDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('first-Administrator bootstrap is verified, transactional, concurrent-safe, and permanently one-use', async () => {
  const databaseName = 'amber_bootstrap_admin_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  await runNodeInDatabase(databaseUrl, `
    const db = require('./src/db/pool');
    const { runMigrations } = require('./src/db/run-migrations');
    runMigrations()
      .finally(() => db.end())
      .catch((error) => { console.error(error); process.exitCode = 1; });
  `);
  const bootstrapPool = new Pool({ connectionString: databaseUrl, max: 4 });
  try {
    const unlinked = await bootstrapPool.query(
      "INSERT INTO application_users (status) VALUES ('pending') RETURNING id"
    );
    await assert.rejects(
      bootstrapAdministrator(Number(unlinked.rows[0].id), { databasePool: bootstrapPool }),
      /no verified external identity/
    );

    const pendingUser = await resolveOrCreateApplicationUser({
      issuer: 'https://bootstrap.example/realms/amber',
      sub: 'first-administrator',
      preferred_username: 'first.admin',
      name: 'First Administrator',
      authenticatedAt: '2026-09-09T12:00:00.000Z',
    }, { databasePool: bootstrapPool });
    const attempts = await Promise.allSettled([
      bootstrapAdministrator(pendingUser.id, { databasePool: bootstrapPool }),
      bootstrapAdministrator(pendingUser.id, { databasePool: bootstrapPool }),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === 'rejected').length, 1);
    assert.match(
      attempts.find((attempt) => attempt.status === 'rejected').reason.message,
      /already been completed permanently/
    );

    const access = await getApplicationAccess({
      issuer: 'https://bootstrap.example/realms/amber',
      sub: 'first-administrator',
      authenticatedAt: '2026-09-09T12:00:00.000Z',
    }, { databasePool: bootstrapPool });
    assert.equal(access.applicationUser.status, 'active');
    assert.deepEqual(access.roles, [{ key: 'administrator', displayName: 'Administrator' }]);
    assert.equal(access.permissions.length, 23);
    const state = await bootstrapPool.query(
      `SELECT administrator_user_id, completed_at IS NOT NULL AS completed
       FROM security_bootstrap_state WHERE singleton = TRUE`
    );
    assert.equal(Number(state.rows[0].administrator_user_id), pendingUser.id);
    assert.equal(state.rows[0].completed, true);
    await assert.rejects(
      bootstrapAdministrator(pendingUser.id, { databasePool: bootstrapPool }),
      /already been completed permanently/
    );
  } finally {
    await bootstrapPool.end();
    await dropTestDatabase(databaseName);
  }
});

test('legacy in-progress correction requests survive migration 018 and can be claimed once', async () => {
  const databaseName = 'amber_legacy_claim_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preClaimDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-claim-migrations-')
  );
  try {
    const migrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('018_')
        && !fileName.startsWith('020_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(serverRoot, 'migrations', fileName),
      path.resolve(preClaimDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preClaimDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const legacyPool = new Pool({ connectionString: databaseUrl });
    let legacyRequestId;
    try {
      await legacyPool.query(
        "INSERT INTO categories (code, name, requires_weight) VALUES ('CL', 'Claim legacy', 0)"
      );
      const question = await legacyPool.query(`
        INSERT INTO questions
          (category_code, key, label, sku_index, display_order, required,
           include_in_sku, input_type)
        VALUES ('CL', 'kind', 'Kind', 1, 1, 1, 1, 'options')
        RETURNING id
      `);
      await legacyPool.query(
        `INSERT INTO options (question_id, value_id, sku_code, label)
         VALUES ($1, 1, '1', 'One'), ($1, 2, '2', 'Two')`,
        [question.rows[0].id]
      );
      const scenario = await legacyPool.query(`
        INSERT INTO price_scenarios
          (category_code, name, match_json, axis_x_key, price_mode, status)
        VALUES ('CL', 'Claim prices', '{}'::jsonb, 'kind', 'fixed_uah', 'active')
        RETURNING id
      `);
      await legacyPool.query(
        `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
         VALUES ($1, 1, 0, 100), ($1, 2, 0, 200)`,
        [scenario.rows[0].id]
      );
      const products = await legacyPool.query(`
        INSERT INTO products
          (full_sku, base_sku, sequence_number, category, weight, total_price,
           total_price_uah, price_per_gram, details, status)
        VALUES
          ('CL1001', 'CL1', 1, 'CL', 0, 100, 100, 0,
           '{"answers":{"kind":1},"isCalibrated":0}'::jsonb, 'active'),
          ('CL1002', 'CL1', 2, 'CL', 0, 100, 100, 0,
           '{"answers":{"kind":1},"isCalibrated":0}'::jsonb, 'active')
        RETURNING id, full_sku
      `);
      await runNodeInDatabase(databaseUrl, `
        const db = require('./src/db/pool');
        const { ensureLegacySkuSchemas } = require('./src/services/sku-schema.service');
        ensureLegacySkuSchemas()
          .finally(() => db.end())
          .catch((error) => { console.error(error); process.exitCode = 1; });
      `);
      const firstProduct = products.rows.find((row) => row.full_sku === 'CL1001');
      const inserted = await legacyPool.query(
        `INSERT INTO correction_requests
          (source_product_id, category_code, source_sku, proposed_sku, old_payload,
           proposed_payload, changes, status, preview_signature)
         VALUES ($1, 'CL', 'CL1001', 'CL2001', '{}'::jsonb,
                 '{"answers":{"kind":2}}'::jsonb,
                 '[]'::jsonb, 'in_progress', 'legacy-signature')
         RETURNING id`,
        [firstProduct.id]
      );
      legacyRequestId = Number(inserted.rows[0].id);
    } finally {
      await legacyPool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const assert = require('node:assert/strict');
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      const { claimCorrectionRequest } = require('./src/services/correction-request.service');
      (async () => {
        await runMigrations();
        const before = await db.query(
          'SELECT status, claim_token_hash, claimed_at FROM correction_requests WHERE id = $1',
          [${legacyRequestId}]
        );
        assert.deepEqual(before.rows[0], {
          status: 'in_progress', claim_token_hash: null, claimed_at: null,
        });
        const claimed = await claimCorrectionRequest(${legacyRequestId});
        assert.equal(claimed.request.status, 'in_progress');
        assert.ok(claimed.claimToken);
        await assert.rejects(claimCorrectionRequest(${legacyRequestId}), /інший працівник/);
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const upgradedPool = new Pool({ connectionString: databaseUrl });
    try {
      const claimed = await upgradedPool.query(
        `SELECT status, claim_token_hash, claimed_at
         FROM correction_requests WHERE id = $1`,
        [legacyRequestId]
      );
      assert.equal(claimed.rows[0].status, 'in_progress');
      assert.ok(claimed.rows[0].claim_token_hash);
      assert.ok(claimed.rows[0].claimed_at);
      const secondProduct = await upgradedPool.query(
        "SELECT id FROM products WHERE full_sku = 'CL1002'"
      );
      await assert.rejects(
        upgradedPool.query(
          `INSERT INTO correction_requests
            (source_product_id, category_code, source_sku, proposed_sku, old_payload,
             proposed_payload, changes, status, preview_signature)
           VALUES ($1, 'CL', 'CL1002', 'CL2002', '{}'::jsonb, '{}'::jsonb,
                   '[]'::jsonb, 'in_progress', 'new-invalid-signature')`,
          [secondProduct.rows[0].id]
        ),
        (error) => error.code === '23514'
      );
    } finally {
      await upgradedPool.end();
    }
  } finally {
    await fs.rm(preClaimDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('legacy zero prices upgrade without repricing products or blocking edits', async () => {
  const databaseName = 'amber_legacy_zero_price_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preCompatibilityDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-zero-compat-migrations-')
  );
  try {
    const migrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => fileName.endsWith('.sql') && !/^(014|015|016)_/.test(fileName));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(serverRoot, 'migrations', fileName),
      path.resolve(preCompatibilityDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preCompatibilityDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const legacyPool = new Pool({ connectionString: databaseUrl });
    try {
      await legacyPool.query(`
        INSERT INTO categories (code, name, requires_weight)
        VALUES ('LX', 'Legacy zero', 0);

        WITH inserted_question AS (
          INSERT INTO questions
            (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
          VALUES ('LX', 'kind', 'Kind', 1, 1, 1, 1, 'options')
          RETURNING id
        )
        INSERT INTO options (question_id, value_id, sku_code, label)
        SELECT id, 1, '1', 'One' FROM inserted_question
        UNION ALL
        SELECT id, 2, '2', 'Two' FROM inserted_question;

        WITH inserted_scenario AS (
          INSERT INTO price_scenarios
            (category_code, name, match_json, axis_x_key, axis_y_key, price_mode, status)
          VALUES ('LX', 'Current automatic price', '{}'::jsonb, 'kind', NULL, 'fixed_uah', 'active')
          RETURNING id
        )
        INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
        SELECT id, 1, 0, 1000 FROM inserted_scenario
        UNION ALL
        SELECT id, 2, 0, 0 FROM inserted_scenario;

        INSERT INTO products
          (full_sku, base_sku, sequence_number, category, weight, total_price,
           total_price_uah, price_per_gram, details)
        VALUES
          ('LX1001', 'LX1', 1, 'LX', 0, 0, 0, 0, '{"answers":{"kind":1}}'::jsonb);
      `);
    } finally {
      await legacyPool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const assert = require('node:assert/strict');
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      const { ensureLegacySkuSchemas } = require('./src/services/sku-schema.service');
      const { applyProductRecount, decodeSku } = require('./src/services/product.service');
      (async () => {
        await runMigrations();
        await ensureLegacySkuSchemas();

        const decoded = await decodeSku('LX1001');
        assert.equal(decoded.pricing.totalPriceUah, 0);
        assert.equal(decoded.pricing.calculatedPriceUah, null);

        const correction = await applyProductRecount({
          sourceSku: 'LX1001',
          answers: { kind: 2 },
          reason: 'still editable',
          manualPriceUah: 500,
        });
        assert.equal(correction.success, true);
        assert.equal(correction.corrected.totalPriceUah, 500);
        await assert.rejects(
          db.query(
            "INSERT INTO products "
              + "(full_sku, base_sku, sequence_number, category, total_price_uah, details) "
              + "VALUES ('LX1999', 'LX1', 999, 'LX', 0, '{}'::jsonb)"
          ),
          (error) => error.code === '23514'
        );
      })()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      const state = await verifiedPool.query(`
        SELECT p.total_price_uah, p.legacy_uah_price_unset,
               p.correction_reason, p.sku_schema_version_id, p.corrected_to_product_id,
               corrected.total_price_uah AS corrected_price_uah,
               (SELECT count(*)::int FROM price_matrix WHERE price = 0) AS zero_matrix_rows,
               (SELECT count(*)::int FROM price_matrix WHERE price = 1000) AS positive_matrix_rows
        FROM products p
        LEFT JOIN products corrected ON corrected.id = p.corrected_to_product_id
        WHERE p.full_sku = 'LX1001'
      `);
      assert.equal(Number(state.rows[0].total_price_uah), 0);
      assert.equal(state.rows[0].legacy_uah_price_unset, true);
      assert.equal(state.rows[0].correction_reason, 'still editable');
      assert.ok(Number(state.rows[0].sku_schema_version_id) > 0);
      assert.ok(Number(state.rows[0].corrected_to_product_id) > 0);
      assert.equal(Number(state.rows[0].corrected_price_uah), 500);
      assert.equal(state.rows[0].zero_matrix_rows, 0);
      assert.equal(state.rows[0].positive_matrix_rows, 1);
    } finally {
      await verifiedPool.end();
    }
  } finally {
    await fs.rm(preCompatibilityDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('duplicate question invariant is atomic across independent transactions', async () => {
  const questionKey = `concurrent_question_${Date.now()}`;
  const worker = async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO questions
         (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
         VALUES ('ZZ', $1, 'Concurrent', 99, 99, 0, 0, 'text')`,
        [questionKey]
      );
      await client.query('SELECT pg_sleep(0.15)');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const outcomes = await Promise.allSettled([worker(), worker()]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.equal(outcomes.find((outcome) => outcome.status === 'rejected').reason.code, '23505');
  const stored = await pool.query(
    'SELECT count(*)::int AS count FROM questions WHERE category_code = $1 AND key = $2',
    ['ZZ', questionKey]
  );
  assert.equal(stored.rows[0].count, 1);
});

test('price-cell API stores only positive prices and treats empty or missing price as deletion', async () => {
  const cell = {
    scenario_id: schemas.ZZScenario,
    x_val: 999,
    y_val: 0,
  };
  const readCell = () => pool.query(
    `SELECT price FROM price_matrix
     WHERE scenario_id = $1 AND x_val = $2 AND y_val = $3`,
    [cell.scenario_id, cell.x_val, cell.y_val]
  );

  try {
    const created = await request('/api/admin/price-cell', {
      method: 'POST',
      body: { ...cell, price: '12.50' },
    });
    assert.equal(created.response.status, 200, created.text);
    assert.equal(Number((await readCell()).rows[0].price), 12.5);

    const zero = await request('/api/admin/price-cell', {
      method: 'POST',
      body: { ...cell, price: 0 },
    });
    assert.equal(zero.response.status, 400, zero.text);
    assert.match(zero.data.error, /більшим за 0/);
    assert.equal(Number((await readCell()).rows[0].price), 12.5);

    const blank = await request('/api/admin/price-cell', {
      method: 'POST',
      body: { ...cell, price: '   ' },
    });
    assert.equal(blank.response.status, 200, blank.text);
    assert.equal((await readCell()).rows.length, 0);

    await request('/api/admin/price-cell', {
      method: 'POST',
      body: { ...cell, price: 8 },
    });
    const missing = await request('/api/admin/price-cell', {
      method: 'POST',
      body: cell,
    });
    assert.equal(missing.response.status, 200, missing.text);
    assert.equal((await readCell()).rows.length, 0);
  } finally {
    await pool.query(
      `DELETE FROM price_matrix
       WHERE scenario_id = $1 AND x_val = $2 AND y_val = $3`,
      [cell.scenario_id, cell.x_val, cell.y_val]
    );
  }
});

test('preview/save are authoritative and concurrent sequences are unique', async () => {
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0 },
  });
  assert.equal(preview.response.status, 200);
  const payload = {
    category: 'ZZ',
    answers: { kind: 1 },
    weight: 0,
    skuSchemaVersionId: schemas.ZZ,
    previewToken: preview.data.previewToken,
    fullSku: 'ATTACKER-SKU',
    totalPriceUah: 1,
    baseSku: 'WRONG',
  };
  const saved = await request('/api/save', { method: 'POST', body: payload });
  assert.equal(saved.response.status, 200, saved.text);
  primarySku = saved.data.fullSku;
  assert.notEqual(primarySku, 'ATTACKER-SKU');
  const stored = await pool.query(
    'SELECT full_sku, base_sku, total_price_uah FROM products WHERE id = $1',
    [saved.data.id]
  );
  assert.equal(Number(stored.rows[0].total_price_uah), 1000);
  assert.equal(stored.rows[0].base_sku, preview.data.baseSku);

  const concurrent = await Promise.all([
    request('/api/save', { method: 'POST', body: payload }),
    request('/api/save', { method: 'POST', body: payload }),
  ]);
  assert.deepEqual(concurrent.map((item) => item.response.status), [200, 200]);
  assert.equal(new Set(concurrent.map((item) => item.data.fullSku)).size, 2);
  const concurrentStored = await pool.query(
    `SELECT full_sku, sequence_number
     FROM products
     WHERE full_sku = ANY($1::text[])
     ORDER BY sequence_number`,
    [concurrent.map((item) => item.data.fullSku)]
  );
  assert.equal(concurrentStored.rows.length, 2);
  assert.equal(new Set(concurrentStored.rows.map((row) => Number(row.sequence_number))).size, 2);
});

test('save rejects a preview after authoritative pricing changes', async () => {
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 2 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(preview.response.status, 200, preview.text);
  const countBefore = await pool.query(
    `SELECT count(*)::int AS count FROM products
     WHERE category = 'ZZ' AND details->'answers'->>'kind' = '2'`
  );
  try {
    const changedMatrix = await pool.query(
      'UPDATE price_matrix SET price = price + 25 WHERE scenario_id = $1 AND x_val = 2',
      [schemas.ZZScenario]
    );
    assert.equal(changedMatrix.rowCount, 1);
    const changedPreview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 2 }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(changedPreview.response.status, 200, changedPreview.text);
    assert.notEqual(changedPreview.data.previewToken, preview.data.previewToken);
    const staleSave = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind: 2 },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: preview.data.previewToken,
      },
    });
    assert.equal(staleSave.response.status, 409, staleSave.text);
    const countAfter = await pool.query(
      `SELECT count(*)::int AS count FROM products
       WHERE category = 'ZZ' AND details->'answers'->>'kind' = '2'`
    );
    assert.equal(countAfter.rows[0].count, countBefore.rows[0].count);
  } finally {
    await pool.query(
      'UPDATE price_matrix SET price = price - 25 WHERE scenario_id = $1 AND x_val = 2',
      [schemas.ZZScenario]
    );
  }
});

test('automatic marketing rounding is persisted through save, decode, and recount while manual prices stay exact', async () => {
  const originalCells = await pool.query(
    `SELECT x_val, y_val, price
     FROM price_matrix
     WHERE scenario_id = $1 AND x_val = ANY($2::int[])
     ORDER BY x_val`,
    [schemas.ZZScenario, [1, 2]]
  );
  assert.equal(originalCells.rows.length, 2);
  const createdProductIds = [];

  try {
    await pool.query(
      `UPDATE price_matrix
       SET price = CASE x_val WHEN 1 THEN 2556 ELSE 918 END
       WHERE scenario_id = $1 AND x_val = ANY($2::int[])`,
      [schemas.ZZScenario, [1, 2]]
    );
    const stalePreview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(stalePreview.response.status, 200, stalePreview.text);
    assert.equal(stalePreview.data.calculatedPriceUah, 2556);
    assert.equal(stalePreview.data.totalPriceUah, 2550);

    await pool.query(
      'UPDATE price_matrix SET price = 3943 WHERE scenario_id = $1 AND x_val = 1',
      [schemas.ZZScenario]
    );
    const staleSave = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind: 1 },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: stalePreview.data.previewToken,
      },
    });
    assert.equal(staleSave.response.status, 409, staleSave.text);

    const automaticPreview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(automaticPreview.data.calculatedPriceUah, 3943);
    assert.equal(automaticPreview.data.totalPriceUah, 3950);
    const automatic = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind: 1 },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: automaticPreview.data.previewToken,
      },
    });
    assert.equal(automatic.response.status, 200, automatic.text);
    createdProductIds.push(Number(automatic.data.id));

    await pool.query(
      'UPDATE price_matrix SET price = 1536 WHERE scenario_id = $1 AND x_val = 1',
      [schemas.ZZScenario]
    );
    const decodedAutomatic = await request('/api/decode', {
      method: 'POST', body: { sku: automatic.data.fullSku },
    });
    assert.equal(decodedAutomatic.response.status, 200, decodedAutomatic.text);
    assert.equal(decodedAutomatic.data.pricing.calculatedPriceUah, 3943);
    assert.equal(decodedAutomatic.data.pricing.automaticPriceUah, 3950);
    assert.equal(decodedAutomatic.data.pricing.totalPriceUah, 3950);

    const manualPreview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(manualPreview.data.calculatedPriceUah, 1536);
    assert.equal(manualPreview.data.totalPriceUah, 1550);
    const manual = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind: 1 },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: manualPreview.data.previewToken,
        manualPriceUah: 613.25,
      },
    });
    assert.equal(manual.response.status, 200, manual.text);
    createdProductIds.push(Number(manual.data.id));
    const storedManual = await pool.query(
      'SELECT total_price_uah, details FROM products WHERE id = $1',
      [manual.data.id]
    );
    assert.equal(Number(storedManual.rows[0].total_price_uah), 613.25);
    assert.equal(Number(storedManual.rows[0].details.manualPriceUah), 613.25);
    assert.equal(Number(storedManual.rows[0].details.calculatedPriceUah), 1536);
    assert.equal(Number(storedManual.rows[0].details.autoPriceUah), 1550);
    const decodedManual = await request('/api/decode', {
      method: 'POST', body: { sku: manual.data.fullSku },
    });
    assert.equal(decodedManual.response.status, 200, decodedManual.text);
    assert.equal(decodedManual.data.pricing.calculatedPriceUah, 1536);
    assert.equal(decodedManual.data.pricing.automaticPriceUah, 1550);
    assert.equal(decodedManual.data.pricing.totalPriceUah, 613.25);

    const recountPreview = await request('/api/recount/preview', {
      method: 'POST',
      body: {
        sourceSku: automatic.data.fullSku,
        answers: { kind: 2 },
        reason: 'marketing rounding integration',
      },
    });
    assert.equal(recountPreview.response.status, 200, recountPreview.text);
    assert.equal(recountPreview.data.corrected.calculatedPriceUah, 918);
    assert.equal(recountPreview.data.corrected.autoPriceUah, 900);
    assert.equal(recountPreview.data.corrected.totalPriceUah, 900);
    const recounted = await request('/api/recount/apply', {
      method: 'POST',
      body: {
        sourceSku: automatic.data.fullSku,
        answers: { kind: 2 },
        reason: 'marketing rounding integration',
      },
    });
    assert.equal(recounted.response.status, 200, recounted.text);
    createdProductIds.push(Number(recounted.data.correctedProductId));
    const storedRecount = await pool.query(
      'SELECT total_price_uah, details FROM products WHERE id = $1',
      [recounted.data.correctedProductId]
    );
    assert.equal(Number(storedRecount.rows[0].total_price_uah), 900);
    assert.equal(Number(storedRecount.rows[0].details.calculatedPriceUah), 918);
    assert.equal(Number(storedRecount.rows[0].details.autoPriceUah), 900);
    assert.equal(storedRecount.rows[0].details.manualPriceUah, null);
  } finally {
    for (const cell of originalCells.rows) {
      await pool.query(
        `UPDATE price_matrix SET price = $1
         WHERE scenario_id = $2 AND x_val = $3 AND y_val = $4`,
        [cell.price, schemas.ZZScenario, cell.x_val, cell.y_val]
      );
    }
    if (createdProductIds.length > 0) {
      await pool.query(
        `UPDATE products SET status = 'archived', exclude_from_export = 1
         WHERE id = ANY($1::int[])`,
        [createdProductIds]
      );
    }
  }
});

test('required answers, weight, schema ownership, and manual fallback fail closed', async () => {
  const missing = await request('/api/preview', {
    method: 'POST', body: { categoryCode: 'ZZ', answers: {}, weight: 0 },
  });
  assert.equal(missing.response.status, 422);
  const weight = await request('/api/preview', {
    method: 'POST', body: { categoryCode: 'WW', answers: { kind: 1 }, weight: 0 },
  });
  assert.equal(weight.response.status, 422);
  const wrongSchema = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      skuSchemaVersionId: schemas.ZZ, previewToken: 'wrong', manualPriceUah: 200,
    },
  });
  assert.equal(wrongSchema.response.status, 422);

  const noPricePreview = await request('/api/preview', {
    method: 'POST',
    body: {
      categoryCode: 'MM', answers: { kind: 1 }, weight: 0, isCalibrated: 0,
    },
  });
  assert.equal(noPricePreview.response.status, 200, noPricePreview.text);

  const legacyPayload = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      skuSchemaVersionId: schemas.MM, manualPriceUah: 321,
    },
  });
  assert.equal(legacyPayload.response.status, 422);
  assert.match(legacyPayload.data.error, /previewToken/);

  const noAuto = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      isCalibrated: null,
      skuSchemaVersionId: schemas.MM, previewToken: noPricePreview.data.previewToken,
    },
  });
  assert.equal(noAuto.response.status, 422);
  assert.match(noAuto.data.error, /Вкажіть ціну вручну/);
  const zeroManual = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      isCalibrated: null,
      skuSchemaVersionId: schemas.MM, previewToken: noPricePreview.data.previewToken,
      manualPriceUah: 0,
    },
  });
  assert.equal(zeroManual.response.status, 422);
  assert.match(zeroManual.data.error, /більшою за 0/);
  const manual = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      isCalibrated: null,
      skuSchemaVersionId: schemas.MM, previewToken: noPricePreview.data.previewToken,
      manualPriceUah: 321,
    },
  });
  assert.equal(manual.response.status, 200, manual.text);
  const stored = await pool.query('SELECT total_price_uah FROM products WHERE id = $1', [manual.data.id]);
  assert.equal(Number(stored.rows[0].total_price_uah), 321);

  const malformedPreview = await request('/api/preview', {
    method: 'POST', body: { categoryCode: 'MM', answers: { kind: 2 }, weight: 0 },
  });
  const malformedManual = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 2 }, weight: 0,
      skuSchemaVersionId: schemas.MM, previewToken: malformedPreview.data.previewToken,
      manualPriceUah: true,
    },
  });
  assert.equal(malformedManual.response.status, 422);
});

test('correction applies a manual price when the target configuration has no matrix cell', async () => {
  const sourcePreview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(sourcePreview.response.status, 200, sourcePreview.text);
  const source = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: sourcePreview.data.previewToken,
    },
  });
  assert.equal(source.response.status, 200, source.text);

  const removedCell = await pool.query(
    'DELETE FROM price_matrix WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0 RETURNING price',
    [schemas.ZZScenario]
  );
  assert.equal(removedCell.rowCount, 1);
  try {
    const preview = await request('/api/recount/preview', {
      method: 'POST',
      body: { sourceSku: source.data.fullSku, answers: { kind: 2 }, reason: 'manual correction' },
    });
    assert.equal(preview.response.status, 200, preview.text);
    assert.equal(preview.data.corrected.totalPriceUah, null);

    const zeroManual = await request('/api/recount/apply', {
      method: 'POST',
      body: {
        sourceSku: source.data.fullSku,
        answers: { kind: 2 },
        reason: 'manual correction',
        manualPriceUah: 0,
      },
    });
    assert.equal(zeroManual.response.status, 422, zeroManual.text);
    assert.match(zeroManual.data.error, /більшою за 0/);

    const applied = await request('/api/recount/apply', {
      method: 'POST',
      body: {
        sourceSku: source.data.fullSku,
        answers: { kind: 2 },
        reason: 'manual correction',
        manualPriceUah: 725,
      },
    });
    assert.equal(applied.response.status, 200, applied.text);
    assert.equal(applied.data.corrected.manualPriceUah, 725);
    const stored = await pool.query(
      'SELECT total_price_uah, details FROM products WHERE id = $1',
      [applied.data.correctedProductId]
    );
    assert.equal(Number(stored.rows[0].total_price_uah), 725);
    assert.equal(Number(stored.rows[0].details.manualPriceUah), 725);
    assert.equal(stored.rows[0].details.autoPriceUah, null);
  } finally {
    await pool.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       VALUES ($1, 2, 0, $2)
       ON CONFLICT (scenario_id, x_val, y_val) DO UPDATE SET price = EXCLUDED.price`,
      [schemas.ZZScenario, removedCell.rows[0].price]
    );
  }
});

test('exchange-rate cache never lets an older replica overwrite a newer fetch', async () => {
  const olderFetchedAt = '2026-08-30T10:00:00.000Z';
  const newerFetchedAt = '2026-08-31T10:00:00.000Z';
  await pool.query("DELETE FROM exchange_rate_cache WHERE currency_pair = 'USD_UAH'");
  await pool.query(`
    CREATE OR REPLACE FUNCTION delay_older_exchange_rate_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.fetched_at = TIMESTAMPTZ '2026-08-30 10:00:00+00' THEN
        PERFORM pg_sleep(0.2);
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER delay_older_exchange_rate_write
    BEFORE INSERT OR UPDATE ON exchange_rate_cache
    FOR EACH ROW EXECUTE FUNCTION delay_older_exchange_rate_write();
  `);
  try {
    const olderWrite = saveLastKnownRate({
      rate: 40,
      rateDate: '2026-08-30',
      fetchedAt: olderFetchedAt,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const newerWrite = saveLastKnownRate({
      rate: 41,
      rateDate: '2026-08-31',
      fetchedAt: newerFetchedAt,
    });
    await Promise.all([olderWrite, newerWrite]);
    const stored = await pool.query(
      "SELECT rate, fetched_at FROM exchange_rate_cache WHERE currency_pair = 'USD_UAH'"
    );
    assert.equal(Number(stored.rows[0].rate), 41);
    assert.equal(new Date(stored.rows[0].fetched_at).toISOString(), newerFetchedAt);
  } finally {
    await pool.query('DROP TRIGGER delay_older_exchange_rate_write ON exchange_rate_cache');
    await pool.query('DROP FUNCTION delay_older_exchange_rate_write()');
  }
});

test('used category code is immutable while metadata remains editable', async () => {
  const changedCode = await request('/api/admin/category', {
    method: 'PUT',
    body: { code: 'ZZ', next_code: 'ZX', name: 'Renamed', requires_weight: 0 },
  });
  assert.equal(changedCode.response.status, 409);
  const metadata = await request('/api/admin/category', {
    method: 'PUT',
    body: { code: 'ZZ', next_code: 'ZZ', name: 'Renamed', requires_weight: 0 },
  });
  assert.equal(metadata.response.status, 200, metadata.text);
});

test('concurrent correction only applies once after transactional revalidation', async () => {
  const correctionPayload = { sourceSku: primarySku, answers: { kind: 2 }, reason: 'integration' };
  const preview = await request('/api/recount/preview', { method: 'POST', body: correctionPayload });
  assert.equal(preview.response.status, 200, preview.text);
  const results = await Promise.all([
    request('/api/recount/apply', { method: 'POST', body: correctionPayload }),
    request('/api/recount/apply', { method: 'POST', body: correctionPayload }),
  ]);
  assert.deepEqual(results.map((item) => item.response.status).sort(), [200, 409]);
  const sourceState = await pool.query(
    `SELECT id, status, corrected_to_product_id
     FROM products WHERE full_sku = $1`,
    [primarySku]
  );
  assert.equal(sourceState.rows[0].status, 'corrected');
  assert.ok(Number(sourceState.rows[0].corrected_to_product_id) > 0);
  const correctionState = await pool.query(
    `SELECT count(*)::int AS correction_count,
            count(DISTINCT corrected_product_id)::int AS corrected_products
     FROM product_corrections
     WHERE source_product_id = $1`,
    [sourceState.rows[0].id]
  );
  assert.deepEqual(correctionState.rows[0], {
    correction_count: 1,
    corrected_products: 1,
  });
});

test('active correction requests stay FIFO when another worker claims a newer request', async () => {
  const skus = ['ZZQUEUE001', 'ZZQUEUE002', 'ZZQUEUE003', 'ZZQUEUE004'];
  let productIds = [];
  try {
    const products = await pool.query(
      `INSERT INTO products
         (full_sku, base_sku, sequence_number, category, weight, total_price,
          total_price_uah, price_per_gram, uah_rate, details, sku_schema_version_id)
       VALUES
         ($1, 'ZZQUEUE', 1, 'ZZ', 0, 25, 1000, 0, 40, '{"answers":{"kind":1}}'::jsonb, $5),
         ($2, 'ZZQUEUE', 2, 'ZZ', 0, 25, 1000, 0, 40, '{"answers":{"kind":1}}'::jsonb, $5),
         ($3, 'ZZQUEUE', 3, 'ZZ', 0, 25, 1000, 0, 40, '{"answers":{"kind":1}}'::jsonb, $5),
         ($4, 'ZZQUEUE', 4, 'ZZ', 0, 25, 1000, 0, 40, '{"answers":{"kind":1}}'::jsonb, $5)
       RETURNING id`,
      [...skus, schemas.ZZ]
    );
    productIds = products.rows.map((row) => Number(row.id));
    const inserted = await pool.query(
      `INSERT INTO correction_requests
         (source_product_id, category_code, source_sku, proposed_sku, old_payload,
          proposed_payload, changes, comment, status, preview_signature,
          claim_token_hash, claimed_at, created_at, updated_at)
       VALUES
         ($1, 'ZZ', $5, 'ZZQUEUE101', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
          'oldest pending', 'pending', 'queue-1', NULL, NULL,
          '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z'),
         ($2, 'ZZ', $6, 'ZZQUEUE102', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
          'same-time first', 'pending', 'queue-2', NULL, NULL,
          '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z'),
         ($3, 'ZZ', $7, 'ZZQUEUE103', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
          'same-time second', 'pending', 'queue-3', NULL, NULL,
          '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z'),
         ($4, 'ZZ', $8, 'ZZQUEUE104', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
          'newer external claim', 'in_progress', 'queue-4', repeat('a', 64),
          '2026-09-01T10:00:00Z', '2026-01-03T10:00:00Z', '2026-09-01T10:00:00Z')
       RETURNING id
       `,
      [...productIds, ...skus]
    );
    const requestIds = inserted.rows.map((row) => Number(row.id));

    const active = await request('/api/admin/correction-requests?status=active');
    assert.equal(active.response.status, 200, active.text);
    const fixtureItems = active.data.items.filter((item) => requestIds.includes(Number(item.id)));
    assert.deepEqual(
      fixtureItems.map((item) => Number(item.id)),
      requestIds,
      'created_at ASC and id ASC must win over claim status and updated_at'
    );
    assert.deepEqual(
      fixtureItems.map((item) => item.status),
      ['pending', 'pending', 'pending', 'in_progress']
    );
  } finally {
    if (productIds.length > 0) {
      await pool.query('DELETE FROM correction_requests WHERE source_product_id = ANY($1::int[])', [productIds]);
      await pool.query('DELETE FROM products WHERE id = ANY($1::int[])', [productIds]);
      await pool.query('DELETE FROM sku_registry WHERE full_sku = ANY($1::text[])', [skus]);
    }
  }
});

test('correction request claims are exclusive, persistent, and owner-authoritative', async () => {
  const productPreview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(productPreview.response.status, 200, productPreview.text);
  const product = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: productPreview.data.previewToken,
    },
  });
  assert.equal(product.response.status, 200, product.text);
  const created = await request('/api/admin/correction-requests', {
    method: 'POST',
    body: {
      sourceSku: product.data.fullSku,
      answers: { kind: 2 },
      reason: 'exclusive claim integration',
    },
  });
  assert.equal(created.response.status, 200, created.text);
  const requestId = Number(created.data.request.id);
  const genericClaim = await request(`/api/admin/correction-requests/${requestId}/status`, {
    method: 'PATCH', body: { status: 'in_progress' },
  });
  assert.equal(genericClaim.response.status, 400, genericClaim.text);

  const lockClient = await pool.connect();
  await lockClient.query('BEGIN');
  await lockClient.query('SELECT id FROM correction_requests WHERE id = $1 FOR UPDATE', [requestId]);
  const competingClaims = [
    request(`/api/admin/correction-requests/${requestId}/claim`, { method: 'POST', body: {} }),
    request(`/api/admin/correction-requests/${requestId}/claim`, { method: 'POST', body: {} }),
  ];
  await new Promise((resolve) => setTimeout(resolve, 50));
  await lockClient.query('COMMIT');
  lockClient.release();

  const claimResults = await Promise.all(competingClaims);
  assert.deepEqual(claimResults.map((item) => item.response.status).sort(), [200, 409]);
  const winningClaim = claimResults.find((item) => item.response.status === 200).data;
  assert.ok(winningClaim.claimToken.length >= 32);
  assert.ok(winningClaim.request.claimFingerprint);
  const claimedState = await pool.query(
    `SELECT status, claim_token_hash, claimed_at
     FROM correction_requests WHERE id = $1`,
    [requestId]
  );
  assert.equal(claimedState.rows[0].status, 'in_progress');
  assert.ok(claimedState.rows[0].claim_token_hash);
  assert.notEqual(claimedState.rows[0].claim_token_hash, winningClaim.claimToken);
  assert.ok(claimedState.rows[0].claimed_at);
  const listed = await request('/api/admin/correction-requests?status=active');
  assert.equal(listed.response.status, 200, listed.text);
  const listedClaim = listed.data.items.find((item) => Number(item.id) === requestId);
  assert.equal(listedClaim.claimFingerprint, winningClaim.request.claimFingerprint);
  assert.equal(Object.hasOwn(listedClaim, 'claimTokenHash'), false);

  const wrongHeaders = { 'X-Correction-Claim-Token': 'x'.repeat(43) };
  const wrongRelease = await request(
    `/api/admin/correction-requests/${requestId}/release`,
    { method: 'POST', body: {}, headers: wrongHeaders }
  );
  assert.equal(wrongRelease.response.status, 409, wrongRelease.text);
  const wrongRefresh = await request(
    `/api/admin/correction-requests/${requestId}/refresh`,
    { method: 'POST', body: {}, headers: wrongHeaders }
  );
  assert.equal(wrongRefresh.response.status, 409, wrongRefresh.text);
  const wrongComplete = await request(
    `/api/admin/correction-requests/${requestId}/complete`,
    { method: 'POST', body: {}, headers: wrongHeaders }
  );
  assert.equal(wrongComplete.response.status, 409, wrongComplete.text);
  const wrongReject = await request(`/api/admin/correction-requests/${requestId}/status`, {
    method: 'PATCH', body: { status: 'rejected' }, headers: wrongHeaders,
  });
  assert.equal(wrongReject.response.status, 409, wrongReject.text);

  const ownerHeaders = { 'X-Correction-Claim-Token': winningClaim.claimToken };
  const released = await request(
    `/api/admin/correction-requests/${requestId}/release`,
    { method: 'POST', body: {}, headers: ownerHeaders }
  );
  assert.equal(released.response.status, 200, released.text);
  assert.equal(released.data.request.status, 'pending');
  assert.equal(released.data.request.claimedAt, null);

  const reclaimed = await request(`/api/admin/correction-requests/${requestId}/claim`, {
    method: 'POST', body: {},
  });
  assert.equal(reclaimed.response.status, 200, reclaimed.text);
  const unconfirmedForceRelease = await request(
    `/api/admin/correction-requests/${requestId}/force-release`,
    { method: 'POST', body: { confirm: false } }
  );
  assert.equal(unconfirmedForceRelease.response.status, 400, unconfirmedForceRelease.text);
  const forceReleased = await request(
    `/api/admin/correction-requests/${requestId}/force-release`,
    { method: 'POST', body: { confirm: true } }
  );
  assert.equal(forceReleased.response.status, 200, forceReleased.text);
  assert.equal(forceReleased.data.request.status, 'pending');

  const finalClaim = await request(`/api/admin/correction-requests/${requestId}/claim`, {
    method: 'POST', body: {},
  });
  assert.equal(finalClaim.response.status, 200, finalClaim.text);
  const rejected = await request(`/api/admin/correction-requests/${requestId}/status`, {
    method: 'PATCH',
    body: { status: 'rejected' },
    headers: { 'X-Correction-Claim-Token': finalClaim.data.claimToken },
  });
  assert.equal(rejected.response.status, 200, rejected.text);
  const finalState = await pool.query(
    `SELECT cr.status, cr.claim_token_hash, p.status AS product_status,
            p.corrected_to_product_id
     FROM correction_requests cr
     JOIN products p ON p.id = cr.source_product_id
     WHERE cr.id = $1`,
    [requestId]
  );
  assert.deepEqual(finalState.rows[0], {
    status: 'rejected',
    claim_token_hash: null,
    product_status: 'active',
    corrected_to_product_id: null,
  });
});

test('claim refreshes stale correction data and later changes still block completion', async () => {
  const candidate = await pool.query(
    `SELECT id, full_sku
     FROM products
     WHERE category = 'ZZ'
       AND status = 'active'
       AND details->'answers'->>'kind' = '1'
     ORDER BY id
     LIMIT 1`
  );
  assert.ok(candidate.rows[0]);
  const originalPrice = await pool.query(
    'SELECT price FROM price_matrix WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0',
    [schemas.ZZScenario]
  );
  try {
    const created = await request('/api/admin/correction-requests', {
      method: 'POST',
      body: {
        sourceSku: candidate.rows[0].full_sku,
        answers: { kind: 2 },
        reason: 'stale request integration',
      },
    });
    assert.equal(created.response.status, 200, created.text);
    const requestId = Number(created.data.request.id);
    const originalCalculatedPrice = Number(created.data.request.proposedPayload.calculatedPriceUah);

    const changedSource = await pool.query(
      `UPDATE products
       SET total_price_uah = total_price_uah + 1
       WHERE id = $1
       RETURNING total_price_uah`,
      [candidate.rows[0].id]
    );
    const changedPrice = await pool.query(
      `UPDATE price_matrix
       SET price = price + 613
       WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0
       RETURNING price`,
      [schemas.ZZScenario]
    );

    const claimed = await request(`/api/admin/correction-requests/${requestId}/claim`, {
      method: 'POST', body: {},
    });
    assert.equal(claimed.response.status, 200, claimed.text);
    assert.equal(
      Number(claimed.data.request.oldPayload.totalPriceUah),
      Number(changedSource.rows[0].total_price_uah)
    );
    assert.equal(
      Number(claimed.data.request.proposedPayload.calculatedPriceUah),
      Number(changedPrice.rows[0].price)
    );
    assert.notEqual(
      Number(claimed.data.request.proposedPayload.calculatedPriceUah),
      originalCalculatedPrice
    );
    const claimHeaders = { 'X-Correction-Claim-Token': claimed.data.claimToken };

    await pool.query(
      "UPDATE products SET status = 'archived' WHERE id = $1",
      [candidate.rows[0].id]
    );
    const failedRefresh = await request(
      `/api/admin/correction-requests/${requestId}/refresh`,
      { method: 'POST', body: {}, headers: claimHeaders }
    );
    assert.equal(failedRefresh.response.status, 409);
    const activeAfterRefreshError = await request(
      '/api/admin/correction-requests?status=active'
    );
    const ownedAfterRefreshError = activeAfterRefreshError.data.items.find(
      (item) => Number(item.id) === requestId
    );
    assert.equal(ownedAfterRefreshError.status, 'in_progress');
    assert.equal(
      ownedAfterRefreshError.claimFingerprint,
      claimed.data.request.claimFingerprint,
      'a failed refresh must preserve the existing owner capability'
    );

    const changedAfterClaim = await pool.query(
      `UPDATE products
       SET status = 'active',
           total_price_uah = total_price_uah + 1
       WHERE id = $1
       RETURNING total_price_uah`,
      [candidate.rows[0].id]
    );
    const staleCompletion = await request(
      `/api/admin/correction-requests/${requestId}/complete`,
      { method: 'POST', body: {}, headers: claimHeaders }
    );
    assert.equal(staleCompletion.response.status, 409);
    assert.equal(staleCompletion.data.details?.type, 'stale_correction_request');

    const activeAfterError = await request('/api/admin/correction-requests?status=active');
    const ownedAfterError = activeAfterError.data.items.find(
      (item) => Number(item.id) === requestId
    );
    assert.equal(ownedAfterError.status, 'in_progress');
    assert.equal(
      ownedAfterError.claimFingerprint,
      claimed.data.request.claimFingerprint,
      'a stale completion must not replace or clear claim ownership'
    );

    const released = await request(
      `/api/admin/correction-requests/${requestId}/release`,
      { method: 'POST', body: {}, headers: claimHeaders }
    );
    assert.equal(released.response.status, 200, released.text);
    assert.equal(released.data.request.status, 'pending');

    const reclaimed = await request(`/api/admin/correction-requests/${requestId}/claim`, {
      method: 'POST', body: {},
    });
    assert.equal(reclaimed.response.status, 200, reclaimed.text);
    assert.equal(
      Number(reclaimed.data.request.oldPayload.totalPriceUah),
      Number(changedAfterClaim.rows[0].total_price_uah)
    );
    const completed = await request(
      `/api/admin/correction-requests/${requestId}/complete`,
      {
        method: 'POST',
        body: {},
        headers: { 'X-Correction-Claim-Token': reclaimed.data.claimToken },
      }
    );
    assert.equal(completed.response.status, 200, completed.text);
    const finalState = await pool.query(
      `SELECT p.status, p.corrected_to_product_id, cr.status AS request_status,
              cr.corrected_product_id, cr.claim_token_hash, cr.claimed_at
       FROM products p
       JOIN correction_requests cr ON cr.id = $1
       WHERE p.id = $2`,
      [requestId, candidate.rows[0].id]
    );
    assert.equal(finalState.rows[0].status, 'corrected');
    assert.equal(finalState.rows[0].request_status, 'completed');
    assert.equal(finalState.rows[0].claim_token_hash, null);
    assert.ok(finalState.rows[0].claimed_at);
    assert.equal(
      Number(finalState.rows[0].corrected_to_product_id),
      Number(finalState.rows[0].corrected_product_id)
    );
  } finally {
    await pool.query(
      `UPDATE price_matrix
       SET price = $1
       WHERE scenario_id = $2 AND x_val = 2 AND y_val = 0`,
      [originalPrice.rows[0].price, schemas.ZZScenario]
    );
  }
});

test('repricing preview/apply/rollback and correction blocking work', async () => {
  await pool.query(
    'UPDATE price_matrix SET price = price + 113 WHERE scenario_id = $1',
    [schemas.ZZScenario]
  );
  const preview = await request('/api/admin/repricing/preview', {
    method: 'POST', body: { scenarioId: schemas.ZZScenario },
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.ok(preview.data.summary.changedCount > 0);
  const marketingRoundedItem = preview.data.items.find((item) => (
    item.status === 'changed' && Number(item.calculatedPriceUah) !== Number(item.newPriceUah)
  ));
  assert.ok(marketingRoundedItem);
  assert.equal(Number(marketingRoundedItem.automaticPriceUah), Number(marketingRoundedItem.newPriceUah));
  const manualOverrides = preview.data.items
    .filter((item) => ['manual_price', 'price_missing'].includes(item.errorCode))
    .map((item) => ({
      productId: Number(item.productId),
      newPriceUah: Number(item.oldPriceUah),
    }));
  const applied = await request('/api/admin/repricing/apply', {
    method: 'POST',
    body: {
      scenarioId: schemas.ZZScenario,
      previewToken: preview.data.previewToken,
      manualOverrides,
    },
  });
  assert.equal(applied.response.status, 200, applied.text);
  const batchId = applied.data.batch?.id || applied.data.batchId;
  const appliedItems = await pool.query(
    `SELECT ri.product_id, ri.old_price_uah, ri.new_price_uah,
            p.total_price_uah, p.details #>> '{repricing,batchId}' AS current_batch_id
     FROM repricing_items ri
     JOIN products p ON p.id = ri.product_id
     WHERE ri.batch_id = $1
     ORDER BY ri.product_id`,
    [batchId]
  );
  assert.ok(appliedItems.rows.length > 0);
  for (const item of appliedItems.rows) {
    assert.equal(Number(item.total_price_uah), Number(item.new_price_uah));
    assert.equal(Number(item.current_batch_id), Number(batchId));
  }
  const rolledBack = await request(`/api/admin/repricing/${batchId}/rollback`, {
    method: 'POST', body: {},
  });
  assert.equal(rolledBack.response.status, 200, rolledBack.text);
  const rolledBackItems = await pool.query(
    `SELECT ri.product_id, ri.old_price_uah, p.total_price_uah,
            p.details #>> '{repricing,batchId}' AS current_batch_id
     FROM repricing_items ri
     JOIN products p ON p.id = ri.product_id
     WHERE ri.batch_id = $1
     ORDER BY ri.product_id`,
    [batchId]
  );
  for (const item of rolledBackItems.rows) {
    assert.equal(Number(item.total_price_uah), Number(item.old_price_uah));
    assert.notEqual(Number(item.current_batch_id || 0), Number(batchId));
  }

  const candidate = await pool.query(
    `SELECT full_sku FROM products
     WHERE category = 'ZZ' AND status = 'active' AND details->'answers'->>'kind' = '1'
     ORDER BY id DESC LIMIT 1`
  );
  await pool.query(
    'UPDATE price_matrix SET price = price + 50 WHERE scenario_id = $1',
    [schemas.ZZScenario]
  );
  const racePreview = await request('/api/admin/repricing/preview', {
    method: 'POST', body: { scenarioId: schemas.ZZScenario },
  });
  const raceManualOverrides = racePreview.data.items
    .filter((item) => ['manual_price', 'price_missing'].includes(item.errorCode))
    .map((item) => ({
      productId: Number(item.productId),
      newPriceUah: Number(item.oldPriceUah),
    }));
  const lockClient = await pool.connect();
  await lockClient.query('BEGIN');
  await lockClient.query('SELECT id FROM products WHERE full_sku = $1 FOR UPDATE', [
    candidate.rows[0].full_sku,
  ]);
  const correctionPromise = request('/api/recount/apply', {
      method: 'POST',
      body: { sourceSku: candidate.rows[0].full_sku, answers: { kind: 2 }, reason: 'race repricing' },
  });
  const repricingPromise = request('/api/admin/repricing/apply', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        previewToken: racePreview.data.previewToken,
        manualOverrides: raceManualOverrides,
      },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await lockClient.query('COMMIT');
  lockClient.release();
  const raceResults = await Promise.all([correctionPromise, repricingPromise]);
  assert.deepEqual(raceResults.map((item) => item.response.status).sort(), [200, 409]);
});

test('repricing keeps manual-priced products editable across consecutive cycles', async () => {
  const createProduct = async (kind) => {
    const preview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const saved = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: preview.data.previewToken,
      },
    });
    assert.equal(saved.response.status, 200, saved.text);
    return {
      ...saved.data,
      currentPriceUah: Number(preview.data.totalPriceUah),
    };
  };

  const keepCurrentProduct = await createProduct(2);
  const newManualProduct = await createProduct(2);
  const automaticProduct = await createProduct(1);
  const appliedBatchIds = [];

  const removedCell = await pool.query(
    `DELETE FROM price_matrix
     WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0
     RETURNING price`,
    [schemas.ZZScenario]
  );
  assert.equal(removedCell.rowCount, 1);
  await pool.query(
    'UPDATE price_matrix SET price = price + 100 WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0',
    [schemas.ZZScenario]
  );

  try {
    const preview = await request('/api/admin/repricing/preview', {
      method: 'POST', body: { scenarioId: schemas.ZZScenario },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const missingItems = preview.data.items.filter((item) => item.errorCode === 'price_missing');
    const unresolvedItems = preview.data.items.filter(
      (item) => ['manual_price', 'price_missing'].includes(item.errorCode)
    );
    const missingProductIds = new Set(missingItems.map((item) => Number(item.productId)));
    assert.equal(missingProductIds.has(Number(keepCurrentProduct.id)), true);
    assert.equal(missingProductIds.has(Number(newManualProduct.id)), true);
    assert.equal(preview.data.summary.errorCount, unresolvedItems.length);
    assert.ok(preview.data.summary.changedCount > 0);

    const unresolved = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: { scenarioId: schemas.ZZScenario, previewToken: preview.data.previewToken },
    });
    assert.equal(unresolved.response.status, 422, unresolved.text);

    const manualOverrides = unresolvedItems.map((item) => ({
      productId: Number(item.productId),
      newPriceUah: Number(item.productId) === Number(newManualProduct.id)
        ? 1750
        : Number(item.oldPriceUah),
    }));
    const invalidOverrides = manualOverrides.map((override) => (
      Number(override.productId) === Number(keepCurrentProduct.id)
        ? { ...override, newPriceUah: 0 }
        : override
    ));
    const invalid = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        previewToken: preview.data.previewToken,
        manualOverrides: invalidOverrides,
      },
    });
    assert.equal(invalid.response.status, 422, invalid.text);

    const draft = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        manualOverrides,
        reviewedProductIds: [],
        uiState: {},
      },
    });
    assert.equal(draft.response.status, 200, draft.text);
    assert.deepEqual(draft.data.manualOverrides, manualOverrides);

    const applied = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        previewToken: preview.data.previewToken,
        manualOverrides,
        draftId: draft.data.draft.id,
      },
    });
    assert.equal(applied.response.status, 200, applied.text);
    appliedBatchIds.push(Number(applied.data.batch.id));

    const stored = await pool.query(
      `SELECT id, total_price_uah, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [[keepCurrentProduct.id, newManualProduct.id, automaticProduct.id]]
    );
    const storedById = new Map(stored.rows.map((row) => [Number(row.id), row]));
    const kept = storedById.get(Number(keepCurrentProduct.id));
    const changed = storedById.get(Number(newManualProduct.id));
    const automatic = storedById.get(Number(automaticProduct.id));
    assert.equal(Number(kept.total_price_uah), keepCurrentProduct.currentPriceUah);
    assert.equal(Number(kept.details.manualPriceUah), keepCurrentProduct.currentPriceUah);
    assert.equal(kept.details.autoPriceUah, null);
    assert.equal(kept.details.repricing.manualOverride, true);
    assert.equal(kept.details.repricing.calculatedPriceUah, null);
    assert.equal(Number(changed.total_price_uah), 1750);
    assert.equal(Number(changed.details.manualPriceUah), 1750);
    assert.equal(changed.details.autoPriceUah, null);
    assert.equal(changed.details.repricing.manualOverride, true);
    assert.equal(
      Number(automatic.total_price_uah),
      automaticProduct.currentPriceUah + 100
    );
    assert.equal(
      Number(automatic.details.autoPriceUah),
      automaticProduct.currentPriceUah + 100
    );
    assert.equal(automatic.details.manualPriceUah, null);
    assert.equal(automatic.details.repricing.manualOverride, false);

    const secondPreview = await request('/api/admin/repricing/preview', {
      method: 'POST', body: { scenarioId: schemas.ZZScenario },
    });
    assert.equal(secondPreview.response.status, 200, secondPreview.text);
    const manualItems = secondPreview.data.items.filter(
      (item) => item.errorCode === 'manual_price'
    );
    const repeatedManualItem = manualItems.find(
      (item) => Number(item.productId) === Number(newManualProduct.id)
    );
    assert.ok(repeatedManualItem, 'the manually-priced product must remain in the next preview');
    assert.equal(Number(repeatedManualItem.oldPriceUah), 1750);

    const secondManualOverrides = manualItems.map((item) => ({
      productId: Number(item.productId),
      newPriceUah: Number(item.productId) === Number(newManualProduct.id)
        ? 1850
        : Number(item.oldPriceUah),
    }));
    const secondDraft = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        manualOverrides: secondManualOverrides,
        reviewedProductIds: [],
        uiState: {},
      },
    });
    assert.equal(secondDraft.response.status, 200, secondDraft.text);

    const secondApplied = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        previewToken: secondPreview.data.previewToken,
        manualOverrides: secondManualOverrides,
        draftId: secondDraft.data.draft.id,
      },
    });
    assert.equal(secondApplied.response.status, 200, secondApplied.text);
    appliedBatchIds.push(Number(secondApplied.data.batch.id));

    const storedAfterSecondCycle = await pool.query(
      `SELECT total_price_uah, details
       FROM products WHERE id = $1`,
      [newManualProduct.id]
    );
    assert.equal(Number(storedAfterSecondCycle.rows[0].total_price_uah), 1850);
    assert.equal(Number(storedAfterSecondCycle.rows[0].details.manualPriceUah), 1850);
    assert.equal(storedAfterSecondCycle.rows[0].details.autoPriceUah, null);
    assert.equal(storedAfterSecondCycle.rows[0].details.repricing.manualOverride, true);
  } finally {
    for (const appliedBatchId of [...appliedBatchIds].reverse()) {
      const rollback = await request(`/api/admin/repricing/${appliedBatchId}/rollback`, {
        method: 'POST', body: {},
      });
      assert.equal(rollback.response.status, 200, rollback.text);
    }
    await pool.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       VALUES ($1, 2, 0, $2)
       ON CONFLICT (scenario_id, x_val, y_val) DO UPDATE SET price = EXCLUDED.price`,
      [schemas.ZZScenario, removedCell.rows[0].price]
    );
    await pool.query(
      'UPDATE price_matrix SET price = price - 100 WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0',
      [schemas.ZZScenario]
    );
  }
});

test('repricing rolls back every product and batch row after a mid-apply failure', async () => {
  await pool.query(
    'UPDATE price_matrix SET price = price + 30 WHERE scenario_id = $1',
    [schemas.ZZScenario]
  );
  try {
    const preview = await request('/api/admin/repricing/preview', {
      method: 'POST', body: { scenarioId: schemas.ZZScenario },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const changedItems = preview.data.items.filter((item) => item.status === 'changed');
    const manualOverrides = preview.data.items
      .filter((item) => ['manual_price', 'price_missing'].includes(item.errorCode))
      .map((item) => ({
        productId: Number(item.productId),
        newPriceUah: Number(item.oldPriceUah),
      }));
    assert.ok(changedItems.length >= 2);
    const productIds = changedItems.map((item) => Number(item.productId));
    const before = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [productIds]
    );
    const failureProductId = productIds[1];
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_repricing_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = ${failureProductId}
           AND NEW.details #>> '{repricing,batchId}'
               IS DISTINCT FROM OLD.details #>> '{repricing,batchId}' THEN
          RAISE EXCEPTION 'forced repricing failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_test_repricing_update
      BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION fail_test_repricing_update();
    `);
    try {
      const failed = await request('/api/admin/repricing/apply', {
        method: 'POST',
        body: {
          scenarioId: schemas.ZZScenario,
          previewToken: preview.data.previewToken,
          manualOverrides,
        },
      });
      assert.equal(failed.response.status, 500);
    } finally {
      await pool.query('DROP TRIGGER fail_test_repricing_update ON products');
      await pool.query('DROP FUNCTION fail_test_repricing_update()');
    }
    const after = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [productIds]
    );
    assert.deepEqual(after.rows, before.rows);
    const persisted = await pool.query(
      `SELECT count(*)::int AS batches
       FROM repricing_batches
       WHERE preview_token = $1 AND status = 'completed'`,
      [preview.data.previewToken]
    );
    assert.equal(persisted.rows[0].batches, 0);
  } finally {
    await pool.query(
      'UPDATE price_matrix SET price = price - 30 WHERE scenario_id = $1',
      [schemas.ZZScenario]
    );
  }
});

test('global repricing is authoritative, atomic, unique per product, and fully rollbackable', async () => {
  const createProduct = async (categoryCode, kind, manualPriceUah = null) => {
    const preview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode, answers: { kind }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const saved = await request('/api/save', {
      method: 'POST',
      body: {
        category: categoryCode,
        answers: { kind },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas[categoryCode],
        previewToken: preview.data.previewToken,
        manualPriceUah,
      },
    });
    assert.equal(saved.response.status, 200, saved.text);
    return saved.data;
  };
  const overridesFor = (preview, excludedProductIds = []) => {
    const excluded = new Set(excludedProductIds.map(Number));
    return preview.items
    .filter((item) => (
      ['manual_price', 'price_missing'].includes(item.errorCode)
      && !excluded.has(Number(item.productId))
    ))
    .map((item) => ({
      productId: Number(item.productId),
      newPriceUah: Number(item.oldPriceUah) > 0 ? Number(item.oldPriceUah) : 500,
    }));
  };

  const changedAutomatic = await createProduct('ZZ', 1);
  const unchangedAutomatic = await createProduct('ZZ', 2);
  const automaticSwitchProduct = await createProduct('ZZ', 1, 700);
  const manualProduct = await createProduct('MM', 1, 700);
  const changedManualProduct = await createProduct('MM', 1, 750);
  const missingProduct = await createProduct('MM', 2, 800);
  await pool.query(
    `UPDATE products
     SET details = details - 'manualPriceUah'
     WHERE id = $1`,
    [missingProduct.id]
  );

  const semiScenario = await pool.query(
    `SELECT id FROM price_scenarios
     WHERE category_code = 'LN'
       AND status = 'active'
       AND match_json @> '{"is_calibrated":2}'::jsonb
     ORDER BY priority DESC, id
     LIMIT 1`
  );
  assert.equal(semiScenario.rows.length, 1);
  const semiScenarioId = Number(semiScenario.rows[0].id);
  const originalCells = await pool.query(
    `SELECT scenario_id, x_val, y_val, price
     FROM price_matrix
     WHERE (scenario_id = $1 AND x_val = 1 AND y_val = 0)
        OR (scenario_id = $2 AND x_val = 6 AND y_val = 0)
     ORDER BY scenario_id, x_val, y_val`,
    [schemas.ZZScenario, semiScenarioId]
  );
  assert.equal(originalCells.rows.length, 2);

  let activeRequestId = null;
  let appliedBatchId = null;
  let activeDraftId = null;
  let overlappingScenarioId = null;
  try {
    const overlappingScenario = await pool.query(
      `INSERT INTO price_scenarios
       (category_code, name, match_json, axis_x_key, axis_y_key, priority,
        status, price_mode, apply_modifiers)
       VALUES ('ZZ', 'Lower-priority overlap', '{}'::jsonb, 'kind', NULL, -100,
               'active', 'fixed_uah', TRUE)
       RETURNING id`
    );
    overlappingScenarioId = Number(overlappingScenario.rows[0].id);
    await pool.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       VALUES ($1, 1, 0, 9999), ($1, 2, 0, 9999)`,
      [overlappingScenarioId]
    );
    await pool.query(
      `UPDATE price_matrix
       SET price = CASE WHEN scenario_id = $1 THEN price + 38 ELSE price + 0.25 END
       WHERE (scenario_id = $1 AND x_val = 1 AND y_val = 0)
          OR (scenario_id = $2 AND x_val = 6 AND y_val = 0)`,
      [schemas.ZZScenario, semiScenarioId]
    );

    const initial = await request('/api/admin/repricing/global/preview', {
      method: 'POST', body: {},
    });
    assert.equal(initial.response.status, 200, initial.text);
    assert.equal(initial.data.scope, 'global');
    assert.equal(initial.data.summary.candidateCount, initial.data.items.length);
    assert.equal(
      new Set(initial.data.items.map((item) => Number(item.productId))).size,
      initial.data.items.length,
      'every active product must occur at most once'
    );
    const changedScenarioIds = new Set(
      initial.data.items
        .filter((item) => item.status === 'changed')
        .map((item) => Number(item.scenarioId))
    );
    assert.equal(changedScenarioIds.has(Number(schemas.ZZScenario)), true);
    assert.equal(changedScenarioIds.has(semiScenarioId), true);
    assert.equal(
      initial.data.items.find((item) => Number(item.productId) === Number(unchangedAutomatic.id))?.status,
      'unchanged'
    );
    assert.equal(
      initial.data.items.find((item) => Number(item.productId) === Number(changedAutomatic.id))?.scenarioId,
      Number(schemas.ZZScenario),
      'a product matching multiple scenarios must use normal authoritative precedence'
    );
    const manualOnlyPreviewItem = initial.data.items.find((item) => (
      Number(item.productId) === Number(manualProduct.id)
    ));
    assert.equal(manualOnlyPreviewItem?.errorCode, 'manual_price');
    assert.equal(manualOnlyPreviewItem?.calculatedPriceUah, null);
    const switchPreviewItem = initial.data.items.find((item) => (
      Number(item.productId) === Number(automaticSwitchProduct.id)
    ));
    assert.equal(switchPreviewItem?.errorCode, 'manual_price');
    assert.ok(Number(switchPreviewItem?.calculatedPriceUah) > 0);
    assert.ok(Number(switchPreviewItem?.automaticPriceUah) > 0);
    assert.notEqual(
      Number(switchPreviewItem?.calculatedPriceUah),
      Number(switchPreviewItem?.automaticPriceUah)
    );
    assert.ok(switchPreviewItem?.pricingDetails?.matrix);
    assert.equal(
      initial.data.items.find((item) => Number(item.productId) === Number(missingProduct.id))?.errorCode,
      'price_missing'
    );

    const automaticProductIds = [Number(automaticSwitchProduct.id)];
    const initialOverrides = overridesFor(initial.data, automaticProductIds);
    assert.ok(initialOverrides.length >= 2);
    const invalidOverrides = initialOverrides.map((override) => (
      Number(override.productId) === Number(manualProduct.id)
        ? { ...override, newPriceUah: 0 }
        : override
    ));
    assert.equal(
      invalidOverrides.find((override) => (
        Number(override.productId) === Number(manualProduct.id)
      ))?.newPriceUah,
      0
    );
    const invalid = await request('/api/admin/repricing/global/apply', {
      method: 'POST',
      body: {
        previewToken: initial.data.previewToken,
        manualOverrides: invalidOverrides,
        automaticProductIds,
      },
    });
    assert.equal(invalid.response.status, 422, invalid.text);

    await pool.query(
      `UPDATE price_matrix SET price = price + 1
       WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0`,
      [schemas.ZZScenario]
    );
    const stalePricing = await request('/api/admin/repricing/global/apply', {
      method: 'POST',
      body: {
        previewToken: initial.data.previewToken,
        manualOverrides: initialOverrides,
        automaticProductIds,
      },
    });
    assert.equal(stalePricing.response.status, 409, stalePricing.text);
    await pool.query(
      `UPDATE price_matrix SET price = price - 1
       WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0`,
      [schemas.ZZScenario]
    );

    const beforeProductChange = await request('/api/admin/repricing/global/preview', {
      method: 'POST', body: {},
    });
    const changedProductRow = await pool.query(
      'SELECT details FROM products WHERE id = $1',
      [changedAutomatic.id]
    );
    await pool.query(
      `UPDATE products
       SET details = jsonb_set(details, '{globalRepricingTest}', 'true'::jsonb)
       WHERE id = $1`,
      [changedAutomatic.id]
    );
    const staleProduct = await request('/api/admin/repricing/global/apply', {
      method: 'POST',
      body: {
        previewToken: beforeProductChange.data.previewToken,
        manualOverrides: overridesFor(beforeProductChange.data),
      },
    });
    assert.equal(staleProduct.response.status, 409, staleProduct.text);
    await pool.query('UPDATE products SET details = $1::jsonb WHERE id = $2', [
      JSON.stringify(changedProductRow.rows[0].details),
      changedAutomatic.id,
    ]);

    const beforeCorrectionRequest = await request('/api/admin/repricing/global/preview', {
      method: 'POST', body: {},
    });
    const requestRow = await pool.query(
      `INSERT INTO correction_requests
       (source_product_id, category_code, source_sku, proposed_sku, old_payload,
        proposed_payload, changes, status, preview_signature)
       SELECT id, category, full_sku, full_sku || '-999', '{}'::jsonb,
              '{}'::jsonb, '[]'::jsonb, 'pending', 'global-repricing-test'
       FROM products WHERE id = $1
       RETURNING id`,
      [changedAutomatic.id]
    );
    activeRequestId = Number(requestRow.rows[0].id);
    const blocked = await request('/api/admin/repricing/global/apply', {
      method: 'POST',
      body: {
        previewToken: beforeCorrectionRequest.data.previewToken,
        manualOverrides: overridesFor(beforeCorrectionRequest.data),
      },
    });
    assert.equal(blocked.response.status, 409, blocked.text);
    assert.equal(blocked.data.details?.type, 'active_correction_requests');
    await pool.query('DELETE FROM correction_requests WHERE id = $1', [activeRequestId]);
    activeRequestId = null;

    const finalPreview = await request('/api/admin/repricing/global/preview', {
      method: 'POST', body: {},
    });
    assert.equal(finalPreview.response.status, 200, finalPreview.text);
    const nonResolvableErrors = finalPreview.data.items.filter((item) => (
      item.status === 'error'
      && !['manual_price', 'price_missing'].includes(item.errorCode)
    ));
    assert.deepEqual(nonResolvableErrors, []);
    const manualOverrides = overridesFor(finalPreview.data, automaticProductIds)
      .map((override) => (
        Number(override.productId) === Number(changedManualProduct.id)
          ? { ...override, newPriceUah: Number(override.newPriceUah) + 25 }
          : override
      ));
    const keptManualOverride = manualOverrides.find((override) => (
      Number(override.productId) === Number(manualProduct.id)
    ));
    assert.equal(keptManualOverride?.newPriceUah, Number(
      finalPreview.data.items.find((item) => (
        Number(item.productId) === Number(manualProduct.id)
      )).oldPriceUah
    ));
    const changedProductIds = finalPreview.data.items
      .filter((item) => (
        item.status === 'changed'
        || ['manual_price', 'price_missing'].includes(item.errorCode)
      ))
      .map((item) => Number(item.productId))
      .sort((first, second) => first - second);
    assert.ok(changedProductIds.length >= 2);
    const beforeApply = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    );
    const batchesBeforeFailure = await pool.query(
      "SELECT count(*)::int AS count FROM repricing_batches WHERE scope = 'global'"
    );
    const failureProductId = changedProductIds[1];
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_global_repricing_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = ${failureProductId}
           AND NEW.details #>> '{repricing,batchId}'
               IS DISTINCT FROM OLD.details #>> '{repricing,batchId}' THEN
          RAISE EXCEPTION 'forced global repricing failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_test_global_repricing_update
      BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION fail_test_global_repricing_update();
    `);
    try {
      const failed = await request('/api/admin/repricing/global/apply', {
        method: 'POST',
        body: {
          previewToken: finalPreview.data.previewToken,
          manualOverrides,
          automaticProductIds,
        },
      });
      assert.equal(failed.response.status, 500, failed.text);
    } finally {
      await pool.query('DROP TRIGGER fail_test_global_repricing_update ON products');
      await pool.query('DROP FUNCTION fail_test_global_repricing_update()');
    }
    const afterFailure = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    );
    assert.deepEqual(afterFailure.rows, beforeApply.rows);
    const batchesAfterFailure = await pool.query(
      "SELECT count(*)::int AS count FROM repricing_batches WHERE scope = 'global'"
    );
    assert.equal(batchesAfterFailure.rows[0].count, batchesBeforeFailure.rows[0].count);

    const draft = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      body: {
        scope: 'global',
        manualOverrides,
        automaticProductIds,
        reviewedProductIds: [
          changedAutomatic.id,
          manualProduct.id,
          automaticSwitchProduct.id,
        ],
        uiState: { filter: 'all', scenarioFilter: String(schemas.ZZScenario) },
      },
    });
    assert.equal(draft.response.status, 200, draft.text);
    assert.equal(draft.data.draft.scope, 'global');
    assert.equal(draft.data.draft.scenarioId, null);
    assert.deepEqual(draft.data.draft.automaticProductIds, automaticProductIds);
    assert.equal(draft.data.draft.uiState.scenarioFilter, String(schemas.ZZScenario));
    assert.equal(
      draft.data.draft.manualOverrides.find((override) => (
        Number(override.productId) === Number(manualProduct.id)
      ))?.newPriceUah,
      keptManualOverride.newPriceUah
    );
    assert.equal(
      draft.data.draft.reviewedProductIds.includes(Number(manualProduct.id)),
      true
    );
    assert.equal(
      draft.data.draft.reviewedProductIds.includes(Number(automaticSwitchProduct.id)),
      true
    );
    activeDraftId = Number(draft.data.draft.id);

    const reopenedDraft = await request(`/api/admin/repricing/drafts/${activeDraftId}`);
    assert.equal(reopenedDraft.response.status, 200, reopenedDraft.text);
    assert.deepEqual(reopenedDraft.data.automaticProductIds, automaticProductIds);
    assert.equal(
      reopenedDraft.data.manualOverrides.find((override) => (
        Number(override.productId) === Number(manualProduct.id)
      ))?.newPriceUah,
      keptManualOverride.newPriceUah
    );
    assert.equal(
      reopenedDraft.data.draft.reviewedProductIds.includes(Number(manualProduct.id)),
      true
    );

    const applied = await request('/api/admin/repricing/global/apply', {
      method: 'POST',
      body: {
        previewToken: finalPreview.data.previewToken,
        manualOverrides,
        automaticProductIds,
        draftId: activeDraftId,
      },
    });
    assert.equal(applied.response.status, 200, applied.text);
    assert.equal(applied.data.batch.scope, 'global');
    appliedBatchId = Number(applied.data.batch.id);
    activeDraftId = null;
    const appliedItems = await pool.query(
      `SELECT ri.product_id, ri.new_price_uah, p.total_price_uah,
              p.details #>> '{repricing,batchId}' AS batch_id,
              p.details #>> '{pricingScenario,id}' AS scenario_id,
              p.details ->> 'calculatedPriceUah' AS calculated_price_uah,
              p.details ->> 'autoPriceUah' AS auto_price_uah,
              p.details ->> 'manualPriceUah' AS manual_price_uah,
              p.details #>> '{repricing,calculatedPriceUah}' AS repricing_calculated_price_uah,
              p.details #>> '{repricing,autoPriceUah}' AS repricing_auto_price_uah,
              p.details #>> '{repricing,useAutomatic}' AS use_automatic,
              p.details #>> '{repricing,manualOverride}' AS manual_override
       FROM repricing_items ri
       JOIN products p ON p.id = ri.product_id
       WHERE ri.batch_id = $1
       ORDER BY ri.product_id`,
      [appliedBatchId]
    );
    assert.equal(appliedItems.rows.length, changedProductIds.length);
    for (const item of appliedItems.rows) {
      assert.equal(Number(item.total_price_uah), Number(item.new_price_uah));
      assert.equal(Number(item.batch_id), appliedBatchId);
    }
    const appliedScenarioIds = new Set(
      appliedItems.rows.map((item) => Number(item.scenario_id)).filter(Number.isFinite)
    );
    assert.equal(appliedScenarioIds.has(Number(schemas.ZZScenario)), true);
    assert.equal(appliedScenarioIds.has(semiScenarioId), true);
    const switchedProduct = appliedItems.rows.find((item) => (
      Number(item.product_id) === Number(automaticSwitchProduct.id)
    ));
    assert.equal(switchedProduct.manual_price_uah, null);
    assert.equal(switchedProduct.use_automatic, 'true');
    assert.equal(switchedProduct.manual_override, 'false');
    assert.equal(
      Number(switchedProduct.calculated_price_uah),
      Number(switchedProduct.repricing_calculated_price_uah)
    );
    assert.equal(Number(switchedProduct.auto_price_uah), Number(switchedProduct.new_price_uah));
    assert.equal(
      Number(switchedProduct.repricing_auto_price_uah),
      Number(switchedProduct.new_price_uah)
    );
    assert.equal(Number(switchedProduct.new_price_uah), Number(
      finalPreview.data.items.find((item) => (
        Number(item.productId) === Number(automaticSwitchProduct.id)
      )).automaticPriceUah
    ));
    const keptManualProduct = appliedItems.rows.find((item) => (
      Number(item.product_id) === Number(manualProduct.id)
    ));
    assert.equal(Number(keptManualProduct.manual_price_uah), 700);
    assert.equal(keptManualProduct.manual_override, 'true');
    const changedManual = appliedItems.rows.find((item) => (
      Number(item.product_id) === Number(changedManualProduct.id)
    ));
    assert.equal(Number(changedManual.manual_price_uah), 775);
    assert.equal(Number(changedManual.new_price_uah), 775);

    await pool.query(
      'UPDATE products SET total_price_uah = total_price_uah + 1 WHERE id = $1',
      [changedProductIds[0]]
    );
    const unsafeRollback = await request(`/api/admin/repricing/${appliedBatchId}/rollback`, {
      method: 'POST', body: {},
    });
    assert.equal(unsafeRollback.response.status, 409, unsafeRollback.text);
    const expectedNewPrice = appliedItems.rows.find(
      (item) => Number(item.product_id) === changedProductIds[0]
    ).new_price_uah;
    await pool.query('UPDATE products SET total_price_uah = $1 WHERE id = $2', [
      expectedNewPrice,
      changedProductIds[0],
    ]);
    const rolledBack = await request(`/api/admin/repricing/${appliedBatchId}/rollback`, {
      method: 'POST', body: {},
    });
    assert.equal(rolledBack.response.status, 200, rolledBack.text);
    const afterRollback = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    );
    assert.deepEqual(afterRollback.rows, beforeApply.rows);
    appliedBatchId = null;
  } finally {
    if (activeRequestId) {
      await pool.query('DELETE FROM correction_requests WHERE id = $1', [activeRequestId]);
    }
    if (appliedBatchId) {
      await request(`/api/admin/repricing/${appliedBatchId}/rollback`, {
        method: 'POST', body: {},
      });
    }
    if (activeDraftId) {
      await pool.query(
        `UPDATE repricing_drafts
         SET status = 'discarded', discarded_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'draft'`,
        [activeDraftId]
      );
    }
    if (overlappingScenarioId) {
      await pool.query('DELETE FROM price_scenarios WHERE id = $1', [overlappingScenarioId]);
    }
    for (const cell of originalCells.rows) {
      await pool.query(
        `UPDATE price_matrix SET price = $1
         WHERE scenario_id = $2 AND x_val = $3 AND y_val = $4`,
        [cell.price, cell.scenario_id, cell.x_val, cell.y_val]
      );
    }
  }
});

test('export snapshot is immutable, idempotent, and cursor is monotonic', async () => {
  const legacyBypass = await request(`/api/export/csv?fromSku=${encodeURIComponent(primarySku)}`);
  assert.equal(legacyBypass.response.status, 410);
  const first = await request('/api/export/snapshots', {
    method: 'POST', body: { fromSku: primarySku }, headers: { 'Idempotency-Key': 'integration-export-1' },
  });
  assert.equal(first.response.status, 201, first.text);
  const repeated = await request('/api/export/snapshots', {
    method: 'POST', body: { fromSku: primarySku }, headers: { 'Idempotency-Key': 'integration-export-1' },
  });
  assert.equal(repeated.data.id, first.data.id);
  const mismatched = await request('/api/export/snapshots', {
    method: 'POST',
    body: { fromSku: primarySku, toSku: primarySku },
    headers: { 'Idempotency-Key': 'integration-export-1' },
  });
  assert.equal(mismatched.response.status, 409);
  const csv = await request(`/api/export/snapshots/${first.data.id}/csv`);
  assert.equal(csv.response.status, 200);
  assert.match(csv.text, /^sku,price_uah/);
  assert.equal((await request(`/api/export/snapshots/${first.data.id}/confirm`, { method: 'POST', body: {} })).response.status, 200);
  const cursorBefore = Number((await pool.query('SELECT exported_to_product_id FROM export_state')).rows[0].exported_to_product_id);

  const historical = await request('/api/export/snapshots', {
    method: 'POST',
    body: { fromSku: primarySku, toSku: primarySku },
    headers: { 'Idempotency-Key': 'integration-export-old' },
  });
  await request(`/api/export/snapshots/${historical.data.id}/confirm`, { method: 'POST', body: {} });
  const cursorAfter = Number((await pool.query('SELECT exported_to_product_id FROM export_state')).rows[0].exported_to_product_id);
  assert.equal(cursorAfter, cursorBefore);

  await pool.query(
    `UPDATE export_state
     SET exported_to_product_id = 0, last_snapshot_id = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE singleton = TRUE`
  );
  const concurrentConfirmations = await Promise.all([
    request(`/api/export/snapshots/${historical.data.id}/confirm`, { method: 'POST', body: {} }),
    request(`/api/export/snapshots/${first.data.id}/confirm`, { method: 'POST', body: {} }),
  ]);
  assert.deepEqual(concurrentConfirmations.map((result) => result.response.status), [200, 200]);
  const concurrentCursor = await pool.query(
    `SELECT st.exported_to_product_id, st.last_snapshot_id,
            GREATEST(old.exported_to_product_id, latest.exported_to_product_id) AS expected_cursor,
            CASE
              WHEN latest.exported_to_product_id >= old.exported_to_product_id THEN latest.id
              ELSE old.id
            END AS expected_snapshot_id
     FROM export_state st
     JOIN export_snapshots old ON old.id = $1
     JOIN export_snapshots latest ON latest.id = $2
     WHERE st.singleton = TRUE`,
    [historical.data.id, first.data.id]
  );
  assert.equal(
    Number(concurrentCursor.rows[0].exported_to_product_id),
    Number(concurrentCursor.rows[0].expected_cursor)
  );
  assert.equal(
    concurrentCursor.rows[0].last_snapshot_id,
    concurrentCursor.rows[0].expected_snapshot_id
  );
  await assert.rejects(
    pool.query("UPDATE export_snapshots SET csv_content = 'changed' WHERE id = $1", [first.data.id]),
    /immutable/
  );

  const endpoints = (await pool.query(
    `SELECT full_sku FROM products
     WHERE full_sku IS NOT NULL
     ORDER BY id
     LIMIT 2`
  )).rows.map((row) => row.full_sku);
  assert.equal(endpoints.length, 2);
  await pool.query(`
    CREATE OR REPLACE FUNCTION delay_test_export_snapshot_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_sleep(0.2);
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER delay_test_export_snapshot_insert
    BEFORE INSERT ON export_snapshots
    FOR EACH ROW EXECUTE FUNCTION delay_test_export_snapshot_insert();
  `);
  try {
    const concurrentKey = 'integration-export-conflict';
    const concurrent = await Promise.all([
      request('/api/export/snapshots', {
        method: 'POST',
        body: { fromSku: endpoints[0], toSku: endpoints[0] },
        headers: { 'Idempotency-Key': concurrentKey },
      }),
      request('/api/export/snapshots', {
        method: 'POST',
        body: { fromSku: endpoints[1], toSku: endpoints[1] },
        headers: { 'Idempotency-Key': concurrentKey },
      }),
    ]);
    assert.deepEqual(
      concurrent.map((result) => result.response.status).sort(),
      [201, 409]
    );
    const storedConflict = await pool.query(
      `SELECT count(*)::int AS count
       FROM export_snapshots
       WHERE idempotency_key = $1`,
      [concurrentKey]
    );
    assert.equal(storedConflict.rows[0].count, 1);
  } finally {
    await pool.query('DROP TRIGGER delay_test_export_snapshot_insert ON export_snapshots');
    await pool.query('DROP FUNCTION delay_test_export_snapshot_insert()');
  }
});

function sqliteRun(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
}

test('SQLite import targets current schema and refuses implicit replacement', async () => {
  const importDbName = 'amber_import_test';
  const adminUrl = new URL(TEST_DATABASE_URL);
  const importUrl = new URL(TEST_DATABASE_URL);
  importUrl.pathname = `/${importDbName}`;
  await pool.query(`DROP DATABASE IF EXISTS ${importDbName} WITH (FORCE)`);
  await pool.query(`CREATE DATABASE ${importDbName}`);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-sqlite-'));
  const sqlitePath = path.join(tempDir, 'legacy.db');
  const sqlite = new sqlite3.Database(sqlitePath);
  try {
    await sqliteRun(sqlite, `
      CREATE TABLE categories(code TEXT, name TEXT, requires_weight INTEGER);
      CREATE TABLE questions(id INTEGER, category_code TEXT, key TEXT, label TEXT, sku_index INTEGER, required INTEGER);
      CREATE TABLE options(id INTEGER, question_id INTEGER, value_id INTEGER, sku_code TEXT, label TEXT);
      CREATE TABLE price_scenarios(id INTEGER, category_code TEXT, name TEXT, match_json TEXT, axis_x_key TEXT, axis_y_key TEXT);
      CREATE TABLE price_matrix(scenario_id INTEGER, x_val INTEGER, y_val INTEGER, price REAL);
      CREATE TABLE price_modifiers(id INTEGER, category_code TEXT, trigger_key TEXT, trigger_val INTEGER, factor REAL);
      INSERT INTO categories VALUES ('IX', 'Imported', 0);
      INSERT INTO questions VALUES (1, 'IX', 'kind', 'Kind', 1, 1);
      INSERT INTO options VALUES (1, 1, 7, 'A7', 'Seven');
      INSERT INTO price_scenarios VALUES (1, 'IX', 'Imported matrix', '{}', 'kind', NULL);
      INSERT INTO price_matrix VALUES (1, 7, 0, 12.5);
    `);
  } finally {
    await new Promise((resolve, reject) => sqlite.close((error) => error ? reject(error) : resolve()));
  }
  try {
    await execFileAsync(process.execPath, ['-e', `
      process.env.DATABASE_URL = ${JSON.stringify(importUrl.toString())};
      const { runMigrations } = require('./src/db/run-migrations');
      const db = require('./src/db/pool');
      runMigrations().then(() => db.end()).catch((error) => { console.error(error); process.exit(1); });
    `], { cwd: path.resolve(__dirname, '..') });
    await execFileAsync(process.execPath, [
      'scripts/migrate-sqlite-config-to-postgres.js',
      `--sqlite=${sqlitePath}`,
      `--pg=${importUrl.toString()}`,
    ], { cwd: path.resolve(__dirname, '..') });
    const importedPool = new Pool({ connectionString: importUrl.toString() });
    try {
      const imported = await importedPool.query(
        `SELECT o.sku_code, sv.version
         FROM options o
         JOIN questions q ON q.id = o.question_id
         JOIN sku_schema_versions sv ON sv.category_code = q.category_code
         WHERE q.category_code = 'IX'`
      );
      assert.deepEqual(imported.rows, [{ sku_code: 'A7', version: 1 }]);
    } finally {
      await importedPool.end();
    }
    await assert.rejects(
      execFileAsync(process.execPath, [
        'scripts/migrate-sqlite-config-to-postgres.js',
        `--sqlite=${sqlitePath}`,
        `--pg=${importUrl.toString()}`,
      ], { cwd: path.resolve(__dirname, '..') })
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    await pool.query(`DROP DATABASE IF EXISTS ${importDbName} WITH (FORCE)`);
  }
});
