const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

test('reviewed effective-name successor supports generated CREATE, exact full names and explicit fresh Magento import without rewriting old evidence', async () => {
  const source = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = `amber_effective_names_${process.pid}_test`, control = new Client({ connectionString: source.toString() });
  await control.connect(); let db, appPool, created = false;
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0);
    await control.query(`CREATE DATABASE ${name}`); created = true;
    const target = new URL(source); target.pathname = `/${name}`;
    process.env.DATABASE_URL = target.toString(); process.env.MAGENTO_BASE_URL = ''; process.env.NBU_RATE_OVERRIDE = '40';
    require('../test/setup-env'); appPool = require('../src/db/pool');
    db = new Client({ connectionString: target.toString() }); await db.connect();
    await require('../src/db/run-migrations').runMigrations();
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Effective names fixture') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const config = { configured: true, baseUrl: 'https://effective-names.invalid', consumerKey: 'fixture', consumerSecret: 'fixture', accessToken: 'fixture', accessTokenSecret: 'fixture' };
    const options = { databasePool: appPool, mutationContext: { actorUserId: actor }, config, creationDeliveryConfig: config };
    await db.query("INSERT INTO categories(code,name,requires_weight,sku_publication_mode) VALUES('AR','Art',1,'explicit')");
    const question = (await db.query("INSERT INTO questions(category_code,key,label,sku_index,include_in_sku,required,input_type) VALUES('AR','type','Type',1,1,1,'options') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,1,'1','One')", [question]);
    const schema = await require('../src/services/sku-schema.service').publishSkuSchema('AR', options);
    await db.query('BEGIN');
    const legacyId = (await db.query(`INSERT INTO products(full_sku,base_sku,sequence_number,category,weight,total_price_uah,details,sku_schema_version_id,created_by_user_id)
      VALUES('AR1-000001','AR1',1,'AR',2,100,'{"answers":{"type":1}}',$1,$2) RETURNING id`, [schema.id, actor])).rows[0].id;
    await require('../src/services/full-product-export.service').initializeNewProduct(db, legacyId);
    await db.query('COMMIT');
    const fixture = require('../test/fixtures/magento-v4');
    const definition = fixture.definition(['AR']); delete definition.sources.color; delete definition.sources.note;
    definition.questionContracts = {}; definition.tables = {};
    definition.sources.weight = { kind: 'product', field: 'weight', type: 'scalar' };
    definition.groups[0].rows.forEach(row => { row.cells.name = { op: 'when', if: { op: 'in', input: { op: 'source', id: 'weight' }, values: [1, '1', '1.000'] },
      then: { op: 'literal', value: row.id === 'base' ? 'Автоматична назва' : 'Generated name' }, else: { op: 'literal', value: '' } }; });
    const templates = require('../src/services/export-templates/template.service');
    const family = await templates.createTemplate({ key: 'effective-names', displayName: 'Effective names', definition }, options);
    const old = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    const oldRow = (await db.query('SELECT * FROM export_template_versions WHERE id=$1', [old.id])).rows[0];
    const loaded = await templates.getTemplate(family.id, options);
    const upgraded = await templates.upgradeDraft(family.id, { expectedRevision: loaded.draft.revision, expectedDefinitionHash: loaded.draft.definitionHash,
      targetContract: 'effective-product-names-v1' }, options);
    const version = await templates.publishTemplate(family.id, { expectedRevision: upgraded.revision, expectedDefinitionHash: upgraded.definitionHash }, options);
    const bindings = require('../src/services/magento/binding.service'), observation = fixture.observation();
    let binding = await bindings.createDraft({ installationKey: 'effective-names', origin: config.baseUrl, templateVersionId: version.id, observedAt: new Date().toISOString(), schema: observation }, options);
    binding = await bindings.updateDraft(binding.id, { expectedRevision: binding.revision, bindings: fixture.approvedBindings(version.definition, observation) }, options);
    binding = await bindings.publishDraft(binding.id, { expectedRevision: binding.revision, expectedCurrentId: null }, options);
    const event = (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('public_sku.activated',$1,'{"displayName":"Effective names fixture","preferredUsername":null}','public_sku_activation','singleton',$2) RETURNING id`, [actor, crypto.randomUUID()])).rows[0].id;
    await db.query('BEGIN'); await db.query("SET LOCAL amber.public_sku_activation='on'");
    await db.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton', [actor, event]);
    const cutoverEvent = (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
      VALUES('magento_delivery.cutover',$1,'{"displayName":"Effective names fixture","preferredUsername":null}','public_sku_activation','singleton',$2) RETURNING id`, [actor, crypto.randomUUID()])).rows[0].id;
    await db.query("SET LOCAL amber.magento_delivery_cutover='on'");
    await db.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='effective-names',actor_user_id=$1,
      legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`, [actor, cutoverEvent]);
    await db.query('UPDATE magento_auto_sync_activation SET enabled=FALSE WHERE singleton'); await db.query('COMMIT');
    let actualFetch = 0; const oldFetch = global.fetch; global.fetch = () => { actualFetch++; throw new Error('EXTERNAL_FETCH_FORBIDDEN'); };
    try {
      const products = require('../src/services/product.service');
      const payload = { categoryCode: 'AR', answers: { type: 1 }, weight: 1, pricingDecision: { mode: 'manual_uah', manualPriceUah: 100 } };
      const preview = await products.buildNewProductPreview(payload, { creationDeliveryConfig: config });
      assert.equal(preview.creationNames.ready, true); assert.equal(preview.fullProposedSku, null);
      const saved = await products.saveProduct({ ...payload, category: 'AR', characteristicConfigHash: preview.characteristicConfigHash, previewToken: preview.previewToken }, options);
      assert.deepEqual((await require('../src/services/magento/product-names.service').read(saved.id, options)).names, { all: 'Автоматична назва', en: 'Generated name' });
      const incomplete = { ...payload, weight: 2 };
      const missing = await products.buildNewProductPreview(incomplete, { creationDeliveryConfig: config });
      assert.equal(missing.creationNames.ready, false);
      await assert.rejects(products.saveProduct({ ...incomplete, category: 'AR', characteristicConfigHash: missing.characteristicConfigHash, previewToken: missing.previewToken }, options), { code: 'PRODUCT_NAMES_REQUIRED' });
      const names = { all: ' Точна повна назва ', en: ' Exact full name ' };
      const filledPayload = { ...incomplete, magentoNames: names };
      const filled = await products.buildNewProductPreview(filledPayload, { creationDeliveryConfig: config });
      const manual = await products.saveProduct({ ...filledPayload, category: 'AR', characteristicConfigHash: filled.characteristicConfigHash, previewToken: filled.previewToken }, options);
      const manualRow = (await db.query('SELECT * FROM products WHERE id=$1', [manual.id])).rows[0];
      assert.equal(manualRow.magento_name_subject_ua, null); assert.equal(manualRow.magento_name_subject_en, null);
      assert.deepEqual((await require('../src/services/magento/product-names.service').read(manual.id, options)).names, names);
      const nameService = require('../src/services/magento/product-names.service');
      const readManual = await nameService.read(manual.id, options);
      await db.query('UPDATE products SET correction_reason=$2 WHERE id=$1', [manual.id, 'Fixture local change']);
      await assert.rejects(nameService.save({ productId: manual.id, names: { all: 'Changed UA', en: 'Changed EN' }, previewToken: readManual.previewToken }, options), { code: 'PRODUCT_NAMES_STALE' });
      assert.deepEqual((await nameService.read(manual.id, options)).names, names);
      const manualFresh = await nameService.read(manual.id, options);
      const beforeFailure = (await db.query('SELECT magento_name_override, (SELECT revision FROM product_full_export_state WHERE product_id=p.id) revision FROM products p WHERE id=$1', [manual.id])).rows[0];
      await db.query(`CREATE FUNCTION reject_name_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_key='product.magento_name_amber_changed' THEN RAISE EXCEPTION 'NAME_FIXTURE_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_name_fixture_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_name_fixture_audit()`);
      await assert.rejects(nameService.save({ productId: manual.id, names: { all: 'Changed UA', en: 'Changed EN' }, previewToken: manualFresh.previewToken }, options), /NAME_FIXTURE_AUDIT_FAILURE/);
      await db.query('DROP TRIGGER reject_name_fixture_audit ON audit_events; DROP FUNCTION reject_name_fixture_audit()');
      assert.deepEqual((await db.query('SELECT magento_name_override, (SELECT revision FROM product_full_export_state WHERE product_id=p.id) revision FROM products p WHERE id=$1', [manual.id])).rows[0], beforeFailure);
      const updatedNames = { all: ' Змінена точна назва ', en: ' Changed exact name ' };
      await nameService.save({ productId: manual.id, names: updatedNames, previewToken: manualFresh.previewToken }, options);
      assert.deepEqual((await nameService.read(manual.id, options)).names, updatedNames);
      const characteristicBefore = (await db.query('SELECT to_jsonb(v) data FROM product_characteristic_versions v JOIN products p ON p.characteristic_version_id=v.id WHERE p.id=$1', [manual.id])).rows[0];
      const recountInput = { sourceSku: manual.publicSku, answers: { type: 1 }, weight: 3, manualPriceUah: 110 };
      const recountPreview = await products.buildProductRecountPreview(recountInput, { magentoConfig: config });
      assert.deepEqual(recountPreview.corrected.exactNames, updatedNames);
      const recounted = await products.applyProductRecount({ ...recountInput, sourceStateSignature: recountPreview.source.stateSignature }, { ...options, magentoConfig: config });
      assert.equal(recounted.corrected.publicSku, manual.publicSku);
      assert.deepEqual((await nameService.read(recounted.correctedProductId, options)).names, updatedNames);
      assert.deepEqual((await db.query('SELECT to_jsonb(v) data FROM product_characteristic_versions v JOIN products p ON p.characteristic_version_id=v.id WHERE p.id=$1', [manual.id])).rows[0], characteristicBefore);
      const readiness = await require('../src/services/magento/product-names.service').read(legacyId, { ...options, readiness: true, allowUnavailable: true });
      assert.equal(readiness.readiness.ready, false); assert.equal(readiness.names, null);
      const resolution = require('../src/services/magento/name-resolution.service'); let remoteEn = ' Exact Magento EN '; let mismatch = false; let gets = 0; let changeInstallationAt = 0;
      const fetchImpl = async (url, request) => {
        assert.equal(request.method, 'GET'); gets++; const path = new URL(url).pathname;
        if (gets === changeInstallationAt) await db.query("UPDATE magento_auto_sync_activation SET installation_key='different-fixture' WHERE singleton");
        const response = path.endsWith('/store/storeViews') ? [{ id: 1, code: 'ua', is_active: true }, { id: 2, code: 'en', is_active: true }]
          : { id: mismatch && path.includes('/en/') ? 99 : 77, sku: 'AR1-000001', name: path.includes('/ua/') ? ' Точна назва Magento UA ' : path.includes('/en/') ? remoteEn : ' Точна основна назва Magento UA ' };
        return new Response(JSON.stringify(path.endsWith('/store/storeViews') ? response : { items: [response], total_count: 1 }), { headers: { 'content-type': 'application/json' } });
      };
      const command = { productId: legacyId, choice: 'magento', intent: 'complete' };
      const reviewed = await resolution.preview(command, { ...options, fetchImpl }); assert.equal(gets, 3);
      assert.deepEqual((await db.query('SELECT magento_name_override FROM products WHERE id=$1', [legacyId])).rows[0], { magento_name_override: null });
      remoteEn = 'Changed after preview';
      await assert.rejects(resolution.apply({ ...command, previewToken: reviewed.previewToken }, { ...options, fetchImpl }), { code: 'MAGENTO_NAME_PREVIEW_STALE' });
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_name_sync_states')).rows[0].n, 0);
      remoteEn = ' Exact Magento EN '; mismatch = true;
      await assert.rejects(resolution.preview(command, { ...options, fetchImpl }), { code: 'MAGENTO_NAME_IDENTITY_CHANGED' }); mismatch = false;
      const fresh = await resolution.preview(command, { ...options, fetchImpl });
      changeInstallationAt = gets + 6;
      await assert.rejects(resolution.apply({ ...command, previewToken: fresh.previewToken }, { ...options, fetchImpl }), { code: 'MAGENTO_NAME_PREVIEW_STALE' });
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_name_sync_states')).rows[0].n, 0);
      await db.query("UPDATE magento_auto_sync_activation SET installation_key='effective-names' WHERE singleton");
      changeInstallationAt = 0;
      await resolution.apply({ ...command, previewToken: fresh.previewToken }, { ...options, fetchImpl });
      const imported = await require('../src/services/magento/product-names.service').read(legacyId, options);
      assert.deepEqual(imported.names, { all: ' Точна основна назва Magento UA ', en: remoteEn });
      const importedState = (await db.query('SELECT magento_name_override, (SELECT revision FROM product_full_export_state WHERE product_id=p.id) revision FROM products p WHERE id=$1', [legacyId])).rows[0];
      const observedAmber = await require('../src/services/magento/sync-preview-db').readPreviewProduct(appPool, { productId: legacyId, bindingRevisionId: binding.id });
      const ordinary = await require('../src/services/magento/name-discovery').readNames(config, observedAmber, { fetchImpl });
      assert.equal(require('../src/services/magento/name-state').decisionFor(ordinary).action, 'confirm');
      await require('../src/services/magento/name-state').reconcileObservation(config, ordinary, { databasePool: appPool, actorUserId: actor });
      assert.deepEqual((await nameService.read(legacyId, options)).names, imported.names);
      assert.deepEqual((await db.query('SELECT magento_name_override, (SELECT revision FROM product_full_export_state WHERE product_id=p.id) revision FROM products p WHERE id=$1', [legacyId])).rows[0], importedState);
      const legacy = (await db.query('SELECT magento_name_subject_ua,magento_name_subject_en FROM products WHERE id=$1', [legacyId])).rows[0];
      assert.deepEqual(legacy, { magento_name_subject_ua: null, magento_name_subject_en: null });
      assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE event_key='product.magento_name_external_accepted'")).rows[0].n, 1);
      assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n, 0);
      assert.deepEqual((await db.query('SELECT * FROM export_template_versions WHERE id=$1', [old.id])).rows[0], oldRow);
      assert.equal(actualFetch, 0);
    } finally { global.fetch = oldFetch; }
  } finally {
    if (db) await db.end(); if (appPool) await appPool.end();
    if (created) await control.query(`DROP DATABASE ${name}`);
    await control.end();
  }
});
