'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const script = require('../scripts/magento-successor-prepare');

const uuid = '11111111-1111-4111-8111-111111111111', token = 'a'.repeat(64);
const base = ['--expected-database', 'amber_test', '--actor-id', '1', '--source', uuid, '--template-version', uuid];
const pool = (products) => ({ async query(sql) {
  if (/current_database/.test(sql)) return { rows: [{ name: 'amber_test' }] };
  if (/FROM magento_binding_revisions/.test(sql)) return { rows: [{ revision: '7' }] };
  if (/ROW_NUMBER/.test(sql)) return { rows: products.map((id) => ({ id })) };
  return { rows: [] };
} });

test('apply requires the reviewed preview token and preview refuses one', () => {
  assert.equal(script.argumentsFor(['--mode', 'preview', ...base]).perGroup, 12);
  assert.throws(() => script.argumentsFor(['--mode', 'apply', ...base]), /SUCCESSOR_ARGUMENTS/);
  assert.throws(() => script.argumentsFor(['--mode', 'preview', ...base, '--preview-token', token]), /SUCCESSOR_ARGUMENTS/);
  assert.equal(script.argumentsFor(['--mode', 'apply', ...base, '--preview-token', token]).previewToken, token);
});

test('preview and apply pass the exact source revision, template and SV sample to the canonical service', async () => {
  const calls = [];
  const successor = {
    async prepare(_config, input) { calls.push(['prepare', input]); return { previewToken: token, productIds: input.productIds, carried: 3, skipped: [{ bindingKey: 'k' }], blockers: [] }; },
    async apply(_config, input) { calls.push(['apply', input]); return { id: uuid, revision: '1', state: 'draft', bindings: { attributes: [{ reviewState: 'approved' }, { reviewState: 'review_required' }] } }; },
  };
  const lines = [];
  const dependencies = { pool: pool([5, 9]), successor, config: { configured: true }, print: (l) => lines.push(JSON.parse(l)), printError: (l) => lines.push(JSON.parse(l)) };
  assert.equal(await script.main(['--mode', 'preview', ...base], dependencies), 0);
  assert.equal(await script.main(['--mode', 'apply', ...base, '--preview-token', token], dependencies), 0);
  assert.deepEqual(calls[0][1], { sourceId: uuid, expectedSourceRevision: '7', templateVersionId: uuid, productIds: [5, 9] });
  assert.equal(calls[1][1].previewToken, token);
  assert.equal(lines[0].skippedCount, 1);
  assert.deepEqual(lines[1].reviewStates, { approved: 1, review_required: 1 });
});

test('an empty category sample refuses before calling the service', async () => {
  const lines = [];
  const code = await script.main(['--mode', 'preview', ...base], { pool: pool([]), config: { configured: true },
    successor: { prepare: () => assert.fail('must not prepare') }, print: () => {}, printError: (l) => lines.push(JSON.parse(l)) });
  assert.equal(code, 1); assert.equal(lines[0].code, 'SUCCESSOR_NO_PRODUCTS');
});
