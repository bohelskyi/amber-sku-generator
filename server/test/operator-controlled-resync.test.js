'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const runner = require('../scripts/controlled-resync');
const controlled = require('../src/services/magento/binding-controlled-actions');
const editor = require('../src/services/magento/integration-editor.service');
const bindingId = '12345678-1234-1234-1234-123456789abc';
const token = 'a'.repeat(64);
const config = { configured: true, baseUrl: 'https://magento.example.invalid/' };
const item = { sku: 'AG-3', productId: 3 };
const payload = () => ({ items: [{ ...item }], command: { bindingRevisionId: bindingId, expectedRevision: '12',
  kind: 'broader_resync', productIds: [3], reason: 'Reviewed exact product', previewToken: token }, blockers: [] });

function context({ id = 3, permissionError } = {}) {
  const calls = [];
  const pool = { async query(sql) {
    calls.push(sql);
    if (sql.startsWith('SELECT current_database()')) return { rows: [{ name: 'amber_test' }] };
    if (sql.startsWith('SHOW ')) return { rows: [{ default_transaction_read_only: 'on' }] };
    return { rows: [{ sku: 'AG-3', current_count: 1, product_id: id }] };
  } };
  const mutationContext = { actorUserId: 7 };
  return { databasePool: pool, config, mutationContext, options: { databasePool: pool, mutationContext }, calls,
    checkStopped() {}, async authority() { if (permissionError) throw Object.assign(Error(permissionError), { code: permissionError }); } };
}

test('controlled preview freezes installation-selected binding, exact scope, reason and service token', async t => {
  const ctx = context();
  t.mock.method(editor, 'read', async (options, operation) => { assert.equal(options.databasePool, ctx.databasePool); return operation(ctx.databasePool); });
  const selection = t.mock.method(editor, 'selected', async (client, selectedConfig, explicitId) => {
    assert.equal(client, ctx.databasePool); assert.equal(selectedConfig, config); assert.equal(explicitId, undefined);
    return { id: bindingId, revision: '12', state: 'published' };
  });
  const preview = t.mock.method(controlled, 'preview', async (selectedConfig, command, options) => {
    assert.equal(selectedConfig, config); assert.equal(options.databasePool, ctx.databasePool);
    assert.deepEqual(command, { bindingRevisionId: bindingId, expectedRevision: '12', kind: 'broader_resync',
      productIds: [3], reason: 'Reviewed exact product' });
    return { products: [{ productId: 3, article: 'AG-3' }], blockers: [], previewToken: token };
  });
  t.mock.method(controlled, 'apply', async () => assert.fail('preview cannot apply'));
  assert.deepEqual(await runner.preview({ reason: 'Reviewed exact product', items: [item] }, ctx), payload());
  assert.equal(selection.mock.callCount(), 1); assert.equal(preview.mock.callCount(), 1);
});

test('controlled preview refuses mismatched identities and does not choose an absent publication', async t => {
  t.mock.method(editor, 'read', async (_options, operation) => operation({}));
  t.mock.method(editor, 'selected', async () => null);
  const preview = t.mock.method(controlled, 'preview', async () => assert.fail('no valid selection'));
  await assert.rejects(runner.preview({ reason: 'Reviewed scope', items: [item] }, context({ id: 4 })), { code: 'OPERATOR_SCOPE_ITEM_MISMATCH' });
  await assert.rejects(runner.preview({ reason: 'Reviewed scope', items: [item] }, context()), { code: 'CONTROLLED_RESYNC_NO_CURRENT_BINDING' });
  assert.equal(preview.mock.callCount(), 0);
});

test('controlled preview rejects a service report for a different or incomplete scope', async t => {
  t.mock.method(editor, 'read', async (_options, operation) => operation({}));
  t.mock.method(editor, 'selected', async () => ({ id: bindingId, revision: '12', state: 'published' }));
  for (const products of [[], [{ productId: 3, article: 'OTHER' }], [{ productId: 4, article: 'AG-3' }]]) {
    t.mock.method(controlled, 'preview', async () => ({ products, blockers: [], previewToken: token }));
    await assert.rejects(runner.preview({ reason: 'Reviewed scope', items: [item] }, context()), { code: 'CONTROLLED_RESYNC_SCOPE_CHANGED' });
  }
});

test('controlled apply sends the stored command verbatim, retains replay and never obtains new consent', async t => {
  const plan = payload(), ctx = context(), records = [];
  t.mock.method(editor, 'selected', async () => assert.fail('apply cannot select a new binding'));
  t.mock.method(controlled, 'preview', async () => assert.fail('apply cannot obtain a new token'));
  const apply = t.mock.method(controlled, 'apply', async (selectedConfig, command, options) => {
    assert.equal(selectedConfig, config); assert.equal(command, plan.command); assert.equal(options, ctx.options);
    assert.equal(records[0].type, 'prepared');
    return { handoffId: bindingId, alreadyApplied: true };
  });
  const result = await runner.apply(plan, ctx, { append: async record => records.push(record) });
  assert.deepEqual(result, { handoffId: bindingId, alreadyApplied: true });
  assert.deepEqual(records.map(record => record.type), ['prepared', 'receipt']);
  assert.equal(apply.mock.callCount(), 1);
});

test('scope drift, permission loss, blockers and journal failure stop controlled apply', async t => {
  const calls = t.mock.method(controlled, 'apply', async () => assert.fail('must not mutate'));
  const journal = { append: async () => {} };
  await assert.rejects(runner.apply(payload(), context({ id: 4 }), journal), { code: 'OPERATOR_SCOPE_ITEM_MISMATCH' });
  await assert.rejects(runner.apply(payload(), context({ permissionError: 'ADMIN_PERMISSION_REVOKED' }), journal), { code: 'ADMIN_PERMISSION_REVOKED' });
  const blocked = payload(); blocked.blockers.push({ productId: 3, code: 'RECONCILIATION_REQUIRED' });
  await assert.rejects(runner.apply(blocked, context(), journal), { code: 'CONTROLLED_RESYNC_BLOCKED' });
  await assert.rejects(runner.apply(payload(), context(), { append: async () => { throw Object.assign(Error('disk'), { code: 'ENOSPC' }); } }), { code: 'ENOSPC' });
  const stopped = context(); stopped.checkStopped = () => { throw Object.assign(Error('stop'), { code: 'OPERATOR_INTERRUPTED' }); };
  await assert.rejects(runner.apply(payload(), stopped, journal), { code: 'OPERATOR_INTERRUPTED' });
  assert.equal(calls.mock.callCount(), 0);
});

test('a stale binding response is preserved without retry, new preview or successful receipt', async t => {
  const records = [], plan = payload();
  t.mock.method(controlled, 'preview', async () => assert.fail('no automatic re-review'));
  const apply = t.mock.method(controlled, 'apply', async (_config, command) => {
    assert.equal(command, plan.command);
    throw Object.assign(Error('changed'), { code: 'MAGENTO_BINDING_CONFLICT' });
  });
  await assert.rejects(runner.apply(plan, context(), { append: async record => records.push(record) }), { code: 'MAGENTO_BINDING_CONFLICT' });
  assert.equal(apply.mock.callCount(), 1);
  assert.deepEqual(records.map(record => record.type), ['prepared']);
});

test('controlled plan shape cannot change the action, IDs or token contract', () => {
  runner.validatePlan(payload());
  for (const mutate of [p => { p.command.kind = 'name_rule'; }, p => { p.command.productIds = [4]; },
    p => { delete p.command.previewToken; }, p => { p.command.previewToken = 'A'.repeat(64); },
    p => { p.command.expectedRevision = 12; }, p => { p.command.reason = 'x'; },
    p => { p.items.push({ sku: 'OTHER', productId: 3 }); }, p => { p.command.force = true; }]) {
    const plan = payload(); mutate(plan); assert.throws(() => runner.validatePlan(plan));
  }
});

test('scope file paths are input-relative and reject missing, duplicate and oversized selections', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-operator-resync-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'request.json');
  await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify({ items: [{ ...item, remoteProductId: 9001 }], installationKey: 'fixture' }));
  await fs.writeFile(path.join(dir, 'b.json'), JSON.stringify({ items: [item], journal: { status: 'complete' } }));
  assert.deepEqual(await runner.readItems({ reason: 'Reviewed scope', scopeFiles: ['a.json'] }, input), [item]);
  await assert.rejects(runner.readItems({ reason: 'Reviewed scope', scopeFiles: ['missing.json'] }, input), { code: 'ENOENT' });
  await assert.rejects(runner.readItems({ reason: 'Reviewed scope', scopeFiles: ['a.json', './a.json'] }, input), { code: 'CONTROLLED_RESYNC_DUPLICATE_SCOPE_FILE' });
  await assert.rejects(runner.readItems({ reason: 'Reviewed scope', scopeFiles: ['a.json', 'b.json'] }, input), { code: 'OPERATOR_SCOPE_DUPLICATE_SKU' });
  await assert.rejects(runner.readItems({ reason: 'Reviewed scope', items: [item], scopeFiles: ['a.json'] }, input), { code: 'CONTROLLED_RESYNC_INPUT_INVALID' });
  const many = Array.from({ length: 101 }, (_, i) => ({ sku: `AG-${i}`, productId: i + 1 }));
  await fs.writeFile(path.join(dir, 'many.json'), JSON.stringify({ items: many }));
  await assert.rejects(runner.readItems({ reason: 'Reviewed scope', scopeFiles: ['many.json'] }, input), { code: 'OPERATOR_SCOPE_INVALID' });
  await fs.writeFile(path.join(dir, 'large.json'), ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(runner.readItems({ reason: 'Reviewed scope', scopeFiles: ['large.json'] }, input), { code: 'OPERATOR_INPUT_LIMIT' });
});

test('controlled CLI forwards every UI permission and fails authorization before service preview', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-operator-resync-auth-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.json');
  await fs.writeFile(input, JSON.stringify({ reason: 'Reviewed scope', items: [item] }));
  const preview = t.mock.method(controlled, 'preview', async () => assert.fail('unauthorized preview'));
  const permissions = ['export_templates.manage', 'export_templates.publish', 'exports.view'];
  for (const [index, code] of ['ADMIN_PERMISSION_REVOKED', 'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED'].entries()) {
    const errors = [], ctx = context();
    const result = await runner.main(['--mode', 'preview', '--input', input, '--output', path.join(dir, `${index}.json`),
      '--expected-database', 'amber_test', '--actor-id', '7'], {
      pool: ctx.databasePool, config, print() {}, printError: message => errors.push(JSON.parse(message)),
      buildFingerprint: 'b'.repeat(64), targetFingerprint: 'c'.repeat(64),
      authority: { async authorize(_pool, actorId, required) {
        assert.equal(actorId, 7); assert.deepEqual(required, permissions); throw Object.assign(Error(code), { code });
      } },
    });
    assert.equal(result, 1); assert.equal(errors[0].code, code);
  }
  assert.equal(preview.mock.callCount(), 0);
});
