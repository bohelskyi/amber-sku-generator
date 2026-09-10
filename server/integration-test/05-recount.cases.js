const suite = require('./suite-context');
const {
  assert,
  test,
  pool,
  request,
} = suite;

test('recount preview authoritatively reprices a changed weight in UAH and USD', async () => {
  const preview = await request('/api/recount/preview', {
    method: 'POST',
    body: {
      sourceSku: 'LN136021',
      answers: {},
      weight: 22.2,
      reason: '',
    },
  });

  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(preview.data.source.totalPrice, 123.6);
  assert.equal(preview.data.source.totalPriceUah, 4944);
  assert.equal(preview.data.corrected.weight, 22.2);
  assert.equal(Number(preview.data.corrected.totalPrice), 133.2);
  assert.equal(preview.data.corrected.totalPriceUah, 5300);
  assert.equal(preview.data.priceDeltaUsd, 9.6);
  assert.equal(preview.data.priceDeltaUah, 356);
  assert.deepEqual(
    preview.data.changes.find((change) => change.key === 'weight'),
    { key: 'weight', from: 20.6, to: 22.2 }
  );

  const invalid = await request('/api/recount/preview', {
    method: 'POST',
    body: { sourceSku: 'LN136021', answers: {}, weight: 0 },
  });
  assert.equal(invalid.response.status, 422, invalid.text);
  assert.match(invalid.data.error, /вага/i);
});

test('complete Size target previews identically for blank and null manual prices', async () => {
  const target = {
    sourceSku: 'LN136021',
    answers: {
      raw_type: 1,
      size: 1,
      shape: 6,
      is_calibrated: 1,
    },
    isCalibrated: 1,
    weight: 20.6,
    reason: '',
  };
  const livePreview = await request('/api/recount/preview', {
    method: 'POST',
    body: { ...target, manualPriceUah: null },
  });
  const continuePreview = await request('/api/recount/preview', {
    method: 'POST',
    body: { ...target, manualPriceUah: '' },
  });

  assert.equal(livePreview.response.status, 200, livePreview.text);
  assert.equal(continuePreview.response.status, 200, continuePreview.text);
  assert.deepEqual(livePreview.data.corrected, continuePreview.data.corrected);
  assert.deepEqual(livePreview.data.changes, continuePreview.data.changes);
  assert.equal(livePreview.data.priceDeltaUah, continuePreview.data.priceDeltaUah);
  assert.equal(livePreview.data.priceDeltaUsd, continuePreview.data.priceDeltaUsd);
});

test('recount removes a valid inherited size when the target configuration hides it', async () => {
  const correctionPayload = {
    sourceSku: 'LN136021',
    answers: { is_calibrated: 2 },
    isCalibrated: 2,
    reason: 'calibrated to semi-calibrated',
  };
  const preview = await request('/api/recount/preview', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(preview.data.corrected.fullSku, 'LN106021');
  assert.equal(Object.hasOwn(preview.data.corrected.answers, 'size'), false);

  const applied = await request('/api/recount/apply', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(applied.response.status, 200, applied.text);
  const correctedState = await pool.query(
    `SELECT source.status AS source_status, corrected.full_sku,
            corrected.details->'answers' AS answers
     FROM products source
     JOIN products corrected ON corrected.id = source.corrected_to_product_id
     WHERE source.full_sku = 'LN136021'`
  );
  assert.equal(correctedState.rows[0].source_status, 'corrected');
  assert.equal(correctedState.rows[0].full_sku, 'LN106021');
  assert.equal(Object.hasOwn(correctedState.rows[0].answers, 'size'), false);
});

test('recount still validates size when the target configuration makes it visible', async () => {
  const missingSize = await request('/api/recount/preview', {
    method: 'POST',
    body: {
      sourceSku: 'LN106020',
      answers: { is_calibrated: 1 },
      isCalibrated: 1,
      reason: 'semi-calibrated to calibrated',
    },
  });
  assert.equal(missingSize.response.status, 422, missingSize.text);
  assert.match(missingSize.data.error, /Розмір/);

  const invalidSize = await request('/api/recount/preview', {
    method: 'POST',
    body: {
      sourceSku: 'LN106020',
      answers: { is_calibrated: 1, size: 999 },
      isCalibrated: 1,
      reason: 'semi-calibrated to calibrated',
    },
  });
  assert.equal(invalidSize.response.status, 422, invalidSize.text);
  assert.match(invalidSize.data.error, /Розмір/);
});

test('legacy hidden size placeholder remains recountable without weakening new-product validation', async () => {
  const decoded = await request('/api/decode', {
    method: 'POST',
    body: { sku: 'LN106020' },
  });
  assert.equal(decoded.response.status, 200, decoded.text);
  assert.equal(decoded.data.existsInDb, true);
  const decodedSize = decoded.data.decodedAnswers.find((answer) => answer.key === 'size');
  assert.deepEqual(
    { valueId: decodedSize.value_id, isPlaceholder: decodedSize.is_placeholder },
    { valueId: null, isPlaceholder: true }
  );

  const correctionPayload = {
    sourceSku: 'LN106020',
    answers: { shape: 7 },
    isCalibrated: 2,
    reason: 'legacy hidden size compatibility',
  };
  const preview = await request('/api/recount/preview', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(preview.data.corrected.fullSku, 'LN107020');
  assert.equal(Object.hasOwn(preview.data.corrected.answers, 'size'), false);

  const applied = await request('/api/recount/apply', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(applied.response.status, 200, applied.text);
  const correctedState = await pool.query(
    `SELECT source.status AS source_status, corrected.full_sku,
            corrected.total_price_uah, corrected.details->'answers' AS answers
     FROM products source
     JOIN products corrected ON corrected.id = source.corrected_to_product_id
     WHERE source.full_sku = 'LN106020'`
  );
  assert.equal(correctedState.rows[0].source_status, 'corrected');
  assert.equal(correctedState.rows[0].full_sku, 'LN107020');
  assert.ok(Number(correctedState.rows[0].total_price_uah) > 0);
  assert.equal(Object.hasOwn(correctedState.rows[0].answers, 'size'), false);

  const hiddenZeroOnNewProduct = await request('/api/preview', {
    method: 'POST',
    body: {
      categoryCode: 'LN',
      answers: { raw_type: 1, size: 0, shape: 6, is_calibrated: 2 },
      weight: 20.3,
      isCalibrated: 2,
    },
  });
  assert.equal(hiddenZeroOnNewProduct.response.status, 422, hiddenZeroOnNewProduct.text);
  assert.match(hiddenZeroOnNewProduct.data.error, /Розмір/);

  const visibleMissingOnNewProduct = await request('/api/preview', {
    method: 'POST',
    body: {
      categoryCode: 'LN',
      answers: { raw_type: 1, shape: 6, is_calibrated: 1 },
      weight: 20.3,
      isCalibrated: 1,
    },
  });
  assert.equal(visibleMissingOnNewProduct.response.status, 422, visibleMissingOnNewProduct.text);
  assert.match(visibleMissingOnNewProduct.data.error, /Розмір/);

  const visibleInvalid = await request('/api/preview', {
    method: 'POST',
    body: {
      categoryCode: 'LN',
      answers: { raw_type: 1, size: 0, shape: 6, is_calibrated: 1 },
      weight: 20.3,
      isCalibrated: 1,
    },
  });
  assert.equal(visibleInvalid.response.status, 422, visibleInvalid.text);
  assert.match(visibleInvalid.data.error, /Розмір/);
});

test('recount explicitly clears optional answers without weakening real zero or required values', async () => {
  const correctionPayload = {
    sourceSku: 'OC1001',
    answers: { discount: null, packaging: 2, zero_option: 0, is_calibrated: 0 },
    isCalibrated: 0,
    reason: 'clear optional discount',
  };
  const preview = await request('/api/recount/preview', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(Object.hasOwn(preview.data.corrected.answers, 'discount'), false);
  assert.equal(preview.data.corrected.answers.packaging, 2);
  assert.equal(preview.data.corrected.answers.zero_option, 0);
  assert.equal(preview.data.corrected.answers.is_calibrated, 0);

  const applied = await request('/api/recount/apply', {
    method: 'POST',
    body: correctionPayload,
  });
  assert.equal(applied.response.status, 200, applied.text);
  const corrected = await pool.query(
    `SELECT corrected.details->'answers' AS answers
     FROM products source
     JOIN products corrected ON corrected.id = source.corrected_to_product_id
     WHERE source.full_sku = 'OC1001'`
  );
  assert.equal(Object.hasOwn(corrected.rows[0].answers, 'discount'), false);
  assert.equal(corrected.rows[0].answers.zero_option, 0);
  assert.equal(corrected.rows[0].answers.is_calibrated, 0);

  const anotherOptional = await request('/api/recount/preview', {
    method: 'POST',
    body: {
      sourceSku: 'OC1002',
      answers: { packaging: null },
      isCalibrated: 0,
      reason: 'clear another optional answer',
    },
  });
  assert.equal(anotherOptional.response.status, 200, anotherOptional.text);
  assert.equal(Object.hasOwn(anotherOptional.data.corrected.answers, 'packaging'), false);

  const requiredCleared = await request('/api/recount/preview', {
    method: 'POST',
    body: {
      sourceSku: 'OC1002',
      answers: { required_choice: null, discount: 2 },
      isCalibrated: 0,
      reason: 'required must remain strict',
    },
  });
  assert.equal(requiredCleared.response.status, 422, requiredCleared.text);
  assert.match(requiredCleared.data.error, /Обов’язковий вибір/);
});
