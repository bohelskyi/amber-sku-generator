const test = require('node:test');
const assert = require('node:assert/strict');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateProduct } = require('../src/services/export-templates/evaluate');
const { POLICY, upgradeNameReadiness } = require('../src/services/export-templates/effective-product-names');
const { decisionFor } = require('../src/services/magento/name-state');
const { readNames } = require('../src/services/magento/name-discovery');
const { boundedGet } = require('../src/services/magento/integration-readiness');
const { ruleProof } = require('../src/services/magento/integration-successor');
const fixture = require('./fixtures/magento-v4');
function sample(empty = false) {
  const definition = fixture.definition(['AR']); delete definition.sources.color; delete definition.sources.note;
  definition.questionContracts = {}; definition.tables = {};
  if (empty) definition.groups[0].rows.forEach(row => { row.cells.name = { op: 'when', if: { op: 'eq', left: { op: 'source', id: 'sku' }, right: { op: 'literal', value: 'NEVER-MATCH' } }, then: { op: 'literal', value: 'Unused valid name' }, else: { op: 'literal', value: '' } }; });
  const next = upgradeNameReadiness(definition);
  return { definition, next, compiled: compileDefinition(next), product: { id: 1, public_sku: 'AR1-1-000001', full_sku: 'AR1-1-000001',
    category: 'AR', weight: '1.000', total_price_uah: '100.00', status: 'active', details: { answers: {} } } };
}
test('effective names use an explicit successor; old definitions and non-name decision proofs remain unchanged', () => {
  const f = sample(); const before = compileDefinition(f.definition).hash;
  assert.equal(f.next.nameReadiness, POLICY);
  assert.equal(compileDefinition(f.definition).hash, before);
  const withoutFlag = structuredClone(f.next); delete withoutFlag.nameReadiness;
  assert.notEqual(ruleProof(withoutFlag, 'AR', 'base', 'name'), ruleProof(f.next, 'AR', 'base', 'name'));
  assert.equal(ruleProof(withoutFlag, 'AR', 'base', 'price'), ruleProof(f.next, 'AR', 'base', 'price'));
  assert.deepEqual(evaluateProduct(f.compiled, f.product).errors, []);
  const bad = { ...f.definition, nameReadiness: POLICY };
  assert.throws(() => compileDefinition(bad), { code: 'TEMPLATE_INVALID' });
});
test('reviewed SV upgrade replaces only the official name-owned subject guard and refuses customized or shared checks', () => {
  const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
  const { officeCatalog } = require('./fixtures/magento-v1/office');
  const definition = materializeMagentoV1(officeCatalog(), { publicSku: true });
  const previous = compileDefinition(definition).hash;
  const next = upgradeNameReadiness(definition);
  assert.equal(compileDefinition(definition).hash, previous);
  const sv = next.groups.find(group => group.route === 'SV');
  assert.ok(!sv.evaluate.some(node => node.op === 'ref' && node.id === 'SV.nameCheck'));
  assert.ok(!(sv.outputChecks || []).some(entry => entry.rule.op === 'ref' && entry.rule.id === 'SV.nameCheck'));
  const customized = structuredClone(definition);
  customized.bindings.find(binding => binding.id === 'SV.nameCheck').value.error.message.value = 'Customized check';
  assert.throws(() => upgradeNameReadiness(customized), { code: 'TEMPLATE_INVALID' });
  const shared = require('../src/services/export-templates/column-contract').upgradeColumns(definition);
  shared.groups.find(group => group.route === 'SV').outputChecks.find(entry => entry.rule.id === 'SV.nameCheck').columns.push('price');
  assert.throws(() => upgradeNameReadiness(shared), { code: 'TEMPLATE_INVALID' });
});

test('full name overrides preserve exact text, require both languages and expire when their generated anchor changes', () => {
  const f = sample(true); const missing = evaluateProduct(f.compiled, f.product);
  assert.ok(missing.errors.some(issue => issue.code === 'effective_names_required'));
  const values = { all: ' Точна повна назва. ', en: ' Exact full name. ' };
  const product = { ...f.product, magento_name_override: { generated: missing.generatedNames, values } };
  const accepted = evaluateProduct(f.compiled, product);
  assert.equal(accepted.base.name, values.all); assert.equal(accepted.english.name, values.en);
  assert.deepEqual(accepted.errors, []);
  for (const override of [{ generated: { all: 'changed', en: 'changed' }, values },
    { generated: missing.generatedNames, values: { ...values, en: 'bad\nname' } }]) {
    assert.ok(evaluateProduct(f.compiled, { ...product, magento_name_override: override }).errors.some(issue => issue.field === 'name'));
  }
});
test('missing local names cannot authorize automatic import; explicit completion still rejects a changed remote identity', () => {
  const f = sample(true); const observation = { amber: { compiled: f.compiled, product: f.product, nameState: null },
    raw: { id: 41, sku: f.product.public_sku, name: 'Точна назва UA' },
    domainEvidence: { ukrainian: { fields: { name: 'Точна назва UA' } }, english: { fields: { name: 'Exact EN' } } } };
  assert.equal(decisionFor(observation).action, 'unavailable');
  const explicit = decisionFor(observation, { allowIncompleteAmber: true });
  assert.equal(explicit.action, 'completion_review'); assert.equal(explicit.remote.all, 'Точна назва UA');
  observation.amber.nameState = { remote_product_id: 42 };
  assert.equal(decisionFor(observation, { allowIncompleteAmber: true }).action, 'identity_changed');
});
test('explicit completion uses canonical all/en names consistently with later discovery and rejects inactive EN, identity drift and writes', async () => {
  const f = sample(true), config = { configured: true, baseUrl: 'https://names-fixture.invalid',
    consumerKey: 'fixture', consumerSecret: 'fixture', accessToken: 'fixture', accessTokenSecret: 'fixture' };
  const calls = []; let changed = false; let inactive = false;
  const fetchImpl = boundedGet(async (url, options) => {
    assert.equal(options.method, 'GET'); const path = new URL(url).pathname; calls.push(path);
    const value = path.endsWith('/store/storeViews') ? [{ id: 1, code: 'ua', is_active: true }, { id: 2, code: 'en', is_active: !inactive }]
      : { id: changed && path.includes('/en/') ? 42 : 41, sku: f.product.public_sku,
        name: path.includes('/ua/') ? 'Unused separate UA override' : path.includes('/en/') ? ' Exact English name ' : ' Українська основна назва ' };
    return new Response(JSON.stringify(path.endsWith('/store/storeViews') ? value : { items: [value], total_count: 1 }), { headers: { 'content-type': 'application/json' } });
  }, { maxRequests: 20 });
  const amber = { compiled: f.compiled, product: f.product };
  const observation = await readNames(config, amber, { fetchImpl, completion: true });
  assert.equal(calls.length, 3); assert.ok(!calls.some(path => path.includes('/ua/')));
  assert.equal(observation.raw.name, ' Українська основна назва ');
  assert.equal(observation.domainEvidence.english.fields.name, ' Exact English name ');
  const accepted = { all: observation.raw.name, en: observation.domainEvidence.english.fields.name };
  const generated = evaluateProduct(f.compiled, f.product).generatedNames;
  amber.product.magento_name_override = { generated, values: accepted };
  amber.nameState = { remote_product_id: 41, baseline_names: accepted };
  const beforeDiscovery = calls.length;
  const ordinary = await readNames(config, amber, { fetchImpl });
  assert.equal(calls.length - beforeDiscovery, 2);
  assert.equal(decisionFor(ordinary).action, 'confirm');
  changed = true; await assert.rejects(readNames(config, amber, { fetchImpl, completion: true }), { code: 'MAGENTO_NAME_IDENTITY_CHANGED' });
  changed = false; inactive = true; await assert.rejects(readNames(config, amber, { fetchImpl, completion: true }), { code: 'MAGENTO_NAME_STORE_UNAVAILABLE' });
  await assert.rejects(fetchImpl('https://names-fixture.invalid', { method: 'POST' }), { code: 'MAGENTO_DISCOVERY_GET_ONLY' });
});
