const assert = require('node:assert/strict');
const test = require('node:test');

const { createApp } = require('../src/app');
const lifecycleGate = require('../src/services/full-product-cutover-gate');
test.before(()=>test.mock.method(lifecycleGate,'readGate',async()=>({phase:'legacy'})));
test.after(()=>test.mock.restoreAll());

const identityBase = {
  issuer: 'https://auth.example.invalid/realms/amber',
  authenticatedAt: '2026-09-11T08:00:00.000Z',
};

const accessBySubject = {
  active: {
    applicationUser: { id: 10, status: 'active', displayName: 'Active User' },
    roles: [],
    permissions: [],
  },
  pending: {
    applicationUser: { id: 11, status: 'pending', displayName: 'Pending User' },
    roles: [],
    permissions: [],
  },
  disabled: {
    applicationUser: { id: 12, status: 'disabled', displayName: 'Disabled User' },
    roles: [],
    permissions: [],
  },
  viewer: {
    applicationUser: { id: 13, status: 'active', displayName: 'Export Viewer' },
    roles: [{ id: 3, key: 'viewer', displayName: 'Viewer' }],
    permissions: ['exports.view'],
  },
  creator: {
    applicationUser: { id: 14, status: 'active', displayName: 'Product Creator' },
    roles: [],
    permissions: ['products.create'],
  },
  archiver: {
    applicationUser: { id: 15, status: 'active', displayName: 'Product Archiver' },
    roles: [],
    permissions: ['products.archive'],
  },
  repricer: {
    applicationUser: { id: 16, status: 'active', displayName: 'Repricing Preparer' },
    roles: [],
    permissions: ['repricing.prepare'],
  },
};

const applicationUserService = {
  async getOrCreateApplicationAccess(identity) {
    return accessBySubject[identity.sub] || accessBySubject.active;
  },
};

const oidcAdapter = {
  issuer: identityBase.issuer,
  redirectUri: 'http://localhost:5000/api/auth/callback',
  async buildAuthorizationRedirect() {
    return new URL('https://auth.example.invalid/authorize');
  },
  async exchangeAuthorizationCode() {
    throw new Error('Not used by HTTP contract tests');
  },
  async buildLogoutRedirect() {
    return null;
  },
};

function sessionMiddleware(req, _res, next) {
  const subject = req.get('X-Test-Identity');
  req.session = subject
    ? {
        identity: { ...identityBase, sub: subject },
        csrfToken: 'known-csrf-token',
      }
    : {};
  next();
}

const app = createApp({ sessionMiddleware, oidcAdapter, applicationUserService });
let server;
let baseUrl;

test.before(async () => {
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function request(path, {
  subject,
  method = 'GET',
  body,
  csrfToken,
  requestId = 'phase-1-contract-request',
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'X-Request-ID': requestId,
      ...(subject ? { 'X-Test-Identity': subject } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  return { response, data: await response.json() };
}

test('unauthenticated APIs keep their JSON 401 contract without an OIDC redirect', async () => {
  for (const path of ['/api/auth/me', '/api/config', '/api/admin/config']) {
    const { response, data } = await request(path);
    assert.equal(response.status, 401);
    assert.deepEqual(data, { error: 'Authentication required' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('x-request-id'), 'phase-1-contract-request');
  }
});

test('/auth/me exposes the stable safe session shape for every application access state', async () => {
  for (const subject of ['active', 'pending', 'disabled']) {
    const { response, data } = await request('/api/auth/me', { subject });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(data).sort(), [
      'applicationUser',
      'csrfToken',
      'identity',
      'permissions',
      'roles',
    ]);
    assert.equal(data.identity.sub, subject);
    assert.equal(data.applicationUser.status, subject === 'active' ? 'active' : subject);
    assert.equal(data.csrfToken, 'known-csrf-token');
    assert.doesNotMatch(JSON.stringify(data), /access_token|refresh_token|id_token|client_secret/);
  }
});

test('pending and disabled sessions keep their stable business-access 403 contracts', async () => {
  for (const [subject, expected] of [
    ['pending', {
      code: 'APP_ACCESS_PENDING',
      error: 'Application access is pending approval',
    }],
    ['disabled', {
      code: 'APP_ACCESS_DISABLED',
      error: 'Application access is disabled',
    }],
  ]) {
    const { response, data } = await request('/api/config', { subject });
    assert.equal(response.status, 403);
    assert.deepEqual(data, expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('unsafe business methods require CSRF before route validation while safe methods do not', async () => {
  const missing = await request('/api/preview', {
    subject: 'creator',
    method: 'POST',
    body: {},
  });
  assert.equal(missing.response.status, 403);
  assert.deepEqual(missing.data, { error: 'Invalid CSRF token' });
  assert.equal(missing.response.headers.get('cache-control'), 'no-store');

  const wrong = await request('/api/preview', {
    subject: 'creator',
    method: 'POST',
    csrfToken: 'wrong-token',
    body: {},
  });
  assert.equal(wrong.response.status, 403);
  assert.deepEqual(wrong.data, { error: 'Invalid CSRF token' });

  const safe = await request('/api/export/csv', { subject: 'viewer' });
  assert.equal(safe.response.status, 410);
});

test('permission denial keeps its machine-readable capability contract', async () => {
  const { response, data } = await request('/api/export/csv', { subject: 'active' });
  assert.equal(response.status, 403);
  assert.deepEqual(data, {
    code: 'INSUFFICIENT_PERMISSION',
    error: 'Insufficient permission',
    requiredPermission: 'exports.view',
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('first-sync preview requires active authentication, CSRF and every existing capability before service reads', async t => {
  const service = require('../src/services/magento/first-sync.service');
  const calls = [];
  t.mock.method(service, 'review', async (_config, input, options) => {
    calls.push({ input, actor: options.mutationContext.actorUserId });
    return { mode: 'review', fields: [], blockers: [] };
  });
  const path = '/api/admin/magento-integration/first-sync/preview';
  const body = { sku: 'SV11500004', bindingRevisionId: '11111111-1111-4111-8111-111111111111' };
  const capabilities = ['export_templates.manage', 'export_templates.publish', 'exports.view'];
  accessBySubject.firstSyncReviewer = { applicationUser: { id: 17, status: 'active', displayName: 'Field reviewer' },
    roles: [], permissions: capabilities };
  try {
    for (const [subject, expected] of [[undefined, 401], ['pending', 403], ['disabled', 403]]) {
      const result = await request(path, { subject, method: 'POST', body, csrfToken: 'known-csrf-token' });
      assert.equal(result.response.status, expected);
    }
    for (const csrfToken of [undefined, 'wrong-token']) {
      const result = await request(path, { subject: 'firstSyncReviewer', method: 'POST', body, csrfToken });
      assert.equal(result.response.status, 403); assert.equal(result.data.error, 'Invalid CSRF token');
    }
    for (const missing of capabilities) {
      accessBySubject.firstSyncReviewer.permissions = capabilities.filter(permission => permission !== missing);
      const result = await request(path, { subject: 'firstSyncReviewer', method: 'POST', body, csrfToken: 'known-csrf-token' });
      assert.equal(result.response.status, 403); assert.equal(result.data.code, 'INSUFFICIENT_PERMISSION');
      assert.equal(result.data.requiredPermission, missing);
    }
    assert.equal(calls.length, 0);
    accessBySubject.firstSyncReviewer.permissions = capabilities;
    const allowed = await request(path, { subject: 'firstSyncReviewer', method: 'POST', body, csrfToken: 'known-csrf-token' });
    assert.equal(allowed.response.status, 200); assert.deepEqual(calls, [{ input: body, actor: 17 }]);
    accessBySubject.firstSyncReviewer.permissions = [];
    const revoked = await request(path, { subject: 'firstSyncReviewer', method: 'POST', body, csrfToken: 'known-csrf-token' });
    assert.equal(revoked.response.status, 403); assert.equal(calls.length, 1);
  } finally { delete accessBySubject.firstSyncReviewer; }
});

test('representative business validation and compatibility errors retain status and body', async () => {
  const archived = await request('/api/delete', {
    subject: 'archiver',
    method: 'POST',
    csrfToken: 'known-csrf-token',
    body: { skuToDelete: 'x' },
  });
  assert.equal(archived.response.status, 400);
  assert.deepEqual(archived.data, { error: 'Некоректний формат' });

  const repricing = await request('/api/admin/repricing/preview', {
    subject: 'repricer',
    method: 'POST',
    csrfToken: 'known-csrf-token',
    body: {},
  });
  assert.equal(repricing.response.status, 400);
  assert.deepEqual(repricing.data, { error: 'Оберіть цінову матрицю.' });

  const disabledExport = await request('/api/export/csv', { subject: 'viewer' });
  assert.equal(disabledExport.response.status, 410);
  assert.deepEqual(disabledExport.data, {
    error: 'Прямий CSV-експорт вимкнено. Створіть і підтвердьте immutable export snapshot.',
  });
});

test('preparing freeze retains authentication/CSRF and returns an explicit retryable business error',async(t)=>{
  t.mock.method(lifecycleGate,'readGate',async()=>({phase:'preparing'}));
  const frozen=await request('/api/delete',{subject:'archiver',method:'POST',csrfToken:'known-csrf-token',body:{skuToDelete:'x'}});
  assert.equal(frozen.response.status,503);assert.equal(frozen.data.code,'EXPORT_CUTOVER_PREPARING');
  assert.equal((await request('/api/delete',{method:'POST',body:{}})).response.status,401);
  assert.equal((await request('/api/delete',{subject:'archiver',method:'POST',body:{}})).response.status,403);
});
