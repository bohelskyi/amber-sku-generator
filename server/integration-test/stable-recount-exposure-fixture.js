// Synthetic local Magento fixture; no real transport.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { insertProductFixture } = require('./product-fixture');
const bindings = require('../src/services/magento/binding.service');
const templates = require('../src/services/export-templates/template.service');
const fixture = require('../test/fixtures/magento-bindings');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { previewProduct } = require('../src/services/magento/sync-preview');
const { enqueue, applyJob } = require('../src/services/magento/sync-job.service');
const { parseMagentoConfig } = require('../src/config/magento');
const config = parseMagentoConfig({ MAGENTO_BASE_URL: 'https://sync.example.invalid', MAGENTO_CONSUMER_KEY: 'fake-key',
  MAGENTO_CONSUMER_SECRET: 'fake-secret', MAGENTO_ACCESS_TOKEN: 'fake-access', MAGENTO_ACCESS_TOKEN_SECRET: 'fake-access-secret' });
const literal = (value) => ({ op: 'literal', value });


module.exports = async function setup(pool, actorUserId, { group = 'BR' } = {}) {
  const mutations = { databasePool: pool, mutationContext: { actorUserId, requestId: 'sync-fixture' } };
  for (const group of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) await pool.query('INSERT INTO categories(code,name) VALUES($1,$1) ON CONFLICT(code) DO NOTHING', [group]);
  const d = structuredClone(fixture.definition()); d.sources = { sku: d.sources.sku,
    price: { kind: 'product', field: 'total_price_uah', type: 'scalar' } }; d.tables = {}; d.evaluatorVersion = 'magento-declarative-3'; d.sourceSupport = {version:'historical-source-support-v1',sources:{}}; d.sources.sku.field = 'public_sku';
  d.sourceContractVersion = 'public-product-identity-v1';
  for (const g of d.groups) for (const row of g.rows) {
    const sku = row.cells.sku;
    row.cells = { sku, name: literal(row.id === 'base' ? 'Amber name' : 'English name'),
      attribute_set_code: literal('Historical CSV name'), product_type: literal('simple'), store_view_code: literal(row.id === 'base' ? '' : 'en') };
    if (row.id === 'base') Object.assign(row.cells, { price: { op: 'text', input: { op: 'source', id: 'price' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' }, product_online: literal('2'), visibility: literal('Catalog, Search'),
      categories: literal('Default/Fixture'), qty: literal('1'), is_in_stock: literal('1'), product_websites: literal('fixture') });
    else row.cells.meta_title = literal('English SEO');
  }
  const definition = compileDefinition(d).definition; const schema = structuredClone(fixture.schema());
  schema.attributeSets[0].attribute_set_name = 'Historical CSV name';
  for (const a of schema.attributes) { a.apply_to = []; if (a.attribute_code === 'name') a.scope = 'store'; }
  schema.attributes.push({ attribute_code: 'meta_title', attribute_id: 1101, scope: 'store', frontend_input: 'text', options: [], apply_to: [] });
  schema.attributeSets[0].attributeCodes.push('meta_title');
  const family = await templates.createTemplate({ key: `sync-${crypto.randomUUID()}`, displayName: 'Synthetic sync', definition }, mutations);
  const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, mutations);
  const installationKey = `sync-${crypto.randomUUID()}`;
  const makeDraft = async () => {
    let draft = await bindings.createDraft({ installationKey, origin: config.baseUrl, templateVersionId: version.id,
      observedAt: new Date().toISOString(), schema }, mutations);
    const b = fixture.approvedBindings(definition, schema, group);
    const native = { attribute_set_code: 'attribute_set_id', product_type: 'type_id', product_online: 'status', visibility: 'visibility',
      categories: 'extension_attributes.category_links', product_websites: 'extension_attributes.website_ids', qty: 'inventory.qty', is_in_stock: 'inventory.is_in_stock', store_view_code: 'store_view_code' };
    for (const a of b.attributes) {
      if (a.strategy === 'transport_control') a.transportTarget = `product.${native[a.target]}`;
      if (a.target === 'categories') a.evidence = { categories: [{ requestedPath: 'Default/Fixture', normalizedPath: 'Default/Fixture',
        categoryId: '9001', candidates: [{ categoryId: '9001', path: 'Default/Fixture' }], reviewState: 'approved' }] };
      const p = b.policies.find((p) => p.bindingKey === require('../src/services/magento/binding-validation').bindingKey(a.routeKey, a.rowId, a.target));
      p.policy = ['qty', 'is_in_stock', 'product_online'].includes(a.target) ? 'initialize_create_only'
        : a.rowId === 'english' && ['sku', 'attribute_set_code', 'product_type', 'store_view_code'].includes(a.target) ? 'magento_managed' : 'authoritative_create_update';
      if (a.target === 'product_online') p.evidence = { createValue: 2 };
    }
    draft = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: b }, mutations);
    return draft;
  };
  const draft = await makeDraft();
  const published = await bindings.publishDraft(draft.id, { expectedRevision: draft.revision, expectedCurrentId: null }, mutations);

  async function scenario({ create = false, initialLinks = [], sku = 'SV5111010', category = 'BR' } = {}) {
    const product = (await insertProductFixture(pool, `INSERT INTO products
      (full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details)
      VALUES ($1,$1,0,$2,5,10,42,2,40,'{"answers":{}}') RETURNING id,public_product_identity_id`, [sku,category])).rows[0];
    await pool.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1", [product.id]);
    const initial = { id: product.id + 100000, sku, attribute_set_id: 8001, name: 'Old name', type_id: 'simple', price: 40,
      status: 1, visibility: 4, custom_attributes: [{ attribute_code: 'unknown_attribute', value: 'Keep me' }], media_gallery_entries: [{ id: 100 }],
      extension_attributes: { category_links: initialLinks, website_ids: [999] } };
    let remote = create ? null : structuredClone(initial);
    let english = create ? null : { ...structuredClone(initial), name: 'Old English', custom_attributes: [{ attribute_code: 'meta_title', value: 'Old SEO' }] };
    let sourceItems = create ? [] : [{ sku, source_code: 'default', quantity: 0, status: 0 }];
    if (!create) await require('../src/services/magento/name-state').saveObservation(pool,
      require('../src/services/magento/binding-contract').originHash(config.baseUrl), product, initial.id,
      { action: 'confirm', amber: { all: 'Old name', en: 'Old English' }, remote: { all: 'Old name', en: 'Old English' } },
      { all: 'Old name', en: 'Old English' });
    const writes = []; const hooks = {};
    const response = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init) => {
      const u = new URL(url); const route = u.pathname.split('/V1/')[1];
      if (init.method === 'GET') {
        if (hooks.readFailure) throw new Error('synthetic GET failure');
        if (route === 'products') {
          assert.equal(u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'), sku);
          const p = u.pathname.includes('/en/') ? english : remote;
          return response({ total_count: p ? 1 : 0, items: p ? [p] : [] });
        }
        if (route === 'categories') return response({ id: 803, name: 'Default', parent_id: 1,
          children_data: [{ id: 9001, parent_id: 803, name: 'Fixture', children_data: [] }] });
        if (route === 'inventory/stock-resolver/website/base') return response({ stock_id: 1,
          extension_attributes: { sales_channels: [{ type: 'website', code: 'base' }] } });
        if (route === 'inventory/get-sources-assigned-to-stock-ordered-by-priority/1') return response([{ source_code: 'default', enabled: true }]);
        if (route === 'inventory/source-items') return response({ items: sourceItems, total_count: sourceItems.length });
        throw new Error(`Unexpected route ${route}`);
      }
      assert.ok(['POST', 'DELETE'].includes(init.method)); assert.equal(init.redirect, 'manual');
      const body = init.body ? JSON.parse(init.body) : null;
      writes.push({ route, method: init.method, scope: u.pathname.split('/')[2], body });
      if (hooks.beforeWrite) await hooks.beforeWrite(writes.at(-1));
      if (hooks.noMutation) return response(true);
      if (hooks.noCategoryMutation && route.startsWith('categories/')) return response(true);
      if (route.startsWith('categories/')) {
        const categoryId = route.split('/')[1];
        if (init.method === 'DELETE') remote.extension_attributes.category_links = remote.extension_attributes.category_links
          .filter((link) => link.category_id !== categoryId);
        else {
          assert.equal(body.productLink.category_id, categoryId);
          remote.extension_attributes.category_links = remote.extension_attributes.category_links
            .filter((link) => link.category_id !== categoryId);
          remote.extension_attributes.category_links.push({ category_id: categoryId, position: body.productLink.position });
        }
      } else if (route === 'inventory/source-items') sourceItems = body.sourceItems;
      else if (route.endsWith('/websites')) remote.extension_attributes.website_ids.push(body.productWebsiteLink.website_id);
      else {
        assert.equal(route, 'products'); const p = body.product;
        if (!remote) { remote = { ...initial, status: 2, custom_attributes: [], extension_attributes: { category_links: [], website_ids: [] } };
          english = structuredClone(remote); sourceItems = [{ sku, source_code: 'default', quantity: 0, status: 0 }]; }
        const target = u.pathname.includes('/en/') ? english : remote;
        for (const [key, value] of Object.entries(p)) {
          if (key === 'custom_attributes') { for (const a of value) {
            const old = target.custom_attributes.find((v) => v.attribute_code === a.attribute_code);
            if (old) old.value = a.value; else target.custom_attributes.push(a);
          } } else if (key === 'extension_attributes') Object.assign(target.extension_attributes, value);
          else target[key] = value;
        }
      }
      if (hooks.afterWrite) await hooks.afterWrite(writes.at(-1));
      return response(true);
    };
    const options = { databasePool: pool, actorUserId, apply: true, fetchImpl,
      preview: (cfg, opts) => previewProduct(cfg, { ...opts, discover: async () => schema }) };
    const input = { sku, bindingRevisionId: published.id };
    return { input, options, product, writes, hooks, remote: () => remote, english: () => english, sources: () => sourceItems,
      enqueue: () => enqueue(config, input, options), apply: (job) => applyJob(config, job.id, options) };
  }

  return { scenario, config, published, installationKey };
};
