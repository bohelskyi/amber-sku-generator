const suite = require('./suite-context');
const {
  assert,
  crypto,
  pool,
  request,
  schemas,
  test,
} = suite;

async function ensureSession() {
  if (!suite.authenticatedSession) {
    suite.authenticatedSession = await suite.authenticateApplicationSession('/');
  }
}

async function createPriceChangeProduct({ priceUah = 2400 } = {}) {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  const fullSku = `PC${suffix}`;
  const result = await pool.query(
    `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price,
        total_price_uah, price_per_gram, uah_rate, details, sku_schema_version_id)
     VALUES ($1, $1, 0, 'LN', 10, $2, $3, 6, 40,
       $4::jsonb, $5)
     RETURNING id, full_sku, sku_schema_version_id, details`,
    [
      fullSku,
      priceUah / 40,
      priceUah,
      JSON.stringify({
        answers: { raw_type: 1, size: 3, shape: 6, is_calibrated: 1 },
        isCalibrated: 1,
      }),
      schemas.LN,
    ]
  );
  return result.rows[0];
}

async function removeProduct(productId) {
  await pool.query('DELETE FROM correction_requests WHERE source_product_id = $1', [productId]);
  await pool.query('DELETE FROM products WHERE id = $1', [productId]);
}

async function preview(productId, pricingDecision) {
  return request('/api/product-price-change/preview', {
    method: 'POST',
    body: { productId, pricingDecision },
  });
}

async function apply(productId, pricingDecision, previewToken) {
  return request('/api/product-price-change/apply', {
    method: 'POST',
    body: { productId, pricingDecision, previewToken },
  });
}

test('manual UAH changes pricing in place and records price-only audit and timeline evidence', async () => {
  await ensureSession();
  const product = await createPriceChangeProduct();
  try {
    const before = (await pool.query(
      `SELECT id, full_sku, sku_schema_version_id, details,
              (SELECT count(*) FROM sku_registry WHERE full_sku = products.full_sku) AS registry_count
       FROM products WHERE id = $1`,
      [product.id]
    )).rows[0];
    const decision = {
      mode: 'manual_uah', manualPriceUah: 2500, marketingRoundingEnabled: false,
    };
    const pricePreview = await preview(product.id, decision);
    assert.equal(pricePreview.response.status, 200, pricePreview.text);
    assert.equal(pricePreview.data.sku, product.full_sku);
    assert.equal(pricePreview.data.currentPriceUah, 2400);
    assert.equal(pricePreview.data.resultingPriceUah, 2500);
    assert.equal(pricePreview.data.priceDifferenceUah, 100);

    const changed = await apply(product.id, decision, pricePreview.data.previewToken);
    assert.equal(changed.response.status, 200, changed.text);
    assert.equal(changed.data.productId, Number(product.id));
    assert.equal(changed.data.sku, product.full_sku);

    const after = (await pool.query(
      `SELECT id, full_sku, sku_schema_version_id, weight, total_price,
              total_price_uah, price_per_gram, uah_rate, details,
              (SELECT count(*) FROM sku_registry WHERE full_sku = products.full_sku) AS registry_count
       FROM products WHERE id = $1`,
      [product.id]
    )).rows[0];
    assert.equal(Number(after.id), Number(before.id));
    assert.equal(after.full_sku, before.full_sku);
    assert.equal(Number(after.sku_schema_version_id), Number(before.sku_schema_version_id));
    assert.deepEqual(after.details.answers, before.details.answers);
    assert.equal(after.details.isCalibrated, before.details.isCalibrated);
    assert.equal(Number(after.weight), 10);
    assert.equal(Number(after.total_price_uah), 2500);
    assert.equal(Number(after.total_price), 62.5);
    assert.equal(Number(after.price_per_gram), 6.25);
    assert.equal(Number(after.uah_rate), 40);
    assert.equal(after.details.calculatedPriceUah, 2400);
    assert.equal(after.details.autoPriceUah, 2400);
    assert.equal(after.details.manualPriceUah, 2500);
    assert.equal(Number(after.registry_count), Number(before.registry_count));
    assert.equal((await pool.query(
      'SELECT count(*) FROM product_corrections WHERE source_product_id = $1 OR corrected_product_id = $1',
      [product.id]
    )).rows[0].count, '0');

    const audit = (await pool.query(
      `SELECT actor_user_id, occurred_at, details
       FROM audit_events
       WHERE event_key = 'product.price_changed'
         AND subject_type = 'product' AND subject_id = $1
       ORDER BY id DESC LIMIT 1`,
      [String(product.id)]
    )).rows[0];
    assert.ok(Number(audit.actor_user_id) > 0);
    assert.ok(audit.occurred_at);
    assert.equal(audit.details.fullSku, product.full_sku);
    assert.equal(audit.details.priceMode, 'manual_uah');
    assert.deepEqual(audit.details.pricingDecision, decision);
    assert.equal(audit.details.oldPrice.totalPriceUah, 2400);
    assert.equal(audit.details.newPrice.totalPriceUah, 2500);

    const timeline = await request(`/api/product-timeline?sku=${product.full_sku}`);
    assert.equal(timeline.response.status, 200, timeline.text);
    const event = timeline.data.events.find((item) => item.type === 'product.price_changed');
    assert.ok(event);
    assert.deepEqual(event.changes, []);
    assert.equal(event.details.price.beforeUah, 2400);
    assert.equal(event.details.price.afterUah, 2500);
    assert.deepEqual(event.details.pricingDecision, decision);
    assert.equal(timeline.data.lineage.products.length, 1);
  } finally {
    await removeProduct(product.id);
  }
});

test('manual UAH marketing rounding is optional, authoritative, and bound to preview state', async () => {
  await ensureSession();
  const product = await createPriceChangeProduct();
  try {
    const exactDecision = {
      mode: 'manual_uah', manualPriceUah: 2476, marketingRoundingEnabled: false,
    };
    const exactPreview = await preview(product.id, exactDecision);
    assert.equal(exactPreview.response.status, 200, exactPreview.text);
    assert.equal(exactPreview.data.resultingPriceUah, 2476);
    const exactChange = await apply(product.id, exactDecision, exactPreview.data.previewToken);
    assert.equal(exactChange.response.status, 200, exactChange.text);
    assert.equal(Number((await pool.query(
      'SELECT total_price_uah FROM products WHERE id = $1', [product.id]
    )).rows[0].total_price_uah), 2476);

    const roundedDecision = {
      mode: 'manual_uah', manualPriceUah: 2526, marketingRoundingEnabled: true,
    };
    const roundedPreview = await preview(product.id, roundedDecision);
    assert.equal(roundedPreview.response.status, 200, roundedPreview.text);
    assert.equal(roundedPreview.data.resultingPriceUah, 2550);
    const roundedChange = await apply(
      product.id,
      roundedDecision,
      roundedPreview.data.previewToken
    );
    assert.equal(roundedChange.response.status, 200, roundedChange.text);
    const roundedStored = (await pool.query(
      `SELECT total_price_uah, details FROM products WHERE id = $1`, [product.id]
    )).rows[0];
    assert.equal(Number(roundedStored.total_price_uah), 2550);
    assert.equal(roundedStored.details.manualPriceUah, 2550);

    const noOpDecision = {
      mode: 'manual_uah', manualPriceUah: 2549, marketingRoundingEnabled: true,
    };
    const noOpPreview = await preview(product.id, noOpDecision);
    assert.equal(noOpPreview.response.status, 200, noOpPreview.text);
    assert.equal(noOpPreview.data.resultingPriceUah, 2550);
    assert.equal(noOpPreview.data.unchanged, true);
    const noOpApply = await apply(product.id, noOpDecision, noOpPreview.data.previewToken);
    assert.equal(noOpApply.response.status, 422, noOpApply.text);
    assert.equal(noOpApply.data.code, 'PRODUCT_PRICE_UNCHANGED');

    const stalePreviewDecision = {
      mode: 'manual_uah', manualPriceUah: 2576, marketingRoundingEnabled: true,
    };
    const stalePreview = await preview(product.id, stalePreviewDecision);
    assert.equal(stalePreview.response.status, 200, stalePreview.text);
    assert.equal(stalePreview.data.resultingPriceUah, 2600);
    const changedChoice = {
      ...stalePreviewDecision,
      marketingRoundingEnabled: false,
    };
    const staleApply = await apply(product.id, changedChoice, stalePreview.data.previewToken);
    assert.equal(staleApply.response.status, 409, staleApply.text);
    assert.equal(staleApply.data.code, 'STALE_PRODUCT_PRICE_PREVIEW');

    const roundedAudit = (await pool.query(
      `SELECT details FROM audit_events
       WHERE event_key = 'product.price_changed' AND subject_id = $1
       ORDER BY id DESC LIMIT 1`,
      [String(product.id)]
    )).rows[0].details;
    assert.deepEqual(roundedAudit.pricingDecision, roundedDecision);
    assert.equal(roundedAudit.newPrice.manualPriceUah, 2550);
    assert.equal(roundedAudit.newPrice.totalPriceUah, 2550);
  } finally {
    await removeProduct(product.id);
  }
});

test('USD/g is calculated server-side and invalid or unchanged prices are rejected', async () => {
  await ensureSession();
  const product = await createPriceChangeProduct();
  try {
    for (const pricingDecision of [
      { mode: 'manual_uah', manualPriceUah: '' },
      { mode: 'manual_uah', manualPriceUah: 0, marketingRoundingEnabled: false },
      { mode: 'manual_uah', manualPriceUah: -1, marketingRoundingEnabled: false },
      { mode: 'manual_uah', manualPriceUah: 'Infinity', marketingRoundingEnabled: false },
      { mode: 'usd_per_gram', usdPerGram: '', marketingRoundingEnabled: false },
      { mode: 'usd_per_gram', usdPerGram: 0, marketingRoundingEnabled: false },
      { mode: 'usd_per_gram', usdPerGram: -1, marketingRoundingEnabled: false },
      { mode: 'usd_per_gram', usdPerGram: 1.12345, marketingRoundingEnabled: false },
    ]) {
      const invalid = await preview(product.id, pricingDecision);
      assert.equal(invalid.response.status, 422, invalid.text);
    }

    const unchangedDecision = {
      mode: 'manual_uah', manualPriceUah: 2400, marketingRoundingEnabled: false,
    };
    const unchangedPreview = await preview(product.id, unchangedDecision);
    assert.equal(unchangedPreview.response.status, 200, unchangedPreview.text);
    assert.equal(unchangedPreview.data.unchanged, true);
    const unchangedApply = await apply(
      product.id,
      unchangedDecision,
      unchangedPreview.data.previewToken
    );
    assert.equal(unchangedApply.response.status, 422, unchangedApply.text);
    assert.equal(unchangedApply.data.code, 'PRODUCT_PRICE_UNCHANGED');

    const decision = {
      mode: 'usd_per_gram',
      usdPerGram: 7,
      marketingRoundingEnabled: false,
    };
    const pricePreview = await preview(product.id, decision);
    assert.equal(pricePreview.response.status, 200, pricePreview.text);
    assert.equal(pricePreview.data.resultingPriceUah, 2800);
    const changed = await apply(product.id, decision, pricePreview.data.previewToken);
    assert.equal(changed.response.status, 200, changed.text);
    const stored = (await pool.query(
      `SELECT total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = $1`,
      [product.id]
    )).rows[0];
    assert.equal(Number(stored.total_price), 70);
    assert.equal(Number(stored.total_price_uah), 2800);
    assert.equal(Number(stored.price_per_gram), 7);
    assert.equal(Number(stored.uah_rate), 40);
    assert.equal(stored.details.calculatedPriceUah, 2800);
    assert.equal(stored.details.autoPriceUah, 2800);
    assert.equal(stored.details.manualPriceUah, null);
    assert.deepEqual(stored.details.customUsdPerGramBasis, {
      usdPerGram: 7,
      marketingRoundingEnabled: false,
      source: 'product_price_change',
    });
  } finally {
    await removeProduct(product.id);
  }
});

test('concurrent price changes serialize on the product and reject the stale request', async () => {
  await ensureSession();
  const product = await createPriceChangeProduct();
  try {
    const decision = {
      mode: 'manual_uah', manualPriceUah: 2600, marketingRoundingEnabled: false,
    };
    const pricePreview = await preview(product.id, decision);
    assert.equal(pricePreview.response.status, 200, pricePreview.text);
    const results = await Promise.all([
      apply(product.id, decision, pricePreview.data.previewToken),
      apply(product.id, decision, pricePreview.data.previewToken),
    ]);
    assert.deepEqual(results.map((item) => item.response.status).sort(), [200, 409]);
    assert.equal(Number((await pool.query(
      'SELECT total_price_uah FROM products WHERE id = $1', [product.id]
    )).rows[0].total_price_uah), 2600);
    assert.equal((await pool.query(
      `SELECT count(*) FROM audit_events
       WHERE event_key = 'product.price_changed' AND subject_id = $1`,
      [String(product.id)]
    )).rows[0].count, '1');
  } finally {
    await removeProduct(product.id);
  }
});

test('audit failure rolls back every price field and active correction requests block the command', async () => {
  await ensureSession();
  const product = await createPriceChangeProduct();
  let triggerCreated = false;
  try {
    const decision = {
      mode: 'manual_uah', manualPriceUah: 2550, marketingRoundingEnabled: false,
    };
    const pricePreview = await preview(product.id, decision);
    const before = (await pool.query(
      `SELECT total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = $1`, [product.id]
    )).rows[0];
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_test_product_price_change_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_key = 'product.price_changed' THEN
          RAISE EXCEPTION 'forced product price audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_test_product_price_change_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_test_product_price_change_audit();
    `);
    triggerCreated = true;
    const failed = await apply(product.id, decision, pricePreview.data.previewToken);
    assert.equal(failed.response.status, 500, failed.text);
    await pool.query('DROP TRIGGER fail_test_product_price_change_audit ON audit_events');
    await pool.query('DROP FUNCTION fail_test_product_price_change_audit()');
    triggerCreated = false;
    const after = (await pool.query(
      `SELECT total_price, total_price_uah, price_per_gram, uah_rate, details
       FROM products WHERE id = $1`, [product.id]
    )).rows[0];
    assert.deepEqual(after, before);
    assert.equal(Number((await pool.query(
      'SELECT count(*) FROM product_export_revisions WHERE product_id = $1',
      [product.id]
    )).rows[0].count), 0);

    const requestRow = await pool.query(
      `INSERT INTO correction_requests
       (source_product_id, category_code, source_sku, proposed_sku, old_payload,
        proposed_payload, changes, status, preview_signature)
       VALUES ($1, 'LN', $2, $2 || '-999', '{}'::jsonb, '{}'::jsonb,
               '[]'::jsonb, 'pending', 'price-change-blocker')
       RETURNING id`,
      [product.id, product.full_sku]
    );
    const blockedPreview = await preview(product.id, decision);
    assert.equal(blockedPreview.response.status, 409, blockedPreview.text);
    assert.equal(blockedPreview.data.code, 'ACTIVE_CORRECTION_REQUEST');
    await pool.query('DELETE FROM correction_requests WHERE id = $1', [requestRow.rows[0].id]);
  } finally {
    if (triggerCreated) {
      await pool.query('DROP TRIGGER IF EXISTS fail_test_product_price_change_audit ON audit_events');
      await pool.query('DROP FUNCTION IF EXISTS fail_test_product_price_change_audit()');
    }
    await removeProduct(product.id);
  }
});

test('an existing repricing draft becomes stale after an in-place price change', async () => {
  await ensureSession();
  const product = await createPriceChangeProduct();
  let draftId = null;
  try {
    const scenarioId = Number((await pool.query(
      `SELECT id FROM price_scenarios
       WHERE category_code = 'LN' AND match_json @> '{"is_calibrated":1}'::jsonb
       ORDER BY priority DESC, id LIMIT 1`
    )).rows[0].id);
    const repricingPreview = await request('/api/admin/repricing/preview', {
      method: 'POST', body: { scenarioId },
    });
    assert.equal(repricingPreview.response.status, 200, repricingPreview.text);
    assert.ok(repricingPreview.data.items.some(
      (item) => Number(item.productId) === Number(product.id)
    ));
    const manualOverrides = repricingPreview.data.items
      .filter((item) => ['manual_price', 'price_missing'].includes(item.errorCode))
      .map((item) => ({
        productId: Number(item.productId),
        newPriceUah: Number(item.oldPriceUah),
      }));
    const draft = await request('/api/admin/repricing/drafts', {
      method: 'POST',
      body: { scenarioId, manualOverrides, reviewedProductIds: [], uiState: {} },
    });
    assert.equal(draft.response.status, 200, draft.text);
    draftId = Number(draft.data.draft.id);

    const decision = {
      mode: 'manual_uah', manualPriceUah: 2500, marketingRoundingEnabled: false,
    };
    const pricePreview = await preview(product.id, decision);
    const changed = await apply(product.id, decision, pricePreview.data.previewToken);
    assert.equal(changed.response.status, 200, changed.text);

    const staleDraft = await request(`/api/admin/repricing/drafts/${draftId}`);
    assert.equal(staleDraft.response.status, 200, staleDraft.text);
    assert.equal(staleDraft.data.sync.hasChanges, true);
    const staleApply = await request('/api/admin/repricing/apply', {
      method: 'POST',
      body: {
        scenarioId,
        previewToken: repricingPreview.data.previewToken,
        manualOverrides,
        draftId,
      },
    });
    assert.equal(staleApply.response.status, 409, staleApply.text);
    assert.equal(Number((await pool.query(
      'SELECT total_price_uah FROM products WHERE id = $1', [product.id]
    )).rows[0].total_price_uah), 2500);
  } finally {
    if (draftId) {
      await request(`/api/admin/repricing/drafts/${draftId}`, { method: 'DELETE', body: {} });
    }
    await removeProduct(product.id);
  }
});
