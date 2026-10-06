const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Client } = require('pg');

test('060 preserves legacy history, then saves/recounts only public identity and immutable characteristics', async () => {
  const sourceUrl = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(sourceUrl.hostname, '127.0.0.1');
  assert.equal(sourceUrl.port, '55432');
  assert.ok(sourceUrl.pathname.endsWith('_test'));
  const name = `amber_native_characteristics_${process.pid}_test`;
  const control = new Client({ connectionString: sourceUrl.toString() });
  await control.connect();
  const targetUrl = new URL(sourceUrl); targetUrl.pathname = `/${name}`;
  const migrationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-native-characteristics-'));
  let db; let appPool; let created = false;
  try {
    await control.query(`CREATE DATABASE ${name}`);
    created = true;
    process.env.DATABASE_URL = targetUrl.toString(); process.env.NBU_RATE_OVERRIDE = '40';
    require('../test/setup-env');
    appPool = require('../src/db/pool'); db = new Client({ connectionString: targetUrl.toString() }); await db.connect();
    const { runMigrations } = require('../src/db/run-migrations');
    const directory = path.resolve(__dirname, '../migrations');
    for (const file of (await fs.readdir(directory)).filter((file) => file.endsWith('.sql') && file < '060')) {
      await fs.copyFile(path.join(directory, file), path.join(migrationDirectory, file));
    }
    await runMigrations({ directory: migrationDirectory });
    await db.query("INSERT INTO categories(code,name,requires_weight) VALUES('ZZ','Native fixture',0)");
    await db.query(`INSERT INTO questions(category_code,key,label,sku_index,required,include_in_sku,input_type)
      VALUES('ZZ','kind','Kind',1,1,1,'options')`);
    await db.query(`INSERT INTO options(question_id,value_id,sku_code,label)
      SELECT id,7,'17','Seven' FROM questions WHERE category_code='ZZ'`);
    await db.query(`INSERT INTO options(question_id,value_id,sku_code,label)
      SELECT id,8,'18','Eight' FROM questions WHERE category_code='ZZ'`);
    await db.query(`INSERT INTO sku_schema_versions(category_code,version,marker,status,config_hash)
      VALUES('ZZ',1,'','active',$1)`, ['a'.repeat(64)]);
    const lifecycle = require('../src/services/full-product-export.service');
    await db.query('BEGIN');
    const legacy = (await db.query(`INSERT INTO products(full_sku,category,total_price_uah,weight,details)
      VALUES('ZZ-LEGACY','ZZ',100,1,'{"answers":{"kind":7}}') RETURNING id`)).rows[0];
    await lifecycle.initializeNewProduct(db, legacy.id); await db.query('COMMIT');
    const legacyBefore = (await db.query('SELECT to_jsonb(p) row FROM products p WHERE id=$1', [legacy.id])).rows[0].row;
    const legacySyncBefore = (await db.query('SELECT magento_sync_product_input(p) value FROM products p WHERE id=$1',[legacy.id])).rows[0].value;
    const reservationBefore = (await db.query('SELECT * FROM sku_registry')).rows;
    const migration = '060_public_identity_characteristics.sql';
    await fs.copyFile(path.join(directory, migration), path.join(migrationDirectory, migration));
    await fs.appendFile(path.join(migrationDirectory, migration), '\nSELECT 1/0;\n');
    await assert.rejects(runMigrations({ directory: migrationDirectory }), /division by zero/);
    assert.equal((await db.query("SELECT to_regclass('product_characteristic_versions') name")).rows[0].name, null);
    assert.equal((await db.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='products' AND column_name='characteristic_version_id'")).rows[0].n, 0);
    await fs.copyFile(path.join(directory, migration), path.join(migrationDirectory, migration));
    await runMigrations({ directory: migrationDirectory }); await runMigrations({ directory: migrationDirectory });
    const legacyAfter = (await db.query('SELECT to_jsonb(p) row FROM products p WHERE id=$1', [legacy.id])).rows[0].row;
    assert.deepEqual(legacyAfter, { ...legacyBefore, characteristic_version_id: null });
    assert.deepEqual((await db.query('SELECT magento_sync_product_input(p) value FROM products p WHERE id=$1',[legacy.id])).rows[0].value,legacySyncBefore);
    assert.deepEqual((await db.query('SELECT * FROM sku_registry')).rows, reservationBefore);
    // Recount's gallery preservation is installed after the exact 060 legacy
    // checkpoint; 061 remains deferred to exercise optional metadata capture.
    for (const photoMigration of ['062_product_photos.sql', '064_product_archive_visibility.sql', '065_product_media_native_fence.sql']) {
      await fs.copyFile(path.join(directory, photoMigration), path.join(migrationDirectory, photoMigration));
    }
    await runMigrations({ directory: migrationDirectory });
    const actor = (await db.query(`INSERT INTO application_users(status,display_name,activated_at)
      VALUES('active','Native actor',CURRENT_TIMESTAMP) RETURNING id`)).rows[0].id;
    const event = async (key) => (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES($1,$2,'{"displayName":"Native actor","preferredUsername":null}','public_sku_activation','singleton',$3) RETURNING id`,
    [key, actor, crypto.randomUUID()])).rows[0].id;
    const activationEvent = await event('public_sku.activated'); const cutoverEvent = await event('magento_delivery.cutover');
    await db.query('BEGIN'); await db.query("SET LOCAL amber.public_sku_activation='on'");
    await db.query(`UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,
      activated_by_user_id=$1,activation_event_id=$2 WHERE singleton`, [actor, activationEvent]);
    await db.query("SET LOCAL amber.magento_delivery_cutover='on'");
    await db.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='fixture',actor_user_id=$1,
      legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`, [actor, cutoverEvent]);
    await db.query('COMMIT');
    const service = require('../src/services/product.service');
    const payload = { categoryCode: 'ZZ', answers: { kind: 7 }, weight: 12.7 };
    const preview = await service.buildNewProductPreview(payload);
    assert.equal(preview.mode, 'public_identity'); assert.equal(preview.fullProposedSku, null);
    const saved = await service.saveProduct({ ...payload, category: 'ZZ', characteristicConfigHash: preview.characteristicConfigHash,
      previewToken: preview.previewToken, manualPriceUah: 100 }, { mutationContext: { actorUserId: actor } });
    assert.match(saved.publicSku, /^AG-\d{6,}$/); assert.equal(saved.internalSku, null);
    const stored = (await db.query('SELECT * FROM products WHERE id=$1', [saved.id])).rows[0];
    for (const key of ['full_sku','base_sku','sequence_number','sku_schema_version_id']) assert.equal(stored[key], null);
    assert.ok(stored.characteristic_version_id); assert.equal(stored.details.answers.kind, 7);
    assert.deepEqual((await db.query('SELECT * FROM sku_registry')).rows, reservationBefore);
    await assert.rejects(db.query('UPDATE product_characteristic_versions SET snapshot=snapshot WHERE id=$1', [stored.characteristic_version_id]), /immutable/);
    await assert.rejects(db.query("UPDATE products SET full_sku='FAUX' WHERE id=$1", [saved.id]), /immutable|cannot acquire/);
    await assert.rejects(db.query("INSERT INTO products(full_sku,category) VALUES('ENCODED-NEW','ZZ')"), /without an encoded SKU/);
    const decoded = await service.decodeSku(saved.publicSku);
    assert.equal(decoded.sku, saved.publicSku); assert.equal(decoded.internalSku, null);
    assert.equal(decoded.decodedAnswers.find((a) => a.key === 'kind').value_id, 7);
    const recountInput = { sourceSku: saved.publicSku, answers: { kind: 8 }, weight: 12.7, manualPriceUah: 110 };
    const recount = await service.buildProductRecountPreview(recountInput);
    const corrected = await service.applyProductRecount({ ...recountInput, sourceStateSignature: recount.source.stateSignature },
      { mutationContext: { actorUserId: actor } });
    assert.equal(corrected.corrected.publicSku, saved.publicSku); assert.equal(corrected.corrected.fullSku, null);
    const successor = (await db.query('SELECT * FROM products WHERE id=$1', [corrected.correctedProductId])).rows[0];
    assert.equal(successor.public_product_identity_id, stored.public_product_identity_id);
    assert.equal(successor.full_sku, null); assert.equal(successor.sku_schema_version_id, null);
    assert.deepEqual((await db.query('SELECT * FROM sku_registry')).rows, reservationBefore);
    assert.equal((await service.decodeSku(saved.publicSku)).product.id, successor.id);
    assert.equal((await db.query('SELECT count(*)::int n FROM public_product_identities')).rows[0].n, 2);
    assert.equal(corrected.corrected.delivery.route, 'normal', 'native revisions are not historical SKU ambiguities');
    const secondInput = { sourceSku: saved.publicSku, answers: { kind: 7 }, weight: 12.7, manualPriceUah: 120 };
    const secondPreview = await service.buildProductRecountPreview(secondInput);
    assert.equal(secondPreview.corrected.delivery.route, 'normal', 'native correction receipts prove lineage through public identity');
    const second = await service.applyProductRecount({ ...secondInput, sourceStateSignature: secondPreview.source.stateSignature },
      { mutationContext: { actorUserId: actor } });
    assert.equal(second.corrected.publicSku, saved.publicSku);
    const parallel = await Promise.all([1,2].map(() => service.saveProduct({ ...payload, category: 'ZZ',
      characteristicConfigHash: preview.characteristicConfigHash, previewToken: preview.previewToken, manualPriceUah: 100 },
    { mutationContext: { actorUserId: actor } })));
    assert.notEqual(parallel[0].publicSku, parallel[1].publicSku);
    assert.ok(parallel.every((p) => p.internalSku === null));
    assert.deepEqual((await db.query('SELECT * FROM sku_registry')).rows, reservationBefore);
    const pricingPayload = { ...payload, pricingDecision: { mode: 'usd_per_gram', usdPerGram: '2,5', marketingRoundingEnabled: false } };
    const pricingPreview = await service.buildNewProductPreview(pricingPayload);
    assert.equal(pricingPreview.totalPriceUah, 1270); assert.equal(pricingPreview.uahRate, 40);
    const priced = await service.saveProduct({ ...pricingPayload, category: 'ZZ', characteristicConfigHash: pricingPreview.characteristicConfigHash,
      previewToken: pricingPreview.previewToken }, { mutationContext: { actorUserId: actor } });
    const pricedRow = (await db.query('SELECT * FROM products WHERE id=$1', [priced.id])).rows[0];
    assert.equal(Number(pricedRow.total_price_uah), 1270); assert.equal(Number(pricedRow.price_per_gram), 2.5);
    assert.deepEqual(pricedRow.details.customUsdPerGramBasis, { usdPerGram: 2.5, marketingRoundingEnabled: false });
    const manualPayload = { ...payload, pricingDecision: { mode: 'manual_uah', manualPriceUah: 111.11 } };
    const manualPreview = await service.buildNewProductPreview(manualPayload);
    const manuallyPriced = await service.saveProduct({ ...manualPayload, category: 'ZZ', characteristicConfigHash: manualPreview.characteristicConfigHash,
      previewToken: manualPreview.previewToken }, { mutationContext: { actorUserId: actor } });
    const manualRow = (await db.query('SELECT details FROM products WHERE id=$1', [manuallyPriced.id])).rows[0];
    assert.equal(manualRow.details.manualPriceUah, 111.11); assert.equal(manualRow.details.autoPriceUah, null);
    assert.equal(manualRow.details.calculatedPriceUah, null);
    await assert.rejects(service.saveProduct({ ...manualPayload, category: 'ZZ', pricingDecision: { mode: 'manual_uah', manualPriceUah: 111.12 },
      characteristicConfigHash: manualPreview.characteristicConfigHash, previewToken: manualPreview.previewToken },
    { mutationContext: { actorUserId: actor } }), { statusCode: 409 });
    await db.query(`INSERT INTO user_role_assignments(application_user_id,role_id)
      SELECT $1,id FROM roles WHERE role_key='storekeeper'`, [actor]);
    const attemptPayload = { ...manualPayload, category: 'ZZ', characteristicConfigHash: manualPreview.characteristicConfigHash,
      previewToken: manualPreview.previewToken, idempotencyKey: crypto.randomUUID() };
    const beforeAttempt = (await db.query(`SELECT (SELECT count(*) FROM products)::int products,
      (SELECT count(*) FROM public_product_identities)::int identities,
      (SELECT count(*) FROM audit_events WHERE event_key='product.created')::int audits`)).rows[0];
    const raced = await Promise.all([1,2].map(() => service.saveProduct(attemptPayload, { mutationContext: { actorUserId: actor } })));
    assert.deepEqual(raced[0], raced[1], 'concurrent original attempts recover the same identity');
    const afterAttempt = (await db.query(`SELECT (SELECT count(*) FROM products)::int products,
      (SELECT count(*) FROM public_product_identities)::int identities,
      (SELECT count(*) FROM audit_events WHERE event_key='product.created')::int audits`)).rows[0];
    for (const key of Object.keys(beforeAttempt)) assert.equal(afterAttempt[key], beforeAttempt[key]+1);
    assert.equal((await db.query('SELECT count(*)::int n FROM product_creation_receipts')).rows[0].n, 1);
    await assert.rejects(service.saveProduct({ ...attemptPayload, enableWhenPhotosVerified: true },
      { mutationContext: { actorUserId: actor } }), { code: 'CREATION_ATTEMPT_CONFLICT', statusCode: 409 });
    await db.query("UPDATE questions SET label='Changed after original create' WHERE category_code='ZZ'");
    await assert.rejects(service.saveProduct({ ...attemptPayload, idempotencyKey: crypto.randomUUID() },
      { mutationContext: { actorUserId: actor } }), { statusCode: 409 });
    assert.deepEqual(await service.saveProduct(attemptPayload, { mutationContext: { actorUserId: actor } }), raced[0],
      'lost-response recovery uses original committed receipt before stale preview validation');
    await db.query("UPDATE application_users SET status='disabled' WHERE id=$1", [actor]);
    await assert.rejects(service.saveProduct(attemptPayload, { mutationContext: { actorUserId: actor } }), { statusCode: 403 });
    await db.query("UPDATE application_users SET status='active' WHERE id=$1", [actor]);
    await assert.rejects(db.query("UPDATE product_creation_receipts SET request_hash=repeat('b',64)"), /immutable/);
    await assert.rejects(db.query('DELETE FROM product_creation_receipts'), /immutable/);
    assert.deepEqual((await db.query('SELECT * FROM sku_registry')).rows, reservationBefore);
    const freshPreview = await service.buildNewProductPreview(manualPayload);
    const rollbackPayload = { ...manualPayload, category: 'ZZ', characteristicConfigHash: freshPreview.characteristicConfigHash,
      previewToken: freshPreview.previewToken, idempotencyKey: crypto.randomUUID() };
    await db.query(`CREATE FUNCTION reject_creation_receipt_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'creation receipt fixture failure'; END $$`);
    await db.query(`CREATE TRIGGER reject_creation_receipt_fixture BEFORE INSERT ON product_creation_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_creation_receipt_fixture()`);
    try {
      await assert.rejects(service.saveProduct(rollbackPayload, { mutationContext: { actorUserId: actor } }), /receipt fixture failure/);
    } finally { await db.query('DROP TRIGGER reject_creation_receipt_fixture ON product_creation_receipts'); }
    assert.deepEqual((await db.query(`SELECT (SELECT count(*) FROM products)::int products,
      (SELECT count(*) FROM public_product_identities)::int identities,
      (SELECT count(*) FROM audit_events WHERE event_key='product.created')::int audits`)).rows[0], afterAttempt,
    'receipt failure rolls back product, identity and audit as one transaction');
    const metadataMigration = '061_catalog_numeric_archive.sql';
    await fs.copyFile(path.join(directory, metadataMigration), path.join(migrationDirectory, metadataMigration));
    await runMigrations({ directory: migrationDirectory });
    const numericRule = { kind: 'decimal', unit: 'мм', min: 0, max: 20, minInclusive: false, maxInclusive: true, maxFractionDigits: 1 };
    await db.query(`INSERT INTO questions(category_code,key,label,input_type,include_in_sku,numeric_validation)
      VALUES('ZZ','length','Length','text',0,$1::jsonb)`, [JSON.stringify(numericRule)]);
    const numericPayload = { ...manualPayload, answers: { kind: 7, length: '12,7' } };
    const numericPreview = await service.buildNewProductPreview(numericPayload);
    assert.equal(numericPreview.normalizedAnswers.length, 12.7);
    const numericSaved = await service.saveProduct({ ...numericPayload, category: 'ZZ',
      characteristicConfigHash: numericPreview.characteristicConfigHash, previewToken: numericPreview.previewToken }, { mutationContext: { actorUserId: actor } });
    const numericVersion = (await db.query(`SELECT v.* FROM product_characteristic_versions v JOIN products p
      ON p.characteristic_version_id=v.id WHERE p.id=$1`, [numericSaved.id])).rows[0];
    assert.deepEqual(numericVersion.snapshot.questions.find((q) => q.key==='length').numeric_validation, numericRule);
    assert.equal(numericVersion.snapshot.questions.find((q) => q.key==='length').archived, false);
    assert.equal((await db.query('SELECT details FROM products WHERE id=$1', [numericSaved.id])).rows[0].details.characteristicConfigVersion,
      String(numericVersion.version));
    await db.query(`UPDATE questions SET numeric_validation=jsonb_set(numeric_validation,'{max}','21'), archived=TRUE
      WHERE category_code='ZZ' AND key='length'`);
    assert.deepEqual((await db.query('SELECT snapshot FROM product_characteristic_versions WHERE id=$1', [numericVersion.id])).rows[0].snapshot,
      numericVersion.snapshot, 'live metadata edits do not reinterpret immutable creation evidence');
    const photos = require('../src/services/product-photos.service');
    const context = { actorUserId: actor, requestId: 'native-recount-photo-preservation' };
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE5sAAAAASUVORK5CYII=';
    const original = await photos.stage({ idempotencyKey: crypto.randomUUID(), name: 'recount.png', mimeType: 'image/png', base64: png }, { mutationContext: context });
    const secondOriginal = await photos.stage({ idempotencyKey: crypto.randomUUID(), name: 'recount-second.png', mimeType: 'image/png', base64: png }, { mutationContext: context });
    const galleryIds = [secondOriginal.id, original.id];
    const galleryPayload = { ...manualPayload, photoIds: galleryIds, enableWhenPhotosVerified: true };
    const galleryPreview = await service.buildNewProductPreview(galleryPayload);
    const gallerySaved = await service.saveProduct({ ...galleryPayload, category: 'ZZ',
      characteristicConfigHash: galleryPreview.characteristicConfigHash, previewToken: galleryPreview.previewToken }, { mutationContext: context });
    const assetBefore = (await db.query('SELECT * FROM product_photo_assets WHERE id=$1', [original.id])).rows[0];
    const secondAssetBefore = (await db.query('SELECT * FROM product_photo_assets WHERE id=$1', [secondOriginal.id])).rows[0];
    const originalJob = (await db.query('SELECT * FROM product_media_jobs WHERE product_id=$1', [gallerySaved.id])).rows[0];
    const recountGallery = async (kind, mutationContext) => {
      const input = { sourceSku: gallerySaved.publicSku, answers: { kind }, weight: 12.7, manualPriceUah: 150 };
      const reviewed = await service.buildProductRecountPreview(input);
      return service.applyProductRecount({ ...input, sourceStateSignature: reviewed.source.stateSignature }, { mutationContext });
    };
    const firstGalleryRecount = await recountGallery(8, context);
    const firstGallery = await photos.read(firstGalleryRecount.correctedProductId);
    assert.deepEqual(firstGallery.photos.map((photo) => photo.id), galleryIds);
    assert.equal(firstGallery.enableWhenVerified, true);
    assert.equal((await db.query('SELECT state FROM product_media_jobs WHERE id=$1', [originalJob.id])).rows[0].state, 'superseded');
    const secondGalleryRecount = await recountGallery(7, context);
    assert.equal(secondGalleryRecount.corrected.publicSku, gallerySaved.publicSku);
    assert.deepEqual((await photos.read(secondGalleryRecount.correctedProductId)).photos.map((photo) => photo.id), galleryIds);
    assert.deepEqual((await db.query('SELECT * FROM product_photo_assets WHERE id=$1', [original.id])).rows[0], assetBefore, 'successors never move or rewrite the predecessor-owned original');
    assert.deepEqual((await photos.read(gallerySaved.id)).photos.map((photo) => photo.id), galleryIds, 'historical gallery remains readable');
    const completionActor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Gallery completion only') RETURNING id")).rows[0].id);
    const completionRole = Number((await db.query("INSERT INTO roles(role_key,display_name,description) VALUES('gallery_completion_only','Gallery completion only','Inherited gallery completion fixture') RETURNING id")).rows[0].id);
    for (const permission of ['corrections.view', 'corrections.claim', 'corrections.complete']) await db.query('INSERT INTO role_permissions(role_id,permission_key) VALUES($1,$2)', [completionRole, permission]);
    await db.query('INSERT INTO user_role_assignments(application_user_id,role_id) VALUES($1,$2)', [completionActor, completionRole]);
    const completionContext = { actorUserId: completionActor, requestId: 'native-gallery-completion-authority' };
    const currentGallery = await photos.read(secondGalleryRecount.correctedProductId);
    await assert.rejects(photos.save(secondGalleryRecount.correctedProductId, { idempotencyKey: crypto.randomUUID(), expectedVersion: currentGallery.version,
      photoIds: galleryIds, enableWhenVerified: true }, { mutationContext: completionContext }), { statusCode: 403 });
    const beforeDeniedRecount = (await db.query('SELECT count(*)::int n FROM products')).rows[0].n;
    await assert.rejects(recountGallery(8, completionContext), { statusCode: 403 });
    assert.equal((await db.query('SELECT count(*)::int n FROM products')).rows[0].n, beforeDeniedRecount, 'denied inheritance rolls back successor allocation');
    assert.equal((await service.decodeSku(gallerySaved.publicSku)).product.id, secondGalleryRecount.correctedProductId);
    const corrections = require('../src/services/correction-request.service');
    const request = await corrections.createCorrectionRequest({ sourceSku: gallerySaved.publicSku, answers: { kind: 8 }, weight: 12.7, manualPriceUah: 150 }, { mutationContext: context });
    const claim = await corrections.claimCorrectionRequest(request.request.id, { mutationContext: completionContext });
    const completed = await corrections.completeCorrectionRequest(request.request.id, claim.request.claimVersion, null, { mutationContext: completionContext });
    const completedGallery = await photos.read(completed.recount.correctedProductId);
    assert.deepEqual(completedGallery.photos.map((photo) => photo.id), galleryIds);
    assert.equal(completedGallery.enableWhenVerified, true);
    assert.equal(completed.recount.corrected.publicSku, gallerySaved.publicSku);
    const inheritedJob = (await db.query('SELECT * FROM product_media_jobs WHERE product_id=$1', [completed.recount.correctedProductId])).rows[0];
    assert.equal(inheritedJob.required_permission, 'corrections.complete');
    assert.equal(Number(inheritedJob.actor_user_id), completionActor);
    assert.deepEqual((await db.query('SELECT * FROM product_photo_assets WHERE id=$1', [original.id])).rows[0], assetBefore);
    assert.deepEqual((await db.query('SELECT * FROM product_photo_assets WHERE id=$1', [secondOriginal.id])).rows[0], secondAssetBefore);
    const nativeRequest = (await db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1', [completed.recount.correctedProductId])).rows[0];
    // Local fixture marks an unresolved dispatch without any Magento request.
    await db.query("UPDATE product_media_jobs SET native_generation=$2,state='uncertain' WHERE id=$1", [inheritedJob.id, nativeRequest.desired_generation]);
    await db.query("INSERT INTO product_media_steps(job_id,step_key,operation_hash) VALUES($1,'upload:fixture',$2)", [inheritedJob.id, 'b'.repeat(64)]);
    const stickyState = async () => ({
      products: (await db.query('SELECT * FROM products WHERE public_product_identity_id=$1 ORDER BY id', [nativeRequest.public_product_identity_id])).rows,
      request: (await db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1', [completed.recount.correctedProductId])).rows,
      job: (await db.query('SELECT * FROM product_media_jobs WHERE id=$1', [inheritedJob.id])).rows,
      steps: (await db.query('SELECT * FROM product_media_steps WHERE job_id=$1', [inheritedJob.id])).rows,
    });
    const beforeBlockedRecount = await stickyState();
    await assert.rejects(recountGallery(7, context), { statusCode: 409, code: 'PHOTO_MEDIA_RECONCILIATION_REQUIRED' });
    assert.deepEqual(await stickyState(), beforeBlockedRecount, 'started delivery blocks recount atomically without resetting generation or permanent dispatch evidence');
  } finally {
    if (appPool) await appPool.end(); if (db) await db.end();
    if (created) await control.query(`DROP DATABASE ${name}`);
    await control.end();
    assert.equal(path.dirname(path.resolve(migrationDirectory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(migrationDirectory).startsWith('amber-native-characteristics-'));
    await fs.rm(migrationDirectory, { recursive: true, force: true });
  }
});
