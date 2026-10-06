const test = require('node:test');
const assert = require('node:assert/strict');
const tests = require('../src/services/product/test-products');
const { getProductPreviewToken, buildNewProductPreview } = require('../src/services/product.service');
const own = require('../src/services/magento/native-identity-ownership');
const fixture = require('./fixtures/magento-bindings');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { planPreview } = require('../src/services/magento/sync-preview');
const { evaluate } = require('../src/services/magento/binding-evidence-products');
const { indexTrees } = require('../src/services/magento/sync-preview-categories');
const restore = require('../src/services/product-lifecycle-state');
function db({ admin = true, enabled = true, namespaceAvailable = true } = {}) {
  return { async query(sql) {
    if (sql.includes('has_permission')) return { rows: [{ status: 'active', has_permission: true }] };
    if (sql.includes("r.role_key='administrator'")) return { rowCount: admin ? 1 : 0, rows: [] };
    if (sql.includes('public_sku_activation')) return { rows: [{ enabled }] };
    if (sql.includes("to_regclass('test_product_sku_sequence')")) return { rows: [{ available: namespaceAvailable }] };
    if (sql.includes('to_jsonb(c)')) return { rows: [{ category: { code: 'ZZ', requires_weight: 0 }, questions: [] }] };
    throw new Error('Unexpected query: ' + sql);
  } };
}
test('TEST boolean rejects UI bypass, non-admin and photo-enable intent before creation', async () => {
  for (const isTestProduct of [null, 1, 0, 'true', 'false', {}, []]) {
    assert.throws(() => tests.normalizeFlag({ isTestProduct }), { code: 'TEST_PRODUCT_FLAG_INVALID', statusCode: 422 });
    await assert.rejects(buildNewProductPreview({ isTestProduct }), { code: 'TEST_PRODUCT_FLAG_INVALID' });
  }
  assert.equal(tests.normalizeFlag({}), false); assert.equal(tests.normalizeFlag({ isTestProduct: false }), false);
  assert.throws(() => tests.normalizeFlag({ isTestProduct: true, enableWhenPhotosVerified: true }), { code: 'TEST_PRODUCT_ENABLE_FORBIDDEN' });
  try { tests.assertDisabled({ is_test_product: true }, null, true); } catch (cause) {
    assert.deepEqual(require('../src/http/errors').serializeHttpError(cause, { includeCode: true }),
      { statusCode: 422, body: { error: 'TEST товар залишається вимкненим у Magento.', code: 'TEST_PRODUCT_ENABLE_FORBIDDEN' } });
  }
  await assert.rejects(tests.assertAdministrator(db({ admin: false }), 7), { code: 'TEST_PRODUCT_ADMINISTRATOR_REQUIRED', statusCode: 403 });
  await assert.rejects(tests.assertAdministrator(db(), undefined), { statusCode: 403 });
});
test('native TEST preview is authoritative and signed; ordinary false leaves golden token unchanged', async () => {
  const payload = { categoryCode: 'ZZ', answers: {}, weight: 1, pricingDecision: { mode: 'manual_uah', manualPriceUah: 100, marketingRoundingEnabled: false } };
  const options = { queryable: db(), mutationContext: { actorUserId: 7 } };
  const normal = await buildNewProductPreview(payload, options);
  const explicitNormal = await buildNewProductPreview({ ...payload, isTestProduct: false }, options);
  const testPreview = await buildNewProductPreview({ ...payload, isTestProduct: true }, options);
  assert.equal(testPreview.isTestProduct, true); assert.equal(testPreview.testTargetStatus, 2);
  assert.equal(normal.isTestProduct, false); assert.equal(normal.testTargetStatus, undefined);
  assert.equal(normal.previewToken, explicitNormal.previewToken); assert.notEqual(normal.previewToken, testPreview.previewToken);
  assert.equal(getProductPreviewToken(normal, 'ZZ', {}, null), getProductPreviewToken({ ...normal, isTestProduct: false }, 'ZZ', {}, null));
});
test('TEST preview and save fail closed before allocation when native activation precedes 069', async (t) => {
  const payload = { categoryCode: 'ZZ', answers: {}, weight: 1, isTestProduct: true };
  const unavailable = db({ namespaceAvailable: false });
  const expected = { statusCode: 409, code: 'TEST_PRODUCT_NAMESPACE_UNAVAILABLE' };
  await assert.rejects(buildNewProductPreview(payload, { queryable: unavailable, mutationContext: { actorUserId: 7 } }), expected);
  await assert.rejects(tests.assertNamespaceAvailable({ query: async () => ({ rows: [] }) }), expected);
  const pool = require('../src/db/pool'); let released = false;
  const query = async sql => {
    if (sql.includes("to_regclass('full_product_export_activation')")) return { rows: [{ present: false }] };
    if (sql.includes('has_permission') || sql.includes("r.role_key='administrator'")
      || sql.includes("to_regclass('test_product_sku_sequence')")) return unavailable.query(sql);
    if (/^(BEGIN|ROLLBACK)/.test(sql) || sql === "SET LOCAL amber.lifecycle_writer_version = '1'" || sql.includes('pg_advisory_')) return { rows: [] };
    throw new Error('No pricing, receipt, product or allocator query is allowed: ' + sql);
  };
  t.mock.method(pool, 'connect', async () => ({ query, release() { released = true; } }));
  await assert.rejects(require('../src/services/product.service').saveProduct({ ...payload,
    characteristicConfigHash: '0'.repeat(64), previewToken: 'forged', idempotencyKey: '10000000-0000-4000-8000-000000000001' },
  { mutationContext: { actorUserId: 7 } }), expected);
  assert.equal(released, true);
});
function amber(isTestProduct) {
  const d = structuredClone(fixture.definition()); d.sources.sku.field = 'public_sku';
  d.evaluatorVersion = 'magento-declarative-3'; d.sourceContractVersion = 'public-product-identity-v1';
  return { product: { id: 5, characteristic_version_id: 1, public_product_identity_id: 9, public_sku: isTestProduct ? 'TEST-000001' : 'AG-000003',
    is_test_product: isTestProduct, full_sku: null, category: 'BR', status: 'active', weight: 5, exclude_from_export: 0,
    details: { answers: { binding_test_semantic: 7, binding_test_size: '17' } } }, compiled: compileDefinition(d),
    revision: { originHash: 'fixture-origin', bindings: { routes: [], attributes: [], options: [], policies: [] }, schema: fixture.schema() } };
}
test('TEST transport creates disabled, keeps frozen publication, and refuses any foreign collision or enabled counterpart', async () => {
  const a = amber(true); const before = JSON.stringify(a.compiled.definition);
  const normal = amber(false); assert.equal(evaluate(a, a.product).base.product_online, '2');
  assert.equal(evaluate(normal, normal.product).base.product_online, undefined); assert.equal(JSON.stringify(a.compiled.definition), before);
  const nodes = indexTrees([]); const create = planPreview(a, fixture.schema(), null, nodes);
  assert.equal(create.candidatePayload.product.status, 2);
  const raw = { id: 5797, sku: a.product.public_sku, status: 2, visibility: 4, name: 'Fixture name', attribute_set_id: 8001, type_id: 'simple', price: 100 };
  const foreign = planPreview(a, fixture.schema(), raw, nodes); assert.ok(foreign.blockers.some(b => b.code === own.CODE));
  await own.load({ query: async () => ({ rows: [{ origin: 'allocated', remote_id: 5797 }] }) }, a, 'fixture-origin');
  const enabled = planPreview(a, fixture.schema(), { ...raw, status: 1 }, nodes);
  assert.ok(enabled.blockers.some(b => b.code === 'TEST_PRODUCT_REMOTE_ENABLED'));
  for (const operation of Object.values(enabled.sendability.operations)) assert.equal(operation.sendable, false);
  const update = planPreview(a, fixture.schema(), raw, nodes);
  assert.equal(update.blockers.some(b => ['TEST_PRODUCT_REMOTE_ENABLED', own.CODE].includes(b.code)), false);
});
test('TEST photo/restore activation cannot be requested while ordinary activation remains allowed', () => {
  const product = { id: 5, is_test_product: true, public_product_identity_id: 9, status: 'archived', exclude_from_export: 1, corrected_to_product_id: null };
  tests.assertDisabled(product, { status: 2 }); assert.throws(() => tests.assertDisabled(product, null, true), { code: 'TEST_PRODUCT_ENABLE_FORBIDDEN' });
  assert.throws(() => tests.assertDisabled(product, { status: 1 }), { code: 'TEST_PRODUCT_REMOTE_ENABLED' });
  assert.doesNotThrow(() => tests.assertDisabled({ is_test_product: false }, { status: 1 }, true));
  const life = { route: 'retired' }; const before = { ...product, status: 'active', exclude_from_export: 0 };
  const hide = { id: 'hide', kind: 'hide', product_id: 5, state: 'verified', previous_product: before,
    previous_lifecycle: { route: 'normal', business_exclusion_state: 'none', evidence: { origin: 'ordinary_save' } },
    previous_remote_status: 1, local_fingerprint: restore.fingerprint(product, life), remote_product_id: 5797 };
  assert.equal(restore.restoreProof(product, life, { confirmedRemoteId: 5797 }, hide).reasonCode, 'TEST_PRODUCT_ENABLE_FORBIDDEN');
  hide.previous_remote_status = 2; assert.equal(restore.restoreProof(product, life, { confirmedRemoteId: 5797 }, hide).visibility.status, 2);
  assert.deepEqual(tests.projection(product), { isTestProduct: true, testTargetStatus: 2 });
});

test('TEST HTTP creation gates keep active session, CSRF, permission and actual Administrator authority', async (t) => {
  const express = require('express');
  const { requireAuthenticatedSession, requireCsrfForUnsafeMethods } = require('../src/auth/authentication');
  const { createRequireActiveApplicationUser } = require('../src/auth/authorization');
  const pool = require('../src/db/pool');
  const query = async sql => {
    if (sql.includes('has_permission')) return { rows: [{ status: 'active', has_permission: true }] };
    if (sql.includes("r.role_key='administrator'")) return { rowCount: 0, rows: [] };
    if (sql.includes('to_regclass')) return { rows: [{ present: false }] };
    return { rows: [], rowCount: 0 };
  };
  t.mock.method(pool, 'query', query);
  t.mock.method(pool, 'connect', async () => ({ query, release() {} }));
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const subject = req.get('X-Fixture-Subject');
    req.session = { csrfToken: 'fixture-token', ...(subject ? { identity: { issuer: 'fixture', sub: subject, authenticatedAt: '2026-10-01T00:00:00Z' } } : {}) };
    next();
  });
  app.use(requireAuthenticatedSession);
  app.use(createRequireActiveApplicationUser({ getOrCreateApplicationAccess: async identity => ({
    applicationUser: { id: 7, status: identity.sub === 'disabled' ? 'disabled' : 'active' },
    roles: [{ key: 'administrator', isSystem: true }], // Caller-visible role cannot confer DB authority.
    permissions: identity.sub === 'none' ? [] : ['products.create'],
  }) }));
  app.use(requireCsrfForUnsafeMethods); app.use(require('../src/routes/public/products.routes'));
  const server = await new Promise(done => { const listening = app.listen(0, '127.0.0.1', () => done(listening)); });
  try {
    const request = (path, payload, subject = 'manager', csrf = true) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(subject ? { 'X-Fixture-Subject': subject } : {}), ...(csrf ? { 'X-CSRF-Token': 'fixture-token' } : {}) }, body: JSON.stringify(payload),
    });
    for (const path of ['/preview', '/price-preview', '/save']) {
      for (const [subject, csrf, status] of [[null, true, 401], ['disabled', true, 403], ['none', true, 403], ['manager', false, 403]]) {
        assert.equal((await request(path, { isTestProduct: true }, subject, csrf)).status, status);
      }
      const malformed = await request(path, { isTestProduct: 'true' }); assert.equal(malformed.status, 422);
      assert.equal((await malformed.json()).code, 'TEST_PRODUCT_FLAG_INVALID');
      const nonAdmin = await request(path, { isTestProduct: true }); assert.equal(nonAdmin.status, 403);
      assert.equal((await nonAdmin.json()).code, 'TEST_PRODUCT_ADMINISTRATOR_REQUIRED');
    }
  } finally { await new Promise(done => server.close(done)); }
});

test('checkpoint-safe photo lookup retains the authoritative TEST marker and rejects activation before writing media', async () => {
  const product={id:5,public_product_identity_id:9,status:'active',corrected_to_product_id:null,
    public_sku:'TEST-000001',is_test_product:true};
  const queries=[];
  const client={async query(sql){
    queries.push(sql);
    if(sql.includes('has_permission'))return {rows:[{status:'active',has_permission:true}]};
    if(sql.includes('SELECT p.id,p.public_product_identity_id')){
      assert.match(sql,/COALESCE\(\(to_jsonb\(i\)->>'is_test_product'\)::boolean,FALSE\) AS is_test_product/);
      return {rows:[product]};
    }
    if(sql.includes('FROM magento_test_deletions'))return {rows:[],rowCount:0};
    throw new Error('TEST activation must stop before any photo set, asset or job mutation: '+sql);
  }};
  await assert.rejects(require('../src/services/product-photos.service').attachCreatedProduct(client,5,
    {photoIds:['10000000-0000-4000-8000-000000000001'],enableWhenVerified:true},{actorUserId:7}),
  {code:'TEST_PRODUCT_ENABLE_FORBIDDEN',statusCode:422});
  assert.equal(queries.length,3);
});

test('TEST deletion remains sealed and exact-scoped; general sync still cannot DELETE', async () => {
  const { signTestDeleteRequest, signSyncRequest } = require('../src/services/magento/oauth');
  const { deleteSealedProduct } = require('../src/services/magento/test-deletion-transport');
  const { originHash } = require('../src/services/magento/binding-contract');
  const config = { configured: true, baseUrl: 'https://test.example.invalid', consumerKey: 'fixture', consumerSecret: 'fixture', accessToken: 'fixture', accessTokenSecret: 'fixture' };
  const url = `${config.baseUrl}/rest/all/V1/products/TEST-000001`;
  assert.match(signTestDeleteRequest(url, config), /^OAuth /);
  for (const bad of [`${url}?force=true`, `${url}/other`, url.replace('/all/', '/en/'), `${url}%2Fother`]) {
    assert.throws(() => signTestDeleteRequest(bad, config), { code: 'MAGENTO_INPUT_INVALID' });
  }
  assert.throws(() => signSyncRequest(url, config, 'DELETE'), { code: 'MAGENTO_INPUT_INVALID' });
  let calls = 0;
  const intent = { id: 'fixture-sealed', state: 'dispatched', dispatched_at: new Date(), public_sku: 'TEST-000001', remote_product_id: 5797, origin_hash: originHash(config.baseUrl) };
  const fetchImpl = async (target, init) => { calls++; assert.equal(target, url); assert.equal(init.method, 'DELETE'); assert.equal(init.redirect, 'manual'); return new Response('true', { status: 200 }); };
  await assert.rejects(deleteSealedProduct(config, { ...intent, state: 'sealed' }, { fetchImpl }), { code: 'TEST_DELETE_INTENT_REQUIRED' });
  assert.equal(calls, 0);
  await deleteSealedProduct(config, intent, { fetchImpl }); assert.equal(calls, 1);
});
