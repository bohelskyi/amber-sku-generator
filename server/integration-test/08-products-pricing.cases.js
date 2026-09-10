const suite = require('./suite-context');
const {
  assert,
  test,
  pool,
  saveLastKnownRate,
  request,
  schemas,
} = suite;

test('preview/save are authoritative and concurrent sequences are unique', async () => {
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0 },
  });
  assert.equal(preview.response.status, 200);
  const payload = {
    category: 'ZZ',
    answers: { kind: 1 },
    weight: 0,
    skuSchemaVersionId: schemas.ZZ,
    previewToken: preview.data.previewToken,
    fullSku: 'ATTACKER-SKU',
    totalPriceUah: 1,
    baseSku: 'WRONG',
  };
  const saved = await request('/api/save', { method: 'POST', body: payload });
  assert.equal(saved.response.status, 200, saved.text);
  suite.primarySku = saved.data.fullSku;
  assert.notEqual(suite.primarySku, 'ATTACKER-SKU');
  const stored = await pool.query(
    'SELECT full_sku, base_sku, total_price_uah FROM products WHERE id = $1',
    [saved.data.id]
  );
  assert.equal(Number(stored.rows[0].total_price_uah), 1000);
  assert.equal(stored.rows[0].base_sku, preview.data.baseSku);

  const concurrent = await Promise.all([
    request('/api/save', { method: 'POST', body: payload }),
    request('/api/save', { method: 'POST', body: payload }),
  ]);
  assert.deepEqual(concurrent.map((item) => item.response.status), [200, 200]);
  assert.equal(new Set(concurrent.map((item) => item.data.fullSku)).size, 2);
  const concurrentStored = await pool.query(
    `SELECT full_sku, sequence_number
     FROM products
     WHERE full_sku = ANY($1::text[])
     ORDER BY sequence_number`,
    [concurrent.map((item) => item.data.fullSku)]
  );
  assert.equal(concurrentStored.rows.length, 2);
  assert.equal(new Set(concurrentStored.rows.map((row) => Number(row.sequence_number))).size, 2);
});

test('save rejects a preview after authoritative pricing changes', async () => {
  const preview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 2 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(preview.response.status, 200, preview.text);
  const countBefore = await pool.query(
    `SELECT count(*)::int AS count FROM products
     WHERE category = 'ZZ' AND details->'answers'->>'kind' = '2'`
  );
  try {
    const changedMatrix = await pool.query(
      'UPDATE price_matrix SET price = price + 25 WHERE scenario_id = $1 AND x_val = 2',
      [schemas.ZZScenario]
    );
    assert.equal(changedMatrix.rowCount, 1);
    const changedPreview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 2 }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(changedPreview.response.status, 200, changedPreview.text);
    assert.notEqual(changedPreview.data.previewToken, preview.data.previewToken);
    const staleSave = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind: 2 },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: preview.data.previewToken,
      },
    });
    assert.equal(staleSave.response.status, 409, staleSave.text);
    const countAfter = await pool.query(
      `SELECT count(*)::int AS count FROM products
       WHERE category = 'ZZ' AND details->'answers'->>'kind' = '2'`
    );
    assert.equal(countAfter.rows[0].count, countBefore.rows[0].count);
  } finally {
    await pool.query(
      'UPDATE price_matrix SET price = price - 25 WHERE scenario_id = $1 AND x_val = 2',
      [schemas.ZZScenario]
    );
  }
});

test('automatic marketing rounding is persisted through save, decode, and recount while manual prices stay exact', async () => {
  const originalCells = await pool.query(
    `SELECT x_val, y_val, price
     FROM price_matrix
     WHERE scenario_id = $1 AND x_val = ANY($2::int[])
     ORDER BY x_val`,
    [schemas.ZZScenario, [1, 2]]
  );
  assert.equal(originalCells.rows.length, 2);
  const createdProductIds = [];

  try {
    await pool.query(
      `UPDATE price_matrix
       SET price = CASE x_val WHEN 1 THEN 2556 ELSE 918 END
       WHERE scenario_id = $1 AND x_val = ANY($2::int[])`,
      [schemas.ZZScenario, [1, 2]]
    );
    const stalePreview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(stalePreview.response.status, 200, stalePreview.text);
    assert.equal(stalePreview.data.calculatedPriceUah, 2556);
    assert.equal(stalePreview.data.totalPriceUah, 2550);

    await pool.query(
      'UPDATE price_matrix SET price = 3943 WHERE scenario_id = $1 AND x_val = 1',
      [schemas.ZZScenario]
    );
    const staleSave = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind: 1 },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: stalePreview.data.previewToken,
      },
    });
    assert.equal(staleSave.response.status, 409, staleSave.text);

    const automaticPreview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(automaticPreview.data.calculatedPriceUah, 3943);
    assert.equal(automaticPreview.data.totalPriceUah, 3950);
    const automatic = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind: 1 },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: automaticPreview.data.previewToken,
      },
    });
    assert.equal(automatic.response.status, 200, automatic.text);
    createdProductIds.push(Number(automatic.data.id));

    await pool.query(
      'UPDATE price_matrix SET price = 1536 WHERE scenario_id = $1 AND x_val = 1',
      [schemas.ZZScenario]
    );
    const decodedAutomatic = await request('/api/decode', {
      method: 'POST', body: { sku: automatic.data.fullSku },
    });
    assert.equal(decodedAutomatic.response.status, 200, decodedAutomatic.text);
    assert.equal(decodedAutomatic.data.pricing.calculatedPriceUah, 3943);
    assert.equal(decodedAutomatic.data.pricing.automaticPriceUah, 3950);
    assert.equal(decodedAutomatic.data.pricing.totalPriceUah, 3950);

    const manualPreview = await request('/api/preview', {
      method: 'POST',
      body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
    });
    assert.equal(manualPreview.data.calculatedPriceUah, 1536);
    assert.equal(manualPreview.data.totalPriceUah, 1550);
    const manual = await request('/api/save', {
      method: 'POST',
      body: {
        category: 'ZZ',
        answers: { kind: 1 },
        weight: 0,
        isCalibrated: 0,
        skuSchemaVersionId: schemas.ZZ,
        previewToken: manualPreview.data.previewToken,
        manualPriceUah: 613.25,
      },
    });
    assert.equal(manual.response.status, 200, manual.text);
    createdProductIds.push(Number(manual.data.id));
    const storedManual = await pool.query(
      'SELECT total_price_uah, details FROM products WHERE id = $1',
      [manual.data.id]
    );
    assert.equal(Number(storedManual.rows[0].total_price_uah), 613.25);
    assert.equal(Number(storedManual.rows[0].details.manualPriceUah), 613.25);
    assert.equal(Number(storedManual.rows[0].details.calculatedPriceUah), 1536);
    assert.equal(Number(storedManual.rows[0].details.autoPriceUah), 1550);
    const decodedManual = await request('/api/decode', {
      method: 'POST', body: { sku: manual.data.fullSku },
    });
    assert.equal(decodedManual.response.status, 200, decodedManual.text);
    assert.equal(decodedManual.data.pricing.calculatedPriceUah, 1536);
    assert.equal(decodedManual.data.pricing.automaticPriceUah, 1550);
    assert.equal(decodedManual.data.pricing.totalPriceUah, 613.25);

    const recountPreview = await request('/api/recount/preview', {
      method: 'POST',
      body: {
        sourceSku: automatic.data.fullSku,
        answers: { kind: 2 },
        reason: 'marketing rounding integration',
      },
    });
    assert.equal(recountPreview.response.status, 200, recountPreview.text);
    assert.equal(recountPreview.data.corrected.calculatedPriceUah, 918);
    assert.equal(recountPreview.data.corrected.autoPriceUah, 900);
    assert.equal(recountPreview.data.corrected.totalPriceUah, 900);
    const recounted = await request('/api/recount/apply', {
      method: 'POST',
      body: {
        sourceSku: automatic.data.fullSku,
        answers: { kind: 2 },
        reason: 'marketing rounding integration',
      },
    });
    assert.equal(recounted.response.status, 200, recounted.text);
    createdProductIds.push(Number(recounted.data.correctedProductId));
    const storedRecount = await pool.query(
      'SELECT total_price_uah, details FROM products WHERE id = $1',
      [recounted.data.correctedProductId]
    );
    assert.equal(Number(storedRecount.rows[0].total_price_uah), 900);
    assert.equal(Number(storedRecount.rows[0].details.calculatedPriceUah), 918);
    assert.equal(Number(storedRecount.rows[0].details.autoPriceUah), 900);
    assert.equal(storedRecount.rows[0].details.manualPriceUah, null);
  } finally {
    for (const cell of originalCells.rows) {
      await pool.query(
        `UPDATE price_matrix SET price = $1
         WHERE scenario_id = $2 AND x_val = $3 AND y_val = $4`,
        [cell.price, schemas.ZZScenario, cell.x_val, cell.y_val]
      );
    }
    if (createdProductIds.length > 0) {
      await pool.query(
        `UPDATE products SET status = 'archived', exclude_from_export = 1
         WHERE id = ANY($1::int[])`,
        [createdProductIds]
      );
    }
  }
});

test('required answers, weight, schema ownership, and manual fallback fail closed', async () => {
  const missing = await request('/api/preview', {
    method: 'POST', body: { categoryCode: 'ZZ', answers: {}, weight: 0 },
  });
  assert.equal(missing.response.status, 422);
  const weight = await request('/api/preview', {
    method: 'POST', body: { categoryCode: 'WW', answers: { kind: 1 }, weight: 0 },
  });
  assert.equal(weight.response.status, 422);
  const wrongSchema = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      skuSchemaVersionId: schemas.ZZ, previewToken: 'wrong', manualPriceUah: 200,
    },
  });
  assert.equal(wrongSchema.response.status, 422);

  const noPricePreview = await request('/api/preview', {
    method: 'POST',
    body: {
      categoryCode: 'MM', answers: { kind: 1 }, weight: 0, isCalibrated: 0,
    },
  });
  assert.equal(noPricePreview.response.status, 200, noPricePreview.text);

  const legacyPayload = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      skuSchemaVersionId: schemas.MM, manualPriceUah: 321,
    },
  });
  assert.equal(legacyPayload.response.status, 422);
  assert.match(legacyPayload.data.error, /previewToken/);

  const noAuto = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      isCalibrated: null,
      skuSchemaVersionId: schemas.MM, previewToken: noPricePreview.data.previewToken,
    },
  });
  assert.equal(noAuto.response.status, 422);
  assert.match(noAuto.data.error, /Вкажіть ціну вручну/);
  const zeroManual = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      isCalibrated: null,
      skuSchemaVersionId: schemas.MM, previewToken: noPricePreview.data.previewToken,
      manualPriceUah: 0,
    },
  });
  assert.equal(zeroManual.response.status, 422);
  assert.match(zeroManual.data.error, /більшою за 0/);
  const manual = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 1 }, weight: 0,
      isCalibrated: null,
      skuSchemaVersionId: schemas.MM, previewToken: noPricePreview.data.previewToken,
      manualPriceUah: 321,
    },
  });
  assert.equal(manual.response.status, 200, manual.text);
  const stored = await pool.query('SELECT total_price_uah FROM products WHERE id = $1', [manual.data.id]);
  assert.equal(Number(stored.rows[0].total_price_uah), 321);

  const malformedPreview = await request('/api/preview', {
    method: 'POST', body: { categoryCode: 'MM', answers: { kind: 2 }, weight: 0 },
  });
  const malformedManual = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'MM', answers: { kind: 2 }, weight: 0,
      skuSchemaVersionId: schemas.MM, previewToken: malformedPreview.data.previewToken,
      manualPriceUah: true,
    },
  });
  assert.equal(malformedManual.response.status, 422);
});

test('correction applies a manual price when the target configuration has no matrix cell', async () => {
  const sourcePreview = await request('/api/preview', {
    method: 'POST',
    body: { categoryCode: 'ZZ', answers: { kind: 1 }, weight: 0, isCalibrated: 0 },
  });
  assert.equal(sourcePreview.response.status, 200, sourcePreview.text);
  const source = await request('/api/save', {
    method: 'POST',
    body: {
      category: 'ZZ',
      answers: { kind: 1 },
      weight: 0,
      isCalibrated: 0,
      skuSchemaVersionId: schemas.ZZ,
      previewToken: sourcePreview.data.previewToken,
    },
  });
  assert.equal(source.response.status, 200, source.text);

  const removedCell = await pool.query(
    'DELETE FROM price_matrix WHERE scenario_id = $1 AND x_val = 2 AND y_val = 0 RETURNING price',
    [schemas.ZZScenario]
  );
  assert.equal(removedCell.rowCount, 1);
  try {
    const preview = await request('/api/recount/preview', {
      method: 'POST',
      body: { sourceSku: source.data.fullSku, answers: { kind: 2 }, reason: 'manual correction' },
    });
    assert.equal(preview.response.status, 200, preview.text);
    assert.equal(preview.data.corrected.totalPriceUah, null);

    const zeroManual = await request('/api/recount/apply', {
      method: 'POST',
      body: {
        sourceSku: source.data.fullSku,
        answers: { kind: 2 },
        reason: 'manual correction',
        manualPriceUah: 0,
      },
    });
    assert.equal(zeroManual.response.status, 422, zeroManual.text);
    assert.match(zeroManual.data.error, /більшою за 0/);

    const applied = await request('/api/recount/apply', {
      method: 'POST',
      body: {
        sourceSku: source.data.fullSku,
        answers: { kind: 2 },
        reason: 'manual correction',
        manualPriceUah: 725,
      },
    });
    assert.equal(applied.response.status, 200, applied.text);
    assert.equal(applied.data.corrected.manualPriceUah, 725);
    const stored = await pool.query(
      'SELECT total_price_uah, details FROM products WHERE id = $1',
      [applied.data.correctedProductId]
    );
    assert.equal(Number(stored.rows[0].total_price_uah), 725);
    assert.equal(Number(stored.rows[0].details.manualPriceUah), 725);
    assert.equal(stored.rows[0].details.autoPriceUah, null);
  } finally {
    await pool.query(
      `INSERT INTO price_matrix (scenario_id, x_val, y_val, price)
       VALUES ($1, 2, 0, $2)
       ON CONFLICT (scenario_id, x_val, y_val) DO UPDATE SET price = EXCLUDED.price`,
      [schemas.ZZScenario, removedCell.rows[0].price]
    );
  }
});

test('exchange-rate cache never lets an older replica overwrite a newer fetch', async () => {
  const olderFetchedAt = '2026-08-30T10:00:00.000Z';
  const newerFetchedAt = '2026-08-31T10:00:00.000Z';
  await pool.query("DELETE FROM exchange_rate_cache WHERE currency_pair = 'USD_UAH'");
  await pool.query(`
    CREATE OR REPLACE FUNCTION delay_older_exchange_rate_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.fetched_at = TIMESTAMPTZ '2026-08-30 10:00:00+00' THEN
        PERFORM pg_sleep(0.2);
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER delay_older_exchange_rate_write
    BEFORE INSERT OR UPDATE ON exchange_rate_cache
    FOR EACH ROW EXECUTE FUNCTION delay_older_exchange_rate_write();
  `);
  try {
    const olderWrite = saveLastKnownRate({
      rate: 40,
      rateDate: '2026-08-30',
      fetchedAt: olderFetchedAt,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const newerWrite = saveLastKnownRate({
      rate: 41,
      rateDate: '2026-08-31',
      fetchedAt: newerFetchedAt,
    });
    await Promise.all([olderWrite, newerWrite]);
    const stored = await pool.query(
      "SELECT rate, fetched_at FROM exchange_rate_cache WHERE currency_pair = 'USD_UAH'"
    );
    assert.equal(Number(stored.rows[0].rate), 41);
    assert.equal(new Date(stored.rows[0].fetched_at).toISOString(), newerFetchedAt);
  } finally {
    await pool.query('DROP TRIGGER delay_older_exchange_rate_write ON exchange_rate_cache');
    await pool.query('DROP FUNCTION delay_older_exchange_rate_write()');
  }
});

test('used category code is immutable while metadata remains editable', async () => {
  const changedCode = await request('/api/admin/category', {
    method: 'PUT',
    body: { code: 'ZZ', next_code: 'ZX', name: 'Renamed', requires_weight: 0 },
  });
  assert.equal(changedCode.response.status, 409);
  const metadata = await request('/api/admin/category', {
    method: 'PUT',
    body: { code: 'ZZ', next_code: 'ZZ', name: 'Renamed', requires_weight: 0 },
  });
  assert.equal(metadata.response.status, 200, metadata.text);
});
