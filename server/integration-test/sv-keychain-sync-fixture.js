const assert = require('node:assert/strict');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { mapProduct, loadMagentoCatalog } = require('../src/services/magento-products-v1');
const { buildCandidates } = require('../src/services/magento/binding-bootstrap');
const { indexTrees } = require('../src/services/magento/sync-preview-categories');
const { previewProduct } = require('../src/services/magento/sync-preview');
const { parseMagentoConfig } = require('../src/config/magento');

// Entirely local PostgreSQL and an injected in-memory Magento counterpart. The
// full SV profile still evaluates all domain requirements; this synthetic binding
// owns only the fields relevant to the regression, with no inventory/category work.
async function run(db, actor, product) {
  await db.query(`INSERT INTO user_role_assignments(application_user_id,role_id)
    SELECT $1,id FROM roles WHERE role_key='administrator' AND is_system`, [actor.id]);
  const config = parseMagentoConfig({ MAGENTO_BASE_URL: 'https://sv-fixture.invalid', MAGENTO_CONSUMER_KEY: 'fake-key',
    MAGENTO_CONSUMER_SECRET: 'fake-secret', MAGENTO_ACCESS_TOKEN: 'fake-token', MAGENTO_ACCESS_TOKEN_SECRET: 'fake-secret' });
  const options = { databasePool: db, mutationContext: { actorUserId: Number(actor.id) } };
  const next = materializeMagentoV1(await loadMagentoCatalog(db), { publicSku: true });
  // Existing v4 supports a scoped SV publication without claiming catalog
  // evidence for the other five categories absent from this disposable fixture.
  next.evaluatorVersion = 'magento-declarative-4';
  next.outputContract = 'magento-products-columns-v2';
  const fields = ['sku','name','attribute_set_code','product_type','store_view_code','price','decor_weight','rozmir_suveniriv','product_online','visibility'];
  const group = next.groups.find(g => g.route === 'SV');
  next.groups = [group];
  next.bindings = next.bindings.filter(b => b.group === '*' || b.group === 'SV');
  next.sources = Object.fromEntries(Object.entries(next.sources).filter(([, s]) => s.kind === 'product' || s.category === 'SV'));
  next.questionContracts = Object.fromEntries(Object.entries(next.questionContracts).filter(([key]) => key.startsWith('SV.')));
  for (const row of group.rows) row.cells = Object.fromEntries(Object.entries(row.cells).filter(([key]) => fields.includes(key)));
  const set = mapProduct(product, await loadMagentoCatalog(db)).base.attribute_set_code;
  const schema = require('../test/fixtures/magento-bindings').schema();
  schema.attributes = ['sku','name','price','decor_weight','rozmir_suveniriv'].map((attribute_code, index) => ({
    attribute_id: 900 + index, attribute_code, frontend_input: 'text', options: [], scope: attribute_code === 'name' ? 'store' : 'global', apply_to: [] }));
  schema.attributeSets = [{ attribute_set_id: 8001, attribute_set_name: set, attributeCodes: schema.attributes.map(a => a.attribute_code) }];
  const installationKey = 'sv-keychain-local-only';
  async function publish(definition, expectedCurrentId) {
    const compiled = compileDefinition(definition);
    const template = await templates.createTemplate({ key: `sv-size-${expectedCurrentId ? 'next' : 'old'}`, displayName: 'SV local fixture', definition }, options);
    const version = await templates.publishTemplate(template.id, { expectedRevision: template.draft.revision, expectedDefinitionHash: template.draft.definitionHash }, options);
    let draft = await bindings.createDraft({ installationKey, origin: config.baseUrl, templateVersionId: version.id, observedAt: new Date().toISOString(), schema }, options);
    const b = buildCandidates({ compiled, products: [product], current: [] }, schema, indexTrees([]), { routeKey: 'SV.souvenir!=value_id:5' });
    b.routes.filter(r => r.enabled).forEach(r => { r.reviewState = 'approved'; });
    b.attributes.forEach(a => { a.reviewState = 'approved'; });
    b.options.forEach(o => { o.reviewState = 'approved'; });
    b.policies.forEach(p => {
      const attribute = b.attributes.find(a => a.bindingKey === p.bindingKey);
      p.reviewState = 'approved';
      p.policy = attribute.rowId === 'base' || attribute.target === 'name' ? 'authoritative_create_update' : 'magento_managed';
      if (attribute.target === 'product_online') { p.policy = 'initialize_create_only'; p.evidence = { createValue: 2 }; }
    });
    draft = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: b }, options);
    return bindings.publishDraft(draft.id, { expectedRevision: draft.revision, expectedCurrentId }, options);
  }
  const old = structuredClone(next);
  const size = old.bindings.find(b => b.id === 'SV.rozmir_suveniriv');
  size.value = size.value.else;
  const historical = await publish(old, null);
  await db.query('UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2', [installationKey, actor.id]);
  const prices = require('../src/services/product-price-change.service');
  const decision = { mode: 'manual_uah', manualPriceUah: 1100, marketingRoundingEnabled: false };
  const reviewed = await prices.previewProductPriceChange({ productId: product.id, pricingDecision: decision });
  await prices.applyProductPriceChange({ productId: product.id, pricingDecision: decision, previewToken: reviewed.previewToken }, options);
  const readRequest = async () => (await db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1', [product.id])).rows[0];
  let remote = null, english = null;
  const writes = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url), route = u.pathname.split('/V1/')[1];
    assert.equal(u.hostname, 'sv-fixture.invalid');
    const response = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    if (init.method === 'GET' && route === 'products') {
      const p = u.pathname.includes('/en/') ? english : remote;
      return response({ items: p ? [p] : [], total_count: p ? 1 : 0 });
    }
    if (init.method === 'GET' && route === 'categories') return response({ id: 803, name: 'Default', parent_id: 1, children_data: [] });
    assert.equal(init.method, 'POST'); assert.equal(route, 'products');
    const p = JSON.parse(init.body).product; writes.push(p);
    assert.ok(!(p.custom_attributes || []).some(a => a.attribute_code === 'rozmir_suveniriv'));
    if (!remote) remote = { id: 123, sku: product.public_sku, attribute_set_id: 8001, type_id: 'simple', status: 2, visibility: 4,
      custom_attributes: [], extension_attributes: { category_links: [] } };
    const target = u.pathname.includes('/en/') ? english : remote;
    const attributes = new Map((target?.custom_attributes || []).map(a => [a.attribute_code, a]));
    for (const a of p.custom_attributes || []) attributes.set(a.attribute_code, a);
    const updated = { ...target, ...p, custom_attributes: [...attributes.values()] };
    if (u.pathname.includes('/en/')) english = updated;
    else { remote = updated; if (!english) english = structuredClone(remote); }
    return response(true);
  };
  const worker = require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(config, { databasePool: db,
    jobOptions: { fetchImpl, preview: (cfg, opts) => previewProduct(cfg, { ...opts, discover: async () => schema }) } });
  await worker.runProduct(product.public_product_identity_id);
  assert.equal((await readRequest()).state, 'needs_attention');
  assert.equal(writes.length, 0, 'historical published evaluator must keep its captured semantics');
  const successor = await publish(next, historical.id);
  const editor = require('../src/services/magento/integration-editor.service');
  const creation = await editor.creationInputs({ categoryCode: 'SV' }, { databasePool: db });
  assert.deepEqual(creation.productCreateRequirements.SV.optionalAnswersWhen.size, { question: 'souvenir', values: ['6'] });
  const beforePreview = (await db.query(`SELECT (SELECT count(*) FROM products) products,(SELECT count(*) FROM audit_events) audits,
    (SELECT count(*) FROM magento_product_sync_requests) requests,(SELECT count(*) FROM sku_registry) reservations`)).rows[0];
  const prospective = await editor.prospectivePreview(config, { bindingRevisionId: successor.id,
    product: { categoryCode: 'SV', answers: { souvenir: 6, material: 1, color: 1, weight: '12,7' } },
    pricingDecision: { mode: 'manual_uah', manualPriceUah: 1000 } }, { databasePool: db,
    discover: async () => ({ schema, categories: indexTrees([]) }), fetchImpl: async () => assert.fail('Prospective example must make no external call') });
  assert.equal(prospective.sendable, true, JSON.stringify(prospective.blockers));
  assert.deepEqual((await db.query(`SELECT (SELECT count(*) FROM products) products,(SELECT count(*) FROM audit_events) audits,
    (SELECT count(*) FROM magento_product_sync_requests) requests,(SELECT count(*) FROM sku_registry) reservations`)).rows[0], beforePreview);
  await worker.tick();
  assert.equal((await readRequest()).state, 'needs_attention', 'deployment/publication alone does not blindly retry parked requests');
  // A separately reviewed business price change supplies the normal generation
  // bump here. Production binding-only unblocking uses the existing H3b handoff.
  const nextDecision = { ...decision, manualPriceUah: 1200 };
  const preview = await prices.previewProductPriceChange({ productId: product.id, pricingDecision: nextDecision });
  await prices.applyProductPriceChange({ productId: product.id, pricingDecision: nextDecision, previewToken: preview.previewToken }, options);
  await worker.runProduct(product.public_product_identity_id);
  assert.equal((await readRequest()).state, 'synced', JSON.stringify({ request: await readRequest(),
    jobs: (await db.query('SELECT state,failure FROM magento_sync_jobs WHERE product_id=$1', [product.id])).rows }));
  assert.equal(remote.price, 1200);
  assert.ok(writes.length > 0);
  assert.equal((await db.query('SELECT binding_revision_id FROM magento_sync_jobs WHERE product_id=$1', [product.id])).rows[0].binding_revision_id, successor.id);
  const names = { all: remote.name, en: english.name };
  remote.custom_attributes.push({ attribute_code: 'rozmir_suveniriv', value: 'Remote dimension' });
  const updateDecision = { ...decision, manualPriceUah: 1300 };
  const updatePreview = await prices.previewProductPriceChange({ productId: product.id, pricingDecision: updateDecision });
  await prices.applyProductPriceChange({ productId: product.id, pricingDecision: updateDecision, previewToken: updatePreview.previewToken }, options);
  await worker.runProduct(product.public_product_identity_id);
  assert.equal((await readRequest()).state, 'synced', JSON.stringify(await readRequest()));
  assert.equal(remote.price, 1300);
  assert.deepEqual({ all: remote.name, en: english.name }, names);
  assert.equal(remote.custom_attributes.find(a => a.attribute_code === 'rozmir_suveniriv').value, 'Remote dimension');
  assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs WHERE product_id=$1', [product.id])).rows[0].n, 2);
  const saved = (await db.query('SELECT * FROM products WHERE id=$1', [product.id])).rows[0];
  assert.deepEqual(saved.details.answers, product.details.answers);
  assert.equal(saved.full_sku, product.full_sku);
  assert.equal(saved.public_product_identity_id, product.public_product_identity_id);
  assert.equal(saved.weight, product.weight);
  await db.query('UPDATE magento_auto_sync_activation SET enabled=FALSE');
}
module.exports = { run };
