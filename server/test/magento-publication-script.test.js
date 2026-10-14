'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const script = require('../scripts/magento-publication');

const draftId = '22222222-2222-4222-8222-222222222222', currentId = '33333333-3333-4333-8333-333333333333', token = 'b'.repeat(64);
const base = ['--expected-database', 'amber_test', '--actor-id', '1', '--draft', draftId];
const pool = { async query(sql) {
  if (/current_database/.test(sql)) return { rows: [{ name: 'amber_test' }] };
  if (/state=\$2/.test(sql)) return { rows: [{ revision: '25', installation_key: 'amber' }] };
  if (/state='published'/.test(sql)) return { rows: [{ id: currentId }] };
  return { rows: [] };
} };

test('arguments bind apply to a token and coverage acknowledgement to apply', () => {
  assert.throws(() => script.argumentsFor(['--mode', 'apply', ...base]), /PUBLICATION_ARGUMENTS/);
  assert.throws(() => script.argumentsFor(['--mode', 'preview', ...base, '--ack-coverage-loss', 'reason']), /PUBLICATION_ARGUMENTS/);
  assert.equal(script.argumentsFor(['--mode', 'apply', ...base, '--preview-token', token]).previewToken, token);
});

test('preview and apply pass the exact draft counter and current publication to the canonical service', async () => {
  const calls = [], lines = [];
  const publication = {
    async preview(_config, input) { calls.push(['preview', input]); return { previewToken: token, bindingRevisionId: draftId, expectedRevision: '25',
      expectedCurrentId: currentId, totalProducts: 900, affected: [{ productId: 1, routeKey: 'SV.a', article: 'SV1' }, { productId: 2, routeKey: 'SV.a' }],
      lostRoutes: [], lostProducts: [], preservedNames: [], checked: [{ kind: 'current', productId: 1, routeKey: 'SV.a', sendable: true, blockers: [] }], blockers: [] }; },
    async publish(_config, input) { calls.push(['publish', input]); return { revision: { id: draftId, state: 'published', versionNumber: '9' }, handoffId: 'h', alreadyApplied: false }; },
  };
  const dependencies = { pool, publication, config: { configured: true }, print: (l) => lines.push(JSON.parse(l)), printError: (l) => lines.push(JSON.parse(l)) };
  assert.equal(await script.main(['--mode', 'preview', ...base], dependencies), 0);
  assert.equal(await script.main(['--mode', 'apply', ...base, '--preview-token', token], dependencies), 0);
  assert.deepEqual(calls[0][1], { bindingRevisionId: draftId, expectedRevision: '25', expectedCurrentId: currentId });
  assert.deepEqual(calls[1][1], { bindingRevisionId: draftId, expectedRevision: '25', expectedCurrentId: currentId, previewToken: token });
  assert.deepEqual(lines[0].affectedByRoute, { 'SV.a': 2 });
  assert.equal(lines[1].state, 'published');
});
