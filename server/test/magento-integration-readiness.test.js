const { test } = require('node:test');
const assert = require('node:assert/strict');
const { semanticReadiness, boundedGet } = require('../src/services/magento/integration-readiness');

const config = { categories: { XX: { name: 'Нова категорія' } }, questions: { XX: [
  { id: 'kind', label: 'Вид', options: [{ id: 8, label: 'Скриньки', sku_code: '02', archived: 0 }] },
] } };
test('a future category is visibly not ready, never silently dropped from the six legacy groups', () => {
  const [category] = semanticReadiness(config, [], null);
  assert.equal(category.code, 'XX'); assert.equal(category.ready, false);
  assert.equal(category.message, 'Категорія ще не готова до Magento');
  assert.equal(category.values[0].state, 'missing');
});
test('equal labels remain candidates, semantic IDs never become Magento option IDs', () => {
  const revision = { bindings: { routes: [{ routeKey: 'XX:all', enabled: true, reviewState: 'approved', setId: 151 }],
    attributes: [{ bindingKey: 'kind', routeKey: 'XX:all', attributeCode: 'suveniry', reviewState: 'approved' }],
    options: [{ bindingKey: 'kind', sourceKind: 'semantic', amberGroup: 'XX', questionKey: 'kind', valueId: '8',
      optionId: '5738', reviewState: 'proposed' }], policies: [] }, schema: {
    attributeSets: [{ attribute_set_id: 151, attributeCodes: ['suveniry'] }],
    attributes: [{ attribute_code: 'suveniry', options: [{ value: '5738', label: 'Скриньки' }] }] } };
  const [category] = semanticReadiness(config, [{ category_code: 'XX', id: 9 }], revision);
  assert.equal(category.values[0].state, 'candidate'); assert.equal(category.values[0].optionId, '5738');
  revision.bindings.options[0].reviewState = 'approved';
  assert.equal(semanticReadiness(config, [{ category_code: 'XX', id: 9 }], revision)[0].values[0].state, 'approved');
  revision.schema.attributeSets[0].attributeCodes = [];
  assert.equal(semanticReadiness(config, [], revision)[0].values[0].state, 'blocked');
});
test('HTTP discovery is GET-only and has a hard total request bound', async () => {
  let calls = 0; const fetch = boundedGet(async () => { calls++; return {}; }, { maxRequests: 2 });
  await assert.rejects(fetch('https://example.test', { method: 'POST' }), { code: 'MAGENTO_DISCOVERY_GET_ONLY' });
  await fetch('https://example.test', { method: 'GET' }); await fetch('https://example.test', { method: 'GET' });
  await assert.rejects(fetch('https://example.test', { method: 'GET' }), { code: 'MAGENTO_DISCOVERY_LIMIT' });
  assert.equal(calls, 2);
});
test('integration routes preserve view/manage/exports permission boundaries', () => {
  const router = require('../src/routes/admin/magento-integration.routes');
  for (const layer of router.stack) {
    const permissions = layer.route.stack.map((s) => s.handle.permissionKey).filter(Boolean);
    assert.deepEqual(permissions, layer.route.path.includes('/categories/')
      ? ['export_templates.manage', 'export_templates.publish'] : layer.route.path.endsWith('-preview')
        ? ['export_templates.manage', 'exports.view'] : ['export_templates.view']);
  }
});
