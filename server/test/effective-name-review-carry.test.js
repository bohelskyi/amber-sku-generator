const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/magento-successor');
const { upgradeColumns } = require('../src/services/export-templates/column-contract');
const { upgradeNameReadiness } = require('../src/services/export-templates/effective-product-names');
const { CHARACTERISTIC_EVALUATOR, CHARACTERISTIC_CONTRACT } = require('../src/services/export-templates/version-contract');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { stableReviewedSource, equivalentNameUpgrade } = require('../src/services/magento/integration-successor');
const { carryReviewedBindings, preserveDraftDecisions } = require('../src/services/magento/binding-carry-forward');

function setup(mode = 'fixed') {
  const f = fixture();
  const raw = mode === 'fixed' ? f.old : upgradeColumns(f.old);
  if (mode === 'native') { raw.evaluatorVersion = CHARACTERISTIC_EVALUATOR; raw.sourceContractVersion = CHARACTERISTIC_CONTRACT; }
  const old = compileDefinition(raw).definition, next = structuredClone(compileDefinition(upgradeNameReadiness(old)).definition);
  const target = { ...f.source, id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', bindings: f.candidates(next) };
  return { ...f, old, next, target };
}
function result(f) {
  const stable = stableReviewedSource(f.source, f.old, f.next, f.target.schema);
  const preserved = preserveDraftDecisions(stable, f.target);
  return carryReviewedBindings(preserved.source, f.target, f.next);
}

test('official raw and persisted name upgrades share unordered check ownership while changed ownership remains strict', () => {
  const f = fixture(), old = compileDefinition(f.old).definition;
  const rawUpgrade = structuredClone(compileDefinition(upgradeNameReadiness(f.old)).definition);
  assert.ok(equivalentNameUpgrade(old, rawUpgrade));
  const check = rawUpgrade.groups.find(g => g.route === 'SV').outputChecks.find(c => c.columns.length > 1);
  assert.ok(check); check.columns.pop();
  assert.equal(equivalentNameUpgrade(old, rawUpgrade), null);
});

for (const mode of ['fixed', 'editable', 'native']) test(`official names upgrade from ${mode} preserves non-name approvals, seven routes and original decisions`, () => {
  const f = setup(mode), original = structuredClone(f.source);
  const carried = carryReviewedBindings(stableReviewedSource(f.source, f.old, f.next, f.schema), f.target, f.next);
  assert.deepEqual(carried.blockers, []);
  for (const route of carried.bindings.routes) assert.equal(route.reviewState, 'approved');
  assert.equal(carried.bindings.routes.length, 7);
  for (const attribute of carried.bindings.attributes) {
    if (attribute.target === 'name') { assert.notEqual(attribute.reviewState, 'approved'); continue; }
    assert.equal(attribute.reviewState, 'approved', `${attribute.routeKey}/${attribute.rowId}/${attribute.target}`);
    for (const policy of carried.bindings.policies.filter(p => p.bindingKey === attribute.bindingKey)) assert.equal(policy.reviewState, 'approved');
  }
  assert.equal(carried.bindings.attributes.filter(a => a.target === 'name').length, 14);
  assert.ok(equivalentNameUpgrade(f.old, f.next));
  assert.deepEqual(f.source, original);
});

test('names upgrade equivalence refuses business edits and cannot inherit approval for the changed field', () => {
  const f = setup();
  f.next.groups.find(g => g.route === 'BR').rows[0].cells.price = { op: 'literal', value: '999' };
  f.target.bindings = f.candidates(f.next);
  assert.equal(equivalentNameUpgrade(f.old, f.next), null);
  const carried = result(f);
  assert.ok(carried.bindings.attributes.filter(a => a.routeKey.startsWith('BR') && a.target === 'price').every(a => a.reviewState !== 'approved'));
});

test('official names equivalence keeps remote identity and store guards', () => {
  const f = setup();
  f.target.schema = structuredClone(f.schema);
  f.target.schema.attributes.find(a => a.attribute_code === 'kolir').attribute_id++;
  const carried = result(f);
  assert.ok(carried.bindings.attributes.filter(a => a.target === 'kolir').every(a => a.reviewState !== 'approved'));
  const drift = setup(); drift.target.schema = structuredClone(drift.schema);
  drift.target.schema.storeTopology.storeViews[0].id++;
  assert.ok(result(drift).bindings.attributes.filter(a => a.rowId === 'english').every(a => a.reviewState !== 'approved'));
});

test('existing draft approvals, changed selections, explicit blocks and ownership choices survive reviewed carry', () => {
  const f = setup();
  const pending = f.target.bindings.options.filter(o => o.sourceKind === 'semantic' && o.optionId && o.reviewState === 'proposed'
    && f.target.bindings.options.filter(other => other.bindingKey === o.bindingKey && other.evaluatedOutput === o.evaluatedOutput).length === 1).slice(0, 3);
  assert.equal(pending.length, 3);
  const chosen = pending[0], attr = f.target.bindings.attributes.find(a => a.bindingKey === chosen.bindingKey);
  f.target.schema = structuredClone(f.schema);
  const alternateId = '999999';
  f.target.schema.attributes.find(a => a.attribute_code === attr.attributeCode).options.push({ value: alternateId, label: chosen.evaluatedOutput });
  chosen.optionId = alternateId; chosen.reviewState = 'review_required'; chosen.evidence.diagnosticCodes = ['EXPLICIT_CANDIDATE_SELECTION'];
  pending[1].reviewState = 'approved'; pending[1].evidence.note = 'Reviewed in this draft';
  pending[2].reviewState = 'blocked'; pending[2].evidence.note = 'Explicit current refusal';
  const policy = f.target.bindings.policies.find(p => f.target.bindings.attributes.find(a => a.bindingKey === p.bindingKey)?.target === 'price');
  policy.policy = 'magento_managed'; policy.reviewState = 'approved'; policy.evidence.note = 'Current ownership choice';
  const name = f.target.bindings.attributes.find(a => a.target === 'name'); name.reviewState = 'approved'; name.evidence.note = 'Reviewed new name policy';
  const before = structuredClone(f.target), source = structuredClone(f.source);
  const carried = result(f);
  assert.deepEqual(carried.blockers, []);
  for (const option of pending) assert.deepEqual(carried.bindings.options.find(o => o.sourceKind === option.sourceKind && o.bindingKey === option.bindingKey && o.sourceKey === option.sourceKey), option);
  assert.deepEqual(carried.bindings.policies.find(p => p.bindingKey === policy.bindingKey && p.storeCode === policy.storeCode), policy);
  assert.deepEqual(carried.bindings.attributes.find(a => a.bindingKey === name.bindingKey), name);
  assert.deepEqual(f.target, before); assert.deepEqual(f.source, source);
});

test('redundant selection of the already-approved exact identity inherits approval without another click', () => {
  const f = setup(), option = f.target.bindings.options.find(o => o.sourceKind === 'semantic' && o.optionId && o.reviewState === 'proposed');
  option.reviewState = 'review_required'; option.evidence.diagnosticCodes = ['EXPLICIT_CANDIDATE_SELECTION'];
  const carried = result(f);
  assert.equal(carried.bindings.options.find(o => o.bindingKey === option.bindingKey && o.sourceKey === option.sourceKey).reviewState, 'approved');
});

test('an explicit changed draft route retains its set and cannot inherit old child scope approvals', () => {
  const f = setup(), route = f.target.bindings.routes.find(r => r.routeKey.startsWith('BR'));
  const old = f.source.bindings.routes.find(r => r.routeKey === route.routeKey);
  route.setId = f.schema.attributeSets.find(s => s.attribute_set_id !== old.setId).attribute_set_id;
  route.reviewState = 'review_required'; route.evidence.diagnosticCodes = ['EXPLICIT_CANDIDATE_SELECTION'];
  const carried = result(f);
  assert.equal(carried.bindings.routes.find(r => r.routeKey === route.routeKey).setId, route.setId);
  assert.equal(carried.bindings.routes.find(r => r.routeKey === route.routeKey).reviewState, 'review_required');
  assert.ok(carried.bindings.attributes.filter(a => a.routeKey === route.routeKey).every(a => a.reviewState !== 'approved'));
});
