const suite = require('./suite-context');
const { getCorrectionPreviewSignature } = require('../src/services/product/product-signatures');
const {
  assert,
  crypto,
  test,
  pool,
  integrationOidcAdapter,
  request,
  authenticateApplicationSession,
  activateApplicationUserForTest,
  roleIdForKey,
  currentAssignmentIdForUser,
  authenticateIdentitySession,
  schemas,
} = suite;

test('pre-feature correction signatures survive the default-on upgrade but stale on a rounding toggle', async () => {
  if (!suite.authenticatedSession) {
    suite.authenticatedSession = await authenticateApplicationSession('/admin');
  }
  const originalFlag = (await pool.query(
    'SELECT marketing_rounding_enabled FROM categories WHERE code = $1', ['ZZ']
  )).rows[0].marketing_rounding_enabled;
  const originalCell = (await pool.query(
    'SELECT price FROM price_matrix WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0',
    [schemas.ZZScenario]
  )).rows[0].price;
  const requestIds = [];
  const productIds = [];
  try {
    await pool.query('UPDATE categories SET marketing_rounding_enabled = 1 WHERE code = $1', ['ZZ']);
    await pool.query(
      'UPDATE price_matrix SET price = 4000 WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0',
      [schemas.ZZScenario]
    );
    for (const toggle of [false, true]) {
      const sourcePreview = await request('/api/preview', {
        method: 'POST', body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0 },
      });
      assert.equal(sourcePreview.response.status, 200, sourcePreview.text);
      const source = await request('/api/save', { method: 'POST', body: {
        category: 'ZZ', answers: { kind: 1 }, weight: 0,
        skuSchemaVersionId: schemas.ZZ, previewToken: sourcePreview.data.previewToken,
      } });
      assert.equal(source.response.status, 200, source.text);
      productIds.push(Number(source.data.id));
      const correctionBody = {
        sourceSku: source.data.fullSku, answers: { kind: 2 }, reason: 'legacy signature upgrade',
      };
      const historicalPreview = await request('/api/recount/preview', {
        method: 'POST', body: correctionBody,
      });
      assert.equal(historicalPreview.response.status, 200, historicalPreview.text);
      assert.equal(Number(historicalPreview.data.corrected.autoPriceUah), 4000);
      const created = await request('/api/admin/correction-requests', {
        method: 'POST', body: correctionBody,
      });
      assert.equal(created.response.status, 200, created.text);
      const requestId = Number(created.data.request.id);
      requestIds.push(requestId);
      assert.equal((await pool.query(
        'SELECT pricing_mode FROM correction_requests WHERE id = $1', [requestId]
      )).rows[0].pricing_mode, 'system_auto');
      const claimed = await request(`/api/admin/correction-requests/${requestId}/claim`, {
        method: 'POST', body: {},
      });
      assert.equal(claimed.response.status, 200, claimed.text);
      const claimVersion = Number(claimed.data.request.claimVersion);
      const legacySignature = getCorrectionPreviewSignature(
        historicalPreview.data, { legacyDefaultRounding: true }
      );
      await pool.query(
        `UPDATE correction_requests
         SET proposed_payload = proposed_payload - 'pricingContextFingerprint',
             preview_signature = $1,
             pricing_mode = NULL,
             pricing_usd_per_gram = NULL,
             pricing_manual_uah = NULL,
             pricing_rounding_enabled = NULL,
             pricing_origin = NULL
         WHERE id = $2`,
        [legacySignature, requestId]
      );
      assert.equal((await pool.query(
        'SELECT pricing_mode FROM correction_requests WHERE id = $1', [requestId]
      )).rows[0].pricing_mode, null);
      if (toggle) {
        await pool.query('UPDATE categories SET marketing_rounding_enabled = 0 WHERE code = $1', ['ZZ']);
        const unchangedNumber = await request('/api/recount/preview', {
          method: 'POST', body: correctionBody,
        });
        assert.equal(unchangedNumber.response.status, 200, unchangedNumber.text);
        assert.equal(Number(unchangedNumber.data.corrected.autoPriceUah), 4000);
      }
      const completed = await request(`/api/admin/correction-requests/${requestId}/complete`, {
        method: 'POST', body: { claimVersion },
      });
      assert.equal(completed.response.status, toggle ? 409 : 200, completed.text);
      if (toggle) {
        await pool.query('UPDATE categories SET marketing_rounding_enabled = 1 WHERE code = $1', ['ZZ']);
      } else {
        productIds.push(Number(completed.data.recount.correctedProductId));
      }
    }
  } finally {
    if (requestIds.length > 0) {
      await pool.query(
        "DELETE FROM correction_requests WHERE id = ANY($1::int[]) AND status <> 'completed'",
        [requestIds]
      );
    }
    if (productIds.length > 0) {
      await pool.query(
        "UPDATE products SET status = 'archived', exclude_from_export = 1 WHERE id = ANY($1::int[]) AND status = 'active'",
        [productIds]
      );
    }
    await pool.query('UPDATE categories SET marketing_rounding_enabled = $1 WHERE code = $2',
      [originalFlag, 'ZZ']);
    await pool.query(
      'UPDATE price_matrix SET price = $1 WHERE scenario_id = $2 AND x_val = 2 AND y_val = 0',
      [originalCell, schemas.ZZScenario]
    );
  }
});

test('new legacy-shaped correction requests persist explicit system and fallback pricing modes', async () => {
  if (!suite.authenticatedSession) {
    suite.authenticatedSession = await authenticateApplicationSession('/admin');
  }
  const storekeeperSession = await authenticateIdentitySession({
    issuer: 'https://correction-pricing.example/realms/amber',
    subject: 'legacy-shaped-storekeeper',
    preferredUsername: 'legacy.shaped.storekeeper',
    displayName: 'Legacy Shaped Storekeeper',
  });
  await activateApplicationUserForTest(
    'https://correction-pricing.example/realms/amber',
    'legacy-shaped-storekeeper',
    'storekeeper'
  );
  const originalCell = (await pool.query(
    'SELECT price FROM price_matrix WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0',
    [schemas.ZZScenario]
  )).rows[0].price;
  const requestIds = [];
  const productIds = [];
  async function createSource() {
    const preview = await request('/api/preview', {
      method: 'POST', body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0 },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const saved = await request('/api/save', { method: 'POST', body: {
      category: 'ZZ', answers: { kind: 1 }, weight: 0,
      skuSchemaVersionId: schemas.ZZ, previewToken: preview.data.previewToken,
    } });
    assert.equal(saved.response.status, 200, saved.text);
    productIds.push(Number(saved.data.id));
    return saved.data.fullSku;
  }

  try {
    const automaticSourceSku = await createSource();
    const fallbackSourceSku = await createSource();
    const automatic = await request('/api/admin/correction-requests', {
      method: 'POST',
      authentication: storekeeperSession,
      body: {
        sourceSku: automaticSourceSku,
        answers: { kind: 2 },
        reason: 'legacy-shaped automatic request',
      },
    });
    assert.equal(automatic.response.status, 200, automatic.text);
    requestIds.push(Number(automatic.data.request.id));
    assert.deepEqual(automatic.data.request.pricingDecision, { mode: 'system_auto' });
    assert.equal(automatic.data.request.pricingOrigin, null);
    assert.deepEqual((await pool.query(
      `SELECT pricing_mode, pricing_manual_uah, pricing_origin
       FROM correction_requests WHERE id = $1`,
      [automatic.data.request.id]
    )).rows, [{
      pricing_mode: 'system_auto', pricing_manual_uah: null, pricing_origin: null,
    }]);

    await pool.query(
      'UPDATE price_matrix SET price = NULL WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0',
      [schemas.ZZScenario]
    );
    const fallback = await request('/api/admin/correction-requests', {
      method: 'POST',
      authentication: storekeeperSession,
      body: {
        sourceSku: fallbackSourceSku,
        answers: { kind: 2 },
        reason: 'legacy-shaped missing automatic fallback',
        manualPriceUah: 725.25,
      },
    });
    assert.equal(fallback.response.status, 200, fallback.text);
    requestIds.push(Number(fallback.data.request.id));
    assert.deepEqual(fallback.data.request.pricingDecision, {
      mode: 'manual_uah', manualPriceUah: 725.25,
    });
    assert.equal(fallback.data.request.pricingOrigin, 'automatic_unavailable_fallback');
    assert.equal(fallback.data.request.proposedPayload.calculatedPriceUah, null);
    assert.equal(fallback.data.request.proposedPayload.autoPriceUah, null);
    assert.equal(Number(fallback.data.request.proposedPayload.manualPriceUah), 725.25);
    assert.equal(Number(fallback.data.request.proposedPayload.totalPriceUah), 725.25);
    assert.deepEqual((await pool.query(
      `SELECT pricing_mode, pricing_manual_uah, pricing_origin
       FROM correction_requests WHERE id = $1`,
      [fallback.data.request.id]
    )).rows, [{
      pricing_mode: 'manual_uah',
      pricing_manual_uah: '725.25',
      pricing_origin: 'automatic_unavailable_fallback',
    }]);
  } finally {
    await pool.query(
      'UPDATE price_matrix SET price = $1 WHERE scenario_id = $2 AND x_val = 2 AND y_val = 0',
      [originalCell, schemas.ZZScenario]
    );
    if (requestIds.length > 0) {
      await pool.query('DELETE FROM correction_requests WHERE id = ANY($1::int[])', [requestIds]);
    }
    if (productIds.length > 0) {
      await pool.query(
        "UPDATE products SET status = 'archived', exclude_from_export = 1 WHERE id = ANY($1::int[]) AND status = 'active'",
        [productIds]
      );
    }
  }
});

test('authorized correction pricing decisions remain authoritative through completion', async () => {
  if (!suite.authenticatedSession) {
    suite.authenticatedSession = await authenticateApplicationSession('/admin');
  }
  const categoryFlag = (await pool.query(
    "SELECT marketing_rounding_enabled FROM categories WHERE code = 'LN'"
  )).rows[0].marketing_rounding_enabled;
  const productIds = [];
  const requestIds = [];
  let matrixUpdated = false;
  async function createSource(weight) {
    const body = {
      categoryCode: 'LN',
      answers: { raw_type: 1, shape: 6, is_calibrated: 2 },
      weight,
      isCalibrated: 2,
    };
    const preview = await request('/api/preview', { method: 'POST', body });
    assert.equal(preview.response.status, 200, preview.text);
    const saved = await request('/api/save', { method: 'POST', body: {
      category: 'LN', answers: body.answers, weight,
      skuSchemaVersionId: schemas.LN, previewToken: preview.data.previewToken,
    } });
    assert.equal(saved.response.status, 200, saved.text);
    productIds.push(Number(saved.data.id));
    return saved.data.fullSku;
  }
  try {
    const sourceSku = await createSource(10);
    const requestBody = {
      sourceSku,
      answers: { shape: 7 },
      weight: 10,
      reason: 'manager custom USD price',
      pricingDecision: {
        mode: 'usd_per_gram', usdPerGram: 10.05, marketingRoundingEnabled: false,
      },
    };
    const preview = await request('/api/admin/correction-requests/preview', {
      method: 'POST', body: requestBody,
    });
    assert.equal(preview.response.status, 200, preview.text);
    assert.equal(Number(preview.data.corrected.calculatedPriceUah), 4020);
    assert.equal(Number(preview.data.corrected.autoPriceUah), 4020);
    assert.equal(Number(preview.data.corrected.totalPriceUah), 4020);
    assert.equal(preview.data.corrected.manualPriceUah, null);
    assert.equal(preview.data.corrected.pricingDetails.matrix, null);
    const created = await request('/api/admin/correction-requests', { method: 'POST', body: {
      ...requestBody, previewSignature: preview.data.previewSignature,
    } });
    assert.equal(created.response.status, 200, created.text);
    requestIds.push(Number(created.data.request.id));
    assert.deepEqual(created.data.request.pricingDecision, requestBody.pricingDecision);
    const stored = await pool.query(`
      SELECT pricing_mode, pricing_usd_per_gram, pricing_rounding_enabled,
        pricing_manual_uah, pricing_origin FROM correction_requests WHERE id = $1
    `, [created.data.request.id]);
    assert.deepEqual(stored.rows, [{
      pricing_mode: 'usd_per_gram', pricing_usd_per_gram: '10.0500',
      pricing_rounding_enabled: 0, pricing_manual_uah: null, pricing_origin: null,
    }]);
    const claimed = await request(
      `/api/admin/correction-requests/${created.data.request.id}/claim`,
      { method: 'POST', body: {} }
    );
    assert.equal(claimed.response.status, 200, claimed.text);
    await pool.query("UPDATE categories SET marketing_rounding_enabled = 0 WHERE code = 'LN'");
    await pool.query(`UPDATE price_matrix SET price = price + 0.25 WHERE scenario_id IN (
      SELECT id FROM price_scenarios WHERE category_code = 'LN')`);
    matrixUpdated = true;
    const replaced = await request(
      `/api/admin/correction-requests/${created.data.request.id}/complete`,
      { method: 'POST', body: {
        claimVersion: claimed.data.request.claimVersion,
        pricingDecision: { mode: 'manual_uah', manualPriceUah: 1 },
      } }
    );
    assert.equal(replaced.response.status, 422, replaced.text);
    const completed = await request(
      `/api/admin/correction-requests/${created.data.request.id}/complete`,
      { method: 'POST', body: { claimVersion: claimed.data.request.claimVersion } }
    );
    assert.equal(completed.response.status, 200, completed.text);
    productIds.push(Number(completed.data.recount.correctedProductId));
    const corrected = await pool.query(`
      SELECT total_price_uah, price_per_gram, uah_rate, details
      FROM products WHERE id = $1
    `, [completed.data.recount.correctedProductId]);
    assert.equal(Number(corrected.rows[0].total_price_uah), 4020);
    assert.equal(Number(corrected.rows[0].price_per_gram), 10.05);
    assert.equal(Number(corrected.rows[0].uah_rate), 40);
    assert.equal(corrected.rows[0].details.manualPriceUah, null);
    assert.deepEqual(corrected.rows[0].details.customUsdPerGramBasis, {
      usdPerGram: 10.05, marketingRoundingEnabled: false,
      correctionRequestId: Number(created.data.request.id),
    });

    const manualSourceSku = await createSource(11);
    const manualBody = {
      sourceSku: manualSourceSku, answers: { shape: 7 }, weight: 11,
      reason: 'manager exact UAH',
      pricingDecision: { mode: 'manual_uah', manualPriceUah: 4020.25 },
    };
    const manualPreview = await request('/api/admin/correction-requests/preview', {
      method: 'POST', body: manualBody,
    });
    assert.equal(manualPreview.response.status, 200, manualPreview.text);
    assert.ok(Number(manualPreview.data.corrected.calculatedPriceUah) > 0);
    assert.ok(Number(manualPreview.data.corrected.autoPriceUah) > 0);
    assert.equal(Number(manualPreview.data.corrected.totalPriceUah), 4020.25);
    assert.equal(Number(manualPreview.data.corrected.manualPriceUah), 4020.25);
    assert.equal(Number(manualPreview.data.corrected.uahRate), 40);
    const manualCreated = await request('/api/admin/correction-requests', {
      method: 'POST', body: { ...manualBody, previewSignature: manualPreview.data.previewSignature },
    });
    assert.equal(manualCreated.response.status, 200, manualCreated.text);
    requestIds.push(Number(manualCreated.data.request.id));
    const manualClaim = await request(
      `/api/admin/correction-requests/${manualCreated.data.request.id}/claim`,
      { method: 'POST', body: {} }
    );
    assert.equal(manualClaim.response.status, 200, manualClaim.text);
    await pool.query("UPDATE categories SET marketing_rounding_enabled = 1 WHERE code = 'LN'");
    const manualComplete = await request(
      `/api/admin/correction-requests/${manualCreated.data.request.id}/complete`,
      { method: 'POST', body: { claimVersion: manualClaim.data.request.claimVersion } }
    );
    assert.equal(manualComplete.response.status, 200, manualComplete.text);
    productIds.push(Number(manualComplete.data.recount.correctedProductId));
    const manualProduct = await pool.query(
      'SELECT total_price_uah, details FROM products WHERE id = $1',
      [manualComplete.data.recount.correctedProductId]
    );
    assert.equal(Number(manualProduct.rows[0].total_price_uah), 4020.25);
    assert.equal(
      Number(manualProduct.rows[0].details.calculatedPriceUah),
      Number(manualPreview.data.corrected.calculatedPriceUah)
    );
    assert.ok(Number(manualProduct.rows[0].details.autoPriceUah) > 0);
    assert.equal(Number(manualProduct.rows[0].details.manualPriceUah), 4020.25);
  } finally {
    await pool.query("UPDATE categories SET marketing_rounding_enabled = $1 WHERE code = 'LN'",
      [categoryFlag]);
    if (matrixUpdated) {
      await pool.query(`UPDATE price_matrix SET price = price - 0.25 WHERE scenario_id IN (
        SELECT id FROM price_scenarios WHERE category_code = 'LN')`);
    }
    if (requestIds.length) {
      await pool.query("DELETE FROM correction_requests WHERE id = ANY($1::int[]) AND status <> 'completed'", [requestIds]);
    }
    if (productIds.length) {
      await pool.query("UPDATE products SET status = 'archived', exclude_from_export = 1 WHERE id = ANY($1::int[]) AND status = 'active'", [productIds]);
    }
  }
});

test('correction completion revalidates decision dependencies after the source lock', async () => {
  if (!suite.authenticatedSession) {
    suite.authenticatedSession = await authenticateApplicationSession('/admin');
  }
  let requestId;
  let sourceProductId;
  let lockClient;
  let lockOpen = false;
  let targetQuestion;
  let completionPromise;
  try {
    const sourceBody = {
      categoryCode: 'LN',
      answers: { raw_type: 1, shape: 6, is_calibrated: 2 },
      weight: 13,
      isCalibrated: 2,
    };
    const sourcePreview = await request('/api/preview', {
      method: 'POST', body: sourceBody,
    });
    assert.equal(sourcePreview.response.status, 200, sourcePreview.text);
    const source = await request('/api/save', { method: 'POST', body: {
      category: 'LN', answers: sourceBody.answers, weight: sourceBody.weight,
      isCalibrated: sourceBody.isCalibrated,
      skuSchemaVersionId: schemas.LN,
      previewToken: sourcePreview.data.previewToken,
    } });
    assert.equal(source.response.status, 200, source.text);
    sourceProductId = Number(source.data.id);

    const requestBody = {
      sourceSku: source.data.fullSku,
      answers: { shape: 7 },
      weight: 13,
      reason: 'transactional decision dependency race',
      pricingDecision: {
        mode: 'usd_per_gram', usdPerGram: 10.05, marketingRoundingEnabled: true,
      },
    };
    const decisionPreview = await request('/api/admin/correction-requests/preview', {
      method: 'POST', body: requestBody,
    });
    assert.equal(decisionPreview.response.status, 200, decisionPreview.text);
    const created = await request('/api/admin/correction-requests', {
      method: 'POST',
      body: { ...requestBody, previewSignature: decisionPreview.data.previewSignature },
    });
    assert.equal(created.response.status, 200, created.text);
    requestId = Number(created.data.request.id);
    const claimed = await request(`/api/admin/correction-requests/${requestId}/claim`, {
      method: 'POST', body: {},
    });
    assert.equal(claimed.response.status, 200, claimed.text);

    targetQuestion = (await pool.query(
      `SELECT id, label FROM questions
       WHERE category_code = 'LN' AND COALESCE(include_in_sku, 1) = 0
       ORDER BY id LIMIT 1`
    )).rows[0];
    lockClient = await pool.connect();
    await lockClient.query('BEGIN');
    lockOpen = true;
    const blockerPid = Number((await lockClient.query(
      'SELECT pg_backend_pid() AS pid'
    )).rows[0].pid);
    await lockClient.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [sourceProductId]);

    completionPromise = request(`/api/admin/correction-requests/${requestId}/complete`, {
      method: 'POST', body: { claimVersion: claimed.data.request.claimVersion },
    });
    let completionBlocked = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const waiting = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE $1 = ANY(pg_blocking_pids(pid))
         ) AS waiting`,
        [blockerPid]
      );
      if (waiting.rows[0].waiting) {
        completionBlocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completionBlocked, true, 'completion must wait for the held source lock');
    await lockClient.query(
      'UPDATE questions SET label = $1 WHERE id = $2',
      [`${targetQuestion.label} (changed while completing)`, targetQuestion.id]
    );
    await lockClient.query('COMMIT');
    lockOpen = false;

    const completed = await completionPromise;
    completionPromise = null;
    assert.equal(completed.response.status, 409, completed.text);
    assert.equal((await pool.query(
      'SELECT status FROM correction_requests WHERE id = $1', [requestId]
    )).rows[0].status, 'in_progress');
    assert.equal((await pool.query(
      'SELECT status FROM products WHERE id = $1', [sourceProductId]
    )).rows[0].status, 'active');
  } finally {
    if (lockOpen) await lockClient.query('ROLLBACK');
    if (completionPromise) await completionPromise;
    if (lockClient) lockClient.release();
    if (targetQuestion) {
      await pool.query(
        'UPDATE questions SET label = $1 WHERE id = $2',
        [targetQuestion.label, targetQuestion.id]
      );
    }
    if (requestId) {
      await pool.query('DELETE FROM correction_requests WHERE id = $1', [requestId]);
    }
    if (sourceProductId) {
      await pool.query(
        "UPDATE products SET status = 'archived', exclude_from_export = 1 WHERE id = $1 AND status = 'active'",
        [sourceProductId]
      );
    }
  }
});

test('concurrent correction only applies once after transactional revalidation', async () => {
  const correctionPayload = { sourceSku: suite.primarySku, answers: { kind: 2 }, reason: 'integration' };
  const preview = await request('/api/recount/preview', { method: 'POST', body: correctionPayload });
  assert.equal(preview.response.status, 200, preview.text);
  const results = await Promise.all([
    request('/api/recount/apply', { method: 'POST', body: correctionPayload }),
    request('/api/recount/apply', { method: 'POST', body: correctionPayload }),
  ]);
  assert.deepEqual(results.map((item) => item.response.status).sort(), [200, 409]);
  const sourceState = await pool.query(
    `SELECT id, status, corrected_to_product_id
     FROM products WHERE full_sku = $1`,
    [suite.primarySku]
  );
  assert.equal(sourceState.rows[0].status, 'corrected');
  assert.ok(Number(sourceState.rows[0].corrected_to_product_id) > 0);
  const correctionState = await pool.query(
    `SELECT count(*)::int AS correction_count,
            count(DISTINCT corrected_product_id)::int AS corrected_products
     FROM product_corrections
     WHERE source_product_id = $1`,
    [sourceState.rows[0].id]
  );
  assert.deepEqual(correctionState.rows[0], {
    correction_count: 1,
    corrected_products: 1,
  });
  assert.equal(Number((await pool.query(
    `SELECT count(*) FROM audit_events
     WHERE event_key = 'product.recounted'
       AND subject_type = 'product' AND subject_id = $1`,
    [String(sourceState.rows[0].id)]
  )).rows[0].count), 1, 'the failed concurrent recount must not create a success event');
});

test('active correction requests stay FIFO when another worker claims a newer request', async () => {
  const skus = ['ZZQUEUE001', 'ZZQUEUE002', 'ZZQUEUE003', 'ZZQUEUE004'];
  let productIds = [];
  try {
    const products = await pool.query(
      `INSERT INTO products
         (full_sku, base_sku, sequence_number, category, weight, total_price,
          total_price_uah, price_per_gram, uah_rate, details, sku_schema_version_id)
       VALUES
         ($1, 'ZZQUEUE', 1, 'ZZ', 0, 25, 1000, 0, 40, '{"answers":{"kind":1}}'::jsonb, $5),
         ($2, 'ZZQUEUE', 2, 'ZZ', 0, 25, 1000, 0, 40, '{"answers":{"kind":1}}'::jsonb, $5),
         ($3, 'ZZQUEUE', 3, 'ZZ', 0, 25, 1000, 0, 40, '{"answers":{"kind":1}}'::jsonb, $5),
         ($4, 'ZZQUEUE', 4, 'ZZ', 0, 25, 1000, 0, 40, '{"answers":{"kind":1}}'::jsonb, $5)
       RETURNING id`,
      [...skus, schemas.ZZ]
    );
    productIds = products.rows.map((row) => Number(row.id));
    const inserted = await pool.query(
      `INSERT INTO correction_requests
         (source_product_id, category_code, source_sku, proposed_sku, old_payload,
          proposed_payload, changes, comment, status, preview_signature,
          claim_token_hash, claimed_at, created_at, updated_at)
       VALUES
         ($1, 'ZZ', $5, 'ZZQUEUE101', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
          'oldest pending', 'pending', 'queue-1', NULL, NULL,
          '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z'),
         ($2, 'ZZ', $6, 'ZZQUEUE102', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
          'same-time first', 'pending', 'queue-2', NULL, NULL,
          '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z'),
         ($3, 'ZZ', $7, 'ZZQUEUE103', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
          'same-time second', 'pending', 'queue-3', NULL, NULL,
          '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z'),
         ($4, 'ZZ', $8, 'ZZQUEUE104', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
          'newer external claim', 'in_progress', 'queue-4', repeat('a', 64),
          '2026-09-01T10:00:00Z', '2026-01-03T10:00:00Z', '2026-09-01T10:00:00Z')
       RETURNING id
       `,
      [...productIds, ...skus]
    );
    const requestIds = inserted.rows.map((row) => Number(row.id));

    const active = await request('/api/admin/correction-requests?status=active');
    assert.equal(active.response.status, 200, active.text);
    const fixtureItems = active.data.items.filter((item) => requestIds.includes(Number(item.id)));
    assert.deepEqual(
      fixtureItems.map((item) => Number(item.id)),
      requestIds,
      'created_at ASC and id ASC must win over claim status and updated_at'
    );
    assert.deepEqual(
      fixtureItems.map((item) => item.status),
      ['pending', 'pending', 'pending', 'in_progress']
    );
  } finally {
    if (productIds.length > 0) {
      await pool.query('DELETE FROM correction_requests WHERE source_product_id = ANY($1::int[])', [productIds]);
      await pool.query('DELETE FROM products WHERE id = ANY($1::int[])', [productIds]);
      await pool.query('DELETE FROM sku_registry WHERE full_sku = ANY($1::text[])', [skus]);
    }
  }
});

test('correction request claims are user-owned, cross-browser, epoch-protected, and explicitly force-released', async () => {
  const sameUserOtherBrowser = await authenticateIdentitySession({
    issuer: integrationOidcAdapter.issuer,
    subject: 'critical-flows-subject',
    preferredUsername: 'critical.flows',
    displayName: 'Critical Flows',
  });
  const secondUserIdentity = {
    issuer: 'https://correction-owner.example/realms/amber',
    subject: `correction-worker-${Date.now()}`,
    preferredUsername: 'correction.worker.two',
    displayName: 'Correction Worker Two',
  };
  const secondUser = await authenticateIdentitySession(secondUserIdentity);
  await activateApplicationUserForTest(
    secondUserIdentity.issuer,
    secondUserIdentity.subject,
    'storekeeper'
  );
  const productPreview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(productPreview.response.status, 200, productPreview.text);
  const product = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: productPreview.data.previewToken,
    },
  });
  assert.equal(product.response.status, 200, product.text);
  const created = await request('/api/admin/correction-requests', {
    method: 'POST',
    body: {
      sourceSku: product.data.fullSku,
      answers: { kind: 2 },
      reason: 'exclusive claim integration',
    },
  });
  assert.equal(created.response.status, 200, created.text);
  const requestId = Number(created.data.request.id);
  assert.equal(
    Number(created.data.request.createdByUser.id),
    suite.authenticatedSession.applicationUser.id
  );
  const genericClaim = await request(`/api/admin/correction-requests/${requestId}/status`, {
    method: 'PATCH', body: { status: 'in_progress' },
  });
  assert.equal(genericClaim.response.status, 400, genericClaim.text);

  const lockClient = await pool.connect();
  await lockClient.query('BEGIN');
  await lockClient.query('SELECT id FROM correction_requests WHERE id = $1 FOR UPDATE', [requestId]);
  const competingClaims = [
    request(`/api/admin/correction-requests/${requestId}/claim`, { method: 'POST', body: {} }),
    request(`/api/admin/correction-requests/${requestId}/claim`, { method: 'POST', body: {} }),
  ];
  await new Promise((resolve) => setTimeout(resolve, 50));
  await lockClient.query('COMMIT');
  lockClient.release();

  const claimResults = await Promise.all(competingClaims);
  assert.deepEqual(claimResults.map((item) => item.response.status).sort(), [200, 409]);
  const winningClaim = claimResults.find((item) => item.response.status === 200).data;
  assert.equal(Object.hasOwn(winningClaim, 'claimToken'), false);
  assert.equal(winningClaim.request.claimFingerprint, null);
  assert.equal(
    Number(winningClaim.request.claimedByUser.id),
    suite.authenticatedSession.applicationUser.id
  );
  const firstClaimVersion = Number(winningClaim.request.claimVersion);
  const claimedState = await pool.query(
    `SELECT status, claim_token_hash, claimed_by_user_id, claim_version, claimed_at
     FROM correction_requests WHERE id = $1`,
    [requestId]
  );
  assert.equal(claimedState.rows[0].status, 'in_progress');
  assert.equal(claimedState.rows[0].claim_token_hash, null);
  assert.equal(
    Number(claimedState.rows[0].claimed_by_user_id),
    suite.authenticatedSession.applicationUser.id
  );
  assert.equal(Number(claimedState.rows[0].claim_version), firstClaimVersion);
  assert.ok(claimedState.rows[0].claimed_at);
  const listed = await request('/api/admin/correction-requests?status=active');
  assert.equal(listed.response.status, 200, listed.text);
  const listedClaim = listed.data.items.find((item) => Number(item.id) === requestId);
  assert.equal(listedClaim.claimFingerprint, null);
  assert.equal(listedClaim.claimedByUser.displayName, 'Critical Flows');
  assert.equal(Object.hasOwn(listedClaim, 'claimTokenHash'), false);

  const wrongHeaders = { 'X-Correction-Claim-Token': 'x'.repeat(43) };
  const sameUserRefresh = await request(
    `/api/admin/correction-requests/${requestId}/refresh`,
    {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      headers: wrongHeaders,
      authentication: sameUserOtherBrowser,
    }
  );
  assert.equal(sameUserRefresh.response.status, 200, sameUserRefresh.text);

  const wrongRelease = await request(
    `/api/admin/correction-requests/${requestId}/release`,
    {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      headers: wrongHeaders,
      authentication: secondUser,
    }
  );
  assert.equal(wrongRelease.response.status, 409, wrongRelease.text);
  const wrongRefresh = await request(
    `/api/admin/correction-requests/${requestId}/refresh`,
    {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      headers: wrongHeaders,
      authentication: secondUser,
    }
  );
  assert.equal(wrongRefresh.response.status, 409, wrongRefresh.text);
  const wrongComplete = await request(
    `/api/admin/correction-requests/${requestId}/complete`,
    {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      headers: wrongHeaders,
      authentication: secondUser,
    }
  );
  assert.equal(wrongComplete.response.status, 409, wrongComplete.text);
  const wrongReject = await request(`/api/admin/correction-requests/${requestId}/status`, {
    method: 'PATCH',
    body: { status: 'rejected', claimVersion: firstClaimVersion },
    headers: wrongHeaders,
    authentication: secondUser,
  });
  assert.equal(wrongReject.response.status, 409, wrongReject.text);

  await pool.query(`
    CREATE OR REPLACE FUNCTION fail_test_correction_release_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event_key = 'correction_request.released' THEN
        RAISE EXCEPTION 'forced correction release audit failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER fail_test_correction_release_audit
    BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION fail_test_correction_release_audit();
  `);
  try {
    const failedAuditedRelease = await request(
      `/api/admin/correction-requests/${requestId}/release`,
      { method: 'POST', body: { claimVersion: firstClaimVersion } }
    );
    assert.equal(failedAuditedRelease.response.status, 500, failedAuditedRelease.text);
    const stateAfterAuditFailure = await pool.query(
      `SELECT status, claimed_by_user_id, claim_version
       FROM correction_requests WHERE id = $1`,
      [requestId]
    );
    assert.equal(stateAfterAuditFailure.rows[0].status, 'in_progress');
    assert.equal(
      Number(stateAfterAuditFailure.rows[0].claimed_by_user_id),
      suite.authenticatedSession.applicationUser.id
    );
    assert.equal(Number(stateAfterAuditFailure.rows[0].claim_version), firstClaimVersion);
  } finally {
    await pool.query('DROP TRIGGER fail_test_correction_release_audit ON audit_events');
    await pool.query('DROP FUNCTION fail_test_correction_release_audit()');
  }

  const releaseLock = await pool.connect();
  await releaseLock.query('BEGIN');
  await releaseLock.query(
    'SELECT id FROM correction_requests WHERE id = $1 FOR UPDATE',
    [requestId]
  );
  const competingReleases = [
    request(`/api/admin/correction-requests/${requestId}/release`, {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
    }),
    request(`/api/admin/correction-requests/${requestId}/release`, {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      headers: wrongHeaders,
      authentication: sameUserOtherBrowser,
    }),
  ];
  await new Promise((resolve) => setTimeout(resolve, 50));
  await releaseLock.query('COMMIT');
  releaseLock.release();
  const releaseResults = await Promise.all(competingReleases);
  assert.deepEqual(releaseResults.map((item) => item.response.status).sort(), [200, 409]);
  const released = releaseResults.find((item) => item.response.status === 200).data;
  assert.equal(released.request.status, 'pending');
  assert.equal(released.request.claimedAt, null);
  assert.equal(Number(released.request.claimVersion), firstClaimVersion + 1);

  const reclaimed = await request(`/api/admin/correction-requests/${requestId}/claim`, {
    method: 'POST', body: {},
  });
  assert.equal(reclaimed.response.status, 200, reclaimed.text);
  const reclaimedVersion = Number(reclaimed.data.request.claimVersion);
  assert.equal(reclaimedVersion, firstClaimVersion + 2);
  const staleRelease = await request(
    `/api/admin/correction-requests/${requestId}/release`,
    {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      authentication: sameUserOtherBrowser,
    }
  );
  assert.equal(staleRelease.response.status, 409, staleRelease.text);
  const staleCompletion = await request(
    `/api/admin/correction-requests/${requestId}/complete`,
    {
      method: 'POST',
      body: { claimVersion: firstClaimVersion },
      authentication: sameUserOtherBrowser,
    }
  );
  assert.equal(staleCompletion.response.status, 409, staleCompletion.text);

  const ownerRelease = await request(
    `/api/admin/correction-requests/${requestId}/release`,
    { method: 'POST', body: { claimVersion: reclaimedVersion } }
  );
  assert.equal(ownerRelease.response.status, 200, ownerRelease.text);
  const secondUserClaim = await request(
    `/api/admin/correction-requests/${requestId}/claim`,
    { method: 'POST', body: {}, authentication: secondUser }
  );
  assert.equal(secondUserClaim.response.status, 200, secondUserClaim.text);
  assert.equal(
    Number(secondUserClaim.data.request.claimedByUser.id),
    secondUser.applicationUser.id
  );
  const secondUserClaimVersion = Number(secondUserClaim.data.request.claimVersion);
  const secondUserAssignmentId = await currentAssignmentIdForUser(secondUser.applicationUser.id);
  const demotedOwner = await request(
    `/api/admin/users/${secondUser.applicationUser.id}/role`,
    {
      method: 'PUT',
      body: {
        roleId: await roleIdForKey('manager'),
        expectedAssignmentId: secondUserAssignmentId,
      },
    }
  );
  assert.equal(demotedOwner.response.status, 200, demotedOwner.text);
  let retainedOwner = await pool.query(
    `SELECT status, claimed_by_user_id, claim_version
     FROM correction_requests WHERE id = $1`,
    [requestId]
  );
  assert.equal(retainedOwner.rows[0].status, 'in_progress');
  assert.equal(Number(retainedOwner.rows[0].claimed_by_user_id), secondUser.applicationUser.id);
  assert.equal(Number(retainedOwner.rows[0].claim_version), secondUserClaimVersion);
  const disabledOwner = await request(
    `/api/admin/users/${secondUser.applicationUser.id}/disable`,
    { method: 'POST', body: {} }
  );
  assert.equal(disabledOwner.response.status, 200, disabledOwner.text);
  retainedOwner = await pool.query(
    `SELECT status, claimed_by_user_id, claim_version
     FROM correction_requests WHERE id = $1`,
    [requestId]
  );
  assert.equal(retainedOwner.rows[0].status, 'in_progress');
  assert.equal(Number(retainedOwner.rows[0].claimed_by_user_id), secondUser.applicationUser.id);
  assert.equal(Number(retainedOwner.rows[0].claim_version), secondUserClaimVersion);

  const administratorOrdinaryBypass = await request(
    `/api/admin/correction-requests/${requestId}/refresh`,
    { method: 'POST', body: { claimVersion: secondUserClaimVersion } }
  );
  assert.equal(administratorOrdinaryBypass.response.status, 409, administratorOrdinaryBypass.text);
  const unconfirmedForceRelease = await request(
    `/api/admin/correction-requests/${requestId}/force-release`,
    { method: 'POST', body: { confirm: false, claimVersion: secondUserClaimVersion } }
  );
  assert.equal(unconfirmedForceRelease.response.status, 400, unconfirmedForceRelease.text);
  const forceReleased = await request(
    `/api/admin/correction-requests/${requestId}/force-release`,
    { method: 'POST', body: { confirm: true, claimVersion: secondUserClaimVersion } }
  );
  assert.equal(forceReleased.response.status, 200, forceReleased.text);
  assert.equal(forceReleased.data.request.status, 'pending');

  const finalClaim = await request(`/api/admin/correction-requests/${requestId}/claim`, {
    method: 'POST', body: {},
  });
  assert.equal(finalClaim.response.status, 200, finalClaim.text);
  const rejected = await request(`/api/admin/correction-requests/${requestId}/status`, {
    method: 'PATCH',
    body: {
      status: 'rejected',
      claimVersion: finalClaim.data.request.claimVersion,
    },
  });
  assert.equal(rejected.response.status, 200, rejected.text);
  const finalState = await pool.query(
    `SELECT cr.status, cr.claim_token_hash, cr.claimed_by_user_id, p.status AS product_status,
            p.corrected_to_product_id
     FROM correction_requests cr
     JOIN products p ON p.id = cr.source_product_id
     WHERE cr.id = $1`,
    [requestId]
  );
  assert.deepEqual(finalState.rows[0], {
    status: 'rejected',
    claim_token_hash: null,
    claimed_by_user_id: null,
    product_status: 'active',
    corrected_to_product_id: null,
  });
  const lifecycle = await pool.query(
    `SELECT event_key, actor_user_id, details
     FROM audit_events
     WHERE subject_type = 'correction_request' AND subject_id = $1
     ORDER BY id`,
    [String(requestId)]
  );
  assert.deepEqual(lifecycle.rows.map((row) => row.event_key), [
    'correction_request.created',
    'correction_request.claimed',
    'correction_request.released',
    'correction_request.claimed',
    'correction_request.released',
    'correction_request.claimed',
    'correction_request.force_released',
    'correction_request.claimed',
    'correction_request.rejected',
  ]);
  const forceReleaseAudit = lifecycle.rows.find(
    (row) => row.event_key === 'correction_request.force_released'
  );
  assert.equal(
    Number(forceReleaseAudit.actor_user_id),
    suite.authenticatedSession.applicationUser.id
  );
  assert.equal(
    Number(forceReleaseAudit.details.previousOwnerUserId),
    secondUser.applicationUser.id
  );
});

test('a legacy token-only claim is adopted once and then follows user ownership', async () => {
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  const product = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: preview.data.previewToken,
    },
  });
  const created = await request('/api/admin/correction-requests', {
    method: 'POST',
    body: {
      sourceSku: product.data.fullSku,
      answers: { kind: 2 },
      reason: 'legacy token adoption',
    },
  });
  assert.equal(created.response.status, 200, created.text);
  const requestId = Number(created.data.request.id);
  const legacyToken = crypto.randomBytes(32).toString('base64url');
  const legacyHash = crypto.createHash('sha256').update(legacyToken).digest('hex');
  await pool.query(
    `UPDATE correction_requests
     SET status = 'in_progress', claim_token_hash = $1, claimed_at = CURRENT_TIMESTAMP
     WHERE id = $2`,
    [legacyHash, requestId]
  );

  const wrongToken = await request(`/api/admin/correction-requests/${requestId}/refresh`, {
    method: 'POST',
    body: { claimVersion: 0 },
    headers: { 'X-Correction-Claim-Token': 'x'.repeat(43) },
  });
  assert.equal(wrongToken.response.status, 409, wrongToken.text);
  const stillLegacy = await pool.query(
    `SELECT claimed_by_user_id, claim_token_hash, claim_version
     FROM correction_requests WHERE id = $1`,
    [requestId]
  );
  assert.equal(stillLegacy.rows[0].claimed_by_user_id, null);
  assert.equal(stillLegacy.rows[0].claim_token_hash, legacyHash);
  assert.equal(Number(stillLegacy.rows[0].claim_version), 0);

  const adopted = await request(`/api/admin/correction-requests/${requestId}/refresh`, {
    method: 'POST',
    body: { claimVersion: 0 },
    headers: { 'X-Correction-Claim-Token': legacyToken },
  });
  assert.equal(adopted.response.status, 200, adopted.text);
  assert.equal(
    Number(adopted.data.request.claimedByUser.id),
    suite.authenticatedSession.applicationUser.id
  );
  assert.equal(adopted.data.request.claimFingerprint, null);
  assert.equal(Number(adopted.data.request.claimVersion), 0);

  const sameUserOtherBrowser = await authenticateIdentitySession({
    issuer: integrationOidcAdapter.issuer,
    subject: 'critical-flows-subject',
    preferredUsername: 'critical.flows',
    displayName: 'Critical Flows',
  });
  const released = await request(`/api/admin/correction-requests/${requestId}/release`, {
    method: 'POST',
    body: { claimVersion: 0 },
    authentication: sameUserOtherBrowser,
  });
  assert.equal(released.response.status, 200, released.text);
  assert.equal(Number(released.data.request.claimVersion), 1);
  const rejected = await request(`/api/admin/correction-requests/${requestId}/status`, {
    method: 'PATCH',
    body: { status: 'rejected' },
  });
  assert.equal(rejected.response.status, 200, rejected.text);

  const audit = await pool.query(
    `SELECT event_key, actor_user_id, details
     FROM audit_events
     WHERE subject_type = 'correction_request' AND subject_id = $1
       AND event_key IN ('correction_request.claimed', 'correction_request.released')
     ORDER BY id`,
    [String(requestId)]
  );
  assert.deepEqual(audit.rows.map((row) => row.event_key), [
    'correction_request.claimed',
    'correction_request.released',
  ]);
  assert.equal(audit.rows[0].details.legacyClaimAdopted, true);
  assert.equal(
    audit.rows.every((row) => Number(row.actor_user_id) === suite.authenticatedSession.applicationUser.id),
    true
  );
});

test('claim refreshes stale correction data and later changes still block completion', async () => {
  const candidate = await pool.query(
    `SELECT id, full_sku
     FROM products
     WHERE category = 'ZZ'
       AND status = 'active'
       AND details->'answers'->>'kind' = '1'
     ORDER BY id
     LIMIT 1`
  );
  assert.ok(candidate.rows[0]);
  const originalPrice = await pool.query(
    'SELECT price FROM price_matrix WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0',
    [schemas.ZZScenario]
  );
  try {
    const created = await request('/api/admin/correction-requests', {
      method: 'POST',
      body: {
        sourceSku: candidate.rows[0].full_sku,
        answers: { kind: 2 },
        reason: 'stale request integration',
      },
    });
    assert.equal(created.response.status, 200, created.text);
    const requestId = Number(created.data.request.id);
    const originalCalculatedPrice = Number(created.data.request.proposedPayload.calculatedPriceUah);

    const changedSource = await pool.query(
      `UPDATE products
       SET total_price_uah = total_price_uah + 1
       WHERE id = $1
       RETURNING total_price_uah`,
      [candidate.rows[0].id]
    );
    const changedPrice = await pool.query(
      `UPDATE price_matrix
       SET price = price + 613
       WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0
       RETURNING price`,
      [schemas.ZZScenario]
    );

    const claimed = await request(`/api/admin/correction-requests/${requestId}/claim`, {
      method: 'POST', body: {},
    });
    assert.equal(claimed.response.status, 200, claimed.text);
    assert.equal(
      Number(claimed.data.request.oldPayload.totalPriceUah),
      Number(changedSource.rows[0].total_price_uah)
    );
    assert.equal(
      Number(claimed.data.request.proposedPayload.calculatedPriceUah),
      Number(changedPrice.rows[0].price)
    );
    assert.notEqual(
      Number(claimed.data.request.proposedPayload.calculatedPriceUah),
      originalCalculatedPrice
    );
    const claimVersion = Number(claimed.data.request.claimVersion);

    await pool.query(
      "UPDATE products SET status = 'archived' WHERE id = $1",
      [candidate.rows[0].id]
    );
    const failedRefresh = await request(
      `/api/admin/correction-requests/${requestId}/refresh`,
      { method: 'POST', body: { claimVersion } }
    );
    assert.equal(failedRefresh.response.status, 409);
    const activeAfterRefreshError = await request(
      '/api/admin/correction-requests?status=active'
    );
    const ownedAfterRefreshError = activeAfterRefreshError.data.items.find(
      (item) => Number(item.id) === requestId
    );
    assert.equal(ownedAfterRefreshError.status, 'in_progress');
    assert.equal(
      Number(ownedAfterRefreshError.claimedByUser.id),
      suite.authenticatedSession.applicationUser.id,
      'a failed refresh must preserve the existing application-user owner'
    );

    const changedAfterClaim = await pool.query(
      `UPDATE products
       SET status = 'active',
           total_price_uah = total_price_uah + 1
       WHERE id = $1
       RETURNING total_price_uah`,
      [candidate.rows[0].id]
    );
    const staleCompletion = await request(
      `/api/admin/correction-requests/${requestId}/complete`,
      { method: 'POST', body: { claimVersion } }
    );
    assert.equal(staleCompletion.response.status, 409);
    assert.equal(staleCompletion.data.details?.type, 'stale_correction_request');

    const activeAfterError = await request('/api/admin/correction-requests?status=active');
    const ownedAfterError = activeAfterError.data.items.find(
      (item) => Number(item.id) === requestId
    );
    assert.equal(ownedAfterError.status, 'in_progress');
    assert.equal(Number(ownedAfterError.claimedByUser.id), suite.authenticatedSession.applicationUser.id);
    assert.equal(Number(ownedAfterError.claimVersion), claimVersion);

    const released = await request(
      `/api/admin/correction-requests/${requestId}/release`,
      { method: 'POST', body: { claimVersion } }
    );
    assert.equal(released.response.status, 200, released.text);
    assert.equal(released.data.request.status, 'pending');

    const reclaimed = await request(`/api/admin/correction-requests/${requestId}/claim`, {
      method: 'POST', body: {},
    });
    assert.equal(reclaimed.response.status, 200, reclaimed.text);
    assert.equal(
      Number(reclaimed.data.request.oldPayload.totalPriceUah),
      Number(changedAfterClaim.rows[0].total_price_uah)
    );
    const completed = await request(
      `/api/admin/correction-requests/${requestId}/complete`,
      {
        method: 'POST',
        body: { claimVersion: reclaimed.data.request.claimVersion },
      }
    );
    assert.equal(completed.response.status, 200, completed.text);
    const finalState = await pool.query(
      `SELECT p.status, p.corrected_to_product_id, cr.status AS request_status,
              cr.corrected_product_id, cr.claim_token_hash, cr.claimed_by_user_id,
              cr.claim_version, cr.claimed_at
       FROM products p
       JOIN correction_requests cr ON cr.id = $1
       WHERE p.id = $2`,
      [requestId, candidate.rows[0].id]
    );
    assert.equal(finalState.rows[0].status, 'corrected');
    assert.equal(finalState.rows[0].request_status, 'completed');
    assert.equal(finalState.rows[0].claim_token_hash, null);
    assert.equal(finalState.rows[0].claimed_by_user_id, null);
    assert.equal(
      Number(finalState.rows[0].claim_version),
      Number(reclaimed.data.request.claimVersion) + 1
    );
    assert.ok(finalState.rows[0].claimed_at);
    assert.equal(
      Number(finalState.rows[0].corrected_to_product_id),
      Number(finalState.rows[0].corrected_product_id)
    );
  } finally {
    await pool.query(
      `UPDATE price_matrix
       SET price = $1
       WHERE scenario_id = $2 AND x_val = 2 AND y_val = 0`,
      [originalPrice.rows[0].price, schemas.ZZScenario]
    );
  }
});

test('repricing drafts attribute creator, modifier, and discard without routine audit spam', async () => {
  const creatorUserId = Number(suite.authenticatedSession.applicationUser.id);
  const modifierSession = await authenticateIdentitySession({
    issuer: 'https://repricing-draft-actor.example/realms/amber',
    subject: 'repricing-draft-modifier',
    preferredUsername: 'repricing.draft.modifier',
    displayName: 'Repricing Draft Modifier',
  });
  const modifierUserId = await activateApplicationUserForTest(
    'https://repricing-draft-actor.example/realms/amber',
    'repricing-draft-modifier',
    'manager'
  );
  let draftId;
  try {
    const created = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      headers: { 'X-Request-ID': 'repricing-draft-created' },
      body: { scope: 'global', uiState: { filter: 'changed' } },
    });
    assert.equal(created.response.status, 200, created.text);
    draftId = Number(created.data.draft.id);
    assert.deepEqual((await pool.query(
      `SELECT created_by_user_id, last_modified_by_user_id, discarded_by_user_id
       FROM repricing_drafts WHERE id = $1`,
      [draftId]
    )).rows, [{
      created_by_user_id: String(creatorUserId),
      last_modified_by_user_id: String(creatorUserId),
      discarded_by_user_id: null,
    }]);

    const saved = await request(`/api/admin/repricing/drafts/${draftId}`, {
      method: 'PUT',
      headers: { 'X-Request-ID': 'repricing-draft-autosave' },
      authentication: modifierSession,
      body: {
        manualOverrides: created.data.manualOverrides,
        automaticProductIds: created.data.automaticProductIds,
        reviewedProductIds: created.data.draft.reviewedProductIds,
        uiState: created.data.draft.uiState,
      },
    });
    assert.equal(saved.response.status, 200, saved.text);
    assert.equal(Number((await pool.query(
      'SELECT last_modified_by_user_id FROM repricing_drafts WHERE id = $1',
      [draftId]
    )).rows[0].last_modified_by_user_id), modifierUserId);

    const synchronized = await request(`/api/admin/repricing/drafts/${draftId}/sync`, {
      method: 'POST',
      headers: { 'X-Request-ID': 'repricing-draft-routine-sync' },
      authentication: modifierSession,
      body: {},
    });
    assert.equal(synchronized.response.status, 200, synchronized.text);
    assert.equal(Number((await pool.query(
      'SELECT last_modified_by_user_id FROM repricing_drafts WHERE id = $1',
      [draftId]
    )).rows[0].last_modified_by_user_id), modifierUserId);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE subject_type = 'repricing_draft' AND subject_id = $1`,
      [String(draftId)]
    )).rows[0].count), 1, 'autosave and synchronization must not emit audit events');

    const discarded = await request(`/api/admin/repricing/drafts/${draftId}`, {
      method: 'DELETE',
      headers: { 'X-Request-ID': 'repricing-draft-discarded' },
      authentication: modifierSession,
    });
    assert.equal(discarded.response.status, 200, discarded.text);
    const state = await pool.query(
      `SELECT status, created_by_user_id, last_modified_by_user_id, discarded_by_user_id
       FROM repricing_drafts WHERE id = $1`,
      [draftId]
    );
    assert.deepEqual(state.rows, [{
      status: 'discarded',
      created_by_user_id: String(creatorUserId),
      last_modified_by_user_id: String(modifierUserId),
      discarded_by_user_id: String(modifierUserId),
    }]);
    const audit = await pool.query(
      `SELECT event_key, actor_user_id, request_id, details
       FROM audit_events
       WHERE subject_type = 'repricing_draft' AND subject_id = $1
       ORDER BY id`,
      [String(draftId)]
    );
    assert.deepEqual(audit.rows, [
      {
        event_key: 'repricing_draft.created',
        actor_user_id: String(creatorUserId),
        request_id: 'repricing-draft-created',
        details: { scope: 'global' },
      },
      {
        event_key: 'repricing_draft.discarded',
        actor_user_id: String(modifierUserId),
        request_id: 'repricing-draft-discarded',
        details: { scope: 'global' },
      },
    ]);
    draftId = null;
  } finally {
    if (draftId) {
      await pool.query(
        `UPDATE repricing_drafts
         SET status = 'discarded', discarded_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'draft'`,
        [draftId]
      );
    }
  }
});

test('correction completion causally attributes successful draft sync and remains best effort', async () => {
  const draftCreatorSession = await authenticateIdentitySession({
    issuer: 'https://correction-draft-sync.example/realms/amber',
    subject: 'correction-draft-creator',
    preferredUsername: 'correction.draft.creator',
    displayName: 'Correction Draft Creator',
  });
  const draftCreatorUserId = await activateApplicationUserForTest(
    'https://correction-draft-sync.example/realms/amber',
    'correction-draft-creator',
    'manager'
  );
  const causalActorUserId = Number(suite.authenticatedSession.applicationUser.id);
  let draftId;
  let unsynchronizableDraftId;
  try {
    const productPreview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
    });
    const product = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind: 1 },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: productPreview.data.previewToken,
      },
    });
    assert.equal(product.response.status, 200, product.text);

    const draft = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      headers: { 'X-Request-ID': 'correction-sync-draft-created' },
      authentication: draftCreatorSession,
      body: { scope: 'global' },
    });
    assert.equal(draft.response.status, 200, draft.text);
    draftId = Number(draft.data.draft.id);
    assert.equal(Number((await pool.query(
      'SELECT created_by_user_id FROM repricing_drafts WHERE id = $1',
      [draftId]
    )).rows[0].created_by_user_id), draftCreatorUserId);

    const unsynchronizableDraft = await pool.query(`
      INSERT INTO repricing_drafts
        (scope, scenario_id, category_code, scenario_name, preview_fingerprint, status)
      VALUES ('scenario', NULL, 'IX', 'Unsynchronizable historical draft',
              'unsynchronizable-fingerprint', 'draft')
      RETURNING id
    `);
    unsynchronizableDraftId = Number(unsynchronizableDraft.rows[0].id);

    const correction = await request('/api/admin/correction-requests', {
      method: 'POST',
      body: {
        sourceSku: product.data.fullSku,
        answers: { kind: 2 },
        reason: 'causal draft synchronization',
      },
    });
    assert.equal(correction.response.status, 200, correction.text);
    const correctionId = Number(correction.data.request.id);
    const claim = await request(`/api/admin/correction-requests/${correctionId}/claim`, {
      method: 'POST', body: {},
    });
    assert.equal(claim.response.status, 200, claim.text);
    const completed = await request(`/api/admin/correction-requests/${correctionId}/complete`, {
      method: 'POST',
      headers: { 'X-Request-ID': 'correction-caused-draft-sync' },
      body: { claimVersion: claim.data.request.claimVersion },
    });
    assert.equal(completed.response.status, 200, completed.text);
    assert.deepEqual(completed.data.draftSyncFailures, [{
      draftId: unsynchronizableDraftId,
      message: 'Цю чернетку неможливо синхронізувати.',
    }]);
    assert.equal(Number((await pool.query(
      'SELECT last_modified_by_user_id FROM repricing_drafts WHERE id = $1',
      [draftId]
    )).rows[0].last_modified_by_user_id), causalActorUserId);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE subject_type = 'repricing_draft' AND subject_id = $1`,
      [String(draftId)]
    )).rows[0].count), 1, 'correction-caused synchronization must not emit repricing audit');
    assert.deepEqual((await pool.query(
      'SELECT status, last_modified_by_user_id FROM repricing_drafts WHERE id = $1',
      [unsynchronizableDraftId]
    )).rows, [{ status: 'draft', last_modified_by_user_id: null }]);
    assert.equal((await pool.query(
      'SELECT status FROM correction_requests WHERE id = $1',
      [correctionId]
    )).rows[0].status, 'completed');
  } finally {
    const cleanupIds = [draftId, unsynchronizableDraftId].filter(Boolean);
    if (cleanupIds.length > 0) {
      await pool.query(
        `UPDATE repricing_drafts
         SET status = 'discarded', discarded_at = CURRENT_TIMESTAMP
         WHERE id = ANY($1::int[]) AND status = 'draft'`,
        [cleanupIds]
      );
    }
  }
});
