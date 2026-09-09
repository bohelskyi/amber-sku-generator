const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const express = require('express');
const expressSession = require('express-session');

const { createSessionMiddleware } = require('../src/auth/session');
const {
  normalizeIdentity,
  requireAuthenticatedSession,
} = require('../src/auth/authentication');
const {
  OIDC_TRANSACTION_TTL_MS,
  createAuthRouter,
  normalizeReturnTo,
} = require('../src/routes/auth.routes');
const { getRequestLogPath } = require('../src/utils/request-log-path');
const logger = require('../src/utils/logger');

const issuer = 'https://auth.example.invalid/realms/amber';
const redirectUri = 'http://localhost:5000/api/auth/callback';

function createFakeAdapter(overrides = {}) {
  const calls = { authorization: [], exchange: [], logout: 0 };
  const adapter = {
    issuer,
    redirectUri,
    async buildAuthorizationRedirect(transaction) {
      calls.authorization.push({ ...transaction });
      const challenge = crypto.createHash('sha256')
        .update(transaction.codeVerifier)
        .digest('base64url');
      const url = new URL('https://auth.example.invalid/authorize');
      url.search = new URLSearchParams({
        response_type: 'code',
        scope: 'openid profile email',
        state: transaction.state,
        nonce: transaction.nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      return url;
    },
    async exchangeAuthorizationCode(parameters) {
      calls.exchange.push(parameters);
      return {
        iss: issuer,
        sub: 'directory-subject-123',
        preferred_username: 'amber.user',
        name: 'Amber User',
        given_name: 'Amber',
        family_name: 'User',
        email: 'amber.user@example.invalid',
        access_token: 'not-an-identity-claim',
        refresh_token: 'not-an-identity-claim',
        id_token: 'not-an-identity-claim',
        groups: ['must-not-be-exposed'],
      };
    },
    async buildLogoutRedirect() {
      calls.logout += 1;
      return new URL(
        'https://auth.example.invalid/logout?client_id=amber-sku-manager&post_logout_redirect_uri=https%3A%2F%2Fapp.example.invalid%2F'
      );
    },
    ...overrides,
  };
  return { adapter, calls };
}

async function startAuthServer({
  adapter,
  now,
  secure = false,
  trustProxy = false,
  store = new expressSession.MemoryStore(),
} = {}) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(createSessionMiddleware({
    config: {
      secret: '0123456789abcdef0123456789abcdef',
      maxAgeMs: 8 * 60 * 60 * 1000,
      secure,
    },
    store,
  }));
  app.use('/api/auth', createAuthRouter({
    oidcAdapter: adapter,
    now,
    sessionCookieSecure: secure,
    applicationBaseUrl: 'https://app.example.invalid/',
  }));
  app.get('/api/test-protected', requireAuthenticatedSession, (req, res) => {
    res.json({ issuer: req.user.issuer, sub: req.user.sub });
  });
  app.get('/api/business-still-public', (_req, res) => res.json({ public: true }));

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    store,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0];
}

async function authFetch(server, path, { cookie, headers = {}, method = 'GET' } = {}) {
  return fetch(`${server.baseUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
  });
}

async function login(server, calls, returnTo = '/') {
  const response = await authFetch(
    server,
    `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`
  );
  return {
    response,
    cookie: cookieFrom(response),
    transaction: calls.authorization.at(-1),
  };
}

test('returnTo accepts same-origin paths and rejects open-redirect forms', () => {
  assert.equal(normalizeReturnTo('/'), '/');
  assert.equal(normalizeReturnTo('/admin/repricing?from=login#review'), '/admin/repricing?from=login#review');
  for (const unsafe of [
    'https://evil.example/',
    '//evil.example/path',
    '/\\evil.example/path',
    '\\evil.example/path',
    '/%5cevil.example/path',
    '/%255cevil.example/path',
    '/%2f%2fevil.example/path',
    '/%0d%0aLocation:%20https://evil.example/',
    'javascript:alert(1)',
    ' admin',
  ]) {
    assert.equal(normalizeReturnTo(unsafe), '/', unsafe);
  }
});

test('login persists random state, nonce, and PKCE S256 transaction before redirect', async () => {
  const { adapter, calls } = createFakeAdapter();
  const server = await startAuthServer({ adapter });
  try {
    const result = await login(server, calls, '/admin');
    assert.equal(result.response.status, 302);
    assert.ok(result.cookie);
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.equal(result.transaction.returnTo, '/admin');
    assert.equal(result.transaction.state.length, 43);
    assert.equal(result.transaction.nonce.length, 43);
    assert.equal(result.transaction.codeVerifier.length, 86);
    assert.notEqual(result.transaction.state, result.transaction.nonce);

    const redirect = new URL(result.response.headers.get('location'));
    assert.equal(redirect.searchParams.get('response_type'), 'code');
    assert.equal(redirect.searchParams.get('scope'), 'openid profile email');
    assert.equal(redirect.searchParams.get('state'), result.transaction.state);
    assert.equal(redirect.searchParams.get('nonce'), result.transaction.nonce);
    assert.equal(redirect.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(
      redirect.searchParams.get('code_challenge'),
      crypto.createHash('sha256').update(result.transaction.codeVerifier).digest('base64url')
    );

    const storedSessions = await new Promise((resolve, reject) => {
      server.store.all((error, sessions) => (error ? reject(error) : resolve(sessions)));
    });
    assert.equal(Object.values(storedSessions).some(
      (session) => session.oidcTransaction?.state === result.transaction.state
    ), true);
  } finally {
    await server.close();
  }
});

test('callback regenerates the session and exposes only normalized identity plus CSRF', async () => {
  const { adapter, calls } = createFakeAdapter();
  const server = await startAuthServer({ adapter });
  try {
    const started = await login(server, calls, '/admin/repricing');
    const callback = await authFetch(
      server,
      `/api/auth/callback?code=authorization-code&state=${started.transaction.state}`,
      { cookie: started.cookie }
    );
    const authenticatedCookie = cookieFrom(callback);
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), 'https://app.example.invalid/admin/repricing');
    assert.equal(callback.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(authenticatedCookie);
    assert.notEqual(authenticatedCookie, started.cookie);
    assert.equal(calls.exchange.length, 1);
    assert.equal(calls.exchange[0].state, started.transaction.state);
    assert.equal(calls.exchange[0].nonce, started.transaction.nonce);
    assert.equal(calls.exchange[0].codeVerifier, started.transaction.codeVerifier);
    assert.equal(calls.exchange[0].callbackUrl.origin, 'http://localhost:5000');
    assert.equal(calls.exchange[0].callbackUrl.pathname, '/api/auth/callback');

    const me = await authFetch(server, '/api/auth/me', { cookie: authenticatedCookie });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get('cache-control'), 'no-store');
    const body = await me.json();
    assert.deepEqual(Object.keys(body.identity).sort(), [
      'authenticatedAt',
      'email',
      'family_name',
      'given_name',
      'issuer',
      'name',
      'preferred_username',
      'sub',
    ]);
    assert.equal(body.identity.issuer, issuer);
    assert.equal(body.identity.sub, 'directory-subject-123');
    assert.equal(typeof body.csrfToken, 'string');
    assert.equal(body.csrfToken.length, 43);
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /access_token|refresh_token|id_token|server-only|groups/);

    const protectedResponse = await authFetch(server, '/api/test-protected', {
      cookie: authenticatedCookie,
    });
    assert.deepEqual(await protectedResponse.json(), {
      issuer,
      sub: 'directory-subject-123',
    });
    const publicResponse = await authFetch(server, '/api/business-still-public');
    assert.equal(publicResponse.status, 200);
    assert.deepEqual(await publicResponse.json(), { public: true });

    const replay = await authFetch(
      server,
      `/api/auth/callback?code=authorization-code&state=${started.transaction.state}`,
      { cookie: authenticatedCookie }
    );
    assert.equal(replay.status, 400);
    assert.equal(calls.exchange.length, 1);
  } finally {
    await server.close();
  }
});

test('callback rejects missing, mismatched, expired, and provider-error transactions', async () => {
  let clock = 1_800_000_000_000;
  const { adapter, calls } = createFakeAdapter();
  const server = await startAuthServer({ adapter, now: () => clock });
  try {
    let started = await login(server, calls);
    let response = await authFetch(server, '/api/auth/callback?code=code', {
      cookie: started.cookie,
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');

    started = await login(server, calls);
    response = await authFetch(server, '/api/auth/callback?code=code&state=wrong-state', {
      cookie: started.cookie,
    });
    assert.equal(response.status, 400);

    started = await login(server, calls);
    clock += OIDC_TRANSACTION_TTL_MS + 1;
    response = await authFetch(
      server,
      `/api/auth/callback?code=code&state=${started.transaction.state}`,
      { cookie: started.cookie }
    );
    assert.equal(response.status, 400);

    started = await login(server, calls);
    response = await authFetch(
      server,
      `/api/auth/callback?error=access_denied&error_description=private-provider-detail&state=${started.transaction.state}`,
      { cookie: started.cookie }
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Authentication failed' });
    assert.equal(calls.exchange.length, 0);
  } finally {
    await server.close();
  }
});

test('callback rejects identity without sub and does not create an authenticated session', async () => {
  const { adapter, calls } = createFakeAdapter({
    exchangeAuthorizationCode: async () => ({ iss: issuer, name: 'Missing Subject' }),
  });
  const server = await startAuthServer({ adapter });
  try {
    const started = await login(server, calls);
    const response = await authFetch(
      server,
      `/api/auth/callback?code=code&state=${started.transaction.state}`,
      { cookie: started.cookie }
    );
    assert.equal(response.status, 400);
    const me = await authFetch(server, '/api/auth/me', { cookie: started.cookie });
    assert.equal(me.status, 401);
  } finally {
    await server.close();
  }
});

test('/me requires authentication and logout requires CSRF, destroys session, and clears cookie', async () => {
  const { adapter, calls } = createFakeAdapter();
  const server = await startAuthServer({ adapter });
  try {
    const anonymousMe = await authFetch(server, '/api/auth/me');
    assert.equal(anonymousMe.status, 401);
    assert.equal(anonymousMe.headers.get('cache-control'), 'no-store');

    const anonymousLogout = await authFetch(server, '/api/auth/logout', { method: 'POST' });
    assert.equal(anonymousLogout.status, 401);

    const started = await login(server, calls);
    const callback = await authFetch(
      server,
      `/api/auth/callback?code=code&state=${started.transaction.state}`,
      { cookie: started.cookie }
    );
    const authenticatedCookie = cookieFrom(callback);
    const me = await authFetch(server, '/api/auth/me', { cookie: authenticatedCookie });
    const { csrfToken } = await me.json();

    const noCsrf = await authFetch(server, '/api/auth/logout', {
      method: 'POST',
      cookie: authenticatedCookie,
    });
    assert.equal(noCsrf.status, 403);
    const wrongCsrf = await authFetch(server, '/api/auth/logout', {
      method: 'POST',
      cookie: authenticatedCookie,
      headers: { 'X-CSRF-Token': 'wrong' },
    });
    assert.equal(wrongCsrf.status, 403);

    const logout = await authFetch(
      server,
      '/api/auth/logout?logoutUrl=https%3A%2F%2Fevil.example%2F&returnTo=%2F%2Fevil.example',
      {
        method: 'POST',
        cookie: authenticatedCookie,
        headers: { 'X-CSRF-Token': csrfToken },
      }
    );
    assert.equal(logout.status, 200);
    assert.equal(logout.headers.get('location'), null);
    assert.equal(logout.headers.get('cache-control'), 'no-store');
    assert.equal(calls.logout, 1);
    const logoutBody = await logout.json();
    assert.deepEqual(Object.keys(logoutBody), ['logoutUrl']);
    const logoutLocation = new URL(logoutBody.logoutUrl);
    assert.equal(logoutLocation.origin, 'https://auth.example.invalid');
    assert.equal(logoutLocation.searchParams.get('client_id'), 'amber-sku-manager');
    assert.equal(
      logoutLocation.searchParams.get('post_logout_redirect_uri'),
      'https://app.example.invalid/'
    );
    assert.doesNotMatch(
      JSON.stringify(logoutBody),
      /evil\.example|access_token|refresh_token|id_token|server-only-secret/
    );
    const clearCookie = logout.headers.get('set-cookie');
    assert.match(clearCookie, /^amber\.sid=/);
    assert.match(clearCookie, /Path=\/api/i);
    assert.match(clearCookie, /HttpOnly/i);
    assert.match(clearCookie, /SameSite=Lax/i);
    assert.match(clearCookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i);
    assert.doesNotMatch(clearCookie, /;\s*Domain=/i);

    const afterLogout = await authFetch(server, '/api/auth/me', { cookie: authenticatedCookie });
    assert.equal(afterLogout.status, 401);
  } finally {
    await server.close();
  }
});

test('logout still completes locally when provider logout discovery is unavailable', async () => {
  const { adapter, calls } = createFakeAdapter({
    buildLogoutRedirect: async () => {
      calls.logout += 1;
      throw new Error('provider unavailable');
    },
  });
  const server = await startAuthServer({ adapter });
  try {
    const started = await login(server, calls);
    const callback = await authFetch(
      server,
      `/api/auth/callback?code=code&state=${started.transaction.state}`,
      { cookie: started.cookie }
    );
    const authenticatedCookie = cookieFrom(callback);
    const me = await authFetch(server, '/api/auth/me', { cookie: authenticatedCookie });
    const { csrfToken } = await me.json();

    const logout = await authFetch(server, '/api/auth/logout', {
      method: 'POST',
      cookie: authenticatedCookie,
      headers: { 'X-CSRF-Token': csrfToken },
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { logoutUrl: null });
    assert.match(logout.headers.get('set-cookie'), /^amber\.sid=/);
    assert.equal((await authFetch(server, '/api/auth/me', {
      cookie: authenticatedCookie,
    })).status, 401);
  } finally {
    await server.close();
  }
});

test('proxy-aware production cookies are Secure while local HTTP cookies are not', async () => {
  const productionFake = createFakeAdapter();
  const production = await startAuthServer({
    adapter: productionFake.adapter,
    secure: true,
    trustProxy: 1,
  });
  const localFake = createFakeAdapter();
  const local = await startAuthServer({ adapter: localFake.adapter });
  try {
    const productionLogin = await authFetch(production, '/api/auth/login', {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.match(productionLogin.headers.get('set-cookie'), /;\s*Secure/i);
    const productionTransaction = productionFake.calls.authorization[0];
    const productionCallback = await authFetch(
      production,
      `/api/auth/callback?code=code&state=${productionTransaction.state}`,
      {
        cookie: cookieFrom(productionLogin),
        headers: { 'X-Forwarded-Proto': 'https' },
      }
    );
    assert.match(productionCallback.headers.get('set-cookie'), /;\s*Secure/i);
    const localLogin = await authFetch(local, '/api/auth/login');
    assert.doesNotMatch(localLogin.headers.get('set-cookie'), /;\s*Secure/i);
  } finally {
    await production.close();
    await local.close();
  }
});

test('identity normalization is issuer+sub based and request logs redact callback query strings', () => {
  const identity = normalizeIdentity(
    { iss: issuer, sub: 'immutable-sub', preferred_username: 'mutable-name', extra: 'omit' },
    { expectedIssuer: issuer, authenticatedAt: new Date('2026-01-02T03:04:05.000Z') }
  );
  assert.deepEqual(identity, {
    issuer,
    sub: 'immutable-sub',
    preferred_username: 'mutable-name',
    authenticatedAt: '2026-01-02T03:04:05.000Z',
  });
  assert.equal(
    getRequestLogPath({
      path: '/api/auth/callback',
      originalUrl: '/api/auth/callback?code=private&state=private&error_description=private',
    }),
    '/api/auth/callback'
  );
  assert.equal(
    getRequestLogPath({
      path: '/api/export/snapshots',
      originalUrl: '/api/export/snapshots?fromSku=BR1',
    }),
    '/api/export/snapshots?fromSku=BR1'
  );
});

test('application request logging never records callback query parameters', async () => {
  const app = require('../src/app');
  const entries = [];
  const originalInfo = logger.info;
  logger.info = (event, context) => entries.push({ event, context });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(
      `${baseUrl}/api/auth/callback?code=private-code&state=private-state&error_description=private-error`
    );
    assert.equal(response.status, 400);
    const completion = entries.find((entry) => entry.event === 'http.request.completed');
    assert.ok(completion);
    assert.equal(completion.context.path, '/api/auth/callback');
    assert.doesNotMatch(JSON.stringify(entries), /private-code|private-state|private-error/);
  } finally {
    logger.info = originalInfo;
    await new Promise((resolve) => server.close(resolve));
  }
});
