const test = require('node:test');
const assert = require('node:assert/strict');
const { scopeBaseFieldToProductRoute } = require('../src/services/magento/integration-field-scope');
const { testFieldFixture } = require('./fixtures/magento-test-field');
const { requirements } = require('../src/services/magento/binding-validation');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const { product } = require('./fixtures/magento-v1/contract');

test('product field scope requires only SV set 151, never stone set 154', () => {
  const f = testFieldFixture(), before = structuredClone(f.definition);
  const definition = scopeBaseFieldToProductRoute(f.definition, f.schema, f.scope);
  const routes = requirements(definition, f.schema);
  assert.equal(routes.length, 7);
  assert.deepEqual(routes.filter(r => r.attributes.some(a => a.target === f.target)).map(r => r.routeKey), [f.generalRoute]);
  const field = routes.find(r => r.routeKey === f.generalRoute).attributes.find(a => a.target === f.target);
  assert.equal(field.strategy, 'semantic_option');
  assert.deepEqual(field.options.map(o => o.sourceKey), ['SV.test_field=value_id:33']);
  assert.ok(!routes.find(r => r.routeKey === f.stoneRoute).attributes.some(a => a.target === f.target));
  for (let i = 0; i < definition.groups.length; i++) {
    const next = structuredClone(definition.groups[i]);
    if (next.route === 'SV') next.rows.find(r => r.id === 'base').cells[f.target] = before.groups[i].rows.find(r => r.id === 'base').cells[f.target];
    assert.deepEqual(next, before.groups[i]);
  }
  assert.deepEqual(f.definition, before);
});

test('field emits only for exact TEST-000001 on the nonstone SV route with answer 33', () => {
  const f = testFieldFixture(), definition = scopeBaseFieldToProductRoute(f.definition, f.schema, f.scope);
  const compiled = compileDefinition(definition);
  for (const [name, category, sku, souvenir, answer, expected] of [
    ['approved', 'SV', 'TEST-000001', 6, 33, 'TEST варіант'],
    ['string semantic answer', 'SV', 'TEST-000001', '6', '33', 'TEST варіант'],
    ['other TEST', 'SV', 'TEST-000002', 6, 33, ''],
    ['production', 'SV', 'AG-000001', 6, 33, ''],
    ['stone', 'SV', 'TEST-000001', 5, 33, ''],
    ['string stone', 'SV', 'TEST-000001', '5', 33, ''],
    ['absent answer', 'SV', 'TEST-000001', 6, undefined, ''],
    ['absent identity', 'SV', null, 6, 33, ''],
    ['other category', 'BR', 'TEST-000001', 6, 33, undefined],
  ]) {
    const p = product(category, { souvenir, [f.target]: answer }, { public_sku: sku });
    const result = evaluateProduct(compiled, p);
    assert.equal(result.base?.[f.target], expected, name);
    if (category === 'SV') assert.equal(result.english?.[f.target], '', name);
    assert.deepEqual(result.errors, evaluateProduct(compileDefinition(f.definition), p).errors, name);
  }
});

test('scope authoring rejects mismatching set, route, category, identity and protected fields', () => {
  const f = testFieldFixture();
  for (const change of [{ setId: 154 }, { routeKey: f.stoneRoute }, { category: 'BR' },
    { routeKey: 'SV:all' }, { publicSku: '' }, { publicSku: ' TEST-000001' }, { target: 'sku' }]) {
    assert.throws(() => scopeBaseFieldToProductRoute(f.definition, f.schema, { ...f.scope, ...change }), { code: 'MAGENTO_FIELD_SCOPE_INVALID' });
  }
  const ambiguous = structuredClone(f.schema);
  ambiguous.attributeSets.push({ ...ambiguous.attributeSets.find(s => s.attribute_set_id === 151), attribute_set_id: 999 });
  assert.throws(() => scopeBaseFieldToProductRoute(f.definition, ambiguous, f.scope), { code: 'MAGENTO_FIELD_SCOPE_INVALID' });
});
