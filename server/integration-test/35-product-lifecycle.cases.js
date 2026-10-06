const suite = require('./suite-context');
suite.test('product restore HTTP requires an active session, CSRF, view and archive capabilities before touching durable or remote state', async () => {
  const admin = await suite.authenticateApplicationSession();
  const pending = await suite.authenticateIdentitySession({ subject: `restore-${suite.crypto.randomUUID()}` });
  const routes = [
    ['/api/products/restore/preview', 'POST', { skus: [] }],
    ['/api/products/restore/apply', 'POST', {}],
    ['/api/products/restore/batches/' + 'a'.repeat(64), 'GET'],
    ['/api/products/visibility/inspect', 'POST', {}],
    ['/api/products/visibility/reconcile', 'POST', {}],
  ];
  for (const [url, method, body] of routes) {
    assertStatus(await suite.request(url, { method, body, authentication: null }), 401);
    const denied = await suite.request(url, { method, body, authentication: pending });
    assertStatus(denied, 403); suite.assert.equal(denied.data.code, 'APP_ACCESS_PENDING');
    if (method === 'POST') assertStatus(await suite.request(url, { method, body, authentication: admin, csrfToken: null }), 403);
  }
  const created = await suite.request('/api/admin/roles', { authentication: admin, method: 'POST', body: {
    displayName: `Restore ${suite.crypto.randomUUID()}`, description: 'Restore permissions fixture', permissionKeys: ['products.view'],
  } }); assertStatus(created, 201);
  assertStatus(await suite.request(`/api/admin/users/${pending.applicationUser.id}/approve`, { authentication: admin, method: 'POST', body: { roleId: created.data.role.id } }), 200);
  for (const [url, method, body] of routes) {
    const denied = await suite.request(url, { method, body, authentication: pending });
    assertStatus(denied, 403); suite.assert.equal(denied.data.requiredPermission, 'products.archive');
  }
  function assertStatus(result, status) { suite.assert.equal(result.response.status, status, result.text); }
});
suite.test('product archive visibility and reviewed batch restore use durable exact PostgreSQL receipts', async (t) => {
  const name = `amber_product_lifecycle_${suite.crypto.randomBytes(6).toString('hex')}_test`;
  const url = await suite.recreateTestDatabase(name);
  const db = new suite.Pool({ connectionString: url, options: '-c amber.lifecycle_writer_version=1' });
  const directory = await suite.fs.mkdtemp(suite.path.join(suite.os.tmpdir(), 'amber-product-archive-063-'));
  try {
    for (const file of (await suite.fs.readdir(suite.path.join(suite.serverRoot, 'migrations'))).filter((file) => file.endsWith('.sql') && file < '064')) {
      await suite.fs.copyFile(suite.path.join(suite.serverRoot, 'migrations', file), suite.path.join(directory, file));
    }
    await suite.runNodeInDatabase(url, `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
    await t.test('064 preserves a preexisting archive and adds no visibility, restoration or native work', () =>
      require('./product-lifecycle-fixture').migrationWithoutEnrollment(db, () =>
        suite.runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});")));
    await require('./product-lifecycle-fixture').run(db, t);
  } finally {
    await db.end(); await suite.dropTestDatabase(name);
    suite.assert.equal(suite.path.dirname(directory), suite.path.resolve(suite.os.tmpdir()));
    suite.assert.ok(suite.path.basename(directory).startsWith('amber-product-archive-063-'));
    await suite.fs.rm(directory, { recursive: true, force: true });
  }
});
