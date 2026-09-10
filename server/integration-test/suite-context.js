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

function sqliteRun(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));
}

module.exports = {
  assert,
  crypto,
  fs,
  os,
  path,
  test,
  sqlite3,
  Pool,
  TEST_DATABASE_URL,
  createApp,
  pool,
  serverRoot,
  execFileAsync,
  runNodeInDatabase,
  recreateTestDatabase,
  dropTestDatabase,
  express,
  createSessionMiddleware,
  createAuthRouter,
  getApplicationAccess,
  resolveOrCreateApplicationUser,
  bootstrapAdministrator,
  runMigrations,
  saveLastKnownRate,
  logger,
  approveApplicationUser,
  changeApplicationUserRole,
  disableApplicationUser,
  enableApplicationUser,
  integrationAuthCalls,
  integrationOidcAdapter,
  request,
  activateApplicationUserForTest,
  replaceActiveRoleForTest,
  roleIdForKey,
  currentAssignmentIdForUser,
  authenticateApplicationSession,
  authenticateIdentitySession,
  schemas,
  sqliteRun,
  get authenticatedSession() { return authenticatedSession; },
  set authenticatedSession(value) { authenticatedSession = value; },
  get primarySku() { return primarySku; },
  set primarySku(value) { primarySku = value; },
};
