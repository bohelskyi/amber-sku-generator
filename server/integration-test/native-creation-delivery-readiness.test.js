const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

test('native creation previews and save receipts report authoritative delivery blockers across reviewed binding changes', async () => {
  const sourceUrl = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(sourceUrl.hostname, '127.0.0.1');
  assert.equal(sourceUrl.port, '55432');
  assert.ok(sourceUrl.pathname.endsWith('_test'));
  const name = `amber_native_creation_readiness_${process.pid}_test`;
  const control = new Client({ connectionString: sourceUrl.toString() });
  await control.connect();
  let db, appPool, created = false;
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0,
      'Never drop or reuse a database that this test did not create');
    await control.query(`CREATE DATABASE ${name}`); created = true;
    const url = new URL(sourceUrl); url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString(); process.env.NBU_RATE_OVERRIDE = '40';
    process.env.MAGENTO_BASE_URL = '';
    require('../test/setup-env');
    appPool = require('../src/db/pool');
    db = new Client({ connectionString: url.toString() }); await db.connect();
    await require('../src/db/run-migrations').runMigrations();
    const actor = (await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Native evaluator fixture') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const options = { databasePool: appPool, mutationContext: { actorUserId: actor } };
    for (const [category, key, values] of [['NM', 'extra', [1, 2]], ['AR', 'size', Array.from({ length: 31 }, (_, i) => i + 1)]]) {
      await db.query("INSERT INTO categories(code,name,requires_weight,sku_publication_mode) VALUES($1,$1,0,'explicit')", [category]);
      const question = (await db.query(`INSERT INTO questions(category_code,key,label,sku_index,include_in_sku,required,input_type)
        VALUES($1,$2,$2,1,1,0,'options') RETURNING id`, [category, key])).rows[0].id;
      for (const value of values) await db.query('INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,$2,$3,$3)', [question, value, String(value)]);
      // Historical configuration supplies the old publication's existing proof.
      // New products below never use this schema or allocate an encoded SKU.
      await require('../src/services/sku-schema.service').publishSkuSchema(category, options);
    }
    const fixture = require('../test/fixtures/magento-v4');
    const { upgradeColumns } = require('../src/services/export-templates/column-contract');
    const { upgradeSourceSupport } = require('../src/services/export-templates/source-support');
    const { compileDefinition } = require('../src/services/export-templates/definition');
    const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
    const { officeCatalog, officeEvidence } = require('../test/fixtures/magento-v1/office');
    const frozenOffice = upgradeSourceSupport(upgradeColumns(materializeMagentoV1(officeCatalog(), { publicSku: true })), officeEvidence());
    const definition = fixture.definition(['NM', 'AR']);
    const text = (id) => ({ op: 'text', input: { op: 'source', id }, trim: false, format: 'scalar-v1', onAbsent: 'empty' });
    definition.sources = { sku: definition.sources.sku, price: definition.sources.price };
    definition.tables = {}; definition.questionContracts = {};
    definition.sourceSupport = structuredClone(frozenOffice.sourceSupport);
    for (const [category, key, values] of [['NM', 'extra', [1, 2]], ['AR', 'size', Array.from({ length: 31 }, (_, i) => i + 1)]]) {
      const source = `${category}.${key}`;
      definition.sources[source] = structuredClone(frozenOffice.sources[source]);
      definition.questionContracts[source] = { source, exists: true, required: false, rule: {}, allowed: values.map(String) };
      definition.tables[category] = Object.fromEntries(values.map((value) => [value, 'Red output']));
      const group = definition.groups.find((g) => g.route === category);
      group.columns.push('kolir');
      for (const row of group.rows) row.cells.kolir = { op: 'lookup', input: { op: 'semanticKey', input: { op: 'source', id: source } },
        table: category, otherwise: { op: 'error', field: 'kolir', message: { op: 'literal', value: 'Missing value' } } };
      group.rows.forEach((row) => { row.cells.price = text('price'); });
    }
    const templates = require('../src/services/export-templates/template.service');
    const family = await templates.createTemplate({ key: 'native-frozen4', displayName: 'Native frozen four', definition }, options);
    const oldVersion = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    const bindings = require('../src/services/magento/binding.service');
    const schema = fixture.observation();
    const config = { configured: true, baseUrl: 'https://native-evaluator.invalid' };
    options.creationDeliveryConfig = config;
    let oldDraft = await bindings.createDraft({ installationKey: 'native-eval5', origin: config.baseUrl, templateVersionId: oldVersion.id,
      observedAt: new Date().toISOString(), schema }, options);
    oldDraft = await bindings.updateDraft(oldDraft.id, { expectedRevision: oldDraft.revision, bindings: fixture.approvedBindings(definition, schema) }, options);
    const oldBinding = await bindings.publishDraft(oldDraft.id, { expectedRevision: oldDraft.revision, expectedCurrentId: null }, options);
    const registryBefore = (await db.query('SELECT * FROM sku_registry ORDER BY full_sku')).rows;
    const oldVersionBefore = (await db.query('SELECT definition,definition_hash FROM export_template_versions WHERE id=$1', [oldVersion.id])).rows[0];
    const oldBindingBefore = await bindings.getRevision(oldBinding.id, options);
    const activationEvent = (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('public_sku.activated',$1,'{"displayName":"Native evaluator fixture","preferredUsername":null}','public_sku_activation','singleton',$2) RETURNING id`, [actor, crypto.randomUUID()])).rows[0].id;
    const cutoverEvent = (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('magento_delivery.cutover',$1,'{"displayName":"Native evaluator fixture","preferredUsername":null}','public_sku_activation','singleton',$2) RETURNING id`, [actor, crypto.randomUUID()])).rows[0].id;
    await db.query('BEGIN'); await db.query("SET LOCAL amber.public_sku_activation='on'");
    await db.query(`UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,
      activated_by_user_id=$1,activation_event_id=$2 WHERE singleton`, [actor, activationEvent]);
    await db.query("SET LOCAL amber.magento_delivery_cutover='on'");
    await db.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='native-eval5',actor_user_id=$1,
      legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`, [actor, cutoverEvent]);
    await db.query('COMMIT');
    const products = require('../src/services/product.service');
    const createdProducts = [];
    const pendingAttempts = [];
    for (const [category, key, value] of [['NM', 'extra', 1], ['AR', 'size', 28]]) {
      const payload = { categoryCode: category, answers: { [key]: value }, weight: 1,
        pricingDecision: { mode: 'manual_uah', manualPriceUah: 100, marketingRoundingEnabled: false } };
      const counts = async () => (await db.query(`SELECT (SELECT count(*) FROM products) products,
        (SELECT count(*) FROM product_characteristic_versions) characteristics,
        (SELECT last_value FROM public_product_sku_sequence) public_sequence`)).rows[0];
      const beforePreview = await counts();
      const preview = await products.buildNewProductPreview(payload, { creationDeliveryConfig: config });
      assert.deepEqual(await counts(), beforePreview, 'Readiness preview must not allocate a product/identity/characteristic version');
      assert.equal(preview.creationDeliveryReadiness.code, 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED');
      assert.equal(preview.creationDeliveryReadiness.bindingRevisionId, oldBinding.id);
      assert.equal(preview.mode, 'public_identity'); assert.equal(preview.fullProposedSku, null);
      const savePayload = { ...payload, category, idempotencyKey: crypto.randomUUID(), characteristicConfigHash: preview.characteristicConfigHash, previewToken: preview.previewToken,
        creationDeliveryReadiness: { status: 'no_native_upgrade_blocker', code: null } };
      const saved = await products.saveProduct(savePayload, options);
      assert.equal(saved.creationDeliveryReadiness.code, 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED', 'Caller cannot clear authoritative warning');
      assert.deepEqual(await products.saveProduct(savePayload, options), saved, 'Lost-response retry returns original immutable warning/result');
      assert.deepEqual((await db.query('SELECT result FROM product_creation_receipts WHERE actor_user_id=$1 AND idempotency_key=$2', [actor, savePayload.idempotencyKey])).rows[0].result, saved);
      pendingAttempts.push({ savePayload, saved });
      const input = { sourceSku: saved.publicSku, answers: { [key]: category === 'NM' ? 2 : 1 }, weight: 1, manualPriceUah: 110 };
      const recountPreview = await products.buildProductRecountPreview(input);
      const recounted = await products.applyProductRecount({ ...input, sourceStateSignature: recountPreview.source.stateSignature }, options);
      assert.equal(recounted.corrected.publicSku, saved.publicSku);
      let currentId = recounted.correctedProductId;
      if (category === 'AR') {
        const again = { ...input, answers: { size: 28 } };
        const next = await products.buildProductRecountPreview(again);
        const result = await products.applyProductRecount({ ...again, sourceStateSignature: next.source.stateSignature }, options);
        currentId = result.correctedProductId; assert.equal(result.corrected.publicSku, saved.publicSku);
      }
      const current = (await db.query(`SELECT p.*,i.public_sku FROM products p
        JOIN public_product_identities i ON i.id=p.public_product_identity_id WHERE p.id=$1`, [currentId])).rows[0];
      assert.equal(current.full_sku, null); assert.equal(current.sku_schema_version_id, null); assert.ok(current.characteristic_version_id);
      createdProducts.push(current);
    }
    const { loadSupportInputs } = require('../src/services/export-templates/support-inputs');
    const { evaluateProduct } = require('../src/services/export-templates/evaluate');
    for (const product of (await loadSupportInputs(db, oldVersion.definition, createdProducts)).products) {
      assert.ok(evaluateProduct(compileDefinition(oldVersion.definition), product).errors.some((issue) => issue.code === 'SOURCE_SUPPORT_INVALID'));
    }
    const awaitingPayload = { categoryCode: 'NM', answers: { extra: 1 }, weight: 1, pricingDecision: { mode: 'manual_uah', manualPriceUah: 100 } };
    const awaitingPreview = await products.buildNewProductPreview(awaitingPayload, { creationDeliveryConfig: config });
    assert.equal(awaitingPreview.creationDeliveryReadiness.code, 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED');
    const nextFamily = await templates.createTemplate({ key: 'native-reviewed5', displayName: 'Native reviewed five', definition: oldVersion.definition }, options);
    const upgraded = await templates.upgradeDraft(nextFamily.id, { expectedRevision: nextFamily.draft.revision,
      expectedDefinitionHash: nextFamily.draft.definitionHash, targetContract: 'public-product-characteristics-v1' }, options);
    assert.equal(upgraded.definition.evaluatorVersion, 'magento-declarative-5');
    assert.equal((await bindings.getCurrentPublished('native-eval5', options)).id, oldBinding.id, 'Draft upgrade cannot replace a binding');
    const nextVersion = await templates.publishTemplate(nextFamily.id, { expectedRevision: upgraded.revision, expectedDefinitionHash: upgraded.definitionHash }, options);
    const successor = require('../src/services/magento/integration-successor');
    let fetchCount = 0;
    const remote = { ...options, discover: async () => ({ schema, categories: [], observedAt: '2026-10-05T00:00:00.000Z' }),
      fetchImpl: async () => { fetchCount += 1; assert.fail('This fixture must never call a Magento transport'); } };
    const input = { sourceId: oldBinding.id, expectedSourceRevision: oldBinding.revision, templateVersionId: nextVersion.id, productIds: [] };
    const preparation = await successor.prepare(config, input, remote);
    const isolated = await successor.apply(config, { ...input, previewToken: preparation.previewToken }, remote);
    assert.equal(isolated.state, 'draft'); assert.equal((await bindings.getCurrentPublished('native-eval5', options)).id, oldBinding.id);
    const reviewed = await bindings.updateDraft(isolated.id, { expectedRevision: isolated.revision, bindings: fixture.approvedBindings(nextVersion.definition, schema) }, options);
    const published = await bindings.publishDraft(reviewed.id, { expectedRevision: reviewed.revision, expectedCurrentId: oldBinding.id }, options);
    assert.equal(published.templateVersionId, nextVersion.id);
    const refreshed = await products.buildNewProductPreview(awaitingPayload, { creationDeliveryConfig: config });
    assert.equal(refreshed.creationDeliveryReadiness.status, 'no_native_upgrade_blocker');
    assert.equal(refreshed.previewToken, awaitingPreview.previewToken, 'Binding diagnostic does not change signed local business intent');
    const afterChange = await products.saveProduct({ ...awaitingPayload, category: 'NM', characteristicConfigHash: awaitingPreview.characteristicConfigHash, previewToken: awaitingPreview.previewToken }, options);
    assert.equal(afterChange.creationDeliveryReadiness.status, 'no_native_upgrade_blocker', 'Save rechecks newer authoritative binding');
    assert.equal(afterChange.creationDeliveryReadiness.bindingRevisionId, published.id);
    assert.deepEqual(await products.saveProduct(pendingAttempts[0].savePayload, options), pendingAttempts[0].saved, 'Old receipt stays exact after configuration upgrade');
    const deferredPayload = { categoryCode: 'AR', answers: { size: 29 }, weight: 1, pricingDecision: { mode: 'manual_uah', manualPriceUah: 100 } };
    const deferred = await products.buildNewProductPreview(deferredPayload, { creationDeliveryConfig: config });
    assert.equal(deferred.creationDeliveryReadiness.code, 'SOURCE_SUPPORT_DEFERRED_VALUE');
    const deferredSaved = await products.saveProduct({ ...deferredPayload, category: 'AR', characteristicConfigHash: deferred.characteristicConfigHash, previewToken: deferred.previewToken }, options);
    assert.equal(deferredSaved.creationDeliveryReadiness.code, 'SOURCE_SUPPORT_DEFERRED_VALUE');
    assert.equal(deferredSaved.creationDeliveryReadiness.targetContract, undefined);
    const disabled = await products.buildNewProductPreview(awaitingPayload, { creationDeliveryConfig: { configured: false } });
    assert.equal(disabled.creationDeliveryReadiness.status, 'not_checked');
    const wrongOrigin = await products.buildNewProductPreview(awaitingPayload, { creationDeliveryConfig: { configured: true, baseUrl: 'https://wrong-origin.invalid' } });
    assert.equal(wrongOrigin.creationDeliveryReadiness.reasonCode, 'MAGENTO_CURRENT_BINDING_UNAVAILABLE');
    for (const product of (await loadSupportInputs(db, nextVersion.definition, createdProducts)).products) {
      const evaluated = evaluateProduct(compileDefinition(nextVersion.definition), product);
      assert.deepEqual(evaluated.errors, []); assert.equal(evaluated.base.sku, product.public_sku);
    }
    const ar = createdProducts.find((p) => p.category === 'AR');
    for (const size of [29, 30, 31]) {
      const changed = { ...ar, details: { ...ar.details, answers: { size } } };
      const [product] = (await loadSupportInputs(db, nextVersion.definition, [changed])).products;
      assert.ok(evaluateProduct(compileDefinition(nextVersion.definition), product).errors.some((issue) => issue.code === 'SOURCE_SUPPORT_INVALID'));
    }
    assert.deepEqual((await db.query('SELECT definition,definition_hash FROM export_template_versions WHERE id=$1', [oldVersion.id])).rows[0], oldVersionBefore);
    assert.deepEqual(await bindings.getRevision(oldBinding.id, options), oldBindingBefore);
    assert.deepEqual((await db.query('SELECT * FROM sku_registry ORDER BY full_sku')).rows, registryBefore);
    assert.equal((await db.query('SELECT count(*)::int n FROM products WHERE full_sku IS NOT NULL OR sku_schema_version_id IS NOT NULL')).rows[0].n, 0);
    assert.equal(fetchCount, 0);
  } finally {
    if (db) await db.end(); if (appPool) await appPool.end();
    if (created) {
      await control.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name]);
      await control.query(`DROP DATABASE ${name}`);
    }
    await control.end();
  }
});
