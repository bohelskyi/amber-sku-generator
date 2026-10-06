const test = require('node:test');
const assert = require('node:assert/strict');
const { upgradeRequirement, CODE } = require('../src/services/magento/native-characteristic-upgrade');
const { safeDiagnostics, presentProblem } = require('../src/services/magento/sync-problems');
const { planPreview } = require('../src/services/magento/sync-preview');
const { evaluate } = require('../src/services/magento/binding-evidence-products');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { projectSupportProducts, upgradeSourceSupport } = require('../src/services/export-templates/source-support');
const { upgradeColumns } = require('../src/services/export-templates/column-contract');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { officeCatalog, officeEvidence } = require('./fixtures/magento-v1/office');
const { product } = require('./fixtures/magento-v1/contract');
const bindingFixture = require('./fixtures/magento-bindings');

function fixture(category, value) {
  const definition = upgradeSourceSupport(upgradeColumns(materializeMagentoV1(officeCatalog(), { publicSku: true })), officeEvidence());
  definition.evaluatorVersion = 'magento-declarative-4';
  const key = category === 'NM' ? 'extra' : 'size';
  const p = product(category, { [key]: value }, { full_sku: null, public_sku: 'AG-000123', characteristic_version_id: '900' });
  const version = { id: '900', category_code: category, questions: [{ key, options: [{ value_id: value }] }] };
  const amber = { compiled: compileDefinition(definition), product: projectSupportProducts([p], [], [version])[0] };
  return { definition, key, version, amber };
}

for (const [category, value] of [['NM', 1], ['AR', 28]]) {
  test(`${category} actual frozen evaluator blocker survives planner/storage as configuration upgrade`, () => {
    const { amber, definition, key } = fixture(category, value);
    const expected = evaluate(amber, amber.product);
    assert.deepEqual(upgradeRequirement(definition, amber.product, expected), { diagnostic: { code: CODE }, question: key });
    const planned = planPreview(amber, bindingFixture.schema(), null, []);
    const blocker = planned.blockers.find((item) => item.code === 'PRODUCT_EVALUATION_NOT_READY');
    assert.equal(blocker.diagnostic.code, CODE);
    const [safe] = safeDiagnostics([blocker]);
    const presented = presentProblem(safe);
    assert.equal(presented.resolution, 'integration_configuration');
    assert.equal(presented.question, key);
    assert.equal(planned.sendable, false);
    assert.match(presented.message, /підготувати, перевірити й застосувати/);
  });
}

test('v5 deferred AR size, invalid input and unrelated readiness remain product problems', () => {
  const { definition, amber, version } = fixture('AR', 29);
  definition.evaluatorVersion = 'magento-declarative-5';
  definition.sourceContractVersion = 'public-product-characteristics-v1';
  amber.compiled = compileDefinition(definition);
  amber.product = projectSupportProducts([amber.product], [], [version])[0];
  const expected = evaluate(amber, amber.product);
  assert.equal(expected.ready, false);
  assert.equal(upgradeRequirement(definition, amber.product, expected), null);
  assert.equal(presentProblem({ code: 'PRODUCT_EVALUATION_NOT_READY', evaluationIssues: expected.evaluationIssues }).resolution, 'product');
  const invalid = fixture('NM', '00');
  assert.equal(upgradeRequirement(invalid.definition, invalid.amber.product, evaluate(invalid.amber, invalid.amber.product)), null);
  assert.equal(presentProblem({ code: 'PRODUCT_EVALUATION_NOT_READY', diagnosticCode: CODE, question: 'extra',
    evaluationIssues: [{ code: 'SOURCE_SUPPORT_INVALID', field: 'sourceSupport', message: 'NM.extra: invalid semantic value' }] }).resolution, 'product');
});

test('upgrade routing requires actual native product and old public evaluator, not a claimed issue alone', () => {
  const { definition, amber } = fixture('NM', 1);
  const expected = evaluate(amber, amber.product);
  for (const p of [{ ...amber.product, full_sku: 'NMlegacy' }, { ...amber.product, characteristic_version_id: null }, { ...amber.product, category: 'BR' }]) {
    assert.equal(upgradeRequirement(definition, p, expected), null);
  }
  for (const evaluatorVersion of ['magento-declarative-1', 'magento-declarative-2', 'magento-declarative-5']) {
    assert.equal(upgradeRequirement({ ...definition, evaluatorVersion }, amber.product, expected), null);
  }
});
