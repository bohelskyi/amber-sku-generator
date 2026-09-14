const suite = require('./suite-context');
const {
  assert,
  crypto,
  test,
  pool,
  request,
  activateApplicationUserForTest,
  replaceActiveRoleForTest,
  authenticateIdentitySession,
} = suite;

async function createReexportProduct({ excludeFromExport = 0, priceUah = 2400 } = {}) {
  const fullSku = `RX${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const result = await pool.query(
    `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price,
        total_price_uah, price_per_gram, uah_rate, details, sku_schema_version_id,
        exclude_from_export)
     VALUES ($1, $1, 0, 'LN', 10, $2, $3, 6, 40,
       '{"answers":{"raw_type":1,"size":3,"shape":6,"is_calibrated":1},"isCalibrated":1}'::jsonb,
       $4, $5)
     RETURNING id, full_sku`,
    [fullSku, priceUah / 40, priceUah, suite.schemas.LN, excludeFromExport]
  );
  return result.rows[0];
}

async function changeManualPrice(productId, manualPriceUah) {
  const pricingDecision = {
    mode: 'manual_uah',
    manualPriceUah,
    marketingRoundingEnabled: false,
  };
  const preview = await request('/api/product-price-change/preview', {
    method: 'POST', body: { productId, pricingDecision },
  });
  assert.equal(preview.response.status, 200, preview.text);
  const applied = await request('/api/product-price-change/apply', {
    method: 'POST',
    body: { productId, pricingDecision, previewToken: preview.data.previewToken },
  });
  assert.equal(applied.response.status, 200, applied.text);
  return applied.data;
}

async function createSnapshot(fromSku, toSku = fromSku) {
  const result = await request('/api/export/snapshots', {
    method: 'POST',
    headers: { 'Idempotency-Key': `reexport-${crypto.randomUUID()}` },
    body: { fromSku, toSku },
  });
  assert.equal(result.response.status, 201, result.text);
  return result.data;
}

async function confirmSnapshot(snapshotId) {
  const result = await request(`/api/export/snapshots/${snapshotId}/confirm`, {
    method: 'POST', body: {},
  });
  assert.equal(result.response.status, 200, result.text);
  return result.data;
}

async function snapshotCsv(snapshotId) {
  const result = await request(`/api/export/snapshots/${snapshotId}/csv`);
  assert.equal(result.response.status, 200, result.text);
  return result.text;
}

function csvRowsForSku(csv, sku) {
  return csv.split(/\r?\n/).filter((line) => line.startsWith(`${sku},`));
}

test('export snapshot creation and confirmation are attributed, audited, and idempotent', async () => {
  const exportSku = (await pool.query(
    `SELECT full_sku FROM products
     WHERE COALESCE(exclude_from_export, 0) = 0
     ORDER BY id DESC LIMIT 1`
  )).rows[0].full_sku;
  const creatorUserId = Number(suite.authenticatedSession.applicationUser.id);
  const confirmerSession = await authenticateIdentitySession({
    issuer: 'https://export-attribution.example/realms/amber',
    subject: 'export-confirmer',
    preferredUsername: 'export.confirmer',
    displayName: 'Export Confirmer',
  });
  const confirmerUserId = await activateApplicationUserForTest(
    'https://export-attribution.example/realms/amber',
    'export-confirmer',
    'administrator'
  );
  try {
    const idempotencyKey = 'integration-export-attribution';
  const created = await request('/api/export/snapshots', {
    method: 'POST',
    headers: {
      'Idempotency-Key': idempotencyKey,
      'X-Request-ID': 'export-snapshot-created',
    },
    body: { fromSku: exportSku, toSku: exportSku },
  });
  assert.equal(created.response.status, 201, created.text);
  const snapshotId = created.data.id;
  assert.deepEqual((await pool.query(
    `SELECT created_by_user_id, confirmed_by_user_id, status
     FROM export_snapshots WHERE id = $1`,
    [snapshotId]
  )).rows, [{
    created_by_user_id: String(creatorUserId),
    confirmed_by_user_id: null,
    status: 'generated',
  }]);
  const createdAudit = await pool.query(
    `SELECT event_key, actor_user_id, request_id, subject_type, subject_id, details
     FROM audit_events
     WHERE event_key = 'export_snapshot.created' AND subject_id = $1`,
    [snapshotId]
  );
  assert.deepEqual(createdAudit.rows, [{
    event_key: 'export_snapshot.created',
    actor_user_id: String(creatorUserId),
    request_id: 'export-snapshot-created',
    subject_type: 'export_snapshot',
    subject_id: snapshotId,
    details: { fromSku: exportSku, toSku: exportSku, rowCount: 1 },
  }]);

  const reused = await request('/api/export/snapshots', {
    method: 'POST',
    authentication: confirmerSession,
    headers: {
      'Idempotency-Key': idempotencyKey,
      'X-Request-ID': 'export-snapshot-reused',
    },
    body: { fromSku: exportSku, toSku: exportSku },
  });
  assert.equal(reused.response.status, 201, reused.text);
  assert.equal(reused.data.id, snapshotId);
  assert.equal(Number((await pool.query(
    'SELECT created_by_user_id FROM export_snapshots WHERE id = $1',
    [snapshotId]
  )).rows[0].created_by_user_id), creatorUserId);
  assert.equal(Number((await pool.query(
    `SELECT count(*) FROM audit_events
     WHERE event_key = 'export_snapshot.created' AND subject_id = $1`,
    [snapshotId]
  )).rows[0].count), 1);

  const confirmed = await request(`/api/export/snapshots/${snapshotId}/confirm`, {
    method: 'POST',
    authentication: confirmerSession,
    headers: { 'X-Request-ID': 'export-snapshot-confirmed' },
    body: {},
  });
  assert.equal(confirmed.response.status, 200, confirmed.text);
  assert.equal(Number((await pool.query(
    'SELECT confirmed_by_user_id FROM export_snapshots WHERE id = $1',
    [snapshotId]
  )).rows[0].confirmed_by_user_id), confirmerUserId);
  const confirmedAudit = await pool.query(
    `SELECT event_key, actor_user_id, request_id, subject_type, subject_id, details
     FROM audit_events
     WHERE event_key = 'export_snapshot.confirmed' AND subject_id = $1`,
    [snapshotId]
  );
  assert.equal(confirmedAudit.rows.length, 1);
  assert.deepEqual(confirmedAudit.rows[0], {
    event_key: 'export_snapshot.confirmed',
    actor_user_id: String(confirmerUserId),
    request_id: 'export-snapshot-confirmed',
    subject_type: 'export_snapshot',
    subject_id: snapshotId,
    details: {
      exportedToProductId: Number((await pool.query(
        'SELECT exported_to_product_id FROM export_snapshots WHERE id = $1',
        [snapshotId]
      )).rows[0].exported_to_product_id),
    },
  });

  const repeatedConfirmation = await request(`/api/export/snapshots/${snapshotId}/confirm`, {
    method: 'POST',
    headers: { 'X-Request-ID': 'export-snapshot-confirmed-again' },
    body: {},
  });
  assert.equal(repeatedConfirmation.response.status, 200, repeatedConfirmation.text);
  assert.equal(Number((await pool.query(
    'SELECT confirmed_by_user_id FROM export_snapshots WHERE id = $1',
    [snapshotId]
  )).rows[0].confirmed_by_user_id), confirmerUserId);
  assert.equal(Number((await pool.query(
    `SELECT count(*) FROM audit_events
     WHERE event_key = 'export_snapshot.confirmed' AND subject_id = $1`,
    [snapshotId]
  )).rows[0].count), 1);

  await assert.rejects(
    pool.query('UPDATE export_snapshots SET created_by_user_id = $1 WHERE id = $2', [
      confirmerUserId,
      snapshotId,
    ]),
    /immutable/
  );
  await assert.rejects(
    pool.query('UPDATE export_snapshots SET confirmed_by_user_id = $1 WHERE id = $2', [
      creatorUserId,
      snapshotId,
    ]),
    /immutable/
  );
  } finally {
    await replaceActiveRoleForTest(confirmerUserId, 'manager');
  }
});

test('in-place price changes coalesce into one immutable pending re-export with the latest price', async () => {
  const product = await createReexportProduct();
  const nextProduct = await createReexportProduct({ priceUah: 1100 });
  try {
    const initialSnapshot = await createSnapshot(product.full_sku, product.full_sku);
    const initialCsv = await snapshotCsv(initialSnapshot.id);
    const initialRows = csvRowsForSku(initialCsv, product.full_sku);
    assert.equal(initialRows.length, 1);
    assert.ok(initialRows[0].startsWith(`${product.full_sku},2400,`));
    await confirmSnapshot(initialSnapshot.id);
    const cursorBeforeChanges = Number((await pool.query(
      'SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE'
    )).rows[0].exported_to_product_id);
    assert.equal(cursorBeforeChanges, Number(product.id));

    await changeManualPrice(product.id, 2500);
    await changeManualPrice(product.id, 2600);
    assert.deepEqual((await pool.query(
      `SELECT revision, confirmed_revision
       FROM product_export_revisions WHERE product_id = $1`,
      [product.id]
    )).rows, [{ revision: '2', confirmed_revision: '0' }]);
    assert.equal(Number((await pool.query(
      'SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE'
    )).rows[0].exported_to_product_id), cursorBeforeChanges);

    const nextSnapshot = await createSnapshot(nextProduct.full_sku, nextProduct.full_sku);
    const nextCsv = await snapshotCsv(nextSnapshot.id);
    const reexportedRows = csvRowsForSku(nextCsv, product.full_sku);
    assert.equal(reexportedRows.length, 1);
    assert.ok(reexportedRows[0].startsWith(`${product.full_sku},2600,`));
    assert.equal(csvRowsForSku(nextCsv, nextProduct.full_sku).length, 1);
    const captured = (await pool.query(
      `SELECT reexport_revisions FROM export_snapshots WHERE id = $1`,
      [nextSnapshot.id]
    )).rows[0].reexport_revisions;
    assert.deepEqual(captured, [{ productId: Number(product.id), revision: 2 }]);

    await confirmSnapshot(nextSnapshot.id);
    assert.deepEqual((await pool.query(
      `SELECT revision, confirmed_revision
       FROM product_export_revisions WHERE product_id = $1`,
      [product.id]
    )).rows, [{ revision: '2', confirmed_revision: '2' }]);
    assert.equal(await snapshotCsv(initialSnapshot.id), initialCsv);
  } finally {
    await pool.query('DELETE FROM products WHERE id = ANY($1::int[])', [
      [Number(product.id), Number(nextProduct.id)],
    ]);
  }
});

test('snapshot confirmation clears only its captured revision under later changes and out-of-order confirmation', async () => {
  const product = await createReexportProduct();
  const anchors = [
    await createReexportProduct({ priceUah: 1101 }),
    await createReexportProduct({ priceUah: 1102 }),
    await createReexportProduct({ priceUah: 1103 }),
  ];
  try {
    const initialSnapshot = await createSnapshot(product.full_sku, product.full_sku);
    await confirmSnapshot(initialSnapshot.id);

    await changeManualPrice(product.id, 2500);
    const olderSnapshot = await createSnapshot(anchors[0].full_sku, anchors[0].full_sku);
    const olderCsv = await snapshotCsv(olderSnapshot.id);
    const olderRows = csvRowsForSku(olderCsv, product.full_sku);
    assert.equal(olderRows.length, 1);
    assert.ok(olderRows[0].startsWith(`${product.full_sku},2500,`));

    await changeManualPrice(product.id, 2600);
    await confirmSnapshot(olderSnapshot.id);
    assert.deepEqual((await pool.query(
      `SELECT revision, confirmed_revision
       FROM product_export_revisions WHERE product_id = $1`,
      [product.id]
    )).rows, [{ revision: '2', confirmed_revision: '1' }]);

    const middleSnapshot = await createSnapshot(anchors[1].full_sku, anchors[1].full_sku);
    const middleRows = csvRowsForSku(await snapshotCsv(middleSnapshot.id), product.full_sku);
    assert.equal(middleRows.length, 1);
    assert.ok(middleRows[0].startsWith(`${product.full_sku},2600,`));
    await changeManualPrice(product.id, 2700);
    const latestSnapshot = await createSnapshot(anchors[2].full_sku, anchors[2].full_sku);
    const latestRows = csvRowsForSku(await snapshotCsv(latestSnapshot.id), product.full_sku);
    assert.equal(latestRows.length, 1);
    assert.ok(latestRows[0].startsWith(`${product.full_sku},2700,`));

    const concurrentConfirmations = await Promise.all([
      confirmSnapshot(latestSnapshot.id),
      confirmSnapshot(middleSnapshot.id),
    ]);
    assert.equal(concurrentConfirmations.length, 2);
    assert.deepEqual((await pool.query(
      `SELECT revision, confirmed_revision
       FROM product_export_revisions WHERE product_id = $1`,
      [product.id]
    )).rows, [{ revision: '3', confirmed_revision: '3' }]);
    assert.equal(await snapshotCsv(olderSnapshot.id), olderCsv);
    assert.equal(Number((await pool.query(
      'SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE'
    )).rows[0].exported_to_product_id), Number(anchors[2].id));
  } finally {
    await pool.query('DELETE FROM products WHERE id = ANY($1::int[])', [[
      Number(product.id),
      ...anchors.map((item) => Number(item.id)),
    ]]);
  }
});

test('an intentionally excluded product is not emitted by the pending re-export queue', async () => {
  const excluded = await createReexportProduct({ excludeFromExport: 1 });
  const anchor = await createReexportProduct({ priceUah: 1104 });
  try {
    const cursorSnapshot = await createSnapshot(anchor.full_sku, anchor.full_sku);
    await confirmSnapshot(cursorSnapshot.id);
    assert.ok(Number(anchor.id) > Number(excluded.id));

    await changeManualPrice(excluded.id, 2500);
    const nextSnapshot = await createSnapshot(anchor.full_sku, anchor.full_sku);
    assert.equal(csvRowsForSku(await snapshotCsv(nextSnapshot.id), excluded.full_sku).length, 0);
    assert.deepEqual((await pool.query(
      `SELECT revision, confirmed_revision
       FROM product_export_revisions WHERE product_id = $1`,
      [excluded.id]
    )).rows, [{ revision: '1', confirmed_revision: '0' }]);
  } finally {
    await pool.query('DELETE FROM products WHERE id = ANY($1::int[])', [[
      Number(excluded.id), Number(anchor.id),
    ]]);
  }
});

test('export audit failures roll back snapshot creation and first confirmation', async () => {
  const exportSku = (await pool.query(
    `SELECT full_sku FROM products
     WHERE COALESCE(exclude_from_export, 0) = 0
     ORDER BY id DESC LIMIT 1`
  )).rows[0].full_sku;
  const failedCreationKey = 'integration-export-created-audit-failure';
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_test_export_created_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced export created audit failure';
    END;
    $$;
    CREATE TRIGGER fail_test_export_created_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW
    WHEN (NEW.event_key = 'export_snapshot.created')
    EXECUTE FUNCTION fail_test_export_created_audit();
  `);
  try {
    const failedCreation = await request('/api/export/snapshots', {
      method: 'POST',
      headers: { 'Idempotency-Key': failedCreationKey },
      body: { fromSku: exportSku, toSku: exportSku },
    });
    assert.equal(failedCreation.response.status, 400, failedCreation.text);
  } finally {
    await pool.query('DROP TRIGGER fail_test_export_created_audit ON audit_events');
    await pool.query('DROP FUNCTION fail_test_export_created_audit()');
  }
  assert.equal(Number((await pool.query(
    'SELECT count(*) FROM export_snapshots WHERE idempotency_key = $1',
    [failedCreationKey]
  )).rows[0].count), 0);

  const created = await request('/api/export/snapshots', {
    method: 'POST',
    headers: { 'Idempotency-Key': 'integration-export-confirmed-audit-failure' },
    body: { fromSku: exportSku, toSku: exportSku },
  });
  assert.equal(created.response.status, 201, created.text);
  const cursorBefore = (await pool.query(
    `SELECT exported_to_product_id, last_snapshot_id FROM export_state WHERE singleton = TRUE`
  )).rows[0];
  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_test_export_confirmed_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'forced export confirmed audit failure';
    END;
    $$;
    CREATE TRIGGER fail_test_export_confirmed_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW
    WHEN (NEW.event_key = 'export_snapshot.confirmed')
    EXECUTE FUNCTION fail_test_export_confirmed_audit();
  `);
  try {
    const failedConfirmation = await request(
      `/api/export/snapshots/${created.data.id}/confirm`,
      { method: 'POST', body: {} }
    );
    assert.equal(failedConfirmation.response.status, 400, failedConfirmation.text);
  } finally {
    await pool.query('DROP TRIGGER fail_test_export_confirmed_audit ON audit_events');
    await pool.query('DROP FUNCTION fail_test_export_confirmed_audit()');
  }
  assert.deepEqual((await pool.query(
    `SELECT status, confirmed_at, confirmed_by_user_id
     FROM export_snapshots WHERE id = $1`,
    [created.data.id]
  )).rows, [{ status: 'generated', confirmed_at: null, confirmed_by_user_id: null }]);
  assert.deepEqual((await pool.query(
    `SELECT exported_to_product_id, last_snapshot_id FROM export_state WHERE singleton = TRUE`
  )).rows[0], cursorBefore);
  assert.equal(Number((await pool.query(
    `SELECT count(*) FROM audit_events
     WHERE event_key = 'export_snapshot.confirmed' AND subject_id = $1`,
    [created.data.id]
  )).rows[0].count), 0);
});

test('SKU schema publication attribution and audit share the publication transaction', async () => {
  const actorUserId = Number(suite.authenticatedSession.applicationUser.id);
  const originalMmLabel = (await pool.query(
    "SELECT label FROM questions WHERE category_code = 'MM' AND key = 'kind'"
  )).rows[0].label;
  const originalWwLabel = (await pool.query(
    "SELECT label FROM questions WHERE category_code = 'WW' AND key = 'kind'"
  )).rows[0].label;
  try {
    await pool.query(
      "UPDATE questions SET label = label || ' published' WHERE category_code = 'MM' AND key = 'kind'"
    );
    const published = await request('/api/admin/sku-schema/MM/publish', {
      method: 'POST',
      headers: { 'X-Request-ID': 'sku-schema-published' },
      body: {},
    });
    assert.equal(published.response.status, 200, published.text);
    assert.equal(published.data.categoryCode, 'MM');
    assert.equal(published.data.version, 2);
    assert.equal(Number((await pool.query(
      'SELECT published_by_user_id FROM sku_schema_versions WHERE id = $1',
      [published.data.id]
    )).rows[0].published_by_user_id), actorUserId);
    assert.deepEqual((await pool.query(
      `SELECT event_key, actor_user_id, request_id, subject_type, subject_id, details
       FROM audit_events
       WHERE event_key = 'sku_schema.published' AND subject_id = $1`,
      [String(published.data.id)]
    )).rows, [{
      event_key: 'sku_schema.published',
      actor_user_id: String(actorUserId),
      request_id: 'sku-schema-published',
      subject_type: 'sku_schema_version',
      subject_id: String(published.data.id),
      details: { categoryCode: 'MM', version: 2 },
    }]);

    await pool.query(
      "UPDATE questions SET label = label || ' failing' WHERE category_code = 'WW' AND key = 'kind'"
    );
    const beforeFailure = await pool.query(
      `SELECT id, version, status, published_by_user_id
       FROM sku_schema_versions WHERE category_code = 'WW' ORDER BY version`
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_sku_schema_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced SKU schema audit failure';
      END;
      $$;
      CREATE TRIGGER fail_test_sku_schema_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW
      WHEN (NEW.event_key = 'sku_schema.published')
      EXECUTE FUNCTION fail_test_sku_schema_audit();
    `);
    try {
      const failedPublication = await request('/api/admin/sku-schema/WW/publish', {
        method: 'POST', body: {},
      });
      assert.equal(failedPublication.response.status, 500, failedPublication.text);
    } finally {
      await pool.query('DROP TRIGGER fail_test_sku_schema_audit ON audit_events');
      await pool.query('DROP FUNCTION fail_test_sku_schema_audit()');
    }
    assert.deepEqual((await pool.query(
      `SELECT id, version, status, published_by_user_id
       FROM sku_schema_versions WHERE category_code = 'WW' ORDER BY version`
    )).rows, beforeFailure.rows);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE event_key = 'sku_schema.published' AND details ->> 'categoryCode' = 'WW'`
    )).rows[0].count), 0);
  } finally {
    await pool.query(
      "UPDATE questions SET label = $1 WHERE category_code = 'MM' AND key = 'kind'",
      [originalMmLabel]
    );
    await pool.query(
      "UPDATE questions SET label = $1 WHERE category_code = 'WW' AND key = 'kind'",
      [originalWwLabel]
    );
  }
});

test('export snapshot is immutable, idempotent, and cursor is monotonic', async () => {
  const legacyBypass = await request(`/api/export/csv?fromSku=${encodeURIComponent(suite.primarySku)}`);
  assert.equal(legacyBypass.response.status, 410);
  const first = await request('/api/export/snapshots', {
    method: 'POST', body: { fromSku: suite.primarySku }, headers: { 'Idempotency-Key': 'integration-export-1' },
  });
  assert.equal(first.response.status, 201, first.text);
  const repeated = await request('/api/export/snapshots', {
    method: 'POST', body: { fromSku: suite.primarySku }, headers: { 'Idempotency-Key': 'integration-export-1' },
  });
  assert.equal(repeated.data.id, first.data.id);
  const mismatched = await request('/api/export/snapshots', {
    method: 'POST',
    body: { fromSku: suite.primarySku, toSku: suite.primarySku },
    headers: { 'Idempotency-Key': 'integration-export-1' },
  });
  assert.equal(mismatched.response.status, 409);
  const csv = await request(`/api/export/snapshots/${first.data.id}/csv`);
  assert.equal(csv.response.status, 200);
  assert.match(csv.text, /^sku,price_uah/);
  assert.equal((await request(`/api/export/snapshots/${first.data.id}/confirm`, { method: 'POST', body: {} })).response.status, 200);
  const cursorBefore = Number((await pool.query('SELECT exported_to_product_id FROM export_state')).rows[0].exported_to_product_id);

  const historical = await request('/api/export/snapshots', {
    method: 'POST',
    body: { fromSku: suite.primarySku, toSku: suite.primarySku },
    headers: { 'Idempotency-Key': 'integration-export-old' },
  });
  await request(`/api/export/snapshots/${historical.data.id}/confirm`, { method: 'POST', body: {} });
  const cursorAfter = Number((await pool.query('SELECT exported_to_product_id FROM export_state')).rows[0].exported_to_product_id);
  assert.equal(cursorAfter, cursorBefore);

  await pool.query(
    `UPDATE export_state
     SET exported_to_product_id = 0, last_snapshot_id = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE singleton = TRUE`
  );
  const concurrentConfirmations = await Promise.all([
    request(`/api/export/snapshots/${historical.data.id}/confirm`, { method: 'POST', body: {} }),
    request(`/api/export/snapshots/${first.data.id}/confirm`, { method: 'POST', body: {} }),
  ]);
  assert.deepEqual(concurrentConfirmations.map((result) => result.response.status), [200, 200]);
  const concurrentCursor = await pool.query(
    `SELECT st.exported_to_product_id, st.last_snapshot_id,
            GREATEST(old.exported_to_product_id, latest.exported_to_product_id) AS expected_cursor,
            CASE
              WHEN latest.exported_to_product_id >= old.exported_to_product_id THEN latest.id
              ELSE old.id
            END AS expected_snapshot_id
     FROM export_state st
     JOIN export_snapshots old ON old.id = $1
     JOIN export_snapshots latest ON latest.id = $2
     WHERE st.singleton = TRUE`,
    [historical.data.id, first.data.id]
  );
  assert.equal(
    Number(concurrentCursor.rows[0].exported_to_product_id),
    Number(concurrentCursor.rows[0].expected_cursor)
  );
  assert.equal(
    concurrentCursor.rows[0].last_snapshot_id,
    concurrentCursor.rows[0].expected_snapshot_id
  );
  await assert.rejects(
    pool.query("UPDATE export_snapshots SET csv_content = 'changed' WHERE id = $1", [first.data.id]),
    /immutable/
  );

  const endpoints = (await pool.query(
    `SELECT full_sku FROM products
     WHERE full_sku IS NOT NULL
     ORDER BY id
     LIMIT 2`
  )).rows.map((row) => row.full_sku);
  assert.equal(endpoints.length, 2);
  await pool.query(`
    CREATE OR REPLACE FUNCTION delay_test_export_snapshot_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_sleep(0.2);
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER delay_test_export_snapshot_insert
    BEFORE INSERT ON export_snapshots
    FOR EACH ROW EXECUTE FUNCTION delay_test_export_snapshot_insert();
  `);
  try {
    const concurrentKey = 'integration-export-conflict';
    const concurrent = await Promise.all([
      request('/api/export/snapshots', {
        method: 'POST',
        body: { fromSku: endpoints[0], toSku: endpoints[0] },
        headers: { 'Idempotency-Key': concurrentKey },
      }),
      request('/api/export/snapshots', {
        method: 'POST',
        body: { fromSku: endpoints[1], toSku: endpoints[1] },
        headers: { 'Idempotency-Key': concurrentKey },
      }),
    ]);
    assert.deepEqual(
      concurrent.map((result) => result.response.status).sort(),
      [201, 409]
    );
    const storedConflict = await pool.query(
      `SELECT count(*)::int AS count
       FROM export_snapshots
       WHERE idempotency_key = $1`,
      [concurrentKey]
    );
    assert.equal(storedConflict.rows[0].count, 1);
  } finally {
    await pool.query('DROP TRIGGER delay_test_export_snapshot_insert ON export_snapshots');
    await pool.query('DROP FUNCTION delay_test_export_snapshot_insert()');
  }
});

test('export viewing is shared while snapshot creation and confirmation remain Administrator-only', async () => {
  const userId = suite.authenticatedSession.applicationUser.id;
  const expectDenied = async (url, options) => {
    const result = await request(url, options);
    assert.equal(result.response.status, 403, result.text);
    assert.deepEqual(result.data, {
      code: 'INSUFFICIENT_PERMISSION',
      error: 'Insufficient permission',
      requiredPermission: 'exports.create',
    });
  };
  const getExportMutationState = async (snapshotId) => ({
    snapshotCount: Number((await pool.query(
      'SELECT count(*) FROM export_snapshots'
    )).rows[0].count),
    snapshot: (await pool.query(
      'SELECT confirmed_at FROM export_snapshots WHERE id = $1',
      [snapshotId]
    )).rows[0],
    cursor: (await pool.query(
      `SELECT exported_to_product_id, last_snapshot_id
       FROM export_state
       WHERE singleton = TRUE`
    )).rows[0],
  });

  await replaceActiveRoleForTest(userId, 'administrator');
  try {
    assert.equal((await request('/api/export/status')).response.status, 200);
    const administratorSnapshot = await request('/api/export/snapshots', {
      method: 'POST',
      body: { fromSku: suite.primarySku, toSku: suite.primarySku },
      headers: { 'Idempotency-Key': 'rbac-export-administrator' },
    });
    assert.equal(administratorSnapshot.response.status, 201, administratorSnapshot.text);
    const administratorDownload = await request(
      `/api/export/snapshots/${administratorSnapshot.data.id}/csv`
    );
    assert.equal(administratorDownload.response.status, 200, administratorDownload.text);
    assert.match(administratorDownload.text, /^sku,price_uah/);
    assert.equal((await request(
      `/api/export/snapshots/${administratorSnapshot.data.id}/confirm`,
      { method: 'POST', body: {} }
    )).response.status, 200);

    const unconfirmedSnapshot = await request('/api/export/snapshots', {
      method: 'POST',
      body: { fromSku: suite.primarySku, toSku: suite.primarySku },
      headers: { 'Idempotency-Key': 'rbac-export-denied-confirm' },
    });
    assert.equal(unconfirmedSnapshot.response.status, 201, unconfirmedSnapshot.text);
    const protectedState = await getExportMutationState(unconfirmedSnapshot.data.id);
    assert.equal(protectedState.snapshot.confirmed_at, null);

    for (const roleKey of ['manager', 'storekeeper']) {
      await replaceActiveRoleForTest(userId, roleKey);
      const me = await request('/api/auth/me');
      assert.equal(me.data.permissions.includes('exports.view'), true);
      assert.equal(me.data.permissions.includes('exports.create'), false);
      assert.equal((await request('/api/export/status')).response.status, 200);
      assert.equal((await request(
        `/api/export/snapshots/${administratorSnapshot.data.id}/csv`
      )).response.status, 200);
      assert.equal((await request('/api/export/csv')).response.status, 410);

      await expectDenied('/api/export/snapshots', {
        method: 'POST',
        body: { fromSku: suite.primarySku, toSku: suite.primarySku },
        headers: { 'Idempotency-Key': `rbac-export-${roleKey}-denied` },
      });
      await expectDenied(`/api/export/snapshots/${unconfirmedSnapshot.data.id}/confirm`, {
        method: 'POST', body: {},
      });
      assert.deepEqual(
        await getExportMutationState(unconfirmedSnapshot.data.id),
        protectedState
      );

      // A permission denial must leave the existing authenticated session usable.
      assert.equal((await request('/api/export/status')).response.status, 200);
    }
  } finally {
    await replaceActiveRoleForTest(userId, 'administrator');
  }
});
