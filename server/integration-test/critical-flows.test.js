const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const {
  Pool,
  TEST_DATABASE_URL,
  assertDisposableTestDatabase,
  closeServer,
  createApp,
  createHttpRequester,
  dropTestDatabase,
  execFileAsync,
  listen,
  pool,
  recreateTestDatabase,
  runNodeInDatabase,
  serverRoot,
} = require('./harness');
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
const logger = require('../src/utils/logger');
const {
  approveApplicationUser,
  changeApplicationUserRole,
  disableApplicationUser,
  enableApplicationUser,
} = require('../src/services/application-user-admin.service');
let server;
let baseUrl;
let authenticatedSession = null;
const schemas = {};
let primarySku;

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

const request = createHttpRequester({
  getBaseUrl: () => baseUrl,
  getDefaultAuthentication: () => authenticatedSession,
});

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

async function replaceActiveRoleForTest(applicationUserId, roleKey) {
  await pool.query(
    `UPDATE user_role_assignments
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE application_user_id = $1 AND revoked_at IS NULL`,
    [applicationUserId]
  );
  if (!roleKey) return;
  await pool.query(
    `INSERT INTO user_role_assignments (application_user_id, role_id)
     SELECT $1, id FROM roles WHERE role_key = $2 AND status = 'active'`,
    [applicationUserId, roleKey]
  );
}

async function roleIdForKey(roleKey, databasePool = pool) {
  const result = await databasePool.query(
    'SELECT id FROM roles WHERE role_key = $1',
    [roleKey]
  );
  assert.equal(result.rows.length, 1, `Role ${roleKey} was not found`);
  return Number(result.rows[0].id);
}

async function currentAssignmentIdForUser(applicationUserId, databasePool = pool) {
  const result = await databasePool.query(
    `SELECT id FROM user_role_assignments
     WHERE application_user_id = $1 AND revoked_at IS NULL`,
    [applicationUserId]
  );
  assert.equal(result.rows.length, 1, `Current assignment for user ${applicationUserId} was not found`);
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

async function authenticateIdentitySession({
  issuer = 'https://user-admin.example/realms/amber',
  subject,
  preferredUsername,
  displayName,
}) {
  const calls = [];
  const oidcAdapter = {
    issuer,
    redirectUri: 'http://localhost:5000/api/auth/callback',
    async buildAuthorizationRedirect(transaction) {
      calls.push({ ...transaction });
      const url = new URL('https://auth.example.invalid/authorize');
      url.searchParams.set('state', transaction.state);
      return url;
    },
    async exchangeAuthorizationCode() {
      return {
        iss: issuer,
        sub: subject,
        preferred_username: preferredUsername,
        name: displayName,
      };
    },
    async buildLogoutRedirect() {
      return null;
    },
  };
  const identityApp = createApp({ oidcAdapter });
  const identityServer = await new Promise((resolve) => {
    const listening = identityApp.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const identityBaseUrl = `http://127.0.0.1:${identityServer.address().port}`;
  try {
    const login = await fetch(`${identityBaseUrl}/api/auth/login`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const loginCookie = login.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(loginCookie);
    const callback = await fetch(
      `${identityBaseUrl}/api/auth/callback?code=user-admin-code&state=${calls[0].state}`,
      { redirect: 'manual', headers: { Cookie: loginCookie } }
    );
    assert.equal(callback.status, 303);
    const cookie = callback.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const meResponse = await fetch(`${identityBaseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
    });
    assert.equal(meResponse.status, 200);
    const me = await meResponse.json();
    return { cookie, csrfToken: me.csrfToken, applicationUser: me.applicationUser };
  } finally {
    await new Promise((resolve) => identityServer.close(resolve));
  }
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
  await assertDisposableTestDatabase();
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
  ({ server, baseUrl } = await listen(app));
});

test.after(async () => {
  await closeServer(server);
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

test('migrations 020-028 create constrained RBAC, audit, and business actor attribution', async () => {
  const requiredTables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name
  `, [[
    'application_external_identities',
    'application_users',
    'audit_events',
    'permissions',
    'role_permissions',
    'roles',
    'security_bootstrap_state',
    'user_role_assignments',
  ]]);
  assert.deepEqual(requiredTables.rows.map((row) => row.table_name), [
    'application_external_identities',
    'application_users',
    'audit_events',
    'permissions',
    'role_permissions',
    'roles',
    'security_bootstrap_state',
    'user_role_assignments',
  ]);

  const permissionKeys = [
    'audit.view',
    'catalog.manage',
    'catalog.view',
    'corrections.claim',
    'corrections.complete',
    'corrections.create',
    'corrections.force_release',
    'corrections.reject',
    'corrections.view',
    'exports.create',
    'exports.view',
    'history.view',
    'pricing.manage',
    'pricing.view',
    'products.archive',
    'products.create',
    'products.decode',
    'products.recount',
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
    'corrections.create',
    'corrections.reject',
    'corrections.view',
    'exports.view',
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
    'exports.view',
    'history.view',
    'products.archive',
    'products.create',
    'products.decode',
    'products.recount',
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

  const roleVersion = await pool.query(
    `SELECT column_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'roles' AND column_name = 'version'`
  );
  assert.deepEqual(roleVersion.rows, [{
    column_name: 'version',
    is_nullable: 'NO',
    column_default: '1',
  }]);
  const customRoleIndexes = await pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = ANY($1::text[])
     ORDER BY indexname`,
    [[
      'roles_display_name_case_insensitive_idx',
      'user_role_assignments_one_current_role_per_user_idx',
    ]]
  );
  assert.deepEqual(customRoleIndexes.rows.map((row) => row.indexname), [
    'roles_display_name_case_insensitive_idx',
    'user_role_assignments_one_current_role_per_user_idx',
  ]);

  const constraintClient = await pool.connect();
  try {
    await constraintClient.query('BEGIN');
    const probeUser = await constraintClient.query(
      `INSERT INTO application_users (status, display_name)
       VALUES ('disabled', 'Role constraint probe') RETURNING id`
    );
    const managerId = await roleIdForKey('manager', constraintClient);
    const storekeeperId = await roleIdForKey('storekeeper', constraintClient);
    await constraintClient.query(
      `INSERT INTO user_role_assignments (application_user_id, role_id) VALUES ($1, $2)`,
      [probeUser.rows[0].id, managerId]
    );
    await constraintClient.query('SAVEPOINT duplicate_assignment');
    await assert.rejects(
      constraintClient.query(
        `INSERT INTO user_role_assignments (application_user_id, role_id) VALUES ($1, $2)`,
        [probeUser.rows[0].id, storekeeperId]
      ),
      (error) => error.code === '23505'
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT duplicate_assignment');

    await constraintClient.query('SAVEPOINT reserved_grant');
    await assert.rejects(
      constraintClient.query(
        `INSERT INTO role_permissions (role_id, permission_key)
         VALUES ($1, 'users.manage')`,
        [managerId]
      ),
      /reserved for the built-in Administrator role/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT reserved_grant');

    await constraintClient.query('SAVEPOINT role_delete');
    await assert.rejects(
      constraintClient.query('DELETE FROM roles WHERE id = $1', [managerId]),
      /deactivate a role instead of deleting it/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT role_delete');

    await constraintClient.query('SAVEPOINT role_truncate');
    await assert.rejects(
      constraintClient.query('TRUNCATE roles CASCADE'),
      /roles cannot be truncated/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT role_truncate');

    await constraintClient.query('SAVEPOINT role_permissions_truncate');
    await assert.rejects(
      constraintClient.query('TRUNCATE role_permissions'),
      /role_permissions cannot be truncated/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT role_permissions_truncate');

    await constraintClient.query('SAVEPOINT role_key_mutation');
    await assert.rejects(
      constraintClient.query(
        `UPDATE roles SET role_key = 'renamed_manager_key' WHERE id = $1`,
        [managerId]
      ),
      /role_key and is_system are immutable/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT role_key_mutation');

    await constraintClient.query('SAVEPOINT role_system_mutation');
    await assert.rejects(
      constraintClient.query('UPDATE roles SET is_system = FALSE WHERE id = $1', [managerId]),
      /role_key and is_system are immutable/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT role_system_mutation');

    await constraintClient.query('SAVEPOINT administrator_mutation');
    await assert.rejects(
      constraintClient.query(
        `UPDATE roles SET status = 'disabled'
         WHERE role_key = 'administrator' AND is_system = TRUE`
      ),
      /built-in Administrator role is immutable/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT administrator_mutation');

    await constraintClient.query('SAVEPOINT administrator_permission_removal');
    await assert.rejects(
      constraintClient.query(
        `DELETE FROM role_permissions mapping
         USING roles role
         WHERE mapping.role_id = role.id
           AND role.role_key = 'administrator'
           AND mapping.permission_key = 'products.view'`
      ),
      /Administrator permissions cannot be removed/
    );
    await constraintClient.query('ROLLBACK TO SAVEPOINT administrator_permission_removal');

    await constraintClient.query(
      `INSERT INTO permissions (permission_key, description)
       VALUES ('integration.future_permission', 'Future permission probe')`
    );
    assert.equal(Number((await constraintClient.query(
      `SELECT COUNT(*) FROM role_permissions mapping
       JOIN roles role ON role.id = mapping.role_id
       WHERE role.role_key = 'administrator'
         AND mapping.permission_key = 'integration.future_permission'`
    )).rows[0].count), 1);
    await constraintClient.query('ROLLBACK');
  } finally {
    constraintClient.release();
  }
});

test('migration 028 aborts without changing unsafe existing RBAC state', async () => {
  const databaseName = 'amber_custom_role_conflict_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preCustomRoleDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-custom-role-migrations-')
  );
  try {
    const migrationDirectory = path.resolve(serverRoot, 'migrations');
    const migrationFiles = (await fs.readdir(migrationDirectory))
      .filter((fileName) => fileName.endsWith('.sql') && !fileName.startsWith('028_'));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(migrationDirectory, fileName),
      path.resolve(preCustomRoleDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preCustomRoleDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    const conflictPool = new Pool({ connectionString: databaseUrl });
    try {
      const user = await conflictPool.query(
        `INSERT INTO application_users (status, display_name)
         VALUES ('disabled', 'Ambiguous role user') RETURNING id`
      );
      await conflictPool.query(
        `INSERT INTO user_role_assignments (application_user_id, role_id)
         SELECT $1, id FROM roles WHERE role_key IN ('manager', 'storekeeper')`,
        [user.rows[0].id]
      );
      await assert.rejects(
        runNodeInDatabase(databaseUrl, `
          const db = require('./src/db/pool');
          const { runMigrations } = require('./src/db/run-migrations');
          runMigrations()
            .finally(() => db.end())
            .catch((error) => { console.error(error); process.exitCode = 1; });
        `),
        /cannot enforce one current role/
      );
      assert.equal(Number((await conflictPool.query(
        `SELECT COUNT(*) FROM user_role_assignments
         WHERE application_user_id = $1 AND revoked_at IS NULL`,
        [user.rows[0].id]
      )).rows[0].count), 2);
      assert.equal((await conflictPool.query(
        `SELECT COUNT(*)::int AS count FROM schema_migrations
         WHERE name = '028_custom_roles.sql'`
      )).rows[0].count, 0);

      await conflictPool.query(
        `UPDATE user_role_assignments
         SET revoked_at = CURRENT_TIMESTAMP
         WHERE application_user_id = $1
           AND role_id = (SELECT id FROM roles WHERE role_key = 'storekeeper')`,
        [user.rows[0].id]
      );
      await conflictPool.query(
        `INSERT INTO role_permissions (role_id, permission_key)
         SELECT id, 'users.manage' FROM roles WHERE role_key = 'manager'`
      );
      await assert.rejects(
        runNodeInDatabase(databaseUrl, `
          const db = require('./src/db/pool');
          const { runMigrations } = require('./src/db/run-migrations');
          runMigrations()
            .finally(() => db.end())
            .catch((error) => { console.error(error); process.exitCode = 1; });
        `),
        /cannot preserve reserved permissions/
      );
      assert.equal(Number((await conflictPool.query(
        `SELECT COUNT(*) FROM role_permissions mapping
         JOIN roles role ON role.id = mapping.role_id
         WHERE role.role_key = 'manager' AND mapping.permission_key = 'users.manage'`
      )).rows[0].count), 1, 'failed migration must not silently revoke reserved mappings');
    } finally {
      await conflictPool.end();
    }
  } finally {
    await fs.rm(preCustomRoleDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration 025 adds nullable user attribution and a nonnegative correction claim epoch', async () => {
  const columns = await pool.query(`
    SELECT column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'correction_requests'
      AND column_name = ANY($1::text[])
    ORDER BY column_name
  `, [[
    'claim_version',
    'claimed_by_user_id',
    'created_by_user_id',
  ]]);
  assert.deepEqual(columns.rows, [
    { column_name: 'claim_version', is_nullable: 'NO', column_default: '0' },
    { column_name: 'claimed_by_user_id', is_nullable: 'YES', column_default: null },
    { column_name: 'created_by_user_id', is_nullable: 'YES', column_default: null },
  ]);

  const indexes = await pool.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'correction_requests'
      AND indexname LIKE 'correction_requests_%_user_idx'
    ORDER BY indexname
  `);
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    'correction_requests_claimed_by_user_idx',
    'correction_requests_created_by_user_idx',
  ]);
  const foreignKeys = await pool.query(`
    SELECT kcu.column_name, ccu.table_name AS referenced_table, rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_schema = tc.constraint_schema
     AND rc.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_schema = rc.unique_constraint_schema
     AND ccu.constraint_name = rc.unique_constraint_name
    WHERE tc.constraint_schema = 'public'
      AND tc.table_name = 'correction_requests'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name IN ('created_by_user_id', 'claimed_by_user_id')
    ORDER BY kcu.column_name
  `);
  assert.deepEqual(foreignKeys.rows, [
    {
      column_name: 'claimed_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      column_name: 'created_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
  ]);
});

test('migration 026 adds only nullable repricing actor references with restricted deletion', async () => {
  const columns = await pool.query(`
    SELECT table_name, column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (
        ('repricing_drafts', 'created_by_user_id'),
        ('repricing_drafts', 'last_modified_by_user_id'),
        ('repricing_drafts', 'discarded_by_user_id'),
        ('repricing_batches', 'applied_by_user_id'),
        ('repricing_batches', 'rolled_back_by_user_id')
      )
    ORDER BY table_name, column_name
  `);
  assert.deepEqual(columns.rows, [
    {
      table_name: 'repricing_batches',
      column_name: 'applied_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'repricing_batches',
      column_name: 'rolled_back_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'repricing_drafts',
      column_name: 'created_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'repricing_drafts',
      column_name: 'discarded_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'repricing_drafts',
      column_name: 'last_modified_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
  ]);

  const foreignKeys = await pool.query(`
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS referenced_table, rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_schema = tc.constraint_schema
     AND rc.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_schema = rc.unique_constraint_schema
     AND ccu.constraint_name = rc.unique_constraint_name
    WHERE tc.constraint_schema = 'public'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND (tc.table_name, kcu.column_name) IN (
        ('repricing_drafts', 'created_by_user_id'),
        ('repricing_drafts', 'last_modified_by_user_id'),
        ('repricing_drafts', 'discarded_by_user_id'),
        ('repricing_batches', 'applied_by_user_id'),
        ('repricing_batches', 'rolled_back_by_user_id')
      )
    ORDER BY tc.table_name, kcu.column_name
  `);
  assert.deepEqual(foreignKeys.rows, [
    {
      table_name: 'repricing_batches',
      column_name: 'applied_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      table_name: 'repricing_batches',
      column_name: 'rolled_back_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      table_name: 'repricing_drafts',
      column_name: 'created_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      table_name: 'repricing_drafts',
      column_name: 'discarded_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      table_name: 'repricing_drafts',
      column_name: 'last_modified_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
  ]);
});

test('migration 027 adds only nullable export and SKU publication actor references', async () => {
  const columns = await pool.query(`
    SELECT table_name, column_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (
        ('export_snapshots', 'created_by_user_id'),
        ('export_snapshots', 'confirmed_by_user_id'),
        ('sku_schema_versions', 'published_by_user_id')
      )
    ORDER BY table_name, column_name
  `);
  assert.deepEqual(columns.rows, [
    {
      table_name: 'export_snapshots',
      column_name: 'confirmed_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'export_snapshots',
      column_name: 'created_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
    {
      table_name: 'sku_schema_versions',
      column_name: 'published_by_user_id',
      is_nullable: 'YES',
      column_default: null,
    },
  ]);

  const foreignKeys = await pool.query(`
    SELECT tc.table_name, kcu.column_name, ccu.table_name AS referenced_table, rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_schema = tc.constraint_schema
     AND kcu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_schema = tc.constraint_schema
     AND rc.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_schema = rc.unique_constraint_schema
     AND ccu.constraint_name = rc.unique_constraint_name
    WHERE tc.constraint_schema = 'public'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND (tc.table_name, kcu.column_name) IN (
        ('export_snapshots', 'created_by_user_id'),
        ('export_snapshots', 'confirmed_by_user_id'),
        ('sku_schema_versions', 'published_by_user_id')
      )
    ORDER BY tc.table_name, kcu.column_name
  `);
  assert.deepEqual(foreignKeys.rows, [
    {
      table_name: 'export_snapshots',
      column_name: 'confirmed_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      table_name: 'export_snapshots',
      column_name: 'created_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
    {
      table_name: 'sku_schema_versions',
      column_name: 'published_by_user_id',
      referenced_table: 'application_users',
      delete_rule: 'RESTRICT',
    },
  ]);
});

test('migration 023 constrains and makes durable audit records immutable', async () => {
  const columns = await pool.query(`
    SELECT column_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'audit_events'
    ORDER BY ordinal_position
  `);
  assert.deepEqual(columns.rows, [
    { column_name: 'id', is_nullable: 'NO' },
    { column_name: 'event_key', is_nullable: 'NO' },
    { column_name: 'actor_user_id', is_nullable: 'NO' },
    { column_name: 'actor_snapshot', is_nullable: 'NO' },
    { column_name: 'subject_type', is_nullable: 'NO' },
    { column_name: 'subject_id', is_nullable: 'NO' },
    { column_name: 'request_id', is_nullable: 'YES' },
    { column_name: 'details', is_nullable: 'NO' },
    { column_name: 'occurred_at', is_nullable: 'NO' },
  ]);

  const indexes = await pool.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'audit_events'
    ORDER BY indexname
  `);
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    'audit_events_actor_idx',
    'audit_events_event_key_idx',
    'audit_events_occurred_idx',
    'audit_events_pkey',
    'audit_events_subject_idx',
  ]);

  const grants = await pool.query(`
    SELECT r.role_key
    FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id
    WHERE rp.permission_key = 'audit.view'
    ORDER BY r.role_key
  `);
  assert.deepEqual(grants.rows, [{ role_key: 'administrator' }]);
  assert.equal(
    Number((await pool.query('SELECT count(*) FROM audit_events')).rows[0].count),
    0,
    'migration must not synthesize historical events'
  );

  const actor = await pool.query(
    `INSERT INTO application_users (status, display_name, preferred_username)
     VALUES ('pending', 'Migration Actor', 'migration.actor')
     RETURNING id`
  );
  const actorUserId = Number(actor.rows[0].id);
  await assert.rejects(
    pool.query(
      `INSERT INTO audit_events
       (event_key, actor_user_id, actor_snapshot, subject_type, subject_id)
       VALUES ('application_user.tested', $1,
               '{"displayName":"Migration Actor","preferredUsername":"migration.actor","email":"forbidden"}'::jsonb,
               'application_user', $2)`,
      [actorUserId, String(actorUserId)]
    ),
    (error) => error.code === '23514'
  );
  const event = await pool.query(
    `INSERT INTO audit_events
     (event_key, actor_user_id, actor_snapshot, subject_type, subject_id, request_id)
     VALUES ('application_user.tested', $1,
             '{"displayName":"Migration Actor","preferredUsername":"migration.actor"}'::jsonb,
             'application_user', $2, 'migration-023-test')
     RETURNING id`,
    [actorUserId, String(actorUserId)]
  );
  await assert.rejects(
    pool.query('UPDATE audit_events SET details = $1::jsonb WHERE id = $2', [
      JSON.stringify({ changed: true }),
      event.rows[0].id,
    ]),
    /audit events are immutable/
  );
  await assert.rejects(
    pool.query('DELETE FROM audit_events WHERE id = $1', [event.rows[0].id]),
    /audit events are immutable/
  );
  await assert.rejects(
    pool.query('TRUNCATE audit_events'),
    /audit events are immutable/
  );
});

test('migration 024 preserves historical product attribution as null', async () => {
  const databaseName = 'amber_product_actor_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preAttributionDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-product-attribution-migrations-')
  );
  try {
    const migrationDirectory = path.resolve(serverRoot, 'migrations');
    const migrationFiles = (await fs.readdir(migrationDirectory))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('024_')
        && !fileName.startsWith('025_')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(migrationDirectory, fileName),
      path.resolve(preAttributionDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preAttributionDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const migrationPool = new Pool({ connectionString: databaseUrl });
    try {
      await migrationPool.query(
        "INSERT INTO categories (code, name, requires_weight) VALUES ('HA', 'Historical attribution', 0)"
      );
      const products = await migrationPool.query(`
        INSERT INTO products
          (full_sku, base_sku, sequence_number, category, weight, total_price,
           total_price_uah, price_per_gram, details, status)
        VALUES
          ('HA1001', 'HA1', 1, 'HA', 0, 25, 1000, 0, '{}'::jsonb, 'corrected'),
          ('HA2002', 'HA2', 2, 'HA', 0, 30, 1200, 0, '{}'::jsonb, 'active')
        RETURNING id, full_sku
      `);
      const bySku = Object.fromEntries(products.rows.map((row) => [row.full_sku, Number(row.id)]));
      await migrationPool.query(
        `INSERT INTO product_corrections
          (source_product_id, corrected_product_id, source_sku, corrected_sku,
           old_payload, new_payload, reason, price_delta_uah)
         VALUES ($1, $2, 'HA1001', 'HA2002', '{}'::jsonb, '{}'::jsonb, 'historical', 200)`,
        [bySku.HA1001, bySku.HA2002]
      );
    } finally {
      await migrationPool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      const columns = await verifiedPool.query(`
        SELECT table_name, column_name, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('products', 'created_by_user_id'),
            ('products', 'archived_by_user_id'),
            ('product_corrections', 'performed_by_user_id')
          )
        ORDER BY table_name, column_name
      `);
      assert.deepEqual(columns.rows, [
        { table_name: 'product_corrections', column_name: 'performed_by_user_id', is_nullable: 'YES' },
        { table_name: 'products', column_name: 'archived_by_user_id', is_nullable: 'YES' },
        { table_name: 'products', column_name: 'created_by_user_id', is_nullable: 'YES' },
      ]);
      const foreignKeys = await verifiedPool.query(`
        SELECT tc.table_name, kcu.column_name, ccu.table_name AS referenced_table,
               rc.delete_rule
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_schema = tc.constraint_schema
         AND kcu.constraint_name = tc.constraint_name
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_schema = tc.constraint_schema
         AND rc.constraint_name = tc.constraint_name
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_schema = rc.unique_constraint_schema
         AND ccu.constraint_name = rc.unique_constraint_name
        WHERE tc.constraint_schema = 'public'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name IN ('products', 'product_corrections')
          AND kcu.column_name IN (
            'created_by_user_id', 'archived_by_user_id', 'performed_by_user_id'
          )
        ORDER BY tc.table_name, kcu.column_name
      `);
      assert.deepEqual(foreignKeys.rows, [
        {
          table_name: 'product_corrections',
          column_name: 'performed_by_user_id',
          referenced_table: 'application_users',
          delete_rule: 'RESTRICT',
        },
        {
          table_name: 'products',
          column_name: 'archived_by_user_id',
          referenced_table: 'application_users',
          delete_rule: 'RESTRICT',
        },
        {
          table_name: 'products',
          column_name: 'created_by_user_id',
          referenced_table: 'application_users',
          delete_rule: 'RESTRICT',
        },
      ]);
      assert.deepEqual((await verifiedPool.query(`
        SELECT created_by_user_id, archived_by_user_id
        FROM products
        WHERE full_sku IN ('HA1001', 'HA2002')
        ORDER BY full_sku
      `)).rows, [
        { created_by_user_id: null, archived_by_user_id: null },
        { created_by_user_id: null, archived_by_user_id: null },
      ]);
      assert.deepEqual((await verifiedPool.query(`
        SELECT performed_by_user_id FROM product_corrections WHERE source_sku = 'HA1001'
      `)).rows, [{ performed_by_user_id: null }]);
      assert.equal(Number((await verifiedPool.query(
        "SELECT count(*) FROM audit_events WHERE event_key LIKE 'product.%'"
      )).rows[0].count), 0);
    } finally {
      await verifiedPool.end();
    }
  } finally {
    await fs.rm(preAttributionDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration 026 preserves historical repricing attribution as null without audit synthesis', async () => {
  const databaseName = 'amber_repricing_actor_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preAttributionDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-repricing-attribution-migrations-')
  );
  try {
    const migrationDirectory = path.resolve(serverRoot, 'migrations');
    const migrationFiles = (await fs.readdir(migrationDirectory))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(migrationDirectory, fileName),
      path.resolve(preAttributionDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preAttributionDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const migrationPool = new Pool({ connectionString: databaseUrl });
    let batchId;
    let draftId;
    try {
      const batch = await migrationPool.query(`
        INSERT INTO repricing_batches
          (scenario_name, preview_token, status, applied_at)
        VALUES ('Historical batch', 'historical-batch-token', 'completed', CURRENT_TIMESTAMP)
        RETURNING id
      `);
      batchId = Number(batch.rows[0].id);
      const draft = await migrationPool.query(`
        INSERT INTO repricing_drafts
          (category_code, scenario_name, preview_fingerprint, status, applied_batch_id,
           applied_at)
        VALUES ('HX', 'Historical draft', 'historical-draft-fingerprint', 'applied', $1,
                CURRENT_TIMESTAMP)
        RETURNING id
      `, [batchId]);
      draftId = Number(draft.rows[0].id);
    } finally {
      await migrationPool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      assert.deepEqual((await verifiedPool.query(`
        SELECT created_by_user_id, last_modified_by_user_id, discarded_by_user_id
        FROM repricing_drafts WHERE id = $1
      `, [draftId])).rows, [{
        created_by_user_id: null,
        last_modified_by_user_id: null,
        discarded_by_user_id: null,
      }]);
      assert.deepEqual((await verifiedPool.query(`
        SELECT applied_by_user_id, rolled_back_by_user_id
        FROM repricing_batches WHERE id = $1
      `, [batchId])).rows, [{
        applied_by_user_id: null,
        rolled_back_by_user_id: null,
      }]);
      assert.equal(Number((await verifiedPool.query(
        "SELECT count(*) FROM audit_events WHERE event_key LIKE 'repricing.%' OR event_key LIKE 'repricing_draft.%'"
      )).rows[0].count), 0);
    } finally {
      await verifiedPool.end();
    }
  } finally {
    await fs.rm(preAttributionDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration 027 preserves historical export and publication attribution as null', async () => {
  const databaseName = 'amber_export_schema_actor_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preAttributionDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-export-schema-attribution-migrations-')
  );
  try {
    const migrationDirectory = path.resolve(serverRoot, 'migrations');
    const migrationFiles = (await fs.readdir(migrationDirectory))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(migrationDirectory, fileName),
      path.resolve(preAttributionDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preAttributionDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const migrationPool = new Pool({ connectionString: databaseUrl });
    let snapshotId;
    let schemaVersionId;
    try {
      snapshotId = 'historical-export-snapshot';
      await migrationPool.query(`
        INSERT INTO export_snapshots
          (id, idempotency_key, from_sku, resolved_to_sku, exported_to_product_id,
           row_count, file_name, csv_content, status, confirmed_at)
        VALUES ($1, 'historical-export-key', 'HX1001', 'HX1001', 0,
                0, 'historical.csv', 'sku,price_uah', 'confirmed', CURRENT_TIMESTAMP)
      `, [snapshotId]);
      await migrationPool.query(
        "INSERT INTO categories (code, name, requires_weight) VALUES ('HX', 'Historical schema', 0)"
      );
      const schemaVersion = await migrationPool.query(`
        INSERT INTO sku_schema_versions
          (category_code, version, marker, status, config_hash)
        VALUES ('HX', 1, '', 'active', 'historical-schema-hash')
        RETURNING id
      `);
      schemaVersionId = Number(schemaVersion.rows[0].id);
    } finally {
      await migrationPool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      assert.deepEqual((await verifiedPool.query(`
        SELECT created_by_user_id, confirmed_by_user_id
        FROM export_snapshots WHERE id = $1
      `, [snapshotId])).rows, [{
        created_by_user_id: null,
        confirmed_by_user_id: null,
      }]);
      assert.deepEqual((await verifiedPool.query(`
        SELECT published_by_user_id FROM sku_schema_versions WHERE id = $1
      `, [schemaVersionId])).rows, [{ published_by_user_id: null }]);
      assert.equal(Number((await verifiedPool.query(`
        SELECT count(*) FROM audit_events
        WHERE event_key LIKE 'export_snapshot.%' OR event_key LIKE 'sku_schema.%'
      `)).rows[0].count), 0);
    } finally {
      await verifiedPool.end();
    }
  } finally {
    await fs.rm(preAttributionDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
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

test('operational mutation logs use the resolved local actor and are not durable audit events', async () => {
  const entries = [];
  const originalInfo = logger.info;
  logger.info = (event, context) => entries.push({ event, context });
  try {
    const response = await request('/api/preview', {
      method: 'POST',
      headers: { 'X-Request-ID': 'operational-actor-test' },
      body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(response.response.status, 200, response.text);
    const mutationLog = entries.find((entry) => entry.event === 'http.mutation.completed');
    assert.ok(mutationLog);
    assert.equal(mutationLog.context.requestId, 'operational-actor-test');
    assert.equal(mutationLog.context.actorId, authenticatedSession.applicationUser.id);
    assert.equal(entries.some((entry) => entry.event === 'audit.mutation'), false);
  } finally {
    logger.info = originalInfo;
  }
});

test('product create, direct recount, and archive share local actor attribution and audit', async () => {
  const actorUserId = authenticatedSession.applicationUser.id;
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(preview.response.status, 200, preview.text);
  const created = await request('/api/save', {
    method: 'POST',
    headers: { 'X-Request-ID': 'audit-product-created' },
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: preview.data.previewToken,
    },
  });
  assert.equal(created.response.status, 200, created.text);
  const sourceProductId = Number(created.data.id);
  assert.equal(Number((await pool.query(
    'SELECT created_by_user_id FROM products WHERE id = $1', [sourceProductId]
  )).rows[0].created_by_user_id), actorUserId);
  assert.deepEqual((await pool.query(
    `SELECT event_key, actor_user_id, request_id, details
     FROM audit_events WHERE subject_type = 'product' AND subject_id = $1 ORDER BY id`,
    [String(sourceProductId)]
  )).rows, [{
    event_key: 'product.created',
    actor_user_id: String(actorUserId),
    request_id: 'audit-product-created',
    details: { fullSku: created.data.fullSku, categoryCode: 'ZZ' },
  }]);

  const recountPayload = {
    sourceSku: created.data.fullSku,
    answers: { kind: 2 },
    reason: 'actor attribution test',
  };
  const recountPreview = await request('/api/recount/preview', {
    method: 'POST', body: recountPayload,
  });
  assert.equal(recountPreview.response.status, 200, recountPreview.text);
  const recounted = await request('/api/recount/apply', {
    method: 'POST',
    headers: { 'X-Request-ID': 'audit-product-recounted' },
    body: recountPayload,
  });
  assert.equal(recounted.response.status, 200, recounted.text);
  const correctedProductId = Number(recounted.data.correctedProductId);
  const recountState = await pool.query(
    `SELECT source.status AS source_status,
            source.exclude_from_export AS source_excluded,
            corrected.created_by_user_id,
            corrected.exclude_from_export AS corrected_excluded,
            pc.id AS product_correction_id,
            pc.performed_by_user_id
     FROM products source
     JOIN products corrected ON corrected.id = source.corrected_to_product_id
     JOIN product_corrections pc
       ON pc.source_product_id = source.id AND pc.corrected_product_id = corrected.id
     WHERE source.id = $1`,
    [sourceProductId]
  );
  assert.equal(recountState.rows[0].source_status, 'corrected');
  assert.equal(Number(recountState.rows[0].source_excluded), 1);
  assert.equal(Number(recountState.rows[0].corrected_excluded), 1);
  assert.equal(Number(recountState.rows[0].created_by_user_id), actorUserId);
  assert.equal(Number(recountState.rows[0].performed_by_user_id), actorUserId);
  const productCorrectionId = Number(recountState.rows[0].product_correction_id);
  assert.deepEqual((await pool.query(
    `SELECT event_key, actor_user_id, request_id, details
     FROM audit_events
     WHERE event_key = 'product.recounted'
       AND subject_type = 'product' AND subject_id = $1`,
    [String(sourceProductId)]
  )).rows, [{
    event_key: 'product.recounted',
    actor_user_id: String(actorUserId),
    request_id: 'audit-product-recounted',
    details: {
      sourceSku: created.data.fullSku,
      correctedProductId,
      correctedSku: recounted.data.corrected.fullSku,
      productCorrectionId,
    },
  }]);

  const archived = await request('/api/delete', {
    method: 'POST',
    headers: { 'X-Request-ID': 'audit-product-archived' },
    body: { skuToDelete: recounted.data.corrected.fullSku },
  });
  assert.equal(archived.response.status, 200, archived.text);
  assert.deepEqual((await pool.query(
    'SELECT status, archived_by_user_id FROM products WHERE id = $1', [correctedProductId]
  )).rows, [{ status: 'archived', archived_by_user_id: String(actorUserId) }]);
  assert.deepEqual((await pool.query(
    `SELECT event_key, actor_user_id, request_id, details
     FROM audit_events
     WHERE event_key = 'product.archived'
       AND subject_type = 'product' AND subject_id = $1`,
    [String(correctedProductId)]
  )).rows, [{
    event_key: 'product.archived',
    actor_user_id: String(actorUserId),
    request_id: 'audit-product-archived',
    details: { fullSku: recounted.data.corrected.fullSku },
  }]);

  const repeatedArchive = await request('/api/delete', {
    method: 'POST',
    headers: { 'X-Request-ID': 'audit-product-archive-no-op' },
    body: { skuToDelete: recounted.data.corrected.fullSku },
  });
  assert.equal(repeatedArchive.response.status, 404, repeatedArchive.text);
  assert.equal(Number((await pool.query(
    `SELECT count(*) FROM audit_events
     WHERE event_key = 'product.archived' AND subject_id = $1`,
    [String(correctedProductId)]
  )).rows[0].count), 1);
});

test('product timeline resolves every actual SKU across corrections and combines business history', async () => {
  const actorUserId = Number(authenticatedSession.applicationUser.id);
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(preview.response.status, 200, preview.text);
  const created = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ, previewToken: preview.data.previewToken,
    },
  });
  assert.equal(created.response.status, 200, created.text);
  const skuA = created.data.fullSku;

  const direct = await request('/api/recount/apply', {
    method: 'POST',
    body: { sourceSku: skuA, answers: { kind: 2 }, reason: 'timeline direct correction' },
  });
  assert.equal(direct.response.status, 200, direct.text);
  const skuB = direct.data.corrected.fullSku;

  const correctionRequest = await request('/api/admin/correction-requests', {
    method: 'POST',
    body: { sourceSku: skuB, answers: { kind: 1 }, reason: 'timeline requested correction' },
  });
  assert.equal(correctionRequest.response.status, 200, correctionRequest.text);
  const correctionRequestId = Number(correctionRequest.data.request.id);
  const claim = await request(`/api/admin/correction-requests/${correctionRequestId}/claim`, {
    method: 'POST', body: {},
  });
  assert.equal(claim.response.status, 200, claim.text);
  const completed = await request(`/api/admin/correction-requests/${correctionRequestId}/complete`, {
    method: 'POST', body: { claimVersion: claim.data.request.claimVersion },
  });
  assert.equal(completed.response.status, 200, completed.text);
  const skuC = completed.data.request.finalPayload.fullSku;
  const currentProduct = await pool.query(
    'SELECT id, total_price_uah, details FROM products WHERE full_sku = $1', [skuC]
  );
  const currentProductId = Number(currentProduct.rows[0].id);
  const oldPrice = Number(currentProduct.rows[0].total_price_uah);
  const newPrice = oldPrice + 125;
  const batch = await pool.query(
    `INSERT INTO repricing_batches
       (scope, scenario_name, scenario_snapshot, preview_token, status, candidate_count,
        changed_count, applied_at, rolled_back_at, applied_by_user_id, rolled_back_by_user_id)
     VALUES ('global', 'Timeline fixture', '{}'::jsonb, $1, 'rolled_back', 1, 1,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 second', $2, $2)
     RETURNING id`,
    [`timeline-${Date.now()}`, actorUserId]
  );
  const batchId = Number(batch.rows[0].id);
  await pool.query(
    `INSERT INTO repricing_items
       (batch_id, product_id, sku, old_price_uah, new_price_uah, price_delta_uah,
        old_payload, new_payload)
     VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric,
       jsonb_build_object('totalPriceUah', $4::numeric, 'details', $7::jsonb),
       jsonb_build_object('totalPriceUah', $5::numeric, 'details', $7::jsonb))`,
    [batchId, currentProductId, skuC, oldPrice, newPrice, 125, JSON.stringify(currentProduct.rows[0].details || {})]
  );
  const actorSnapshot = JSON.stringify({ displayName: 'Critical Flows', preferredUsername: 'critical.flows' });
  await pool.query(
    `INSERT INTO audit_events
       (event_key, actor_user_id, actor_snapshot, subject_type, subject_id, details, occurred_at)
     VALUES
       ('repricing.applied', $1, $2::jsonb, 'repricing_batch', $3, '{}'::jsonb, CURRENT_TIMESTAMP),
       ('repricing.rolled_back', $1, $2::jsonb, 'repricing_batch', $3, '{}'::jsonb,
        CURRENT_TIMESTAMP + INTERVAL '1 second')`,
    [actorUserId, actorSnapshot, String(batchId)]
  );
  const archived = await request('/api/delete', {
    method: 'POST', body: { skuToDelete: skuC },
  });
  assert.equal(archived.response.status, 200, archived.text);

  const timelines = await Promise.all([skuA, skuB, skuC].map((sku) => (
    request(`/api/product-timeline?sku=${encodeURIComponent(sku)}`)
  )));
  for (const timeline of timelines) assert.equal(timeline.response.status, 200, timeline.text);
  const expectedSkus = [skuA, skuB, skuC];
  for (const timeline of timelines) {
    assert.deepEqual(timeline.data.lineage.products.map((product) => product.sku), expectedSkus);
    assert.equal(timeline.data.lineage.currentSku, skuC);
    assert.equal(timeline.data.lineage.integrity, 'ok');
    const types = timeline.data.events.map((event) => event.type);
    assert.ok(types.includes('product.created'));
    assert.equal(types.filter((type) => type === 'product.corrected').length, 2);
    assert.ok(types.includes('correction_request.created'));
    assert.ok(types.includes('correction_request.claimed'));
    assert.ok(types.includes('correction_request.completed'));
    assert.ok(types.includes('repricing.applied'));
    assert.ok(types.includes('repricing.rolled_back'));
    assert.ok(types.includes('product.archived'));
    const requestCompletion = timeline.data.events.find((event) => event.type === 'correction_request.completed');
    const requestedCorrection = timeline.data.events.find((event) => (
      event.type === 'product.corrected' && event.details.applicationMode === 'request'
    ));
    assert.equal(requestCompletion.groupKey, requestedCorrection.groupKey);
    assert.equal(JSON.stringify(timeline.data).includes('correctionRequestId'), false);
    assert.equal(JSON.stringify(timeline.data).includes('claimVersion'), false);
    assert.equal(Object.hasOwn(timeline.data.events[0], 'evidence'), false);
  }
  assert.deepEqual(
    timelines[0].data.events.map((event) => event.type),
    timelines[2].data.events.map((event) => event.type)
  );

  const missing = await request('/api/product-timeline?sku=ZZ-NOT-A-PRODUCT');
  assert.equal(missing.response.status, 404, missing.text);
  assert.equal(missing.data.code, 'SKU_HISTORY_NOT_FOUND');
  const invalid = await request('/api/product-timeline?sku=');
  assert.equal(invalid.response.status, 400, invalid.text);
  assert.equal(invalid.data.code, 'INVALID_SKU');
});

test('a failed product audit insert rolls back product creation and SKU reservation', async () => {
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(preview.response.status, 200, preview.text);
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_test_product_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced product audit failure';
    END;
    $$;
    CREATE TRIGGER fail_test_product_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW
    WHEN (NEW.event_key = 'product.created')
    EXECUTE FUNCTION fail_test_product_audit();
  `);
  try {
    const failed = await request('/api/save', {
      method: 'POST',
      headers: { 'X-Request-ID': 'audit-product-create-rollback' },
      body: {
        category: 'ZZ',
        answers: { kind: 1 },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: preview.data.previewToken,
      },
    });
    assert.equal(failed.response.status, 500, failed.text);
    assert.equal(Number((await pool.query(
      'SELECT count(*) FROM products WHERE full_sku = $1', [preview.data.fullProposedSku]
    )).rows[0].count), 0);
    assert.equal(Number((await pool.query(
      'SELECT count(*) FROM sku_registry WHERE full_sku = $1', [preview.data.fullProposedSku]
    )).rows[0].count), 0);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE event_key = 'product.created' AND request_id = 'audit-product-create-rollback'`
    )).rows[0].count), 0);
  } finally {
    await pool.query('DROP TRIGGER fail_test_product_audit ON audit_events');
    await pool.query('DROP FUNCTION fail_test_product_audit()');
  }
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
  assert.equal(stillActive.response.status, 403, stillActive.text);
  assert.equal(stillActive.data.code, 'INSUFFICIENT_PERMISSION');
  assert.equal(stillActive.data.requiredPermission, 'products.view');

  const administratorRole = await pool.query(
    "SELECT id FROM roles WHERE role_key = 'administrator'"
  );
  await pool.query(
    `INSERT INTO user_role_assignments (application_user_id, role_id)
     VALUES ($1, $2)`,
    [userId, administratorRole.rows[0].id]
  );
  const restoredMe = await request('/api/auth/me');
  assert.equal(restoredMe.data.permissions.length, 26);
  const permittedAgain = await request('/api/config');
  assert.equal(permittedAgain.response.status, 200, permittedAgain.text);
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

test('migration 023 rolls back its audit schema and permission grant together', async () => {
  const databaseName = 'amber_audit_migration_rollback_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preAuditDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-audit-migrations-')
  );
  const failingAuditDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-failing-audit-migration-')
  );
  try {
    const migrationDirectory = path.resolve(serverRoot, 'migrations');
    const migrationFiles = (await fs.readdir(migrationDirectory))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('023_')
        && !fileName.startsWith('024_')
        && !fileName.startsWith('025_')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(migrationDirectory, fileName),
      path.resolve(preAuditDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preAuditDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const auditSql = await fs.readFile(
      path.resolve(migrationDirectory, '023_audit_events.sql'),
      'utf8'
    );
    await fs.writeFile(
      path.resolve(failingAuditDirectory, '023_audit_events.sql'),
      `${auditSql}\nSELECT * FROM forced_missing_audit_migration_table;\n`
    );
    await assert.rejects(runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(failingAuditDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `));

    const migrationPool = new Pool({ connectionString: databaseUrl });
    try {
      const state = await migrationPool.query(`
        SELECT to_regclass('public.audit_events') AS audit_events,
               to_regprocedure('public.protect_audit_event_immutability()') AS audit_function,
               (SELECT count(*)::int FROM permissions WHERE permission_key = 'audit.view')
                 AS permission_count,
               (SELECT count(*)::int FROM schema_migrations
                WHERE name = '023_audit_events.sql') AS migration_count
      `);
      assert.deepEqual(state.rows, [{
        audit_events: null,
        audit_function: null,
        permission_count: 0,
        migration_count: 0,
      }]);
    } finally {
      await migrationPool.end();
    }
  } finally {
    await fs.rm(preAuditDirectory, { recursive: true, force: true });
    await fs.rm(failingAuditDirectory, { recursive: true, force: true });
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
         && !fileName.startsWith('021_')
         && !fileName.startsWith('022_')
         && !fileName.startsWith('023_')
         && !fileName.startsWith('024_')
         && !fileName.startsWith('025_')
         && !fileName.startsWith('026_')
         && !fileName.startsWith('027_')
         && !fileName.startsWith('028_')
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
        "SELECT count(*)::int AS count FROM schema_migrations WHERE name ~ '^(015|016|017|018|019|020|021|022|023|024)_'"
      );
      assert.equal(checkpointMigration.rows[0].count, 10);
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

test('migrations 020-024 upgrade a database at migration 019 and repeated startup stays safe', async () => {
  const databaseName = 'amber_rbac_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preRbacDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-pre-rbac-migrations-'));
  try {
    const migrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('020_')
        && !fileName.startsWith('021_')
        && !fileName.startsWith('022_')
        && !fileName.startsWith('023_')
        && !fileName.startsWith('024_')
        && !fileName.startsWith('025_')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
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
        if (counts.rows[0].permissions !== 26
            || counts.rows[0].roles !== 3
            || counts.rows[0].mappings !== 50) {
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

test('migration 021 adds business capabilities and corrects built-in mappings on migration 020', async () => {
  const databaseName = 'amber_permission_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const prePermissionDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-permission-migrations-')
  );
  try {
    const migrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('021_')
        && !fileName.startsWith('022_')
        && !fileName.startsWith('023_')
        && !fileName.startsWith('024_')
        && !fileName.startsWith('025_')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(serverRoot, 'migrations', fileName),
      path.resolve(prePermissionDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(prePermissionDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const upgradePool = new Pool({ connectionString: databaseUrl });
    try {
      const before = await upgradePool.query(`
        SELECT r.role_key, rp.permission_key
        FROM roles r
        JOIN role_permissions rp ON rp.role_id = r.id
        WHERE (r.role_key = 'storekeeper' AND rp.permission_key = 'products.archive')
           OR rp.permission_key IN ('products.recount', 'exports.view')
      `);
      assert.deepEqual(before.rows, []);
    } finally {
      await upgradePool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      (async () => {
        await runMigrations();
        await runMigrations();
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      const after = await verifiedPool.query(`
        SELECT r.role_key, ARRAY_AGG(rp.permission_key ORDER BY rp.permission_key) AS permission_keys
        FROM roles r
        JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.role_key IN ('administrator', 'manager', 'storekeeper')
        GROUP BY r.id
        ORDER BY r.role_key
      `);
      const byRole = Object.fromEntries(after.rows.map((row) => [row.role_key, row.permission_keys]));
      assert.equal(byRole.administrator.includes('exports.view'), true);
      assert.equal(byRole.administrator.includes('products.recount'), true);
      assert.equal(byRole.manager.includes('exports.view'), true);
      assert.equal(byRole.manager.includes('products.archive'), false);
      assert.equal(byRole.manager.includes('products.recount'), false);
      assert.equal(byRole.storekeeper.includes('exports.view'), true);
      assert.equal(byRole.storekeeper.includes('products.archive'), true);
      assert.equal(byRole.storekeeper.includes('products.recount'), true);
    } finally {
      await verifiedPool.end();
    }
  } finally {
    await fs.rm(prePermissionDirectory, { recursive: true, force: true });
    await dropTestDatabase(databaseName);
  }
});

test('migration 022 removes Manager correction processing without changing other built-in roles', async () => {
  const databaseName = 'amber_manager_correction_permissions_upgrade_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const preManagerPermissionDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'amber-pre-manager-permission-migrations-')
  );
  try {
    const migrationFiles = (await fs.readdir(path.resolve(serverRoot, 'migrations')))
      .filter((fileName) => (
        fileName.endsWith('.sql')
        && !fileName.startsWith('022_')
        && !fileName.startsWith('023_')
        && !fileName.startsWith('024_')
        && !fileName.startsWith('025_')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
      ));
    await Promise.all(migrationFiles.map((fileName) => fs.copyFile(
      path.resolve(serverRoot, 'migrations', fileName),
      path.resolve(preManagerPermissionDirectory, fileName)
    )));
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations({ directory: ${JSON.stringify(preManagerPermissionDirectory)} })
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const upgradePool = new Pool({ connectionString: databaseUrl });
    try {
      const before = await upgradePool.query(`
        SELECT r.role_key, ARRAY_AGG(rp.permission_key ORDER BY rp.permission_key) AS permission_keys
        FROM roles r
        JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.role_key IN ('administrator', 'manager', 'storekeeper')
        GROUP BY r.id
        ORDER BY r.role_key
      `);
      const byRole = Object.fromEntries(before.rows.map((row) => [row.role_key, row.permission_keys]));
      assert.equal(byRole.manager.includes('corrections.claim'), true);
      assert.equal(byRole.manager.includes('corrections.complete'), true);
      assert.equal(byRole.administrator.includes('corrections.claim'), true);
      assert.equal(byRole.storekeeper.includes('corrections.complete'), true);
    } finally {
      await upgradePool.end();
    }

    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      (async () => {
        await runMigrations();
        await runMigrations();
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const verifiedPool = new Pool({ connectionString: databaseUrl });
    try {
      const after = await verifiedPool.query(`
        SELECT r.role_key, ARRAY_AGG(rp.permission_key ORDER BY rp.permission_key) AS permission_keys
        FROM roles r
        JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.role_key IN ('administrator', 'manager', 'storekeeper')
        GROUP BY r.id
        ORDER BY r.role_key
      `);
      const byRole = Object.fromEntries(after.rows.map((row) => [row.role_key, row.permission_keys]));
      assert.equal(byRole.manager.includes('corrections.claim'), false);
      assert.equal(byRole.manager.includes('corrections.complete'), false);
      assert.equal(byRole.manager.includes('corrections.create'), true);
      assert.equal(byRole.manager.includes('corrections.reject'), true);
      assert.equal(byRole.administrator.includes('corrections.claim'), true);
      assert.equal(byRole.administrator.includes('corrections.complete'), true);
      assert.equal(byRole.storekeeper.includes('corrections.claim'), true);
      assert.equal(byRole.storekeeper.includes('corrections.complete'), true);
    } finally {
      await verifiedPool.end();
    }
  } finally {
    await fs.rm(preManagerPermissionDirectory, { recursive: true, force: true });
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
    assert.equal(access.roles.length, 1);
    assert.equal(access.roles[0].key, 'administrator');
    assert.equal(access.roles[0].displayName, 'Administrator');
    assert.equal(Number.isSafeInteger(access.roles[0].id), true);
    assert.equal(access.permissions.length, 26);
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

test('legacy in-progress correction requests survive through migration 025 without false ownership', async () => {
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
        && !fileName.startsWith('021_')
        && !fileName.startsWith('022_')
        && !fileName.startsWith('023_')
        && !fileName.startsWith('024_')
        && !fileName.startsWith('025_')
        && !fileName.startsWith('026_')
        && !fileName.startsWith('027_')
        && !fileName.startsWith('028_')
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
        const actor = await db.query(
          "INSERT INTO application_users (status, display_name, preferred_username) "
            + "VALUES ('active', 'Legacy Claim Actor', 'legacy.claim.actor') RETURNING id"
        );
        const mutationContext = {
          actorUserId: Number(actor.rows[0].id),
          requestId: 'legacy-unowned-claim',
        };
        const before = await db.query(
          'SELECT status, claim_token_hash, claimed_at, created_by_user_id, '
            + 'claimed_by_user_id, claim_version '
            + 'FROM correction_requests WHERE id = $1',
          [${legacyRequestId}]
        );
        assert.deepEqual(before.rows[0], {
          status: 'in_progress', claim_token_hash: null, claimed_at: null,
          created_by_user_id: null, claimed_by_user_id: null, claim_version: '0',
        });
        const claimed = await claimCorrectionRequest(${legacyRequestId}, { mutationContext });
        assert.equal(claimed.request.status, 'in_progress');
        assert.equal(claimed.request.claimVersion, 1);
        assert.equal(Object.hasOwn(claimed, 'claimToken'), false);
        await assert.rejects(
          claimCorrectionRequest(${legacyRequestId}, { mutationContext }),
          /інший працівник/
        );
        await db.end();
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `);

    const upgradedPool = new Pool({ connectionString: databaseUrl });
    try {
      const claimed = await upgradedPool.query(
        `SELECT status, claim_token_hash, claimed_at, claimed_by_user_id, claim_version
         FROM correction_requests WHERE id = $1`,
        [legacyRequestId]
      );
      assert.equal(claimed.rows[0].status, 'in_progress');
      assert.equal(claimed.rows[0].claim_token_hash, null);
      assert.ok(claimed.rows[0].claimed_by_user_id);
      assert.equal(Number(claimed.rows[0].claim_version), 1);
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

        const actor = await db.query(
          "INSERT INTO application_users (status, display_name, preferred_username) "
            + "VALUES ('active', 'Legacy Recount Actor', 'legacy.recount.actor') RETURNING id"
        );

        const correction = await applyProductRecount({
          sourceSku: 'LX1001',
          answers: { kind: 2 },
          reason: 'still editable',
          manualPriceUah: 500,
        }, {
          mutationContext: {
            actorUserId: Number(actor.rows[0].id),
            requestId: 'legacy-zero-recount',
          },
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

test('question-key updates rewrite every live reference while published schemas stay immutable', async () => {
  if (!authenticatedSession) authenticatedSession = await authenticateApplicationSession('/admin');
  const categoryCode = 'KR';
  const oldKey = 'old_key';
  const newKey = 'renamed_key';
  await pool.query(
    `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
     VALUES ($1, 'Key rewrite', 0, 0)`,
    [categoryCode]
  );
  const questions = await pool.query(
    `INSERT INTO questions
       (category_code, key, label, sku_index, display_order, required,
        include_in_sku, input_type, visible_if_json)
     VALUES
       ($1, $2, 'Original key', 1, 1, 1, 1, 'options', NULL),
       ($1, 'other_key', 'Other key', 2, 2, 1, 1, 'options', NULL),
       ($1, 'dependent_key', 'Dependent', 0, 3, 0, 0, 'text',
        '{"$and":[{"old_key":1},{"$or":[{"old_key":[1,2]},{"other_key":2}]}]}'::jsonb)
     RETURNING id, key`,
    [categoryCode, oldKey]
  );
  const questionIds = Object.fromEntries(
    questions.rows.map((question) => [question.key, Number(question.id)])
  );
  const options = await pool.query(
    `INSERT INTO options
       (question_id, value_id, sku_code, label, visible_if_json, hidden_if_json)
     VALUES
       ($1, 1, '1', 'Original one', NULL, NULL),
       ($2, 2, '2', 'Other two',
        '{"$or":[{"old_key":1},{"other_key":2}]}'::jsonb,
        '{"$and":[{"old_key":[2]},{"other_key":1}]}'::jsonb)
     RETURNING id, question_id`,
    [questionIds[oldKey], questionIds.other_key]
  );
  const dependentOptionId = Number(
    options.rows.find((option) => Number(option.question_id) === questionIds.other_key).id
  );
  const scenario = await pool.query(
    `INSERT INTO price_scenarios
       (category_code, name, match_json, axis_x_key, axis_y_key, price_mode, status)
     VALUES
       ($1, 'Rewrite scenario',
        '{"$or":[{"old_key":1},{"$and":[{"other_key":2},{"old_key":[1,2]}]}]}'::jsonb,
        'old_key+other_key', 'other_key+old_key', 'fixed_uah', 'active')
     RETURNING id`,
    [categoryCode]
  );
  const modifier = await pool.query(
    `INSERT INTO price_modifiers
       (category_code, trigger_key, trigger_val, match_json, factor)
     VALUES
       ($1, $2, 1,
        '{"$and":[{"old_key":1},{"$or":[{"other_key":2},{"old_key":2}]}]}'::jsonb,
        1.1)
     RETURNING id`,
    [categoryCode, oldKey]
  );

  const publication = await request(`/api/admin/sku-schema/${categoryCode}/publish`, {
    method: 'POST',
  });
  assert.equal(publication.response.status, 200, publication.text);
  const schemaVersionId = Number(publication.data.id);
  const publishedBefore = await pool.query(
    `SELECT sq.question_key, sq.visible_if_json, so.value_id, so.sku_code,
            so.visible_if_json AS option_visible_if_json,
            so.hidden_if_json AS option_hidden_if_json
     FROM sku_schema_questions sq
     LEFT JOIN sku_schema_options so ON so.schema_question_id = sq.id
     WHERE sq.schema_version_id = $1
     ORDER BY sq.question_key, so.value_id`,
    [schemaVersionId]
  );
  await pool.query(
    `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price,
        total_price_uah, price_per_gram, uah_rate, details, sku_schema_version_id)
     VALUES
       ('KR12001', 'KR12', 1, $1, 0, 25, 1000, 0, 40,
        '{"answers":{"old_key":1,"other_key":2},"isCalibrated":0}'::jsonb, $2)`,
    [categoryCode, schemaVersionId]
  );

  const renamed = await request('/api/admin/question/update', {
    method: 'POST',
    body: {
      id: questionIds[oldKey],
      key: newKey,
      label: 'Original key',
      sku_index: 1,
      display_order: 1,
      required: 1,
      include_in_sku: 1,
      input_type: 'options',
      sku_separator: '',
      visible_if_json: null,
    },
  });
  assert.equal(renamed.response.status, 200, renamed.text);
  assert.deepEqual(renamed.data, { success: true, key: newKey });

  const rewritten = await pool.query(
    `SELECT
       (SELECT visible_if_json FROM questions WHERE id = $1) AS question_rule,
       (SELECT visible_if_json FROM options WHERE id = $2) AS option_visible_rule,
       (SELECT hidden_if_json FROM options WHERE id = $2) AS option_hidden_rule,
       (SELECT match_json FROM price_scenarios WHERE id = $3) AS scenario_rule,
       (SELECT axis_x_key FROM price_scenarios WHERE id = $3) AS axis_x_key,
       (SELECT axis_y_key FROM price_scenarios WHERE id = $3) AS axis_y_key,
       (SELECT match_json FROM price_modifiers WHERE id = $4) AS modifier_rule,
       (SELECT trigger_key FROM price_modifiers WHERE id = $4) AS trigger_key,
       (SELECT details->'answers' FROM products WHERE full_sku = 'KR12001') AS product_answers`,
    [
      questionIds.dependent_key,
      dependentOptionId,
      Number(scenario.rows[0].id),
      Number(modifier.rows[0].id),
    ]
  );
  assert.deepEqual(rewritten.rows[0], {
    question_rule: {
      $and: [
        { [newKey]: 1 },
        { $or: [{ [newKey]: [1, 2] }, { other_key: 2 }] },
      ],
    },
    option_visible_rule: { $or: [{ [newKey]: 1 }, { other_key: 2 }] },
    option_hidden_rule: { $and: [{ [newKey]: [2] }, { other_key: 1 }] },
    scenario_rule: {
      $or: [
        { [newKey]: 1 },
        { $and: [{ other_key: 2 }, { [newKey]: [1, 2] }] },
      ],
    },
    axis_x_key: `${newKey}+other_key`,
    axis_y_key: `other_key+${newKey}`,
    modifier_rule: {
      $and: [
        { [newKey]: 1 },
        { $or: [{ other_key: 2 }, { [newKey]: 2 }] },
      ],
    },
    trigger_key: newKey,
    product_answers: { [newKey]: 1, other_key: 2 },
  });

  const publishedAfter = await pool.query(
    `SELECT sq.question_key, sq.visible_if_json, so.value_id, so.sku_code,
            so.visible_if_json AS option_visible_if_json,
            so.hidden_if_json AS option_hidden_if_json
     FROM sku_schema_questions sq
     LEFT JOIN sku_schema_options so ON so.schema_question_id = sq.id
     WHERE sq.schema_version_id = $1
     ORDER BY sq.question_key, so.value_id`,
    [schemaVersionId]
  );
  assert.deepEqual(publishedAfter.rows, publishedBefore.rows);
  assert.ok(publishedAfter.rows.some((row) => row.question_key === oldKey));
  assert.ok(!publishedAfter.rows.some((row) => row.question_key === newKey));
});

test('used option semantic values are rejected without partially changing the option', async () => {
  if (!authenticatedSession) authenticatedSession = await authenticateApplicationSession('/admin');
  const categoryCode = 'UV';
  await pool.query(
    `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
     VALUES ($1, 'Used values', 0, 0)`,
    [categoryCode]
  );
  const question = await pool.query(
    `INSERT INTO questions
       (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
     VALUES ($1, 'kind', 'Kind', 1, 1, 1, 1, 'options')
     RETURNING id`,
    [categoryCode]
  );
  const option = await pool.query(
    `INSERT INTO options (question_id, value_id, sku_code, label)
     VALUES ($1, 1, '1', 'Original meaning') RETURNING id`,
    [question.rows[0].id]
  );
  const publication = await request(`/api/admin/sku-schema/${categoryCode}/publish`, {
    method: 'POST',
  });
  assert.equal(publication.response.status, 200, publication.text);
  await pool.query(
    `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price,
        total_price_uah, price_per_gram, uah_rate, details, sku_schema_version_id)
     VALUES
       ('UV1001', 'UV1', 1, $1, 0, 25, 1000, 0, 40,
        '{"answers":{"kind":1},"isCalibrated":0}'::jsonb, $2)`,
    [categoryCode, Number(publication.data.id)]
  );

  const rejected = await request('/api/admin/option', {
    method: 'PUT',
    body: {
      id: Number(option.rows[0].id),
      value_id: 9,
      sku_code: '9',
      label: 'Reinterpreted meaning',
      visible_if_json: null,
      hidden_if_json: null,
      archived: false,
    },
  });
  assert.equal(rejected.response.status, 409, rejected.text);
  assert.match(rejected.data.error, /використовується у 1 товарах і не може бути змінений/);

  const stored = await pool.query(
    `SELECT value_id, sku_code, label, visible_if_json, hidden_if_json, archived
     FROM options WHERE id = $1`,
    [Number(option.rows[0].id)]
  );
  assert.deepEqual(stored.rows[0], {
    value_id: 1,
    sku_code: '1',
    label: 'Original meaning',
    visible_if_json: null,
    hidden_if_json: null,
    archived: false,
  });
  const product = await pool.query(
    `SELECT details->'answers' AS answers FROM products WHERE full_sku = 'UV1001'`
  );
  assert.deepEqual(product.rows[0].answers, { kind: 1 });
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

test('catalog and pricing configuration mutations write concise semantic audit events', async () => {
  if (!authenticatedSession) authenticatedSession = await authenticateApplicationSession('/admin');
  const categoryCode = `A${Date.now().toString().slice(-8)}`;
  const actorUserId = Number(authenticatedSession.applicationUser.id);
  const mutationOptions = (requestId) => ({ headers: { 'X-Request-ID': requestId } });

  const createdCategory = await request('/api/admin/category', {
    method: 'POST',
    body: {
      code: categoryCode,
      name: 'Audit category',
      requires_weight: 0,
      skip_hidden_sku_questions: 0,
    },
    ...mutationOptions('audit-category-created'),
  });
  assert.equal(createdCategory.response.status, 200, createdCategory.text);

  const updatedCategory = await request('/api/admin/category', {
    method: 'PUT',
    body: {
      code: categoryCode,
      next_code: categoryCode,
      name: 'Audited category',
      requires_weight: 0,
      skip_hidden_sku_questions: 0,
    },
    ...mutationOptions('audit-category-updated'),
  });
  assert.equal(updatedCategory.response.status, 200, updatedCategory.text);

  const questionPayload = {
    category_code: categoryCode,
    key: 'audit_kind',
    label: 'Audit kind',
    sku_index: 1,
    display_order: 1,
    required: 1,
    include_in_sku: 1,
    input_type: 'options',
    sku_separator: '',
  };
  const createdQuestion = await request('/api/admin/question', {
    method: 'POST',
    body: questionPayload,
    ...mutationOptions('audit-question-created'),
  });
  assert.equal(createdQuestion.response.status, 200, createdQuestion.text);
  const questionId = Number(createdQuestion.data.id);

  const updatedQuestionPayload = {
    ...questionPayload,
    id: questionId,
    label: 'Audited kind',
  };
  const updatedQuestion = await request('/api/admin/question', {
    method: 'PUT',
    body: updatedQuestionPayload,
    ...mutationOptions('audit-question-updated'),
  });
  assert.equal(updatedQuestion.response.status, 200, updatedQuestion.text);
  const noOpQuestion = await request('/api/admin/question', {
    method: 'PUT',
    body: updatedQuestionPayload,
    ...mutationOptions('audit-question-no-op'),
  });
  assert.equal(noOpQuestion.response.status, 200, noOpQuestion.text);

  const reordered = await request('/api/admin/questions/order', {
    method: 'PUT',
    body: {
      category_code: categoryCode,
      questions: [{ id: questionId, display_order: 2, sku_index: 1 }],
    },
    ...mutationOptions('audit-question-reordered'),
  });
  assert.equal(reordered.response.status, 200, reordered.text);
  const noOpReorder = await request('/api/admin/questions/order', {
    method: 'PUT',
    body: {
      category_code: categoryCode,
      questions: [{ id: questionId, display_order: 2, sku_index: 1 }],
    },
    ...mutationOptions('audit-question-reorder-no-op'),
  });
  assert.equal(noOpReorder.response.status, 200, noOpReorder.text);

  const createdOption = await request('/api/admin/option', {
    method: 'POST',
    body: {
      question_id: questionId,
      value_id: 1,
      sku_code: '01',
      label: 'Audit option',
    },
    ...mutationOptions('audit-option-created'),
  });
  assert.equal(createdOption.response.status, 200, createdOption.text);
  const optionId = Number(createdOption.data.id);
  const updatedOption = await request('/api/admin/option', {
    method: 'PUT',
    body: {
      id: optionId,
      value_id: 1,
      sku_code: '01',
      label: 'Audited option',
    },
    ...mutationOptions('audit-option-updated'),
  });
  assert.equal(updatedOption.response.status, 200, updatedOption.text);
  const archivedOption = await request(`/api/admin/option/${optionId}/archive`, {
    method: 'PATCH',
    body: { archived: true },
    ...mutationOptions('audit-option-archived'),
  });
  assert.equal(archivedOption.response.status, 200, archivedOption.text);
  const noOpArchive = await request(`/api/admin/option/${optionId}/archive`, {
    method: 'PATCH',
    body: { archived: true },
    ...mutationOptions('audit-option-archive-no-op'),
  });
  assert.equal(noOpArchive.response.status, 200, noOpArchive.text);

  const scenarioPayload = {
    category_code: categoryCode,
    name: 'Audit scenario',
    group_name: 'Audit group',
    match_json: { audit_kind: 1 },
    axis_x_key: 'weight_band',
    axis_y_key: '',
    priority: 0,
    status: 'draft',
    price_mode: 'fixed_uah',
    apply_modifiers: true,
    weight_bands: [
      { label: 'Light', min_weight: 0, max_weight: 10 },
      { label: 'Heavy', min_weight: 10, max_weight: null },
    ],
  };
  const createdScenario = await request('/api/admin/scenario', {
    method: 'POST',
    body: scenarioPayload,
    ...mutationOptions('audit-scenario-created'),
  });
  assert.equal(createdScenario.response.status, 200, createdScenario.text);
  const scenarioId = Number(createdScenario.data.id);
  const storedBands = await pool.query(
    `SELECT id, label, min_weight, max_weight
     FROM price_weight_bands
     WHERE scenario_id = $1
     ORDER BY sort_order`,
    [scenarioId]
  );
  assert.equal(storedBands.rows.length, 2);

  const updatedScenarioPayload = {
    ...scenarioPayload,
    id: scenarioId,
    priority: 2,
    weight_bands: storedBands.rows.map((band, index) => ({
      id: Number(band.id),
      label: index === 0 ? 'Small' : band.label,
      min_weight: Number(band.min_weight),
      max_weight: band.max_weight === null ? null : Number(band.max_weight),
    })),
  };
  const updatedScenario = await request('/api/admin/scenario', {
    method: 'PUT',
    body: updatedScenarioPayload,
    ...mutationOptions('audit-scenario-updated'),
  });
  assert.equal(updatedScenario.response.status, 200, updatedScenario.text);
  const noOpScenario = await request('/api/admin/scenario', {
    method: 'PUT',
    body: updatedScenarioPayload,
    ...mutationOptions('audit-scenario-no-op'),
  });
  assert.equal(noOpScenario.response.status, 200, noOpScenario.text);

  const firstBandId = Number(storedBands.rows[0].id);
  const cell = { scenario_id: scenarioId, x_val: firstBandId, y_val: 0 };
  const setCell = await request('/api/admin/price-cell', {
    method: 'POST',
    body: { ...cell, price: 125.5 },
    ...mutationOptions('audit-matrix-set'),
  });
  assert.equal(setCell.response.status, 200, setCell.text);
  const noOpCell = await request('/api/admin/price-cell', {
    method: 'POST',
    body: { ...cell, price: 125.5 },
    ...mutationOptions('audit-matrix-no-op'),
  });
  assert.equal(noOpCell.response.status, 200, noOpCell.text);
  const invalidCell = await request('/api/admin/price-cell', {
    method: 'POST',
    body: { ...cell, price: 0 },
    ...mutationOptions('audit-matrix-invalid'),
  });
  assert.equal(invalidCell.response.status, 400, invalidCell.text);
  const deleteCell = await request('/api/admin/price-cell', {
    method: 'POST',
    body: cell,
    ...mutationOptions('audit-matrix-deleted'),
  });
  assert.equal(deleteCell.response.status, 200, deleteCell.text);
  const noOpDeleteCell = await request('/api/admin/price-cell', {
    method: 'POST',
    body: cell,
    ...mutationOptions('audit-matrix-delete-no-op'),
  });
  assert.equal(noOpDeleteCell.response.status, 200, noOpDeleteCell.text);

  const createdModifier = await request('/api/admin/modifier', {
    method: 'POST',
    body: {
      category_code: categoryCode,
      match_json: { audit_kind: 1 },
      factor: 1.1,
    },
    ...mutationOptions('audit-modifier-created'),
  });
  assert.equal(createdModifier.response.status, 200, createdModifier.text);
  const modifierId = Number(createdModifier.data.id);
  const updatedModifier = await request('/api/admin/modifier', {
    method: 'PUT',
    body: { id: modifierId, factor: 1.2 },
    ...mutationOptions('audit-modifier-updated'),
  });
  assert.equal(updatedModifier.response.status, 200, updatedModifier.text);
  const noOpModifier = await request('/api/admin/modifier', {
    method: 'PUT',
    body: { id: modifierId, factor: 1.2 },
    ...mutationOptions('audit-modifier-no-op'),
  });
  assert.equal(noOpModifier.response.status, 200, noOpModifier.text);

  const duplicatedScenario = await request('/api/admin/scenario/duplicate', {
    method: 'POST',
    body: { id: scenarioId },
    ...mutationOptions('audit-scenario-duplicated'),
  });
  assert.equal(duplicatedScenario.response.status, 200, duplicatedScenario.text);
  const duplicateScenarioId = Number(duplicatedScenario.data.id);

  const deletedModifier = await request('/api/admin/delete-item', {
    method: 'POST', body: { type: 'modifier', id: modifierId },
    ...mutationOptions('audit-modifier-deleted'),
  });
  assert.equal(deletedModifier.response.status, 200, deletedModifier.text);
  for (const deletedScenarioId of [duplicateScenarioId, scenarioId]) {
    const deletedScenario = await request('/api/admin/delete-item', {
      method: 'POST', body: { type: 'scenario', id: deletedScenarioId },
      ...mutationOptions(`audit-scenario-deleted-${deletedScenarioId}`),
    });
    assert.equal(deletedScenario.response.status, 200, deletedScenario.text);
  }
  for (const [type, id] of [['option', optionId], ['question', questionId], ['category', categoryCode]]) {
    const deleted = await request('/api/admin/delete-item', {
      method: 'POST', body: { type, id },
      ...mutationOptions(`audit-${type}-deleted`),
    });
    assert.equal(deleted.response.status, 200, deleted.text);
  }

  const auditEvents = await pool.query(
    `SELECT event_key, subject_type, subject_id, actor_user_id, request_id, details
     FROM audit_events
     WHERE details->>'categoryCode' = $1
        OR (event_key LIKE 'catalog.category.%' AND subject_id = $1)
     ORDER BY id`,
    [categoryCode]
  );
  assert.deepEqual(
    auditEvents.rows.map((event) => event.event_key),
    [
      'catalog.category.created',
      'catalog.category.updated',
      'catalog.question.created',
      'catalog.question.updated',
      'catalog.question.reordered',
      'catalog.option.created',
      'catalog.option.updated',
      'catalog.option.archived',
      'pricing.scenario.created',
      'pricing.scenario.updated',
      'pricing.matrix_cell.set',
      'pricing.matrix_cell.deleted',
      'pricing.modifier.created',
      'pricing.modifier.updated',
      'pricing.scenario.duplicated',
      'pricing.modifier.deleted',
      'pricing.scenario.deleted',
      'pricing.scenario.deleted',
      'catalog.option.deleted',
      'catalog.question.deleted',
      'catalog.category.deleted',
    ]
  );
  assert.equal(
    auditEvents.rows.every((event) => Number(event.actor_user_id) === actorUserId),
    true
  );
  assert.equal(
    auditEvents.rows.some((event) => /no-op|invalid/.test(event.request_id)),
    false
  );

  const questionUpdateEvent = auditEvents.rows.find(
    (event) => event.event_key === 'catalog.question.updated'
  );
  assert.deepEqual(questionUpdateEvent.details.changes, {
    label: { from: 'Audit kind', to: 'Audited kind' },
  });
  const scenarioUpdateEvent = auditEvents.rows.find(
    (event) => event.event_key === 'pricing.scenario.updated'
  );
  assert.deepEqual(scenarioUpdateEvent.details.changes, {
    priority: { from: 0, to: 2 },
  });
  assert.deepEqual(scenarioUpdateEvent.details.weightBandChanges, {
    created: 0,
    updated: 1,
    deleted: 0,
    matrixCellsDeleted: 0,
  });
  assert.equal(JSON.stringify(scenarioUpdateEvent.details).includes('audit_kind'), false);

  const matrixEvents = auditEvents.rows.filter(
    (event) => event.subject_type === 'pricing_matrix_cell'
  );
  assert.deepEqual(matrixEvents.map((event) => ({
    eventKey: event.event_key,
    oldPrice: event.details.oldPrice,
    newPrice: event.details.newPrice,
    xValue: event.details.xValue,
    yValue: event.details.yValue,
  })), [
    {
      eventKey: 'pricing.matrix_cell.set',
      oldPrice: null,
      newPrice: 125.5,
      xValue: firstBandId,
      yValue: 0,
    },
    {
      eventKey: 'pricing.matrix_cell.deleted',
      oldPrice: 125.5,
      newPrice: null,
      xValue: firstBandId,
      yValue: 0,
    },
  ]);
});

test('configuration audit failure rolls back catalog and pricing mutations', async () => {
  if (!authenticatedSession) authenticatedSession = await authenticateApplicationSession('/admin');
  const categoryCode = `F${Date.now().toString().slice(-8)}`;
  const xValue = 987654;
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_test_configuration_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event_key IN ('catalog.category.created', 'pricing.matrix_cell.set') THEN
        RAISE EXCEPTION 'forced configuration audit failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER fail_test_configuration_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION fail_test_configuration_audit();
  `);
  try {
    const category = await request('/api/admin/category', {
      method: 'POST',
      body: { code: categoryCode, name: 'Must roll back', requires_weight: 0 },
    });
    assert.equal(category.response.status, 500, category.text);
    assert.equal(Number((await pool.query(
      'SELECT count(*) FROM categories WHERE code = $1', [categoryCode]
    )).rows[0].count), 0);

    const matrix = await request('/api/admin/price-cell', {
      method: 'POST',
      body: { scenario_id: schemas.ZZScenario, x_val: xValue, y_val: 0, price: 777 },
    });
    assert.equal(matrix.response.status, 500, matrix.text);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM price_matrix
       WHERE scenario_id = $1 AND x_val = $2 AND y_val = 0`,
      [schemas.ZZScenario, xValue]
    )).rows[0].count), 0);
  } finally {
    await pool.query('DROP TRIGGER fail_test_configuration_audit ON audit_events');
    await pool.query('DROP FUNCTION fail_test_configuration_audit()');
    await pool.query('DELETE FROM categories WHERE code = $1', [categoryCode]);
    await pool.query(
      'DELETE FROM price_matrix WHERE scenario_id = $1 AND x_val = $2 AND y_val = 0',
      [schemas.ZZScenario, xValue]
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
  assert.equal(Number((await pool.query(
    `SELECT count(*) FROM audit_events
     WHERE event_key = 'product.recounted'
       AND subject_type = 'product' AND subject_id = $1`,
    [String(sourceState.rows[0].id)]
  )).rows[0].count), 1, 'the failed concurrent recount must not create a success event');
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

test('correction request claims are user-owned, cross-browser, epoch-protected, and explicitly force-released', async () => {
  const sameUserOtherBrowser = await authenticateIdentitySession({
    issuer: integrationOidcAdapter.issuer,
    subject: 'critical-flows-subject',
    preferredUsername: 'critical.flows',
    displayName: 'Critical Flows',
  });
  const secondUserIdentity = {
    issuer: 'https://correction-owner.example/realms/amber',
    subject: `correction-worker-${Date.now()}`,
    preferredUsername: 'correction.worker.two',
    displayName: 'Correction Worker Two',
  };
  const secondUser = await authenticateIdentitySession(secondUserIdentity);
  await activateApplicationUserForTest(
    secondUserIdentity.issuer,
    secondUserIdentity.subject,
    'storekeeper'
  );
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
  assert.equal(
    Number(created.data.request.createdByUser.id),
    authenticatedSession.applicationUser.id
  );
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
  assert.equal(Object.hasOwn(winningClaim, 'claimToken'), false);
  assert.equal(winningClaim.request.claimFingerprint, null);
  assert.equal(
    Number(winningClaim.request.claimedByUser.id),
    authenticatedSession.applicationUser.id
  );
  const firstClaimVersion = Number(winningClaim.request.claimVersion);
  const claimedState = await pool.query(
    `SELECT status, claim_token_hash, claimed_by_user_id, claim_version, claimed_at
     FROM correction_requests WHERE id = $1`,
    [requestId]
  );
  assert.equal(claimedState.rows[0].status, 'in_progress');
  assert.equal(claimedState.rows[0].claim_token_hash, null);
  assert.equal(
    Number(claimedState.rows[0].claimed_by_user_id),
    authenticatedSession.applicationUser.id
  );
  assert.equal(Number(claimedState.rows[0].claim_version), firstClaimVersion);
  assert.ok(claimedState.rows[0].claimed_at);
  const listed = await request('/api/admin/correction-requests?status=active');
  assert.equal(listed.response.status, 200, listed.text);
  const listedClaim = listed.data.items.find((item) => Number(item.id) === requestId);
  assert.equal(listedClaim.claimFingerprint, null);
  assert.equal(listedClaim.claimedByUser.displayName, 'Critical Flows');
  assert.equal(Object.hasOwn(listedClaim, 'claimTokenHash'), false);

  const wrongHeaders = { 'X-Correction-Claim-Token': 'x'.repeat(43) };
  const sameUserRefresh = await request(
    `/api/admin/correction-requests/${requestId}/refresh`,
    {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      headers: wrongHeaders,
      authentication: sameUserOtherBrowser,
    }
  );
  assert.equal(sameUserRefresh.response.status, 200, sameUserRefresh.text);

  const wrongRelease = await request(
    `/api/admin/correction-requests/${requestId}/release`,
    {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      headers: wrongHeaders,
      authentication: secondUser,
    }
  );
  assert.equal(wrongRelease.response.status, 409, wrongRelease.text);
  const wrongRefresh = await request(
    `/api/admin/correction-requests/${requestId}/refresh`,
    {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      headers: wrongHeaders,
      authentication: secondUser,
    }
  );
  assert.equal(wrongRefresh.response.status, 409, wrongRefresh.text);
  const wrongComplete = await request(
    `/api/admin/correction-requests/${requestId}/complete`,
    {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      headers: wrongHeaders,
      authentication: secondUser,
    }
  );
  assert.equal(wrongComplete.response.status, 409, wrongComplete.text);
  const wrongReject = await request(`/api/admin/correction-requests/${requestId}/status`, {
    method: 'PATCH',
    body: { status: 'rejected', claimVersion: firstClaimVersion },
    headers: wrongHeaders,
    authentication: secondUser,
  });
  assert.equal(wrongReject.response.status, 409, wrongReject.text);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_test_correction_release_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event_key = 'correction_request.released' THEN
        RAISE EXCEPTION 'forced correction release audit failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER fail_test_correction_release_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION fail_test_correction_release_audit();
  `);
  try {
    const failedAuditedRelease = await request(
      `/api/admin/correction-requests/${requestId}/release`,
      { method: 'POST', body: { claimVersion: firstClaimVersion } }
    );
    assert.equal(failedAuditedRelease.response.status, 500, failedAuditedRelease.text);
    const stateAfterAuditFailure = await pool.query(
      `SELECT status, claimed_by_user_id, claim_version
       FROM correction_requests WHERE id = $1`,
      [requestId]
    );
    assert.equal(stateAfterAuditFailure.rows[0].status, 'in_progress');
    assert.equal(
      Number(stateAfterAuditFailure.rows[0].claimed_by_user_id),
      authenticatedSession.applicationUser.id
    );
    assert.equal(Number(stateAfterAuditFailure.rows[0].claim_version), firstClaimVersion);
  } finally {
    await pool.query('DROP TRIGGER fail_test_correction_release_audit ON audit_events');
    await pool.query('DROP FUNCTION fail_test_correction_release_audit()');
  }

  const releaseLock = await pool.connect();
  await releaseLock.query('BEGIN');
  await releaseLock.query(
    'SELECT id FROM correction_requests WHERE id = $1 FOR UPDATE',
    [requestId]
  );
  const competingReleases = [
    request(`/api/admin/correction-requests/${requestId}/release`, {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
    }),
    request(`/api/admin/correction-requests/${requestId}/release`, {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      headers: wrongHeaders,
      authentication: sameUserOtherBrowser,
    }),
  ];
  await new Promise((resolve) => setTimeout(resolve, 50));
  await releaseLock.query('COMMIT');
  releaseLock.release();
  const releaseResults = await Promise.all(competingReleases);
  assert.deepEqual(releaseResults.map((item) => item.response.status).sort(), [200, 409]);
  const released = releaseResults.find((item) => item.response.status === 200).data;
  assert.equal(released.request.status, 'pending');
  assert.equal(released.request.claimedAt, null);
  assert.equal(Number(released.request.claimVersion), firstClaimVersion + 1);

  const reclaimed = await request(`/api/admin/correction-requests/${requestId}/claim`, {
    method: 'POST', body: {},
  });
  assert.equal(reclaimed.response.status, 200, reclaimed.text);
  const reclaimedVersion = Number(reclaimed.data.request.claimVersion);
  assert.equal(reclaimedVersion, firstClaimVersion + 2);
  const staleRelease = await request(
    `/api/admin/correction-requests/${requestId}/release`,
    {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      authentication: sameUserOtherBrowser,
    }
  );
  assert.equal(staleRelease.response.status, 409, staleRelease.text);
  const staleCompletion = await request(
    `/api/admin/correction-requests/${requestId}/complete`,
    {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      authentication: sameUserOtherBrowser,
    }
  );
  assert.equal(staleCompletion.response.status, 409, staleCompletion.text);

  const ownerRelease = await request(
    `/api/admin/correction-requests/${requestId}/release`,
    { method: 'POST', body: { claimVersion: reclaimedVersion } }
  );
  assert.equal(ownerRelease.response.status, 200, ownerRelease.text);
  const secondUserClaim = await request(
    `/api/admin/correction-requests/${requestId}/claim`,
    { method: 'POST', body: {}, authentication: secondUser }
  );
  assert.equal(secondUserClaim.response.status, 200, secondUserClaim.text);
  assert.equal(
    Number(secondUserClaim.data.request.claimedByUser.id),
    secondUser.applicationUser.id
  );
  const secondUserClaimVersion = Number(secondUserClaim.data.request.claimVersion);
  const secondUserAssignmentId = await currentAssignmentIdForUser(secondUser.applicationUser.id);
  const demotedOwner = await request(
    `/api/admin/users/${secondUser.applicationUser.id}/role`,
    {
      method: 'PUT',
      body: {
        roleId: await roleIdForKey('manager'),
        expectedAssignmentId: secondUserAssignmentId,
      },
    }
  );
  assert.equal(demotedOwner.response.status, 200, demotedOwner.text);
  let retainedOwner = await pool.query(
    `SELECT status, claimed_by_user_id, claim_version
     FROM correction_requests WHERE id = $1`,
    [requestId]
  );
  assert.equal(retainedOwner.rows[0].status, 'in_progress');
  assert.equal(Number(retainedOwner.rows[0].claimed_by_user_id), secondUser.applicationUser.id);
  assert.equal(Number(retainedOwner.rows[0].claim_version), secondUserClaimVersion);
  const disabledOwner = await request(
    `/api/admin/users/${secondUser.applicationUser.id}/disable`,
    { method: 'POST', body: {} }
  );
  assert.equal(disabledOwner.response.status, 200, disabledOwner.text);
  retainedOwner = await pool.query(
    `SELECT status, claimed_by_user_id, claim_version
     FROM correction_requests WHERE id = $1`,
    [requestId]
  );
  assert.equal(retainedOwner.rows[0].status, 'in_progress');
  assert.equal(Number(retainedOwner.rows[0].claimed_by_user_id), secondUser.applicationUser.id);
  assert.equal(Number(retainedOwner.rows[0].claim_version), secondUserClaimVersion);

  const administratorOrdinaryBypass = await request(
    `/api/admin/correction-requests/${requestId}/refresh`,
    { method: 'POST', body: { claimVersion: secondUserClaimVersion } }
  );
  assert.equal(administratorOrdinaryBypass.response.status, 409, administratorOrdinaryBypass.text);
  const unconfirmedForceRelease = await request(
    `/api/admin/correction-requests/${requestId}/force-release`,
    { method: 'POST', body: { confirm: false, claimVersion: secondUserClaimVersion } }
  );
  assert.equal(unconfirmedForceRelease.response.status, 400, unconfirmedForceRelease.text);
  const forceReleased = await request(
    `/api/admin/correction-requests/${requestId}/force-release`,
    { method: 'POST', body: { confirm: true, claimVersion: secondUserClaimVersion } }
  );
  assert.equal(forceReleased.response.status, 200, forceReleased.text);
  assert.equal(forceReleased.data.request.status, 'pending');

  const finalClaim = await request(`/api/admin/correction-requests/${requestId}/claim`, {
    method: 'POST', body: {},
  });
  assert.equal(finalClaim.response.status, 200, finalClaim.text);
  const rejected = await request(`/api/admin/correction-requests/${requestId}/status`, {
    method: 'PATCH',
    body: {
      status: 'rejected',
      claimVersion: finalClaim.data.request.claimVersion,
    },
  });
  assert.equal(rejected.response.status, 200, rejected.text);
  const finalState = await pool.query(
    `SELECT cr.status, cr.claim_token_hash, cr.claimed_by_user_id, p.status AS product_status,
            p.corrected_to_product_id
     FROM correction_requests cr
     JOIN products p ON p.id = cr.source_product_id
     WHERE cr.id = $1`,
    [requestId]
  );
  assert.deepEqual(finalState.rows[0], {
    status: 'rejected',
    claim_token_hash: null,
    claimed_by_user_id: null,
    product_status: 'active',
    corrected_to_product_id: null,
  });
  const lifecycle = await pool.query(
    `SELECT event_key, actor_user_id, details
     FROM audit_events
     WHERE subject_type = 'correction_request' AND subject_id = $1
     ORDER BY id`,
    [String(requestId)]
  );
  assert.deepEqual(lifecycle.rows.map((row) => row.event_key), [
    'correction_request.created',
    'correction_request.claimed',
    'correction_request.released',
    'correction_request.claimed',
    'correction_request.released',
    'correction_request.claimed',
    'correction_request.force_released',
    'correction_request.claimed',
    'correction_request.rejected',
  ]);
  const forceReleaseAudit = lifecycle.rows.find(
    (row) => row.event_key === 'correction_request.force_released'
  );
  assert.equal(
    Number(forceReleaseAudit.actor_user_id),
    authenticatedSession.applicationUser.id
  );
  assert.equal(
    Number(forceReleaseAudit.details.previousOwnerUserId),
    secondUser.applicationUser.id
  );
});

test('a legacy token-only claim is adopted once and then follows user ownership', async () => {
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  const product = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: preview.data.previewToken,
    },
  });
  const created = await request('/api/admin/correction-requests', {
    method: 'POST',
    body: {
      sourceSku: product.data.fullSku,
      answers: { kind: 2 },
      reason: 'legacy token adoption',
    },
  });
  assert.equal(created.response.status, 200, created.text);
  const requestId = Number(created.data.request.id);
  const legacyToken = crypto.randomBytes(32).toString('base64url');
  const legacyHash = crypto.createHash('sha256').update(legacyToken).digest('hex');
  await pool.query(
    `UPDATE correction_requests
     SET status = 'in_progress', claim_token_hash = $1, claimed_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [legacyHash, requestId]
  );

  const wrongToken = await request(`/api/admin/correction-requests/${requestId}/refresh`, {
    method: 'POST',
    body: { claimVersion: 0 },
    headers: { 'X-Correction-Claim-Token': 'x'.repeat(43) },
  });
  assert.equal(wrongToken.response.status, 409, wrongToken.text);
  const stillLegacy = await pool.query(
    `SELECT claimed_by_user_id, claim_token_hash, claim_version
     FROM correction_requests WHERE id = $1`,
    [requestId]
  );
  assert.equal(stillLegacy.rows[0].claimed_by_user_id, null);
  assert.equal(stillLegacy.rows[0].claim_token_hash, legacyHash);
  assert.equal(Number(stillLegacy.rows[0].claim_version), 0);

  const adopted = await request(`/api/admin/correction-requests/${requestId}/refresh`, {
    method: 'POST',
    body: { claimVersion: 0 },
    headers: { 'X-Correction-Claim-Token': legacyToken },
  });
  assert.equal(adopted.response.status, 200, adopted.text);
  assert.equal(
    Number(adopted.data.request.claimedByUser.id),
    authenticatedSession.applicationUser.id
  );
  assert.equal(adopted.data.request.claimFingerprint, null);
  assert.equal(Number(adopted.data.request.claimVersion), 0);

  const sameUserOtherBrowser = await authenticateIdentitySession({
    issuer: integrationOidcAdapter.issuer,
    subject: 'critical-flows-subject',
    preferredUsername: 'critical.flows',
    displayName: 'Critical Flows',
  });
  const released = await request(`/api/admin/correction-requests/${requestId}/release`, {
    method: 'POST',
    body: { claimVersion: 0 },
    authentication: sameUserOtherBrowser,
  });
  assert.equal(released.response.status, 200, released.text);
  assert.equal(Number(released.data.request.claimVersion), 1);
  const rejected = await request(`/api/admin/correction-requests/${requestId}/status`, {
    method: 'PATCH',
    body: { status: 'rejected' },
  });
  assert.equal(rejected.response.status, 200, rejected.text);

  const audit = await pool.query(
    `SELECT event_key, actor_user_id, details
     FROM audit_events
     WHERE subject_type = 'correction_request' AND subject_id = $1
       AND event_key IN ('correction_request.claimed', 'correction_request.released')
     ORDER BY id`,
    [String(requestId)]
  );
  assert.deepEqual(audit.rows.map((row) => row.event_key), [
    'correction_request.claimed',
    'correction_request.released',
  ]);
  assert.equal(audit.rows[0].details.legacyClaimAdopted, true);
  assert.equal(
    audit.rows.every((row) => Number(row.actor_user_id) === authenticatedSession.applicationUser.id),
    true
  );
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
    const claimVersion = Number(claimed.data.request.claimVersion);

    await pool.query(
      "UPDATE products SET status = 'archived' WHERE id = $1",
      [candidate.rows[0].id]
    );
    const failedRefresh = await request(
      `/api/admin/correction-requests/${requestId}/refresh`,
      { method: 'POST', body: { claimVersion } }
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
      Number(ownedAfterRefreshError.claimedByUser.id),
      authenticatedSession.applicationUser.id,
      'a failed refresh must preserve the existing application-user owner'
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
      { method: 'POST', body: { claimVersion } }
    );
    assert.equal(staleCompletion.response.status, 409);
    assert.equal(staleCompletion.data.details?.type, 'stale_correction_request');

    const activeAfterError = await request('/api/admin/correction-requests?status=active');
    const ownedAfterError = activeAfterError.data.items.find(
      (item) => Number(item.id) === requestId
    );
    assert.equal(ownedAfterError.status, 'in_progress');
    assert.equal(Number(ownedAfterError.claimedByUser.id), authenticatedSession.applicationUser.id);
    assert.equal(Number(ownedAfterError.claimVersion), claimVersion);

    const released = await request(
      `/api/admin/correction-requests/${requestId}/release`,
      { method: 'POST', body: { claimVersion } }
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
        body: { claimVersion: reclaimed.data.request.claimVersion },
      }
    );
    assert.equal(completed.response.status, 200, completed.text);
    const finalState = await pool.query(
      `SELECT p.status, p.corrected_to_product_id, cr.status AS request_status,
              cr.corrected_product_id, cr.claim_token_hash, cr.claimed_by_user_id,
              cr.claim_version, cr.claimed_at
       FROM products p
       JOIN correction_requests cr ON cr.id = $1
       WHERE p.id = $2`,
      [requestId, candidate.rows[0].id]
    );
    assert.equal(finalState.rows[0].status, 'corrected');
    assert.equal(finalState.rows[0].request_status, 'completed');
    assert.equal(finalState.rows[0].claim_token_hash, null);
    assert.equal(finalState.rows[0].claimed_by_user_id, null);
    assert.equal(
      Number(finalState.rows[0].claim_version),
      Number(reclaimed.data.request.claimVersion) + 1
    );
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

test('repricing drafts attribute creator, modifier, and discard without routine audit spam', async () => {
  const creatorUserId = Number(authenticatedSession.applicationUser.id);
  const modifierSession = await authenticateIdentitySession({
    issuer: 'https://repricing-draft-actor.example/realms/amber',
    subject: 'repricing-draft-modifier',
    preferredUsername: 'repricing.draft.modifier',
    displayName: 'Repricing Draft Modifier',
  });
  const modifierUserId = await activateApplicationUserForTest(
    'https://repricing-draft-actor.example/realms/amber',
    'repricing-draft-modifier',
    'manager'
  );
  let draftId;
  try {
    const created = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      headers: { 'X-Request-ID': 'repricing-draft-created' },
      body: { scope: 'global', uiState: { filter: 'changed' } },
    });
    assert.equal(created.response.status, 200, created.text);
    draftId = Number(created.data.draft.id);
    assert.deepEqual((await pool.query(
      `SELECT created_by_user_id, last_modified_by_user_id, discarded_by_user_id
       FROM repricing_drafts WHERE id = $1`,
      [draftId]
    )).rows, [{
      created_by_user_id: String(creatorUserId),
      last_modified_by_user_id: String(creatorUserId),
      discarded_by_user_id: null,
    }]);

    const saved = await request(`/api/admin/repricing/drafts/${draftId}`, {
      method: 'PUT',
      headers: { 'X-Request-ID': 'repricing-draft-autosave' },
      authentication: modifierSession,
      body: {
        manualOverrides: created.data.manualOverrides,
        automaticProductIds: created.data.automaticProductIds,
        reviewedProductIds: created.data.draft.reviewedProductIds,
        uiState: created.data.draft.uiState,
      },
    });
    assert.equal(saved.response.status, 200, saved.text);
    assert.equal(Number((await pool.query(
      'SELECT last_modified_by_user_id FROM repricing_drafts WHERE id = $1',
      [draftId]
    )).rows[0].last_modified_by_user_id), modifierUserId);

    const synchronized = await request(`/api/admin/repricing/drafts/${draftId}/sync`, {
      method: 'POST',
      headers: { 'X-Request-ID': 'repricing-draft-routine-sync' },
      authentication: modifierSession,
      body: {},
    });
    assert.equal(synchronized.response.status, 200, synchronized.text);
    assert.equal(Number((await pool.query(
      'SELECT last_modified_by_user_id FROM repricing_drafts WHERE id = $1',
      [draftId]
    )).rows[0].last_modified_by_user_id), modifierUserId);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE subject_type = 'repricing_draft' AND subject_id = $1`,
      [String(draftId)]
    )).rows[0].count), 1, 'autosave and synchronization must not emit audit events');

    const discarded = await request(`/api/admin/repricing/drafts/${draftId}`, {
      method: 'DELETE',
      headers: { 'X-Request-ID': 'repricing-draft-discarded' },
      authentication: modifierSession,
    });
    assert.equal(discarded.response.status, 200, discarded.text);
    const state = await pool.query(
      `SELECT status, created_by_user_id, last_modified_by_user_id, discarded_by_user_id
       FROM repricing_drafts WHERE id = $1`,
      [draftId]
    );
    assert.deepEqual(state.rows, [{
      status: 'discarded',
      created_by_user_id: String(creatorUserId),
      last_modified_by_user_id: String(modifierUserId),
      discarded_by_user_id: String(modifierUserId),
    }]);
    const audit = await pool.query(
      `SELECT event_key, actor_user_id, request_id, details
       FROM audit_events
       WHERE subject_type = 'repricing_draft' AND subject_id = $1
       ORDER BY id`,
      [String(draftId)]
    );
    assert.deepEqual(audit.rows, [
      {
        event_key: 'repricing_draft.created',
        actor_user_id: String(creatorUserId),
        request_id: 'repricing-draft-created',
        details: { scope: 'global' },
      },
      {
        event_key: 'repricing_draft.discarded',
        actor_user_id: String(modifierUserId),
        request_id: 'repricing-draft-discarded',
        details: { scope: 'global' },
      },
    ]);
    draftId = null;
  } finally {
    if (draftId) {
      await pool.query(
        `UPDATE repricing_drafts
         SET status = 'discarded', discarded_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'draft'`,
        [draftId]
      );
    }
  }
});

test('correction completion causally attributes successful draft sync and remains best effort', async () => {
  const draftCreatorSession = await authenticateIdentitySession({
    issuer: 'https://correction-draft-sync.example/realms/amber',
    subject: 'correction-draft-creator',
    preferredUsername: 'correction.draft.creator',
    displayName: 'Correction Draft Creator',
  });
  const draftCreatorUserId = await activateApplicationUserForTest(
    'https://correction-draft-sync.example/realms/amber',
    'correction-draft-creator',
    'manager'
  );
  const causalActorUserId = Number(authenticatedSession.applicationUser.id);
  let draftId;
  let unsynchronizableDraftId;
  try {
    const productPreview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
    });
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

    const draft = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      headers: { 'X-Request-ID': 'correction-sync-draft-created' },
      authentication: draftCreatorSession,
      body: { scope: 'global' },
    });
    assert.equal(draft.response.status, 200, draft.text);
    draftId = Number(draft.data.draft.id);
    assert.equal(Number((await pool.query(
      'SELECT created_by_user_id FROM repricing_drafts WHERE id = $1',
      [draftId]
    )).rows[0].created_by_user_id), draftCreatorUserId);

    const unsynchronizableDraft = await pool.query(`
      INSERT INTO repricing_drafts
        (scope, scenario_id, category_code, scenario_name, preview_fingerprint, status)
      VALUES ('scenario', NULL, 'IX', 'Unsynchronizable historical draft',
              'unsynchronizable-fingerprint', 'draft')
      RETURNING id
    `);
    unsynchronizableDraftId = Number(unsynchronizableDraft.rows[0].id);

    const correction = await request('/api/admin/correction-requests', {
      method: 'POST',
      body: {
        sourceSku: product.data.fullSku,
        answers: { kind: 2 },
        reason: 'causal draft synchronization',
      },
    });
    assert.equal(correction.response.status, 200, correction.text);
    const correctionId = Number(correction.data.request.id);
    const claim = await request(`/api/admin/correction-requests/${correctionId}/claim`, {
      method: 'POST', body: {},
    });
    assert.equal(claim.response.status, 200, claim.text);
    const completed = await request(`/api/admin/correction-requests/${correctionId}/complete`, {
      method: 'POST',
      headers: { 'X-Request-ID': 'correction-caused-draft-sync' },
      body: { claimVersion: claim.data.request.claimVersion },
    });
    assert.equal(completed.response.status, 200, completed.text);
    assert.deepEqual(completed.data.draftSyncFailures, [{
      draftId: unsynchronizableDraftId,
      message: 'Цю чернетку неможливо синхронізувати.',
    }]);
    assert.equal(Number((await pool.query(
      'SELECT last_modified_by_user_id FROM repricing_drafts WHERE id = $1',
      [draftId]
    )).rows[0].last_modified_by_user_id), causalActorUserId);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE subject_type = 'repricing_draft' AND subject_id = $1`,
      [String(draftId)]
    )).rows[0].count), 1, 'correction-caused synchronization must not emit repricing audit');
    assert.deepEqual((await pool.query(
      'SELECT status, last_modified_by_user_id FROM repricing_drafts WHERE id = $1',
      [unsynchronizableDraftId]
    )).rows, [{ status: 'draft', last_modified_by_user_id: null }]);
    assert.equal((await pool.query(
      'SELECT status FROM correction_requests WHERE id = $1',
      [correctionId]
    )).rows[0].status, 'completed');
  } finally {
    const cleanupIds = [draftId, unsynchronizableDraftId].filter(Boolean);
    if (cleanupIds.length > 0) {
      await pool.query(
        `UPDATE repricing_drafts
         SET status = 'discarded', discarded_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1::int[]) AND status = 'draft'`,
        [cleanupIds]
      );
    }
  }
});

test('repricing financial audit is atomic, attributed, and idempotent', async () => {
  const actorUserId = Number(authenticatedSession.applicationUser.id);
  await pool.query(
    'UPDATE price_matrix SET price = price + 37 WHERE scenario_id = $1',
    [schemas.ZZScenario]
  );
  let batchId;
  let applied = false;
  try {
    const preview = await request('/api/admin/repricing/preview', {
      method: 'POST', body: { scenarioId: schemas.ZZScenario },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const manualOverrides = preview.data.items
      .filter((item) => ['manual_price', 'price_missing'].includes(item.errorCode))
      .map((item) => ({
        productId: Number(item.productId),
        newPriceUah: Number(item.oldPriceUah),
      }));
    const payload = {
      scenarioId: schemas.ZZScenario,
      previewToken: preview.data.previewToken,
      manualOverrides,
    };
    const changedProductIds = preview.data.items
      .filter((item) => item.status === 'changed')
      .map((item) => Number(item.productId));
    assert.ok(changedProductIds.length > 0);
    const beforeApply = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    );
    const batchCountBefore = Number((await pool.query(
      'SELECT count(*) FROM repricing_batches'
    )).rows[0].count);

    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_repricing_applied_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced repricing applied audit failure';
      END;
      $$;
      CREATE TRIGGER fail_test_repricing_applied_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW
      WHEN (NEW.event_key = 'repricing.applied')
      EXECUTE FUNCTION fail_test_repricing_applied_audit();
    `);
    try {
      const failedApply = await request('/api/admin/repricing/apply', {
        method: 'POST',
        headers: { 'X-Request-ID': 'repricing-apply-audit-failure' },
        body: payload,
      });
      assert.equal(failedApply.response.status, 500, failedApply.text);
    } finally {
      await pool.query('DROP TRIGGER fail_test_repricing_applied_audit ON audit_events');
      await pool.query('DROP FUNCTION fail_test_repricing_applied_audit()');
    }
    assert.deepEqual((await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    )).rows, beforeApply.rows);
    assert.equal(Number((await pool.query(
      'SELECT count(*) FROM repricing_batches'
    )).rows[0].count), batchCountBefore);

    const successfulApply = await request('/api/admin/repricing/apply', {
      method: 'POST',
      headers: { 'X-Request-ID': 'repricing-applied' },
      body: payload,
    });
    assert.equal(successfulApply.response.status, 200, successfulApply.text);
    batchId = Number(successfulApply.data.batch.id);
    applied = true;
    const afterApply = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    );
    assert.equal(Number((await pool.query(
      'SELECT applied_by_user_id FROM repricing_batches WHERE id = $1', [batchId]
    )).rows[0].applied_by_user_id), actorUserId);
    assert.deepEqual((await pool.query(
      `SELECT event_key, actor_user_id, request_id, details
       FROM audit_events
       WHERE subject_type = 'repricing_batch' AND subject_id = $1
       ORDER BY id`,
      [String(batchId)]
    )).rows, [{
      event_key: 'repricing.applied',
      actor_user_id: String(actorUserId),
      request_id: 'repricing-applied',
      details: {},
    }]);

    const repeatedApply = await request('/api/admin/repricing/apply', {
      method: 'POST',
      headers: { 'X-Request-ID': 'repricing-applied-retry' },
      body: payload,
    });
    assert.equal(repeatedApply.response.status, 200, repeatedApply.text);
    assert.equal(repeatedApply.data.alreadyApplied, true);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE event_key = 'repricing.applied' AND subject_id = $1`,
      [String(batchId)]
    )).rows[0].count), 1);

    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_repricing_rollback_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced repricing rollback audit failure';
      END;
      $$;
      CREATE TRIGGER fail_test_repricing_rollback_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW
      WHEN (NEW.event_key = 'repricing.rolled_back')
      EXECUTE FUNCTION fail_test_repricing_rollback_audit();
    `);
    try {
      const failedRollback = await request(`/api/admin/repricing/${batchId}/rollback`, {
        method: 'POST',
        headers: { 'X-Request-ID': 'repricing-rollback-audit-failure' },
        body: {},
      });
      assert.equal(failedRollback.response.status, 500, failedRollback.text);
    } finally {
      await pool.query('DROP TRIGGER fail_test_repricing_rollback_audit ON audit_events');
      await pool.query('DROP FUNCTION fail_test_repricing_rollback_audit()');
    }
    assert.deepEqual((await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    )).rows, afterApply.rows);
    assert.deepEqual((await pool.query(
      'SELECT status, rolled_back_by_user_id FROM repricing_batches WHERE id = $1',
      [batchId]
    )).rows, [{ status: 'completed', rolled_back_by_user_id: null }]);

    const successfulRollback = await request(`/api/admin/repricing/${batchId}/rollback`, {
      method: 'POST',
      headers: { 'X-Request-ID': 'repricing-rolled-back' },
      body: {},
    });
    assert.equal(successfulRollback.response.status, 200, successfulRollback.text);
    applied = false;
    assert.deepEqual((await pool.query(
      'SELECT status, applied_by_user_id, rolled_back_by_user_id FROM repricing_batches WHERE id = $1',
      [batchId]
    )).rows, [{
      status: 'rolled_back',
      applied_by_user_id: String(actorUserId),
      rolled_back_by_user_id: String(actorUserId),
    }]);
    assert.deepEqual((await pool.query(
      `SELECT event_key, actor_user_id, request_id, details
       FROM audit_events
       WHERE subject_type = 'repricing_batch' AND subject_id = $1
       ORDER BY id`,
      [String(batchId)]
    )).rows, [
      {
        event_key: 'repricing.applied',
        actor_user_id: String(actorUserId),
        request_id: 'repricing-applied',
        details: {},
      },
      {
        event_key: 'repricing.rolled_back',
        actor_user_id: String(actorUserId),
        request_id: 'repricing-rolled-back',
        details: {},
      },
    ]);
    const repeatedRollback = await request(`/api/admin/repricing/${batchId}/rollback`, {
      method: 'POST',
      headers: { 'X-Request-ID': 'repricing-rolled-back-retry' },
      body: {},
    });
    assert.equal(repeatedRollback.response.status, 200, repeatedRollback.text);
    assert.equal(repeatedRollback.data.alreadyRolledBack, true);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE event_key = 'repricing.rolled_back' AND subject_id = $1`,
      [String(batchId)]
    )).rows[0].count), 1);
  } finally {
    if (applied && batchId) {
      await request(`/api/admin/repricing/${batchId}/rollback`, { method: 'POST', body: {} });
    }
    await pool.query(
      'UPDATE price_matrix SET price = price - 37 WHERE scenario_id = $1',
      [schemas.ZZScenario]
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

test('export snapshot creation and confirmation are attributed, audited, and idempotent', async () => {
  const exportSku = (await pool.query(
    `SELECT full_sku FROM products
     WHERE COALESCE(exclude_from_export, 0) = 0
     ORDER BY id DESC LIMIT 1`
  )).rows[0].full_sku;
  const creatorUserId = Number(authenticatedSession.applicationUser.id);
  const confirmerSession = await authenticateIdentitySession({
    issuer: 'https://export-attribution.example/realms/amber',
    subject: 'export-confirmer',
    preferredUsername: 'export.confirmer',
    displayName: 'Export Confirmer',
  });
  const confirmerUserId = await activateApplicationUserForTest(
    'https://export-attribution.example/realms/amber',
    'export-confirmer',
    'administrator'
  );
  try {
    const idempotencyKey = 'integration-export-attribution';
  const created = await request('/api/export/snapshots', {
    method: 'POST',
    headers: {
      'Idempotency-Key': idempotencyKey,
      'X-Request-ID': 'export-snapshot-created',
    },
    body: { fromSku: exportSku, toSku: exportSku },
  });
  assert.equal(created.response.status, 201, created.text);
  const snapshotId = created.data.id;
  assert.deepEqual((await pool.query(
    `SELECT created_by_user_id, confirmed_by_user_id, status
     FROM export_snapshots WHERE id = $1`,
    [snapshotId]
  )).rows, [{
    created_by_user_id: String(creatorUserId),
    confirmed_by_user_id: null,
    status: 'generated',
  }]);
  const createdAudit = await pool.query(
    `SELECT event_key, actor_user_id, request_id, subject_type, subject_id, details
     FROM audit_events
     WHERE event_key = 'export_snapshot.created' AND subject_id = $1`,
    [snapshotId]
  );
  assert.deepEqual(createdAudit.rows, [{
    event_key: 'export_snapshot.created',
    actor_user_id: String(creatorUserId),
    request_id: 'export-snapshot-created',
    subject_type: 'export_snapshot',
    subject_id: snapshotId,
    details: { fromSku: exportSku, toSku: exportSku, rowCount: 1 },
  }]);

  const reused = await request('/api/export/snapshots', {
    method: 'POST',
    authentication: confirmerSession,
    headers: {
      'Idempotency-Key': idempotencyKey,
      'X-Request-ID': 'export-snapshot-reused',
    },
    body: { fromSku: exportSku, toSku: exportSku },
  });
  assert.equal(reused.response.status, 201, reused.text);
  assert.equal(reused.data.id, snapshotId);
  assert.equal(Number((await pool.query(
    'SELECT created_by_user_id FROM export_snapshots WHERE id = $1',
    [snapshotId]
  )).rows[0].created_by_user_id), creatorUserId);
  assert.equal(Number((await pool.query(
    `SELECT count(*) FROM audit_events
     WHERE event_key = 'export_snapshot.created' AND subject_id = $1`,
    [snapshotId]
  )).rows[0].count), 1);

  const confirmed = await request(`/api/export/snapshots/${snapshotId}/confirm`, {
    method: 'POST',
    authentication: confirmerSession,
    headers: { 'X-Request-ID': 'export-snapshot-confirmed' },
    body: {},
  });
  assert.equal(confirmed.response.status, 200, confirmed.text);
  assert.equal(Number((await pool.query(
    'SELECT confirmed_by_user_id FROM export_snapshots WHERE id = $1',
    [snapshotId]
  )).rows[0].confirmed_by_user_id), confirmerUserId);
  const confirmedAudit = await pool.query(
    `SELECT event_key, actor_user_id, request_id, subject_type, subject_id, details
     FROM audit_events
     WHERE event_key = 'export_snapshot.confirmed' AND subject_id = $1`,
    [snapshotId]
  );
  assert.equal(confirmedAudit.rows.length, 1);
  assert.deepEqual(confirmedAudit.rows[0], {
    event_key: 'export_snapshot.confirmed',
    actor_user_id: String(confirmerUserId),
    request_id: 'export-snapshot-confirmed',
    subject_type: 'export_snapshot',
    subject_id: snapshotId,
    details: {
      exportedToProductId: Number((await pool.query(
        'SELECT exported_to_product_id FROM export_snapshots WHERE id = $1',
        [snapshotId]
      )).rows[0].exported_to_product_id),
    },
  });

  const repeatedConfirmation = await request(`/api/export/snapshots/${snapshotId}/confirm`, {
    method: 'POST',
    headers: { 'X-Request-ID': 'export-snapshot-confirmed-again' },
    body: {},
  });
  assert.equal(repeatedConfirmation.response.status, 200, repeatedConfirmation.text);
  assert.equal(Number((await pool.query(
    'SELECT confirmed_by_user_id FROM export_snapshots WHERE id = $1',
    [snapshotId]
  )).rows[0].confirmed_by_user_id), confirmerUserId);
  assert.equal(Number((await pool.query(
    `SELECT count(*) FROM audit_events
     WHERE event_key = 'export_snapshot.confirmed' AND subject_id = $1`,
    [snapshotId]
  )).rows[0].count), 1);

  await assert.rejects(
    pool.query('UPDATE export_snapshots SET created_by_user_id = $1 WHERE id = $2', [
      confirmerUserId,
      snapshotId,
    ]),
    /immutable/
  );
  await assert.rejects(
    pool.query('UPDATE export_snapshots SET confirmed_by_user_id = $1 WHERE id = $2', [
      creatorUserId,
      snapshotId,
    ]),
    /immutable/
  );
  } finally {
    await replaceActiveRoleForTest(confirmerUserId, 'manager');
  }
});

test('export audit failures roll back snapshot creation and first confirmation', async () => {
  const exportSku = (await pool.query(
    `SELECT full_sku FROM products
     WHERE COALESCE(exclude_from_export, 0) = 0
     ORDER BY id DESC LIMIT 1`
  )).rows[0].full_sku;
  const failedCreationKey = 'integration-export-created-audit-failure';
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_test_export_created_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced export created audit failure';
    END;
    $$;
    CREATE TRIGGER fail_test_export_created_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW
    WHEN (NEW.event_key = 'export_snapshot.created')
    EXECUTE FUNCTION fail_test_export_created_audit();
  `);
  try {
    const failedCreation = await request('/api/export/snapshots', {
      method: 'POST',
      headers: { 'Idempotency-Key': failedCreationKey },
      body: { fromSku: exportSku, toSku: exportSku },
    });
    assert.equal(failedCreation.response.status, 400, failedCreation.text);
  } finally {
    await pool.query('DROP TRIGGER fail_test_export_created_audit ON audit_events');
    await pool.query('DROP FUNCTION fail_test_export_created_audit()');
  }
  assert.equal(Number((await pool.query(
    'SELECT count(*) FROM export_snapshots WHERE idempotency_key = $1',
    [failedCreationKey]
  )).rows[0].count), 0);

  const created = await request('/api/export/snapshots', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'integration-export-confirmed-audit-failure' },
    body: { fromSku: exportSku, toSku: exportSku },
  });
  assert.equal(created.response.status, 201, created.text);
  const cursorBefore = (await pool.query(
    `SELECT exported_to_product_id, last_snapshot_id FROM export_state WHERE singleton = TRUE`
  )).rows[0];
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_test_export_confirmed_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced export confirmed audit failure';
    END;
    $$;
    CREATE TRIGGER fail_test_export_confirmed_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW
    WHEN (NEW.event_key = 'export_snapshot.confirmed')
    EXECUTE FUNCTION fail_test_export_confirmed_audit();
  `);
  try {
    const failedConfirmation = await request(
      `/api/export/snapshots/${created.data.id}/confirm`,
      { method: 'POST', body: {} }
    );
    assert.equal(failedConfirmation.response.status, 400, failedConfirmation.text);
  } finally {
    await pool.query('DROP TRIGGER fail_test_export_confirmed_audit ON audit_events');
    await pool.query('DROP FUNCTION fail_test_export_confirmed_audit()');
  }
  assert.deepEqual((await pool.query(
    `SELECT status, confirmed_at, confirmed_by_user_id
     FROM export_snapshots WHERE id = $1`,
    [created.data.id]
  )).rows, [{ status: 'generated', confirmed_at: null, confirmed_by_user_id: null }]);
  assert.deepEqual((await pool.query(
    `SELECT exported_to_product_id, last_snapshot_id FROM export_state WHERE singleton = TRUE`
  )).rows[0], cursorBefore);
  assert.equal(Number((await pool.query(
    `SELECT count(*) FROM audit_events
     WHERE event_key = 'export_snapshot.confirmed' AND subject_id = $1`,
    [created.data.id]
  )).rows[0].count), 0);
});

test('SKU schema publication attribution and audit share the publication transaction', async () => {
  const actorUserId = Number(authenticatedSession.applicationUser.id);
  const originalMmLabel = (await pool.query(
    "SELECT label FROM questions WHERE category_code = 'MM' AND key = 'kind'"
  )).rows[0].label;
  const originalWwLabel = (await pool.query(
    "SELECT label FROM questions WHERE category_code = 'WW' AND key = 'kind'"
  )).rows[0].label;
  try {
    await pool.query(
      "UPDATE questions SET label = label || ' published' WHERE category_code = 'MM' AND key = 'kind'"
    );
    const published = await request('/api/admin/sku-schema/MM/publish', {
      method: 'POST',
      headers: { 'X-Request-ID': 'sku-schema-published' },
      body: {},
    });
    assert.equal(published.response.status, 200, published.text);
    assert.equal(published.data.categoryCode, 'MM');
    assert.equal(published.data.version, 2);
    assert.equal(Number((await pool.query(
      'SELECT published_by_user_id FROM sku_schema_versions WHERE id = $1',
      [published.data.id]
    )).rows[0].published_by_user_id), actorUserId);
    assert.deepEqual((await pool.query(
      `SELECT event_key, actor_user_id, request_id, subject_type, subject_id, details
       FROM audit_events
       WHERE event_key = 'sku_schema.published' AND subject_id = $1`,
      [String(published.data.id)]
    )).rows, [{
      event_key: 'sku_schema.published',
      actor_user_id: String(actorUserId),
      request_id: 'sku-schema-published',
      subject_type: 'sku_schema_version',
      subject_id: String(published.data.id),
      details: { categoryCode: 'MM', version: 2 },
    }]);

    await pool.query(
      "UPDATE questions SET label = label || ' failing' WHERE category_code = 'WW' AND key = 'kind'"
    );
    const beforeFailure = await pool.query(
      `SELECT id, version, status, published_by_user_id
       FROM sku_schema_versions WHERE category_code = 'WW' ORDER BY version`
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_sku_schema_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced SKU schema audit failure';
      END;
      $$;
      CREATE TRIGGER fail_test_sku_schema_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW
      WHEN (NEW.event_key = 'sku_schema.published')
      EXECUTE FUNCTION fail_test_sku_schema_audit();
    `);
    try {
      const failedPublication = await request('/api/admin/sku-schema/WW/publish', {
        method: 'POST', body: {},
      });
      assert.equal(failedPublication.response.status, 500, failedPublication.text);
    } finally {
      await pool.query('DROP TRIGGER fail_test_sku_schema_audit ON audit_events');
      await pool.query('DROP FUNCTION fail_test_sku_schema_audit()');
    }
    assert.deepEqual((await pool.query(
      `SELECT id, version, status, published_by_user_id
       FROM sku_schema_versions WHERE category_code = 'WW' ORDER BY version`
    )).rows, beforeFailure.rows);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE event_key = 'sku_schema.published' AND details ->> 'categoryCode' = 'WW'`
    )).rows[0].count), 0);
  } finally {
    await pool.query(
      "UPDATE questions SET label = $1 WHERE category_code = 'MM' AND key = 'kind'",
      [originalMmLabel]
    );
    await pool.query(
      "UPDATE questions SET label = $1 WHERE category_code = 'WW' AND key = 'kind'",
      [originalWwLabel]
    );
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

test('export viewing is shared while snapshot creation and confirmation remain Administrator-only', async () => {
  const userId = authenticatedSession.applicationUser.id;
  const expectDenied = async (url, options) => {
    const result = await request(url, options);
    assert.equal(result.response.status, 403, result.text);
    assert.deepEqual(result.data, {
      code: 'INSUFFICIENT_PERMISSION',
      error: 'Insufficient permission',
      requiredPermission: 'exports.create',
    });
  };
  const getExportMutationState = async (snapshotId) => ({
    snapshotCount: Number((await pool.query(
      'SELECT count(*) FROM export_snapshots'
    )).rows[0].count),
    snapshot: (await pool.query(
      'SELECT confirmed_at FROM export_snapshots WHERE id = $1',
      [snapshotId]
    )).rows[0],
    cursor: (await pool.query(
      `SELECT exported_to_product_id, last_snapshot_id
       FROM export_state
       WHERE singleton = TRUE`
    )).rows[0],
  });

  await replaceActiveRoleForTest(userId, 'administrator');
  try {
    assert.equal((await request('/api/export/status')).response.status, 200);
    const administratorSnapshot = await request('/api/export/snapshots', {
      method: 'POST',
      body: { fromSku: primarySku, toSku: primarySku },
      headers: { 'Idempotency-Key': 'rbac-export-administrator' },
    });
    assert.equal(administratorSnapshot.response.status, 201, administratorSnapshot.text);
    const administratorDownload = await request(
      `/api/export/snapshots/${administratorSnapshot.data.id}/csv`
    );
    assert.equal(administratorDownload.response.status, 200, administratorDownload.text);
    assert.match(administratorDownload.text, /^sku,price_uah/);
    assert.equal((await request(
      `/api/export/snapshots/${administratorSnapshot.data.id}/confirm`,
      { method: 'POST', body: {} }
    )).response.status, 200);

    const unconfirmedSnapshot = await request('/api/export/snapshots', {
      method: 'POST',
      body: { fromSku: primarySku, toSku: primarySku },
      headers: { 'Idempotency-Key': 'rbac-export-denied-confirm' },
    });
    assert.equal(unconfirmedSnapshot.response.status, 201, unconfirmedSnapshot.text);
    const protectedState = await getExportMutationState(unconfirmedSnapshot.data.id);
    assert.equal(protectedState.snapshot.confirmed_at, null);

    for (const roleKey of ['manager', 'storekeeper']) {
      await replaceActiveRoleForTest(userId, roleKey);
      const me = await request('/api/auth/me');
      assert.equal(me.data.permissions.includes('exports.view'), true);
      assert.equal(me.data.permissions.includes('exports.create'), false);
      assert.equal((await request('/api/export/status')).response.status, 200);
      assert.equal((await request(
        `/api/export/snapshots/${administratorSnapshot.data.id}/csv`
      )).response.status, 200);
      assert.equal((await request('/api/export/csv')).response.status, 410);

      await expectDenied('/api/export/snapshots', {
        method: 'POST',
        body: { fromSku: primarySku, toSku: primarySku },
        headers: { 'Idempotency-Key': `rbac-export-${roleKey}-denied` },
      });
      await expectDenied(`/api/export/snapshots/${unconfirmedSnapshot.data.id}/confirm`, {
        method: 'POST', body: {},
      });
      assert.deepEqual(
        await getExportMutationState(unconfirmedSnapshot.data.id),
        protectedState
      );

      // A permission denial must leave the existing authenticated session usable.
      assert.equal((await request('/api/export/status')).response.status, 200);
    }
  } finally {
    await replaceActiveRoleForTest(userId, 'administrator');
  }
});

test('business endpoints enforce the Administrator, Storekeeper, and Manager capability matrix', async () => {
  const userId = authenticatedSession.applicationUser.id;
  const denied = async (url, options, requiredPermission) => {
    const result = await request(url, options);
    assert.equal(result.response.status, 403, result.text);
    assert.deepEqual(result.data, {
      code: 'INSUFFICIENT_PERMISSION',
      error: 'Insufficient permission',
      requiredPermission,
    });
    assert.equal(result.response.headers.get('location'), null);
    return result;
  };

  await replaceActiveRoleForTest(userId, 'storekeeper');
  const storekeeperMe = await request('/api/auth/me');
  assert.equal(storekeeperMe.response.status, 200, storekeeperMe.text);
  assert.equal(storekeeperMe.data.roles[0].key, 'storekeeper');
  assert.equal(storekeeperMe.data.permissions.includes('products.archive'), true);
  assert.equal(storekeeperMe.data.permissions.includes('products.recount'), true);

  const firstPreview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(firstPreview.response.status, 200, firstPreview.text);
  const firstProduct = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: firstPreview.data.previewToken,
    },
  });
  assert.equal(firstProduct.response.status, 200, firstProduct.text);
  const decoded = await request('/api/decode', {
    method: 'POST', body: { sku: firstProduct.data.fullSku },
  });
  assert.equal(decoded.response.status, 200, decoded.text);

  const correctionPreview = await request('/api/recount/preview', {
    method: 'POST',
    body: { sourceSku: firstProduct.data.fullSku, answers: { kind: 2 }, reason: 'RBAC workflow' },
  });
  assert.equal(correctionPreview.response.status, 200, correctionPreview.text);
  const correction = await request('/api/admin/correction-requests', {
    method: 'POST',
    body: { sourceSku: firstProduct.data.fullSku, answers: { kind: 2 }, reason: 'RBAC workflow' },
  });
  assert.equal(correction.response.status, 200, correction.text);
  const correctionId = Number(correction.data.request.id);
  const claim = await request(`/api/admin/correction-requests/${correctionId}/claim`, {
    method: 'POST', body: {},
  });
  assert.equal(claim.response.status, 200, claim.text);
  const refresh = await request(`/api/admin/correction-requests/${correctionId}/refresh`, {
    method: 'POST', body: { claimVersion: claim.data.request.claimVersion },
  });
  assert.equal(refresh.response.status, 200, refresh.text);
  const completed = await request(`/api/admin/correction-requests/${correctionId}/complete`, {
    method: 'POST', body: { claimVersion: claim.data.request.claimVersion },
  });
  assert.equal(completed.response.status, 200, completed.text);
  const correctedSku = completed.data.recount.corrected.fullSku;
  const queuedRecountAttribution = await pool.query(
    `SELECT corrected.created_by_user_id, pc.performed_by_user_id,
            ae.actor_user_id, ae.details
     FROM product_corrections pc
     JOIN products corrected ON corrected.id = pc.corrected_product_id
     JOIN audit_events ae
       ON ae.event_key = 'product.recounted'
      AND ae.subject_type = 'product'
      AND ae.subject_id = pc.source_product_id::text
     WHERE pc.source_product_id = $1`,
    [Number(firstProduct.data.id)]
  );
  assert.equal(Number(queuedRecountAttribution.rows[0].created_by_user_id), userId);
  assert.equal(Number(queuedRecountAttribution.rows[0].performed_by_user_id), userId);
  assert.equal(Number(queuedRecountAttribution.rows[0].actor_user_id), userId);
  assert.equal(queuedRecountAttribution.rows[0].details.correctionRequestId, correctionId);
  const repeatedCompletion = await request(
    `/api/admin/correction-requests/${correctionId}/complete`,
    { method: 'POST', body: { claimVersion: claim.data.request.claimVersion } }
  );
  assert.equal(repeatedCompletion.response.status, 200, repeatedCompletion.text);
  assert.equal(repeatedCompletion.data.alreadyCompleted, true);
  const completionAudit = await pool.query(
    `SELECT event_key, actor_user_id, details
     FROM audit_events
     WHERE (event_key = 'product.recounted'
            AND subject_type = 'product' AND subject_id = $1)
        OR (event_key = 'correction_request.completed'
            AND subject_type = 'correction_request' AND subject_id = $2)
     ORDER BY id`,
    [String(firstProduct.data.id), String(correctionId)]
  );
  assert.deepEqual(completionAudit.rows.map((row) => row.event_key), [
    'correction_request.completed',
    'product.recounted',
  ]);
  assert.equal(completionAudit.rows.every((row) => Number(row.actor_user_id) === userId), true);
  assert.deepEqual(completionAudit.rows[0].details, {
    claimVersion: Number(claim.data.request.claimVersion),
    nextClaimVersion: Number(claim.data.request.claimVersion) + 1,
    sourceProductId: Number(firstProduct.data.id),
    correctedProductId: Number(completed.data.recount.correctedProductId),
    productCorrectionId: Number(queuedRecountAttribution.rows[0].details.productCorrectionId),
  });

  const history = await request('/api/products');
  assert.equal(history.response.status, 200, history.text);
  assert.equal(history.data.some((product) => product.full_sku === correctedSku), true);
  const storekeeperPrepare = await request('/api/admin/repricing/global/preview', {
    method: 'POST', body: {},
  });
  assert.equal(storekeeperPrepare.response.status, 200, storekeeperPrepare.text);

  const categoryCountBefore = Number((await pool.query(
    "SELECT count(*) FROM categories WHERE code = 'RS'"
  )).rows[0].count);
  await denied('/api/admin/category', {
    method: 'POST', body: { code: 'RS', name: 'Storekeeper denied category' },
  }, 'catalog.manage');
  assert.equal(Number((await pool.query(
    "SELECT count(*) FROM categories WHERE code = 'RS'"
  )).rows[0].count), categoryCountBefore);
  await denied('/api/admin/prices/ZZ', {}, 'pricing.view');
  await denied('/api/admin/repricing/apply', { method: 'POST', body: {} }, 'repricing.apply');
  await denied('/api/admin/repricing/999999/rollback', { method: 'POST', body: {} }, 'repricing.rollback');
  const exportCountBefore = Number((await pool.query('SELECT count(*) FROM export_snapshots')).rows[0].count);
  await denied('/api/export/snapshots', {
    method: 'POST', body: { fromSku: correctedSku, toSku: correctedSku },
  }, 'exports.create');
  assert.equal(Number((await pool.query('SELECT count(*) FROM export_snapshots')).rows[0].count), exportCountBefore);
  await denied('/api/admin/correction-requests/999999/force-release', {
    method: 'POST', body: { confirm: true },
  }, 'corrections.force_release');

  const archived = await request('/api/delete', {
    method: 'POST', body: { skuToDelete: correctedSku },
  });
  assert.equal(archived.response.status, 200, archived.text);
  assert.equal((await pool.query(
    'SELECT status FROM products WHERE full_sku = $1', [correctedSku]
  )).rows[0].status, 'archived');

  const secondPreview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(secondPreview.response.status, 200, secondPreview.text);
  const managerRequestSource = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: secondPreview.data.previewToken,
    },
  });
  assert.equal(managerRequestSource.response.status, 200, managerRequestSource.text);

  await replaceActiveRoleForTest(userId, 'manager');
  const managerMe = await request('/api/auth/me');
  assert.equal(managerMe.response.status, 200, managerMe.text);
  assert.equal(managerMe.data.roles[0].key, 'manager');
  assert.equal(managerMe.data.permissions.includes('products.archive'), false);
  assert.equal(managerMe.data.permissions.includes('products.create'), false);
  assert.equal(managerMe.data.permissions.includes('corrections.claim'), false);
  assert.equal(managerMe.data.permissions.includes('corrections.complete'), false);
  assert.equal(managerMe.data.permissions.includes('corrections.reject'), true);

  const managerDecode = await request('/api/decode', {
    method: 'POST', body: { sku: managerRequestSource.data.fullSku },
  });
  assert.equal(managerDecode.response.status, 200, managerDecode.text);
  const managerCorrectionPreview = await request('/api/recount/preview', {
    method: 'POST',
    body: {
      sourceSku: managerRequestSource.data.fullSku,
      answers: { kind: 2 },
      reason: 'Manager correction request',
    },
  });
  assert.equal(managerCorrectionPreview.response.status, 200, managerCorrectionPreview.text);
  const managerCorrection = await request('/api/admin/correction-requests', {
    method: 'POST',
    body: {
      sourceSku: managerRequestSource.data.fullSku,
      answers: { kind: 2 },
      reason: 'Manager correction request',
    },
  });
  assert.equal(managerCorrection.response.status, 200, managerCorrection.text);
  const managerCorrectionId = Number(managerCorrection.data.request.id);
  const managerCorrectionList = await request('/api/admin/correction-requests');
  assert.equal(managerCorrectionList.response.status, 200, managerCorrectionList.text);
  assert.equal(
    managerCorrectionList.data.items.some((item) => Number(item.id) === managerCorrectionId),
    true
  );
  await denied(`/api/admin/correction-requests/${managerCorrectionId}/claim`, {
    method: 'POST', body: {},
  }, 'corrections.claim');
  await denied(`/api/admin/correction-requests/${managerCorrectionId}/complete`, {
    method: 'POST', body: {},
  }, 'corrections.complete');
  const managerRejected = await request(
    `/api/admin/correction-requests/${managerCorrectionId}/status`,
    { method: 'PATCH', body: { status: 'rejected' } }
  );
  assert.equal(managerRejected.response.status, 200, managerRejected.text);
  assert.equal(managerRejected.data.request.status, 'rejected');
  assert.equal((await request('/api/products')).response.status, 200);
  const managerPrices = await request('/api/admin/prices/ZZ');
  assert.equal(managerPrices.response.status, 200, managerPrices.text);
  assert.equal(managerPrices.data.scenarios.length > 0, true);
  assert.equal(managerPrices.data.scenarios[0].matrix.length > 0, true);
  assert.ok(Array.isArray(managerPrices.data.modifiers));
  assert.equal((await request('/api/admin/repricing/global/preview', {
    method: 'POST', body: {},
  })).response.status, 200);

  const productCountBefore = Number((await pool.query('SELECT count(*) FROM products')).rows[0].count);
  await denied('/api/save', { method: 'POST', body: {} }, 'products.create');
  assert.equal(Number((await pool.query('SELECT count(*) FROM products')).rows[0].count), productCountBefore);
  await denied('/api/delete', {
    method: 'POST', body: { skuToDelete: managerRequestSource.data.fullSku },
  }, 'products.archive');
  assert.equal((await pool.query(
    'SELECT status FROM products WHERE full_sku = $1', [managerRequestSource.data.fullSku]
  )).rows[0].status, 'active');
  await denied('/api/recount/apply', {
    method: 'POST', body: { sourceSku: managerRequestSource.data.fullSku, answers: { kind: 2 } },
  }, 'products.recount');
  await denied('/api/admin/config', {}, 'catalog.view');
  await denied('/api/admin/roles', {}, 'roles.manage');
  await denied('/api/admin/category', {
    method: 'POST', body: { code: 'RM', name: 'Manager denied category' },
  }, 'catalog.manage');

  const priceCellBefore = await pool.query(
    'SELECT price FROM price_matrix WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0',
    [schemas.ZZScenario]
  );
  await denied('/api/admin/price-cell', {
    method: 'POST',
    body: { scenario_id: schemas.ZZScenario, x_val: 1, y_val: 0, price: 999999 },
  }, 'pricing.manage');
  const priceCellAfter = await pool.query(
    'SELECT price FROM price_matrix WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0',
    [schemas.ZZScenario]
  );
  assert.deepEqual(priceCellAfter.rows, priceCellBefore.rows);

  const schemaCountBefore = Number((await pool.query(
    "SELECT count(*) FROM sku_schema_versions WHERE category_code = 'ZZ'"
  )).rows[0].count);
  await denied('/api/admin/sku-schema/ZZ/publish', {
    method: 'POST', body: {},
  }, 'sku_schemas.publish');
  assert.equal(Number((await pool.query(
    "SELECT count(*) FROM sku_schema_versions WHERE category_code = 'ZZ'"
  )).rows[0].count), schemaCountBefore);
  await denied('/api/admin/repricing/apply', { method: 'POST', body: {} }, 'repricing.apply');
  await denied('/api/admin/repricing/999999/rollback', { method: 'POST', body: {} }, 'repricing.rollback');
  await denied('/api/export/snapshots', {
    method: 'POST', body: { fromSku: managerRequestSource.data.fullSku },
  }, 'exports.create');
  await denied('/api/admin/correction-requests/999999/force-release', {
    method: 'POST', body: { confirm: true },
  }, 'corrections.force_release');

  const stillLoggedIn = await request('/api/decode', {
    method: 'POST', body: { sku: managerRequestSource.data.fullSku },
  });
  assert.equal(stillLoggedIn.response.status, 200, stillLoggedIn.text);

  await replaceActiveRoleForTest(userId, null);
  await denied('/api/decode', {
    method: 'POST', body: { sku: managerRequestSource.data.fullSku },
  }, 'products.decode');
  await replaceActiveRoleForTest(userId, 'manager');
  assert.equal((await request('/api/decode', {
    method: 'POST', body: { sku: managerRequestSource.data.fullSku },
  })).response.status, 200);

  await replaceActiveRoleForTest(userId, 'administrator');
  const invalidDeleteType = await request('/api/admin/delete-item', {
    method: 'POST', body: { type: '__proto__', id: 1 },
  });
  assert.equal(invalidDeleteType.response.status, 400, invalidDeleteType.text);
  assert.deepEqual(invalidDeleteType.data, { error: 'Invalid resource type' });
});

test('users.manage API administers one current application role and updates existing sessions immediately', async () => {
  if (!authenticatedSession) authenticatedSession = await authenticateApplicationSession('/admin');
  const administratorUserId = authenticatedSession.applicationUser.id;
  await replaceActiveRoleForTest(administratorUserId, 'administrator');
  const administratorRoleId = await roleIdForKey('administrator');
  const managerRoleId = await roleIdForKey('manager');
  const storekeeperRoleId = await roleIdForKey('storekeeper');

  const createPendingUser = (suffix) => resolveOrCreateApplicationUser({
    issuer: 'https://user-admin-api.example/realms/amber',
    sub: `user-admin-${suffix}`,
    preferred_username: `user.admin.${suffix}`,
    name: `User Admin ${suffix}`,
    email: `${suffix}@example.invalid`,
    authenticatedAt: '2026-09-09T12:00:00.000Z',
  });
  const assignmentState = async (userId) => {
    const result = await pool.query(
      `SELECT u.status, r.role_key, a.revoked_at, a.assigned_by_user_id,
              a.revoked_by_user_id
       FROM application_users u
       LEFT JOIN user_role_assignments a ON a.application_user_id = u.id
       LEFT JOIN roles r ON r.id = a.role_id
       WHERE u.id = $1
       ORDER BY a.id`,
      [userId]
    );
    return result.rows;
  };

  const rolesResponse = await request('/api/admin/users/roles');
  assert.equal(rolesResponse.response.status, 200, rolesResponse.text);
  assert.deepEqual(rolesResponse.data.roles.map((role) => role.id), [
    administratorRoleId, managerRoleId, storekeeperRoleId,
  ]);
  assert.equal(rolesResponse.data.roles.every((role) => (
    Number.isSafeInteger(role.id) && role.displayName && role.status === 'active'
  )), true);

  const administratorAssignmentId = await currentAssignmentIdForUser(administratorUserId);
  for (const [path, method, body] of [
    [`/api/admin/users/${administratorUserId}/disable`, 'POST', {}],
    [`/api/admin/users/${administratorUserId}/role`, 'PUT', {
      roleId: managerRoleId,
      expectedAssignmentId: administratorAssignmentId,
    }],
  ]) {
    const lastAdministratorConflict = await request(path, { method, body });
    assert.equal(lastAdministratorConflict.response.status, 409, lastAdministratorConflict.text);
    assert.equal(lastAdministratorConflict.data.code, 'LAST_ADMINISTRATOR_REQUIRED');
  }
  assert.equal(Number((await pool.query(
    `SELECT count(*) FROM audit_events
     WHERE subject_type = 'application_user' AND subject_id = $1`,
    [String(administratorUserId)]
  )).rows[0].count), 0, 'failed user-management mutations must not be audited as successes');
  const administratorAfterConflicts = await request('/api/auth/me');
  assert.equal(administratorAfterConflicts.response.status, 200);
  assert.deepEqual(
    administratorAfterConflicts.data.roles.map((role) => role.key),
    ['administrator']
  );
  assert.equal(administratorAfterConflicts.data.permissions.includes('users.manage'), true);

  const rejectedUser = await createPendingUser('rejected');
  const customRole = await pool.query(
    `INSERT INTO roles (role_key, display_name, description, is_system)
     VALUES ('integration_custom_role', 'Integration custom role', 'Assignable custom role', FALSE)
     RETURNING id`
  );
  for (const [roleBody, expectedCode] of [
    [{}, 'INVALID_ROLE_ID'],
    [{ roleId: 'integration_custom_role' }, 'INVALID_ROLE_ID'],
    [{ roleId: 99999999 }, 'ROLE_NOT_ASSIGNABLE'],
  ]) {
    const rejected = await request(`/api/admin/users/${rejectedUser.id}/approve`, {
      method: 'POST',
      body: roleBody,
    });
    assert.equal(rejected.response.status, 400, rejected.text);
    assert.equal(rejected.data.code, expectedCode);
    assert.deepEqual(await assignmentState(rejectedUser.id), [{
      status: 'pending',
      role_key: null,
      revoked_at: null,
      assigned_by_user_id: null,
      revoked_by_user_id: null,
    }]);
  }
  const missingCsrf = await request(`/api/admin/users/${rejectedUser.id}/approve`, {
    method: 'POST',
    body: { roleId: managerRoleId },
    csrfToken: null,
  });
  assert.equal(missingCsrf.response.status, 403, missingCsrf.text);
  assert.deepEqual(missingCsrf.data, { error: 'Invalid CSRF token' });
  assert.equal((await assignmentState(rejectedUser.id))[0].status, 'pending');
  const customApproval = await request(`/api/admin/users/${rejectedUser.id}/approve`, {
    method: 'POST',
    body: { roleId: Number(customRole.rows[0].id) },
  });
  assert.equal(customApproval.response.status, 200, customApproval.text);
  assert.equal(customApproval.data.user.role.key, 'integration_custom_role');

  const deniedUser = await createPendingUser('denied');
  for (const roleKey of ['manager', 'storekeeper']) {
    await replaceActiveRoleForTest(administratorUserId, roleKey);
    const listDenied = await request('/api/admin/users');
    assert.equal(listDenied.response.status, 403, listDenied.text);
    assert.equal(listDenied.data.code, 'INSUFFICIENT_PERMISSION');
    assert.equal(listDenied.data.requiredPermission, 'users.manage');
    const mutationDenied = await request(`/api/admin/users/${deniedUser.id}/approve`, {
      method: 'POST',
      body: { roleId: storekeeperRoleId },
    });
    assert.equal(mutationDenied.response.status, 403, mutationDenied.text);
    assert.equal(mutationDenied.data.code, 'INSUFFICIENT_PERMISSION');
    assert.deepEqual(await assignmentState(deniedUser.id), [{
      status: 'pending',
      role_key: null,
      revoked_at: null,
      assigned_by_user_id: null,
      revoked_by_user_id: null,
    }]);
    assert.equal((await request('/api/config')).response.status, 200);
  }
  await replaceActiveRoleForTest(administratorUserId, 'administrator');

  const pendingStorekeeper = await createPendingUser('storekeeper');
  const pendingManager = await createPendingUser('manager');
  const pendingAdministrator = await createPendingUser('administrator');
  for (const [user, roleKey, roleId] of [
    [pendingStorekeeper, 'storekeeper', storekeeperRoleId],
    [pendingManager, 'manager', managerRoleId],
    [pendingAdministrator, 'administrator', administratorRoleId],
  ]) {
    const approved = await request(`/api/admin/users/${user.id}/approve`, {
      method: 'POST',
      body: { roleId },
    });
    assert.equal(approved.response.status, 200, approved.text);
    assert.equal(approved.data.user.status, 'active');
    assert.equal(approved.data.user.role.key, roleKey);
    const activeAssignments = (await assignmentState(user.id))
      .filter((row) => row.revoked_at === null && row.role_key !== null);
    assert.equal(activeAssignments.length, 1);
    assert.equal(activeAssignments[0].role_key, roleKey);
    assert.equal(Number(activeAssignments[0].assigned_by_user_id), administratorUserId);
  }

  let expectedAssignmentId = await currentAssignmentIdForUser(pendingStorekeeper.id);
  let changed = await request(`/api/admin/users/${pendingStorekeeper.id}/role`, {
    method: 'PUT', body: { roleId: managerRoleId, expectedAssignmentId },
  });
  assert.equal(changed.response.status, 200, changed.text);
  assert.equal(changed.data.user.role.key, 'manager');
  expectedAssignmentId = changed.data.user.currentAssignmentId;
  changed = await request(`/api/admin/users/${pendingStorekeeper.id}/role`, {
    method: 'PUT', body: { roleId: storekeeperRoleId, expectedAssignmentId },
  });
  assert.equal(changed.response.status, 200, changed.text);
  assert.equal(changed.data.user.role.key, 'storekeeper');
  const storekeeperHistory = await assignmentState(pendingStorekeeper.id);
  assert.equal(storekeeperHistory.length, 3);
  assert.equal(storekeeperHistory.filter((row) => row.revoked_at === null).length, 1);
  assert.equal(storekeeperHistory.filter((row) => row.revoked_at !== null).length, 2);
  assert.equal(storekeeperHistory.filter(
    (row) => Number(row.revoked_by_user_id) === administratorUserId
  ).length, 2);

  expectedAssignmentId = await currentAssignmentIdForUser(pendingManager.id);
  changed = await request(`/api/admin/users/${pendingManager.id}/role`, {
    method: 'PUT', body: { roleId: storekeeperRoleId, expectedAssignmentId },
  });
  assert.equal(changed.response.status, 200, changed.text);
  assert.equal(changed.data.user.role.key, 'storekeeper');
  assert.equal((await assignmentState(pendingManager.id)).filter(
    (row) => row.revoked_at === null
  ).length, 1);

  const liveSession = await authenticateIdentitySession({
    subject: 'existing-session-role-change',
    preferredUsername: 'existing.session',
    displayName: 'Existing Session',
  });
  const secondLiveSession = await authenticateIdentitySession({
    subject: 'existing-session-role-change',
    preferredUsername: 'existing.session',
    displayName: 'Existing Session',
  });
  const liveUserId = liveSession.applicationUser.id;
  const approvedLive = await request(`/api/admin/users/${liveUserId}/approve`, {
    method: 'POST',
    body: { roleId: storekeeperRoleId },
    headers: { 'X-Request-ID': 'audit-user-approved' },
  });
  assert.equal(approvedLive.response.status, 200, approvedLive.text);
  assert.equal((await request('/api/config', { authentication: liveSession })).response.status, 200);
  assert.equal((await request('/api/admin/prices/ZZ', {
    authentication: liveSession,
  })).response.status, 403);

  const liveRoleChange = await request(`/api/admin/users/${liveUserId}/role`, {
    method: 'PUT',
    body: {
      roleId: managerRoleId,
      expectedAssignmentId: approvedLive.data.user.currentAssignmentId,
    },
    headers: { 'X-Request-ID': 'audit-user-role-manager' },
  });
  assert.equal(liveRoleChange.response.status, 200, liveRoleChange.text);
  const liveMe = await request('/api/auth/me', { authentication: liveSession });
  assert.deepEqual(liveMe.data.roles.map((role) => role.key), ['manager']);
  assert.equal((await request('/api/admin/prices/ZZ', {
    authentication: liveSession,
  })).response.status, 200);

  const noOpRoleChange = await request(`/api/admin/users/${liveUserId}/role`, {
    method: 'PUT',
    body: {
      roleId: managerRoleId,
      expectedAssignmentId: liveRoleChange.data.user.currentAssignmentId,
    },
    headers: { 'X-Request-ID': 'audit-user-role-no-op' },
  });
  assert.equal(noOpRoleChange.response.status, 200, noOpRoleChange.text);

  const disabled = await request(`/api/admin/users/${liveUserId}/disable`, {
    method: 'POST',
    body: {},
    headers: { 'X-Request-ID': 'audit-user-disabled' },
  });
  assert.equal(disabled.response.status, 200, disabled.text);
  assert.equal(disabled.data.user.status, 'disabled');
  const disabledBusiness = await request('/api/config', { authentication: liveSession });
  assert.equal(disabledBusiness.response.status, 403, disabledBusiness.text);
  assert.equal(disabledBusiness.data.code, 'APP_ACCESS_DISABLED');
  const disabledMe = await request('/api/auth/me', { authentication: liveSession });
  assert.equal(disabledMe.response.status, 200, disabledMe.text);
  assert.equal(disabledMe.data.applicationUser.status, 'disabled');
  const disabledLogout = await request('/api/auth/logout', {
    method: 'POST', body: {}, authentication: secondLiveSession,
  });
  assert.equal(disabledLogout.response.status, 200, disabledLogout.text);

  const disabledRoleChange = await request(`/api/admin/users/${liveUserId}/role`, {
    method: 'PUT',
    body: {
      roleId: storekeeperRoleId,
      expectedAssignmentId: disabled.data.user.currentAssignmentId,
    },
    headers: { 'X-Request-ID': 'audit-user-role-storekeeper' },
  });
  assert.equal(disabledRoleChange.response.status, 200, disabledRoleChange.text);
  assert.equal(disabledRoleChange.data.user.status, 'disabled');
  assert.equal(disabledRoleChange.data.user.role.key, 'storekeeper');
  const enabled = await request(`/api/admin/users/${liveUserId}/enable`, {
    method: 'POST',
    body: {},
    headers: { 'X-Request-ID': 'audit-user-enabled' },
  });
  assert.equal(enabled.response.status, 200, enabled.text);
  assert.equal(enabled.data.user.status, 'active');
  assert.equal(enabled.data.user.role.key, 'storekeeper');
  assert.equal((await request('/api/config', { authentication: liveSession })).response.status, 200);
  assert.equal((await request('/api/admin/prices/ZZ', {
    authentication: liveSession,
  })).response.status, 403);

  const list = await request('/api/admin/users');
  assert.equal(list.response.status, 200, list.text);
  const listedLiveUser = list.data.users.find((user) => user.id === liveUserId);
  assert.deepEqual(Object.keys(listedLiveUser).sort(), [
    'currentAssignmentId',
    'displayName',
    'id',
    'identityLinked',
    'lastAuthenticatedAt',
    'preferredUsername',
    'role',
    'status',
  ]);
  assert.equal(listedLiveUser.identityLinked, true);
  assert.doesNotMatch(JSON.stringify(listedLiveUser), /issuer|subject|email|existing-session-role-change/);

  const auditEvents = await pool.query(
    `SELECT event_key, actor_user_id, actor_snapshot, request_id, details
     FROM audit_events
     WHERE subject_type = 'application_user' AND subject_id = $1
     ORDER BY id`,
    [String(liveUserId)]
  );
  assert.deepEqual(auditEvents.rows.map((row) => row.event_key), [
    'application_user.approved',
    'application_user.role_changed',
    'application_user.disabled',
    'application_user.role_changed',
    'application_user.enabled',
  ]);
  assert.deepEqual(auditEvents.rows.map((row) => row.request_id), [
    'audit-user-approved',
    'audit-user-role-manager',
    'audit-user-disabled',
    'audit-user-role-storekeeper',
    'audit-user-enabled',
  ]);
  assert.equal(auditEvents.rows.every(
    (row) => Number(row.actor_user_id) === administratorUserId
  ), true);
  assert.equal(auditEvents.rows.every((row) => (
    JSON.stringify(row.actor_snapshot) === JSON.stringify({
      displayName: 'Critical Flows',
      preferredUsername: 'critical.flows',
    })
  )), true);
  assert.equal(auditEvents.rows.some((row) => row.request_id === 'audit-user-role-no-op'), false);
  assert.deepEqual(auditEvents.rows[1].details, {
    userStatus: 'active',
    previousRole: {
      id: storekeeperRoleId,
      key: 'storekeeper',
      displayName: 'Storekeeper',
    },
    newRole: {
      id: managerRoleId,
      key: 'manager',
      displayName: 'Manager',
    },
  });

  await pool.query(
    `UPDATE application_users
     SET display_name = 'Changed Later', preferred_username = 'changed.later'
     WHERE id = $1`,
    [administratorUserId]
  );
  const historicalSnapshots = await pool.query(
    `SELECT actor_snapshot FROM audit_events
     WHERE subject_type = 'application_user' AND subject_id = $1
     ORDER BY id`,
    [String(liveUserId)]
  );
  assert.equal(historicalSnapshots.rows.every((row) => (
    JSON.stringify(row.actor_snapshot) === JSON.stringify({
      displayName: 'Critical Flows',
      preferredUsername: 'critical.flows',
    })
  )), true, 'historical actor snapshots must not follow mutable user profiles');
  await pool.query(
    `UPDATE application_users
     SET display_name = 'Critical Flows', preferred_username = 'critical.flows'
     WHERE id = $1`,
    [administratorUserId]
  );
});

test('roles.manage API provides protected Administrator and editable versioned roles', async () => {
  if (!authenticatedSession) authenticatedSession = await authenticateApplicationSession('/admin/roles');
  await replaceActiveRoleForTest(authenticatedSession.applicationUser.id, 'administrator');

  const permissionsResponse = await request('/api/admin/roles/permissions');
  assert.equal(permissionsResponse.response.status, 200, permissionsResponse.text);
  assert.deepEqual(
    permissionsResponse.data.permissions
      .filter((permission) => permission.reserved)
      .map((permission) => permission.key),
    ['audit.view', 'roles.manage', 'users.manage']
  );

  let rolesResponse = await request('/api/admin/roles');
  assert.equal(rolesResponse.response.status, 200, rolesResponse.text);
  const administrator = rolesResponse.data.roles.find((role) => role.key === 'administrator');
  let manager = rolesResponse.data.roles.find((role) => role.key === 'manager');
  const storekeeper = rolesResponse.data.roles.find((role) => role.key === 'storekeeper');
  assert.equal(administrator.isProtected, true);
  assert.equal(manager.isProtected, false);
  assert.equal(manager.isSystem, true);

  const updatedStorekeeper = await request(`/api/admin/roles/${storekeeper.id}`, {
    method: 'PATCH',
    body: {
      displayName: storekeeper.displayName,
      description: `${storekeeper.description} (editable)`,
      expectedVersion: storekeeper.version,
    },
  });
  assert.equal(updatedStorekeeper.response.status, 200, updatedStorekeeper.text);
  assert.equal(updatedStorekeeper.data.role.version, storekeeper.version + 1);

  for (const [path, method, body] of [
    [`/api/admin/roles/${administrator.id}`, 'PATCH', {
      displayName: 'Changed Administrator',
      description: administrator.description,
      expectedVersion: administrator.version,
    }],
    [`/api/admin/roles/${administrator.id}/permissions`, 'PUT', {
      permissionKeys: administrator.permissionKeys.filter((key) => key !== 'products.view'),
      expectedVersion: administrator.version,
      expectedActiveAssignedUserCount: administrator.activeAssignedUserCount,
    }],
    [`/api/admin/roles/${administrator.id}/deactivate`, 'POST', {
      expectedVersion: administrator.version,
    }],
  ]) {
    const protectedResponse = await request(path, { method, body });
    assert.equal(protectedResponse.response.status, 409, protectedResponse.text);
    assert.equal(protectedResponse.data.code, 'ADMINISTRATOR_ROLE_PROTECTED');
  }

  const managerOriginal = {
    displayName: manager.displayName,
    description: manager.description,
    permissionKeys: manager.permissionKeys,
  };
  const concurrentManagerEdits = await Promise.all([
    request(`/api/admin/roles/${manager.id}`, {
      method: 'PATCH',
      body: {
        displayName: 'Manager concurrent A',
        description: manager.description,
        expectedVersion: manager.version,
      },
    }),
    request(`/api/admin/roles/${manager.id}`, {
      method: 'PATCH',
      body: {
        displayName: 'Manager concurrent B',
        description: manager.description,
        expectedVersion: manager.version,
      },
    }),
  ]);
  assert.deepEqual(
    concurrentManagerEdits.map((result) => result.response.status).sort(),
    [200, 409]
  );
  assert.equal(
    concurrentManagerEdits.find((result) => result.response.status === 409).data.code,
    'ROLE_VERSION_CONFLICT'
  );
  manager = concurrentManagerEdits.find((result) => result.response.status === 200).data.role;

  const noOpAuditBefore = Number((await pool.query(
    `SELECT COUNT(*) FROM audit_events
     WHERE subject_type = 'role' AND subject_id = $1 AND event_key = 'role.updated'`,
    [String(manager.id)]
  )).rows[0].count);
  const managerNoOp = await request(`/api/admin/roles/${manager.id}`, {
    method: 'PATCH',
    body: {
      displayName: manager.displayName,
      description: manager.description,
      expectedVersion: manager.version,
    },
    headers: { 'X-Request-ID': 'role-update-no-op' },
  });
  assert.equal(managerNoOp.response.status, 200, managerNoOp.text);
  assert.equal(Number((await pool.query(
    `SELECT COUNT(*) FROM audit_events
     WHERE subject_type = 'role' AND subject_id = $1 AND event_key = 'role.updated'`,
    [String(manager.id)]
  )).rows[0].count), noOpAuditBefore);

  const restoredManager = await request(`/api/admin/roles/${manager.id}`, {
    method: 'PATCH',
    body: {
      displayName: managerOriginal.displayName,
      description: `${managerOriginal.description} (editable)`,
      expectedVersion: manager.version,
    },
  });
  assert.equal(restoredManager.response.status, 200, restoredManager.text);
  manager = restoredManager.data.role;
  const reservedManagerGrant = await request(`/api/admin/roles/${manager.id}/permissions`, {
    method: 'PUT',
    body: {
      permissionKeys: [...manager.permissionKeys, 'roles.manage'],
      expectedVersion: manager.version,
      expectedActiveAssignedUserCount: manager.activeAssignedUserCount,
    },
  });
  assert.equal(reservedManagerGrant.response.status, 400, reservedManagerGrant.text);
  assert.equal(reservedManagerGrant.data.code, 'RESERVED_PERMISSION');

  const changedManagerPermissions = await request(`/api/admin/roles/${manager.id}/permissions`, {
    method: 'PUT',
    body: {
      permissionKeys: [...manager.permissionKeys, 'corrections.claim'],
      expectedVersion: manager.version,
      expectedActiveAssignedUserCount: manager.activeAssignedUserCount,
    },
  });
  assert.equal(changedManagerPermissions.response.status, 200, changedManagerPermissions.text);
  assert.equal(changedManagerPermissions.data.role.permissionKeys.includes('corrections.claim'), true);
  manager = changedManagerPermissions.data.role;
  const restoredManagerPermissions = await request(`/api/admin/roles/${manager.id}/permissions`, {
    method: 'PUT',
    body: {
      permissionKeys: managerOriginal.permissionKeys,
      expectedVersion: manager.version,
      expectedActiveAssignedUserCount: manager.activeAssignedUserCount,
    },
  });
  assert.equal(restoredManagerPermissions.response.status, 200, restoredManagerPermissions.text);

  const reservedCreate = await request('/api/admin/roles', {
    method: 'POST',
    body: {
      displayName: 'Forbidden security role',
      description: 'Must fail',
      permissionKeys: ['products.view', 'users.manage'],
    },
  });
  assert.equal(reservedCreate.response.status, 400, reservedCreate.text);
  assert.equal(reservedCreate.data.code, 'RESERVED_PERMISSION');

  const created = await request('/api/admin/roles', {
    method: 'POST',
    body: {
      displayName: 'Custom live access',
      description: 'Integration custom role',
      permissionKeys: ['products.view', 'products.decode'],
    },
    headers: { 'X-Request-ID': 'role-created' },
  });
  assert.equal(created.response.status, 201, created.text);
  let customRole = created.data.role;
  assert.equal(customRole.isSystem, false);
  assert.equal(customRole.isProtected, false);

  const duplicateName = await request('/api/admin/roles', {
    method: 'POST',
    body: {
      displayName: '  CUSTOM LIVE ACCESS  ',
      description: 'Case-insensitive duplicate',
      permissionKeys: [],
    },
  });
  assert.equal(duplicateName.response.status, 409, duplicateName.text);
  assert.equal(duplicateName.data.code, 'ROLE_DISPLAY_NAME_CONFLICT');

  const liveSession = await authenticateIdentitySession({
    subject: 'custom-role-live-permissions',
    preferredUsername: 'custom.role.live',
    displayName: 'Custom Role Live',
  });
  const approved = await request(`/api/admin/users/${liveSession.applicationUser.id}/approve`, {
    method: 'POST',
    body: { roleId: customRole.id },
  });
  assert.equal(approved.response.status, 200, approved.text);
  assert.equal((await request('/api/config', { authentication: liveSession })).response.status, 200);

  const permissionChange = await request(`/api/admin/roles/${customRole.id}/permissions`, {
    method: 'PUT',
    body: {
      permissionKeys: ['products.decode'],
      expectedVersion: customRole.version,
      expectedActiveAssignedUserCount: 1,
    },
    headers: { 'X-Request-ID': 'role-permissions-changed' },
  });
  assert.equal(permissionChange.response.status, 200, permissionChange.text);
  customRole = permissionChange.data.role;
  const permissionRevoked = await request('/api/config', { authentication: liveSession });
  assert.equal(permissionRevoked.response.status, 403, permissionRevoked.text);
  assert.equal(permissionRevoked.data.requiredPermission, 'products.view');

  const assignedDeactivation = await request(`/api/admin/roles/${customRole.id}/deactivate`, {
    method: 'POST', body: { expectedVersion: customRole.version },
  });
  assert.equal(assignedDeactivation.response.status, 409, assignedDeactivation.text);
  assert.equal(assignedDeactivation.data.code, 'ROLE_HAS_CURRENT_ASSIGNMENTS');
  const disabledUser = await request(`/api/admin/users/${liveSession.applicationUser.id}/disable`, {
    method: 'POST', body: {},
  });
  assert.equal(disabledUser.response.status, 200, disabledUser.text);
  const disabledAssignedDeactivation = await request(`/api/admin/roles/${customRole.id}/deactivate`, {
    method: 'POST', body: { expectedVersion: customRole.version },
  });
  assert.equal(disabledAssignedDeactivation.response.status, 409, disabledAssignedDeactivation.text);

  const reassigned = await request(`/api/admin/users/${liveSession.applicationUser.id}/role`, {
    method: 'PUT',
    body: {
      roleId: await roleIdForKey('storekeeper'),
      expectedAssignmentId: disabledUser.data.user.currentAssignmentId,
    },
  });
  assert.equal(reassigned.response.status, 200, reassigned.text);
  const deactivated = await request(`/api/admin/roles/${customRole.id}/deactivate`, {
    method: 'POST', body: { expectedVersion: customRole.version },
    headers: { 'X-Request-ID': 'role-deactivated' },
  });
  assert.equal(deactivated.response.status, 200, deactivated.text);
  const reactivated = await request(`/api/admin/roles/${customRole.id}/reactivate`, {
    method: 'POST', body: { expectedVersion: deactivated.data.role.version },
    headers: { 'X-Request-ID': 'role-reactivated' },
  });
  assert.equal(reactivated.response.status, 200, reactivated.text);
  customRole = reactivated.data.role;

  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_test_role_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced role audit failure';
    END;
    $$;
    CREATE TRIGGER fail_test_role_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION fail_test_role_audit();
  `);
  const failedUpdate = await request(`/api/admin/roles/${customRole.id}`, {
    method: 'PATCH',
    body: {
      displayName: 'Must roll back',
      description: customRole.description,
      expectedVersion: customRole.version,
    },
  });
  assert.equal(failedUpdate.response.status, 500, failedUpdate.text);
  await pool.query('DROP TRIGGER fail_test_role_audit ON audit_events');
  const afterFailedUpdate = await pool.query(
    'SELECT display_name, version FROM roles WHERE id = $1',
    [customRole.id]
  );
  assert.deepEqual(afterFailedUpdate.rows, [{
    display_name: customRole.displayName,
    version: String(customRole.version),
  }]);

  const roleAudit = await pool.query(
    `SELECT event_key, request_id, details
     FROM audit_events WHERE subject_type = 'role' AND subject_id = $1
     ORDER BY id`,
    [String(customRole.id)]
  );
  assert.deepEqual(roleAudit.rows.map((row) => row.event_key), [
    'role.created',
    'role.permissions_changed',
    'role.deactivated',
    'role.reactivated',
  ]);
  assert.equal(roleAudit.rows[1].details.removedPermissionKeys[0], 'products.view');
  assert.equal(roleAudit.rows.some((row) => row.request_id === 'role-update-no-op'), false);
});

test('a failed audit insert rolls back the entire user-administration mutation', async () => {
  const databaseName = 'amber_user_admin_audit_rollback_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const auditPool = new Pool({ connectionString: databaseUrl });
  try {
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    const administrator = await resolveOrCreateApplicationUser({
      issuer: 'https://audit-rollback.example/realms/amber',
      sub: 'audit-rollback-administrator',
      preferred_username: 'audit.rollback.admin',
      name: 'Audit Rollback Administrator',
      authenticatedAt: '2026-09-10T10:00:00.000Z',
    }, { databasePool: auditPool });
    await bootstrapAdministrator(administrator.id, { databasePool: auditPool });
    const pending = await resolveOrCreateApplicationUser({
      issuer: 'https://audit-rollback.example/realms/amber',
      sub: 'audit-rollback-pending',
      preferred_username: 'audit.rollback.pending',
      name: 'Audit Rollback Pending',
      authenticatedAt: '2026-09-10T10:01:00.000Z',
    }, { databasePool: auditPool });

    await auditPool.query(`
      CREATE OR REPLACE FUNCTION fail_test_user_admin_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced audit failure';
      END;
      $$;
      CREATE TRIGGER fail_test_user_admin_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_test_user_admin_audit();
    `);

    await assert.rejects(
      approveApplicationUser(pending.id, await roleIdForKey('manager', auditPool), {
        actorUserId: administrator.id,
        requestId: 'audit-rollback-request',
        databasePool: auditPool,
      }),
      /forced audit failure/
    );
    const state = await auditPool.query(
      `SELECT u.status,
              (SELECT count(*)::int FROM user_role_assignments a
               WHERE a.application_user_id = u.id) AS assignment_count,
              (SELECT count(*)::int FROM audit_events e
               WHERE e.subject_type = 'application_user' AND e.subject_id = u.id::text)
                AS audit_count
       FROM application_users u
       WHERE u.id = $1`,
      [pending.id]
    );
    assert.deepEqual(state.rows, [{
      status: 'pending',
      assignment_count: 0,
      audit_count: 0,
    }]);
  } finally {
    await auditPool.end();
    await dropTestDatabase(databaseName);
  }
});

test('last-Administrator protection is transactional and concurrency-safe', async () => {
  const databaseName = 'amber_user_admin_safety_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const safetyPool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await runNodeInDatabase(databaseUrl, `
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations().catch((error) => { console.error(error); process.exit(1); });
    `);
    const first = await resolveOrCreateApplicationUser({
      issuer: 'https://user-admin-safety.example/realms/amber',
      sub: 'first-administrator',
      preferred_username: 'first.administrator',
      authenticatedAt: '2026-09-09T10:00:00.000Z',
    }, { databasePool: safetyPool });
    await bootstrapAdministrator(first.id, { databasePool: safetyPool });
    const administratorRoleId = await roleIdForKey('administrator', safetyPool);
    const managerRoleId = await roleIdForKey('manager', safetyPool);
    const storekeeperRoleId = await roleIdForKey('storekeeper', safetyPool);
    const firstAssignmentId = await currentAssignmentIdForUser(first.id, safetyPool);

    for (const operation of [
      () => disableApplicationUser(first.id, {
        actorUserId: first.id, databasePool: safetyPool,
      }),
      () => changeApplicationUserRole(first.id, managerRoleId, {
        actorUserId: first.id, databasePool: safetyPool,
        expectedAssignmentId: firstAssignmentId,
      }),
      () => changeApplicationUserRole(first.id, storekeeperRoleId, {
        actorUserId: first.id, databasePool: safetyPool,
        expectedAssignmentId: firstAssignmentId,
      }),
    ]) {
      await assert.rejects(operation, (error) => (
        error.statusCode === 409 && error.code === 'LAST_ADMINISTRATOR_REQUIRED'
      ));
      const unchanged = await safetyPool.query(
        `SELECT u.status, r.role_key
         FROM application_users u
         JOIN user_role_assignments a
           ON a.application_user_id = u.id AND a.revoked_at IS NULL
         JOIN roles r ON r.id = a.role_id
         WHERE u.id = $1`,
        [first.id]
      );
      assert.deepEqual(unchanged.rows, [{ status: 'active', role_key: 'administrator' }]);
    }

    const second = await resolveOrCreateApplicationUser({
      issuer: 'https://user-admin-safety.example/realms/amber',
      sub: 'second-administrator',
      preferred_username: 'second.administrator',
      authenticatedAt: '2026-09-09T10:01:00.000Z',
    }, { databasePool: safetyPool });
    await approveApplicationUser(second.id, administratorRoleId, {
      actorUserId: first.id, databasePool: safetyPool,
    });

    const selfDemoted = await changeApplicationUserRole(first.id, managerRoleId, {
      actorUserId: first.id, databasePool: safetyPool,
      expectedAssignmentId: firstAssignmentId,
    });
    assert.equal(selfDemoted.role.key, 'manager');
    await changeApplicationUserRole(first.id, administratorRoleId, {
      actorUserId: second.id, databasePool: safetyPool,
      expectedAssignmentId: selfDemoted.currentAssignmentId,
    });
    const selfDisabled = await disableApplicationUser(second.id, {
      actorUserId: second.id, databasePool: safetyPool,
    });
    assert.equal(selfDisabled.status, 'disabled');
    await enableApplicationUser(second.id, undefined, {
      actorUserId: first.id, databasePool: safetyPool,
    });

    const assignmentRaceUser = await resolveOrCreateApplicationUser({
      issuer: 'https://user-admin-safety.example/realms/amber',
      sub: 'assignment-race-user',
      preferred_username: 'assignment.race',
      authenticatedAt: '2026-09-09T10:02:00.000Z',
    }, { databasePool: safetyPool });
    await approveApplicationUser(assignmentRaceUser.id, managerRoleId, {
      actorUserId: first.id, databasePool: safetyPool,
    });
    const assignmentRaceExpected = await currentAssignmentIdForUser(
      assignmentRaceUser.id,
      safetyPool
    );
    const assignmentRace = await Promise.allSettled([
      changeApplicationUserRole(assignmentRaceUser.id, storekeeperRoleId, {
        actorUserId: first.id,
        databasePool: safetyPool,
        expectedAssignmentId: assignmentRaceExpected,
      }),
      changeApplicationUserRole(assignmentRaceUser.id, administratorRoleId, {
        actorUserId: first.id,
        databasePool: safetyPool,
        expectedAssignmentId: assignmentRaceExpected,
      }),
    ]);
    assert.deepEqual(
      assignmentRace.map((result) => result.status).sort(),
      ['fulfilled', 'rejected']
    );
    assert.equal(
      assignmentRace.find((result) => result.status === 'rejected').reason.code,
      'APPLICATION_USER_ASSIGNMENT_CONFLICT'
    );
    assert.equal(Number((await safetyPool.query(
      `SELECT COUNT(*) FROM user_role_assignments
       WHERE application_user_id = $1 AND revoked_at IS NULL`,
      [assignmentRaceUser.id]
    )).rows[0].count), 1);
    const raceWinner = assignmentRace.find((result) => result.status === 'fulfilled').value;
    if (raceWinner.role.key === 'administrator') {
      await changeApplicationUserRole(assignmentRaceUser.id, managerRoleId, {
        actorUserId: first.id,
        databasePool: safetyPool,
        expectedAssignmentId: raceWinner.currentAssignmentId,
      });
    }

    await safetyPool.query(`
      CREATE OR REPLACE FUNCTION delay_test_application_user_disable()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.2);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER delay_test_application_user_disable
      BEFORE UPDATE OF status ON application_users
      FOR EACH ROW
      WHEN (OLD.status = 'active' AND NEW.status = 'disabled')
      EXECUTE FUNCTION delay_test_application_user_disable();
    `);
    const concurrent = await Promise.allSettled([
      disableApplicationUser(first.id, {
        actorUserId: first.id, databasePool: safetyPool,
      }),
      disableApplicationUser(second.id, {
        actorUserId: second.id, databasePool: safetyPool,
      }),
    ]);
    assert.deepEqual(
      concurrent.map((result) => result.status).sort(),
      ['fulfilled', 'rejected']
    );
    const conflict = concurrent.find((result) => result.status === 'rejected').reason;
    assert.equal(conflict.code, 'LAST_ADMINISTRATOR_REQUIRED');
    const activeAdministrators = await safetyPool.query(
      `SELECT u.id
       FROM application_users u
       JOIN user_role_assignments a
         ON a.application_user_id = u.id AND a.revoked_at IS NULL
       JOIN roles r ON r.id = a.role_id
       WHERE u.status = 'active'
         AND r.role_key = 'administrator'
         AND r.is_system = TRUE
         AND r.status = 'active'`
    );
    assert.equal(activeAdministrators.rows.length, 1);
    const safetyState = await safetyPool.query(
      `SELECT u.status, r.role_key, a.revoked_at
       FROM application_users u
       JOIN user_role_assignments a
         ON a.application_user_id = u.id AND a.revoked_at IS NULL
       JOIN roles r ON r.id = a.role_id
       WHERE u.id = ANY($1::bigint[])
       ORDER BY u.id`,
      [[first.id, second.id]]
    );
    assert.equal(safetyState.rows.length, 2);
    assert.equal(safetyState.rows.filter((row) => row.status === 'active').length, 1);
    assert.equal(safetyState.rows.every((row) => row.role_key === 'administrator'), true);
  } finally {
    await safetyPool.end();
    await dropTestDatabase(databaseName);
  }
});

function sqliteRun(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
}

test('global audit viewer enforces audit.view and returns safe deterministic filtered pages', async () => {
  const suffix = Date.now();
  const adminIdentity = {
    issuer: 'https://audit-viewer.example/realms/amber',
    subject: `audit-admin-${suffix}`,
    preferredUsername: 'audit.admin.current',
    displayName: 'Current Audit Admin',
  };
  const adminSession = await authenticateIdentitySession(adminIdentity);
  const actorUserId = await activateApplicationUserForTest(
    adminIdentity.issuer, adminIdentity.subject, 'administrator'
  );
  const managerIdentity = {
    issuer: adminIdentity.issuer,
    subject: `audit-manager-${suffix}`,
    preferredUsername: 'audit.manager',
    displayName: 'Audit Manager',
  };
  const managerSession = await authenticateIdentitySession(managerIdentity);
  await activateApplicationUserForTest(managerIdentity.issuer, managerIdentity.subject, 'manager');
  const pendingSession = await authenticateIdentitySession({
    issuer: adminIdentity.issuer,
    subject: `audit-pending-${suffix}`,
    preferredUsername: 'audit.pending',
    displayName: 'Audit Pending',
  });
  const disabledIdentity = {
    issuer: adminIdentity.issuer,
    subject: `audit-disabled-${suffix}`,
    preferredUsername: 'audit.disabled',
    displayName: 'Audit Disabled',
  };
  const disabledSession = await authenticateIdentitySession(disabledIdentity);
  const disabledUserId = await activateApplicationUserForTest(
    disabledIdentity.issuer, disabledIdentity.subject, 'manager'
  );
  await pool.query(
    `UPDATE application_users SET status = 'disabled', deactivated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [disabledUserId]
  );

  assert.equal((await request('/api/admin/audit-events', { authentication: null })).response.status, 401);
  assert.equal((await request('/api/admin/audit-events', { authentication: pendingSession })).data.code, 'APP_ACCESS_PENDING');
  assert.equal((await request('/api/admin/audit-events', { authentication: disabledSession })).data.code, 'APP_ACCESS_DISABLED');
  const denied = await request('/api/admin/audit-events', { authentication: managerSession });
  assert.equal(denied.response.status, 403, denied.text);
  assert.equal(denied.data.code, 'INSUFFICIENT_PERMISSION');

  const occurredAt = '2099-01-01T12:00:00.000Z';
  const fixtures = [
    ['application_user.role_changed', 'application_user', '501', { previousRole: { displayName: 'Manager' }, newRole: { displayName: 'Storekeeper' } }],
    ['role.permissions_changed', 'role', '502', { addedPermissionKeys: ['products.view'], removedPermissionKeys: ['pricing.view'] }],
    ['catalog.category.updated', 'catalog_category', 'AU', { code: 'AU', changes: { name: { before: 'Old', after: 'New' } } }],
    ['pricing.matrix_cell.set', 'pricing_matrix_cell', '9:1:0', { categoryCode: 'AU', oldPrice: 10.25, newPrice: 11.5 }],
    ['product.created', 'product', '503', { fullSku: 'AU-EXACT-503', requestId: 'never-return', sessionData: 'never-return' }],
    ['product.recounted', 'product', '504', { sourceSku: 'AU-OLD', correctedSku: 'AU-NEW', correctionRequestId: 600 }],
    ['product.archived', 'product', '509', { fullSku: 'AU-ARCHIVED-509' }],
    ['correction_request.force_released', 'correction_request', '505', { previousOwnerUserId: 77, claimToken: 'never-return', claimVersion: 4 }],
    ['repricing.applied', 'repricing_batch', '506', { draftId: 700 }],
    ['repricing.rolled_back', 'repricing_batch', '510', {}],
    ['export_snapshot.created', 'export_snapshot', '511', { fromSku: 'AU-1', toSku: 'AU-9', rowCount: 9 }],
    ['export_snapshot.confirmed', 'export_snapshot', '507', { exportedToProductId: 503 }],
    ['sku_schema.published', 'sku_schema_version', '508', { categoryCode: 'AU', version: 3 }],
    ['future_domain.future_action', 'future_subject', 'future-id', { name: 'not-allowlisted-for-unknown-events' }],
  ];
  for (const [eventKey, subjectType, subjectId, details] of fixtures) {
    await pool.query(
      `INSERT INTO audit_events
       (event_key, actor_user_id, actor_snapshot, subject_type, subject_id, details, occurred_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7::timestamptz)`,
      [eventKey, actorUserId, JSON.stringify({
        displayName: eventKey === 'future_domain.future_action' ? null : 'Historical Audit Admin',
        preferredUsername: eventKey === 'future_domain.future_action' ? null : 'audit.admin.historical',
      }), subjectType, subjectId, JSON.stringify(details), occurredAt]
    );
  }
  await pool.query(
    `UPDATE application_users
     SET display_name = 'Mutated Current Name', preferred_username = 'mutated.current'
     WHERE id = $1`,
    [actorUserId]
  );

  const baseQuery = 'from=2099-01-01T00%3A00%3A00Z&to=2099-01-02T00%3A00%3A00Z';
  const first = await request(`/api/admin/audit-events?${baseQuery}&limit=4`, { authentication: adminSession });
  assert.equal(first.response.status, 200, first.text);
  assert.equal(first.data.items.length, 4);
  assert.equal(first.data.page.hasMore, true);
  assert.ok(first.data.page.nextCursor);
  const allItems = [...first.data.items];
  let currentPage = first.data.page;
  while (currentPage.hasMore) {
    const next = await request(
      `/api/admin/audit-events?${baseQuery}&limit=4&cursor=${encodeURIComponent(currentPage.nextCursor)}`,
      { authentication: adminSession }
    );
    assert.equal(next.response.status, 200, next.text);
    allItems.push(...next.data.items);
    currentPage = next.data.page;
  }
  assert.equal(allItems.length, fixtures.length);
  assert.equal(new Set(allItems.map((event) => `${event.eventKey}:${event.subject.id}`)).size, fixtures.length);
  assert.equal(allItems.every((event) => !Object.hasOwn(event, 'id')), true);
  assert.equal(allItems.every((event) => event.actor.displayName !== 'Mutated Current Name'), true);
  assert.equal(allItems.find((event) => event.eventKey === 'product.created').actor.displayName, 'Historical Audit Admin');
  assert.equal(allItems.find((event) => event.eventKey === 'future_domain.future_action').actor.status, 'recorded_reference');
  assert.deepEqual(allItems.find((event) => event.eventKey === 'future_domain.future_action').details, {});
  assert.deepEqual(allItems.find((event) => event.eventKey === 'product.created').details, { fullSku: 'AU-EXACT-503' });
  assert.doesNotMatch(JSON.stringify(allItems), /never-return|requestId|claimToken|sessionData|draftId|claimVersion/);

  const catalog = await request(`/api/admin/audit-events?${baseQuery}&domain=catalog`, { authentication: adminSession });
  assert.deepEqual(catalog.data.items.map((event) => event.eventKey), ['catalog.category.updated']);
  const actor = await request(`/api/admin/audit-events?${baseQuery}&actorId=${actorUserId}`, { authentication: adminSession });
  assert.equal(actor.data.items.length, fixtures.length);
  const subject = await request(`/api/admin/audit-events?${baseQuery}&subjectType=product&subjectId=503`, { authentication: adminSession });
  assert.deepEqual(subject.data.items.map((event) => event.eventKey), ['product.created']);
  const exact = await request(`/api/admin/audit-events?${baseQuery}&eventKey=sku_schema.published`, { authentication: adminSession });
  assert.deepEqual(exact.data.items[0].details, { categoryCode: 'AU', version: 3 });

  const reusedCursor = await request(
    `/api/admin/audit-events?${baseQuery}&domain=role&cursor=${encodeURIComponent(first.data.page.nextCursor)}`,
    { authentication: adminSession }
  );
  assert.equal(reusedCursor.response.status, 400);
  assert.equal(reusedCursor.data.code, 'INVALID_CURSOR');
});

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
