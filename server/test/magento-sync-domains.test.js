const test = require('node:test');
const assert = require('node:assert/strict');
const { readDomains, planDomains } = require('../src/services/magento/sync-preview-domains');
const { bindingKey } = require('../src/services/magento/binding-validation');
const { parseMagentoConfig } = require('../src/config/magento');
const { createMagentoClient } = require('../src/services/magento/client');
const config = parseMagentoConfig({ MAGENTO_BASE_URL: 'https://example.invalid', MAGENTO_CONSUMER_KEY: 'fake-key',
  MAGENTO_CONSUMER_SECRET: 'fake-secret', MAGENTO_ACCESS_TOKEN: 'fake-access', MAGENTO_ACCESS_TOKEN_SECRET: 'fake-access-secret' });
function fixture() {
  const sku = 'KL3/11131351005';
  const expected = { base: { qty: '1', is_in_stock: '1', product_websites: 'base', product_type: 'simple', attribute_set_code: 'Set' },
    english: { sku, store_view_code: 'en', attribute_set_code: 'Set', product_type: 'simple',
      name: 'EN generated name', meta_title: 'EN SEO', meta_description: '', description: undefined } };
  const schema = { storeTopology: { websites: [{ id: 1, code: 'base' }],
    storeViews: [{ id: 3, code: 'en', website_id: 1, store_group_id: 1, is_active: true }] },
  attributes: ['name', 'meta_title', 'meta_description', 'description'].map((attribute_code, i) => ({ attribute_code,
    attribute_id: i + 1, scope: 'store', frontend_input: 'text', apply_to: [] })),
  attributeSets: [{ attribute_set_id: 144, attributeCodes: ['name', 'meta_title', 'meta_description', 'description'] }] };
  const bindings = { routes: [{ routeKey: 'KL:all', setId: 144 }], attributes: [], policies: [] };
  for (const [row, targets] of [['base', ['qty', 'is_in_stock', 'product_websites']], ['english', Object.keys(expected.english)]]) {
    for (const target of targets) {
      const key = bindingKey('KL:all', row, target);
      bindings.attributes.push({ routeKey: 'KL:all', rowId: row, target, bindingKey: key, reviewState: 'approved', attributeCode: target });
      bindings.policies.push({ bindingKey: key, storeCode: row === 'base' ? 'all' : 'en', reviewState: 'approved',
        policy: ['qty', 'is_in_stock'].includes(target) ? 'initialize_create_only'
          : ['sku', 'store_view_code', 'attribute_set_code', 'product_type'].includes(target) ? 'magento_managed' : 'authoritative_create_update' });
    }
  }
  return { sku, routeKey: 'KL:all', expected, schema, revision: { schema: structuredClone(schema), bindings },
    raw: { sku, id: 55, extension_attributes: { website_ids: [1, 9] } },
    evidence: { inventory: { stockId: 1, sources: [{ sourceCode: 'default', enabled: true }],
      sourceItems: [{ sourceCode: 'default', qty: 0, isInStock: false }] },
    english: { fields: { name: 'EN generated name', meta_title: 'Old SEO', meta_description: 'Keep SEO', description: 'Keep copy' }, preservedFields: ['unknown_field'] } } };
}
function plan(f) { const blockers = []; return { report: planDomains({ ...f, block: (code, details) => blockers.push({ code, ...details }) }), blockers }; }

test('UPDATE preserves sold inventory, extra websites and empty or unproduced EN fields, with exact scoped SEO changes', () => {
  const f = fixture(); const before = structuredClone(f); const { report: r, blockers } = plan(f);
  assert.deepEqual(blockers, []); assert.deepEqual(f, before);
  assert.equal(r.inventory.action, 'preserve'); assert.equal(r.inventory.candidatePayload, null);
  assert.equal(r.inventory.current.sourceItems[0].qty, 0); assert.equal(r.inventory.current.sourceItems[0].isInStock, false);
  assert.deepEqual(r.websites.operations, []); assert.deepEqual(r.websites.preservedAdditionalIds, [9]);
  assert.deepEqual(r.storeViews.candidatePayload, { product: { sku: f.sku, custom_attributes: [{ attribute_code: 'meta_title', value: 'EN SEO' }] } });
  assert.equal(r.storeViews.diff.find((d) => d.target === 'meta_description').action, 'preserve');
  assert.equal(r.storeViews.diff.find((d) => d.target === 'description').action, 'preserve');
  assert.ok(r.storeViews.preservedFields.includes('unknown_field'));
});
test('CREATE initializes only a uniquely resolved enabled MSI source and adds website membership separately', () => {
  const f = fixture(); f.raw = null; f.evidence.english = null; f.evidence.inventory.sourceItems = [];
  const { report: r, blockers } = plan(f); assert.deepEqual(blockers, []);
  assert.deepEqual(r.inventory.candidatePayload, { sourceItems: [{ sku: f.sku, source_code: 'default', quantity: 1, status: 1 }] });
  assert.deepEqual(r.websites.operations[0].candidatePayload, { productWebsiteLink: { sku: f.sku, website_id: 1 } });
  assert.equal(r.storeViews.candidatePayload.product.name, 'EN generated name');
  f.evidence.inventory.sources.push({ sourceCode: 'another', enabled: true });
  assert.ok(plan(f).blockers.some((b) => b.code === 'INVENTORY_CREATE_SOURCE_UNRESOLVED'));
  assert.equal(plan(f).report.inventory.candidatePayload, null);
  f.evidence.inventory.sourceItems.push({ sourceCode: 'default', qty: 1, isInStock: true });
  assert.ok(plan(f).blockers.some((b) => b.code === 'INVENTORY_ORPHAN_SOURCE_ITEMS_PRESENT'));
});
test('website ensure adds base without replacing extra memberships; identities, missing evidence and policy stay fail closed', () => {
  const f = fixture(); f.raw.extension_attributes.website_ids = [9];
  assert.deepEqual(plan(f).report.websites.wouldAdd, [1]);
  assert.deepEqual(plan(f).report.websites.preservedAdditionalIds, [9]);
  f.schema.storeTopology.websites[0].id = 5;
  assert.ok(plan(f).blockers.some((b) => b.code === 'WEBSITE_IDENTITY_REVIEW_REQUIRED'));
  f.raw.extension_attributes.website_ids = null;
  assert.ok(plan(f).blockers.some((b) => b.code === 'WEBSITE_ASSIGNMENTS_UNAVAILABLE'));
  assert.deepEqual(plan(f).report.websites.operations, []);
  f.revision.bindings.attributes[0].reviewState = 'proposed';
  f.revision.bindings.policies[0].policy = 'authoritative_create_update';
  assert.ok(plan(f).blockers.some((b) => b.code === 'INVENTORY_BINDING_REVIEW_REQUIRED'));
  assert.ok(plan(f).blockers.some((b) => b.code === 'DOMAIN_POLICY_REVIEW_REQUIRED'));
});
test('EN global/unknown scopes, drift, blocked mappings and missing scoped reads cannot become sendable', () => {
  for (const scope of ['global', 'website', undefined]) {
    const f = fixture(); f.schema.attributes[1].scope = scope;
    assert.ok(plan(f).blockers.some((b) => b.code === 'STORE_VIEW_ATTRIBUTE_UNSUPPORTED'));
    assert.equal(plan(f).report.storeViews.candidatePayload, null);
  }
  const f = fixture(); f.schema.storeTopology.storeViews[0].id = 7; f.evidence.english = null;
  f.revision.bindings.attributes.find((a) => a.target === 'meta_title').reviewState = 'blocked';
  const r = plan(f); assert.ok(r.blockers.some((b) => b.code === 'STORE_VIEW_IDENTITY_REVIEW_REQUIRED'));
  assert.ok(r.blockers.some((b) => b.code === 'STORE_VIEW_CURRENT_PRODUCT_UNAVAILABLE'));
  assert.ok(r.blockers.some((b) => b.code === 'STORE_VIEW_BINDING_REVIEW_REQUIRED'));
});
function network(f, overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
    const u = new URL(url); calls.push(u);
    const route = u.pathname.split('/V1/')[1];
    const responses = {
      'inventory/stock-resolver/website/base': { stock_id: 1, extension_attributes: { sales_channels: [{ type: 'website', code: 'base' }] } },
      'inventory/get-sources-assigned-to-stock-ordered-by-priority/1': [{ source_code: 'default', enabled: true, email: 'not retained' }],
      'inventory/source-items': { total_count: 1, items: [{ sku: f.sku, source_code: 'default', quantity: 0, status: 0 }] },
      products: { total_count: 1, items: [{ ...f.raw, name: 'Current EN', custom_attributes: [{ attribute_code: 'unknown', value: 'not retained' }] }] },
      ...overrides,
    };
    assert.ok(Object.hasOwn(responses, route), route);
    if (['products', 'inventory/source-items'].includes(route)) {
      assert.equal(u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'), f.sku);
      assert.equal(u.searchParams.get('searchCriteria[filter_groups][0][filters][0][condition_type]'), 'eq');
    }
    if (route === 'products') assert.equal(u.pathname, '/rest/en/V1/products');
    return new Response(JSON.stringify(responses[route]), { headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl, client: createMagentoClient(config, { fetchImpl }) };
}
test('live contract reads are exact-SKU GET-only, bounded, minimized and explicitly EN-scoped', async () => {
  const f = fixture(); const n = network(f);
  const evidence = await readDomains(config, { ...f, ...n });
  assert.deepEqual(evidence.failures, []); assert.equal(n.calls.length, 4);
  assert.equal(evidence.inventory.sourceItems[0].qty, 0);
  assert.equal(evidence.english.fields.name, 'Current EN');
  assert.ok(!JSON.stringify(evidence).includes('not retained'));
});
test('MSI truncation, nonexact SKU, invalid source status and scoped identity mismatch remain structured read failures', async () => {
  const f = fixture();
  for (const value of [
    { total_count: 101, items: [] },
    { total_count: 1, items: [{ sku: 'WRONG', source_code: 'default', quantity: 1, status: 1 }] },
    { total_count: 1, items: [{ sku: f.sku, source_code: 'default', quantity: 1, status: 2 }] },
    { total_count: 1, items: [{ sku: f.sku, quantity: 1, status: 1 }] },
  ]) {
    const n = network(f, { 'inventory/source-items': value }); const e = await readDomains(config, { ...f, ...n });
    assert.equal(e.inventory, null); assert.equal(e.failures[0].code, 'INVENTORY_READ_UNAVAILABLE'); assert.ok(e.english);
  }
  const n = network(f, { products: { total_count: 1, items: [{ ...f.raw, id: 99, custom_attributes: [] }] } });
  const e = await readDomains(config, { ...f, ...n });
  assert.equal(e.english, null); assert.equal(e.failures[0].code, 'STORE_VIEW_READ_UNAVAILABLE'); assert.ok(e.inventory);
});
