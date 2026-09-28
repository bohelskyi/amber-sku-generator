const test = require('node:test');
const assert = require('node:assert/strict');
const { homeDefinition, officeEvidence } = require('./fixtures/export-source-support');
const { upgradeSourceSupport } = require('../src/services/export-templates/source-support');
const { compileDefinition } = require('../src/services/export-templates/definition');
const transfer = require('../src/services/magento/binding-transfer');
const transferCli = require('../scripts/magento-binding-transfer');
const bindingFixture = require('./fixtures/magento-bindings');
const { hash } = require('../src/services/magento/binding-contract');
const { normalizeBindings, validateBindings } = require('../src/services/magento/binding-validation');

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

test('binding transfer rebases only evaluated identities after target source-support reconciliation', () => {
  const sourceDefinition = bindingFixture.definition(); const targetDefinition = structuredClone(sourceDefinition);
  targetDefinition.sourceSupport = { version: 'target-test-only', sources: {} };
  const sourceBindings = normalizeBindings(bindingFixture.approvedBindings(sourceDefinition, bindingFixture.schema()));
  const artifact = { template: { definition: sourceDefinition, definitionHash: hash(sourceDefinition) },
    schema: bindingFixture.schema(), bindings: sourceBindings, source: { bindingHash: hash(sourceBindings) } };
  const target = { definition: targetDefinition, definitionHash: hash(targetDefinition) };
  const result = transfer.rebaseEvaluatedOptionIdentities(artifact, target);
  assert.equal(result.rebased, true); assert.equal(result.bindings.options.length, sourceBindings.options.length);
  assert.deepEqual(result.bindings.routes, sourceBindings.routes);
  assert.deepEqual(result.bindings.attributes, sourceBindings.attributes);
  assert.deepEqual(result.bindings.policies, sourceBindings.policies);
  const sourceSemantic = sourceBindings.options.filter((option) => option.sourceKind === 'semantic');
  assert.deepEqual(result.bindings.options.filter((option) => option.sourceKind === 'semantic'), sourceSemantic);
  for (const original of sourceBindings.options.filter((option) => option.sourceKind === 'evaluated')) {
    const rebased = result.bindings.options.find((option) => option.bindingKey === original.bindingKey
      && option.outputKey === original.outputKey && option.evaluatedOutput === original.evaluatedOutput);
    assert.ok(rebased); assert.notEqual(rebased.domainKey, original.domainKey);
    assert.notEqual(rebased.sourceKey, original.sourceKey);
    const { domainKey: _oldDomain, sourceKey: _oldSource, ...oldDecision } = original;
    const { domainKey: _newDomain, sourceKey: _newSource, ...newDecision } = rebased;
    assert.deepEqual(newDecision, oldDecision);
  }
  assert.equal(validateBindings(result.bindings, targetDefinition, artifact.schema, { publish: true }).valid, true);
  assert.deepEqual(transfer.rebaseEvaluatedOptionIdentities(artifact, artifact.template),
    { bindings: artifact.bindings, targetBindingHash: artifact.source.bindingHash, rebased: false });
});

test('binding transfer rejects evaluated rebase when evaluator output or cardinality changes', () => {
  const sourceDefinition = bindingFixture.definition();
  const sourceBindings = normalizeBindings(bindingFixture.approvedBindings(sourceDefinition, bindingFixture.schema()));
  const artifact = { template: { definition: sourceDefinition, definitionHash: hash(sourceDefinition) },
    schema: bindingFixture.schema(), bindings: sourceBindings, source: { bindingHash: hash(sourceBindings) } };
  for (const mutate of [
    (definition) => { definition.groups[0].rows[0].cells.name.value = 'Changed output'; },
    (definition) => { delete definition.groups[0].rows[0].cells.dovzhyna_brasletu_diuimiv; },
  ]) {
    const definition = structuredClone(sourceDefinition); definition.sourceSupport = { version: 'target-test-only', sources: {} }; mutate(definition);
    assert.throws(() => transfer.rebaseEvaluatedOptionIdentities(artifact,
      { definition, definitionHash: hash(definition) }), { code: 'MAGENTO_BINDING_EVALUATED_REBASE_UNSUPPORTED' });
  }
});
