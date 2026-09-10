const suite = require('./suite-context');
const {
  assert,
  path,
  test,
  Pool,
  pool,
  runNodeInDatabase,
  recreateTestDatabase,
  dropTestDatabase,
  resolveOrCreateApplicationUser,
  bootstrapAdministrator,
  runMigrations,
  approveApplicationUser,
  changeApplicationUserRole,
  disableApplicationUser,
  enableApplicationUser,
  request,
  activateApplicationUserForTest,
  replaceActiveRoleForTest,
  roleIdForKey,
  currentAssignmentIdForUser,
  authenticateApplicationSession,
  authenticateIdentitySession,
  schemas,
} = suite;

test('business endpoints enforce the Administrator, Storekeeper, and Manager capability matrix', async () => {
  const userId = suite.authenticatedSession.applicationUser.id;
  const denied = async (url, options, requiredPermission) => {
    const result = await request(url, options);
    assert.equal(result.response.status, 403, result.text);
    assert.deepEqual(result.data, {
      code: 'INSUFFICIENT_PERMISSION',
      error: 'Insufficient permission',
      requiredPermission,
    });
    assert.equal(result.response.headers.get('location'), null);
    return result;
  };

  await replaceActiveRoleForTest(userId, 'storekeeper');
  const storekeeperMe = await request('/api/auth/me');
  assert.equal(storekeeperMe.response.status, 200, storekeeperMe.text);
  assert.equal(storekeeperMe.data.roles[0].key, 'storekeeper');
  assert.equal(storekeeperMe.data.permissions.includes('products.archive'), true);
  assert.equal(storekeeperMe.data.permissions.includes('products.recount'), true);

  const firstPreview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(firstPreview.response.status, 200, firstPreview.text);
  const firstProduct = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: firstPreview.data.previewToken,
    },
  });
  assert.equal(firstProduct.response.status, 200, firstProduct.text);
  const decoded = await request('/api/decode', {
    method: 'POST', body: { sku: firstProduct.data.fullSku },
  });
  assert.equal(decoded.response.status, 200, decoded.text);

  const correctionPreview = await request('/api/recount/preview', {
    method: 'POST',
    body: { sourceSku: firstProduct.data.fullSku, answers: { kind: 2 }, reason: 'RBAC workflow' },
  });
  assert.equal(correctionPreview.response.status, 200, correctionPreview.text);
  const correction = await request('/api/admin/correction-requests', {
    method: 'POST',
    body: { sourceSku: firstProduct.data.fullSku, answers: { kind: 2 }, reason: 'RBAC workflow' },
  });
  assert.equal(correction.response.status, 200, correction.text);
  const correctionId = Number(correction.data.request.id);
  const claim = await request(`/api/admin/correction-requests/${correctionId}/claim`, {
    method: 'POST', body: {},
  });
  assert.equal(claim.response.status, 200, claim.text);
  const refresh = await request(`/api/admin/correction-requests/${correctionId}/refresh`, {
    method: 'POST', body: { claimVersion: claim.data.request.claimVersion },
  });
  assert.equal(refresh.response.status, 200, refresh.text);
  const completed = await request(`/api/admin/correction-requests/${correctionId}/complete`, {
    method: 'POST', body: { claimVersion: claim.data.request.claimVersion },
  });
  assert.equal(completed.response.status, 200, completed.text);
  const correctedSku = completed.data.recount.corrected.fullSku;
  const queuedRecountAttribution = await pool.query(
    `SELECT corrected.created_by_user_id, pc.performed_by_user_id,
            ae.actor_user_id, ae.details
     FROM product_corrections pc
     JOIN products corrected ON corrected.id = pc.corrected_product_id
     JOIN audit_events ae
       ON ae.event_key = 'product.recounted'
      AND ae.subject_type = 'product'
      AND ae.subject_id = pc.source_product_id::text
     WHERE pc.source_product_id = $1`,
    [Number(firstProduct.data.id)]
  );
  assert.equal(Number(queuedRecountAttribution.rows[0].created_by_user_id), userId);
  assert.equal(Number(queuedRecountAttribution.rows[0].performed_by_user_id), userId);
  assert.equal(Number(queuedRecountAttribution.rows[0].actor_user_id), userId);
  assert.equal(queuedRecountAttribution.rows[0].details.correctionRequestId, correctionId);
  const repeatedCompletion = await request(
    `/api/admin/correction-requests/${correctionId}/complete`,
    { method: 'POST', body: { claimVersion: claim.data.request.claimVersion } }
  );
  assert.equal(repeatedCompletion.response.status, 200, repeatedCompletion.text);
  assert.equal(repeatedCompletion.data.alreadyCompleted, true);
  const completionAudit = await pool.query(
    `SELECT event_key, actor_user_id, details
     FROM audit_events
     WHERE (event_key = 'product.recounted'
            AND subject_type = 'product' AND subject_id = $1)
        OR (event_key = 'correction_request.completed'
            AND subject_type = 'correction_request' AND subject_id = $2)
     ORDER BY id`,
    [String(firstProduct.data.id), String(correctionId)]
  );
  assert.deepEqual(completionAudit.rows.map((row) => row.event_key), [
    'correction_request.completed',
    'product.recounted',
  ]);
  assert.equal(completionAudit.rows.every((row) => Number(row.actor_user_id) === userId), true);
  assert.deepEqual(completionAudit.rows[0].details, {
    claimVersion: Number(claim.data.request.claimVersion),
    nextClaimVersion: Number(claim.data.request.claimVersion) + 1,
    sourceProductId: Number(firstProduct.data.id),
    correctedProductId: Number(completed.data.recount.correctedProductId),
    productCorrectionId: Number(queuedRecountAttribution.rows[0].details.productCorrectionId),
  });

  const history = await request('/api/products');
  assert.equal(history.response.status, 200, history.text);
  assert.equal(history.data.some((product) => product.full_sku === correctedSku), true);
  const storekeeperPrepare = await request('/api/admin/repricing/global/preview', {
    method: 'POST', body: {},
  });
  assert.equal(storekeeperPrepare.response.status, 200, storekeeperPrepare.text);

  const categoryCountBefore = Number((await pool.query(
    "SELECT count(*) FROM categories WHERE code = 'RS'"
  )).rows[0].count);
  await denied('/api/admin/category', {
    method: 'POST', body: { code: 'RS', name: 'Storekeeper denied category' },
  }, 'catalog.manage');
  assert.equal(Number((await pool.query(
    "SELECT count(*) FROM categories WHERE code = 'RS'"
  )).rows[0].count), categoryCountBefore);
  await denied('/api/admin/prices/ZZ', {}, 'pricing.view');
  await denied('/api/admin/repricing/apply', { method: 'POST', body: {} }, 'repricing.apply');
  await denied('/api/admin/repricing/999999/rollback', { method: 'POST', body: {} }, 'repricing.rollback');
  const exportCountBefore = Number((await pool.query('SELECT count(*) FROM export_snapshots')).rows[0].count);
  await denied('/api/export/snapshots', {
    method: 'POST', body: { fromSku: correctedSku, toSku: correctedSku },
  }, 'exports.create');
  assert.equal(Number((await pool.query('SELECT count(*) FROM export_snapshots')).rows[0].count), exportCountBefore);
  await denied('/api/admin/correction-requests/999999/force-release', {
    method: 'POST', body: { confirm: true },
  }, 'corrections.force_release');

  const archived = await request('/api/delete', {
    method: 'POST', body: { skuToDelete: correctedSku },
  });
  assert.equal(archived.response.status, 200, archived.text);
  assert.equal((await pool.query(
    'SELECT status FROM products WHERE full_sku = $1', [correctedSku]
  )).rows[0].status, 'archived');

  const secondPreview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(secondPreview.response.status, 200, secondPreview.text);
  const managerRequestSource = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: secondPreview.data.previewToken,
    },
  });
  assert.equal(managerRequestSource.response.status, 200, managerRequestSource.text);

  await replaceActiveRoleForTest(userId, 'manager');
  const managerMe = await request('/api/auth/me');
  assert.equal(managerMe.response.status, 200, managerMe.text);
  assert.equal(managerMe.data.roles[0].key, 'manager');
  assert.equal(managerMe.data.permissions.includes('products.archive'), false);
  assert.equal(managerMe.data.permissions.includes('products.create'), false);
  assert.equal(managerMe.data.permissions.includes('corrections.claim'), false);
  assert.equal(managerMe.data.permissions.includes('corrections.complete'), false);
  assert.equal(managerMe.data.permissions.includes('corrections.reject'), true);

  const managerDecode = await request('/api/decode', {
    method: 'POST', body: { sku: managerRequestSource.data.fullSku },
  });
  assert.equal(managerDecode.response.status, 200, managerDecode.text);
  const managerCorrectionPreview = await request('/api/recount/preview', {
    method: 'POST',
    body: {
      sourceSku: managerRequestSource.data.fullSku,
      answers: { kind: 2 },
      reason: 'Manager correction request',
    },
  });
  assert.equal(managerCorrectionPreview.response.status, 200, managerCorrectionPreview.text);
  const managerCorrection = await request('/api/admin/correction-requests', {
    method: 'POST',
    body: {
      sourceSku: managerRequestSource.data.fullSku,
      answers: { kind: 2 },
      reason: 'Manager correction request',
    },
  });
  assert.equal(managerCorrection.response.status, 200, managerCorrection.text);
  const managerCorrectionId = Number(managerCorrection.data.request.id);
  const managerCorrectionList = await request('/api/admin/correction-requests');
  assert.equal(managerCorrectionList.response.status, 200, managerCorrectionList.text);
  assert.equal(
    managerCorrectionList.data.items.some((item) => Number(item.id) === managerCorrectionId),
    true
  );
  await denied(`/api/admin/correction-requests/${managerCorrectionId}/claim`, {
    method: 'POST', body: {},
  }, 'corrections.claim');
  await denied(`/api/admin/correction-requests/${managerCorrectionId}/complete`, {
    method: 'POST', body: {},
  }, 'corrections.complete');
  const managerRejected = await request(
    `/api/admin/correction-requests/${managerCorrectionId}/status`,
    { method: 'PATCH', body: { status: 'rejected' } }
  );
  assert.equal(managerRejected.response.status, 200, managerRejected.text);
  assert.equal(managerRejected.data.request.status, 'rejected');
  assert.equal((await request('/api/products')).response.status, 200);
  const managerPrices = await request('/api/admin/prices/ZZ');
  assert.equal(managerPrices.response.status, 200, managerPrices.text);
  assert.equal(managerPrices.data.scenarios.length > 0, true);
  assert.equal(managerPrices.data.scenarios[0].matrix.length > 0, true);
  assert.ok(Array.isArray(managerPrices.data.modifiers));
  assert.equal((await request('/api/admin/repricing/global/preview', {
    method: 'POST', body: {},
  })).response.status, 200);

  const productCountBefore = Number((await pool.query('SELECT count(*) FROM products')).rows[0].count);
  await denied('/api/save', { method: 'POST', body: {} }, 'products.create');
  assert.equal(Number((await pool.query('SELECT count(*) FROM products')).rows[0].count), productCountBefore);
  await denied('/api/delete', {
    method: 'POST', body: { skuToDelete: managerRequestSource.data.fullSku },
  }, 'products.archive');
  assert.equal((await pool.query(
    'SELECT status FROM products WHERE full_sku = $1', [managerRequestSource.data.fullSku]
  )).rows[0].status, 'active');
  await denied('/api/recount/apply', {
    method: 'POST', body: { sourceSku: managerRequestSource.data.fullSku, answers: { kind: 2 } },
  }, 'products.recount');
  await denied('/api/admin/config', {}, 'catalog.view');
  await denied('/api/admin/roles', {}, 'roles.manage');
  await denied('/api/admin/category', {
    method: 'POST', body: { code: 'RM', name: 'Manager denied category' },
  }, 'catalog.manage');

  const priceCellBefore = await pool.query(
    'SELECT price FROM price_matrix WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0',
    [schemas.ZZScenario]
  );
  await denied('/api/admin/price-cell', {
    method: 'POST',
    body: { scenario_id: schemas.ZZScenario, x_val: 1, y_val: 0, price: 999999 },
  }, 'pricing.manage');
  const priceCellAfter = await pool.query(
    'SELECT price FROM price_matrix WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0',
    [schemas.ZZScenario]
  );
  assert.deepEqual(priceCellAfter.rows, priceCellBefore.rows);

  const schemaCountBefore = Number((await pool.query(
    "SELECT count(*) FROM sku_schema_versions WHERE category_code = 'ZZ'"
  )).rows[0].count);
  await denied('/api/admin/sku-schema/ZZ/publish', {
    method: 'POST', body: {},
  }, 'sku_schemas.publish');
  assert.equal(Number((await pool.query(
    "SELECT count(*) FROM sku_schema_versions WHERE category_code = 'ZZ'"
  )).rows[0].count), schemaCountBefore);
  await denied('/api/admin/repricing/apply', { method: 'POST', body: {} }, 'repricing.apply');
  await denied('/api/admin/repricing/999999/rollback', { method: 'POST', body: {} }, 'repricing.rollback');
  await denied('/api/export/snapshots', {
    method: 'POST', body: { fromSku: managerRequestSource.data.fullSku },
  }, 'exports.create');
  await denied('/api/admin/correction-requests/999999/force-release', {
    method: 'POST', body: { confirm: true },
  }, 'corrections.force_release');

  const stillLoggedIn = await request('/api/decode', {
    method: 'POST', body: { sku: managerRequestSource.data.fullSku },
  });
  assert.equal(stillLoggedIn.response.status, 200, stillLoggedIn.text);

  await replaceActiveRoleForTest(userId, null);
  await denied('/api/decode', {
    method: 'POST', body: { sku: managerRequestSource.data.fullSku },
  }, 'products.decode');
  await replaceActiveRoleForTest(userId, 'manager');
  assert.equal((await request('/api/decode', {
    method: 'POST', body: { sku: managerRequestSource.data.fullSku },
  })).response.status, 200);

  await replaceActiveRoleForTest(userId, 'administrator');
  const invalidDeleteType = await request('/api/admin/delete-item', {
    method: 'POST', body: { type: '__proto__', id: 1 },
  });
  assert.equal(invalidDeleteType.response.status, 400, invalidDeleteType.text);
  assert.deepEqual(invalidDeleteType.data, { error: 'Invalid resource type' });
});

test('users.manage API administers one current application role and updates existing sessions immediately', async () => {
  if (!suite.authenticatedSession) suite.authenticatedSession = await authenticateApplicationSession('/admin');
  const administratorUserId = suite.authenticatedSession.applicationUser.id;
  await replaceActiveRoleForTest(administratorUserId, 'administrator');
  const administratorRoleId = await roleIdForKey('administrator');
  const managerRoleId = await roleIdForKey('manager');
  const storekeeperRoleId = await roleIdForKey('storekeeper');

  const createPendingUser = (suffix) => resolveOrCreateApplicationUser({
    issuer: 'https://user-admin-api.example/realms/amber',
    sub: `user-admin-${suffix}`,
    preferred_username: `user.admin.${suffix}`,
    name: `User Admin ${suffix}`,
    email: `${suffix}@example.invalid`,
    authenticatedAt: '2026-09-09T12:00:00.000Z',
  });
  const assignmentState = async (userId) => {
    const result = await pool.query(
      `SELECT u.status, r.role_key, a.revoked_at, a.assigned_by_user_id,
              a.revoked_by_user_id
       FROM application_users u
       LEFT JOIN user_role_assignments a ON a.application_user_id = u.id
       LEFT JOIN roles r ON r.id = a.role_id
       WHERE u.id = $1
       ORDER BY a.id`,
      [userId]
    );
    return result.rows;
  };

  const rolesResponse = await request('/api/admin/users/roles');
  assert.equal(rolesResponse.response.status, 200, rolesResponse.text);
  assert.deepEqual(rolesResponse.data.roles.map((role) => role.id), [
    administratorRoleId, managerRoleId, storekeeperRoleId,
  ]);
  assert.equal(rolesResponse.data.roles.every((role) => (
    Number.isSafeInteger(role.id) && role.displayName && role.status === 'active'
  )), true);

  const administratorAssignmentId = await currentAssignmentIdForUser(administratorUserId);
  for (const [path, method, body] of [
    [`/api/admin/users/${administratorUserId}/disable`, 'POST', {}],
    [`/api/admin/users/${administratorUserId}/role`, 'PUT', {
      roleId: managerRoleId,
      expectedAssignmentId: administratorAssignmentId,
    }],
  ]) {
    const lastAdministratorConflict = await request(path, { method, body });
    assert.equal(lastAdministratorConflict.response.status, 409, lastAdministratorConflict.text);
    assert.equal(lastAdministratorConflict.data.code, 'LAST_ADMINISTRATOR_REQUIRED');
  }
  assert.equal(Number((await pool.query(
    `SELECT count(*) FROM audit_events
     WHERE subject_type = 'application_user' AND subject_id = $1`,
    [String(administratorUserId)]
  )).rows[0].count), 0, 'failed user-management mutations must not be audited as successes');
  const administratorAfterConflicts = await request('/api/auth/me');
  assert.equal(administratorAfterConflicts.response.status, 200);
  assert.deepEqual(
    administratorAfterConflicts.data.roles.map((role) => role.key),
    ['administrator']
  );
  assert.equal(administratorAfterConflicts.data.permissions.includes('users.manage'), true);

  const rejectedUser = await createPendingUser('rejected');
  const customRole = await pool.query(
    `INSERT INTO roles (role_key, display_name, description, is_system)
     VALUES ('integration_custom_role', 'Integration custom role', 'Assignable custom role', FALSE)
     RETURNING id`
  );
  for (const [roleBody, expectedCode] of [
    [{}, 'INVALID_ROLE_ID'],
    [{ roleId: 'integration_custom_role' }, 'INVALID_ROLE_ID'],
    [{ roleId: 99999999 }, 'ROLE_NOT_ASSIGNABLE'],
  ]) {
    const rejected = await request(`/api/admin/users/${rejectedUser.id}/approve`, {
      method: 'POST',
      body: roleBody,
    });
    assert.equal(rejected.response.status, 400, rejected.text);
    assert.equal(rejected.data.code, expectedCode);
    assert.deepEqual(await assignmentState(rejectedUser.id), [{
      status: 'pending',
      role_key: null,
      revoked_at: null,
      assigned_by_user_id: null,
      revoked_by_user_id: null,
    }]);
  }
  const missingCsrf = await request(`/api/admin/users/${rejectedUser.id}/approve`, {
    method: 'POST',
    body: { roleId: managerRoleId },
    csrfToken: null,
  });
  assert.equal(missingCsrf.response.status, 403, missingCsrf.text);
  assert.deepEqual(missingCsrf.data, { error: 'Invalid CSRF token' });
  assert.equal((await assignmentState(rejectedUser.id))[0].status, 'pending');
  const customApproval = await request(`/api/admin/users/${rejectedUser.id}/approve`, {
    method: 'POST',
    body: { roleId: Number(customRole.rows[0].id) },
  });
  assert.equal(customApproval.response.status, 200, customApproval.text);
  assert.equal(customApproval.data.user.role.key, 'integration_custom_role');

  const deniedUser = await createPendingUser('denied');
  for (const roleKey of ['manager', 'storekeeper']) {
    await replaceActiveRoleForTest(administratorUserId, roleKey);
    const listDenied = await request('/api/admin/users');
    assert.equal(listDenied.response.status, 403, listDenied.text);
    assert.equal(listDenied.data.code, 'INSUFFICIENT_PERMISSION');
    assert.equal(listDenied.data.requiredPermission, 'users.manage');
    const mutationDenied = await request(`/api/admin/users/${deniedUser.id}/approve`, {
      method: 'POST',
      body: { roleId: storekeeperRoleId },
    });
    assert.equal(mutationDenied.response.status, 403, mutationDenied.text);
    assert.equal(mutationDenied.data.code, 'INSUFFICIENT_PERMISSION');
    assert.deepEqual(await assignmentState(deniedUser.id), [{
      status: 'pending',
      role_key: null,
      revoked_at: null,
      assigned_by_user_id: null,
      revoked_by_user_id: null,
    }]);
    assert.equal((await request('/api/config')).response.status, 200);
  }
  await replaceActiveRoleForTest(administratorUserId, 'administrator');

  const pendingStorekeeper = await createPendingUser('storekeeper');
  const pendingManager = await createPendingUser('manager');
  const pendingAdministrator = await createPendingUser('administrator');
  for (const [user, roleKey, roleId] of [
    [pendingStorekeeper, 'storekeeper', storekeeperRoleId],
    [pendingManager, 'manager', managerRoleId],
    [pendingAdministrator, 'administrator', administratorRoleId],
  ]) {
    const approved = await request(`/api/admin/users/${user.id}/approve`, {
      method: 'POST',
      body: { roleId },
    });
    assert.equal(approved.response.status, 200, approved.text);
    assert.equal(approved.data.user.status, 'active');
    assert.equal(approved.data.user.role.key, roleKey);
    const activeAssignments = (await assignmentState(user.id))
      .filter((row) => row.revoked_at === null && row.role_key !== null);
    assert.equal(activeAssignments.length, 1);
    assert.equal(activeAssignments[0].role_key, roleKey);
    assert.equal(Number(activeAssignments[0].assigned_by_user_id), administratorUserId);
  }

  let expectedAssignmentId = await currentAssignmentIdForUser(pendingStorekeeper.id);
  let changed = await request(`/api/admin/users/${pendingStorekeeper.id}/role`, {
    method: 'PUT', body: { roleId: managerRoleId, expectedAssignmentId },
  });
  assert.equal(changed.response.status, 200, changed.text);
  assert.equal(changed.data.user.role.key, 'manager');
  expectedAssignmentId = changed.data.user.currentAssignmentId;
  changed = await request(`/api/admin/users/${pendingStorekeeper.id}/role`, {
    method: 'PUT', body: { roleId: storekeeperRoleId, expectedAssignmentId },
  });
  assert.equal(changed.response.status, 200, changed.text);
  assert.equal(changed.data.user.role.key, 'storekeeper');
  const storekeeperHistory = await assignmentState(pendingStorekeeper.id);
  assert.equal(storekeeperHistory.length, 3);
  assert.equal(storekeeperHistory.filter((row) => row.revoked_at === null).length, 1);
  assert.equal(storekeeperHistory.filter((row) => row.revoked_at !== null).length, 2);
  assert.equal(storekeeperHistory.filter(
    (row) => Number(row.revoked_by_user_id) === administratorUserId
  ).length, 2);

  expectedAssignmentId = await currentAssignmentIdForUser(pendingManager.id);
  changed = await request(`/api/admin/users/${pendingManager.id}/role`, {
    method: 'PUT', body: { roleId: storekeeperRoleId, expectedAssignmentId },
  });
  assert.equal(changed.response.status, 200, changed.text);
  assert.equal(changed.data.user.role.key, 'storekeeper');
  assert.equal((await assignmentState(pendingManager.id)).filter(
    (row) => row.revoked_at === null
  ).length, 1);

  const liveSession = await authenticateIdentitySession({
    subject: 'existing-session-role-change',
    preferredUsername: 'existing.session',
    displayName: 'Existing Session',
  });
  const secondLiveSession = await authenticateIdentitySession({
    subject: 'existing-session-role-change',
    preferredUsername: 'existing.session',
    displayName: 'Existing Session',
  });
  const liveUserId = liveSession.applicationUser.id;
  const approvedLive = await request(`/api/admin/users/${liveUserId}/approve`, {
    method: 'POST',
    body: { roleId: storekeeperRoleId },
    headers: { 'X-Request-ID': 'audit-user-approved' },
  });
  assert.equal(approvedLive.response.status, 200, approvedLive.text);
  assert.equal((await request('/api/config', { authentication: liveSession })).response.status, 200);
  assert.equal((await request('/api/admin/prices/ZZ', {
    authentication: liveSession,
  })).response.status, 403);

  const liveRoleChange = await request(`/api/admin/users/${liveUserId}/role`, {
    method: 'PUT',
    body: {
      roleId: managerRoleId,
      expectedAssignmentId: approvedLive.data.user.currentAssignmentId,
    },
    headers: { 'X-Request-ID': 'audit-user-role-manager' },
  });
  assert.equal(liveRoleChange.response.status, 200, liveRoleChange.text);
  const liveMe = await request('/api/auth/me', { authentication: liveSession });
  assert.deepEqual(liveMe.data.roles.map((role) => role.key), ['manager']);
  assert.equal((await request('/api/admin/prices/ZZ', {
    authentication: liveSession,
  })).response.status, 200);

  const noOpRoleChange = await request(`/api/admin/users/${liveUserId}/role`, {
    method: 'PUT',
    body: {
      roleId: managerRoleId,
      expectedAssignmentId: liveRoleChange.data.user.currentAssignmentId,
    },
    headers: { 'X-Request-ID': 'audit-user-role-no-op' },
  });
  assert.equal(noOpRoleChange.response.status, 200, noOpRoleChange.text);

  const disabled = await request(`/api/admin/users/${liveUserId}/disable`, {
    method: 'POST',
    body: {},
    headers: { 'X-Request-ID': 'audit-user-disabled' },
  });
  assert.equal(disabled.response.status, 200, disabled.text);
  assert.equal(disabled.data.user.status, 'disabled');
  const disabledBusiness = await request('/api/config', { authentication: liveSession });
  assert.equal(disabledBusiness.response.status, 403, disabledBusiness.text);
  assert.equal(disabledBusiness.data.code, 'APP_ACCESS_DISABLED');
  const disabledMe = await request('/api/auth/me', { authentication: liveSession });
  assert.equal(disabledMe.response.status, 200, disabledMe.text);
  assert.equal(disabledMe.data.applicationUser.status, 'disabled');
  const disabledLogout = await request('/api/auth/logout', {
    method: 'POST', body: {}, authentication: secondLiveSession,
  });
  assert.equal(disabledLogout.response.status, 200, disabledLogout.text);

  const disabledRoleChange = await request(`/api/admin/users/${liveUserId}/role`, {
    method: 'PUT',
    body: {
      roleId: storekeeperRoleId,
      expectedAssignmentId: disabled.data.user.currentAssignmentId,
    },
    headers: { 'X-Request-ID': 'audit-user-role-storekeeper' },
  });
  assert.equal(disabledRoleChange.response.status, 200, disabledRoleChange.text);
  assert.equal(disabledRoleChange.data.user.status, 'disabled');
  assert.equal(disabledRoleChange.data.user.role.key, 'storekeeper');
  const enabled = await request(`/api/admin/users/${liveUserId}/enable`, {
    method: 'POST',
    body: {},
    headers: { 'X-Request-ID': 'audit-user-enabled' },
  });
  assert.equal(enabled.response.status, 200, enabled.text);
  assert.equal(enabled.data.user.status, 'active');
  assert.equal(enabled.data.user.role.key, 'storekeeper');
  assert.equal((await request('/api/config', { authentication: liveSession })).response.status, 200);
  assert.equal((await request('/api/admin/prices/ZZ', {
    authentication: liveSession,
  })).response.status, 403);

  const list = await request('/api/admin/users');
  assert.equal(list.response.status, 200, list.text);
  const listedLiveUser = list.data.users.find((user) => user.id === liveUserId);
  assert.deepEqual(Object.keys(listedLiveUser).sort(), [
    'currentAssignmentId',
    'displayName',
    'id',
    'identityLinked',
    'lastAuthenticatedAt',
    'preferredUsername',
    'role',
    'status',
  ]);
  assert.equal(listedLiveUser.identityLinked, true);
  assert.doesNotMatch(JSON.stringify(listedLiveUser), /issuer|subject|email|existing-session-role-change/);

  const auditEvents = await pool.query(
    `SELECT event_key, actor_user_id, actor_snapshot, request_id, details
     FROM audit_events
     WHERE subject_type = 'application_user' AND subject_id = $1
     ORDER BY id`,
    [String(liveUserId)]
  );
  assert.deepEqual(auditEvents.rows.map((row) => row.event_key), [
    'application_user.approved',
    'application_user.role_changed',
    'application_user.disabled',
    'application_user.role_changed',
    'application_user.enabled',
  ]);
  assert.deepEqual(auditEvents.rows.map((row) => row.request_id), [
    'audit-user-approved',
    'audit-user-role-manager',
    'audit-user-disabled',
    'audit-user-role-storekeeper',
    'audit-user-enabled',
  ]);
  assert.equal(auditEvents.rows.every(
    (row) => Number(row.actor_user_id) === administratorUserId
  ), true);
  assert.equal(auditEvents.rows.every((row) => (
    JSON.stringify(row.actor_snapshot) === JSON.stringify({
      displayName: 'Critical Flows',
      preferredUsername: 'critical.flows',
    })
  )), true);
  assert.equal(auditEvents.rows.some((row) => row.request_id === 'audit-user-role-no-op'), false);
  assert.deepEqual(auditEvents.rows[1].details, {
    userStatus: 'active',
    previousRole: {
      id: storekeeperRoleId,
      key: 'storekeeper',
      displayName: 'Storekeeper',
    },
    newRole: {
      id: managerRoleId,
      key: 'manager',
      displayName: 'Manager',
    },
  });

  await pool.query(
    `UPDATE application_users
     SET display_name = 'Changed Later', preferred_username = 'changed.later'
     WHERE id = $1`,
    [administratorUserId]
  );
  const historicalSnapshots = await pool.query(
    `SELECT actor_snapshot FROM audit_events
     WHERE subject_type = 'application_user' AND subject_id = $1
     ORDER BY id`,
    [String(liveUserId)]
  );
  assert.equal(historicalSnapshots.rows.every((row) => (
    JSON.stringify(row.actor_snapshot) === JSON.stringify({
      displayName: 'Critical Flows',
      preferredUsername: 'critical.flows',
    })
  )), true, 'historical actor snapshots must not follow mutable user profiles');
  await pool.query(
    `UPDATE application_users
     SET display_name = 'Critical Flows', preferred_username = 'critical.flows'
     WHERE id = $1`,
    [administratorUserId]
  );
});

test('roles.manage API provides protected Administrator and editable versioned roles', async () => {
  if (!suite.authenticatedSession) suite.authenticatedSession = await authenticateApplicationSession('/admin/roles');
  await replaceActiveRoleForTest(suite.authenticatedSession.applicationUser.id, 'administrator');

  const permissionsResponse = await request('/api/admin/roles/permissions');
  assert.equal(permissionsResponse.response.status, 200, permissionsResponse.text);
  assert.deepEqual(
    permissionsResponse.data.permissions
      .filter((permission) => permission.reserved)
      .map((permission) => permission.key),
    ['audit.view', 'roles.manage', 'users.manage']
  );

  let rolesResponse = await request('/api/admin/roles');
  assert.equal(rolesResponse.response.status, 200, rolesResponse.text);
  const administrator = rolesResponse.data.roles.find((role) => role.key === 'administrator');
  let manager = rolesResponse.data.roles.find((role) => role.key === 'manager');
  const storekeeper = rolesResponse.data.roles.find((role) => role.key === 'storekeeper');
  assert.equal(administrator.isProtected, true);
  assert.equal(manager.isProtected, false);
  assert.equal(manager.isSystem, true);

  const updatedStorekeeper = await request(`/api/admin/roles/${storekeeper.id}`, {
    method: 'PATCH',
    body: {
      displayName: storekeeper.displayName,
      description: `${storekeeper.description} (editable)`,
      expectedVersion: storekeeper.version,
    },
  });
  assert.equal(updatedStorekeeper.response.status, 200, updatedStorekeeper.text);
  assert.equal(updatedStorekeeper.data.role.version, storekeeper.version + 1);

  for (const [path, method, body] of [
    [`/api/admin/roles/${administrator.id}`, 'PATCH', {
      displayName: 'Changed Administrator',
      description: administrator.description,
      expectedVersion: administrator.version,
    }],
    [`/api/admin/roles/${administrator.id}/permissions`, 'PUT', {
      permissionKeys: administrator.permissionKeys.filter((key) => key !== 'products.view'),
      expectedVersion: administrator.version,
      expectedActiveAssignedUserCount: administrator.activeAssignedUserCount,
    }],
    [`/api/admin/roles/${administrator.id}/deactivate`, 'POST', {
      expectedVersion: administrator.version,
    }],
  ]) {
    const protectedResponse = await request(path, { method, body });
    assert.equal(protectedResponse.response.status, 409, protectedResponse.text);
    assert.equal(protectedResponse.data.code, 'ADMINISTRATOR_ROLE_PROTECTED');
  }

  const managerOriginal = {
    displayName: manager.displayName,
    description: manager.description,
    permissionKeys: manager.permissionKeys,
  };
  const concurrentManagerEdits = await Promise.all([
    request(`/api/admin/roles/${manager.id}`, {
      method: 'PATCH',
      body: {
        displayName: 'Manager concurrent A',
        description: manager.description,
        expectedVersion: manager.version,
      },
    }),
    request(`/api/admin/roles/${manager.id}`, {
      method: 'PATCH',
      body: {
        displayName: 'Manager concurrent B',
        description: manager.description,
        expectedVersion: manager.version,
      },
    }),
  ]);
  assert.deepEqual(
    concurrentManagerEdits.map((result) => result.response.status).sort(),
    [200, 409]
  );
  assert.equal(
    concurrentManagerEdits.find((result) => result.response.status === 409).data.code,
    'ROLE_VERSION_CONFLICT'
  );
  manager = concurrentManagerEdits.find((result) => result.response.status === 200).data.role;

  const noOpAuditBefore = Number((await pool.query(
    `SELECT COUNT(*) FROM audit_events
     WHERE subject_type = 'role' AND subject_id = $1 AND event_key = 'role.updated'`,
    [String(manager.id)]
  )).rows[0].count);
  const managerNoOp = await request(`/api/admin/roles/${manager.id}`, {
    method: 'PATCH',
    body: {
      displayName: manager.displayName,
      description: manager.description,
      expectedVersion: manager.version,
    },
    headers: { 'X-Request-ID': 'role-update-no-op' },
  });
  assert.equal(managerNoOp.response.status, 200, managerNoOp.text);
  assert.equal(Number((await pool.query(
    `SELECT COUNT(*) FROM audit_events
     WHERE subject_type = 'role' AND subject_id = $1 AND event_key = 'role.updated'`,
    [String(manager.id)]
  )).rows[0].count), noOpAuditBefore);

  const restoredManager = await request(`/api/admin/roles/${manager.id}`, {
    method: 'PATCH',
    body: {
      displayName: managerOriginal.displayName,
      description: `${managerOriginal.description} (editable)`,
      expectedVersion: manager.version,
    },
  });
  assert.equal(restoredManager.response.status, 200, restoredManager.text);
  manager = restoredManager.data.role;
  const reservedManagerGrant = await request(`/api/admin/roles/${manager.id}/permissions`, {
    method: 'PUT',
    body: {
      permissionKeys: [...manager.permissionKeys, 'roles.manage'],
      expectedVersion: manager.version,
      expectedActiveAssignedUserCount: manager.activeAssignedUserCount,
    },
  });
  assert.equal(reservedManagerGrant.response.status, 400, reservedManagerGrant.text);
  assert.equal(reservedManagerGrant.data.code, 'RESERVED_PERMISSION');

  const changedManagerPermissions = await request(`/api/admin/roles/${manager.id}/permissions`, {
    method: 'PUT',
    body: {
      permissionKeys: [...manager.permissionKeys, 'corrections.claim'],
      expectedVersion: manager.version,
      expectedActiveAssignedUserCount: manager.activeAssignedUserCount,
    },
  });
  assert.equal(changedManagerPermissions.response.status, 200, changedManagerPermissions.text);
  assert.equal(changedManagerPermissions.data.role.permissionKeys.includes('corrections.claim'), true);
  manager = changedManagerPermissions.data.role;
  const restoredManagerPermissions = await request(`/api/admin/roles/${manager.id}/permissions`, {
    method: 'PUT',
    body: {
      permissionKeys: managerOriginal.permissionKeys,
      expectedVersion: manager.version,
      expectedActiveAssignedUserCount: manager.activeAssignedUserCount,
    },
  });
  assert.equal(restoredManagerPermissions.response.status, 200, restoredManagerPermissions.text);

  const reservedCreate = await request('/api/admin/roles', {
    method: 'POST',
    body: {
      displayName: 'Forbidden security role',
      description: 'Must fail',
      permissionKeys: ['products.view', 'users.manage'],
    },
  });
  assert.equal(reservedCreate.response.status, 400, reservedCreate.text);
  assert.equal(reservedCreate.data.code, 'RESERVED_PERMISSION');

  const created = await request('/api/admin/roles', {
    method: 'POST',
    body: {
      displayName: 'Custom live access',
      description: 'Integration custom role',
      permissionKeys: ['products.view', 'products.decode'],
    },
    headers: { 'X-Request-ID': 'role-created' },
  });
  assert.equal(created.response.status, 201, created.text);
  let customRole = created.data.role;
  assert.equal(customRole.isSystem, false);
  assert.equal(customRole.isProtected, false);

  const duplicateName = await request('/api/admin/roles', {
    method: 'POST',
    body: {
      displayName: '  CUSTOM LIVE ACCESS  ',
      description: 'Case-insensitive duplicate',
      permissionKeys: [],
    },
  });
  assert.equal(duplicateName.response.status, 409, duplicateName.text);
  assert.equal(duplicateName.data.code, 'ROLE_DISPLAY_NAME_CONFLICT');

  const liveSession = await authenticateIdentitySession({
    subject: 'custom-role-live-permissions',
    preferredUsername: 'custom.role.live',
    displayName: 'Custom Role Live',
  });
  const approved = await request(`/api/admin/users/${liveSession.applicationUser.id}/approve`, {
    method: 'POST',
    body: { roleId: customRole.id },
  });
  assert.equal(approved.response.status, 200, approved.text);
  assert.equal((await request('/api/config', { authentication: liveSession })).response.status, 200);

  const permissionChange = await request(`/api/admin/roles/${customRole.id}/permissions`, {
    method: 'PUT',
    body: {
      permissionKeys: ['products.decode'],
      expectedVersion: customRole.version,
      expectedActiveAssignedUserCount: 1,
    },
    headers: { 'X-Request-ID': 'role-permissions-changed' },
  });
  assert.equal(permissionChange.response.status, 200, permissionChange.text);
  customRole = permissionChange.data.role;
  const permissionRevoked = await request('/api/config', { authentication: liveSession });
  assert.equal(permissionRevoked.response.status, 403, permissionRevoked.text);
  assert.equal(permissionRevoked.data.requiredPermission, 'products.view');

  const assignedDeactivation = await request(`/api/admin/roles/${customRole.id}/deactivate`, {
    method: 'POST', body: { expectedVersion: customRole.version },
  });
  assert.equal(assignedDeactivation.response.status, 409, assignedDeactivation.text);
  assert.equal(assignedDeactivation.data.code, 'ROLE_HAS_CURRENT_ASSIGNMENTS');
  const disabledUser = await request(`/api/admin/users/${liveSession.applicationUser.id}/disable`, {
    method: 'POST', body: {},
  });
  assert.equal(disabledUser.response.status, 200, disabledUser.text);
  const disabledAssignedDeactivation = await request(`/api/admin/roles/${customRole.id}/deactivate`, {
    method: 'POST', body: { expectedVersion: customRole.version },
  });
  assert.equal(disabledAssignedDeactivation.response.status, 409, disabledAssignedDeactivation.text);

  const reassigned = await request(`/api/admin/users/${liveSession.applicationUser.id}/role`, {
    method: 'PUT',
    body: {
      roleId: await roleIdForKey('storekeeper'),
      expectedAssignmentId: disabledUser.data.user.currentAssignmentId,
    },
  });
  assert.equal(reassigned.response.status, 200, reassigned.text);
  const deactivated = await request(`/api/admin/roles/${customRole.id}/deactivate`, {
    method: 'POST', body: { expectedVersion: customRole.version },
    headers: { 'X-Request-ID': 'role-deactivated' },
  });
  assert.equal(deactivated.response.status, 200, deactivated.text);
  const reactivated = await request(`/api/admin/roles/${customRole.id}/reactivate`, {
    method: 'POST', body: { expectedVersion: deactivated.data.role.version },
    headers: { 'X-Request-ID': 'role-reactivated' },
  });
  assert.equal(reactivated.response.status, 200, reactivated.text);
  customRole = reactivated.data.role;

  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_test_role_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced role audit failure';
    END;
    $$;
    CREATE TRIGGER fail_test_role_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION fail_test_role_audit();
  `);
  const failedUpdate = await request(`/api/admin/roles/${customRole.id}`, {
    method: 'PATCH',
    body: {
      displayName: 'Must roll back',
      description: customRole.description,
      expectedVersion: customRole.version,
    },
  });
  assert.equal(failedUpdate.response.status, 500, failedUpdate.text);
  await pool.query('DROP TRIGGER fail_test_role_audit ON audit_events');
  const afterFailedUpdate = await pool.query(
    'SELECT display_name, version FROM roles WHERE id = $1',
    [customRole.id]
  );
  assert.deepEqual(afterFailedUpdate.rows, [{
    display_name: customRole.displayName,
    version: String(customRole.version),
  }]);

  const roleAudit = await pool.query(
    `SELECT event_key, request_id, details
     FROM audit_events WHERE subject_type = 'role' AND subject_id = $1
     ORDER BY id`,
    [String(customRole.id)]
  );
  assert.deepEqual(roleAudit.rows.map((row) => row.event_key), [
    'role.created',
    'role.permissions_changed',
    'role.deactivated',
    'role.reactivated',
  ]);
  assert.equal(roleAudit.rows[1].details.removedPermissionKeys[0], 'products.view');
  assert.equal(roleAudit.rows.some((row) => row.request_id === 'role-update-no-op'), false);
});

test('a failed audit insert rolls back the entire user-administration mutation', async () => {
  const databaseName = 'amber_user_admin_audit_rollback_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const auditPool = new Pool({ connectionString: databaseUrl });
  try {
    await runNodeInDatabase(databaseUrl, `
      const db = require('./src/db/pool');
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations()
        .finally(() => db.end())
        .catch((error) => { console.error(error); process.exitCode = 1; });
    `);
    const administrator = await resolveOrCreateApplicationUser({
      issuer: 'https://audit-rollback.example/realms/amber',
      sub: 'audit-rollback-administrator',
      preferred_username: 'audit.rollback.admin',
      name: 'Audit Rollback Administrator',
      authenticatedAt: '2026-09-10T10:00:00.000Z',
    }, { databasePool: auditPool });
    await bootstrapAdministrator(administrator.id, { databasePool: auditPool });
    const pending = await resolveOrCreateApplicationUser({
      issuer: 'https://audit-rollback.example/realms/amber',
      sub: 'audit-rollback-pending',
      preferred_username: 'audit.rollback.pending',
      name: 'Audit Rollback Pending',
      authenticatedAt: '2026-09-10T10:01:00.000Z',
    }, { databasePool: auditPool });

    await auditPool.query(`
      CREATE OR REPLACE FUNCTION fail_test_user_admin_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced audit failure';
      END;
      $$;
      CREATE TRIGGER fail_test_user_admin_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_test_user_admin_audit();
    `);

    await assert.rejects(
      approveApplicationUser(pending.id, await roleIdForKey('manager', auditPool), {
        actorUserId: administrator.id,
        requestId: 'audit-rollback-request',
        databasePool: auditPool,
      }),
      /forced audit failure/
    );
    const state = await auditPool.query(
      `SELECT u.status,
              (SELECT count(*)::int FROM user_role_assignments a
               WHERE a.application_user_id = u.id) AS assignment_count,
              (SELECT count(*)::int FROM audit_events e
               WHERE e.subject_type = 'application_user' AND e.subject_id = u.id::text)
                AS audit_count
       FROM application_users u
       WHERE u.id = $1`,
      [pending.id]
    );
    assert.deepEqual(state.rows, [{
      status: 'pending',
      assignment_count: 0,
      audit_count: 0,
    }]);
  } finally {
    await auditPool.end();
    await dropTestDatabase(databaseName);
  }
});

test('last-Administrator protection is transactional and concurrency-safe', async () => {
  const databaseName = 'amber_user_admin_safety_test';
  const databaseUrl = await recreateTestDatabase(databaseName);
  const safetyPool = new Pool({ connectionString: databaseUrl, max: 8 });
  try {
    await runNodeInDatabase(databaseUrl, `
      const { runMigrations } = require('./src/db/run-migrations');
      runMigrations().catch((error) => { console.error(error); process.exit(1); });
    `);
    const first = await resolveOrCreateApplicationUser({
      issuer: 'https://user-admin-safety.example/realms/amber',
      sub: 'first-administrator',
      preferred_username: 'first.administrator',
      authenticatedAt: '2026-09-09T10:00:00.000Z',
    }, { databasePool: safetyPool });
    await bootstrapAdministrator(first.id, { databasePool: safetyPool });
    const administratorRoleId = await roleIdForKey('administrator', safetyPool);
    const managerRoleId = await roleIdForKey('manager', safetyPool);
    const storekeeperRoleId = await roleIdForKey('storekeeper', safetyPool);
    const firstAssignmentId = await currentAssignmentIdForUser(first.id, safetyPool);

    for (const operation of [
      () => disableApplicationUser(first.id, {
        actorUserId: first.id, databasePool: safetyPool,
      }),
      () => changeApplicationUserRole(first.id, managerRoleId, {
        actorUserId: first.id, databasePool: safetyPool,
        expectedAssignmentId: firstAssignmentId,
      }),
      () => changeApplicationUserRole(first.id, storekeeperRoleId, {
        actorUserId: first.id, databasePool: safetyPool,
        expectedAssignmentId: firstAssignmentId,
      }),
    ]) {
      await assert.rejects(operation, (error) => (
        error.statusCode === 409 && error.code === 'LAST_ADMINISTRATOR_REQUIRED'
      ));
      const unchanged = await safetyPool.query(
        `SELECT u.status, r.role_key
         FROM application_users u
         JOIN user_role_assignments a
           ON a.application_user_id = u.id AND a.revoked_at IS NULL
         JOIN roles r ON r.id = a.role_id
         WHERE u.id = $1`,
        [first.id]
      );
      assert.deepEqual(unchanged.rows, [{ status: 'active', role_key: 'administrator' }]);
    }

    const second = await resolveOrCreateApplicationUser({
      issuer: 'https://user-admin-safety.example/realms/amber',
      sub: 'second-administrator',
      preferred_username: 'second.administrator',
      authenticatedAt: '2026-09-09T10:01:00.000Z',
    }, { databasePool: safetyPool });
    await approveApplicationUser(second.id, administratorRoleId, {
      actorUserId: first.id, databasePool: safetyPool,
    });

    const selfDemoted = await changeApplicationUserRole(first.id, managerRoleId, {
      actorUserId: first.id, databasePool: safetyPool,
      expectedAssignmentId: firstAssignmentId,
    });
    assert.equal(selfDemoted.role.key, 'manager');
    await changeApplicationUserRole(first.id, administratorRoleId, {
      actorUserId: second.id, databasePool: safetyPool,
      expectedAssignmentId: selfDemoted.currentAssignmentId,
    });
    const selfDisabled = await disableApplicationUser(second.id, {
      actorUserId: second.id, databasePool: safetyPool,
    });
    assert.equal(selfDisabled.status, 'disabled');
    await enableApplicationUser(second.id, undefined, {
      actorUserId: first.id, databasePool: safetyPool,
    });

    const assignmentRaceUser = await resolveOrCreateApplicationUser({
      issuer: 'https://user-admin-safety.example/realms/amber',
      sub: 'assignment-race-user',
      preferred_username: 'assignment.race',
      authenticatedAt: '2026-09-09T10:02:00.000Z',
    }, { databasePool: safetyPool });
    await approveApplicationUser(assignmentRaceUser.id, managerRoleId, {
      actorUserId: first.id, databasePool: safetyPool,
    });
    const assignmentRaceExpected = await currentAssignmentIdForUser(
      assignmentRaceUser.id,
      safetyPool
    );
    const assignmentRace = await Promise.allSettled([
      changeApplicationUserRole(assignmentRaceUser.id, storekeeperRoleId, {
        actorUserId: first.id,
        databasePool: safetyPool,
        expectedAssignmentId: assignmentRaceExpected,
      }),
      changeApplicationUserRole(assignmentRaceUser.id, administratorRoleId, {
        actorUserId: first.id,
        databasePool: safetyPool,
        expectedAssignmentId: assignmentRaceExpected,
      }),
    ]);
    assert.deepEqual(
      assignmentRace.map((result) => result.status).sort(),
      ['fulfilled', 'rejected']
    );
    assert.equal(
      assignmentRace.find((result) => result.status === 'rejected').reason.code,
      'APPLICATION_USER_ASSIGNMENT_CONFLICT'
    );
    assert.equal(Number((await safetyPool.query(
      `SELECT COUNT(*) FROM user_role_assignments
       WHERE application_user_id = $1 AND revoked_at IS NULL`,
      [assignmentRaceUser.id]
    )).rows[0].count), 1);
    const raceWinner = assignmentRace.find((result) => result.status === 'fulfilled').value;
    if (raceWinner.role.key === 'administrator') {
      await changeApplicationUserRole(assignmentRaceUser.id, managerRoleId, {
        actorUserId: first.id,
        databasePool: safetyPool,
        expectedAssignmentId: raceWinner.currentAssignmentId,
      });
    }

    await safetyPool.query(`
      CREATE OR REPLACE FUNCTION delay_test_application_user_disable()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.2);
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER delay_test_application_user_disable
      BEFORE UPDATE OF status ON application_users
      FOR EACH ROW
      WHEN (OLD.status = 'active' AND NEW.status = 'disabled')
      EXECUTE FUNCTION delay_test_application_user_disable();
    `);
    const concurrent = await Promise.allSettled([
      disableApplicationUser(first.id, {
        actorUserId: first.id, databasePool: safetyPool,
      }),
      disableApplicationUser(second.id, {
        actorUserId: second.id, databasePool: safetyPool,
      }),
    ]);
    assert.deepEqual(
      concurrent.map((result) => result.status).sort(),
      ['fulfilled', 'rejected']
    );
    const conflict = concurrent.find((result) => result.status === 'rejected').reason;
    assert.equal(conflict.code, 'LAST_ADMINISTRATOR_REQUIRED');
    const activeAdministrators = await safetyPool.query(
      `SELECT u.id
       FROM application_users u
       JOIN user_role_assignments a
         ON a.application_user_id = u.id AND a.revoked_at IS NULL
       JOIN roles r ON r.id = a.role_id
       WHERE u.status = 'active'
         AND r.role_key = 'administrator'
         AND r.is_system = TRUE
         AND r.status = 'active'`
    );
    assert.equal(activeAdministrators.rows.length, 1);
    const safetyState = await safetyPool.query(
      `SELECT u.status, r.role_key, a.revoked_at
       FROM application_users u
       JOIN user_role_assignments a
         ON a.application_user_id = u.id AND a.revoked_at IS NULL
       JOIN roles r ON r.id = a.role_id
       WHERE u.id = ANY($1::bigint[])
       ORDER BY u.id`,
      [[first.id, second.id]]
    );
    assert.equal(safetyState.rows.length, 2);
    assert.equal(safetyState.rows.filter((row) => row.status === 'active').length, 1);
    assert.equal(safetyState.rows.every((row) => row.role_key === 'administrator'), true);
  } finally {
    await safetyPool.end();
    await dropTestDatabase(databaseName);
  }
});

test('global audit viewer enforces audit.view and returns safe deterministic filtered pages', async () => {
  const suffix = Date.now();
  const adminIdentity = {
    issuer: 'https://audit-viewer.example/realms/amber',
    subject: `audit-admin-${suffix}`,
    preferredUsername: 'audit.admin.current',
    displayName: 'Current Audit Admin',
  };
  const adminSession = await authenticateIdentitySession(adminIdentity);
  const actorUserId = await activateApplicationUserForTest(
    adminIdentity.issuer, adminIdentity.subject, 'administrator'
  );
  const managerIdentity = {
    issuer: adminIdentity.issuer,
    subject: `audit-manager-${suffix}`,
    preferredUsername: 'audit.manager',
    displayName: 'Audit Manager',
  };
  const managerSession = await authenticateIdentitySession(managerIdentity);
  await activateApplicationUserForTest(managerIdentity.issuer, managerIdentity.subject, 'manager');
  const pendingSession = await authenticateIdentitySession({
    issuer: adminIdentity.issuer,
    subject: `audit-pending-${suffix}`,
    preferredUsername: 'audit.pending',
    displayName: 'Audit Pending',
  });
  const disabledIdentity = {
    issuer: adminIdentity.issuer,
    subject: `audit-disabled-${suffix}`,
    preferredUsername: 'audit.disabled',
    displayName: 'Audit Disabled',
  };
  const disabledSession = await authenticateIdentitySession(disabledIdentity);
  const disabledUserId = await activateApplicationUserForTest(
    disabledIdentity.issuer, disabledIdentity.subject, 'manager'
  );
  await pool.query(
    `UPDATE application_users SET status = 'disabled', deactivated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [disabledUserId]
  );

  assert.equal((await request('/api/admin/audit-events', { authentication: null })).response.status, 401);
  assert.equal((await request('/api/admin/audit-events', { authentication: pendingSession })).data.code, 'APP_ACCESS_PENDING');
  assert.equal((await request('/api/admin/audit-events', { authentication: disabledSession })).data.code, 'APP_ACCESS_DISABLED');
  const denied = await request('/api/admin/audit-events', { authentication: managerSession });
  assert.equal(denied.response.status, 403, denied.text);
  assert.equal(denied.data.code, 'INSUFFICIENT_PERMISSION');

  const occurredAt = '2099-01-01T12:00:00.000Z';
  const fixtures = [
    ['application_user.role_changed', 'application_user', '501', { previousRole: { displayName: 'Manager' }, newRole: { displayName: 'Storekeeper' } }],
    ['role.permissions_changed', 'role', '502', { addedPermissionKeys: ['products.view'], removedPermissionKeys: ['pricing.view'] }],
    ['catalog.category.updated', 'catalog_category', 'AU', { code: 'AU', changes: { name: { before: 'Old', after: 'New' } } }],
    ['pricing.matrix_cell.set', 'pricing_matrix_cell', '9:1:0', { categoryCode: 'AU', oldPrice: 10.25, newPrice: 11.5 }],
    ['product.created', 'product', '503', { fullSku: 'AU-EXACT-503', requestId: 'never-return', sessionData: 'never-return' }],
    ['product.recounted', 'product', '504', { sourceSku: 'AU-OLD', correctedSku: 'AU-NEW', correctionRequestId: 600 }],
    ['product.archived', 'product', '509', { fullSku: 'AU-ARCHIVED-509' }],
    ['correction_request.force_released', 'correction_request', '505', { previousOwnerUserId: 77, claimToken: 'never-return', claimVersion: 4 }],
    ['repricing.applied', 'repricing_batch', '506', { draftId: 700 }],
    ['repricing.rolled_back', 'repricing_batch', '510', {}],
    ['export_snapshot.created', 'export_snapshot', '511', { fromSku: 'AU-1', toSku: 'AU-9', rowCount: 9 }],
    ['export_snapshot.confirmed', 'export_snapshot', '507', { exportedToProductId: 503 }],
    ['sku_schema.published', 'sku_schema_version', '508', { categoryCode: 'AU', version: 3 }],
    ['future_domain.future_action', 'future_subject', 'future-id', { name: 'not-allowlisted-for-unknown-events' }],
  ];
  for (const [eventKey, subjectType, subjectId, details] of fixtures) {
    await pool.query(
      `INSERT INTO audit_events
       (event_key, actor_user_id, actor_snapshot, subject_type, subject_id, details, occurred_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7::timestamptz)`,
      [eventKey, actorUserId, JSON.stringify({
        displayName: eventKey === 'future_domain.future_action' ? null : 'Historical Audit Admin',
        preferredUsername: eventKey === 'future_domain.future_action' ? null : 'audit.admin.historical',
      }), subjectType, subjectId, JSON.stringify(details), occurredAt]
    );
  }
  await pool.query(
    `UPDATE application_users
     SET display_name = 'Mutated Current Name', preferred_username = 'mutated.current'
     WHERE id = $1`,
    [actorUserId]
  );

  const baseQuery = 'from=2099-01-01T00%3A00%3A00Z&to=2099-01-02T00%3A00%3A00Z';
  const first = await request(`/api/admin/audit-events?${baseQuery}&limit=4`, { authentication: adminSession });
  assert.equal(first.response.status, 200, first.text);
  assert.equal(first.data.items.length, 4);
  assert.equal(first.data.page.hasMore, true);
  assert.ok(first.data.page.nextCursor);
  const allItems = [...first.data.items];
  let currentPage = first.data.page;
  while (currentPage.hasMore) {
    const next = await request(
      `/api/admin/audit-events?${baseQuery}&limit=4&cursor=${encodeURIComponent(currentPage.nextCursor)}`,
      { authentication: adminSession }
    );
    assert.equal(next.response.status, 200, next.text);
    allItems.push(...next.data.items);
    currentPage = next.data.page;
  }
  assert.equal(allItems.length, fixtures.length);
  assert.equal(new Set(allItems.map((event) => `${event.eventKey}:${event.subject.id}`)).size, fixtures.length);
  assert.equal(allItems.every((event) => !Object.hasOwn(event, 'id')), true);
  assert.equal(allItems.every((event) => event.actor.displayName !== 'Mutated Current Name'), true);
  assert.equal(allItems.find((event) => event.eventKey === 'product.created').actor.displayName, 'Historical Audit Admin');
  assert.equal(allItems.find((event) => event.eventKey === 'future_domain.future_action').actor.status, 'recorded_reference');
  assert.deepEqual(allItems.find((event) => event.eventKey === 'future_domain.future_action').details, {});
  assert.deepEqual(allItems.find((event) => event.eventKey === 'product.created').details, { fullSku: 'AU-EXACT-503' });
  assert.doesNotMatch(JSON.stringify(allItems), /never-return|requestId|claimToken|sessionData|draftId|claimVersion/);

  const catalog = await request(`/api/admin/audit-events?${baseQuery}&domain=catalog`, { authentication: adminSession });
  assert.deepEqual(catalog.data.items.map((event) => event.eventKey), ['catalog.category.updated']);
  const actor = await request(`/api/admin/audit-events?${baseQuery}&actorId=${actorUserId}`, { authentication: adminSession });
  assert.equal(actor.data.items.length, fixtures.length);
  const subject = await request(`/api/admin/audit-events?${baseQuery}&subjectType=product&subjectId=503`, { authentication: adminSession });
  assert.deepEqual(subject.data.items.map((event) => event.eventKey), ['product.created']);
  const exact = await request(`/api/admin/audit-events?${baseQuery}&eventKey=sku_schema.published`, { authentication: adminSession });
  assert.deepEqual(exact.data.items[0].details, { categoryCode: 'AU', version: 3 });

  const reusedCursor = await request(
    `/api/admin/audit-events?${baseQuery}&domain=role&cursor=${encodeURIComponent(first.data.page.nextCursor)}`,
    { authentication: adminSession }
  );
  assert.equal(reusedCursor.response.status, 400);
  assert.equal(reusedCursor.data.code, 'INVALID_CURSOR');
});
