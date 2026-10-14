'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const batch = require('../scripts/name-completion-batch');

const products = { 'SV1': 11, 'SV2': 12, 'SV3': 13 };
function fakePool({ override = {}, audit = {}, requests = {} } = {}) {
  const query = async (sql, params = []) => {
    if (/current_database/.test(sql)) return { rows: [{ name: 'amber_test' }] };
    if (/FROM products p JOIN public_product_identities/.test(sql)) {
      return { rows: products[params[0]] ? [{ id: products[params[0]] }] : [] };
    }
    if (/SELECT magento_name_override/.test(sql)) return { rows: [{ magento_name_override: override[params[0]] ?? null }] };
    if (/FROM audit_events/.test(sql)) return { rows: audit[params[0]] ? [{ id: audit[params[0]] }] : [] };
    if (/magento_product_sync_requests/.test(sql)) return { rows: requests[params[0]] ? [requests[params[0]]] : [] };
    return { rows: [] };
  };
  return { query, connect: async () => ({ query, release() {} }) };
}
function fakeRuntime({ previewError = {}, applyError = {}, calls = [] } = {}) {
  return {
    access: { assertActorStillAuthorized: async () => {} },
    policy: require('../src/services/export-templates/effective-product-names'),
    names: {
      async preview(payload) {
        calls.push(['preview', payload.productId]);
        if (previewError[payload.productId]) throw Object.assign(Error('x'), { code: previewError[payload.productId] });
        return { amber: { all: '', en: '' }, magento: { all: 'Сувенір ' + payload.productId, en: 'Souvenir ' + payload.productId },
          previewToken: 'token-' + payload.productId };
      },
      async apply(payload) {
        calls.push(['apply', payload.productId, payload.previewToken]);
        const code = Array.isArray(applyError[payload.productId]) ? applyError[payload.productId].shift() : applyError[payload.productId];
        if (code) throw Object.assign(Error('x'), { code });
        return { productId: payload.productId, choice: 'magento', state: 'pending' };
      },
    },
  };
}
async function setup(skus = ['SV1', 'SV2', 'SV3']) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'name-completion-'));
  const input = path.join(directory, 'skus.json');
  await fs.writeFile(input, JSON.stringify({ items: skus.map(sku => ({ sku })) }));
  return { directory, input, output: path.join(directory, 'run') };
}
const common = ['--expected-database', 'amber_test', '--actor-id', '1'];
async function run(args, runtime, pool, extra = {}) {
  const lines = [], errors = [];
  const code = await batch.main([...args, ...common], { runtime, pool, config: { configured: true },
    fetchImpl: async () => ({ ok: true }), print: line => lines.push(line), printError: line => errors.push(line), ...extra });
  return { code, lines, errors, summary: lines.map(line => JSON.parse(line)).find(row => row.kind) };
}
const journal = async output => (await fs.readFile(path.join(output, 'journal.jsonl'), 'utf8'))
  .trim().split('\n').map(line => JSON.parse(line));

test('arguments require an explicit mode, database, actor and matching input', () => {
  assert.throws(() => batch.argumentsFor(['--mode', 'apply', '--output', 'x', ...common]), /NAME_COMPLETION_ARGUMENTS/);
  assert.throws(() => batch.argumentsFor(['--mode', 'status', '--input', 'a.json', '--output', 'x', ...common]), /NAME_COMPLETION_ARGUMENTS/);
  assert.equal(batch.argumentsFor(['--mode', 'resume', '--output', 'x', ...common]).actor, 1);
});

test('diagnostic input keeps only canonical completion candidates', () => {
  const rows = [{ sku: 'SV1', completionDecision: 'completion_review' }, { sku: 'SV2', completionDecision: 'unavailable' },
    { kind: 'summary', checked: 2 }];
  assert.deepEqual(batch.parseInput(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n')), 'x.jsonl'), ['SV1']);
  assert.throws(() => batch.parseInput(Buffer.from('{"items":[{"sku":"SV1"},{"sku":"SV1"}]}'), 'x.json'), /INPUT_INVALID/);
});

test('apply records an intent before every canonical apply and a receipt after it', async () => {
  const { input, output } = await setup();
  const calls = [];
  const result = await run(['--mode', 'apply', '--input', input, '--output', output], fakeRuntime({ calls }), fakePool());
  assert.equal(result.code, 0);
  assert.deepEqual(result.summary.counts, { completed: 3 });
  assert.equal(result.summary.magentoWrites, 0);
  const types = (await journal(output)).map(row => row.type + (row.sku ? ':' + row.sku : ''));
  assert.deepEqual(types, ['start', 'prepared:SV1', 'receipt:SV1', 'prepared:SV2', 'receipt:SV2', 'prepared:SV3', 'receipt:SV3', 'summary']);
  assert.deepEqual(calls.filter(call => call[0] === 'apply').map(call => call[2]), ['token-11', 'token-12', 'token-13']);
  await assert.rejects(fs.access(path.join(output, 'run.lock')));
});

test('product refusals stay per product, busy lanes retry once at the end, authority failures stop the run', async () => {
  const { input, output } = await setup();
  const calls = [];
  const runtime = fakeRuntime({ calls, previewError: { 12: 'MAGENTO_NAME_COMPLETION_UNAVAILABLE' }, applyError: { 11: ['MAGENTO_SYNC_BUSY'] } });
  const result = await run(['--mode', 'apply', '--input', input, '--output', output], runtime, fakePool());
  assert.equal(result.code, 2);
  assert.deepEqual(result.summary.counts, { 'review:MAGENTO_NAME_COMPLETION_UNAVAILABLE': 1, completed: 2 });
  assert.deepEqual(calls.filter(call => call[0] === 'apply').map(call => call[1]), [11, 13, 11]);

  const stopped = await setup();
  const denied = await run(['--mode', 'apply', '--input', stopped.input, '--output', stopped.output],
    fakeRuntime({ previewError: { 11: 'ADMIN_PERMISSION_REVOKED' } }), fakePool());
  assert.equal(denied.code, 1);
  assert.match(denied.errors[0], /ADMIN_PERMISSION_REVOKED/);
});

test('resume verifies a committed interrupted intent instead of applying it again', async () => {
  const { input, output } = await setup(['SV1', 'SV2']);
  const first = await run(['--mode', 'apply', '--input', input, '--output', output],
    fakeRuntime({ applyError: { 11: 'SIMULATED_LOST_REPLY', 12: 'SIMULATED_LOST_REPLY' } }), fakePool());
  assert.equal(first.code, 2);
  // Simulate an interruption after the intent: drop the review rows, keep the prepared intents.
  const kept = (await journal(output)).filter(row => row.type === 'start' || row.type === 'prepared').map((row, seq) => ({ ...row, seq }));
  await fs.writeFile(path.join(output, 'journal.jsonl'), kept.map(row => JSON.stringify(row)).join('\n') + '\n');
  const calls = [];
  const pool = fakePool({ override: { 11: { values: { all: 'Сувенір 11', en: 'Souvenir 11' } } }, audit: { 11: 501 } });
  const resumed = await run(['--mode', 'resume', '--output', output], fakeRuntime({ calls }), pool);
  assert.equal(resumed.code, 0);
  assert.deepEqual(calls.filter(call => call[0] === 'apply').map(call => call[1]), [12]);
  const receipts = (await journal(output)).filter(row => row.type === 'receipt');
  assert.deepEqual(receipts.map(row => [row.sku, Boolean(row.recovered)]), [['SV1', true], ['SV2', false]]);
  assert.equal(receipts[0].auditEventId, '501');
});

test('Magento transport refuses anything except GET', async () => {
  const { input, output } = await setup(['SV1']);
  const runtime = fakeRuntime();
  runtime.names.preview = async (_payload, options) => { await options.fetchImpl('https://example.invalid', { method: 'PUT', body: '{}' }); };
  const result = await run(['--mode', 'preview', '--input', input, '--output', output], runtime, fakePool());
  assert.deepEqual(result.summary.counts, { 'review:NAME_COMPLETION_REMOTE_WRITE_DENIED': 1 });
});

test('status reports delivery from the current request generation only', async () => {
  const { input, output } = await setup(['SV1', 'SV2']);
  await run(['--mode', 'apply', '--input', input, '--output', output], fakeRuntime(), fakePool());
  const requests = { 11: { state: 'synced', desired: '4', synced: '4', reason_code: null, diagnostics: [] },
    12: { state: 'needs_attention', desired: '3', synced: '2', reason_code: 'data_or_binding', diagnostics: [{ code: 'REQUIRED_ATTRIBUTE_VALUE_MISSING' }] } };
  const status = await run(['--mode', 'status', '--output', output], fakeRuntime(), fakePool({ requests }));
  assert.equal(status.code, 2);
  assert.deepEqual(status.summary.delivery, { delivered: 1, needs_attention: 1 });
  assert.deepEqual(JSON.parse(status.lines[1]).diagnostics, ['REQUIRED_ATTRIBUTE_VALUE_MISSING']);
});
