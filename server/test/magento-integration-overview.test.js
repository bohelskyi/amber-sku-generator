const { test } = require('node:test');
const assert = require('node:assert/strict');
const { preparationSummary, operationalCounts } = require('../src/services/magento/integration-overview');
const { semanticReadiness } = require('../src/services/magento/integration-readiness');
const { entries } = require('../src/services/magento/binding-review');

function fixture() {
  const catalog = { categories: { XX: { name: 'Категорія' } }, questions: { XX: [
    { id: 'kind', label: 'Вид', options: [{ id: 8, label: 'Значення', sku_code: '02', archived: 0 }] },
  ] } };
  const revision = { bindings: {
    routes: [{ routeKey: 'XX:all', enabled: true, reviewState: 'approved', setId: 151 }],
    attributes: [{ bindingKey: 'kind', routeKey: 'XX:all', rowId: 'base', target: 'kind', attributeCode: 'kind', reviewState: 'approved', evidence: {} }],
    options: [{ bindingKey: 'kind', sourceKey: 'XX.kind=value_id:8', sourceKind: 'semantic', amberGroup: 'XX', questionKey: 'kind', valueId: '8', optionId: '5738', reviewState: 'approved' }],
    policies: [],
  }, schema: { attributeSets: [{ attribute_set_id: 151, attribute_set_name: 'Set', attributeCodes: ['kind'] }],
    attributes: [{ attribute_id: 13, attribute_code: 'kind', options: [{ value: '5738', label: 'Значення' }] }] } };
  const summarize = () => preparationSummary(semanticReadiness(catalog, [{ category_code: 'XX', id: 9 }], revision)[0], revision, entries(revision));
  return { catalog, revision, summarize };
}

test('overview preparation ignores approved and reviewed refusal paths but detects a new unmapped semantic value', () => {
  const f = fixture();
  assert.deepEqual(f.summarize(), { needed: false, count: 0, reasons: [] });
  f.revision.bindings.options[0].reviewState = 'blocked';
  assert.equal(f.summarize().needed, false);
  f.catalog.questions.XX[0].options.push({ id: 9, label: 'Нове', sku_code: '03', archived: 0 });
  assert.deepEqual(f.summarize().reasons.map((r) => r.code), ['MAPPING_MISSING']);
  f.revision.bindings.routes[0].reviewState = 'blocked';
  assert.equal(f.summarize().needed, false);
});

test('overview preparation distinguishes explicit refusal from missing set membership and unreviewed decisions', () => {
  const f = fixture();
  f.revision.schema.attributeSets[0].attributeCodes = [];
  assert.equal(f.summarize().reasons[0].code, 'STRUCTURE_REVIEW_REQUIRED');
  f.revision.bindings.attributes[0].reviewState = 'blocked';
  assert.equal(f.summarize().needed, false);
  f.revision.bindings.attributes[0].reviewState = 'approved';
  f.revision.schema.attributeSets[0].attributeCodes = ['kind'];
  f.revision.bindings.options[0].reviewState = 'proposed';
  assert.deepEqual(f.summarize().reasons, [{ code: 'MAPPING_REVIEW_REQUIRED', message: 'Потрібно переглянути непідтверджені відповідності', count: 1 }]);
});

test('an approved sibling attribute cannot turn another attribute refusal into structural attention', () => {
  const f = fixture();
  f.revision.bindings.options[0].reviewState = 'blocked';
  f.revision.bindings.attributes.push({ ...f.revision.bindings.attributes[0], bindingKey: 'other', target: 'other', attributeCode: 'other' });
  f.revision.bindings.options.push({ ...f.revision.bindings.options[0], bindingKey: 'other', reviewState: 'approved' });
  f.revision.schema.attributes.push({ ...f.revision.schema.attributes[0], attribute_id: 14, attribute_code: 'other' });
  f.revision.schema.attributeSets[0].attributeCodes.push('other');
  assert.equal(f.summarize().needed, false);
});

test('not applicable values and children of a refused category attribute do not create preparation noise', () => {
  const f = fixture();
  const category = semanticReadiness(f.catalog, [{ category_code: 'XX', id: 9 }], f.revision)[0];
  category.values.push({ state: 'not_applicable', mappings: [] });
  assert.equal(preparationSummary(category, f.revision, entries(f.revision)).needed, false);
  f.revision.bindings.attributes[0].reviewState = 'blocked';
  f.revision.bindings.attributes[0].evidence.categories = [{ normalizedPath: 'Root/Path', requestedPath: 'Root/Path', categoryId: null, reviewState: 'proposed' }];
  assert.equal(f.summarize().needed, false);
});

test('uncovered category is future preparation without claiming any operational failure', () => {
  const f = fixture();
  const category = semanticReadiness(f.catalog, [], null)[0];
  assert.deepEqual(preparationSummary(category, null), { needed: true, count: 1,
    reasons: [{ code: 'NOT_CONNECTED', message: 'Ще не підключено', count: 1 }] });
});

test('operational projection keeps distinct product totals separate from overlapping reason counts', async () => {
  const calls = [];
  const result = await operationalCounts({ query: async (...args) => { calls.push(args); return { rows: [
    { category: null, code: null, level: 3, count: 2 },
    { category: 'XX', code: null, level: 1, count: 2 },
    { category: 'XX', code: 'OPTION_UNRESOLVED', level: 0, count: 2 },
    { category: 'XX', code: 'ATTRIBUTE_NOT_FOUND', level: 0, count: 1 },
  ] }; } }, 'configured-origin');
  assert.equal(result.count, 2); assert.equal(result.categories.get('XX').count, 2);
  assert.equal(result.categories.get('XX').reasons.reduce((sum, row) => sum + row.count, 0), 3);
  assert.equal(result.categories.get('XX').reasons[0].message, 'У Magento немає підтвердженого відповідного значення характеристики.');
  assert.deepEqual(calls[0][1], ['configured-origin']);
});

test('overview route uses effective view permission and refuses to infer products.view', async () => {
  const service = require('../src/services/magento/integration-overview');
  const router = require('../src/routes/admin/magento-integration.routes');
  const route = router.stack.find((layer) => layer.route.path === '/admin/magento-integration/overview').route;
  assert.deepEqual(route.stack.map((layer) => layer.handle.permissionKey).filter(Boolean), ['export_templates.view']);
  const original = service.overview; const calls = [];
  service.overview = async (_config, options) => { calls.push(options); return {}; };
  try {
    const response = { json: () => {} };
    await route.stack.at(-1).handle({ permissions: ['export_templates.view'] }, response);
    await route.stack.at(-1).handle({ permissions: ['export_templates.view', 'products.view'] }, response);
    assert.deepEqual(calls, [{ canViewProducts: false }, { canViewProducts: true }]);
  } finally { service.overview = original; }
});

test('creation inputs require preview capabilities, not unrelated product-view access', async () => {
  const service = require('../src/services/magento/integration-editor.service');
  const router = require('../src/routes/admin/magento-integration.routes');
  const route = router.stack.find((layer) => layer.route.path === '/admin/magento-integration/creation-inputs').route;
  assert.deepEqual(route.stack.map((layer) => layer.handle.permissionKey).filter(Boolean), ['export_templates.manage', 'exports.view']);
  let allowed = 0;
  for (const middleware of route.stack.slice(0, -1)) {
    middleware.handle({ permissions: ['export_templates.manage', 'exports.view'] }, {}, () => { allowed++; });
  }
  assert.equal(allowed, 2);
  const original = service.creationInputs; let input;
  service.creationInputs = async (value) => { input = value; return {}; };
  try {
    await route.stack.at(-1).handle({ query: Object.assign(Object.create(null), { categoryCode: 'SV' }) }, { json: () => {} });
    assert.deepEqual(input, { categoryCode: 'SV' });
    assert.equal(Object.getPrototypeOf(input), Object.prototype);
  } finally { service.creationInputs = original; }
});

test('creation input read rejects incomplete or extra query parameters before database access', async () => {
  const { creationInputs } = require('../src/services/magento/integration-editor.service');
  for (const input of [{}, { categoryCode: ['SV'] }, { categoryCode: '' }, { categoryCode: 'SV', draft: true }]) {
    await assert.rejects(creationInputs(input));
  }
});
