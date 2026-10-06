const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { requireAuthenticatedSession, requireCsrfForUnsafeMethods } = require('../src/auth/authentication');
const { createRequireActiveApplicationUser } = require('../src/auth/authorization');
const lifecycle = require('../src/services/product-lifecycle.service');
const visibility = require('../src/services/magento/product-visibility-worker');

test('restore and visibility HTTP enforce session, active status, CSRF and both capabilities before invoking a service', async (t) => {
  let invoked = 0;
  for (const method of ['preview', 'apply', 'readBatch', 'status']) t.mock.method(lifecycle, method, async () => { invoked++; return { state: 'fixture' }; });
  for (const method of ['inspect', 'reconcile']) t.mock.method(visibility, method, async () => { invoked++; return { state: 'fixture' }; });
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const subject = req.get('X-Fixture-Subject');
    req.session = { csrfToken: 'fixture-token', ...(subject ? { identity: { issuer: 'fixture', sub: subject, authenticatedAt: '2026-10-01T00:00:00Z' } } : {}) };
    next();
  });
  app.use(requireAuthenticatedSession);
  app.use(createRequireActiveApplicationUser({ getOrCreateApplicationAccess: async (identity) => ({
    applicationUser: { id: 1, status: identity.sub === 'pending' ? 'pending' : identity.sub === 'disabled' ? 'disabled' : 'active' },
    roles: [], permissions: identity.sub === 'both' ? ['products.view', 'products.archive'] : identity.sub === 'view' ? ['products.view'] : identity.sub === 'archive' ? ['products.archive'] : [],
  }) }));
  app.use(requireCsrfForUnsafeMethods); app.use(require('../src/routes/public/product-lifecycle.routes'));
  const server = await new Promise((done) => { const listening = app.listen(0, '127.0.0.1', () => done(listening)); });
  const root = `http://127.0.0.1:${server.address().port}`;
  const routes = [
    ['/products/restore/preview', 'POST', {}], ['/products/restore/apply', 'POST', {}],
    ['/products/restore/batches/' + 'a'.repeat(64), 'GET'],
    ['/products/visibility/inspect', 'POST', { intentId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
    ['/products/visibility/reconcile', 'POST', { intentId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }],
  ];
  async function request(path, method, body, subject, csrf = true) {
    return fetch(root + path, { method, headers: { ...(subject ? { 'X-Fixture-Subject': subject } : {}),
      ...(csrf ? { 'X-CSRF-Token': 'fixture-token' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  }
  try {
    for (const [path, method, body] of routes) {
      for (const [subject, status] of [[null, 401], ['pending', 403], ['disabled', 403], ['view', 403], ['archive', 403], ['none', 403]]) {
        assert.equal((await request(path, method, body, subject)).status, status);
        assert.equal(invoked, 0);
      }
      if (method === 'POST') { assert.equal((await request(path, method, body, 'both', false)).status, 403); assert.equal(invoked, 0); }
    }
    for (const [path, method, body] of routes) assert.equal((await request(path, method, body, 'both')).status, 200);
    assert.equal(invoked, routes.length);
    assert.equal((await request('/products/12/lifecycle', 'GET', undefined, 'view')).status, 200);
  } finally { await new Promise((done) => server.close(done)); }
});
