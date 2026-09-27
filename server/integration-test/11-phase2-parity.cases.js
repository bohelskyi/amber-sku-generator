const { test, assert, pool, Pool, TEST_DATABASE_URL, crypto, authenticateApplicationSession } = require('./suite-context');
const products = require('../src/services/product.service');
const requests = require('../src/services/correction-request.service');
const names = require('../src/services/product-magento-name.service');
const information = require('../src/services/product-information.service');
const exportsService = require('../src/services/export.service');
const prices = require('../src/services/product-price-change.service');
const { installSouvenirFixture } = require('./11-export-recount-exclusion.cases');
let actor;
const opts = (databasePool = pool) => ({ databasePool, canOverride: true, mutationContext: {
  actorUserId: actor.applicationUser.id, requestId: 'phase-2-parity' } });
const answers = { material: 2, color: 3, souvenir: 1, statuette: 5, weight: 1260, size: '23/6/30' };
const product = async (id) => (await pool.query('SELECT * FROM products WHERE id=$1', [id])).rows[0];
const state = async (id) => (await pool.query('SELECT * FROM product_full_export_state WHERE product_id=$1', [id])).rows[0];
const requestRow = async (id) => (await pool.query('SELECT * FROM correction_requests WHERE id=$1', [id])).rows[0];
const audits = async (key, id) => (await pool.query('SELECT * FROM audit_events WHERE event_key=$1 AND subject_id=$2 ORDER BY id', [key, String(id)])).rows;
const range = (p) => ({ fromSku: p.full_sku, toSku: p.full_sku });
const capture = (p, db = pool) => exportsService.createExportSnapshot({ ...range(p), idempotencyKey: crypto.randomUUID() }, opts(db));
const confirm = (s, db = pool) => exportsService.confirmExportSnapshot(s.id, opts(db));
async function setup() { actor = await authenticateApplicationSession(); await installSouvenirFixture(); }
async function save(review = false) {
  const preview = await products.buildProductPreview({ categoryCode: 'SV', answers, weight: 1260 });
  const saved = await products.saveProduct({ category: 'SV', answers, weight: 1260, manualPriceUah: 21700,
    skuSchemaVersionId: preview.skuSchemaVersionId, previewToken: preview.previewToken }, opts());
  // Explicit fixture baseline; tested public name commands start from full revision 1.
  await pool.query(`UPDATE products SET magento_name_subject_ua='Фігура', magento_name_subject_en='Figurine',
    magento_name_review_required=$2 WHERE id=$1`, [saved.id, review]);
  return product(saved.id);
}
const recountPayload = (p, patch = { size: '24/6/30' }) => ({ sourceSku: p.full_sku, answers: patch, manualPriceUah: 21700 });
async function direct(p, patch) {
  const input = recountPayload(p, patch); const preview = await products.buildProductRecountPreview(input);
  return products.applyProductRecount({ ...input, sourceStateSignature: preview.source.stateSignature }, opts());
}
async function createRequest(p, patch) {
  const { manualPriceUah, ...input } = recountPayload(p, patch);
  input.pricingDecision = { mode: 'manual_uah', manualPriceUah };
  const preview = await requests.previewCorrectionRequest(input, opts());
  return (await requests.createCorrectionRequest({ ...input, previewSignature: preview.previewSignature }, opts())).request;
}
async function claimed(p, patch) {
  const r = await createRequest(p, patch);
  return (await requests.claimCorrectionRequest(r.id, opts())).request;
}
const refresh = (r, db = pool) => requests.refreshCorrectionRequest(r.id, r.claimVersion, null, opts(db));
const complete = (r, db = pool) => requests.completeCorrectionRequest(r.id, r.claimVersion, null, opts(db));
async function nameInput(p, review = false) {
  const input = { productId: p.id, subjectUa: review ? p.magento_name_subject_ua : 'Нова фігура',
    subjectEn: review ? p.magento_name_subject_en : 'New figurine', ...(review ? { confirmUnchanged: true } : {}) };
  return { ...input, previewToken: (await names.previewProductMagentoName(input)).previewToken };
}
async function infoInput(p, size = '25/6/30') {
  const input = { productId: p.id, answersPatch: { size } };
  return { ...input, previewToken: (await information.previewProductInformation(input)).previewToken };
}
const counters = (s) => [s.revision, s.confirmed_revision, s.delivery_version];
const refreshError = (e) => e.statusCode === 409 && e.details?.refreshRequired === true;
async function footprint() {
  const result = {};
  for (const table of ['products','sku_registry','product_corrections','correction_requests','product_full_export_state',
    'product_export_revisions','audit_events']) {
    result[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(t ORDER BY to_jsonb(t)::text),'[]') rows FROM ${table} t`)).rows[0].rows;
  }
  return result;
}

test('phase2 new requests bind lifecycle, complete lineage, inherited names and refresh without product mutation', async () => {
  await setup(); const p = await save(); const before = await state(p.id);
  const r = await claimed(p, { symbolic_stat: 1 });
  const stored = await requestRow(r.id); const evidence = stored.proposed_payload.recountEvidence;
  assert.equal(evidence.version, 2); assert.deepEqual(evidence.names, { ua: 'Фігура', en: 'Figurine', reviewRequired: true });
  assert.equal(evidence.lifecycle[0].deliveryVersion, '1'); assert.equal(evidence.exposure.classification, 'reliably_unexposed');
  assert.equal(r.delivery.route, 'normal'); assert.equal(r.delivery.nameReviewRequired, true); assert.equal(r.refreshRequired, false);
  const unchanged = await refresh(r); assert.deepEqual(unchanged.request.proposedPayload.recountEvidence, evidence);
  assert.deepEqual(await state(p.id), before); assert.deepEqual(await product(p.id), p);
  assert.equal((await pool.query('SELECT * FROM product_corrections WHERE source_product_id=$1', [p.id])).rows.length, 0);
  await names.applyProductMagentoName(await nameInput(p), opts());
  const s = await capture(p);
  await assert.rejects(complete(r), refreshError);
  const refreshed = (await refresh(r)).request;
  assert.equal(refreshed.delivery.holdReason, 'prior_exposure');
  assert.equal(refreshed.proposedPayload.nameInheritance.en, 'New figurine');
  assert.notEqual((await requestRow(r.id)).preview_signature, stored.preview_signature);
  const done = await complete(refreshed);
  assert.equal((await state(done.recount.correctedProductId)).hold_reason, 'prior_exposure');
  assert.equal((await product(done.recount.correctedProductId)).magento_name_review_required, true);
  assert.equal((await state(p.id)).revision, '2');
  await confirm(s); assert.equal((await state(done.recount.correctedProductId)).confirmed_revision, '0');
});

test('phase2 old pending evidence requires refresh while completed history and legacy token adoption retain semantics', async () => {
  await setup(); const p = await save(); const r = await claimed(p);
  const token = 'phase2-legacy-token-with-at-least-thirty-two-characters';
  await pool.query(`UPDATE correction_requests SET proposed_payload=proposed_payload-'recountEvidence',
    claimed_by_user_id=NULL, claim_token_hash=$2 WHERE id=$1`, [r.id, requests.getClaimTokenHash(token)]);
  await assert.rejects(requests.completeCorrectionRequest(r.id, r.claimVersion, token, opts()), refreshError);
  assert.equal((await requestRow(r.id)).claimed_by_user_id, null);
  assert.equal((await requests.getCorrectionRequests({ status: 'all' })).items.find((item) => item.id === r.id).refreshRequired, true);
  const updated = (await requests.refreshCorrectionRequest(r.id, r.claimVersion, token, opts())).request;
  assert.equal(updated.claimVersion, r.claimVersion); assert.equal(updated.claimedByUser.id, actor.applicationUser.id);
  assert.equal((await requestRow(r.id)).claim_token_hash, null);
  await complete(updated);
  await pool.query("UPDATE correction_requests SET proposed_payload=proposed_payload-'recountEvidence' WHERE id=$1", [r.id]);
  const completed = await requestRow(r.id);
  assert.equal((await complete(updated)).alreadyCompleted, true);
  assert.deepEqual(await requestRow(r.id), completed);
  await assert.rejects(requests.completeCorrectionRequest(r.id, r.claimVersion + 2, token, opts()), (e) => e.details?.type === 'correction_claim_conflict');
  const legacyId = (await pool.query(`INSERT INTO correction_requests(source_product_id, corrected_product_id, category_code,
    source_sku, proposed_sku, old_payload, proposed_payload, final_payload, status, preview_signature)
    SELECT source_product_id,corrected_product_id,category_code,source_sku,proposed_sku,old_payload,proposed_payload,
    final_payload,'completed','historical' FROM correction_requests WHERE id=$1 RETURNING id`, [r.id])).rows[0].id;
  const historical = await requestRow(legacyId);
  assert.equal((await requests.completeCorrectionRequest(legacyId, undefined, undefined, opts())).alreadyCompleted, true);
  assert.deepEqual(await requestRow(legacyId), historical);
});

for (const cause of ['delivery_version', 'names', 'exposure', 'review', 'lineage']) {
  test(`phase2 stale ${cause} evidence rejects completion and direct preview before any writes`, async () => {
    await setup(); const p = await save(cause === 'review'); const r = await claimed(p);
    if (cause === 'delivery_version') await pool.query('UPDATE product_full_export_state SET delivery_version=delivery_version+1 WHERE product_id=$1', [p.id]);
    if (cause === 'names') await names.applyProductMagentoName(await nameInput(p), opts());
    if (cause === 'exposure') await capture(p);
    if (cause === 'review') await names.applyProductMagentoName(await nameInput(p, true), opts());
    if (cause === 'lineage') {
      const other = await save();
      await pool.query('UPDATE products SET corrected_from_product_id=$2 WHERE id=$1', [p.id, other.id]);
    }
    const before = await footprint();
    await assert.rejects(complete(r), refreshError);
    assert.deepEqual(await footprint(), before);
    const updated = (await refresh(r)).request;
    assert.notEqual(updated.oldPayload.stateSignature, r.oldPayload.stateSignature);
    assert.equal(updated.claimVersion, r.claimVersion);
    await complete(updated);
  });
}

for (const route of ['normal', 'generated', 'confirmed', 'historical', 'excluded']) {
  test(`phase2 direct/request parity for ${route} source and inherited name review`, async () => {
    await setup(); const source = [await save(), await save()];
    for (const p of source) {
      if (route === 'generated' || route === 'confirmed') { const s = await capture(p); if (route === 'confirmed') await confirm(s); }
      if (route === 'historical') await pool.query(`UPDATE product_full_export_state SET route='hold',hold_reason='historical_ambiguity',
        evidence='{"origin":"migration_039"}',delivery_version=delivery_version+1 WHERE product_id=$1`, [p.id]);
      if (route === 'excluded') await pool.query('UPDATE products SET exclude_from_export=1 WHERE id=$1', [p.id]);
    }
    const patch = { symbolic_stat: 1 };
    const a = await direct(source[0], patch); const r = await claimed(source[1], patch); const b = (await complete(r)).recount;
    const [pa, pb] = await Promise.all([product(a.correctedProductId), product(b.correctedProductId)]);
    const [sa, sb] = await Promise.all([state(pa.id), state(pb.id)]);
    assert.deepEqual(a.corrected.delivery, b.corrected.delivery);
    for (const key of ['revision','confirmed_revision','delivery_version','route','hold_reason']) assert.equal(sa[key], sb[key]);
    for (const key of ['magento_name_subject_ua','magento_name_subject_en','magento_name_review_required','total_price_uah','weight','exclude_from_export']) assert.equal(pa[key], pb[key]);
    assert.deepEqual(pa.details.answers, pb.details.answers);
    assert.equal((await state(source[0].id)).route, 'retired'); assert.equal((await state(source[1].id)).route, 'retired');
    assert.equal((await audits('correction_request.completed', r.id)).length, 1);
    for (const p of source) assert.equal((await audits('product.recounted', p.id)).length, 1);
  });
}

for (const kind of ['information', 'name']) for (const previouslyConfirmed of [false, true]) {
  test(`phase2 ${kind} revisions ${previouslyConfirmed ? 'after' : 'before'} first confirmation survive old and out-of-order snapshots`, async () => {
    await setup(); const p = await save(); const old = await capture(p);
    if (previouslyConfirmed) await confirm(old);
    const priceBefore = (await pool.query('SELECT revision,confirmed_revision,has_product_snapshot FROM product_export_revisions WHERE product_id=$1', [p.id])).rows;
    if (kind === 'information') await information.applyProductInformation(await infoInput(p), opts());
    else await names.applyProductMagentoName(await nameInput(p), opts());
    assert.deepEqual(counters(await state(p.id)), ['2', previouslyConfirmed ? '1' : '0', '1']);
    const newFile = await capture(p);
    await confirm(old); await confirm(old);
    assert.deepEqual(counters(await state(p.id)), ['2','1','1']);
    assert.equal((await pool.query('SELECT * FROM product_full_export_state WHERE product_id=$1 AND revision>confirmed_revision', [p.id])).rows.length, 1);
    await confirm(newFile); await confirm(old); await confirm(newFile);
    assert.deepEqual(counters(await state(p.id)), ['2','2','1']);
    assert.deepEqual((await pool.query('SELECT revision,confirmed_revision,has_product_snapshot FROM product_export_revisions WHERE product_id=$1', [p.id])).rows, priceBefore);
    const current = await product(p.id);
    for (const key of ['id','full_sku','sku_schema_version_id','total_price_uah','corrected_from_product_id','corrected_to_product_id']) assert.equal(current[key], p[key]);
    assert.equal((await audits('export_snapshot.confirmed', old.id)).length, 1);
    assert.equal((await pool.query('SELECT * FROM export_snapshot_products WHERE snapshot_id=$1', [old.id])).rows.length, 1);
    assert.equal((await pool.query('SELECT full_revision FROM export_snapshot_products WHERE snapshot_id=$1', [newFile.id])).rows[0].full_revision, '2');
    assert.equal((await pool.query('SELECT row_count FROM magento_export_artifacts WHERE snapshot_id=$1', [newFile.id])).rows[0].row_count, 2);
    await assert.rejects(kind === 'information' ? infoInput(p) : nameInput(p), (e) => e.publicCode === 'NO_CHANGE');
    assert.deepEqual(counters(await state(p.id)), ['2','2','1']);
    if (!previouslyConfirmed) {
      const other = await save(); const first = await capture(other);
      if (kind === 'information') await information.applyProductInformation(await infoInput(other), opts());
      else await names.applyProductMagentoName(await nameInput(other), opts());
      const second = await capture(other);
      await confirm(second); await confirm(first); await confirm(second);
      assert.deepEqual(counters(await state(other.id)), ['2','2','1']);
      assert.equal((await audits('export_snapshot.confirmed', first.id)).length, 1);
      assert.equal((await audits('export_snapshot.confirmed', second.id)).length, 1);
    }
  });
}

test('phase2 inherited pair confirmation is explicit, versioned, audited, stale-safe and payload-revision neutral', async () => {
  await setup(); const source = await save(); const successor = await direct(source, { symbolic_stat: 1 });
  const p = await product(successor.correctedProductId); assert.equal(p.magento_name_review_required, true);
  const input = await nameInput(p, true);
  const metadata = await names.previewProductMagentoName({ productId: p.id }); assert.equal(metadata.canConfirmUnchanged, true);
  assert.equal(metadata.previewToken, input.previewToken);
  const staleName = await nameInput(p); const staleInformation = await infoInput(p);
  const staleDirect = await products.buildProductRecountPreview(recountPayload(p, { size: 'new size' }));
  await assert.rejects(names.previewProductMagentoName({ ...input, confirmUnchanged: false }), (e) => e.publicCode === 'NO_CHANGE');
  const result = await names.applyProductMagentoName(input, opts());
  assert.equal(result.action, 'confirm_inherited'); assert.equal(result.reviewRequired, false);
  assert.deepEqual(counters(await state(p.id)), ['1','0','2']);
  const after = await product(p.id); assert.deepEqual({ ...after, magento_name_review_required: true }, p);
  assert.equal((await audits('product_magento_name.reviewed', p.id)).length, 1);
  assert.equal((await audits('product_magento_name.updated', p.id)).length, 0);
  await assert.rejects(names.applyProductMagentoName(input, opts()), (e) => e.publicCode === 'STALE_MAGENTO_NAME');
  await assert.rejects(names.applyProductMagentoName(staleName, opts()), (e) => e.publicCode === 'STALE_MAGENTO_NAME');
  await assert.rejects(information.applyProductInformation(staleInformation, opts()), (e) => e.publicCode === 'STALE_PRODUCT_INFORMATION');
  await assert.rejects(products.applyProductRecount({ ...recountPayload(p, { size: 'new size' }), sourceStateSignature: staleDirect.source.stateSignature }, opts()), (e) => e.statusCode === 409);
  const editable = await save(true); await names.applyProductMagentoName(await nameInput(editable), opts());
  assert.deepEqual(counters(await state(editable.id)), ['2','0','2']);
  assert.equal((await product(editable.id)).magento_name_review_required, false);
});

test('phase2 no-op, invalid information and price-only mutations preserve full-product revision boundaries', async () => {
  await setup(); const p = await save(); const before = await footprint();
  await assert.rejects(information.previewProductInformation({ productId: p.id, answersPatch: { size: answers.size } }), (e) => e.publicCode === 'NO_CHANGE');
  await assert.rejects(information.previewProductInformation({ productId: p.id, answersPatch: { weight: '1261' } }), /дозволеного переліку/);
  await assert.rejects(names.previewProductMagentoName({ productId: p.id, subjectUa: 'Фігура', subjectEn: 'Figurine' }), (e) => e.publicCode === 'NO_CHANGE');
  await assert.rejects(names.previewProductMagentoName({ productId: p.id, subjectUa: 'Фігура', subjectEn: 'Figurine', confirmUnchanged: true }), (e) => e.publicCode === 'STALE_MAGENTO_NAME');
  assert.deepEqual(await footprint(), before);
  const input = { productId: p.id, pricingDecision: { mode: 'manual_uah', manualPriceUah: 22000, marketingRoundingEnabled: false } };
  const preview = await prices.previewProductPriceChange(input);
  await prices.applyProductPriceChange({ ...input, previewToken: preview.previewToken }, opts());
  assert.deepEqual(counters(await state(p.id)), ['1','0','1']);
  assert.equal((await pool.query('SELECT revision FROM product_export_revisions WHERE product_id=$1', [p.id])).rows[0].revision, '1');
  const requestInput = { requestType: 'price_change', productId: p.id,
    pricingDecision: { ...input.pricingDecision, manualPriceUah: 23000 } };
  const requestPreview = await requests.previewCorrectionRequest(requestInput, opts());
  const pending = (await requests.createCorrectionRequest({ ...requestInput, previewToken: requestPreview.previewToken }, opts())).request;
  const priceRequest = (await requests.claimCorrectionRequest(pending.id, opts())).request;
  await complete(priceRequest);
  assert.deepEqual(counters(await state(p.id)), ['1','0','1']);
  assert.equal((await pool.query('SELECT revision FROM product_export_revisions WHERE product_id=$1', [p.id])).rows[0].revision, '2');
});

for (const kind of ['information', 'name', 'review', 'completion']) for (const failure of ['audit', 'lifecycle']) {
  test(`phase2 ${kind} ${failure} failure rolls back mutation, lifecycle, request and audit`, async () => {
    await setup(); const p = await save(kind === 'review');
    const r = kind === 'completion' ? await claimed(p) : null;
    const input = kind === 'information' ? await infoInput(p) : kind === 'completion' ? null : await nameInput(p, kind === 'review');
    const before = await footprint(); const table = failure === 'audit' ? 'audit_events' : 'product_full_export_state';
    await pool.query(`CREATE FUNCTION phase2_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'phase2 injected failure'; END $$;
      CREATE TRIGGER phase2_fail BEFORE ${failure === 'audit' ? 'INSERT' : 'UPDATE'} ON ${table} FOR EACH ROW EXECUTE FUNCTION phase2_fail()`);
    try {
      await assert.rejects(kind === 'completion' ? complete(r) : kind === 'information'
        ? information.applyProductInformation(input, opts()) : names.applyProductMagentoName(input, opts()), /phase2 injected failure/);
    } finally { await pool.query(`DROP TRIGGER phase2_fail ON ${table}; DROP FUNCTION phase2_fail()`); }
    assert.deepEqual(await footprint(), before);
  });
}

test('phase2 inherited whitespace is preserved by explicit review and formatting-only name writes remain no-ops', async () => {
  await setup(); const p = await save(true);
  await pool.query("UPDATE products SET magento_name_subject_ua=' Фігура ', magento_name_subject_en=' Figurine ' WHERE id=$1", [p.id]);
  const original = await product(p.id);
  await assert.rejects(names.previewProductMagentoName({ productId: p.id, subjectUa: 'Фігура', subjectEn: 'Figurine' }), (e) => e.publicCode === 'NO_CHANGE');
  const read = await names.previewProductMagentoName({ productId: p.id });
  await names.applyProductMagentoName({ productId: p.id, subjectUa: read.subjectUa, subjectEn: read.subjectEn,
    previewToken: read.previewToken, confirmUnchanged: true }, opts());
  assert.deepEqual({ ...await product(p.id), magento_name_review_required: true }, original);
  assert.deepEqual(counters(await state(p.id)), ['1','0','2']);
  assert.equal((await audits('product_magento_name.updated', p.id)).length, 0);
  assert.equal((await audits('product_magento_name.reviewed', p.id)).length, 1);
});

test('phase2 reviewed-name readiness invalidates full export previews without changing selection or exclusion', async () => {
  await setup(); const p = await save(true);
  const before = await exportsService.previewExport(range(p), opts());
  assert.equal(before.readyCount, 0); assert.equal(before.errors[0].fields[0].code, 'manual_name_review_required');
  await assert.rejects(capture(p), (e) => e.publicCode === 'MAGENTO_NOT_READY');
  const exclusion = p.exclude_from_export;
  await names.applyProductMagentoName(await nameInput(p, true), opts());
  const after = await exportsService.previewExport(range(p), opts());
  assert.equal(after.readyCount, 1); assert.notEqual(after.tableFingerprint, before.tableFingerprint);
  assert.equal((await product(p.id)).exclude_from_export, exclusion);
  const s = await capture(p); assert.equal((await pool.query('SELECT delivery_version FROM export_snapshot_products WHERE snapshot_id=$1', [s.id])).rows[0].delivery_version, '2');
});

module.exports = { setup, save, product, state, requestRow, audits, opts, claimed, refresh, complete, capture, confirm, nameInput, infoInput, counters };
