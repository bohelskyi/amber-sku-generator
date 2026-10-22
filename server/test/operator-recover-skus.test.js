'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const runner = require('../scripts/recover-skus');
const { createCommand, getOnly } = require('../scripts/operator-cli');
const { hash } = require('../src/services/magento/binding-contract');
const config = { configured: true, baseUrl: 'https://magento.example.invalid' };
const common = ['--expected-database', 'amber_test', '--actor-id', '7'];
const reason = 'Operator reviewed the exact recount recovery';
const error = code => Object.assign(Error(code), { code });

function database(ids = { 'AG-1': 1, 'AG-2': 2, 'AG-3': 3 }) {
  return { ids, async query(sql, params = []) {
    if (/current_database/.test(sql)) return { rows: [{ name: 'amber_test' }] };
    if (/SHOW default_transaction_read_only/.test(sql)) return { rows: [{ default_transaction_read_only: 'on' }] };
    if (/FROM public_product_identities/.test(sql)) return { rows: params[0].filter(sku => ids[sku])
      .map(sku => ({ sku, product_id: ids[sku], current_count: 1 })) };
    assert.fail('unexpected SQL: ' + sql);
  } };
}
function reviewed(id, blockers = []) {
  const review = { format: 'magento-lifecycle-recovery-v1', kind: 'stable_recount_exposure', productId: id,
    article: `AG-${id}`, payload: { productId: id, eligible: blockers.length === 0, planHash: 'b'.repeat(64), generatedAt: '2026-10-22T00:00:00.000Z' },
    requiredEvidence: null, blockers, nextAction: null };
  return { review, reviewHash: hash(review), eligible: blockers.length === 0, blockers };
}
function context(pool = database(), authority = async () => {}) {
  const options = { databasePool: pool, config, mutationContext: { actorUserId: 7 }, fetchImpl: getOnly(async () => ({ ok: true })) };
  return { ...options, options, authority, checkStopped() {} };
}
function service(overrides = {}) {
  return { async productRecovery(_config, id) { return { productId: id, article: `AG-${id}`,
    lifecycle: { availableKinds: ['stable_recount_exposure'] } }; },
  async preview(_config, id) { return reviewed(id); },
  async apply(_config, id) { return { productId: id, sku: `AG-${id}`, alreadyApplied: false, handoffId: `handoff-${id}` }; }, ...overrides };
}
const input = (skus = ['AG-1', 'AG-2']) => ({ skus, reason });
const pair = item => ({ sku: item.sku, productId: item.productId });

test('recovery CLI requires explicit mode, actor, database, new output and apply hash', () => {
  const base = ['--input', 'in.json', '--output', 'out.json', ...common];
  assert.equal(runner.parseArguments(['--mode', 'preview', ...base]).mode, 'preview');
  assert.equal(runner.parseArguments(['--mode', 'apply', ...base, '--plan-hash', 'a'.repeat(64)]).planHash, 'a'.repeat(64));
  for (const args of [['--mode', 'apply', ...base], ['--mode', 'preview', ...base, '--plan-hash', 'a'.repeat(64)],
    ['--mode', 'bad', ...base], ['--mode', 'preview', ...base, '--actor-id', '8'],
    ['--mode', 'preview', ...base.slice(0, -1), '9007199254740993'], ['--mode', 'preview', ...base, '--force', 'yes']]) {
    assert.throws(() => runner.parseArguments(args), /OPERATOR_ARGUMENTS/);
  }
});

test('recovery input rejects duplicates, unbounded scope, extra fields and misleading reasons', () => {
  assert.deepEqual(runner.validateInput(input()), input());
  for (const bad of [input([]), input(['AG-1', 'AG-1']), input(Array.from({ length: 51 }, (_, i) => `AG-${i}`)),
    { ...input(), reason: 'x' }, { ...input(), reason: ' Review ' }, { ...input(), reason: 'line\nbreak' },
    { ...input(), reason: 'a'.repeat(2001) }, { ...input(), force: true }, input([' AG-1'])]) {
    assert.throws(() => runner.validateInput(bad));
  }
});

test('recovery preview preserves every status and exact reviewed proof using the supplied read-only pool', async () => {
  const ctx = context(), calls = [];
  const definition = runner.createDefinition({ recovery: service({
    async productRecovery(actualConfig, id, options) {
      calls.push(['state', id]); assert.equal(actualConfig, config); assert.equal(options.databasePool, ctx.databasePool);
      assert.equal(options.canRecoverJobs, false); assert.equal(options.canReconcileLifecycle, true);
      return { productId: id, article: `AG-${id}`, lifecycle: { availableKinds: id === 3 ? [] : ['stable_recount_exposure'] } };
    },
    async preview(_config, id, payload, options) {
      calls.push(['preview', id]); assert.deepEqual(payload, { kind: 'stable_recount_exposure' }); assert.equal(options, ctx.options);
      return reviewed(id, id === 2 ? ['DURABLE_REMOTE_ID_REQUIRED'] : []);
    },
  }) });
  const plan = await definition.preview(input(['AG-3', 'AG-2', 'AG-1']), ctx);
  assert.deepEqual(plan.items.map(item => item.status), ['eligible', 'blocked', 'not_available']);
  assert.deepEqual(plan.items[0].review, reviewed(1).review);
  assert.deepEqual(plan.items[1].blockers, ['DURABLE_REMOTE_ID_REQUIRED']);
  assert.deepEqual(calls, [['state', 1], ['preview', 1], ['state', 2], ['preview', 2], ['state', 3]]);
});

test('recovery preview refuses changed identity and GET-only transport violations', async () => {
  await assert.rejects(runner.createDefinition({ recovery: service({ async productRecovery() {
    return { productId: 99, article: 'AG-1' };
  } }) }).preview(input(['AG-1']), context()), { code: 'RECOVER_SKUS_PRODUCT_MISMATCH' });
  await assert.rejects(runner.createDefinition({ recovery: service({ async preview(_config, _id, _payload, options) {
    await options.fetchImpl('https://magento.example.invalid', { method: 'PUT' });
  } }) }).preview(input(['AG-1']), context()), /GET_ONLY|REMOTE_WRITE/);
});

test('recovery apply reuses stored review verbatim, journals before mutation and leaves blocked entries unchanged', async () => {
  const ctx = context(), records = [], calls = [];
  const plan = await runner.createDefinition({ recovery: service({ async preview(_config, id) {
    return reviewed(id, id === 2 ? ['DURABLE_REMOTE_ID_REQUIRED'] : []);
  } }) }).preview(input(), ctx);
  const definition = runner.createDefinition({ recovery: service({
    preview() { assert.fail('apply cannot obtain new consent'); }, productRecovery() { assert.fail('apply cannot refresh recovery'); },
    async apply(_config, id, payload, options) {
      assert.equal(records.at(-1).type, 'item_prepared'); assert.equal(payload.review, plan.items[0].review);
      assert.equal(payload.reviewHash, plan.items[0].reviewHash); assert.equal(payload.reason, reason); assert.equal(options, ctx.options);
      calls.push(id); return { productId: id, sku: `AG-${id}`, alreadyApplied: true, handoffId: 'existing' };
    },
  }) });
  const result = await definition.apply(plan, ctx, { append: async row => records.push(row) });
  assert.deepEqual(calls, [1]); assert.deepEqual(result.items.map(item => item.status), ['already_applied', 'blocked']);
  assert.deepEqual(records.map(row => row.type), ['item_prepared', 'item_result', 'item_result']);
});

test('recovery apply rejects tampering and scope drift and stops after permission loss or unknown outcome', async () => {
  const plan = await runner.createDefinition({ recovery: service() }).preview(input(), context());
  const changed = structuredClone(plan); changed.items[0].review.article = 'AG-9';
  assert.throws(() => runner.validatePlan(changed), /REVIEW_INVALID/);
  const calls = [], definition = runner.createDefinition({ recovery: service({ async apply(_config, id) {
    calls.push(id); throw error('SIMULATED_LOST_REPLY');
  } }) });
  await assert.rejects(definition.apply(plan, context(database({ 'AG-1': 9, 'AG-2': 2 })), { append: async () => {} }), /ITEM_MISMATCH/);
  assert.deepEqual(calls, []);
  const rows = [];
  await assert.rejects(definition.apply(plan, context(), { append: async row => rows.push(row) }), /SIMULATED_LOST_REPLY/);
  assert.deepEqual(calls, [1]); assert.equal(rows.at(-1).outcome, 'unconfirmed');
  let completed = 0;
  const revoked = context(database(), async () => { if (completed) throw error('ADMIN_PERMISSION_REVOKED'); });
  const guarded = runner.createDefinition({ recovery: service({ async apply(_config, id) {
    completed++; return { productId: id, sku: `AG-${id}`, alreadyApplied: false };
  } }) });
  await assert.rejects(guarded.apply(plan, revoked, { append: async () => {} }), /ADMIN_PERMISSION_REVOKED/);
  assert.equal(completed, 1);
});

test('recovery re-resolves later items and an interruption after preparation prevents the service call', async () => {
  const plan = await runner.createDefinition({ recovery: service() }).preview(input(), context());
  const pool = database(), calls = [];
  const definition = runner.createDefinition({ recovery: service({ async apply(_config, id) {
    calls.push(id); pool.ids['AG-2'] = 99;
    return { productId: id, sku: `AG-${id}`, alreadyApplied: false };
  } }) });
  await assert.rejects(definition.apply(plan, context(pool), { append: async () => {} }), /ITEM_MISMATCH/);
  assert.deepEqual(calls, [1]);
  let stopped = false;
  const ctx = context(); ctx.checkStopped = () => { if (stopped) throw error('OPERATOR_INTERRUPTED'); };
  await assert.rejects(definition.apply(plan, ctx, { append: async row => { if (row.type === 'item_prepared') stopped = true; } }), /OPERATOR_INTERRUPTED/);
  assert.deepEqual(calls, [1]);
});

test('recovery shared CLI roundtrip seals proof and refuses changed hash, writable preview pool and existing output', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'recover-skus-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'input.json'), previewFile = path.join(directory, 'preview.json');
  await fs.writeFile(source, JSON.stringify(input(['AG-1'])));
  let applies = 0;
  const command = createCommand(runner.createDefinition({ recovery: service({ async apply(_config, id) {
    applies++; return { productId: id, sku: `AG-${id}`, alreadyApplied: false };
  } }) }));
  const deps = { pool: database(), config, print() {}, printError() {}, buildFingerprint: 'b'.repeat(64), targetFingerprint: 'c'.repeat(64),
    authority: { authorize: async () => {}, guardPool: pool => pool } };
  const args = (mode, sourceFile, output, hashValue) => ['--mode', mode, '--input', sourceFile, '--output', output, ...common,
    ...(hashValue ? ['--plan-hash', hashValue] : [])];
  assert.equal(await command.main(args('preview', source, previewFile), deps), 0);
  const plan = JSON.parse(await fs.readFile(previewFile, 'utf8'));
  assert.deepEqual(plan.payload.items.map(pair), [{ sku: 'AG-1', productId: 1 }]);
  assert.equal(await command.main(args('apply', previewFile, path.join(directory, 'wrong.jsonl'), '0'.repeat(64)), deps), 1);
  assert.equal(await command.main(args('apply', previewFile, previewFile, plan.planHash), deps), 1);
  assert.equal(applies, 0);
  assert.equal(await command.main(args('apply', previewFile, path.join(directory, 'apply.jsonl'), plan.planHash), deps), 0);
  assert.equal(applies, 1);
  const rawQuery = deps.pool.query.bind(deps.pool);
  deps.pool.query = (sql, params) => /SHOW default_transaction_read_only/.test(sql)
    ? Promise.resolve({ rows: [{ default_transaction_read_only: 'off' }] }) : rawQuery(sql, params);
  assert.equal(await command.main(args('preview', source, path.join(directory, 'unsafe.json')), deps), 1);
  assert.equal(applies, 1);
});
