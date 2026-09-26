const { test, assert, pool, crypto, request, authenticateApplicationSession } = require('./suite-context');
const { ensureLegacySkuSchemas } = require('../src/services/sku-schema.service');
const { loadMagentoCatalog, mapProduct } = require('../src/services/magento-products-v1');

async function installSouvenirFixture() {
  // Disposable catalog only. Run before the template modules add archived SV schemas.
  await pool.query(`INSERT INTO categories(code,name,requires_weight,skip_hidden_sku_questions)
    VALUES('SV','Сувеніри',0,0) ON CONFLICT(code) DO NOTHING`);
  const definitions = [
    ['material', null, 2], ['color', null, 3], ['souvenir', null, 1],
    ['statuette', { souvenir: 1 }, 5], ['2', { statuette: 1 }, 1],
    ['bird', { 2: 2 }, 1], ['plants', { statuette: 2 }, 1],
    ['symbolic_stat', { statuette: 5 }, 1], ['table_games', { souvenir: 2 }, 1],
    ['stone_processing', { souvenir: 5 }, 1], ['additional_stone', { souvenir: 5 }, 1],
  ];
  for (const [index, [key, visible, value]] of definitions.entries()) {
    let q = (await pool.query('SELECT id FROM questions WHERE category_code=$1 AND key=$2', ['SV', key])).rows[0];
    if (!q) q = (await pool.query(`INSERT INTO questions
      (category_code,key,label,sku_index,display_order,required,include_in_sku,input_type,visible_if_json)
      VALUES('SV',$1,$1,$2::int,$2::int,$3,1,'options',$4::jsonb) RETURNING id`,
    [key, index + 1, index < 4 ? 1 : 0, visible ? JSON.stringify(visible) : null])).rows[0];
    await pool.query(`INSERT INTO options(question_id,value_id,sku_code,label)
      SELECT $1,$2,$3,$3 WHERE NOT EXISTS(SELECT 1 FROM options WHERE question_id=$1 AND value_id=$2)`,
    [q.id, value, String(value)]);
  }
  for (const key of ['weight', 'size']) await pool.query(`INSERT INTO questions
    (category_code,key,label,sku_index,display_order,required,include_in_sku,input_type)
    SELECT 'SV',$1,$1,0,99,0,0,'text'
    WHERE NOT EXISTS(SELECT 1 FROM questions WHERE category_code='SV' AND key=$1)`, [key]);
  await ensureLegacySkuSchemas();
}

module.exports = { installSouvenirFixture };

test('recount export exclusion reproduction: comma weight successor misses refreshed and future new exports', async () => {
  // Characterization of the release blocker, not approval of the exclusion policy.
  // Corresponds to local correction 1436: 1260,0 -> 1260, preserved physical weight/price.
  const actor = await authenticateApplicationSession();
  await installSouvenirFixture();
  const call = async (path, body, status = 200) => {
    const result = await request(path, { authentication: actor,
      ...(body === undefined ? {} : { method: 'POST', body }) });
    assert.equal(result.response.status, status, result.text);
    return result.data;
  };
  const answers = { material: 2, color: 3, souvenir: 1, statuette: 5, weight: 1260, size: '23/6/30' };
  const createProduct = async () => {
    const preview = await call('/api/preview', { categoryCode: 'SV', answers, weight: 1260 });
    const saved = await call('/api/save', { category: 'SV', answers, weight: 1260,
      skuSchemaVersionId: preview.skuSchemaVersionId, previewToken: preview.previewToken, manualPriceUah: 21700 });
    // A stored UA/EN pair mirrors the operator's source. This is fixture data only.
    await pool.query(`UPDATE products SET magento_name_subject_ua=$1,magento_name_subject_en=$2 WHERE id=$3`,
      ['Символіка', 'symbolic figurine', saved.id]);
    return (await pool.query('SELECT * FROM products WHERE id=$1', [saved.id])).rows[0];
  };
  const capture = (preview) => call('/api/export/snapshots', {
    mode: 'new', fromSku: preview.range.fromSku, toSku: preview.range.toSku,
    previewExpectation: preview.previewExpectation, idempotencyKey: crypto.randomUUID(),
  }, 201);
  const cursor = async () => Number((await pool.query('SELECT exported_to_product_id FROM export_state WHERE singleton=TRUE')).rows[0].exported_to_product_id);
  const ids = (preview) => [...new Set(preview.review.files.flatMap((file) => file.rows.map((row) => row.productId)))];
  const checkpoint = await createProduct();
  const checkpointSnapshot = await call('/api/export/snapshots', { fromSku: checkpoint.full_sku,
    toSku: checkpoint.full_sku, idempotencyKey: crypto.randomUUID() }, 201);
  await call(`/api/export/snapshots/${checkpointSnapshot.id}/confirm`, {});
  const first = await createProduct();
  const source = await createProduct();
  const last = await createProduct();
  await pool.query(`UPDATE products SET details=jsonb_set(details,'{answers,weight}',$1::jsonb) WHERE id=$2`,
    [JSON.stringify('1260,0'), source.id]);

  const before = await call('/api/export/preview', { mode: 'new' });
  assert.deepEqual(ids(before), [first.id, source.id, last.id]);
  assert.equal(before.range.exportedToProductId, last.id);
  assert.equal(before.representedCount, 3);
  assert.equal(before.readyCount, 2);
  assert.equal(before.previewExpectation, null);
  assert.deepEqual(before.errors.map((error) => error.sku), [source.full_sku]);
  assert.deepEqual(before.errors[0].fields.map((field) => field.field), ['decor_weight']);
  assert.equal(source.status, 'active');
  assert.equal(source.exclude_from_export, 0);
  const correction = { sourceSku: source.full_sku, answers: { weight: 1260 }, manualPriceUah: 21700 };
  const target = await call('/api/recount/preview', correction);
  assert.equal(target.source.answers.weight, '1260,0');
  assert.equal(target.corrected.answers.weight, 1260);
  const applied = await call('/api/recount/apply', { ...correction, sourceStateSignature: target.source.stateSignature });
  const successorId = applied.correctedProductId;
  assert.ok(successorId > last.id);
  assert.notEqual(applied.corrected.fullSku, source.full_sku);
  const pair = (await pool.query('SELECT * FROM products WHERE id=ANY($1::int[]) ORDER BY id', [[source.id, successorId]])).rows;
  assert.equal(pair[0].status, 'corrected');
  assert.equal(pair[0].corrected_to_product_id, successorId);
  assert.equal(pair[0].exclude_from_export, 1);
  assert.equal(pair[1].status, 'active');
  assert.equal(pair[1].corrected_from_product_id, source.id);
  assert.equal(pair[1].corrected_to_product_id, null);
  assert.equal(pair[1].exclude_from_export, 1);
  assert.equal(pair[1].details.answers.weight, 1260);
  assert.equal(pair[1].weight, pair[0].weight);
  assert.equal(pair[1].total_price_uah, pair[0].total_price_uah);
  // Phase 1 preserves the subjects; every release-blocker exclusion/cursor
  // assertion below remains unchanged until Phase 4 changes selection.
  assert.equal(pair[1].magento_name_subject_ua, pair[0].magento_name_subject_ua);
  assert.equal(pair[1].magento_name_subject_en, pair[0].magento_name_subject_en);
  assert.equal(pair[1].magento_name_review_required, false);
  const history = (await pool.query('SELECT * FROM product_corrections WHERE source_product_id=$1', [source.id])).rows;
  assert.equal(history.length, 1);
  assert.equal(history[0].corrected_product_id, successorId);
  assert.equal(history[0].old_payload.answers.weight, '1260,0');
  assert.equal(history[0].new_payload.answers.weight, 1260);
  const mappedSuccessor = mapProduct(pair[1], await loadMagentoCatalog(pool));
  assert.equal(mappedSuccessor.base.decor_weight, '1260');
  assert.equal(mappedSuccessor.errors.some((error) => error.code === 'manual_name_required'), false);
  assert.equal(mappedSuccessor.errors.some((error) => error.field === 'decor_weight'), false);

  // UX-5 repeats the original {mode:'new'} intent; the server resolves membership again.
  const after = await call('/api/export/preview', { mode: 'new' });
  assert.deepEqual(after.range, before.range);
  assert.notEqual(after.tableFingerprint, before.tableFingerprint);
  assert.deepEqual(ids(after), [first.id, last.id]);
  assert.equal(after.representedCount, 2);
  assert.equal(after.readyCount, 2);
  assert.equal((await call('/api/export/status')).countSinceLastExport, 2);
  assert.equal(await cursor(), checkpoint.id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_export_revisions WHERE product_id=ANY($1::int[])',
    [[source.id, successorId]])).rows[0].n, 0);
  // Even an explicit successor range omits it: this is exclusion, not a frozen upper bound.
  const explicit = await call('/api/export/preview', { fromSku: pair[1].full_sku, toSku: pair[1].full_sku });
  assert.equal(explicit.representedCount, 0);

  const currentSnapshot = await capture(after);
  await call(`/api/export/snapshots/${currentSnapshot.id}/confirm`, {});
  assert.equal(await cursor(), last.id);
  assert.ok(await cursor() < successorId);
  assert.equal((await call('/api/export/preview', { mode: 'new' })).representedCount, 0);
  assert.equal((await call('/api/export/status')).countSinceLastExport, 0);

  // A later eligible row lets confirmation pass the excluded successor permanently.
  const later = await createProduct();
  assert.ok(later.id > successorId);
  const next = await call('/api/export/preview', { mode: 'new' });
  assert.deepEqual(ids(next), [later.id]);
  const laterSnapshot = await capture(next);
  await call(`/api/export/snapshots/${laterSnapshot.id}/confirm`, {});
  await call(`/api/export/snapshots/${currentSnapshot.id}/confirm`, {});
  assert.equal(await cursor(), later.id);
  assert.equal((await call('/api/export/status')).countSinceLastExport, 0);
  assert.equal((await call('/api/export/preview', { mode: 'new' })).representedCount, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_export_revisions WHERE product_id=$1',
    [successorId])).rows[0].n, 0);
});
