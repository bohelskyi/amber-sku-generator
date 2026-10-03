const { test, assert, Pool, runNodeInDatabase, recreateTestDatabase, dropTestDatabase } = require('./suite-context');
const { insertProductFixture } = require('./product-fixture');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');
const editor = require('../src/services/magento/integration-editor.service');
const publication = require('../src/services/magento/binding-publication');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const { readPreviewProduct } = require('../src/services/magento/sync-preview-db');
const { buildCandidates } = require('../src/services/magento/binding-bootstrap');
const { indexTrees } = require('../src/services/magento/sync-preview-categories');
const { product } = require('../test/fixtures/magento-v1/contract');

test('SV saved current preview consumes exact successor pin and preserves keychain size optionality', async (t) => {
  const name = 'amber_sv_current_preview_test', url = await recreateTestDatabase(name), db = new Pool({ connectionString: url });
  try {
    await runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','SV preview admin') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const options = { databasePool: db, mutationContext: { actorUserId: actor } };
    const f = require('../test/fixtures/magento-successor').fixture();
    for (const g of f.next.groups) await db.query('INSERT INTO categories(code,name) VALUES($1,$1)', [g.route]);
    for (const [id, s] of Object.entries(f.next.sources)) {
      if (s.kind === 'product') continue;
      const q = (await db.query(`INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required,sku_index)
        VALUES($1,$2,$2,$3,$4,0,1) RETURNING id`, [s.category, s.key, s.kind === 'semantic' ? 'options' : 'text', id === 'SV.souvenir' ? 1 : 0])).rows[0];
      const values = [...new Set(Object.values(f.next.questionContracts).filter(q => q.source === id).flatMap(q => q.allowed))];
      for (const value of values) await db.query('INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,$2,$3,$3)', [q.id, value, value]);
    }
    await runNodeInDatabase(url, "require('./src/services/sku-schema.service').ensureLegacySkuSchemas().finally(()=>require('./src/db/pool').end());");
    const historicalSchema = (await db.query("SELECT id FROM sku_schema_versions WHERE category_code='SV' AND status='active'")).rows[0].id;
    let schema = f.schema;
    schema.storeTopology.websites[0].code = 'base';
    schema.attributes.find(a => a.attribute_code === 'name').scope = 'store';
    schema.attributeSets.find(s => s.attribute_set_name === 'Сувеніри').attribute_set_id = 151;
    schema = require('../src/services/magento/binding-contract').normalizeSchema(schema);
    const tree = { id: 703, name: 'Default', parent_id: 0, children_data: [
      { id: 705, name: 'Сувеніри', parent_id: 703, children_data: [
        { id: 706, name: 'Брелоки', parent_id: 705, children_data: [] },
      ] },
    ] };
    const config = { configured: true, baseUrl: 'https://sv-current.invalid', consumerKey: 'fixture-key',
      consumerSecret: 'fixture-secret', accessToken: 'fixture-token', accessTokenSecret: 'fixture-token-secret' };
    async function draft(definition, key) {
      const family = await templates.createTemplate({ key, displayName: key, definition }, options);
      const v = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
      let b = await bindings.createDraft({ installationKey: 'sv-current', origin: config.baseUrl, templateVersionId: v.id,
        observedAt: new Date().toISOString(), schema }, options);
      const candidate = buildCandidates({ compiled: compileDefinition(definition), products: [product('SV', {}, { public_sku: 'SV-SAMPLE' })], current: [] },
        schema, indexTrees([tree]), { routeKey: 'SV.souvenir!=value_id:5' });
      for (const r of candidate.routes) if (r.enabled) r.reviewState = 'approved';
      for (const a of candidate.attributes) { a.reviewState = 'approved'; for (const c of a.evidence.categories || []) c.reviewState = 'approved'; }
      for (const o of candidate.options) o.reviewState = o.optionId ? 'approved' : 'blocked';
      for (const p of candidate.policies) {
        const a = candidate.attributes.find(a => a.bindingKey === p.bindingKey);
        p.reviewState = 'approved'; p.policy = a.rowId === 'english' && a.target !== 'name' ? 'magento_managed'
          : ['qty', 'is_in_stock', 'product_online', 'visibility'].includes(a.target) ? 'initialize_create_only' : 'authoritative_create_update';
        if (a.target === 'product_online') p.evidence.createValue = 2;
      }
      b = await bindings.updateDraft(b.id, { expectedRevision: b.revision, bindings: candidate }, options);
      return { binding: b, version: v };
    }
    const old = await draft(f.old, 'sv-current-old');
    const current = await bindings.publishDraft(old.binding.id, { expectedRevision: old.binding.revision, expectedCurrentId: null }, options);
    const next = await draft(f.next, 'sv-current-next');
    const answers = { color: 1, weight: '16.2', material: 1, souvenir: 6 };
    const p = (await insertProductFixture(db, `INSERT INTO products(full_sku,category,weight,total_price_uah,details,sku_schema_version_id)
      VALUES('SV116007','SV',16.2,42,$1::jsonb,$2) RETURNING *`, [JSON.stringify({ answers }), historicalSchema])).rows[0];
    await db.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1", [p.id]);
    await db.query("UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='sv-current',actor_user_id=$1 WHERE singleton", [actor]);
    await db.query("UPDATE questions SET label='Changed live label' WHERE category_code='SV' AND key='souvenir'");
    await runNodeInDatabase(url, "require('./src/services/sku-schema.service').publishSkuSchema('SV',{mutationContext:{actorUserId:" + actor + "}}).finally(()=>require('./src/db/pool').end());");
    assert.equal((await db.query('SELECT status FROM sku_schema_versions WHERE id=$1', [historicalSchema])).rows[0].status, 'archived');
    const amber = await readPreviewProduct(db, { productId: p.id, bindingRevisionId: next.binding.id });
    assert.equal(amber.template.versionId, next.version.id);
    assert.equal(amber.compiled.hash, next.binding.definitionHash);
    assert.deepEqual(amber.compiled.definition.bindings.find(b => b.id === 'SV.rozmir_suveniriv'), f.next.bindings.find(b => b.id === 'SV.rozmir_suveniriv'));
    assert.equal(amber.product.sku_schema_version_id, historicalSchema);
    assert.deepEqual(amber.product.details.answers, answers);
    const direct = evaluateProduct(amber.compiled, amber.product);
    assert.deepEqual(direct.errors, []); assert.equal(direct.base.rozmir_suveniriv, '');
    const names = { all: direct.base.name, en: direct.english.name };
    await db.query(`INSERT INTO magento_name_sync_states(origin_hash,public_product_identity_id,remote_product_id,baseline_names,observed_amber_names,observed_remote_names,state)
      VALUES($1,$2,1919,$3::jsonb,$3::jsonb,$3::jsonb,'common')`, [current.originHash, p.public_product_identity_id, JSON.stringify(names)]);
    const raw = { id: 1919, sku: p.full_sku, attribute_set_id: 151, type_id: 'simple', status: 1, visibility: 4, price: 42,
      name: names.all, custom_attributes: [], extension_attributes: { category_links: [], website_ids: [701] } };
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'GET'); const u = new URL(url); assert.equal(u.hostname, 'sv-current.invalid');
      const path = u.pathname.split('/V1/')[1]; let data;
      const items = list => ({ items: list, total_count: list.length });
      if (path === 'store/websites') data = schema.storeTopology.websites;
      else if (path === 'store/storeGroups') data = schema.storeTopology.storeGroups;
      else if (path === 'store/storeViews') data = schema.storeTopology.storeViews;
      else if (path === 'products/attribute-sets/sets/list') data = items(schema.attributeSets);
      else if (path === 'products/attributes') data = items(schema.attributes);
      else if (/^products\/attribute-sets\/\d+\/attributes$/.test(path)) data = schema.attributes;
      else if (/^products\/attributes\/\w+\/options$/.test(path)) data = schema.attributes.find(a => a.attribute_code === path.split('/')[2]).options;
      else if (path === 'categories') data = tree;
      else if (path === 'products') data = items([{ ...raw, name: u.pathname.includes('/rest/en/') ? names.en : names.all }]);
      else if (path === 'inventory/stock-resolver/website/base') data = { stock_id: 1, extension_attributes: { sales_channels: [{ type: 'website', code: 'base' }] } };
      else if (path === 'inventory/get-sources-assigned-to-stock-ordered-by-priority/1') data = [{ source_code: 'default', enabled: true }];
      else if (path === 'inventory/source-items') data = items([{ sku: p.full_sku, source_code: 'default', quantity: 1, status: 1 }]);
      else assert.fail('Unexpected synthetic GET: ' + path);
      return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    };
    const consumed = [];
    const observedPool = { query: (...args) => db.query(...args), connect: async () => {
      const client = await db.connect(); return { release: () => client.release(), query: async (...args) => {
        const result = await client.query(...args);
        if (typeof args[0] === 'string' && args[0].includes('FROM export_template_versions')) consumed.push(...result.rows);
        return result;
      } };
    } };
    const remote = { ...options, databasePool: observedPool, fetchImpl };
    const historical = await editor.currentPreview(config, { productId: p.id, bindingRevisionId: current.id }, remote);
    assert.ok(historical.blockers.some(b => b.code === 'PRODUCT_EVALUATION_NOT_READY' && b.issueFields.includes('rozmir_suveniriv')));
    consumed.length = 0;
    const preview = await editor.currentPreview(config, { productId: p.id, bindingRevisionId: next.binding.id }, remote);
    assert.ok(consumed.length); assert.ok(consumed.every(v => v.id === next.version.id && v.definition_hash === amber.compiled.hash));
    assert.deepEqual(consumed[0].definition.bindings.find(b => b.id === 'SV.rozmir_suveniriv'), f.next.bindings.find(b => b.id === 'SV.rozmir_suveniriv'));
    t.diagnostic(JSON.stringify({ direct: direct.errors, current: preview.blockers, templateVersionId: next.version.id, hash: amber.compiled.hash }));
    assert.equal(preview.mode, 'update'); assert.equal(preview.attributeSet.id, 151);
    assert.equal(preview.sendable, true, JSON.stringify(preview.blockers));
    assert.equal(next.binding.bindings.policies.find(p => p.bindingKey === next.binding.bindings.attributes
      .find(a => a.target === 'rozmir_suveniriv').bindingKey).policy, 'authoritative_create_update');
    const publicationInput = { bindingRevisionId: next.binding.id, expectedRevision: next.binding.revision, expectedCurrentId: current.id };
    const publicationOptions = { ...remote, discover: async () => ({ schema, categories: indexTrees([tree]) }) };
    const proof = await publication.preview(config, publicationInput, publicationOptions);
    assert.ok(proof.affected.some(v => v.productId === p.id));
    assert.deepEqual(proof.blockers, [], JSON.stringify(proof));
    const saved = (await db.query('SELECT details,weight,total_price_uah,sku_schema_version_id FROM products WHERE id=$1', [p.id])).rows[0];
    assert.deepEqual(saved.details.answers, answers);
    assert.equal(Object.hasOwn(saved.details.answers, 'size'), false);
    assert.equal(saved.weight, p.weight); assert.equal(saved.total_price_uah, p.total_price_uah);
    assert.equal(saved.sku_schema_version_id, historicalSchema);
    assert.equal((await bindings.getCurrentPublished('sv-current', options)).id, current.id);
    assert.deepEqual(await bindings.getRevision(current.id, options), current);
    assert.deepEqual(await bindings.getRevision(next.binding.id, options), next.binding);
    await db.query("UPDATE products SET details=jsonb_set(details,'{answers,souvenir}','7'),magento_name_subject_ua='Лампа',magento_name_subject_en='lamp' WHERE id=$1", [p.id]);
    const required = await editor.currentPreview(config, { productId: p.id, bindingRevisionId: next.binding.id }, remote);
    assert.ok(required.blockers.some(b => b.code === 'PRODUCT_EVALUATION_NOT_READY' && b.issueFields.includes('rozmir_suveniriv')));
    const blocked = await publication.preview(config, { ...publicationInput, currentProductIds: [p.id] }, publicationOptions);
    const checked = blocked.checked.find(v => v.kind === 'current' && v.productId === p.id);
    assert.equal(checked.sendable, false);
    assert.ok(checked.blockers.some(b => b.code === 'PRODUCT_EVALUATION_NOT_READY' && b.issueFields.includes('rozmir_suveniriv')));
    assert.ok(!blocked.affected.some(v => v.productId === p.id), 'unready non-keychain never enters publication delivery handoff');
  } finally { await db.end(); await dropTestDatabase(name); }
});
