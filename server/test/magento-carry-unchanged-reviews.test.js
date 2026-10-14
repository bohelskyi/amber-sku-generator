'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const review = require('../src/services/magento/binding-review');
const script = require('../scripts/magento-carry-unchanged-reviews');

const key = 'SV.souvenir=value_id:5/base/kolir';
function revision({ id, state, reviewState, optionId = '5', policy = 'authoritative_create_update', extraTarget = false }) {
  const attribute = (target, bindingKey) => ({ bindingKey, routeKey: 'SV.souvenir=value_id:5', rowId: 'base', target,
    attributeCode: target, reviewState, evidence: {} });
  return { id, state, revision: '3', installationKey: 'amber',
    schema: { attributeSets: [], attributes: [{ attribute_code: 'kolir', attribute_id: 10, options: [{ value: '5', label: 'Світлий' }, { value: '6', label: 'Темний' }] },
      { attribute_code: 'suveniry', attribute_id: 11, options: [] }] },
    bindings: { routes: [],
      attributes: [attribute('kolir', key), ...(extraTarget ? [attribute('suveniry', 'SV.souvenir=value_id:5/base/suveniry')] : [])],
      options: [{ bindingKey: key, sourceKey: { kind: 'semantic', questionKey: 'color', valueId: '1' }, optionId, evaluatedOutput: 'Світлий', reviewState, evidence: {} }],
      policies: [{ bindingKey: key, storeCode: 'all', policy, reviewState, evidence: {} }] } };
}
const source = revision({ id: 'source', state: 'published', reviewState: 'approved', extraTarget: true });
const common = { group: 'SV', targets: ['kolir'] };

test('only pending decisions identical to the approved source decision are planned', () => {
  const draft = revision({ id: 'draft', state: 'draft', reviewState: 'review_required', extraTarget: true });
  const planned = script.plan(review, source, draft, common);
  assert.deepEqual(planned.identical.map((d) => d.kind).sort(), ['attribute', 'option', 'policy']);
  assert.equal(planned.identical.find((d) => d.kind === 'policy').policy, 'authoritative_create_update');
  const changed = revision({ id: 'draft', state: 'draft', reviewState: 'proposed', optionId: '6' });
  const differing = script.plan(review, source, changed, common);
  assert.deepEqual(differing.different.map((d) => d.kind), ['option'], 'a different Magento option ID is never auto-approved');
  const sourceBlocked = revision({ id: 'source', state: 'published', reviewState: 'blocked' });
  assert.equal(script.plan(review, sourceBlocked, draft, common).notApprovedInSource.length, 3);
});

test('apply approves identical decisions through the canonical decision with reason and policy', async () => {
  let stored = revision({ id: 'draft', state: 'draft', reviewState: 'review_required', extraTarget: true });
  const updates = [];
  const bindings = {
    async updateDraft(_id, input) { updates.push(input.expectedRevision); stored = { ...stored, bindings: input.bindings, revision: String(Number(stored.revision) + 1) }; return stored; },
  };
  const lines = [];
  const pool = { async query() { return { rows: [{ name: 'amber_test' }] }; } };
  const uuid = '11111111-1111-4111-8111-111111111111';
  const args = ['--mode', 'apply', '--expected-database', 'amber_test', '--actor-id', '1', '--source', uuid, '--draft', uuid,
    '--group', 'SV', '--targets', 'kolir', '--reason', 'Unchanged mapping after optional-when-absent template'];
  // The script reads the source first; every later read is the draft.
  let reads = 0;
  bindings.getRevision = async () => structuredClone(reads++ === 0 ? source : stored);
  const code = await script.main(args, { pool, review, bindings, print: (l) => lines.push(JSON.parse(l)), printError: (l) => lines.push(JSON.parse(l)) });
  assert.equal(code, 0, JSON.stringify(lines));
  assert.equal(updates.length, 3);
  assert.deepEqual(updates, ['3', '4', '5'], 'each decision uses the current draft counter');
  assert.ok(stored.bindings.attributes.filter((a) => a.target === 'kolir').every((a) => a.reviewState === 'approved'));
  assert.equal(stored.bindings.attributes.find((a) => a.target === 'suveniry').reviewState, 'review_required', 'other targets untouched');
  assert.equal(stored.bindings.policies[0].policy, 'authoritative_create_update');
  assert.equal(stored.bindings.options[0].evidence.note, 'Unchanged mapping after optional-when-absent template');
  assert.equal(lines.at(-1).kind, 'carry_review_done');
});
