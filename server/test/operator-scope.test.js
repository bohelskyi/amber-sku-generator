'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const scope = require('../scripts/operator-scope');
const runner = require('../scripts/scope-from-skus');

function database(rows) {
  const calls = [];
  return { calls, async query(sql, values) {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT current_database()')) return { rows: [{ name: 'amber_test' }] };
    if (sql.startsWith('SHOW ')) return { rows: [{ default_transaction_read_only: 'on' }] };
    return { rows: typeof rows === 'function' ? rows() : rows };
  } };
}
const current = (sku, id) => ({ sku, current_count: 1, product_id: id });

test('scope input preserves literal public articles and strictly bounds identities', () => {
  assert.deepEqual(scope.validateSkus(['A,%_', 'БР-1']), ['A,%_', 'БР-1']);
  assert.equal(scope.validateSkus(Array.from({ length: 100 }, (_, i) => `AG-${i}`)).length, 100);
  for (const skus of [[], null, [''], [' AG-1'], ['AG-1 '], ['A\nB'], ['x'.repeat(256)], [null],
    Array.from({ length: 101 }, (_, i) => `AG-${i}`), Array(1)]) {
    assert.throws(() => scope.validateSkus(skus), { code: 'OPERATOR_SCOPE_INVALID' });
  }
  assert.throws(() => scope.validateSkus(['A', 'B'], { limit: 1 }), { code: 'OPERATOR_SCOPE_INVALID' });
  assert.throws(() => scope.validateSkus(['A', 'A']), { code: 'OPERATOR_SCOPE_DUPLICATE_SKU' });
  for (const productId of ['1', 0, -1, 1.5, 2147483648, NaN]) {
    assert.throws(() => scope.validateItems([{ sku: 'A', productId }]), { code: 'OPERATOR_SCOPE_INVALID' });
  }
  assert.throws(() => scope.validateItems([{ sku: 'A', productId: 1, extra: true }]), { code: 'OPERATOR_SCOPE_INVALID' });
  assert.throws(() => scope.validateItems([{ sku: 'A', productId: 1 }, { sku: 'B', productId: 1 }]),
    { code: 'OPERATOR_SCOPE_DUPLICATE_PRODUCT' });
});

test('scope resolution uses one exact parameterized lookup and preserves requested spelling', async () => {
  const literal = "A,%_'; SELECT 1 --";
  const db = database([current('БР-2', 2), current(literal, 1)]);
  assert.deepEqual(await scope.resolveSkus(db, ['БР-2', literal]), [{ sku: literal, productId: 1 }, { sku: 'БР-2', productId: 2 }]);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /i\.public_sku=ANY\(\$1::text\[\]\)/);
  assert.match(db.calls[0].sql, /LEFT JOIN products/);
  assert.match(db.calls[0].sql, /corrected_to_product_id IS NULL/);
  assert.ok(!db.calls[0].sql.includes(literal));
  assert.deepEqual(db.calls[0].values, [['БР-2', literal]]);
});

test('missing, retired-only and ambiguous public identities never produce a partial scope', async () => {
  for (const [rows, code] of [
    [[current('A', 1)], 'OPERATOR_SCOPE_MISSING_SKU'],
    [[current('A', 1), { sku: 'B', current_count: 0, product_id: null }], 'OPERATOR_SCOPE_PRODUCT_NOT_CURRENT'],
    [[current('A', 1), { sku: 'B', current_count: 2, product_id: 2 }], 'OPERATOR_SCOPE_PRODUCT_AMBIGUOUS'],
    [[current('A', 1), current('B', 2), current('B', 3)], 'OPERATOR_SCOPE_PRODUCT_AMBIGUOUS'],
  ]) await assert.rejects(scope.resolveSkus(database(rows), ['A', 'B']), { code });
  const db = database([]);
  await assert.rejects(scope.resolveSkus(db, ['A', 'A']), { code: 'OPERATOR_SCOPE_DUPLICATE_SKU' });
  assert.equal(db.calls.length, 0);
});

test('reviewed pairs are rejected after a current-product replacement', async () => {
  const items = [{ sku: 'B', productId: 2 }, { sku: 'A', productId: 1 }];
  assert.deepEqual(await scope.assertItems(database([current('A', 1), current('B', 2)]), items),
    [{ sku: 'A', productId: 1 }, { sku: 'B', productId: 2 }]);
  await assert.rejects(scope.assertItems(database([current('A', 3), current('B', 2)]), items),
    { code: 'OPERATOR_SCOPE_ITEM_MISMATCH' });
});

test('scope CLI rejects ambiguous flags and apply without the reviewed hash', () => {
  const args = ['--input', 'in.json', '--output', 'new.json', '--expected-database', 'amber_test', '--actor-id', '7'];
  assert.equal(runner.parseArguments(['--mode', 'preview', ...args]).actorId, 7);
  assert.equal(runner.parseArguments(['--mode', 'apply', ...args, '--plan-hash', 'a'.repeat(64)]).mode, 'apply');
  for (const bad of [['--mode', 'apply', ...args], ['--mode', 'typo', ...args],
    ['--mode', 'preview', ...args, '--mode', 'preview'], ['--mode', 'preview', ...args, '--extra', 'x'],
    ['--mode', 'preview', ...args, '--plan-hash', 'a'.repeat(64)], ['--mode', 'preview', ...args.slice(0, -1), '9007199254740992']]) {
    assert.throws(() => runner.parseArguments(bad), { code: 'OPERATOR_ARGUMENTS' });
  }
});

test('scope preview and apply stay read-only and create an exclusive reviewed artifact', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-operator-scope-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.json'), planFile = path.join(dir, 'plan.json'), output = path.join(dir, 'scope.json');
  await fs.writeFile(input, JSON.stringify({ skus: ['AG-3'] }));
  let id = 3;
  const db = database(() => [current('AG-3', id)]), errors = [], checks = [];
  const dependencies = { pool: db, print() {}, printError: value => errors.push(JSON.parse(value)),
    buildFingerprint: 'b'.repeat(64), targetFingerprint: 'c'.repeat(64),
    authority: { async authorize(_pool, actor, permissions) { checks.push({ actor, permissions }); },
      guardPool() { assert.fail('scope apply must keep the read-only pool'); } } };
  const args = (mode, source, destination, hash) => ['--mode', mode, '--input', source, '--output', destination,
    '--expected-database', 'amber_test', '--actor-id', '7', ...(hash ? ['--plan-hash', hash] : [])];
  assert.equal(await runner.main(args('preview', input, planFile), dependencies), 0);
  const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
  assert.equal(plan.origin, null);
  assert.deepEqual(plan.payload.items, [{ sku: 'AG-3', productId: 3 }]);
  assert.equal(await runner.main(args('apply', planFile, output, plan.planHash), dependencies), 0);
  const artifact = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.deepEqual(artifact.items, plan.payload.items);
  assert.equal(artifact.journal.status, 'complete');
  assert.ok(checks.every(check => check.actor === 7 && check.permissions.join(',') === 'export_templates.view'));
  assert.ok(db.calls.every(call => /^(SELECT|SHOW)/.test(call.sql)));
  const before = await fs.readFile(output, 'utf8'), calls = db.calls.length;
  assert.equal(await runner.main(args('apply', planFile, output, plan.planHash), dependencies), 1);
  assert.equal(errors.at(-1).code, 'OPERATOR_OUTPUT_EXISTS');
  assert.equal(db.calls.length, calls);
  assert.equal(await fs.readFile(output, 'utf8'), before);
  id = 4;
  const changed = path.join(dir, 'changed.json');
  assert.equal(await runner.main(args('apply', planFile, changed, plan.planHash), dependencies), 1);
  assert.equal(errors.at(-1).code, 'OPERATOR_SCOPE_ITEM_MISMATCH');
  assert.ok(!Object.hasOwn(JSON.parse(await fs.readFile(changed, 'utf8')), 'items'));
});

test('scope wrapper requires exactly skus for preview and reviewed items for apply', async () => {
  const db = database([current('A', 1)]);
  await assert.rejects(runner.preview({ skus: ['A'], reason: 'unused' }, { databasePool: db }), { code: 'OPERATOR_SCOPE_INVALID' });
  assert.throws(() => runner.validatePlan({ items: [{ sku: 'A', productId: 1 }], extra: true }), { code: 'OPERATOR_SCOPE_INVALID' });
  assert.equal(db.calls.length, 0);
});
