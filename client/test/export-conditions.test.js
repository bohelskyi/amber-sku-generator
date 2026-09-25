import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { assembleConditions, buildConditionPredicate, conditionChain, conditionPredicate } from '../src/lib/export-template-conditions.js';
import { editField } from '../src/lib/export-template-presentation.js';
const require = createRequire(import.meta.url);
const { materializeMagentoV1 } = require('../../server/src/services/export-templates/magento-v1-definition');
const { compileDefinition, hashJsonData } = require('../../server/src/services/export-templates/definition');
const { evaluateProduct } = require('../../server/src/services/export-templates/evaluate');
const { catalog, product } = require('../../server/test/fixtures/magento-v1/contract');
const literal = (value) => ({ op: 'literal', value });
const baseline = () => materializeMagentoV1(catalog());
const path = ['groups', 4, 'rows', 0, 'cells', 'meta_description'];
const input = { op: 'semanticKey', input: { op: 'source', id: 'AR.type' } };
const predicate = (value) => buildConditionPredicate({ input, operator: 'eq', value });
const when = (value, then, otherwise = literal('default')) => ({ op: 'when', if: predicate(value), then, else: otherwise });
const result = (d, type = 2, overrides = {}) => evaluateProduct(compileDefinition(d), product('AR', { type }, overrides));

test('condition lenses preserve ref chains, unknown children and canonical hash without an edit', () => {
  const d = baseline(); const custom = { op: 'future', unknown: [null, 0, '0', ' ', ''] };
  d.bindings.push({ id: 'test.condition', group: 'AR', value: when('1', custom, literal('else')) });
  const tree = when('2', literal('landscape'), { op: 'ref', id: 'test.condition' });
  d.groups[4].rows[0].cells.meta_description = tree;
  const hash = hashJsonData(d); const chain = conditionChain(d, tree);
  assert.equal(chain.rows.length, 2); assert.equal(chain.rows[1].node.then, custom);
  assert.deepEqual(chain.rows[1].trail, ['else', { ref: 'test.condition' }]);
  assert.equal(hashJsonData(d), hash);
  assert.deepEqual(assembleConditions([...chain.rows].reverse(), chain.fallback).then, custom);
  const unknownWhen = { ...tree, future: true };
  assert.equal(conditionChain(d, unknownWhen), null);
  assert.equal(conditionPredicate(d, { ...predicate('1'), future: true }), null);
  assert.equal(conditionPredicate(d, { op: 'eq', left: input, right: null }), null);
  assert.equal(conditionPredicate(d, { op: 'eq', left: { op: 'source', id: 'AR.type' }, right: literal(1) }), null);
  assert.throws(() => buildConditionPredicate({ input, operator: 'invented' }));
});

test('form predicate builders retain exact equality, membership, presence, absence and genuine zero semantics', () => {
  const d = baseline(); const source = { op: 'source', id: 'weight' };
  const compare = (operator, value, values) => {
    const test = buildConditionPredicate({ input: source, operator, value, values });
    d.groups[4].rows[0].cells.meta_description = { op: 'when', if: test, then: literal('yes'), else: literal('no') };
    return test;
  };
  assert.equal(conditionPredicate(d, compare('eq', 0)).value, 0);
  assert.equal(result(d, 2, { weight: 0 }).base.meta_description, 'yes');
  assert.equal(result(d, 2, { weight: '0' }).base.meta_description, 'no');
  compare('in', undefined, [0, '  ']);
  assert.equal(result(d, 2, { weight: 0 }).base.meta_description, 'yes');
  assert.equal(result(d, 2, { weight: '0' }).base.meta_description, 'no');
  assert.equal(result(d, 2, { weight: '  ' }).base.meta_description, 'yes');
  compare('present');
  for (const weight of [0, '0']) assert.equal(result(d, 2, { weight }).base.meta_description, 'yes');
  for (const weight of [null, '', '  ']) assert.equal(result(d, 2, { weight }).base.meta_description, 'no');
  compare('absent'); assert.equal(result(d, 2, { weight: null }).base.meta_description, 'yes');
  assert.equal(result(d, 2, { weight: 0 }).base.meta_description, 'no');
});

test('ordered form output keeps lazy branch errors and lazy fallback evaluation under the server evaluator', () => {
  const d = baseline();
  const failure = { op: 'error', code: 'TEST_BRANCH', field: 'meta_description', message: literal('Selected only') };
  const tree = when('2', literal('landscape'), when('1', failure));
  d.groups[4].rows[0].cells.meta_description = tree;
  assert.deepEqual(result(d, 2).errors, []); assert.equal(result(d, 2).base.meta_description, 'landscape');
  assert.ok(result(d, 1).errors.some((error) => error.code === 'TEST_BRANCH'));
  assert.equal(result(d, 3).base.meta_description, 'default');
  const chain = conditionChain(d, tree);
  d.groups[4].rows[0].cells.meta_description = assembleConditions(chain.rows, chain.fallback);
  assert.deepEqual(result(d, 2).errors, []);
});

test('local branch editing detaches only selected refs; explicit shared edits preserve the consumer contract', () => {
  const d = baseline(); const tree = when('2', literal('landscape'), when('1', literal('icon')));
  d.bindings.push({ id: 'test.seo', group: 'AR', value: tree });
  for (const ri of [0, 1]) d.groups[4].rows[ri].cells.meta_description = { op: 'ref', id: 'test.seo' };
  const chain = conditionChain(d, d.groups[4].rows[0].cells.meta_description);
  const trail = [...chain.rows[1].trail, 'then'];
  const local = editField(d, path, trail, 'local', () => literal('local icon'));
  assert.equal(result(local, 1).base.meta_description, 'local icon'); assert.equal(result(local, 1).english.meta_description, 'icon');
  assert.deepEqual(local.bindings, d.bindings); assert.deepEqual(local.sources, d.sources); assert.deepEqual(local.questionContracts, d.questionContracts);
  const shared = editField(d, path, trail, 'shared', () => literal('shared icon'));
  assert.equal(result(shared, 1).base.meta_description, 'shared icon'); assert.equal(result(shared, 1).english.meta_description, 'shared icon');
  assert.deepEqual(shared.groups, d.groups);
});
