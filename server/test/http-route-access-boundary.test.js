const test = require('node:test');
const assert = require('node:assert/strict');
const { IncomingMessage, ServerResponse } = require('node:http');
const { Duplex } = require('node:stream');
const { Socket } = require('node:net');
const express = require('express');
const { Pool } = require('pg');

const CSRF_TOKEN = 'route-boundary-test-csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Exact entry points only: a new route, including under /api/auth, is audited.
const PUBLIC_ENTRY_POINTS = new Set([
  // Liveness must work without an application session.
  'GET /health/live',
  // Readiness must work without an application session.
  'GET /health/ready',
  // Password OIDC login establishes the session that business routes require.
  'GET /api/auth/login',
  // Windows OIDC login establishes that same authenticated session.
  'GET /api/auth/login/windows',
  // The OIDC callback validates the transaction before establishing a session.
  'GET /api/auth/callback',
]);
const ACTIVE_ACCESS_EXCEPTIONS = new Set([
  // AUTH_RBAC: pending/disabled users need their own access state and CSRF token.
  'GET /api/auth/me',
  // AUTH_RBAC: pending/disabled users must still be able to end their own session.
  'POST /api/auth/logout',
]);
const IMPLICIT_OPTIONS_EXCEPTIONS = new Map([
  // Express advertises the existing GET handler (and its implicit HEAD); no handler runs.
  ['OPTIONS /api/auth/me', 'GET, HEAD'],
  // Express advertises the existing POST handler; negotiation never performs logout.
  ['OPTIONS /api/auth/logout', 'POST'],
]);

function key(endpoint) {
  return `${endpoint.method} ${endpoint.path}`;
}

function requiresActiveAccess(endpoint) {
  return !PUBLIC_ENTRY_POINTS.has(key(endpoint)) && !ACTIVE_ACCESS_EXCEPTIONS.has(key(endpoint));
}

function isImplicitOptionsException(endpoint, registered) {
  return IMPLICIT_OPTIONS_EXCEPTIONS.has(key(endpoint))
    && !registered.some((candidate) => key(candidate) === key(endpoint));
}

function optionsEndpoints(endpoints) {
  return [...new Set(endpoints.map((endpoint) => endpoint.path))]
    .map((path) => ({ method: 'OPTIONS', path }));
}

function paths(value) {
  const result = Array.isArray(value) ? value.flat(Infinity) : [value];
  for (const path of result) {
    assert.equal(typeof path, 'string', 'Add explicit coverage for non-string route paths');
    assert.match(path, /^\/(?:[a-zA-Z0-9_./-]|:[a-zA-Z0-9_]+)*$/,
      `Add concrete request expansion for route pattern ${path}`);
  }
  return result;
}

function joinPaths(prefix, path) {
  return `${prefix === '/' ? '' : prefix}${path === '/' ? '' : path}` || '/';
}

function inventory(router, mountPaths, prefix = '') {
  assert.ok(Array.isArray(router.stack), 'Expected an actual Express router stack');
  assert.equal(Object.keys(router.params || {}).length, 0,
    'Review parameter middleware before allowing it to run in this no-I/O audit');
  return router.stack.flatMap((layer) => {
    if (layer.route) {
      return paths(layer.route.path).flatMap((path) => Object.keys(layer.route.methods).map((method) => {
        assert.notEqual(method, '_all', 'Expand all-method registrations explicitly');
        return { method: method.toUpperCase(), path: joinPaths(prefix, path), route: layer.route };
      }));
    }
    if (!layer.handle?.stack) return [];
    assert.ok(mountPaths.has(layer), 'Router mount was not observed during app registration');
    return paths(mountPaths.get(layer)).flatMap((path) =>
      inventory(layer.handle, mountPaths, joinPaths(prefix, path)));
  });
}

function collectPermissions(router) {
  return router.stack.flatMap((layer) => {
    if (layer.route) return collectPermissions(layer.route);
    if (layer.handle?.stack) return collectPermissions(layer.handle);
    return layer.handle.permissionKey ? [layer.handle.permissionKey] : (layer.handle.permissionKeys || []);
  });
}

// Real IncomingMessage/ServerResponse objects exercise Express without opening a socket.
async function request(app, endpoint, { actor, csrf, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const incoming = new IncomingMessage(socket);
    incoming.complete = true;
    incoming.method = endpoint.method;
    incoming.url = endpoint.path.replace(/:[a-zA-Z0-9_]+/g, '1');
    incoming.headers = { host: 'route-audit.invalid', ...headers,
      ...(actor ? { 'x-audit-actor': actor } : {}),
      ...(csrf === undefined ? {} : { 'x-csrf-token': csrf }),
    };
    // Audit valid requests: malformed/oversized JSON parser precedence is a separate contract.
    // These two real permission middlewares select their permission from body.type.
    const body = SAFE_METHODS.has(endpoint.method) ? undefined : JSON.stringify(
      ['/api/admin/delete-item', '/api/admin/catalog-impact'].includes(endpoint.path)
        ? { type: 'category', id: 1 } : {}
    );
    if (body !== undefined) {
      incoming.headers['content-type'] = 'application/json';
      incoming.headers['content-length'] = String(Buffer.byteLength(body));
    }
    const response = new ServerResponse(incoming);
    response.assignSocket(socket);
    const originalWrite = response.write;
    const originalEnd = response.end;
    response.write = function (chunk, ...args) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return originalWrite.call(this, chunk, ...args);
    };
    response.end = function (chunk, ...args) {
      if (chunk) chunks.push(Buffer.from(chunk));
      return originalEnd.call(this, chunk, ...args);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Request did not terminate: ${key(endpoint)}`));
    }, 3000);
    response.once('error', (error) => { clearTimeout(timer); socket.destroy(); reject(error); });
    response.once('finish', () => {
      clearTimeout(timer);
      resolve({ status: response.statusCode, headers: response.getHeaders(),
        body: Buffer.concat(chunks).toString() });
      socket.destroy();
    });
    if (body !== undefined) incoming.push(Buffer.from(body));
    incoming.push(null);
    app.handle(incoming, response);
  });
}

async function denialFailures(app, endpoints, profile) {
  const failures = [];
  for (const endpoint of endpoints) {
    const response = await request(app, endpoint, profile);
    if (response.status !== profile.status
      || !String(response.headers['content-type']).startsWith('application/json')
      || response.headers.location !== undefined
      || (endpoint.method !== 'HEAD' && response.body !== JSON.stringify(profile.body))) {
      failures.push({ route: key(endpoint), actor: profile.actor || 'anonymous',
        expectedStatus: profile.status, actualStatus: response.status, body: response.body });
    }
  }
  return failures;
}

test('actual app registrations enforce authentication, active access and unsafe-method CSRF', async (t) => {
  const unexpectedIo = [];
  const forbid = (operation) => () => {
    unexpectedIo.push(operation);
    throw new Error(`Route boundary audit forbids ${operation}`);
  };
  t.mock.method(Socket.prototype, 'connect', forbid('network connection'));
  t.mock.method(globalThis, 'fetch', forbid('fetch'));
  t.mock.method(Pool.prototype, 'query', forbid('database query'));
  t.mock.method(Pool.prototype, 'connect', forbid('database connection'));

  // Capture exact mount paths while Express registers them, without decoding private regexes.
  const mountPaths = new WeakMap();
  const originalUse = express.Router.prototype.use;
  t.mock.method(express.Router.prototype, 'use', function (...args) {
    const start = this.stack.length;
    let first = args[0];
    while (Array.isArray(first) && first.length) first = first[0];
    const mountPath = typeof first === 'function' ? '/' : args[0];
    const result = originalUse.apply(this, args);
    for (const layer of this.stack.slice(start)) mountPaths.set(layer, mountPath);
    return result;
  });
  const logger = require('../src/utils/logger');
  for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, () => {});
  // Prevent the module's default app from constructing an unused PostgreSQL session store.
  t.mock.method(require('../src/auth/session'), 'createSessionMiddleware',
    () => (_req, _res, next) => next());
  t.mock.method(require('../src/services/full-product-cutover-gate'), 'readGate',
    async () => ({ phase: 'legacy' }));
  const { requireAuthenticatedSession, requireCsrfForUnsafeMethods, requireCsrfToken } = require('../src/auth/authentication');
  const authorization = require('../src/auth/authorization');
  const activeGuards = new Set();
  const createActiveGuard = authorization.createRequireActiveApplicationUser;
  t.mock.method(authorization, 'createRequireActiveApplicationUser', (...args) => {
    const guard = createActiveGuard(...args);
    activeGuards.add(guard);
    return guard;
  });
  const { createApp } = require('../src/app');
  let permissions = [];
  const effects = { handlers: 0, accessResolutions: 0, sessionSaves: 0,
    sessionDestroys: 0, logoutRedirects: 0 };
  const app = createApp({
    sessionMiddleware: (req, _res, next) => {
      const actor = req.get('x-audit-actor');
      req.session = {
        ...(actor ? { identity: { issuer: 'https://route-audit.invalid', sub: actor,
          authenticatedAt: '2026-10-23T00:00:00Z' } } : {}),
        csrfToken: CSRF_TOKEN,
        save: (callback) => { effects.sessionSaves += 1; callback(); },
        destroy: (callback) => { effects.sessionDestroys += 1; callback(); },
      };
      next();
    },
    applicationUserService: { getOrCreateApplicationAccess: async (identity) => {
      effects.accessResolutions += 1;
      return { applicationUser: { id: 42, status: identity?.sub || 'active' }, roles: [],
        permissions: identity?.sub === 'active' ? permissions : [] };
    } },
    oidcAdapter: { buildLogoutRedirect: async () => { effects.logoutRedirects += 1; return null; },
      buildAuthorizationRedirect: forbid('OIDC login'), exchangeAuthorizationCode: forbid('OIDC callback') },
  });
  permissions = [...new Set(collectPermissions(app.router))];
  const registered = inventory(app.router, mountPaths);
  const protectedEndpoints = registered.filter((endpoint) => !PUBLIC_ENTRY_POINTS.has(key(endpoint)));
  const activeEndpoints = registered.filter(requiresActiveAccess);
  const unsafeEndpoints = protectedEndpoints.filter((endpoint) => !SAFE_METHODS.has(endpoint.method));
  const allOptions = optionsEndpoints(protectedEndpoints);
  const protectedOptions = allOptions.filter((endpoint) => !isImplicitOptionsException(endpoint, registered));
  const sentinels = new Map();
  // Keep every preceding route/global guard in its original location. Replace only the
  // terminal business handler; /me and /logout run their real handlers with fake dependencies.
  for (const endpoint of protectedEndpoints) {
    if (sentinels.has(endpoint.route)) continue;
    const terminal = endpoint.route.stack.at(-1);
    assert.ok(terminal && !terminal.handle.permissionKey && !terminal.handle.permissionKeys,
      `Expected a terminal business handler: ${key(endpoint)}`);
    assert.notEqual(terminal.handle, requireAuthenticatedSession);
    assert.notEqual(terminal.handle, requireCsrfForUnsafeMethods);
    assert.ok(!activeGuards.has(terminal.handle));
    if (ACTIVE_ACCESS_EXCEPTIONS.has(key(endpoint))) {
      const handler = terminal.handle;
      t.mock.method(terminal, 'handle', function (...args) {
        effects.handlers += 1;
        return handler.apply(this, args);
      });
      continue;
    }
    const marker = `route-${sentinels.size}`;
    sentinels.set(endpoint.route, marker);
    t.mock.method(terminal, 'handle', (_req, res) => {
      effects.handlers += 1;
      return res.json({ reached: marker });
    });
  }

  await t.test('inventory includes every actual registration and only the explicit public exceptions', () => {
    assert.equal(new Set(registered.map(key)).size, registered.length, 'Duplicate method/path registrations');
    assert.deepEqual(new Set(registered.filter((endpoint) => PUBLIC_ENTRY_POINTS.has(key(endpoint))).map(key)),
      PUBLIC_ENTRY_POINTS);
    assert.ok(protectedEndpoints.length > 0);
    assert.deepEqual(new Set(protectedEndpoints.filter((endpoint) => !requiresActiveAccess(endpoint)).map(key)),
      ACTIVE_ACCESS_EXCEPTIONS);
    assert.deepEqual(new Set(allOptions.filter((endpoint) => isImplicitOptionsException(endpoint, registered)).map(key)),
      new Set(IMPLICIT_OPTIONS_EXCEPTIONS.keys()));
    t.diagnostic(`${registered.length} registrations; ${protectedEndpoints.length} authenticated; `
      + `${activeEndpoints.length} active-gated; ${unsafeEndpoints.length} unsafe; `
      + `${protectedOptions.length} protected OPTIONS paths; ${allOptions.length - protectedOptions.length} automatic OPTIONS exceptions`);
  });
  const anonymous = { status: 401, body: { error: 'Authentication required' } };
  const profiles = [
    ['anonymous requests return JSON 401 without redirects', anonymous, protectedEndpoints],
    ['pending users cannot reach any route outside the two exact active-state exceptions', { actor: 'pending', csrf: CSRF_TOKEN,
      status: 403, body: authorization.ACCESS_ERROR_BY_STATUS.pending }, activeEndpoints],
    ['disabled users cannot reach any route outside the two exact active-state exceptions', { actor: 'disabled', csrf: CSRF_TOKEN,
      status: 403, body: authorization.ACCESS_ERROR_BY_STATUS.disabled }, activeEndpoints],
    ['unsafe requests require a CSRF token', { actor: 'active', status: 403,
      body: { error: 'Invalid CSRF token' } }, unsafeEndpoints],
    ['unsafe requests reject an incorrect CSRF token', { actor: 'active', csrf: 'incorrect-token',
      status: 403, body: { error: 'Invalid CSRF token' } }, unsafeEndpoints],
  ];
  for (const [name, profile, endpoints] of profiles) {
    await t.test(name, async () => assert.deepEqual(await denialFailures(app, endpoints, profile), []));
  }
  await t.test('implicit HEAD requests to protected GET routes also return JSON 401', async () => {
    const headEndpoints = protectedEndpoints.filter((endpoint) => endpoint.method === 'GET')
      .map((endpoint) => ({ ...endpoint, method: 'HEAD' }));
    assert.deepEqual(await denialFailures(app, headEndpoints, anonymous), []);
  });
  await t.test('only the two implicit session OPTIONS responses advertise methods without running handlers', async () => {
    for (const endpoint of allOptions.filter((candidate) => isImplicitOptionsException(candidate, registered))) {
      for (const actor of [undefined, 'pending', 'disabled', 'active']) {
        const before = { ...effects };
        const response = await request(app, endpoint, { actor, headers: {
          origin: 'https://untrusted.invalid', 'access-control-request-method': 'POST',
          'access-control-request-headers': 'x-csrf-token',
        } });
        const expectedAllow = IMPLICIT_OPTIONS_EXCEPTIONS.get(key(endpoint));
        assert.equal(response.status, 200, key(endpoint));
        assert.equal(response.headers.allow, expectedAllow, key(endpoint));
        assert.equal(response.body, expectedAllow, key(endpoint));
        assert.equal(response.headers['content-type'], 'text/plain', key(endpoint));
        assert.equal(response.headers.location, undefined, key(endpoint));
        assert.equal(response.headers['set-cookie'], undefined, key(endpoint));
        assert.deepEqual(Object.keys(response.headers).filter((header) => header.startsWith('access-control-')), []);
        assert.deepEqual(effects, before, `${key(endpoint)} must not resolve access or run/write through a handler`);
      }
    }
  });
  for (const [name, profile] of profiles.slice(0, 3)) {
    await t.test(`OPTIONS retains the business boundary: ${name}`, async () => {
      assert.deepEqual(await denialFailures(app, protectedOptions, profile), []);
    });
  }
  await t.test('pending and disabled users can read only their own session state and perform CSRF-protected logout', async () => {
    for (const actor of ['pending', 'disabled']) {
      const before = { ...effects };
      const me = await request(app, { method: 'GET', path: '/api/auth/me' }, { actor });
      assert.equal(me.status, 200);
      assert.equal(me.headers['cache-control'], 'no-store');
      assert.deepEqual(JSON.parse(me.body), {
        identity: { issuer: 'https://route-audit.invalid', sub: actor, authenticatedAt: '2026-10-23T00:00:00Z' },
        csrfToken: CSRF_TOKEN, applicationUser: { id: 42, status: actor }, roles: [], permissions: [],
      });
      assert.deepEqual(effects, { ...before, handlers: before.handlers + 1,
        accessResolutions: before.accessResolutions + 1 });
      const logout = await request(app, { method: 'POST', path: '/api/auth/logout' }, { actor, csrf: CSRF_TOKEN });
      assert.equal(logout.status, 200);
      assert.equal(logout.headers['cache-control'], 'no-store');
      assert.deepEqual(JSON.parse(logout.body), { logoutUrl: null });
      const cookies = [logout.headers['set-cookie']].flat();
      assert.equal(cookies.length, 1);
      assert.match(cookies[0], /^amber\.sid=;/);
      assert.match(cookies[0], /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
      assert.deepEqual(effects, { ...before, handlers: before.handlers + 2,
        accessResolutions: before.accessResolutions + 1,
        sessionDestroys: before.sessionDestroys + 1, logoutRedirects: before.logoutRedirects + 1 });
    }
  });
  await t.test('logout still requires authentication and correct CSRF for every access state', async () => {
    const logout = [{ method: 'POST', path: '/api/auth/logout' }];
    const before = { ...effects };
    for (const csrf of [undefined, 'incorrect-token', CSRF_TOKEN]) {
      assert.deepEqual(await denialFailures(app, logout, { ...anonymous, csrf }), []);
    }
    for (const actor of ['pending', 'disabled', 'active']) {
      for (const csrf of [undefined, 'incorrect-token']) {
        assert.deepEqual(await denialFailures(app, logout, { actor, csrf,
          status: 403, body: { error: 'Invalid CSRF token' } }), []);
      }
    }
    assert.deepEqual(effects, before, 'Rejected logout must not run its handler or destroy a session');
  });
  await t.test('active valid requests reach each exact route instead of a 404 or a different handler', async () => {
    for (const endpoint of protectedEndpoints) {
      const response = await request(app, endpoint, { actor: 'active', csrf: CSRF_TOKEN });
      assert.equal(response.status, 200, `${key(endpoint)}: ${response.body}`);
      if (sentinels.has(endpoint.route)) {
        assert.deepEqual(JSON.parse(response.body), { reached: sentinels.get(endpoint.route) }, key(endpoint));
      }
    }
  });
  await t.test('a newly registered route before the boundary is automatically detected', async () => {
    app.get('/api/unguarded-audit-probe', (_req, res) => res.json({ unguarded: true }));
    const layer = app.router.stack.pop();
    app.router.stack.unshift(layer);
    try {
      const added = inventory(app.router, mountPaths).filter((endpoint) => endpoint.route === layer.route);
      assert.equal(added.length, 1);
      assert.equal((await denialFailures(app, added, anonymous)).length, 1);
    } finally { app.router.stack.shift(); }
  });
  await t.test('near-miss paths, auth-prefix routes and wrong methods never inherit an exception', async () => {
    for (const endpoint of [
      { method: 'GET', path: '/api/auth/me-extra' },
      { method: 'POST', path: '/api/auth/logout/extra' },
      { method: 'GET', path: '/api/auth/new-audit-probe' },
      { method: 'POST', path: '/api/auth/me' },
      { method: 'GET', path: '/api/auth/logout' },
      // Implicit HEAD is exercised above, but a new explicit HEAD registration is not a GET exception.
      { method: 'HEAD', path: '/api/auth/me' },
      { method: 'POST', path: '/api/auth/login' },
      { method: 'OPTIONS', path: '/api/auth/me-extra' },
    ]) {
      app[endpoint.method.toLowerCase()](endpoint.path, (_req, res) => res.json({ unguarded: true }));
      const layer = app.router.stack.pop();
      app.router.stack.unshift(layer);
      try {
        const added = inventory(app.router, mountPaths).filter((candidate) => candidate.route === layer.route);
        assert.equal(added.length, 1);
        assert.ok(requiresActiveAccess(added[0]), key(endpoint));
        assert.equal(isImplicitOptionsException(added[0], registered), false, key(endpoint));
        for (const profile of [anonymous, profiles[1][1], profiles[2][1]]) {
          assert.equal((await denialFailures(app, added, profile)).length, 1, key(endpoint));
        }
      } finally { app.router.stack.shift(); }
    }
  });
  await t.test('explicit OPTIONS handlers on either session path cannot use the automatic-negotiation exception', async () => {
    for (const path of ['/api/auth/me', '/api/auth/logout']) {
      app.options(path, (_req, res) => res.json({ unguarded: true }));
      const layer = app.router.stack.pop();
      app.router.stack.unshift(layer);
      try {
        const current = inventory(app.router, mountPaths);
        const added = current.filter((endpoint) => endpoint.route === layer.route);
        assert.equal(added.length, 1);
        assert.ok(requiresActiveAccess(added[0]));
        assert.equal(isImplicitOptionsException(added[0], current), false);
        for (const profile of [anonymous, profiles[1][1], profiles[2][1]]) {
          assert.equal((await denialFailures(app, added, profile)).length, 1);
        }
      } finally { app.router.stack.shift(); }
    }
  });
  const businessProbe = protectedEndpoints.find((endpoint) => endpoint.method === 'POST' && sentinels.has(endpoint.route));
  assert.ok(businessProbe, 'A real unsafe business route is required for mutation controls');
  for (const [name, matches, profile] of [
    ['authentication', (handle) => handle === requireAuthenticatedSession, anonymous],
    ['active access', (handle) => activeGuards.has(handle), profiles[1][1]],
    ['CSRF', (handle) => handle === requireCsrfForUnsafeMethods, profiles[3][1]],
  ]) {
    await t.test(`removing the actual global ${name} guard is detected`, async () => {
      const index = app.router.stack.findIndex((layer) => matches(layer.handle));
      assert.ok(index >= 0, `Actual global ${name} guard must be registered`);
      const [layer] = app.router.stack.splice(index, 1);
      try { assert.equal((await denialFailures(app, [businessProbe], profile)).length, 1); }
      finally { app.router.stack.splice(index, 0, layer); }
    });
  }
  for (const [routeKey, guard, name, profile] of [
    ['GET /api/auth/me', requireAuthenticatedSession, 'authentication', anonymous],
    ['POST /api/auth/logout', requireAuthenticatedSession, 'authentication', { ...anonymous, csrf: CSRF_TOKEN }],
    ...['pending', 'disabled', 'active'].map((actor) => [
      'POST /api/auth/logout', requireCsrfToken, `${actor} CSRF`,
      { actor, status: 403, body: { error: 'Invalid CSRF token' } },
    ]),
  ]) {
    await t.test(`removing local ${name} from ${routeKey} is detected`, async () => {
      const endpoint = registered.find((candidate) => key(candidate) === routeKey);
      const index = endpoint.route.stack.findIndex((layer) => layer.handle === guard);
      assert.ok(index >= 0, `Actual local ${name} guard must be registered`);
      const [layer] = endpoint.route.stack.splice(index, 1);
      try { assert.equal((await denialFailures(app, [endpoint], profile)).length, 1); }
      finally { endpoint.route.stack.splice(index, 0, layer); }
    });
  }
  await t.test('no request attempted database or external network I/O', () => assert.deepEqual(unexpectedIo, []));
});
