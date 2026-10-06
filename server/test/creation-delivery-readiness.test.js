const test = require('node:test');
const assert = require('node:assert/strict');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { upgradeColumns } = require('../src/services/export-templates/column-contract');
const { upgradeSourceSupport } = require('../src/services/export-templates/source-support');
const { officeCatalog, officeEvidence } = require('./fixtures/magento-v1/office');
const { product } = require('./fixtures/magento-v1/contract');
const { originHash } = require('../src/services/magento/binding-contract');
const { SCOPE, upgradeIssue, readCreationDeliveryReadiness, readCreationIntegrationReadiness } = require('../src/services/product/creation-delivery-readiness');

const config = { configured: true, baseUrl: 'https://creation-readiness.invalid' };
function definition(version = 'magento-declarative-4') {
  const d = upgradeSourceSupport(upgradeColumns(materializeMagentoV1(officeCatalog(), { publicSku: true })), officeEvidence());
  d.evaluatorVersion = version;
  if (version === 'magento-declarative-5') d.sourceContractVersion = 'public-product-characteristics-v1';
  return d;
}
function preview(category, answer) {
  const key = category === 'NM' ? 'extra' : 'size';
  return { normalizedAnswers: product(category, { [key]: answer }).details.answers, weightVal: 10, totalPriceUah: 100 };
}
function database(d = definition()) {
  const compiled = compileDefinition(d);
  const template = { id: 'template-version', template_id: 'template-family', definition: d,
    definition_hash: compiled.hash, evaluator_version: d.evaluatorVersion, output_contract: d.outputContract, format_version: d.formatVersion };
  const binding = { id: 'current-binding', origin_hash: originHash(config.baseUrl), template_id: template.template_id,
    template_version_id: template.id, template_definition_hash: compiled.hash,
    evaluator_version: d.evaluatorVersion, output_contract: d.outputContract, format_version: d.formatVersion };
  const row = { activation: { enabled: true, legacy_product_csv_enabled: false }, binding, template };
  const queries = [];
  return { row, queries, async query(sql) { queries.push(sql); assert.match(sql, /^SELECT /); return { rows: [row] }; } };
}

for (const evaluatorVersion of ['magento-declarative-3', 'magento-declarative-4']) {
  for (const [category, answer, question] of [['NM', 1, 'extra'], ['AR', 28, 'size']]) {
    test(`${evaluatorVersion} ${category} reports exact native upgrade need before any product/SKU allocation`, async () => {
      const db = database(definition(evaluatorVersion));
      const result = await readCreationDeliveryReadiness(db, category, preview(category, answer), { config });
      assert.equal(result.status, 'configuration_required'); assert.equal(result.code, 'NATIVE_CHARACTERISTICS_UPGRADE_REQUIRED');
      assert.equal(result.scope, SCOPE); assert.equal(result.questionKey, question);
      assert.equal(result.bindingRevisionId, 'current-binding'); assert.equal(result.targetContract, 'public-product-characteristics-v1');
      assert.match(result.message, /можна зберегти локально/);
      assert.equal(db.queries.length, 1); assert.ok(!JSON.stringify(result).includes('AG-'));
    });
  }
}

test('v5 deferred AR, malformed NM answers and unrelated categories never become old-evaluator upgrade blockers', async () => {
  assert.equal(upgradeIssue(compileDefinition(definition('magento-declarative-5')), 'AR', preview('AR', 29)), null);
  assert.equal(upgradeIssue(compileDefinition(definition()), 'NM', preview('NM', '00')), null);
  assert.equal(upgradeIssue(compileDefinition(definition()), 'BR', preview('BR', 1)), null);
  const db = database(definition('magento-declarative-5'));
  const result = await readCreationDeliveryReadiness(db, 'AR', preview('AR', 29), { config });
  assert.equal(result.status, 'configuration_required'); assert.equal(result.code, 'SOURCE_SUPPORT_DEFERRED_VALUE');
  assert.equal(result.valueId, '29'); assert.equal(result.targetContract, undefined);
  assert.equal(result.scope, SCOPE); assert.equal(result.ready, undefined);
});

test('authoritative frozen deferred values stay visibly pending before v3/v4/v5 local creation', async () => {
  for (const evaluator of ['magento-declarative-3', 'magento-declarative-4', 'magento-declarative-5']) {
    for (const value of [29, 30, 31]) {
      const result = await readCreationDeliveryReadiness(database(definition(evaluator)), 'AR', preview('AR', value), { config });
      assert.equal(result.code, 'SOURCE_SUPPORT_DEFERRED_VALUE'); assert.equal(result.status, 'configuration_required');
      assert.equal(result.valueId, String(value)); assert.equal(result.targetContract, undefined);
    }
  }
  const p = preview('AR', '029');
  assert.notEqual((await readCreationDeliveryReadiness(database(), 'AR', p, { config })).code, 'SOURCE_SUPPORT_DEFERRED_VALUE');
});

test('missing/disabled/wrong-origin/corrupt publication reports not checked and never claims readiness', async () => {
  for (const mutate of [db => { db.row.activation.enabled = false; }, db => { db.row.binding = null; },
    db => { db.row.binding.origin_hash = '0'.repeat(64); }, db => { db.row.template.definition_hash = '0'.repeat(64); }]) {
    const db = database(); mutate(db);
    const result = await readCreationDeliveryReadiness(db, 'NM', preview('NM', 1), { config });
    assert.equal(result.status, 'not_checked'); assert.equal(result.ready, undefined); assert.equal(result.code, null);
  }
  const db = database();
  assert.equal((await readCreationDeliveryReadiness(db, 'NM', preview('NM', 1), { config: { configured: false } })).status, 'not_checked');
  assert.equal((await readCreationDeliveryReadiness(db, 'KL', {}, { config })).status, 'not_checked');
  assert.equal(db.queries.length, 0);
});

test('absent native NM answer does not invent a zero placeholder or upgrade requirement', () => {
  const p = preview('NM', 1); delete p.normalizedAnswers.extra;
  assert.equal(upgradeIssue(compileDefinition(definition()), 'NM', p), null);
});
test('extended creation diagnostic identifies an exact missing category or consumed semantic value without inferring unused questions', async () => {
  const d = require('./fixtures/magento-v4').definition();
  const missingCategory = await readCreationIntegrationReadiness(database(d),'NEW',{normalizedAnswers:{}},{config});
  assert.equal(missingCategory.code,'MAGENTO_CATEGORY_NOT_LINKED');
  assert.equal(missingCategory.questionKey,null);assert.equal(missingCategory.valueId,null);
  const missingValue = await readCreationIntegrationReadiness(database(d),'XG',{normalizedAnswers:{new_color:8}},{config});
  assert.equal(missingValue.code,'MAGENTO_SOURCE_VALUE_NOT_LINKED');
  assert.equal(missingValue.questionKey,'new_color');assert.equal(missingValue.valueId,'8');
  const unused = await readCreationIntegrationReadiness(database(d),'XG',{normalizedAnswers:{unmapped_local_question:9}},{config});
  assert.equal(unused.status,'no_native_upgrade_blocker');assert.equal(unused.ready,undefined);
});
