const assert = require('node:assert/strict');
const pool = require('../src/db/pool');
const products = require('../src/services/product.service');
const prices = require('../src/services/product-price-change.service');
const repricing = require('../src/services/repricing.service');
const corrections = require('../src/services/correction-request.service');

async function run() {
  try {
    assert.ok(new URL(process.env.DATABASE_URL).pathname.endsWith('_test'));
    global.fetch = async () => { throw new Error('Network forbidden in automatic mutation acceptance'); };
    await require('../src/db/run-migrations').runMigrations();
    const actor = (await pool.query("INSERT INTO application_users(status,display_name) VALUES('active','Automatic sync tester') RETURNING id")).rows[0];
    const options = { mutationContext: { actorUserId: Number(actor.id) } };
    await pool.query("INSERT INTO categories(code,name,requires_weight) VALUES('AT','Automatic test',0)");
    const question = (await pool.query(`INSERT INTO questions(category_code,key,label,sku_index,display_order,required,include_in_sku,input_type)
      VALUES('AT','kind','Kind',1,1,1,1,'options') RETURNING id`)).rows[0];
    await pool.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,1,'1','One'),($1,2,'2','Two')", [question.id]);
    const scenario = (await pool.query(`INSERT INTO price_scenarios(category_code,name,match_json,axis_x_key,price_mode,status)
      VALUES('AT','Auto test','{}','kind','fixed_uah','active') RETURNING id`)).rows[0];
    await pool.query('INSERT INTO price_matrix(scenario_id,x_val,y_val,price) VALUES($1,1,0,1000),($1,2,0,1500)', [scenario.id]);
    await require('../src/services/sku-schema.service').ensureLegacySkuSchemas();
    const request = async (id) => (await pool.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1', [id])).rows[0];
    const input = { category: 'AT', categoryCode: 'AT', answers: { kind: 1 }, weight: 0 };
    const save = async () => {
      const preview = await products.buildNewProductPreview(input);
      return products.saveProduct({ ...input, skuSchemaVersionId: preview.skuSchemaVersionId, previewToken: preview.previewToken }, options);
    };
    const legacy = await save(); assert.equal(await request(legacy.id), undefined);
    await pool.query("UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='test-only',actor_user_id=$1", [actor.id]);
    const created = await save(); assert.equal((await request(created.id)).desired_generation, '1');
    const before = (await pool.query('SELECT (SELECT count(*) FROM products) products,(SELECT count(*) FROM sku_registry) reservations,(SELECT count(*) FROM magento_product_sync_requests) requests')).rows[0];
    await pool.query(`CREATE FUNCTION test_auto_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_key='product.created' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_auto_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_auto_audit_failure()`);
    try { await assert.rejects(save(), /injected audit failure/); }
    finally { await pool.query('DROP TRIGGER test_auto_audit_failure ON audit_events; DROP FUNCTION test_auto_audit_failure()'); }
    assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM products) products,(SELECT count(*) FROM sku_registry) reservations,(SELECT count(*) FROM magento_product_sync_requests) requests')).rows[0], before);

    const decision = { mode: 'manual_uah', manualPriceUah: 1250, marketingRoundingEnabled: false };
    const pricePreview = await prices.previewProductPriceChange({ productId: created.id, pricingDecision: decision });
    await prices.applyProductPriceChange({ productId: created.id, pricingDecision: decision, previewToken: pricePreview.previewToken }, options);
    assert.equal((await request(created.id)).desired_generation, '2');

    const preview = await repricing.buildRepricingPreview(scenario.id);
    const applied = await repricing.applyRepricing({ scenarioId: scenario.id, previewToken: preview.previewToken,
      manualOverrides: [{ productId: created.id, newPriceUah: 1400 }] }, options);
    assert.equal((await request(created.id)).desired_generation, '3');
    await repricing.rollbackRepricing(applied.batch?.id || applied.batchId, options);
    assert.equal((await request(created.id)).desired_generation, '4');

    const recountInput = { sourceSku: legacy.fullSku, answers: { kind: 2 }, reason: 'auto target test' };
    const recountPreview = await products.buildProductRecountPreview(recountInput);
    const recounted = await products.applyProductRecount({ ...recountInput, sourceStateSignature: recountPreview.source.stateSignature }, options);
    assert.equal(await request(legacy.id), undefined);
    assert.equal((await request(recounted.correctedProductId)).desired_generation, '1');
    const successor = (await pool.query('SELECT exclude_from_export FROM products WHERE id=$1', [recounted.correctedProductId])).rows[0];
    assert.equal(successor.exclude_from_export, 1, 'legacy recount-only compatibility is preserved');

    const source = await save(); const correctionInput = { sourceSku: source.fullSku, answers: { kind: 2 }, reason: 'auto request target' };
    const correctionPreview = await corrections.previewCorrectionRequest(correctionInput, options);
    const pending = (await corrections.createCorrectionRequest({ ...correctionInput, previewSignature: correctionPreview.previewSignature }, options)).request;
    assert.equal((await request(source.id)).desired_generation, '1', 'pending request is not a product mutation');
    const claimed = (await corrections.claimCorrectionRequest(pending.id, options)).request;
    const done = await corrections.completeCorrectionRequest(claimed.id, claimed.claimVersion, null, options);
    assert.equal((await request(done.recount.correctedProductId)).desired_generation, '1');
    assert.equal((await pool.query('SELECT corrected_to_product_id FROM products WHERE id=$1', [source.id])).rows[0].corrected_to_product_id, done.recount.correctedProductId);
    const { insertProductFixture } = require('./product-fixture');
    await pool.query("INSERT INTO categories(code,name) VALUES('BR','Information fixture'),('SV','Name fixture')");
    await pool.query(`INSERT INTO questions(category_code,key,label,sku_index,display_order,required,include_in_sku,input_type)
      VALUES('BR','braclet_size','Size',0,1,0,0,'text')`);
    const infoProduct = (await insertProductFixture(pool, `INSERT INTO products(full_sku,category,total_price_uah,details)
      VALUES('BR-AUTO-INFO','BR',100,'{"answers":{"braclet_size":"16"}}') RETURNING id`)).rows[0];
    const information = require('../src/services/product-information.service');
    const infoInput = { productId: infoProduct.id, answersPatch: { braclet_size: '17' } };
    const infoPreview = await information.previewProductInformation(infoInput);
    await information.applyProductInformation({ ...infoInput, previewToken: infoPreview.previewToken }, options);
    assert.equal((await request(infoProduct.id)).desired_generation, '2');
    const nameProduct = (await insertProductFixture(pool, "INSERT INTO products(full_sku,category,total_price_uah) VALUES('SV-AUTO-NAME','SV',100) RETURNING id")).rows[0];
    const names = require('../src/services/product-magento-name.service');
    const nameInput = { productId: nameProduct.id, subjectUa: 'Фігурка', subjectEn: 'figurine' };
    const namePreview = await names.previewProductMagentoName(nameInput);
    await names.applyProductMagentoName({ ...nameInput, previewToken: namePreview.previewToken }, options);
    assert.equal((await request(nameProduct.id)).desired_generation, '2');
    await pool.query('UPDATE magento_auto_sync_activation SET enabled=FALSE');
    assert.equal((await pool.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n, 0);
  } finally { await pool.end(); }
}
module.exports = { run };
