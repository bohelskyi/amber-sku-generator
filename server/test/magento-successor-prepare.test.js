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

test('an explicit SKU sample resolves each current product exactly once and replaces the category sample', async () => {
  assert.deepEqual(script.argumentsFor(['--mode', 'preview', ...base, '--skus', 'AG-000001,CH1']).skus, ['AG-000001', 'CH1']);
  for (const extra of [['--skus', 'A,A'], ['--skus', 'A,'], ['--skus', 'A', '--category', 'CH'], ['--skus', 'A', '--per-group', '3']])
    assert.throws(() => script.argumentsFor(['--mode', 'preview', ...base, ...extra]), /SUCCESSOR_ARGUMENTS/);
  const db = rows => ({ async query(sql, params) {
    if (/current_database/.test(sql)) return { rows: [{ name: 'amber_test' }] };
    if (/FROM magento_binding_revisions/.test(sql)) return { rows: [{ revision: '7' }] };
    if (/public_sku=ANY/.test(sql)) return { rows: rows.filter(row => params[0].includes(row.public_sku)) };
    if (/ROW_NUMBER/.test(sql)) throw new Error('category sample must not be used');
    return { rows: [] };
  } });
  const calls = [], successor = { async prepare(_config, input) { calls.push(input); return { previewToken: token, productIds: input.productIds, carried: 0, skipped: [], blockers: [] }; } };
  const lines = [], deps = rows => ({ pool: db(rows), successor, config: { configured: true }, print: l => lines.push(JSON.parse(l)), printError: l => lines.push(JSON.parse(l)) });
  assert.equal(await script.main(['--mode', 'preview', ...base, '--skus', 'CH1,BR2'], deps([{ id: 11, public_sku: 'BR2' }, { id: 4, public_sku: 'CH1' }])), 0);
  assert.deepEqual(calls[0].productIds, [4, 11], 'SKU order is kept');
  assert.equal(await script.main(['--mode', 'preview', ...base, '--skus', 'CH1,MISSING'], deps([{ id: 4, public_sku: 'CH1' }])), 1);
  assert.equal(lines.at(-1).code, 'SUCCESSOR_SKU_NOT_FOUND');
  assert.equal(calls.length, 1);
});
