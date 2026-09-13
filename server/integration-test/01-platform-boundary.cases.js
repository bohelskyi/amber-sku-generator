const suite = require('./suite-context');
const {
  assert,
  test,
  pool,
  request,
} = suite;

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
