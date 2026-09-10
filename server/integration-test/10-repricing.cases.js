const suite = require('./suite-context');
const {
  assert,
  test,
  pool,
  request,
  schemas,
} = suite;

test('repricing financial audit is atomic, attributed, and idempotent', async () => {
  const actorUserId = Number(suite.authenticatedSession.applicationUser.id);
  await pool.query(
    'UPDATE price_matrix SET price = price + 37 WHERE scenario_id = $1',
    [schemas.ZZScenario]
  );
  let batchId;
  let applied = false;
  try {
    const preview = await request('/api/admin/repricing/preview', {
      method: 'POST', body: { scenarioId: schemas.ZZScenario },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const manualOverrides = preview.data.items
      .filter((item) => ['manual_price', 'price_missing'].includes(item.errorCode))
      .map((item) => ({
        productId: Number(item.productId),
        newPriceUah: Number(item.oldPriceUah),
      }));
    const payload = {
      scenarioId: schemas.ZZScenario,
      previewToken: preview.data.previewToken,
      manualOverrides,
    };
    const changedProductIds = preview.data.items
      .filter((item) => item.status === 'changed')
      .map((item) => Number(item.productId));
    assert.ok(changedProductIds.length > 0);
    const beforeApply = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    );
    const batchCountBefore = Number((await pool.query(
      'SELECT count(*) FROM repricing_batches'
    )).rows[0].count);

    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_repricing_applied_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced repricing applied audit failure';
      END;
      $$;
      CREATE TRIGGER fail_test_repricing_applied_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW
      WHEN (NEW.event_key = 'repricing.applied')
      EXECUTE FUNCTION fail_test_repricing_applied_audit();
    `);
    try {
      const failedApply = await request('/api/admin/repricing/apply', {
        method: 'POST',
        headers: { 'X-Request-ID': 'repricing-apply-audit-failure' },
        body: payload,
      });
      assert.equal(failedApply.response.status, 500, failedApply.text);
    } finally {
      await pool.query('DROP TRIGGER fail_test_repricing_applied_audit ON audit_events');
      await pool.query('DROP FUNCTION fail_test_repricing_applied_audit()');
    }
    assert.deepEqual((await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    )).rows, beforeApply.rows);
    assert.equal(Number((await pool.query(
      'SELECT count(*) FROM repricing_batches'
    )).rows[0].count), batchCountBefore);

    const successfulApply = await request('/api/admin/repricing/apply', {
      method: 'POST',
      headers: { 'X-Request-ID': 'repricing-applied' },
      body: payload,
    });
    assert.equal(successfulApply.response.status, 200, successfulApply.text);
    batchId = Number(successfulApply.data.batch.id);
    applied = true;
    const afterApply = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    );
    assert.equal(Number((await pool.query(
      'SELECT applied_by_user_id FROM repricing_batches WHERE id = $1', [batchId]
    )).rows[0].applied_by_user_id), actorUserId);
    assert.deepEqual((await pool.query(
      `SELECT event_key, actor_user_id, request_id, details
       FROM audit_events
       WHERE subject_type = 'repricing_batch' AND subject_id = $1
       ORDER BY id`,
      [String(batchId)]
    )).rows, [{
      event_key: 'repricing.applied',
      actor_user_id: String(actorUserId),
      request_id: 'repricing-applied',
      details: {},
    }]);

    const repeatedApply = await request('/api/admin/repricing/apply', {
      method: 'POST',
      headers: { 'X-Request-ID': 'repricing-applied-retry' },
      body: payload,
    });
    assert.equal(repeatedApply.response.status, 200, repeatedApply.text);
    assert.equal(repeatedApply.data.alreadyApplied, true);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE event_key = 'repricing.applied' AND subject_id = $1`,
      [String(batchId)]
    )).rows[0].count), 1);

    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_repricing_rollback_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'forced repricing rollback audit failure';
      END;
      $$;
      CREATE TRIGGER fail_test_repricing_rollback_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW
      WHEN (NEW.event_key = 'repricing.rolled_back')
      EXECUTE FUNCTION fail_test_repricing_rollback_audit();
    `);
    try {
      const failedRollback = await request(`/api/admin/repricing/${batchId}/rollback`, {
        method: 'POST',
        headers: { 'X-Request-ID': 'repricing-rollback-audit-failure' },
        body: {},
      });
      assert.equal(failedRollback.response.status, 500, failedRollback.text);
    } finally {
      await pool.query('DROP TRIGGER fail_test_repricing_rollback_audit ON audit_events');
      await pool.query('DROP FUNCTION fail_test_repricing_rollback_audit()');
    }
    assert.deepEqual((await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    )).rows, afterApply.rows);
    assert.deepEqual((await pool.query(
      'SELECT status, rolled_back_by_user_id FROM repricing_batches WHERE id = $1',
      [batchId]
    )).rows, [{ status: 'completed', rolled_back_by_user_id: null }]);

    const successfulRollback = await request(`/api/admin/repricing/${batchId}/rollback`, {
      method: 'POST',
      headers: { 'X-Request-ID': 'repricing-rolled-back' },
      body: {},
    });
    assert.equal(successfulRollback.response.status, 200, successfulRollback.text);
    applied = false;
    assert.deepEqual((await pool.query(
      'SELECT status, applied_by_user_id, rolled_back_by_user_id FROM repricing_batches WHERE id = $1',
      [batchId]
    )).rows, [{
      status: 'rolled_back',
      applied_by_user_id: String(actorUserId),
      rolled_back_by_user_id: String(actorUserId),
    }]);
    assert.deepEqual((await pool.query(
      `SELECT event_key, actor_user_id, request_id, details
       FROM audit_events
       WHERE subject_type = 'repricing_batch' AND subject_id = $1
       ORDER BY id`,
      [String(batchId)]
    )).rows, [
      {
        event_key: 'repricing.applied',
        actor_user_id: String(actorUserId),
        request_id: 'repricing-applied',
        details: {},
      },
      {
        event_key: 'repricing.rolled_back',
        actor_user_id: String(actorUserId),
        request_id: 'repricing-rolled-back',
        details: {},
      },
    ]);
    const repeatedRollback = await request(`/api/admin/repricing/${batchId}/rollback`, {
      method: 'POST',
      headers: { 'X-Request-ID': 'repricing-rolled-back-retry' },
      body: {},
    });
    assert.equal(repeatedRollback.response.status, 200, repeatedRollback.text);
    assert.equal(repeatedRollback.data.alreadyRolledBack, true);
    assert.equal(Number((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE event_key = 'repricing.rolled_back' AND subject_id = $1`,
      [String(batchId)]
    )).rows[0].count), 1);
  } finally {
    if (applied && batchId) {
      await request(`/api/admin/repricing/${batchId}/rollback`, { method: 'POST', body: {} });
    }
    await pool.query(
      'UPDATE price_matrix SET price = price - 37 WHERE scenario_id = $1',
      [schemas.ZZScenario]
    );
  }
});

test('repricing preview/apply/rollback and correction blocking work', async () => {
  await pool.query(
    'UPDATE price_matrix SET price = price + 113 WHERE scenario_id = $1',
    [schemas.ZZScenario]
  );
  const preview = await request('/api/admin/repricing/preview', {
    method: 'POST', body: { scenarioId: schemas.ZZScenario },
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.ok(preview.data.summary.changedCount > 0);
  const marketingRoundedItem = preview.data.items.find((item) => (
    item.status === 'changed' && Number(item.calculatedPriceUah) !== Number(item.newPriceUah)
  ));
  assert.ok(marketingRoundedItem);
  assert.equal(Number(marketingRoundedItem.automaticPriceUah), Number(marketingRoundedItem.newPriceUah));
  const manualOverrides = preview.data.items
    .filter((item) => ['manual_price', 'price_missing'].includes(item.errorCode))
    .map((item) => ({
      productId: Number(item.productId),
      newPriceUah: Number(item.oldPriceUah),
    }));
  const applied = await request('/api/admin/repricing/apply', {
    method: 'POST',
    body: {
      scenarioId: schemas.ZZScenario,
      previewToken: preview.data.previewToken,
      manualOverrides,
    },
  });
  assert.equal(applied.response.status, 200, applied.text);
  const batchId = applied.data.batch?.id || applied.data.batchId;
  const appliedItems = await pool.query(
    `SELECT ri.product_id, ri.old_price_uah, ri.new_price_uah,
            p.total_price_uah, p.details #>> '{repricing,batchId}' AS current_batch_id
     FROM repricing_items ri
     JOIN products p ON p.id = ri.product_id
     WHERE ri.batch_id = $1
     ORDER BY ri.product_id`,
    [batchId]
  );
  assert.ok(appliedItems.rows.length > 0);
  for (const item of appliedItems.rows) {
    assert.equal(Number(item.total_price_uah), Number(item.new_price_uah));
    assert.equal(Number(item.current_batch_id), Number(batchId));
  }
  const rolledBack = await request(`/api/admin/repricing/${batchId}/rollback`, {
    method: 'POST', body: {},
  });
  assert.equal(rolledBack.response.status, 200, rolledBack.text);
  const rolledBackItems = await pool.query(
    `SELECT ri.product_id, ri.old_price_uah, p.total_price_uah,
            p.details #>> '{repricing,batchId}' AS current_batch_id
     FROM repricing_items ri
     JOIN products p ON p.id = ri.product_id
     WHERE ri.batch_id = $1
     ORDER BY ri.product_id`,
    [batchId]
  );
  for (const item of rolledBackItems.rows) {
    assert.equal(Number(item.total_price_uah), Number(item.old_price_uah));
    assert.notEqual(Number(item.current_batch_id || 0), Number(batchId));
  }

  const candidate = await pool.query(
    `SELECT full_sku FROM products
     WHERE category = 'ZZ' AND status = 'active' AND details->'answers'->>'kind' = '1'
     ORDER BY id DESC LIMIT 1`
  );
  await pool.query(
    'UPDATE price_matrix SET price = price + 50 WHERE scenario_id = $1',
    [schemas.ZZScenario]
  );
  const racePreview = await request('/api/admin/repricing/preview', {
    method: 'POST', body: { scenarioId: schemas.ZZScenario },
  });
  const raceManualOverrides = racePreview.data.items
    .filter((item) => ['manual_price', 'price_missing'].includes(item.errorCode))
    .map((item) => ({
      productId: Number(item.productId),
      newPriceUah: Number(item.oldPriceUah),
    }));
  const lockClient = await pool.connect();
  await lockClient.query('BEGIN');
  await lockClient.query('SELECT id FROM products WHERE full_sku = $1 FOR UPDATE', [
    candidate.rows[0].full_sku,
  ]);
  const correctionPromise = request('/api/recount/apply', {
      method: 'POST',
      body: { sourceSku: candidate.rows[0].full_sku, answers: { kind: 2 }, reason: 'race repricing' },
  });
  const repricingPromise = request('/api/admin/repricing/apply', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        previewToken: racePreview.data.previewToken,
        manualOverrides: raceManualOverrides,
      },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await lockClient.query('COMMIT');
  lockClient.release();
  const raceResults = await Promise.all([correctionPromise, repricingPromise]);
  assert.deepEqual(raceResults.map((item) => item.response.status).sort(), [200, 409]);
});

test('repricing keeps manual-priced products editable across consecutive cycles', async () => {
  const createProduct = async (kind) => {
    const preview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const saved = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: preview.data.previewToken,
      },
    });
    assert.equal(saved.response.status, 200, saved.text);
    return {
      ...saved.data,
      currentPriceUah: Number(preview.data.totalPriceUah),
    };
  };

  const keepCurrentProduct = await createProduct(2);
  const newManualProduct = await createProduct(2);
  const automaticProduct = await createProduct(1);
  const appliedBatchIds = [];

  const removedCell = await pool.query(
    `DELETE FROM price_matrix
     WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0
     RETURNING price`,
    [schemas.ZZScenario]
  );
  assert.equal(removedCell.rowCount, 1);
  await pool.query(
    'UPDATE price_matrix SET price = price + 100 WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0',
    [schemas.ZZScenario]
  );

  try {
    const preview = await request('/api/admin/repricing/preview', {
      method: 'POST', body: { scenarioId: schemas.ZZScenario },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const missingItems = preview.data.items.filter((item) => item.errorCode === 'price_missing');
    const unresolvedItems = preview.data.items.filter(
      (item) => ['manual_price', 'price_missing'].includes(item.errorCode)
    );
    const missingProductIds = new Set(missingItems.map((item) => Number(item.productId)));
    assert.equal(missingProductIds.has(Number(keepCurrentProduct.id)), true);
    assert.equal(missingProductIds.has(Number(newManualProduct.id)), true);
    assert.equal(preview.data.summary.errorCount, unresolvedItems.length);
    assert.ok(preview.data.summary.changedCount > 0);

    const unresolved = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: { scenarioId: schemas.ZZScenario, previewToken: preview.data.previewToken },
    });
    assert.equal(unresolved.response.status, 422, unresolved.text);

    const manualOverrides = unresolvedItems.map((item) => ({
      productId: Number(item.productId),
      newPriceUah: Number(item.productId) === Number(newManualProduct.id)
        ? 1750
        : Number(item.oldPriceUah),
    }));
    const invalidOverrides = manualOverrides.map((override) => (
      Number(override.productId) === Number(keepCurrentProduct.id)
        ? { ...override, newPriceUah: 0 }
        : override
    ));
    const invalid = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        previewToken: preview.data.previewToken,
        manualOverrides: invalidOverrides,
      },
    });
    assert.equal(invalid.response.status, 422, invalid.text);

    const draft = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        manualOverrides,
        reviewedProductIds: [],
        uiState: {},
      },
    });
    assert.equal(draft.response.status, 200, draft.text);
    assert.deepEqual(draft.data.manualOverrides, manualOverrides);

    const applied = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        previewToken: preview.data.previewToken,
        manualOverrides,
        draftId: draft.data.draft.id,
      },
    });
    assert.equal(applied.response.status, 200, applied.text);
    appliedBatchIds.push(Number(applied.data.batch.id));

    const stored = await pool.query(
      `SELECT id, total_price_uah, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [[keepCurrentProduct.id, newManualProduct.id, automaticProduct.id]]
    );
    const storedById = new Map(stored.rows.map((row) => [Number(row.id), row]));
    const kept = storedById.get(Number(keepCurrentProduct.id));
    const changed = storedById.get(Number(newManualProduct.id));
    const automatic = storedById.get(Number(automaticProduct.id));
    assert.equal(Number(kept.total_price_uah), keepCurrentProduct.currentPriceUah);
    assert.equal(Number(kept.details.manualPriceUah), keepCurrentProduct.currentPriceUah);
    assert.equal(kept.details.autoPriceUah, null);
    assert.equal(kept.details.repricing.manualOverride, true);
    assert.equal(kept.details.repricing.calculatedPriceUah, null);
    assert.equal(Number(changed.total_price_uah), 1750);
    assert.equal(Number(changed.details.manualPriceUah), 1750);
    assert.equal(changed.details.autoPriceUah, null);
    assert.equal(changed.details.repricing.manualOverride, true);
    assert.equal(
      Number(automatic.total_price_uah),
      automaticProduct.currentPriceUah + 100
    );
    assert.equal(
      Number(automatic.details.autoPriceUah),
      automaticProduct.currentPriceUah + 100
    );
    assert.equal(automatic.details.manualPriceUah, null);
    assert.equal(automatic.details.repricing.manualOverride, false);

    const secondPreview = await request('/api/admin/repricing/preview', {
      method: 'POST', body: { scenarioId: schemas.ZZScenario },
    });
    assert.equal(secondPreview.response.status, 200, secondPreview.text);
    const manualItems = secondPreview.data.items.filter(
      (item) => item.errorCode === 'manual_price'
    );
    const repeatedManualItem = manualItems.find(
      (item) => Number(item.productId) === Number(newManualProduct.id)
    );
    assert.ok(repeatedManualItem, 'the manually-priced product must remain in the next preview');
    assert.equal(Number(repeatedManualItem.oldPriceUah), 1750);

    const secondManualOverrides = manualItems.map((item) => ({
      productId: Number(item.productId),
      newPriceUah: Number(item.productId) === Number(newManualProduct.id)
        ? 1850
        : Number(item.oldPriceUah),
    }));
    const secondDraft = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        manualOverrides: secondManualOverrides,
        reviewedProductIds: [],
        uiState: {},
      },
    });
    assert.equal(secondDraft.response.status, 200, secondDraft.text);

    const secondApplied = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: {
        scenarioId: schemas.ZZScenario,
        previewToken: secondPreview.data.previewToken,
        manualOverrides: secondManualOverrides,
        draftId: secondDraft.data.draft.id,
      },
    });
    assert.equal(secondApplied.response.status, 200, secondApplied.text);
    appliedBatchIds.push(Number(secondApplied.data.batch.id));

    const storedAfterSecondCycle = await pool.query(
      `SELECT total_price_uah, details
       FROM products WHERE id = $1`,
      [newManualProduct.id]
    );
    assert.equal(Number(storedAfterSecondCycle.rows[0].total_price_uah), 1850);
    assert.equal(Number(storedAfterSecondCycle.rows[0].details.manualPriceUah), 1850);
    assert.equal(storedAfterSecondCycle.rows[0].details.autoPriceUah, null);
    assert.equal(storedAfterSecondCycle.rows[0].details.repricing.manualOverride, true);
  } finally {
    for (const appliedBatchId of [...appliedBatchIds].reverse()) {
      const rollback = await request(`/api/admin/repricing/${appliedBatchId}/rollback`, {
        method: 'POST', body: {},
      });
      assert.equal(rollback.response.status, 200, rollback.text);
    }
    await pool.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       VALUES ($1, 2, 0, $2)
       ON CONFLICT (scenario_id, x_val, y_val) DO UPDATE SET price = EXCLUDED.price`,
      [schemas.ZZScenario, removedCell.rows[0].price]
    );
    await pool.query(
      'UPDATE price_matrix SET price = price - 100 WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0',
      [schemas.ZZScenario]
    );
  }
});

test('repricing rolls back every product and batch row after a mid-apply failure', async () => {
  await pool.query(
    'UPDATE price_matrix SET price = price + 30 WHERE scenario_id = $1',
    [schemas.ZZScenario]
  );
  try {
    const preview = await request('/api/admin/repricing/preview', {
      method: 'POST', body: { scenarioId: schemas.ZZScenario },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const changedItems = preview.data.items.filter((item) => item.status === 'changed');
    const manualOverrides = preview.data.items
      .filter((item) => ['manual_price', 'price_missing'].includes(item.errorCode))
      .map((item) => ({
        productId: Number(item.productId),
        newPriceUah: Number(item.oldPriceUah),
      }));
    assert.ok(changedItems.length >= 2);
    const productIds = changedItems.map((item) => Number(item.productId));
    const before = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [productIds]
    );
    const failureProductId = productIds[1];
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_repricing_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = ${failureProductId}
           AND NEW.details #>> '{repricing,batchId}'
               IS DISTINCT FROM OLD.details #>> '{repricing,batchId}' THEN
          RAISE EXCEPTION 'forced repricing failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_test_repricing_update
      BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION fail_test_repricing_update();
    `);
    try {
      const failed = await request('/api/admin/repricing/apply', {
        method: 'POST',
        body: {
          scenarioId: schemas.ZZScenario,
          previewToken: preview.data.previewToken,
          manualOverrides,
        },
      });
      assert.equal(failed.response.status, 500);
    } finally {
      await pool.query('DROP TRIGGER fail_test_repricing_update ON products');
      await pool.query('DROP FUNCTION fail_test_repricing_update()');
    }
    const after = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [productIds]
    );
    assert.deepEqual(after.rows, before.rows);
    const persisted = await pool.query(
      `SELECT count(*)::int AS batches
       FROM repricing_batches
       WHERE preview_token = $1 AND status = 'completed'`,
      [preview.data.previewToken]
    );
    assert.equal(persisted.rows[0].batches, 0);
  } finally {
    await pool.query(
      'UPDATE price_matrix SET price = price - 30 WHERE scenario_id = $1',
      [schemas.ZZScenario]
    );
  }
});

test('global repricing is authoritative, atomic, unique per product, and fully rollbackable', async () => {
  const createProduct = async (categoryCode, kind, manualPriceUah = null) => {
    const preview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode, answers: { kind }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(preview.response.status, 200, preview.text);
    const saved = await request('/api/save', {
      method: 'POST',
      body: {
        category: categoryCode,
        answers: { kind },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas[categoryCode],
        previewToken: preview.data.previewToken,
        manualPriceUah,
      },
    });
    assert.equal(saved.response.status, 200, saved.text);
    return saved.data;
  };
  const overridesFor = (preview, excludedProductIds = []) => {
    const excluded = new Set(excludedProductIds.map(Number));
    return preview.items
    .filter((item) => (
      ['manual_price', 'price_missing'].includes(item.errorCode)
      && !excluded.has(Number(item.productId))
    ))
    .map((item) => ({
      productId: Number(item.productId),
      newPriceUah: Number(item.oldPriceUah) > 0 ? Number(item.oldPriceUah) : 500,
    }));
  };

  const changedAutomatic = await createProduct('ZZ', 1);
  const unchangedAutomatic = await createProduct('ZZ', 2);
  const automaticSwitchProduct = await createProduct('ZZ', 1, 700);
  const manualProduct = await createProduct('MM', 1, 700);
  const changedManualProduct = await createProduct('MM', 1, 750);
  const missingProduct = await createProduct('MM', 2, 800);
  await pool.query(
    `UPDATE products
     SET details = details - 'manualPriceUah'
     WHERE id = $1`,
    [missingProduct.id]
  );

  const semiScenario = await pool.query(
    `SELECT id FROM price_scenarios
     WHERE category_code = 'LN'
       AND status = 'active'
       AND match_json @> '{"is_calibrated":2}'::jsonb
     ORDER BY priority DESC, id
     LIMIT 1`
  );
  assert.equal(semiScenario.rows.length, 1);
  const semiScenarioId = Number(semiScenario.rows[0].id);
  const originalCells = await pool.query(
    `SELECT scenario_id, x_val, y_val, price
     FROM price_matrix
     WHERE (scenario_id = $1 AND x_val = 1 AND y_val = 0)
        OR (scenario_id = $2 AND x_val = 6 AND y_val = 0)
     ORDER BY scenario_id, x_val, y_val`,
    [schemas.ZZScenario, semiScenarioId]
  );
  assert.equal(originalCells.rows.length, 2);

  let activeRequestId = null;
  let appliedBatchId = null;
  let activeDraftId = null;
  let overlappingScenarioId = null;
  try {
    const overlappingScenario = await pool.query(
      `INSERT INTO price_scenarios
       (category_code, name, match_json, axis_x_key, axis_y_key, priority,
        status, price_mode, apply_modifiers)
       VALUES ('ZZ', 'Lower-priority overlap', '{}'::jsonb, 'kind', NULL, -100,
               'active', 'fixed_uah', TRUE)
       RETURNING id`
    );
    overlappingScenarioId = Number(overlappingScenario.rows[0].id);
    await pool.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       VALUES ($1, 1, 0, 9999), ($1, 2, 0, 9999)`,
      [overlappingScenarioId]
    );
    await pool.query(
      `UPDATE price_matrix
       SET price = CASE WHEN scenario_id = $1 THEN price + 38 ELSE price + 0.25 END
       WHERE (scenario_id = $1 AND x_val = 1 AND y_val = 0)
          OR (scenario_id = $2 AND x_val = 6 AND y_val = 0)`,
      [schemas.ZZScenario, semiScenarioId]
    );

    const initial = await request('/api/admin/repricing/global/preview', {
      method: 'POST', body: {},
    });
    assert.equal(initial.response.status, 200, initial.text);
    assert.equal(initial.data.scope, 'global');
    assert.equal(initial.data.summary.candidateCount, initial.data.items.length);
    assert.equal(
      new Set(initial.data.items.map((item) => Number(item.productId))).size,
      initial.data.items.length,
      'every active product must occur at most once'
    );
    const changedScenarioIds = new Set(
      initial.data.items
        .filter((item) => item.status === 'changed')
        .map((item) => Number(item.scenarioId))
    );
    assert.equal(changedScenarioIds.has(Number(schemas.ZZScenario)), true);
    assert.equal(changedScenarioIds.has(semiScenarioId), true);
    assert.equal(
      initial.data.items.find((item) => Number(item.productId) === Number(unchangedAutomatic.id))?.status,
      'unchanged'
    );
    assert.equal(
      initial.data.items.find((item) => Number(item.productId) === Number(changedAutomatic.id))?.scenarioId,
      Number(schemas.ZZScenario),
      'a product matching multiple scenarios must use normal authoritative precedence'
    );
    const manualOnlyPreviewItem = initial.data.items.find((item) => (
      Number(item.productId) === Number(manualProduct.id)
    ));
    assert.equal(manualOnlyPreviewItem?.errorCode, 'manual_price');
    assert.equal(manualOnlyPreviewItem?.calculatedPriceUah, null);
    const switchPreviewItem = initial.data.items.find((item) => (
      Number(item.productId) === Number(automaticSwitchProduct.id)
    ));
    assert.equal(switchPreviewItem?.errorCode, 'manual_price');
    assert.ok(Number(switchPreviewItem?.calculatedPriceUah) > 0);
    assert.ok(Number(switchPreviewItem?.automaticPriceUah) > 0);
    assert.notEqual(
      Number(switchPreviewItem?.calculatedPriceUah),
      Number(switchPreviewItem?.automaticPriceUah)
    );
    assert.ok(switchPreviewItem?.pricingDetails?.matrix);
    assert.equal(
      initial.data.items.find((item) => Number(item.productId) === Number(missingProduct.id))?.errorCode,
      'price_missing'
    );

    const automaticProductIds = [Number(automaticSwitchProduct.id)];
    const initialOverrides = overridesFor(initial.data, automaticProductIds);
    assert.ok(initialOverrides.length >= 2);
    const invalidOverrides = initialOverrides.map((override) => (
      Number(override.productId) === Number(manualProduct.id)
        ? { ...override, newPriceUah: 0 }
        : override
    ));
    assert.equal(
      invalidOverrides.find((override) => (
        Number(override.productId) === Number(manualProduct.id)
      ))?.newPriceUah,
      0
    );
    const invalid = await request('/api/admin/repricing/global/apply', {
      method: 'POST',
      body: {
        previewToken: initial.data.previewToken,
        manualOverrides: invalidOverrides,
        automaticProductIds,
      },
    });
    assert.equal(invalid.response.status, 422, invalid.text);

    await pool.query(
      `UPDATE price_matrix SET price = price + 1
       WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0`,
      [schemas.ZZScenario]
    );
    const stalePricing = await request('/api/admin/repricing/global/apply', {
      method: 'POST',
      body: {
        previewToken: initial.data.previewToken,
        manualOverrides: initialOverrides,
        automaticProductIds,
      },
    });
    assert.equal(stalePricing.response.status, 409, stalePricing.text);
    await pool.query(
      `UPDATE price_matrix SET price = price - 1
       WHERE scenario_id = $1 AND x_val = 1 AND y_val = 0`,
      [schemas.ZZScenario]
    );

    const beforeProductChange = await request('/api/admin/repricing/global/preview', {
      method: 'POST', body: {},
    });
    const changedProductRow = await pool.query(
      'SELECT details FROM products WHERE id = $1',
      [changedAutomatic.id]
    );
    await pool.query(
      `UPDATE products
       SET details = jsonb_set(details, '{globalRepricingTest}', 'true'::jsonb)
       WHERE id = $1`,
      [changedAutomatic.id]
    );
    const staleProduct = await request('/api/admin/repricing/global/apply', {
      method: 'POST',
      body: {
        previewToken: beforeProductChange.data.previewToken,
        manualOverrides: overridesFor(beforeProductChange.data),
      },
    });
    assert.equal(staleProduct.response.status, 409, staleProduct.text);
    await pool.query('UPDATE products SET details = $1::jsonb WHERE id = $2', [
      JSON.stringify(changedProductRow.rows[0].details),
      changedAutomatic.id,
    ]);

    const beforeCorrectionRequest = await request('/api/admin/repricing/global/preview', {
      method: 'POST', body: {},
    });
    const requestRow = await pool.query(
      `INSERT INTO correction_requests
       (source_product_id, category_code, source_sku, proposed_sku, old_payload,
        proposed_payload, changes, status, preview_signature)
       SELECT id, category, full_sku, full_sku || '-999', '{}'::jsonb,
              '{}'::jsonb, '[]'::jsonb, 'pending', 'global-repricing-test'
       FROM products WHERE id = $1
       RETURNING id`,
      [changedAutomatic.id]
    );
    activeRequestId = Number(requestRow.rows[0].id);
    const blocked = await request('/api/admin/repricing/global/apply', {
      method: 'POST',
      body: {
        previewToken: beforeCorrectionRequest.data.previewToken,
        manualOverrides: overridesFor(beforeCorrectionRequest.data),
      },
    });
    assert.equal(blocked.response.status, 409, blocked.text);
    assert.equal(blocked.data.details?.type, 'active_correction_requests');
    await pool.query('DELETE FROM correction_requests WHERE id = $1', [activeRequestId]);
    activeRequestId = null;

    const finalPreview = await request('/api/admin/repricing/global/preview', {
      method: 'POST', body: {},
    });
    assert.equal(finalPreview.response.status, 200, finalPreview.text);
    const nonResolvableErrors = finalPreview.data.items.filter((item) => (
      item.status === 'error'
      && !['manual_price', 'price_missing'].includes(item.errorCode)
    ));
    assert.deepEqual(nonResolvableErrors, []);
    const manualOverrides = overridesFor(finalPreview.data, automaticProductIds)
      .map((override) => (
        Number(override.productId) === Number(changedManualProduct.id)
          ? { ...override, newPriceUah: Number(override.newPriceUah) + 25 }
          : override
      ));
    const keptManualOverride = manualOverrides.find((override) => (
      Number(override.productId) === Number(manualProduct.id)
    ));
    assert.equal(keptManualOverride?.newPriceUah, Number(
      finalPreview.data.items.find((item) => (
        Number(item.productId) === Number(manualProduct.id)
      )).oldPriceUah
    ));
    const changedProductIds = finalPreview.data.items
      .filter((item) => (
        item.status === 'changed'
        || ['manual_price', 'price_missing'].includes(item.errorCode)
      ))
      .map((item) => Number(item.productId))
      .sort((first, second) => first - second);
    assert.ok(changedProductIds.length >= 2);
    const beforeApply = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    );
    const batchesBeforeFailure = await pool.query(
      "SELECT count(*)::int AS count FROM repricing_batches WHERE scope = 'global'"
    );
    const failureProductId = changedProductIds[1];
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_global_repricing_update()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = ${failureProductId}
           AND NEW.details #>> '{repricing,batchId}'
               IS DISTINCT FROM OLD.details #>> '{repricing,batchId}' THEN
          RAISE EXCEPTION 'forced global repricing failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_test_global_repricing_update
      BEFORE UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION fail_test_global_repricing_update();
    `);
    try {
      const failed = await request('/api/admin/repricing/global/apply', {
        method: 'POST',
        body: {
          previewToken: finalPreview.data.previewToken,
          manualOverrides,
          automaticProductIds,
        },
      });
      assert.equal(failed.response.status, 500, failed.text);
    } finally {
      await pool.query('DROP TRIGGER fail_test_global_repricing_update ON products');
      await pool.query('DROP FUNCTION fail_test_global_repricing_update()');
    }
    const afterFailure = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    );
    assert.deepEqual(afterFailure.rows, beforeApply.rows);
    const batchesAfterFailure = await pool.query(
      "SELECT count(*)::int AS count FROM repricing_batches WHERE scope = 'global'"
    );
    assert.equal(batchesAfterFailure.rows[0].count, batchesBeforeFailure.rows[0].count);

    const draft = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      body: {
        scope: 'global',
        manualOverrides,
        automaticProductIds,
        reviewedProductIds: [
          changedAutomatic.id,
          manualProduct.id,
          automaticSwitchProduct.id,
        ],
        uiState: { filter: 'all', scenarioFilter: String(schemas.ZZScenario) },
      },
    });
    assert.equal(draft.response.status, 200, draft.text);
    assert.equal(draft.data.draft.scope, 'global');
    assert.equal(draft.data.draft.scenarioId, null);
    assert.deepEqual(draft.data.draft.automaticProductIds, automaticProductIds);
    assert.equal(draft.data.draft.uiState.scenarioFilter, String(schemas.ZZScenario));
    assert.equal(
      draft.data.draft.manualOverrides.find((override) => (
        Number(override.productId) === Number(manualProduct.id)
      ))?.newPriceUah,
      keptManualOverride.newPriceUah
    );
    assert.equal(
      draft.data.draft.reviewedProductIds.includes(Number(manualProduct.id)),
      true
    );
    assert.equal(
      draft.data.draft.reviewedProductIds.includes(Number(automaticSwitchProduct.id)),
      true
    );
    activeDraftId = Number(draft.data.draft.id);

    const reopenedDraft = await request(`/api/admin/repricing/drafts/${activeDraftId}`);
    assert.equal(reopenedDraft.response.status, 200, reopenedDraft.text);
    assert.deepEqual(reopenedDraft.data.automaticProductIds, automaticProductIds);
    assert.equal(
      reopenedDraft.data.manualOverrides.find((override) => (
        Number(override.productId) === Number(manualProduct.id)
      ))?.newPriceUah,
      keptManualOverride.newPriceUah
    );
    assert.equal(
      reopenedDraft.data.draft.reviewedProductIds.includes(Number(manualProduct.id)),
      true
    );

    const applied = await request('/api/admin/repricing/global/apply', {
      method: 'POST',
      body: {
        previewToken: finalPreview.data.previewToken,
        manualOverrides,
        automaticProductIds,
        draftId: activeDraftId,
      },
    });
    assert.equal(applied.response.status, 200, applied.text);
    assert.equal(applied.data.batch.scope, 'global');
    appliedBatchId = Number(applied.data.batch.id);
    activeDraftId = null;
    const appliedItems = await pool.query(
      `SELECT ri.product_id, ri.new_price_uah, p.total_price_uah,
              p.details #>> '{repricing,batchId}' AS batch_id,
              p.details #>> '{pricingScenario,id}' AS scenario_id,
              p.details ->> 'calculatedPriceUah' AS calculated_price_uah,
              p.details ->> 'autoPriceUah' AS auto_price_uah,
              p.details ->> 'manualPriceUah' AS manual_price_uah,
              p.details #>> '{repricing,calculatedPriceUah}' AS repricing_calculated_price_uah,
              p.details #>> '{repricing,autoPriceUah}' AS repricing_auto_price_uah,
              p.details #>> '{repricing,useAutomatic}' AS use_automatic,
              p.details #>> '{repricing,manualOverride}' AS manual_override
       FROM repricing_items ri
       JOIN products p ON p.id = ri.product_id
       WHERE ri.batch_id = $1
       ORDER BY ri.product_id`,
      [appliedBatchId]
    );
    assert.equal(appliedItems.rows.length, changedProductIds.length);
    for (const item of appliedItems.rows) {
      assert.equal(Number(item.total_price_uah), Number(item.new_price_uah));
      assert.equal(Number(item.batch_id), appliedBatchId);
    }
    const appliedScenarioIds = new Set(
      appliedItems.rows.map((item) => Number(item.scenario_id)).filter(Number.isFinite)
    );
    assert.equal(appliedScenarioIds.has(Number(schemas.ZZScenario)), true);
    assert.equal(appliedScenarioIds.has(semiScenarioId), true);
    const switchedProduct = appliedItems.rows.find((item) => (
      Number(item.product_id) === Number(automaticSwitchProduct.id)
    ));
    assert.equal(switchedProduct.manual_price_uah, null);
    assert.equal(switchedProduct.use_automatic, 'true');
    assert.equal(switchedProduct.manual_override, 'false');
    assert.equal(
      Number(switchedProduct.calculated_price_uah),
      Number(switchedProduct.repricing_calculated_price_uah)
    );
    assert.equal(Number(switchedProduct.auto_price_uah), Number(switchedProduct.new_price_uah));
    assert.equal(
      Number(switchedProduct.repricing_auto_price_uah),
      Number(switchedProduct.new_price_uah)
    );
    assert.equal(Number(switchedProduct.new_price_uah), Number(
      finalPreview.data.items.find((item) => (
        Number(item.productId) === Number(automaticSwitchProduct.id)
      )).automaticPriceUah
    ));
    const keptManualProduct = appliedItems.rows.find((item) => (
      Number(item.product_id) === Number(manualProduct.id)
    ));
    assert.equal(Number(keptManualProduct.manual_price_uah), 700);
    assert.equal(keptManualProduct.manual_override, 'true');
    const changedManual = appliedItems.rows.find((item) => (
      Number(item.product_id) === Number(changedManualProduct.id)
    ));
    assert.equal(Number(changedManual.manual_price_uah), 775);
    assert.equal(Number(changedManual.new_price_uah), 775);

    await pool.query(
      'UPDATE products SET total_price_uah = total_price_uah + 1 WHERE id = $1',
      [changedProductIds[0]]
    );
    const unsafeRollback = await request(`/api/admin/repricing/${appliedBatchId}/rollback`, {
      method: 'POST', body: {},
    });
    assert.equal(unsafeRollback.response.status, 409, unsafeRollback.text);
    const expectedNewPrice = appliedItems.rows.find(
      (item) => Number(item.product_id) === changedProductIds[0]
    ).new_price_uah;
    await pool.query('UPDATE products SET total_price_uah = $1 WHERE id = $2', [
      expectedNewPrice,
      changedProductIds[0],
    ]);
    const rolledBack = await request(`/api/admin/repricing/${appliedBatchId}/rollback`, {
      method: 'POST', body: {},
    });
    assert.equal(rolledBack.response.status, 200, rolledBack.text);
    const afterRollback = await pool.query(
      `SELECT id, total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = ANY($1::int[]) ORDER BY id`,
      [changedProductIds]
    );
    assert.deepEqual(afterRollback.rows, beforeApply.rows);
    appliedBatchId = null;
  } finally {
    if (activeRequestId) {
      await pool.query('DELETE FROM correction_requests WHERE id = $1', [activeRequestId]);
    }
    if (appliedBatchId) {
      await request(`/api/admin/repricing/${appliedBatchId}/rollback`, {
        method: 'POST', body: {},
      });
    }
    if (activeDraftId) {
      await pool.query(
        `UPDATE repricing_drafts
         SET status = 'discarded', discarded_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND status = 'draft'`,
        [activeDraftId]
      );
    }
    if (overlappingScenarioId) {
      await pool.query('DELETE FROM price_scenarios WHERE id = $1', [overlappingScenarioId]);
    }
    for (const cell of originalCells.rows) {
      await pool.query(
        `UPDATE price_matrix SET price = $1
         WHERE scenario_id = $2 AND x_val = $3 AND y_val = $4`,
        [cell.price, cell.scenario_id, cell.x_val, cell.y_val]
      );
    }
  }
});
