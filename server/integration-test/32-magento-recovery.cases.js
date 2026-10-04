const suite = require('./suite-context');
const { test, assert, request, authenticateApplicationSession, authenticateIdentitySession, crypto, pool } = suite;

test('Magento recovery HTTP boundaries require authenticated active users, CSRF and independently delegated capabilities', async () => {
  const admin = await authenticateApplicationSession();
  const actor = await authenticateIdentitySession({ subject: `recovery-${crypto.randomUUID()}` });
  const root = '/api/admin/magento-recovery';
  const id = crypto.randomUUID();
  const calls = [
    [`${root}/products/2147483647`, 'GET', null],
    [`${root}/jobs/${id}`, 'GET', 'export_templates.publish'],
    ...['inspect', 'reconcile', 'continue'].map((action) => [`${root}/jobs/${id}/${action}`, 'POST', 'export_templates.publish']),
    ...['lifecycle-preview', 'lifecycle-apply'].map((action) => [`${root}/products/2147483647/${action}`, 'POST', 'exports.reconcile']),
  ];
  for (const [url, method] of calls) {
    const unauthenticated = await request(url, { method, body: method === 'GET' ? undefined : {}, authentication: null });
    assert.equal(unauthenticated.response.status, 401); assert.equal(unauthenticated.response.headers.get('location'), null);
    const pending = await request(url, { method, body: method === 'GET' ? undefined : {}, authentication: actor });
    assert.equal(pending.response.status, 403); assert.equal(pending.data.code, 'APP_ACCESS_PENDING');
    if (method !== 'GET') {
      const denied = await request(url, { method, body: {}, authentication: admin, csrfToken: null });
      assert.equal(denied.response.status, 403);
    }
  }
  const created = await request('/api/admin/roles', { authentication: admin, method: 'POST', body: {
    displayName: `Recovery ${crypto.randomUUID()}`, description: 'Recovery delegation fixture', permissionKeys: [],
  } });
  assert.equal(created.response.status, 201, created.text); let role = created.data.role;
  assert.equal((await request(`/api/admin/users/${actor.applicationUser.id}/approve`, { authentication: admin,
    method: 'POST', body: { roleId: role.id } })).response.status, 200);
  async function grant(permissionKeys) {
    const result = await request(`/api/admin/roles/${role.id}/permissions`, { authentication: admin, method: 'PUT', body: {
      permissionKeys, expectedVersion: role.version, expectedActiveAssignedUserCount: 1,
    } });
    assert.equal(result.response.status, 200, result.text); role = result.data.role;
  }
  for (const [url, method] of calls) {
    const denied = await request(url, { method, body: method === 'GET' ? undefined : {}, authentication: actor });
    assert.equal(denied.response.status, 403); assert.equal(denied.data.code, 'INSUFFICIENT_PERMISSION');
  }
  for (const capability of ['exports.reconcile', 'export_templates.publish']) {
    await grant([capability]);
    for (const [url, method, required] of calls) {
      const result = await request(url, { method, body: method === 'GET' ? undefined : {}, authentication: actor });
      if (required && required !== capability) assert.equal(result.response.status, 403, result.text);
      else assert.ok([404, 422].includes(result.response.status), result.text);
    }
  }
  await pool.query("UPDATE application_users SET status='disabled',deactivated_at=CURRENT_TIMESTAMP WHERE id=$1", [actor.applicationUser.id]);
  for (const [url, method] of calls) {
    const denied = await request(url, { method, body: method === 'GET' ? undefined : {}, authentication: actor });
    assert.equal(denied.response.status, 403); assert.equal(denied.data.code, 'APP_ACCESS_DISABLED');
  }
});
