'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const runner = require('../scripts/names-batch');
const { createCommand, getOnly } = require('../scripts/operator-cli');
const { hash } = require('../src/services/magento/binding-contract');
const config = { configured: true, baseUrl: 'https://magento.example.invalid' };
const common = ['--expected-database', 'amber_test', '--actor-id', '7'];
const error = code => Object.assign(Error(code), { code });
const input = (ids = [1, 2]) => ({ items: ids.map(productId => ({ sku: `AG-${productId}`, productId })) });
function database(ids = { 'AG-1': 1, 'AG-2': 2 }) {
  return { ids, async query(sql, params = []) {
    if (/current_database/.test(sql)) return { rows: [{ name: 'amber_test' }] };
    if (/SHOW default_transaction_read_only/.test(sql)) return { rows: [{ default_transaction_read_only: 'on' }] };
    if (/FROM public_product_identities/.test(sql)) return { rows: params[0].filter(sku => ids[sku])
      .map(sku => ({ sku, product_id: ids[sku], current_count: 1 })) };
    assert.fail('unexpected SQL: ' + sql);
  } };
}
function context(pool = database(), authority = async () => {}) {
  const options = { databasePool: pool, config, mutationContext: { actorUserId: 7 }, fetchImpl: getOnly(async () => ({ ok: true })) };
  return { ...options, options, authority, checkStopped() {} };
}
function service(overrides = {}) {
  return { async preview({ productId, choice }) {
    const amber = { all: `Назва ${productId}`, en: `Name ${productId}` };
    const magento = productId === 1 ? { en: amber.en, all: amber.all } : { all: 'Magento UA', en: 'Magento EN' };
    return { productId, article: `AG-${productId}`, choice, amber, magento,
      previewToken: hash({ productId, choice, amber, magento }) };
  }, async apply(payload) { return { productId: payload.productId, choice: payload.choice, state: 'pending' }; }, ...overrides };
}

test('names CLI requires explicit preview/apply and saved plan hash', () => {
  const base = ['--input', 'in.json', '--output', 'out.json', ...common];
  assert.equal(runner.parseArguments(['--mode', 'preview', ...base]).mode, 'preview');
  assert.equal(runner.parseArguments(['--mode', 'apply', ...base, '--plan-hash', 'a'.repeat(64)]).mode, 'apply');
  for (const args of [['--mode', 'apply', ...base], ['--mode', 'preview', ...base, '--plan-hash', 'a'.repeat(64)],
    ['--mode', 'preview', ...base, '--mode', 'apply'], ['--mode', 'preview', ...base.slice(0, -1), '0'],
    ['--mode', 'preview', ...base, '--unknown', 'yes']]) assert.throws(() => runner.parseArguments(args), /OPERATOR_ARGUMENTS/);
});

test('names input is exact, bounded, and only the intended recovery blockers are selected', () => {
  assert.deepEqual(runner.parsePreviewInput(input()), input());
  const rows = [{ sku: 'AG-1', productId: 1, status: 'blocked', blockers: ['DURABLE_REMOTE_ID_REQUIRED'] },
    { sku: 'AG-2', productId: 2, status: 'blocked', blockers: ['OTHER_BLOCKER'] }, { kind: 'summary', found: 2 }];
  assert.deepEqual(runner.parsePreviewInput(rows, { jsonLines: true }), input([1]));
  for (const bad of [input([]), input([1, 1]), input(Array.from({ length: 51 }, (_, i) => i + 1)),
    { items: [{ sku: 'AG-1', productId: '1' }] }, { items: [{ sku: 'AG-1', productId: 1, choice: 'amber' }] },
    { ...input(), force: true }]) assert.throws(() => runner.parsePreviewInput(bad));
  assert.throws(() => runner.parsePreviewInput([...rows, rows[0]], { jsonLines: true }), /DUPLICATE/);
  assert.throws(() => runner.parsePreviewInput([{ sku: 'AG-1', status: 'blocked', blockers: ['DURABLE_REMOTE_ID_REQUIRED'] }], { jsonLines: true }));
  assert.throws(() => runner.parsePreviewInput([{ sku: 'AG-1', productId: 1, status: 'blocked', blockers: ['OTHER'] }], { jsonLines: true }));
});

test('names reads JSONL and recovery envelopes with bounded regular-file input', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'names-input-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const jsonl = path.join(directory, 'legacy.jsonl');
  await fs.writeFile(jsonl, JSON.stringify({ sku: 'AG-1', productId: 1, status: 'blocked', blockers: ['DURABLE_REMOTE_ID_REQUIRED'] }) + '\n');
  assert.deepEqual(await runner.readPreviewInput(jsonl), input([1]));
  const review = { format: 'magento-lifecycle-recovery-v1', kind: 'stable_recount_exposure', article: 'AG-1', productId: 1,
    payload: { productId: 1, eligible: false }, blockers: ['DURABLE_REMOTE_ID_REQUIRED'], requiredEvidence: null, nextAction: null };
  const envelope = { contract: 'amber-operator-review-v1', command: 'recover-skus', payload: { reason: 'Reviewed recovery',
    items: [{ sku: 'AG-1', productId: 1, status: 'blocked', blockers: review.blockers, review, reviewHash: hash(review) }] } };
  assert.deepEqual(runner.parsePreviewInput(envelope), input([1]));
  const large = path.join(directory, 'large.json'); await fs.writeFile(large, ' '.repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(runner.readPreviewInput(large), /OPERATOR_INPUT_LIMIT/);
});

test('names preview chooses amber only for equal exact pairs and injects pool, actor and GET-only transport', async () => {
  const ctx = context(), calls = [], original = service();
  const definition = runner.createDefinition({ names: service({ async preview(payload, options) {
    calls.push(payload); assert.equal(options, ctx.options); assert.equal(options.databasePool, ctx.databasePool);
    assert.equal(options.mutationContext.actorUserId, 7); return original.preview(payload);
  } }) });
  const plan = await definition.preview(input(), ctx);
  assert.deepEqual(calls, [{ productId: 1, choice: 'magento' }, { productId: 1, choice: 'amber' }, { productId: 2, choice: 'magento' }]);
  assert.deepEqual(plan.items.map(item => item.choice), ['amber', 'magento']);
  assert.equal(plan.items[0].previewToken, (await original.preview({ productId: 1, choice: 'amber' })).previewToken);
});

test('names preview never converts changing names, wrong identities or failed GET restrictions into consent', async () => {
  const base = service();
  const changing = runner.createDefinition({ names: service({ async preview(payload) {
    const value = await base.preview(payload); if (payload.choice === 'amber') value.magento.all = 'Changed'; return value;
  } }) });
  assert.equal((await changing.preview(input([1]), context())).items[0].code, 'NAMES_BATCH_PREVIEW_CHANGED');
  const wrong = runner.createDefinition({ names: service({ async preview(payload) { return { ...await base.preview(payload), article: 'OTHER' }; } }) });
  assert.equal((await wrong.preview(input([1]), context())).items[0].code, 'NAMES_BATCH_PREVIEW_INVALID');
  await assert.rejects(runner.createDefinition({ names: service({ async preview(_payload, options) {
    await options.fetchImpl('https://magento.example.invalid', { method: 'POST', body: '{}' });
  } }) }).preview(input([1]), context()), /GET_ONLY|REMOTE_WRITE/);
});

test('names apply uses stored choice/token only, prepares each mutation, and rechecks scope and authority per item', async () => {
  const plan = await runner.createDefinition({ names: service() }).preview(input(), context());
  const ctx = context(), rows = [], calls = [];
  const definition = runner.createDefinition({ names: service({
    preview() { assert.fail('apply must not replace reviewed tokens'); },
    async apply(payload, options) {
      assert.equal(rows.at(-1).type, 'item_prepared'); assert.equal(options, ctx.options); calls.push(payload);
      return { productId: payload.productId, choice: payload.choice, state: 'pending' };
    },
  }) });
  await definition.apply(plan, ctx, { append: async row => rows.push(row) });
  assert.deepEqual(calls, plan.items.map(({ productId, choice, previewToken }) => ({ productId, choice, previewToken })));
  assert.deepEqual(rows.map(row => row.type), ['item_prepared', 'item_result', 'item_prepared', 'item_result']);
  const changed = structuredClone(plan); changed.items[0].choice = 'magento';
  assert.throws(() => runner.validatePlan(changed), /REVIEW_INVALID/);
  await assert.rejects(definition.apply(plan, context(database({ 'AG-1': 3, 'AG-2': 2 })), { append: async () => {} }), /ITEM_MISMATCH/);
  let count = 0;
  const revoking = runner.createDefinition({ names: service({ async apply(payload) {
    count++; return { productId: payload.productId, choice: payload.choice, state: 'pending' };
  } }) });
  await assert.rejects(revoking.apply(plan, context(database(), async () => { if (count) throw error('ADMIN_PERMISSION_REVOKED'); }),
    { append: async () => {} }), /ADMIN_PERMISSION_REVOKED/);
  assert.equal(count, 1);
});

test('names apply stops at the first stale token or unknown reply, without refreshing or retrying', async () => {
  const plan = await runner.createDefinition({ names: service() }).preview(input(), context());
  for (const code of ['MAGENTO_NAME_PREVIEW_STALE', 'SIMULATED_LOST_REPLY']) {
    const calls = [], rows = [], definition = runner.createDefinition({ names: service({
      preview() { assert.fail('no refresh after stale token'); },
      async apply(payload) { calls.push(payload.productId); throw error(code); },
    }) });
    await assert.rejects(definition.apply(plan, context(), { append: async row => rows.push(row) }), { code });
    assert.deepEqual(calls, [1]); assert.equal(rows.at(-1).outcome, 'unconfirmed');
  }
});

test('names re-resolves later items and does not apply after interruption during journal preparation', async () => {
  const plan = await runner.createDefinition({ names: service() }).preview(input(), context());
  const pool = database(), calls = [];
  const definition = runner.createDefinition({ names: service({ async apply(payload) {
    calls.push(payload.productId); pool.ids['AG-2'] = 99;
    return { productId: payload.productId, choice: payload.choice, state: 'pending' };
  } }) });
  await assert.rejects(definition.apply(plan, context(pool), { append: async () => {} }), /ITEM_MISMATCH/);
  assert.deepEqual(calls, [1]);
  let stopped = false;
  const ctx = context(); ctx.checkStopped = () => { if (stopped) throw error('OPERATOR_INTERRUPTED'); };
  await assert.rejects(definition.apply(plan, ctx, { append: async row => { if (row.type === 'item_prepared') stopped = true; } }), /OPERATOR_INTERRUPTED/);
  assert.deepEqual(calls, [1]);
});

test('names CLI writes a reviewed artifact and refuses overwrite, actor drift and tampered tokens before apply', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'names-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'input.json'), previewFile = path.join(directory, 'preview.json');
  await fs.writeFile(source, JSON.stringify(input([1])));
  let applies = 0;
  const command = createCommand(runner.createDefinition({ names: service({ async apply(payload) {
    applies++; return { productId: payload.productId, choice: payload.choice, state: 'pending' };
  } }) }));
  const deps = { pool: database(), config, print() {}, printError() {}, buildFingerprint: 'b'.repeat(64), targetFingerprint: 'c'.repeat(64),
    authority: { authorize: async () => {}, guardPool: pool => pool } };
  const args = (mode, sourceFile, output, hashValue) => ['--mode', mode, '--input', sourceFile, '--output', output, ...common,
    ...(hashValue ? ['--plan-hash', hashValue] : [])];
  assert.equal(await command.main(args('preview', source, previewFile), deps), 0);
  const review = JSON.parse(await fs.readFile(previewFile, 'utf8'));
  assert.equal(await command.main(args('apply', previewFile, previewFile, review.planHash), deps), 1);
  const changed = structuredClone(review); changed.payload.items[0].previewToken = 'a'.repeat(64);
  const tampered = path.join(directory, 'tampered.json'); await fs.writeFile(tampered, JSON.stringify(changed));
  assert.equal(await command.main(args('apply', tampered, path.join(directory, 'bad.jsonl'), review.planHash), deps), 1);
  const wrongActor = args('apply', previewFile, path.join(directory, 'wrong-actor.jsonl'), review.planHash);
  wrongActor[wrongActor.indexOf('--actor-id') + 1] = '8';
  assert.equal(await command.main(wrongActor, deps), 1); assert.equal(applies, 0);
  assert.equal(await command.main(args('apply', previewFile, path.join(directory, 'apply.jsonl'), review.planHash), deps), 0);
  assert.equal(applies, 1);
});
