const test = require('node:test');
const assert = require('node:assert/strict');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { compileDefinition, hashJsonData } = require('../src/services/export-templates/definition');
const { sourceSupportUpdate, upgradeSourceSupport, VERSION, EVALUATOR } = require('../src/services/export-templates/source-support');
const { prepareMagentoCandidate, systemProfile, prepareSourceSupport, prepareDraft } = require('../src/services/export-templates/template.service');
const { officeCatalog, officeEvidence } = require('./fixtures/magento-v1/office');
const { homeDefinition } = require('./fixtures/export-source-support');
const { product } = require('./fixtures/magento-v1/contract');
const { evaluateBatch } = require('../src/services/export-templates/evaluate');
const id = '11111111-1111-4111-8111-111111111111';

// Exercise the real service/materializer with synthetic authoritative read rows.
// Unexpected SQL (including writes) fails immediately; no database is contacted.
function reads(definition, evidence = officeEvidence()) {
  const row = { template_id: id, revision: '7', definition };
  const queries = [];
  const client = { release() {}, async query(sql) {
    queries.push(sql);
    if (['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM export_template_drafts')) return { rows: [row] };
    if (sql.includes('AS categories')) return { rows: [evidence] };
    if (sql.includes('LEFT JOIN options')) return { rows: [...officeCatalog()].flatMap(([category_code, questions]) =>
      [...questions].flatMap(([key, q]) => (q.options.length ? q.options : [{ value_id: null }]).map((o) =>
        ({ category_code, key, required: q.required, visible_if_json: q.visible_if_json, value_id: o.value_id })))) };
    assert.fail('Unexpected SQL: ' + sql);
  } };
  return { options: { databasePool: { async connect() { return client; } } }, queries,
    pre: { expectedRevision: row.revision, expectedDefinitionHash: hashJsonData(definition) } };
}

test('SUPPORT lifecycle current candidate starts coherent/current; ordinary system profile stays legacy/read-only', async () => {
  const legacy = materializeMagentoV1(officeCatalog()); const before = structuredClone(legacy);
  const db = reads(legacy);
  const current = await prepareMagentoCandidate(db.options);
  assert.equal(current.definition.sourceSupport.version, VERSION);
  assert.equal(current.definition.evaluatorVersion, EVALUATOR);
  assert.equal(current.definitionHash, compileDefinition(current.definition).hash);
  assert.deepEqual(current.diagnostics, []);
  assert.equal(sourceSupportUpdate(current.definition).status, 'current');
  const system = await systemProfile(db.options);
  assert.deepEqual(system.definition, legacy);
  assert.equal(system.definition.sourceSupport, undefined);
  assert.equal(system.definitionHash, hashJsonData(legacy));
  const explicit = await prepareMagentoCandidate({ ...db.options, supportPolicy: VERSION });
  assert.deepEqual(explicit, current, 'existing explicit callers remain compatible');
  assert.deepEqual(legacy, before);
  await assert.rejects(prepareMagentoCandidate({ ...db.options, supportPolicy: 'future' }), { code: 'TEMPLATE_COMMAND_INVALID' });
});

test('SUPPORT lifecycle new current draft has a read-only, non-actionable proposal', async () => {
  const current = (await prepareMagentoCandidate(reads(homeDefinition()).options)).definition;
  const db = reads(current); const before = structuredClone(current);
  const proposal = await prepareSourceSupport(id, db.pre, db.options);
  assert.equal(proposal.changed, false);
  assert.equal(proposal.sourceSupportUpdate.status, 'current');
  assert.deepEqual(proposal.definition, before);
  assert.deepEqual(current, before);
  assert.equal(proposal.definitionHash, db.pre.expectedDefinitionHash);
});

test('SUPPORT lifecycle legacy save is exact; explicit proposal preserves all custom output/readiness structure', async () => {
  const old = homeDefinition(); const br = old.groups[0];
  old.tables.localColor = { ...old.tables.color4, 4: '  Frozen custom output\n ' };
  br.rows[0].cells.test_export_color.table = 'localColor';
  br.rows[1].cells.test_export_note = { op: 'literal', value: 'Independent EN' };
  const before = structuredClone(old); const hash = hashJsonData(old);
  assert.equal(sourceSupportUpdate(old).status, 'available');
  assert.deepEqual(prepareDraft(old), { definition: before, hash });
  const db = reads(old); const proposal = await prepareSourceSupport(id, db.pre, db.options);
  assert.equal(proposal.changed, true);
  assert.equal(proposal.sourceSupportUpdate.status, 'available');
  const restored = structuredClone(proposal.definition);
  delete restored.sourceSupport; restored.evaluatorVersion = old.evaluatorVersion;
  assert.deepEqual(restored, before);
  assert.deepEqual(old, before);
  assert.notEqual(proposal.definitionHash, hash);
  const p = product('BR', { color: 4 });
  assert.deepEqual(evaluateBatch(compileDefinition(proposal.definition), [p]), evaluateBatch(compileDefinition(old), [p]));
});

test('SUPPORT lifecycle catalog/schema drift is not a current-policy update or deferred promotion', async () => {
  const current = upgradeSourceSupport(homeDefinition(), officeEvidence()); const hash = hashJsonData(current);
  const evidence = officeEvidence();
  evidence.questions.find((q) => q.category_code === 'AR' && q.key === 'size').label = 'Renamed size';
  evidence.questions.find((q) => q.category_code === 'AR' && q.key === 'size').value_ids.push('32');
  evidence.schemas.push({ id: 999, category_code: 'AR', questions: [{ key: 'size', value_ids: ['29', '30', '31', '32'] }] });
  const db = reads(current, evidence); const proposal = await prepareSourceSupport(id, db.pre, db.options);
  assert.equal(proposal.sourceSupportUpdate.status, 'current');
  assert.equal(proposal.changed, false);
  assert.equal(proposal.definitionHash, hash);
  assert.deepEqual(proposal.definition, current);
  assert.deepEqual(current.sourceSupport.sources['AR.size'].deferredValues, ['29', '30', '31']);
});

test('SUPPORT lifecycle unsupported definitions remain intact and preparation fails closed; conflicts stay distinct', async () => {
  const current = upgradeSourceSupport(homeDefinition(), officeEvidence());
  const aliasedLegacy = homeDefinition();
  aliasedLegacy.sources['NM.extra'].aliases = [{ key: 'older_extra', schemaId: '12', evidence: 'Synthetic alias' }];
  compileDefinition(aliasedLegacy); // Valid legacy shape, unsupported by the closed support policy.
  for (const bad of [{}, { ...current, sourceSupport: { ...current.sourceSupport, version: 'future' } },
    { ...current, evaluatorVersion: 'future' }, { ...current, sourceSupport: null }, aliasedLegacy]) {
    const before = structuredClone(bad);
    assert.equal(sourceSupportUpdate(bad).status, 'unsupported');
    assert.deepEqual(prepareDraft(bad).definition, before, 'safe incomplete drafts still save without rewriting');
    const db = reads(bad);
    await assert.rejects(prepareSourceSupport(id, db.pre, db.options), { code: 'TEMPLATE_INVALID' });
    assert.deepEqual(bad, before);
  }
  const db = reads(current);
  await assert.rejects(prepareSourceSupport(id, { ...db.pre, expectedRevision: '6' }, db.options), { code: 'TEMPLATE_DRAFT_CONFLICT' });
});
