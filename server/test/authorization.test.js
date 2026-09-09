const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRequireActiveApplicationUser,
  requirePermission,
} = require('../src/auth/authorization');

function runMiddleware(access) {
  const req = { user: { issuer: 'https://issuer.example', sub: 'subject' } };
  const response = { statusCode: 200, headers: {}, body: null };
  const res = {
    set(name, value) {
      response.headers[name] = value;
      return this;
    },
    status(statusCode) {
      response.statusCode = statusCode;
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    },
  };
  let nextValue;
  const middleware = createRequireActiveApplicationUser({
    getOrCreateApplicationAccess: async () => access,
  });
  return middleware(req, res, (error) => { nextValue = error || true; })
    .then(() => ({ req, response, nextValue }));
}

test('active application users pass the coarse access boundary with database-derived context', async () => {
  const access = {
    applicationUser: { id: 7, status: 'active' },
    roles: [{ key: 'manager', displayName: 'Manager' }],
    permissions: ['repricing.prepare'],
  };
  const result = await runMiddleware(access);
  assert.equal(result.nextValue, true);
  assert.equal(result.req.applicationUser.id, 7);
  assert.deepEqual(result.req.roles, access.roles);
  assert.deepEqual(result.req.permissions, access.permissions);
});

test('pending and disabled users receive stable application-access 403 responses', async () => {
  for (const [status, code] of [
    ['pending', 'APP_ACCESS_PENDING'],
    ['disabled', 'APP_ACCESS_DISABLED'],
  ]) {
    const result = await runMiddleware({
      applicationUser: { id: 8, status },
      roles: [],
      permissions: [],
    });
    assert.equal(result.nextValue, undefined);
    assert.equal(result.response.statusCode, 403);
    assert.equal(result.response.body.code, code);
    assert.equal(result.response.headers['Cache-Control'], 'no-store');
  }
});

function runPermissionMiddleware(permissionKey, permissions) {
  const req = { permissions };
  const response = { statusCode: 200, headers: {}, body: null };
  const res = {
    set(name, value) {
      response.headers[name] = value;
      return this;
    },
    status(statusCode) {
      response.statusCode = statusCode;
      return this;
    },
    json(body) {
      response.body = body;
      return this;
    },
  };
  let nextValue;
  requirePermission(permissionKey)(req, res, (error) => { nextValue = error || true; });
  return { response, nextValue };
}

test('requirePermission authorizes only the requested stable capability', () => {
  const allowed = runPermissionMiddleware(
    'repricing.prepare',
    ['repricing.prepare', 'repricing.view']
  );
  assert.equal(allowed.nextValue, true);
  assert.equal(allowed.response.statusCode, 200);

  const denied = runPermissionMiddleware('repricing.apply', ['repricing.prepare']);
  assert.equal(denied.nextValue, undefined);
  assert.equal(denied.response.statusCode, 403);
  assert.deepEqual(denied.response.body, {
    code: 'INSUFFICIENT_PERMISSION',
    error: 'Insufficient permission',
    requiredPermission: 'repricing.apply',
  });
  assert.equal(denied.response.headers['Cache-Control'], 'no-store');
});

test('requirePermission fails closed for missing request permission context', () => {
  const denied = runPermissionMiddleware('products.create', undefined);
  assert.equal(denied.response.statusCode, 403);
  assert.equal(denied.response.body.code, 'INSUFFICIENT_PERMISSION');
});

test('export viewing does not grant export creation', () => {
  const view = runPermissionMiddleware('exports.view', ['exports.view']);
  assert.equal(view.nextValue, true);

  const create = runPermissionMiddleware('exports.create', ['exports.view']);
  assert.equal(create.nextValue, undefined);
  assert.equal(create.response.statusCode, 403);
  assert.equal(create.response.body.requiredPermission, 'exports.create');
});

test('requirePermission rejects invalid configured permission keys at startup', () => {
  assert.throws(() => requirePermission('Administrator'), /Invalid permission key/);
  assert.throws(() => requirePermission('products'), /Invalid permission key/);
});
