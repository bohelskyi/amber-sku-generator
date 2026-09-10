const suite = require('./suite-context');
const {
  assert,
  test,
  pool,
  createApp,
  express,
  createSessionMiddleware,
  createAuthRouter,
  resolveOrCreateApplicationUser,
  logger,
  request,
  authenticateApplicationSession,
} = suite;

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
  suite.authenticatedSession = await authenticateApplicationSession('/admin');

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
    assert.equal(mutationLog.context.actorId, suite.authenticatedSession.applicationUser.id);
    assert.equal(entries.some((entry) => entry.event === 'audit.mutation'), false);
  } finally {
    logger.info = originalInfo;
  }
});
