const suite = require('./suite-context');
const {
  assert,
  test,
  pool,
  request,
  authenticateApplicationSession,
  schemas,
} = suite;

test('product create, direct recount, and archive share local actor attribution and audit', async () => {
  const actorUserId = suite.authenticatedSession.applicationUser.id;
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(preview.response.status, 200, preview.text);
  const created = await request('/api/save', {
    method: 'POST',
    headers: { 'X-Request-ID': 'audit-product-created' },
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: preview.data.previewToken,
    },
  });
  assert.equal(created.response.status, 200, created.text);
  const sourceProductId = Number(created.data.id);
  assert.equal(Number((await pool.query(
    'SELECT created_by_user_id FROM products WHERE id = $1', [sourceProductId]
  )).rows[0].created_by_user_id), actorUserId);
  assert.deepEqual((await pool.query(
    `SELECT event_key, actor_user_id, request_id, details
     FROM audit_events WHERE subject_type = 'product' AND subject_id = $1 ORDER BY id`,
    [String(sourceProductId)]
  )).rows, [{
    event_key: 'product.created',
    actor_user_id: String(actorUserId),
    request_id: 'audit-product-created',
    details: { fullSku: created.data.fullSku, categoryCode: 'ZZ' },
  }]);

  const recountPayload = {
    sourceSku: created.data.fullSku,
    answers: { kind: 2 },
    reason: 'actor attribution test',
  };
  const recountPreview = await request('/api/recount/preview', {
    method: 'POST', body: recountPayload,
  });
  assert.equal(recountPreview.response.status, 200, recountPreview.text);
  const recounted = await request('/api/recount/apply', {
    method: 'POST',
    headers: { 'X-Request-ID': 'audit-product-recounted' },
    body: recountPayload,
  });
  assert.equal(recounted.response.status, 200, recounted.text);
  const correctedProductId = Number(recounted.data.correctedProductId);
  const recountState = await pool.query(
    `SELECT source.status AS source_status,
            source.exclude_from_export AS source_excluded,
            corrected.created_by_user_id,
            corrected.exclude_from_export AS corrected_excluded,
            pc.id AS product_correction_id,
            pc.performed_by_user_id
     FROM products source
     JOIN products corrected ON corrected.id = source.corrected_to_product_id
     JOIN product_corrections pc
       ON pc.source_product_id = source.id AND pc.corrected_product_id = corrected.id
     WHERE source.id = $1`,
    [sourceProductId]
  );
  assert.equal(recountState.rows[0].source_status, 'corrected');
  assert.equal(Number(recountState.rows[0].source_excluded), 1);
  assert.equal(Number(recountState.rows[0].corrected_excluded), 1);
  assert.equal(Number(recountState.rows[0].created_by_user_id), actorUserId);
  assert.equal(Number(recountState.rows[0].performed_by_user_id), actorUserId);
  const productCorrectionId = Number(recountState.rows[0].product_correction_id);
  assert.deepEqual((await pool.query(
    `SELECT event_key, actor_user_id, request_id, details
     FROM audit_events
     WHERE event_key = 'product.recounted'
       AND subject_type = 'product' AND subject_id = $1`,
    [String(sourceProductId)]
  )).rows, [{
    event_key: 'product.recounted',
    actor_user_id: String(actorUserId),
    request_id: 'audit-product-recounted',
    details: {
      sourceSku: created.data.fullSku,
      correctedProductId,
      correctedSku: recounted.data.corrected.fullSku,
      productCorrectionId,
    },
  }]);

  const archived = await request('/api/delete', {
    method: 'POST',
    headers: { 'X-Request-ID': 'audit-product-archived' },
    body: { skuToDelete: recounted.data.corrected.fullSku },
  });
  assert.equal(archived.response.status, 200, archived.text);
  assert.deepEqual((await pool.query(
    'SELECT status, archived_by_user_id FROM products WHERE id = $1', [correctedProductId]
  )).rows, [{ status: 'archived', archived_by_user_id: String(actorUserId) }]);
  assert.deepEqual((await pool.query(
    `SELECT event_key, actor_user_id, request_id, details
     FROM audit_events
     WHERE event_key = 'product.archived'
       AND subject_type = 'product' AND subject_id = $1`,
    [String(correctedProductId)]
  )).rows, [{
    event_key: 'product.archived',
    actor_user_id: String(actorUserId),
    request_id: 'audit-product-archived',
    details: { fullSku: recounted.data.corrected.fullSku },
  }]);

  const repeatedArchive = await request('/api/delete', {
    method: 'POST',
    headers: { 'X-Request-ID': 'audit-product-archive-no-op' },
    body: { skuToDelete: recounted.data.corrected.fullSku },
  });
  assert.equal(repeatedArchive.response.status, 404, repeatedArchive.text);
  assert.equal(Number((await pool.query(
    `SELECT count(*) FROM audit_events
     WHERE event_key = 'product.archived' AND subject_id = $1`,
    [String(correctedProductId)]
  )).rows[0].count), 1);
});

test('product timeline resolves every actual SKU across corrections and combines business history', async () => {
  const actorUserId = Number(suite.authenticatedSession.applicationUser.id);
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(preview.response.status, 200, preview.text);
  const created = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ, previewToken: preview.data.previewToken,
    },
  });
  assert.equal(created.response.status, 200, created.text);
  const skuA = created.data.fullSku;

  const direct = await request('/api/recount/apply', {
    method: 'POST',
    body: { sourceSku: skuA, answers: { kind: 2 }, reason: 'timeline direct correction' },
  });
  assert.equal(direct.response.status, 200, direct.text);
  const skuB = direct.data.corrected.fullSku;

  const correctionRequest = await request('/api/admin/correction-requests', {
    method: 'POST',
    body: { sourceSku: skuB, answers: { kind: 1 }, reason: 'timeline requested correction' },
  });
  assert.equal(correctionRequest.response.status, 200, correctionRequest.text);
  const correctionRequestId = Number(correctionRequest.data.request.id);
  const claim = await request(`/api/admin/correction-requests/${correctionRequestId}/claim`, {
    method: 'POST', body: {},
  });
  assert.equal(claim.response.status, 200, claim.text);
  const completed = await request(`/api/admin/correction-requests/${correctionRequestId}/complete`, {
    method: 'POST', body: { claimVersion: claim.data.request.claimVersion },
  });
  assert.equal(completed.response.status, 200, completed.text);
  const skuC = completed.data.request.finalPayload.fullSku;
  const currentProduct = await pool.query(
    'SELECT id, total_price_uah, details FROM products WHERE full_sku = $1', [skuC]
  );
  const currentProductId = Number(currentProduct.rows[0].id);
  const oldPrice = Number(currentProduct.rows[0].total_price_uah);
  const newPrice = oldPrice + 125;
  const batch = await pool.query(
    `INSERT INTO repricing_batches
       (scope, scenario_name, scenario_snapshot, preview_token, status, candidate_count,
        changed_count, applied_at, rolled_back_at, applied_by_user_id, rolled_back_by_user_id)
     VALUES ('global', 'Timeline fixture', '{}'::jsonb, $1, 'rolled_back', 1, 1,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '1 second', $2, $2)
     RETURNING id`,
    [`timeline-${Date.now()}`, actorUserId]
  );
  const batchId = Number(batch.rows[0].id);
  await pool.query(
    `INSERT INTO repricing_items
       (batch_id, product_id, sku, old_price_uah, new_price_uah, price_delta_uah,
        old_payload, new_payload)
     VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::numeric,
       jsonb_build_object('totalPriceUah', $4::numeric, 'details', $7::jsonb),
       jsonb_build_object('totalPriceUah', $5::numeric, 'details', $7::jsonb))`,
    [batchId, currentProductId, skuC, oldPrice, newPrice, 125, JSON.stringify(currentProduct.rows[0].details || {})]
  );
  const actorSnapshot = JSON.stringify({ displayName: 'Critical Flows', preferredUsername: 'critical.flows' });
  await pool.query(
    `INSERT INTO audit_events
       (event_key, actor_user_id, actor_snapshot, subject_type, subject_id, details, occurred_at)
     VALUES
       ('repricing.applied', $1, $2::jsonb, 'repricing_batch', $3, '{}'::jsonb, CURRENT_TIMESTAMP),
       ('repricing.rolled_back', $1, $2::jsonb, 'repricing_batch', $3, '{}'::jsonb,
        CURRENT_TIMESTAMP + INTERVAL '1 second')`,
    [actorUserId, actorSnapshot, String(batchId)]
  );
  const archived = await request('/api/delete', {
    method: 'POST', body: { skuToDelete: skuC },
  });
  assert.equal(archived.response.status, 200, archived.text);

  const timelines = await Promise.all([skuA, skuB, skuC].map((sku) => (
    request(`/api/product-timeline?sku=${encodeURIComponent(sku)}`)
  )));
  for (const timeline of timelines) assert.equal(timeline.response.status, 200, timeline.text);
  const expectedSkus = [skuA, skuB, skuC];
  for (const timeline of timelines) {
    assert.deepEqual(timeline.data.lineage.products.map((product) => product.sku), expectedSkus);
    assert.equal(timeline.data.lineage.currentSku, skuC);
    assert.equal(timeline.data.lineage.integrity, 'ok');
    const types = timeline.data.events.map((event) => event.type);
    assert.ok(types.includes('product.created'));
    assert.equal(types.filter((type) => type === 'product.corrected').length, 2);
    assert.ok(types.includes('correction_request.created'));
    assert.ok(types.includes('correction_request.claimed'));
    assert.ok(types.includes('correction_request.completed'));
    assert.ok(types.includes('repricing.applied'));
    assert.ok(types.includes('repricing.rolled_back'));
    assert.ok(types.includes('product.archived'));
    const requestCompletion = timeline.data.events.find((event) => event.type === 'correction_request.completed');
    const requestedCorrection = timeline.data.events.find((event) => (
      event.type === 'product.corrected' && event.details.applicationMode === 'request'
    ));
    assert.equal(requestCompletion.groupKey, requestedCorrection.groupKey);
    assert.equal(JSON.stringify(timeline.data).includes('correctionRequestId'), false);
    assert.equal(JSON.stringify(timeline.data).includes('claimVersion'), false);
    assert.equal(Object.hasOwn(timeline.data.events[0], 'evidence'), false);
  }
  assert.deepEqual(
    timelines[0].data.events.map((event) => event.type),
    timelines[2].data.events.map((event) => event.type)
  );

  const missing = await request('/api/product-timeline?sku=ZZ-NOT-A-PRODUCT');
  assert.equal(missing.response.status, 404, missing.text);
  assert.equal(missing.data.code, 'SKU_HISTORY_NOT_FOUND');
  const invalid = await request('/api/product-timeline?sku=');
  assert.equal(invalid.response.status, 400, invalid.text);
  assert.equal(invalid.data.code, 'INVALID_SKU');
});

test('a failed product audit insert rolls back product creation and SKU reservation', async () => {
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(preview.response.status, 200, preview.text);
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_test_product_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced product audit failure';
    END;
    $$;
    CREATE TRIGGER fail_test_product_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW
    WHEN (NEW.event_key = 'product.created')
    EXECUTE FUNCTION fail_test_product_audit();
  `);
  try {
    const failed = await request('/api/save', {
      method: 'POST',
      headers: { 'X-Request-ID': 'audit-product-create-rollback' },
      body: {
        category: 'ZZ',
        answers: { kind: 1 },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: preview.data.previewToken,
      },
    });
    assert.equal(failed.response.status, 500, failed.text);
    assert.equal(Number((await pool.query(
      'SELECT count(*) FROM products WHERE full_sku = $1', [preview.data.fullProposedSku]
    )).rows[0].count), 0);
    assert.equal(Number((await pool.query(
      'SELECT count(*) FROM sku_registry WHERE full_sku = $1', [preview.data.fullProposedSku]
    )).rows[0].count), 0);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE event_key = 'product.created' AND request_id = 'audit-product-create-rollback'`
    )).rows[0].count), 0);
  } finally {
    await pool.query('DROP TRIGGER fail_test_product_audit ON audit_events');
    await pool.query('DROP FUNCTION fail_test_product_audit()');
  }
});

test('role revocation is reflected immediately without replacing the active session', async () => {
  const userId = suite.authenticatedSession.applicationUser.id;
  await pool.query(
    `UPDATE user_role_assignments
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE application_user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
  const meWithoutRole = await request('/api/auth/me');
  assert.equal(meWithoutRole.response.status, 200, meWithoutRole.text);
  assert.deepEqual(meWithoutRole.data.roles, []);
  assert.deepEqual(meWithoutRole.data.permissions, []);
  const stillActive = await request('/api/config');
  assert.equal(stillActive.response.status, 403, stillActive.text);
  assert.equal(stillActive.data.code, 'INSUFFICIENT_PERMISSION');
  assert.equal(stillActive.data.requiredPermission, 'products.view');

  const administratorRole = await pool.query(
    "SELECT id FROM roles WHERE role_key = 'administrator'"
  );
  await pool.query(
    `INSERT INTO user_role_assignments (application_user_id, role_id)
     VALUES ($1, $2)`,
    [userId, administratorRole.rows[0].id]
  );
  const restoredMe = await request('/api/auth/me');
  assert.equal(restoredMe.data.permissions.length, 26);
  const permittedAgain = await request('/api/config');
  assert.equal(permittedAgain.response.status, 200, permittedAgain.text);
});

test('an expired PostgreSQL application session returns JSON 401', async () => {
  await pool.query(`
    UPDATE "session"
    SET expire = NOW() - INTERVAL '1 minute'
    WHERE sess->'identity'->>'sub' = 'critical-flows-subject'
  `);
  const expired = await request('/api/config');
  assert.equal(expired.response.status, 401, expired.text);
  assert.deepEqual(expired.data, { error: 'Authentication required' });
  assert.equal(expired.response.headers.get('location'), null);

  suite.authenticatedSession = await authenticateApplicationSession('/');
});
