const test = require('node:test');
const assert = require('node:assert/strict');

const adminRoutes = require('../src/routes/admin.routes');
const publicRoutes = require('../src/routes/public.routes');
const { ENDPOINT_MANIFEST } = require('../src/routes/endpoint-manifest');

function readRouter(router) {
  return router.stack.flatMap((layer) => {
    if (layer.route) {
      const permissionMiddleware = layer.route.stack.find(
        (entry) => entry.handle.permissionKey || entry.handle.permissionKeys
      )?.handle;
      const permission = permissionMiddleware?.permissionKey
        || permissionMiddleware?.permissionKeys;
      return Object.keys(layer.route.methods).map((method) => ({
        method: method.toUpperCase(),
        path: layer.route.path,
        permission,
      }));
    }
    return layer.handle?.stack ? readRouter(layer.handle) : [];
  });
}

function key(endpoint) {
  return `${endpoint.method} ${endpoint.path}`;
}

test('endpoint manifest exactly covers every public and admin business route', () => {
  const actual = [...readRouter(publicRoutes), ...readRouter(adminRoutes)]
    .sort((left, right) => key(left).localeCompare(key(right)));
  const expected = ENDPOINT_MANIFEST
    .map(({ method, path, permission }) => ({ method, path, permission }))
    .sort((left, right) => key(left).localeCompare(key(right)));

  assert.equal(new Set(expected.map(key)).size, expected.length, 'manifest route keys are unique');
  assert.deepEqual(actual, expected);
});

test('endpoint manifest records the shared access boundary and response contract', () => {
  for (const endpoint of ENDPOINT_MANIFEST) {
    assert.equal(endpoint.authenticated, true, key(endpoint));
    assert.equal(endpoint.activeUser, true, key(endpoint));
    assert.equal(endpoint.csrf, ['POST', 'PUT', 'PATCH', 'DELETE'].includes(endpoint.method), key(endpoint));
    assert.ok(['json', 'csv'].includes(endpoint.response), key(endpoint));
  }

  assert.deepEqual(
    ENDPOINT_MANIFEST.filter((endpoint) => endpoint.response === 'csv').map(key).sort(),
    [
      'GET /admin/product-corrections/csv',
      'GET /admin/repricing/:batchId/csv',
      'GET /admin/repricing/:batchId/rollback-csv',
      'GET /export/snapshots/:id/csv',
    ].sort()
  );
});
