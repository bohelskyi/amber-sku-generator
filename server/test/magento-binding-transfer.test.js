const test = require('node:test');
const assert = require('node:assert/strict');
const { homeDefinition, officeEvidence } = require('./fixtures/export-source-support');
const { upgradeSourceSupport } = require('../src/services/export-templates/source-support');
const { compileDefinition } = require('../src/services/export-templates/definition');
const transfer = require('../src/services/magento/binding-transfer');
const transferCli = require('../scripts/magento-binding-transfer');

function sourceArtifact() {
  const definition = upgradeSourceSupport(homeDefinition(), officeEvidence());
  const policy = definition.sourceSupport.sources['AR.size'];
  policy.semanticValues.push(...policy.deferredValues);
  policy.deferredValues = [];
  return { template: { definition: compileDefinition(definition).definition } };
}

function target(evidence, count = 0) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM categories')) return { rows: [evidence] };
    if (sql.includes("status='active'")) return { rows: [{ count }] };
    assert.fail(`Unexpected query: ${sql}`);
  } };
}

test('binding transfer explicitly demotes only target-unproven AR size values 29/30/31', async () => {
  const artifact = sourceArtifact(); const evidence = officeEvidence(); const client = target(evidence);
  const result = await transfer.reconcileTargetSourceSupport(client, artifact);
  assert.deepEqual(result.definition.sourceSupport.sources['AR.size'].semanticValues,
    artifact.template.definition.sourceSupport.sources['AR.size'].semanticValues.filter((v) => !['29', '30', '31'].includes(v)));
  assert.deepEqual(result.definition.sourceSupport.sources['AR.size'].deferredValues, ['29', '30', '31']);
  const unchanged = structuredClone(result.definition); unchanged.sourceSupport = artifact.template.definition.sourceSupport;
  assert.deepEqual(unchanged, artifact.template.definition);
  assert.equal(result.demotions.length, 3);
  assert.equal(client.calls.filter((call) => call.sql.includes("status='active'")).length, 3);
  assert.equal(transferCli.parse(['import', '--artifact', 'a.json', '--expected-hash', 'a'.repeat(64),
    '--expected-database', 'amber', '--installation', 'prod', '--actor-user-id', '7']).reconcileTargetSourceSupport, undefined);
  assert.equal(transferCli.parse(['import', '--reconcile-target-source-support', '--artifact', 'a.json',
    '--expected-hash', 'a'.repeat(64), '--expected-database', 'amber', '--installation', 'prod',
    '--actor-user-id', '7']).reconcileTargetSourceSupport, true);
});

test('binding transfer rejects source-support adaptation outside the closed deferred policy', async () => {
  const artifact = sourceArtifact(); const evidence = officeEvidence();
  evidence.schemas.find((row) => row.category_code === 'AR').questions[0].value_ids =
    evidence.schemas.find((row) => row.category_code === 'AR').questions[0].value_ids.filter((v) => v !== '28');
  await assert.rejects(transfer.reconcileTargetSourceSupport(target(evidence), artifact),
    { code: 'MAGENTO_BINDING_SOURCE_RECONCILIATION_UNSUPPORTED' });
});
