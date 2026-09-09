const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createRequireActiveApplicationUser,
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
