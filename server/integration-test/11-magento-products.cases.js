const suite = require('./suite-context');
const {
  assert, crypto, test, pool, request,
} = suite;

async function ensureTextQuestion(category, key, required = 1) {
  const existing = await pool.query(
    'SELECT id FROM questions WHERE category_code = $1 AND key = $2',
    [category, key]
  );
  if (existing.rows.length) return;
  await pool.query(
    `INSERT INTO questions
       (category_code, key, label, sku_index, display_order, required,
        include_in_sku, input_type)
     VALUES ($1, $2, $2, 0, 99, $3, 0, 'text')`,
    [category, key, required]
  );
}

async function insertProduct(category, answers, {
  weight = 10, priceUah = 2000, excluded = 0, details = {}, skuOverride = null,
} = {}) {
  const sku = skuOverride
    || `${category}V1-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const schema = await pool.query(
    `SELECT id FROM sku_schema_versions
     WHERE category_code = $1 AND status = 'active'
     ORDER BY id DESC LIMIT 1`, [category]
  );
  const result = await pool.query(
    `INSERT INTO products
       (full_sku, base_sku, sequence_number, category, weight, total_price,
        total_price_uah, price_per_gram, uah_rate, details,
        sku_schema_version_id, exclude_from_export)
     VALUES ($1, $1, 0, $2, $3, $4, $5, 5, 40, $6::jsonb, $7, $8)
     RETURNING id, full_sku`,
    [sku, category, weight, priceUah / 40, priceUah,
      JSON.stringify({ ...details, answers }), schema.rows[0]?.id || null, excluded]
  );
  return result.rows[0];
}

async function informationPreview(productId, answersPatch) {
  return request('/api/product-information/preview', {
    method: 'POST', body: { productId, answersPatch },
  });
}

async function informationApply(productId, answersPatch, previewToken) {
  return request('/api/product-information/apply', {
    method: 'POST', body: { productId, answersPatch, previewToken, reason: 'Magento completion' },
  });
}

async function createMagentoSnapshot(sku, key = crypto.randomUUID()) {
  return request('/api/export/snapshots', {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: { fromSku: sku, toSku: sku },
  });
}

async function artifactCsv(snapshotId, group) {
  return request(`/api/export/snapshots/${snapshotId}/magento/${group}/csv`);
}

test('Magento BR uses stored semantic answers, shares the cursor, and preserves old artifacts on metadata re-export', async () => {
  await ensureTextQuestion('BR', 'braclet_size');
  const product = await insertProduct('BR', {
    raw_type: 1, processing: 2, quality: 1, texture: 2, color: 1,
    size: 1, shape: 3, style: 1, is_calibrated: 0,
  });
  const registryBefore = await pool.query(
    'SELECT count(*)::int AS count FROM sku_registry WHERE full_sku = $1', [product.full_sku]
  );
  const cursorBefore = Number((await pool.query(
    'SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE'
  )).rows[0].exported_to_product_id);
  const preview = await request('/api/export/preview', {
    method: 'POST', body: { fromSku: product.full_sku, toSku: product.full_sku },
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(preview.data.representedCount, 1);
  assert.equal(preview.data.readyCount, 0);
  assert.ok(preview.data.errors[0].fields.some(
    (field) => field.field === 'dovzhyna_brasletu_diuimiv'
  ));
  const fail = await createMagentoSnapshot(product.full_sku);
  assert.equal(fail.response.status, 422, fail.text);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM magento_export_artifacts WHERE snapshot_id = $1',
    [fail.data.id || 'absent']
  )).rows[0].count, 0);
  const completion = await informationPreview(product.id, { braclet_size: '16' });
  assert.equal(completion.response.status, 200, completion.text);
  assert.equal(completion.data.exportGuidance.mode, 'next_normal_export');
  const applied = await informationApply(product.id, { braclet_size: '16' },
    completion.data.previewToken);
  assert.equal(applied.response.status, 200, applied.text);
  assert.equal(Number(applied.data.productId), Number(product.id));
  assert.equal(applied.data.sku, product.full_sku);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM product_corrections WHERE source_product_id = $1',
    [product.id]
  )).rows[0].count, 0);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM sku_registry WHERE full_sku = $1', [product.full_sku]
  )).rows[0].count, registryBefore.rows[0].count);
  assert.equal((await pool.query(
    'SELECT total_price_uah FROM products WHERE id = $1', [product.id]
  )).rows[0].total_price_uah, '2000.00');

  const first = await createMagentoSnapshot(product.full_sku);
  assert.equal(first.response.status, 201, first.text);
  assert.deepEqual(first.data.artifacts.map((item) => item.groupCode), ['BR']);
  const oldCsv = await artifactCsv(first.data.id, 'BR');
  assert.equal(oldCsv.response.status, 200, oldCsv.text);
  assert.equal(oldCsv.text.split('\n').length, 3);
  assert.ok(oldCsv.text.includes('16,"Default/Браслети'));
  assert.ok(oldCsv.text.includes('Natural amber bracelet. Art:'));
  assert.ok(!oldCsv.text.includes(',ua,'));
  assert.equal(Number((await pool.query(
    'SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE'
  )).rows[0].exported_to_product_id), cursorBefore);
  assert.equal((await pool.query(
    'SELECT has_product_snapshot FROM product_export_revisions WHERE product_id = $1',
    [product.id]
  )).rows[0].has_product_snapshot, true);

  const stalePreview = await informationPreview(product.id, { braclet_size: '17' });
  const pricingDecision = {
    mode: 'manual_uah', manualPriceUah: 2300, marketingRoundingEnabled: false,
  };
  const pricePreview = await request('/api/product-price-change/preview', {
    method: 'POST', body: { productId: product.id, pricingDecision },
  });
  assert.equal(pricePreview.response.status, 200, pricePreview.text);
  const priceApply = await request('/api/product-price-change/apply', {
    method: 'POST',
    body: { productId: product.id, pricingDecision,
      previewToken: pricePreview.data.previewToken },
  });
  assert.equal(priceApply.response.status, 200, priceApply.text);
  const staleApply = await informationApply(product.id, { braclet_size: '17' },
    stalePreview.data.previewToken);
  assert.equal(staleApply.response.status, 409);
  const secondPreview = await informationPreview(product.id, { braclet_size: '17' });
  assert.equal(secondPreview.data.exportGuidance.mode, 'reexport');
  const secondApply = await informationApply(product.id, { braclet_size: '17' },
    secondPreview.data.previewToken);
  assert.equal(secondApply.response.status, 200, secondApply.text);
  const second = await createMagentoSnapshot(product.full_sku);
  assert.equal(second.response.status, 201, second.text);
  const newCsv = await artifactCsv(second.data.id, 'BR');
  assert.ok(newCsv.text.includes('17,"Default/Браслети'));
  assert.ok(newCsv.text.includes(',2300,'));
  assert.equal((await artifactCsv(first.data.id, 'BR')).text, oldCsv.text);
  await request(`/api/export/snapshots/${second.data.id}/confirm`, { method: 'POST', body: {} });
  const revisions = (await pool.query(
    `SELECT revision, confirmed_revision FROM product_export_revisions WHERE product_id = $1`,
    [product.id]
  )).rows[0];
  assert.equal(Number(revisions.revision), 1);
  assert.equal(Number(revisions.confirmed_revision), 0);
  assert.ok(Number((await pool.query(
    'SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE'
  )).rows[0].exported_to_product_id) >= cursorBefore);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM audit_events WHERE event_key = $1 AND subject_id = $2',
    ['product_information.updated', String(product.id)]
  )).rows[0].count, 2);
});

test('informational update rejects unrelated and pricing-dependent fields, and preserves calibration 3', async () => {
  await ensureTextQuestion('BR', 'braclet_size');
  const br = await insertProduct('BR', {
    raw_type: 1, processing: 1, quality: 1, texture: 1, color: 1,
    size: 1, shape: 1, style: 1, is_calibrated: 0,
  });
  const unrelated = await informationPreview(br.id, { attach: '1' });
  assert.equal(unrelated.response.status, 422);
  await pool.query(
    `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
     VALUES ('AR', 'Картини', 0, 0) ON CONFLICT (code) DO NOTHING`
  );
  await ensureTextQuestion('AR', 'attach', 0);
  const painting = await insertProduct('AR', { type: 1 });
  const unrelatedPainting = await informationPreview(painting.id, { attach: '1' });
  assert.equal(unrelatedPainting.response.status, 422);

  await ensureTextQuestion('CH', 'bead_length');
  await ensureTextQuestion('CH', 'bead_width');
  await ensureTextQuestion('CH', 'rosary_length');
  const ch = await insertProduct('CH', {
    raw_type: 1, quality: 1, texture: 1, color: 1, size: 1,
    shape: 1, religion: 1, count: 1, is_calibrated: 3,
    bead_width: '8', bead_length: '9', rosary_length: '30',
  }, { details: { isCalibrated: 3 } });
  const chPreview = await informationPreview(ch.id, { bead_width: '10' });
  assert.equal(chPreview.response.status, 200, chPreview.text);
  const chApply = await informationApply(ch.id, { bead_width: '10' },
    chPreview.data.previewToken);
  assert.equal(chApply.response.status, 200, chApply.text);
  const stored = (await pool.query('SELECT details FROM products WHERE id = $1', [ch.id])).rows[0];
  assert.equal(stored.details.answers.is_calibrated, 3);
  assert.equal(stored.details.isCalibrated, 3);
  const mapped = await request('/api/export/preview', {
    method: 'POST', body: { fromSku: ch.full_sku, toSku: ch.full_sku },
  });
  assert.equal(mapped.response.status, 200, mapped.text);
  assert.equal(mapped.data.readyCount, 1, JSON.stringify(mapped.data.errors));
});

test('informational no-op is rejected and excluded products receive no re-export guidance', async () => {
  await ensureTextQuestion('BR', 'braclet_size');
  const excluded = await insertProduct('BR', {
    raw_type: 1, processing: 1, quality: 1, texture: 1, color: 1,
    size: 1, shape: 1, style: 1, is_calibrated: 0, braclet_size: '14',
  }, { excluded: 1 });
  const noOp = await informationPreview(excluded.id, { braclet_size: '14' });
  assert.equal(noOp.response.status, 422);
  assert.equal(noOp.data.code, 'NO_CHANGE');
  const preview = await informationPreview(excluded.id, { braclet_size: '15' });
  assert.equal(preview.response.status, 200, preview.text);
  assert.deepEqual(preview.data.exportGuidance, { mode: 'excluded', eligible: false });
  const applied = await informationApply(excluded.id, { braclet_size: '15' },
    preview.data.previewToken);
  assert.equal(applied.response.status, 200, applied.text);
  assert.deepEqual(applied.data.exportGuidance, { mode: 'excluded', eligible: false });
  const row = (await pool.query(
    `SELECT id, full_sku, exclude_from_export, details->'answers'->>'braclet_size' AS size
     FROM products WHERE id = $1`, [excluded.id]
  )).rows[0];
  assert.equal(row.id, excluded.id);
  assert.equal(row.full_sku, excluded.full_sku);
  assert.equal(Number(row.exclude_from_export), 1);
  assert.equal(row.size, '15');
  const legacy = await insertProduct('BR', {});
  await pool.query('UPDATE products SET details = NULL WHERE id = $1', [legacy.id]);
  const legacyPreview = await informationPreview(legacy.id, { braclet_size: '17' });
  assert.equal(legacyPreview.response.status, 200, legacyPreview.text);
  const legacyApply = await informationApply(legacy.id, { braclet_size: '17' },
    legacyPreview.data.previewToken);
  assert.equal(legacyApply.response.status, 200, legacyApply.text);
  assert.equal((await pool.query(
    `SELECT details->'answers'->>'braclet_size' AS size FROM products WHERE id = $1`,
    [legacy.id]
  )).rows[0].size, '17');
});

test('SV.size can be completed in place while pricing-dependent SV.weight cannot', async () => {
  await pool.query(
    `INSERT INTO categories (code, name, requires_weight, skip_hidden_sku_questions)
     VALUES ('SV', 'Сувеніри', 0, 0)`
  );
  const definitions = [
    ['material', 1, null, [[1, 'Натуральний']]],
    ['color', 1, null, [[1, 'Світлий']]],
    ['souvenir', 1, null, [[5, 'Сувенірний камінь'], [6, 'Брелок']]],
    ['statuette', 1, { souvenir: 1 }, [[1, 'Тварина']]],
    ['2', 1, { statuette: 1 }, [[1, 'Ссавець']]],
    ['bird', 0, { 2: 2 }, [[1, 'Орел']]],
    ['plants', 1, { statuette: 2 }, [[1, 'Дерево']]],
    ['symbolic_stat', 0, { statuette: 5 }, [[1, 'Українська']]],
    ['table_games', 0, { souvenir: 2 }, [[1, 'Шахи']]],
    ['stone_processing', 1, { souvenir: 5 }, [[1, 'Полірований']]],
    ['additional_stone', 0, { souvenir: 5 }, [[1, 'Є інклюзи']]],
  ];
  for (const [key, required, visible, options] of definitions) {
    const question = await pool.query(
      `INSERT INTO questions
         (category_code, key, label, sku_index, display_order, required,
          include_in_sku, input_type, visible_if_json)
       VALUES ('SV', $1, $1, 1, 1, $2, 1, 'options', $3::jsonb)
       RETURNING id`,
      [key, required, visible ? JSON.stringify(visible) : null]
    );
    for (const [valueId, label] of options) {
      await pool.query(
        `INSERT INTO options (question_id, value_id, sku_code, label)
         VALUES ($1, $2, $3, $4)`,
        [question.rows[0].id, valueId, `X${valueId}`, label]
      );
    }
  }
  await ensureTextQuestion('SV', 'weight', 0);
  await ensureTextQuestion('SV', 'size', 0);
  await pool.query(
    `INSERT INTO price_scenarios
       (category_code, name, match_json, axis_x_key, status)
     VALUES ('SV', 'Weight-dependent souvenir', '{"souvenir":6}'::jsonb, 'weight', 'active')`
  );
  const product = await insertProduct('SV', {
    material: 1, color: 1, souvenir: 6, weight: '25',
  });
  const deniedWeight = await informationPreview(product.id, { weight: '26' });
  assert.equal(deniedWeight.response.status, 422, deniedWeight.text);
  const sizePreview = await informationPreview(product.id, { size: '4 см' });
  assert.equal(sizePreview.response.status, 200, sizePreview.text);
  assert.equal(sizePreview.data.exportGuidance.mode, 'next_normal_export');
  const sizeApply = await informationApply(product.id, { size: '4 см' },
    sizePreview.data.previewToken);
  assert.equal(sizeApply.response.status, 200, sizeApply.text);
  const ready = await request('/api/export/preview', {
    method: 'POST', body: { fromSku: product.full_sku, toSku: product.full_sku },
  });
  assert.equal(ready.response.status, 200, ready.text);
  assert.equal(ready.data.readyCount, 1, JSON.stringify(ready.data.errors));
  const snapshot = await createMagentoSnapshot(product.full_sku);
  assert.equal(snapshot.response.status, 201, snapshot.text);
  const csv = await artifactCsv(snapshot.data.id, 'SV');
  assert.ok(csv.text.includes('Брелок з бурштину'));
  assert.ok(csv.text.includes('Amber key chain'));
  assert.ok(csv.text.includes('4 см'));
  const stone = await insertProduct('SV', {
    material: 1, color: 1, souvenir: 5, stone_processing: 1,
    additional_stone: 1, weight: '25', size: '5 см',
  });
  const { loadMagentoCatalog, mapProduct } = require('../src/services/magento-products-v1');
  const catalog = await loadMagentoCatalog(pool);
  const row = (await pool.query('SELECT * FROM products WHERE id = $1', [stone.id])).rows[0];
  const mapped = mapProduct(row, catalog);
  assert.equal(mapped.base.attribute_set_code, 'Камінь');
  assert.equal(mapped.base.fraction, '20-50');
  assert.ok(mapped.base.categories.startsWith('Default/Камінь,'));
  assert.deepEqual(mapped.errors.map((error) => error.field), ['name']);
});

test('manual souvenir names save in place, refresh readiness, and preserve old artifacts', async () => {
  const product = await insertProduct('SV', {
    material: 1, color: 1, souvenir: 5, stone_processing: 1,
    additional_stone: 1, weight: '25', size: '5 см',
  });
  const namePayload = { productId: product.id,
    subjectUa: 'Камінь декоративний', subjectEn: 'decorative stone' };
  const before = (await pool.query('SELECT * FROM products WHERE id = $1', [product.id])).rows[0];
  const status = await request('/api/export/status');
  assert.equal(status.response.status, 200, status.text);
  assert.equal(status.data.translationSuggestionAvailable, false);
  const noProvider = await request('/api/product-magento-name/suggest', {
    method: 'POST', body: { productId: product.id, subjectUa: 'Камінь' },
  });
  assert.equal(noProvider.response.status, 503, noProvider.text);
  assert.equal(noProvider.data.code, 'TRANSLATION_NOT_CONFIGURED');
  const unready = await request('/api/export/preview', { method: 'POST',
    body: { fromSku: product.full_sku, toSku: product.full_sku } });
  assert.equal(unready.data.readyCount, 0);
  assert.ok(unready.data.errors[0].fields.some((item) => item.code === 'manual_name_required'));
  const preview = await request('/api/product-magento-name/preview', {
    method: 'POST', body: namePayload,
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(preview.data.nameEn, `Amber decorative stone. Art: ${product.full_sku}`);
  const applied = await request('/api/product-magento-name/apply', { method: 'POST',
    body: { ...namePayload, previewToken: preview.data.previewToken } });
  assert.equal(applied.response.status, 200, applied.text);
  const after = (await pool.query('SELECT * FROM products WHERE id = $1', [product.id])).rows[0];
  for (const field of ['id', 'full_sku', 'details', 'weight', 'total_price_uah',
    'exclude_from_export', 'sku_schema_version_id']) {
    assert.deepEqual(after[field], before[field], field);
  }
  assert.equal(after.magento_name_subject_ua, namePayload.subjectUa);
  assert.equal(after.magento_name_subject_en, namePayload.subjectEn);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_corrections WHERE source_product_id = $1',
    [product.id])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_export_revisions WHERE product_id = $1',
    [product.id])).rows[0].n, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM audit_events
    WHERE event_key = 'product_magento_name.updated' AND subject_id = $1`,
  [String(product.id)])).rows[0].n, 1);
  const ready = await request('/api/export/preview', { method: 'POST',
    body: { fromSku: product.full_sku, toSku: product.full_sku } });
  assert.equal(ready.data.readyCount, 1, JSON.stringify(ready.data.errors));
  const oldSnapshot = await createMagentoSnapshot(product.full_sku);
  assert.equal(oldSnapshot.response.status, 201, oldSnapshot.text);
  const oldCsv = (await artifactCsv(oldSnapshot.data.id, 'SV')).text;
  assert.ok(oldCsv.includes('Камінь декоративний з бурштину'));
  const nextPayload = { ...namePayload, subjectUa: 'Новий камінь', subjectEn: 'new stone' };
  const stale = await request('/api/product-magento-name/preview', {
    method: 'POST', body: { ...namePayload, subjectUa: 'Стара назва' },
  });
  const nextPreview = await request('/api/product-magento-name/preview', {
    method: 'POST', body: nextPayload,
  });
  const nextApply = await request('/api/product-magento-name/apply', { method: 'POST',
    body: { ...nextPayload, previewToken: nextPreview.data.previewToken } });
  assert.equal(nextApply.response.status, 200, nextApply.text);
  const staleApply = await request('/api/product-magento-name/apply', { method: 'POST',
    body: { ...namePayload, subjectUa: 'Стара назва', previewToken: stale.data.previewToken } });
  assert.equal(staleApply.response.status, 409, staleApply.text);
  assert.equal(staleApply.data.code, 'STALE_MAGENTO_NAME');
  const newSnapshot = await createMagentoSnapshot(product.full_sku);
  assert.equal(newSnapshot.response.status, 201, newSnapshot.text);
  assert.ok((await artifactCsv(newSnapshot.data.id, 'SV')).text.includes('Новий камінь з бурштину'));
  assert.equal((await artifactCsv(oldSnapshot.data.id, 'SV')).text, oldCsv);
});

test('manual souvenir name update and snapshot capture serialize on the product row', async () => {
  const product = await insertProduct('SV', {
    material: 1, color: 1, souvenir: 5, stone_processing: 1,
    additional_stone: 1, weight: '25', size: '5 см',
  });
  const initial = { productId: product.id,
    subjectUa: 'Перший камінь', subjectEn: 'first stone' };
  const initialPreview = await request('/api/product-magento-name/preview', {
    method: 'POST', body: initial,
  });
  assert.equal(initialPreview.response.status, 200, initialPreview.text);
  assert.equal((await request('/api/product-magento-name/apply', { method: 'POST',
    body: { ...initial, previewToken: initialPreview.data.previewToken },
  })).response.status, 200);
  const next = { productId: product.id,
    subjectUa: 'Другий камінь', subjectEn: 'second stone' };
  const preview = await request('/api/product-magento-name/preview', {
    method: 'POST', body: next,
  });
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [product.id]);
  try {
    const applyPromise = request('/api/product-magento-name/apply', { method: 'POST',
      body: { ...next, previewToken: preview.data.previewToken },
    });
    const snapshotPromise = createMagentoSnapshot(product.full_sku);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await blocker.query('COMMIT');
    const [applied, snapshot] = await Promise.all([applyPromise, snapshotPromise]);
    assert.equal(applied.response.status, 200, applied.text);
    assert.equal(snapshot.response.status, 201, snapshot.text);
    const csv = (await artifactCsv(snapshot.data.id, 'SV')).text;
    const oldPair = csv.includes('Перший камінь з бурштину')
      && csv.includes('Amber first stone. Art:');
    const newPair = csv.includes('Другий камінь з бурштину')
      && csv.includes('Amber second stone. Art:');
    assert.equal(oldPair || newPair, true);
    assert.equal(oldPair && newPair, false);
    const final = (await pool.query(
      'SELECT magento_name_subject_ua, magento_name_subject_en FROM products WHERE id = $1',
      [product.id]
    )).rows[0];
    assert.deepEqual(final, { magento_name_subject_ua: 'Другий камінь',
      magento_name_subject_en: 'second stone' });
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }
});

test('active correction request blocks a previously previewed informational update', async () => {
  await ensureTextQuestion('BR', 'braclet_size');
  const product = await insertProduct('BR', {
    raw_type: 1, processing: 1, quality: 1, texture: 1, color: 1,
    size: 1, shape: 1, style: 1, is_calibrated: 0, braclet_size: '14',
  });
  const preview = await informationPreview(product.id, { braclet_size: '15' });
  assert.equal(preview.response.status, 200, preview.text);
  await pool.query(
    `INSERT INTO correction_requests
       (source_product_id, category_code, source_sku, proposed_sku,
        old_payload, proposed_payload, preview_signature)
     VALUES ($1, 'BR', $2, $2, '{}'::jsonb, '{}'::jsonb, 'pending-test')`,
    [product.id, product.full_sku]
  );
  const blocked = await informationApply(product.id, { braclet_size: '15' },
    preview.data.previewToken);
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.data.code, 'ACTIVE_CORRECTION_REQUEST');
  assert.equal((await pool.query(
    `SELECT details->'answers'->>'braclet_size' AS size
     FROM products WHERE id = $1`, [product.id]
  )).rows[0].size, '14');
});

test('snapshot capture and informational apply serialize on the product row', async () => {
  await ensureTextQuestion('CH', 'bead_length');
  await ensureTextQuestion('CH', 'bead_width');
  await ensureTextQuestion('CH', 'rosary_length');
  const product = await insertProduct('CH', {
    raw_type: 1, quality: 1, texture: 1, color: 1, size: 1,
    shape: 1, religion: 1, count: 1, is_calibrated: 0,
    bead_width: '8', bead_length: '9', rosary_length: '30',
  });
  const patch = { bead_width: '11', bead_length: '12' };
  const preview = await informationPreview(product.id, patch);
  assert.equal(preview.response.status, 200, preview.text);
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [product.id]);
  try {
    const appliedPromise = informationApply(product.id, patch, preview.data.previewToken);
    const snapshotPromise = createMagentoSnapshot(product.full_sku);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await blocker.query('COMMIT');
    const [applied, snapshot] = await Promise.all([appliedPromise, snapshotPromise]);
    assert.equal(applied.response.status, 200, applied.text);
    assert.equal(snapshot.response.status, 201, snapshot.text);
    const csv = (await artifactCsv(snapshot.data.id, 'CH')).text;
    const oldPair = csv.includes(',9,8,30,');
    const newPair = csv.includes(',12,11,30,');
    assert.equal(oldPair || newPair, true, csv);
    assert.equal(oldPair && newPair, false);
    const final = (await pool.query(
      `SELECT details->'answers' AS answers FROM products WHERE id = $1`, [product.id]
    )).rows[0].answers;
    assert.equal(final.bead_length, '12');
    assert.equal(final.bead_width, '11');
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }
});

test('Magento artifact records are immutable and historical legacy snapshots remain readable', async () => {
  let historical = (await pool.query(
    `SELECT id FROM export_snapshots
     WHERE NOT EXISTS (
       SELECT 1 FROM magento_export_artifacts a WHERE a.snapshot_id = export_snapshots.id
     ) ORDER BY generated_at DESC LIMIT 1`
  )).rows[0];
  if (!historical) {
    const sku = (await pool.query(
      "SELECT full_sku FROM products WHERE category = 'BR' ORDER BY id DESC LIMIT 1"
    )).rows[0].full_sku;
    const created = await request('/api/export/snapshots', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { fromSku: sku, toSku: sku, profile: 'internal-legacy' },
    });
    assert.equal(created.response.status, 201, created.text);
    historical = { id: created.data.id };
  }
  assert.ok(historical);
  const manifest = await request(`/api/export/snapshots/${historical.id}`);
  assert.equal(manifest.response.status, 200, manifest.text);
  assert.deepEqual(manifest.data.artifacts, []);
  const artifact = (await pool.query(
    'SELECT snapshot_id, group_code FROM magento_export_artifacts ORDER BY created_at DESC LIMIT 1'
  )).rows[0];
  assert.ok(artifact);
  await assert.rejects(
    pool.query(
      `UPDATE magento_export_artifacts SET file_name = 'changed'
       WHERE snapshot_id = $1 AND group_code = $2`,
      [artifact.snapshot_id, artifact.group_code]
    ),
    /immutable/
  );
  await assert.rejects(
    pool.query(
      'DELETE FROM magento_export_artifacts WHERE snapshot_id = $1 AND group_code = $2',
      [artifact.snapshot_id, artifact.group_code]
    ),
    /immutable/
  );
});

test('new-product Magento workflow uses the confirmed ID cursor without SKU input', async () => {
  await ensureTextQuestion('BR', 'braclet_size');
  const lastEligible = (await pool.query(
    `SELECT full_sku FROM products
     WHERE COALESCE(exclude_from_export, 0) = 0 ORDER BY id DESC LIMIT 1`
  )).rows[0];
  const advance = await request('/api/export/snapshots', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { fromSku: lastEligible.full_sku, toSku: lastEligible.full_sku,
      profile: 'internal-legacy' },
  });
  assert.equal(advance.response.status, 201, advance.text);
  const advanced = await request(`/api/export/snapshots/${advance.data.id}/confirm`, {
    method: 'POST', body: {},
  });
  assert.equal(advanced.response.status, 200, advanced.text);

  const commonAnswers = {
    raw_type: 1, processing: 1, quality: 1, texture: 1, color: 1,
    size: 1, shape: 1, style: 1, is_calibrated: 0,
  };
  const unique = crypto.randomUUID().replaceAll('-', '').slice(0, 9).toUpperCase();
  const first = await insertProduct('BR', { ...commonAnswers, braclet_size: '16' }, {
    skuOverride: `ZZNEW${unique}`,
  });
  const second = await insertProduct('BR', { ...commonAnswers, braclet_size: '17' }, {
    skuOverride: `AANEW${unique}`,
  });
  assert.ok(Number(first.id) < Number(second.id));
  assert.ok(first.full_sku > second.full_sku);
  const status = await request('/api/export/status');
  assert.equal(status.response.status, 200, status.text);
  assert.equal(status.data.countSinceLastExport, 2);
  const cursorBefore = Number((await pool.query(
    'SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE'
  )).rows[0].exported_to_product_id);

  const preview = await request('/api/export/preview', {
    method: 'POST', body: { mode: 'new' },
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(preview.data.mode, 'new');
  assert.equal(preview.data.representedCount, 2);
  assert.equal(preview.data.readyCount, 2);
  assert.deepEqual(preview.data.errors, []);
  assert.equal(preview.data.range.fromSku, first.full_sku);
  assert.equal(preview.data.range.toSku, second.full_sku);
  assert.deepEqual(preview.data.artifacts.map((item) => item.groupCode), ['BR']);
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM product_export_revisions WHERE product_id = ANY($1::int[])',
    [[first.id, second.id]]
  )).rows[0].count, 0);
  assert.equal(Number((await pool.query(
    'SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE'
  )).rows[0].exported_to_product_id), cursorBefore);

  const key = crypto.randomUUID();
  const createBody = { mode: 'new', fromSku: preview.data.range.fromSku,
    toSku: preview.data.range.toSku };
  const created = await request('/api/export/snapshots', {
    method: 'POST', headers: { 'Idempotency-Key': key }, body: createBody,
  });
  assert.equal(created.response.status, 201, created.text);
  const downloaded = await artifactCsv(created.data.id, 'BR');
  assert.equal(downloaded.response.status, 200, downloaded.text);
  assert.ok(downloaded.text.indexOf(first.full_sku) < downloaded.text.indexOf(second.full_sku));
  assert.equal(Number((await pool.query(
    'SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE'
  )).rows[0].exported_to_product_id), cursorBefore);
  const confirmed = await request(`/api/export/snapshots/${created.data.id}/confirm`, {
    method: 'POST', body: {},
  });
  assert.equal(confirmed.response.status, 200, confirmed.text);
  assert.equal(Number((await pool.query(
    'SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE'
  )).rows[0].exported_to_product_id), Number(second.id));
  const repeated = await request('/api/export/snapshots', {
    method: 'POST', headers: { 'Idempotency-Key': key }, body: createBody,
  });
  assert.equal(repeated.response.status, 201, repeated.text);
  assert.equal(repeated.data.id, created.data.id);
  const stale = await request('/api/export/snapshots', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: createBody,
  });
  assert.equal(stale.response.status, 409, stale.text);
  assert.equal(stale.data.code, 'NEW_EXPORT_RANGE_STALE');

  const empty = await request('/api/export/preview', {
    method: 'POST', body: { mode: 'new' },
  });
  assert.equal(empty.response.status, 200, empty.text);
  assert.equal(empty.data.representedCount, 0);
  assert.equal(empty.data.range, null);
  const manual = await createMagentoSnapshot(first.full_sku);
  assert.equal(manual.response.status, 201, manual.text);
  assert.equal(manual.data.artifacts[0].groupCode, 'BR');
  assert.equal(Number((await pool.query(
    'SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE'
  )).rows[0].exported_to_product_id), Number(second.id));

  const notReady = await insertProduct('BR', commonAnswers);
  const blockedPreview = await request('/api/export/preview', {
    method: 'POST', body: { mode: 'new' },
  });
  assert.equal(blockedPreview.response.status, 200, blockedPreview.text);
  assert.equal(blockedPreview.data.representedCount, 1);
  assert.equal(blockedPreview.data.readyCount, 0);
  assert.ok(blockedPreview.data.errors[0].fields.some(
    (field) => field.field === 'dovzhyna_brasletu_diuimiv'
  ));
  const snapshotCountBefore = Number((await pool.query(
    'SELECT count(*)::int AS count FROM export_snapshots'
  )).rows[0].count);
  const blocked = await request('/api/export/snapshots', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { mode: 'new', fromSku: notReady.full_sku, toSku: notReady.full_sku },
  });
  assert.equal(blocked.response.status, 422, blocked.text);
  assert.equal(Number((await pool.query(
    'SELECT count(*)::int AS count FROM export_snapshots'
  )).rows[0].count), snapshotCountBefore);
  assert.equal(Number((await pool.query(
    'SELECT exported_to_product_id FROM export_state WHERE singleton = TRUE'
  )).rows[0].exported_to_product_id), Number(second.id));
  assert.equal((await pool.query(
    'SELECT count(*)::int AS count FROM product_export_revisions WHERE product_id = $1',
    [notReady.id]
  )).rows[0].count, 0);
});
