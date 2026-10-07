const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Client, Pool } = require('pg');

test('archived name-baseline review preserves exact Magento names before a separate ordinary historical restore', async t => {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = `amber_archived_names_${process.pid}_${randomBytes(6).toString('hex')}_test`;
  const expected = [...new Set(['amber_test', 'postgres', 'template0', 'template1', source.pathname.slice(1)])].sort();
  const control = new Client({ connectionString: source.toString() }); await control.connect();
  let db, appPool, created = false;
  try {
    assert.deepEqual((await control.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r => r.datname), expected);
    assert.equal((await control.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0);
    await control.query(`CREATE DATABASE ${name}`); created = true;
    const url = new URL(source); url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString(); process.env.MAGENTO_BASE_URL = ''; process.env.NBU_RATE_OVERRIDE = '40';
    require('../test/setup-env'); appPool = require('../src/db/pool'); db = new Pool({ connectionString: url.toString(), max: 8 });
    await require('../src/db/run-migrations').runMigrations();
    const c = require('../src/services/magento/binding-contract');
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Archived names fixture') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    for (const category of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) await db.query('INSERT INTO categories(code,name,requires_weight) VALUES($1,$1,0)', [category]);
    const { insertProductFixture, insertNativeProductFixture } = require('./product-fixture');
    const product = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,total_price_uah,weight,status,exclude_from_export,details)
      VALUES('AR1-1-000007','AR',240,12.7,'archived',1,'{"answers":{"weight":12.7},"logMessage":"unknown prior archive"}') RETURNING *`)).rows[0];
    const config = { configured: true, baseUrl: 'https://archived-names.invalid', consumerKey: 'archived-names-consumer-unique', consumerSecret: 'archived-names-secret-unique', accessToken: 'archived-names-access-unique', accessTokenSecret: 'archived-names-access-secret-unique' };
    const options = { databasePool: db, config, reviewSecret: 'synthetic-archived-name-review-secret', actorUserId: actor, mutationContext: { actorUserId: actor, requestId: 'archived-names-fixture' } };
    const fixture = require('../test/fixtures/magento-bindings'); const definition = structuredClone(fixture.definition());
    definition.sources = { sku: definition.sources.sku, price: { kind: 'product', field: 'total_price_uah', type: 'scalar' } }; definition.tables = {};
    for (const group of definition.groups) for (const row of group.rows) {
      row.cells = Object.fromEntries(Object.entries(row.cells).filter(([key]) => ['sku', 'store_view_code', 'name', 'attribute_set_code', 'product_type', 'price'].includes(key)));
      row.cells.name = { op: 'literal', value: row.id === 'base' ? 'Ікона з бурштину. Арт: AR1-1-000007' : 'Amber icon. Item: AR1-1-000007' };
      row.cells.price = row.id === 'base' ? { op: 'text', input: { op: 'source', id: 'price' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' } : { op: 'literal', value: '' };
      row.cells.product_online = { op: 'literal', value: row.id === 'base' ? '2' : '' };
      row.cells.visibility = { op: 'literal', value: row.id === 'base' ? 'Catalog, Search' : '' };
    }
    const templates = require('../src/services/export-templates/template.service');
    const family = await templates.createTemplate({ key: 'archived-names-fixture', displayName: 'Archived names fixture', definition }, options);
    const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    const bindings = require('../src/services/magento/binding.service'), schema = fixture.schema(); schema.attributes.find(a => a.attribute_code === 'name').scope = 'store';
    let draft = await bindings.createDraft({ installationKey: 'archived-names', origin: config.baseUrl, templateVersionId: version.id, observedAt: new Date().toISOString(), schema }, options);
    const decisions = fixture.approvedBindings(definition, schema, 'AR');
    const native = { attribute_set_code: 'attribute_set_id', product_type: 'type_id', store_view_code: 'store_view_code', product_online: 'status', visibility: 'visibility' };
    decisions.attributes.forEach(a => { if (a.strategy === 'transport_control') a.transportTarget = `product.${native[a.target]}`; });
    const bindingKey = require('../src/services/magento/binding-validation').bindingKey;
    decisions.policies.forEach(p => {
      const a = decisions.attributes.find(a => bindingKey(a.routeKey, a.rowId, a.target) === p.bindingKey);
      p.policy = p.storeCode === 'en' && a.target !== 'name' ? 'magento_managed' : 'authoritative_create_update';
      if (a.target === 'product_online') { p.policy = 'initialize_create_only'; p.evidence = { createValue: 2 }; }
      if (a.target === 'visibility') p.policy = 'initialize_create_only';
    });
    draft = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: decisions }, options);
    const published = await bindings.publishDraft(draft.id, { expectedRevision: draft.revision, expectedCurrentId: null }, options);
    const client = await db.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL amber.lifecycle_maintenance='on'"); await client.query("SET LOCAL amber.magento_delivery_cutover='on'");
      const event = (await client.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id,request_id)
        VALUES('product.fixture',$1,'{"displayName":"Archived names fixture","preferredUsername":null}','fixture','archived-names','fixture') RETURNING id`, [actor])).rows[0].id;
      await client.query("SET LOCAL amber.public_sku_activation='on'");
      await client.query(`UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2 WHERE singleton`, [actor,event]);
      await client.query(`UPDATE full_product_export_activation SET phase='preparing',generation=generation+1,manifest_hash=$1,approval_event_id=$2 WHERE singleton`, [c.hash('archived-names'), event]);
      await client.query(`UPDATE full_product_export_activation SET phase='active',selector_version=1,generation=generation+1,activation_event_id=$1 WHERE singleton`, [event]);
      await client.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='archived-names',actor_user_id=$1,legacy_product_csv_enabled=FALSE,
        cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2 WHERE singleton`, [actor, event]);
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    await db.query("INSERT INTO magento_product_sync_requests(public_product_identity_id,product_id,state,reason_code) VALUES($1,$2,'needs_attention','product_retired')", [product.public_product_identity_id, product.id]);
    const names = { all: 'Ікона Божої Матері «Остробрамська» з бурштину. Арт: AR1-1-000007', en: 'Amber icon of Our Lady of the Dawn Gate. Item: AR1-1-000007' };
    let remoteId = 5817, remoteEn = names.en, wrongEnglishId = false, onGet = null; const requests = [];
    const fetchImpl = async (url, init = {}) => {
      assert.equal(init.method || 'GET', 'GET', 'Name review and historical preview never write Magento');
      const parsed = new URL(url); assert.equal(parsed.origin, config.baseUrl); requests.push(parsed.pathname);
      if (onGet) await onGet(parsed);
      let value;
      if (parsed.pathname.endsWith('/store/storeViews')) value = [{ id: 804, code: 'en', is_active: 1 }];
      else if (parsed.pathname.endsWith('/categories')) value = { id: 803, parent_id: 1, name: 'Default', children_data: [] };
      else {
        assert.ok(parsed.pathname.endsWith('/products'));
        const sku = [...parsed.searchParams].find(([key]) => key.includes('[value]'))?.[1]; assert.equal(sku, 'AR1-1-000007');
        value = { items: [{ id: wrongEnglishId && parsed.pathname.includes('/en/') ? remoteId + 1 : remoteId, sku, attribute_set_id: 8001,
          name: parsed.pathname.includes('/en/') ? remoteEn : names.all, price: 240, status: 1, visibility: 4, type_id: 'simple',
          custom_attributes: [], extension_attributes: { category_links: [], website_ids: [801] } }], total_count: 1 };
      }
      return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    };
    options.fetchImpl = fetchImpl; options.discover = async () => schema;
    const historical = require('../src/services/historical-standard-reactivation.service'), resolution = require('../src/services/magento/name-resolution.service');
    const authorized = operation => require('../src/services/access-admin-transaction').runAccessAdminMutation({ databasePool: db, actorUserId: actor, requiredPermission: 'products.archive', createError: c.error, operation });
    const mutate = (sql, values) => authorized(client => client.query(sql, values));
    const command = { productId: Number(product.id), article: 'AR1-1-000007', remoteProductId: 5817, bindingRevisionId: published.id, choice: 'magento', intent: 'historical' };
    const apply = (review, overrides = {}) => resolution.apply({ ...command, previewToken: review.previewToken, reviewExpiresAt: review.reviewExpiresAt }, { ...options, ...overrides });
    const snapshot = async () => (await db.query(`SELECT
      (SELECT to_jsonb(p) FROM products p WHERE id=$1) product,
      (SELECT to_jsonb(f) FROM product_full_export_state f WHERE product_id=$1) lifecycle,
      (SELECT to_jsonb(r) FROM magento_product_sync_requests r WHERE product_id=$1) request,
      (SELECT jsonb_agg(j) FROM magento_sync_jobs j) jobs,
      (SELECT jsonb_agg(n) FROM magento_name_sync_states n) names,
      (SELECT count(*)::int FROM historical_standard_intents) intents,
      (SELECT count(*)::int FROM audit_events) audits`, [product.id])).rows[0];
    await t.test('complete but different names are the sole delivery blocker under the old published template', async () => {
      const review = await historical.preview({ skus: [command.article] }, options);
      assert.equal(review.items[0].disposition, 'blocked'); assert.deepEqual(review.items[0].deliveryBlockerCodes, ['NAME_BASELINE_REQUIRED']);
      assert.equal(review.items[0].remoteProductId, 5817); assert.equal(review.items[0].deliveryMode, 'update');
      assert.deepEqual(review.items[0].prerequisites.filter(p => !p.met).map(p => p.code), ['CURRENT_DELIVERY_PLAN_VALID']);
      assert.equal(definition.nameReadiness, undefined);
    });
    await t.test('historical preview reads exact UA/EN without any local mutation and default name editing still rejects archived', async () => {
      const before = await snapshot(), count = requests.length;
      const review = await resolution.preview(command, options);
      assert.deepEqual(review.magento, names); assert.equal(review.remoteProductId, 5817); assert.equal(review.bindingRevisionId, published.id);
      assert.equal(review.alreadyAccepted, false); assert.equal(requests.length - count, 3); assert.deepEqual(await snapshot(), before);
      await assert.rejects(resolution.preview({ productId: command.productId, choice: 'magento' }, options), { code: 'MAGENTO_NAME_PRODUCT_RETIRED' });
      await assert.rejects(require('../src/services/magento/product-names.service').read(command.productId, options), { code: 'PRODUCT_NAMES_RETIRED' });
    });
    await t.test('authority, exact article, published binding, remote entity and English identity remain guarded', async () => {
      const before = await snapshot();
      await assert.rejects(resolution.preview(command, { ...options, actorUserId: 99999999, mutationContext: { actorUserId: 99999999 } }), { code: 'ADMIN_PERMISSION_REVOKED' });
      await assert.rejects(resolution.preview({ ...command, choice: 'amber' }, options), { code: 'MAGENTO_NAME_SELECTION_INVALID' });
      await assert.rejects(resolution.preview({ ...command, article: 'OTHER' }, options), { code: 'MAGENTO_NAME_HISTORICAL_CONTEXT_CHANGED' });
      await assert.rejects(resolution.preview({ ...command, bindingRevisionId: randomUUID() }, options), { code: 'MAGENTO_NAME_HISTORICAL_CONTEXT_CHANGED' });
      remoteId++; await assert.rejects(resolution.preview(command, options), { code: 'MAGENTO_NAME_IDENTITY_CHANGED' }); remoteId--;
      wrongEnglishId = true; await assert.rejects(resolution.preview(command, options), { code: 'MAGENTO_NAME_IDENTITY_CHANGED' }); wrongEnglishId = false;
      assert.deepEqual(await snapshot(), before);
    });
    await t.test('changed remote names, expired review and another actor cannot save the baseline', async () => {
      const review = await resolution.preview(command, options), before = await snapshot();
      remoteEn = 'Changed remote EN'; await assert.rejects(apply(review), { code: 'MAGENTO_NAME_PREVIEW_STALE' }); remoteEn = names.en;
      await assert.rejects(apply(review, { now: () => Date.parse(review.reviewExpiresAt) + 1 }), { code: 'MAGENTO_NAME_PREVIEW_STALE' });
      const other = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Other administrator') RETURNING id")).rows[0].id);
      await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [other]);
      await assert.rejects(apply(review, { actorUserId: other, mutationContext: { actorUserId: other } }), { code: 'MAGENTO_NAME_PREVIEW_STALE' });
      assert.deepEqual(await snapshot(), before);
    });
    await t.test('an independent connection changing the product after final remote read invalidates apply atomically', async () => {
      const review = await resolution.preview(command, options); let reads = 0;
      onGet = async () => { if (++reads === 6) await mutate('UPDATE products SET correction_reason=$2 WHERE id=$1', [product.id, 'Independent change during name review']); };
      await assert.rejects(apply(review), { code: 'MAGENTO_NAME_PREVIEW_STALE' }); onGet = null;
      const after = await snapshot(); assert.equal(after.product.magento_name_override, null); assert.equal(after.names, null); assert.equal(after.intents, 0); assert.equal(after.jobs, null);
    });
    await t.test('audit failure rolls back names, baseline and request generation without changing retired lifecycle', async () => {
      const review = await resolution.preview(command, options), before = await snapshot();
      await db.query(`CREATE FUNCTION reject_archived_names_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_key='product.magento_name_external_accepted' THEN RAISE EXCEPTION 'ARCHIVED_NAMES_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_archived_names_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_archived_names_audit()`);
      await assert.rejects(apply(review), /ARCHIVED_NAMES_AUDIT_FAILURE/);
      await db.query('DROP TRIGGER reject_archived_names_audit ON audit_events; DROP FUNCTION reject_archived_names_audit()');
      assert.deepEqual(await snapshot(), before);
    });
    await t.test('explicit acceptance preserves full names, archive, lifecycle, jobs and binding; fresh restore preview becomes eligible', async () => {
      const review = await resolution.preview(command, options), before = await snapshot(), saved = await apply(review);
      assert.equal(saved.state, 'archived'); assert.equal(saved.baselineSaved, true);
      const after = await snapshot();
      const { magento_name_override, magento_name_review_required, ...rest } = after.product;
      assert.deepEqual(rest, Object.fromEntries(Object.entries(before.product).filter(([key]) => !['magento_name_override', 'magento_name_review_required'].includes(key))));
      assert.deepEqual(magento_name_override.values, names); assert.equal(magento_name_review_required, false);
      assert.deepEqual(after.lifecycle, before.lifecycle); assert.equal(after.product.status, 'archived'); assert.equal(after.lifecycle.route, 'retired');
      assert.equal(after.request.state, 'needs_attention'); assert.equal(after.request.reason_code, 'product_retired'); assert.equal(after.jobs, null); assert.equal(after.intents, 0);
      assert.deepEqual(after.names[0].baseline_names, names); assert.equal(after.names[0].state, 'common'); assert.equal(Number(after.names[0].remote_product_id), 5817);
      assert.equal((await db.query("SELECT id FROM magento_binding_revisions WHERE state='published'")).rows[0].id, published.id);
      await assert.rejects(apply(review), { code: 'MAGENTO_NAME_PREVIEW_STALE' });
      assert.equal((await resolution.preview(command, options)).alreadyAccepted, true, 'A lost local apply reply is recovered by another read, never an automatic repeat save');
      const restoredReview = await historical.preview({ skus: [command.article] }, options);
      assert.equal(restoredReview.items[0].disposition, 'eligible'); assert.deepEqual(restoredReview.items[0].deliveryBlockerCodes, []);
      assert.equal(restoredReview.items[0].currentName, names.all); assert.equal(restoredReview.items[0].targetStatus, 1); assert.equal(restoredReview.items[0].targetVisibility, 4);
      assert.equal((await snapshot()).product.status, 'archived'); assert.equal((await snapshot()).intents, 0);
    });
    await t.test('reconciliation-required request and a newer local version never become an archived-name repair bypass', async () => {
      await db.query("UPDATE magento_product_sync_requests SET state='needs_attention',reason_code='reconciliation_required' WHERE product_id=$1", [product.id]);
      await assert.rejects(resolution.preview(command, options), { code: 'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED' });
      assert.equal((await snapshot()).request.reason_code, 'reconciliation_required');
      await db.query("UPDATE magento_product_sync_requests SET reason_code='product_retired' WHERE product_id=$1", [product.id]);
      const successor = (await authorized(client => insertNativeProductFixture(client, { category: 'AR', totalPriceUah: 240, weight: 12.7, correctedFromProductId: product.id }))).rows[0];
      assert.equal(successor.public_product_identity_id, product.public_product_identity_id, 'A legitimate recount successor inherits the server identity');
      await assert.rejects(resolution.preview(command, options), { code: 'HISTORICAL_LINEAGE_BLOCKED' });
      assert.equal((await snapshot()).product.status, 'archived'); assert.equal((await snapshot()).intents, 0);
    });
  } finally {
    await db?.end(); await appPool?.end();
    if (created) await control.query(`DROP DATABASE ${name}`);
    assert.deepEqual((await control.query('SELECT datname FROM pg_database ORDER BY datname')).rows.map(r => r.datname), expected);
    await control.end();
  }
});
