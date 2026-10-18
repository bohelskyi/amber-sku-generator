const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const runner = require('../scripts/legacy-answer-recount-batch');
const service = require('../src/services/legacy-answer-recount-batch.service');
const products = require('../src/services/product.service');
const recovery = require('../src/services/magento/lifecycle-recovery');

const input = (items = [{ sku: 'SV5111001' }], extra = {}) => ({ category: 'SV', answers: { stone_processing: 1 },
  reason: 'Owner verified polished stone processing', items, ...extra });
const questions = [{ id: 78, key: 'stone_processing', label: 'Обробка', input_type: 'options', required: 1, include_in_sku: 1,
  archived: false, options: [{ value_id: 0, label: 'Не оброблений', archived: false }, { value_id: 1, label: 'Полірований', archived: false },
    { value_id: 2, label: 'Archived', archived: true }] }];
function database({ admin = true, permitted = true, rows = sku => [{ id: Number(sku.slice(-3)), full_sku: sku, category: 'SV',
  details: { answers: { souvenir: 5 }, manualPriceUah: 5000 }, corrected_from_product_id: null, public_sku: sku,
  route: 'hold', hold_reason: 'historical_ambiguity' }], remoteIds = () => 9001 } = {}) {
  const statements = [];
  const query = async (sql, values = []) => {
    statements.push(sql);
    if (/current_database/.test(sql)) return { rows: [{ name: 'amber_test' }] };
    if (/role_key='administrator'/.test(sql)) return { rowCount: admin ? 1 : 0, rows: [] };
    if (/has_permission/.test(sql)) return { rows: [{ status: 'active', has_permission: permitted }] };
    if (/FROM categories c/.test(sql)) return { rows: [{ category: { code: 'SV', requires_weight: 0 },
      questions: questions.map(q => ({ ...q, options: q.options })) }] };
    if (/FROM products p JOIN public_product_identities/.test(sql)) return { rows: rows(values[0]).map(r => ({ public_product_identity_id: r.id + 1000, ...r })) };
    if (/FROM magento_binding_revisions b/.test(sql)) return { rows: [{ origin_hash: 'o'.repeat(64) }] };
    if (/FROM magento_name_sync_states/.test(sql)) {
      const remote = remoteIds(values[1]);
      return { rows: remote ? [{ public_product_identity_id: values[1], remote_product_id: remote }] : [] };
    }
    return { rows: [] };
  };
  return { statements, query, connect: async () => ({ query, release() {} }) };
}
function recountPreview(sku, overrides = {}) {
  return { source: { productId: Number(sku.slice(-3)), publicSku: sku, internalSku: sku, answers: { souvenir: 5 }, weight: 46.3,
    totalPriceUah: 5000, stateSignature: 's'.repeat(64) },
  corrected: { answers: { souvenir: 5, stone_processing: 1 }, weight: 46.3, totalPriceUah: 5000, publicSku: sku, internalSku: null,
    mode: 'public_identity', delivery: { route: 'hold', holdReason: 'historical_ambiguity' } },
  changes: [{ key: 'stone_processing', from: null, to: 1 }], nameChanges: null, previewToken: 't'.repeat(64), ...overrides };
}
const options = (pool, extra = {}) => ({ databasePool: pool, expectedDatabase: 'amber_test', actorUserId: 7, ...extra });

test('arguments are exact; apply requires a plan hash and preview refuses one', () => {
  const base = ['--input', 'in.json', '--output', 'out.jsonl', '--expected-database', 'amber_test', '--actor-id', '7'];
  assert.deepEqual(runner.argumentsFor(['--mode', 'preview', ...base]),
    { mode: 'preview', input: 'in.json', output: 'out.jsonl', database: 'amber_test', actor: 7 });
  assert.equal(runner.argumentsFor(['--mode', 'apply', ...base, '--plan-hash', 'a'.repeat(64)]).planHash, 'a'.repeat(64));
  for (const args of [['--mode', 'apply', ...base], ['--mode', 'preview', ...base, '--plan-hash', 'a'.repeat(64)],
    ['--mode', 'apply', ...base, '--plan-hash', 'A'.repeat(64)], ['--mode', 'other', ...base],
    ['--mode', 'preview', ...base.slice(2)], ['--mode', 'preview', ...base.slice(0, -1), '0'],
    ['--mode', 'preview', ...base, '--mode', 'preview'], ['--mode', 'preview', ...base, '--extra', 'x']]) {
    assert.throws(() => runner.argumentsFor(args), { code: 'LEGACY_ANSWER_ARGUMENTS' }, args.join(' '));
  }
  assert.throws(() => runner.getOnly(async () => {})('https://x.invalid', { method: 'POST' }), { code: 'LEGACY_ANSWER_REMOTE_WRITE_DENIED' });
});

test('input is strict: 1..50 distinct SKUs, integer option IDs and a bounded reason', () => {
  assert.deepEqual(service.validateInput(input()), input());
  const many = Array.from({ length: 50 }, (_, i) => ({ sku: `SV5111${String(i + 1).padStart(3, '0')}` }));
  assert.equal(service.validateInput(input(many)).items.length, 50);
  for (const bad of [input([]), input([...many, { sku: 'SV1' }]), input([{ sku: 'SV1' }, { sku: 'SV1' }]),
    input([{ sku: ' SV1' }]), input([{ sku: 'SV1', productId: 1 }]), input(undefined, { reason: 'short' }),
    input(undefined, { reason: 'x'.repeat(501) }), input(undefined, { reason: 'line\nbreak reason' }),
    input(undefined, { answers: {} }), input(undefined, { answers: { stone_processing: '1' } }),
    input(undefined, { answers: { stone_processing: 1.5 } }), input(undefined, { answers: { 'bad-key': 1 } }),
    input(undefined, { category: 'sv' }), input(undefined, { extra: true }), input(undefined, { weightFromAnswer: 'yes' }),
    { category: 'SV', weightFromAnswer: false, reason: 'Owner verified exact weight', items: [{ sku: 'SV1' }] }, []]) {
    assert.throws(() => service.validateInput(bad), { code: /LEGACY_ANSWER_(INPUT_INVALID|DUPLICATE_SKU)/ }, JSON.stringify(bad));
  }
});

test('stored pricing decision is kept and the preview blocker rejects every non-answer change', () => {
  assert.deepEqual(service.pricingDecision({ manualPriceUah: 5000 }), { mode: 'manual_uah', manualPriceUah: 5000 });
  assert.deepEqual(service.pricingDecision({ customUsdPerGramBasis: { usdPerGram: 2.5, marketingRoundingEnabled: true } }),
    { mode: 'usd_per_gram', usdPerGram: 2.5, marketingRoundingEnabled: true });
  assert.deepEqual(service.pricingDecision({}), { mode: 'system_auto' });
  const product = { id: 1, public_sku: 'SV5111001', details: { answers: { souvenir: 5 } } }, request = input();
  assert.equal(service.previewBlocker(recountPreview('SV5111001'), product, request), null);
  const variant = mutate => { const value = recountPreview('SV5111001'); mutate(value); return service.previewBlocker(value, product, request); };
  assert.equal(variant(v => { v.corrected.totalPriceUah = 5100; }), 'PRICE_CHANGED');
  assert.equal(variant(v => { v.corrected.weight = 46; }), 'WEIGHT_WOULD_CHANGE');
  assert.equal(variant(v => { v.corrected.publicSku = 'SV5111999'; }), 'PUBLIC_SKU_WOULD_CHANGE');
  assert.equal(variant(v => { delete v.corrected.answers.souvenir; }), 'ANSWERS_WOULD_CHANGE');
  assert.equal(variant(v => { v.corrected.answers.stone_processing = 0; }), 'ANSWERS_WOULD_CHANGE');
  assert.equal(variant(v => { v.changes.push({ key: 'color', from: 1, to: 2 }); }), 'ANSWERS_WOULD_CHANGE');
  assert.equal(variant(v => { v.source.answers.stone_processing = 0; }), 'ANSWER_ALREADY_PRESENT');
  assert.equal(variant(v => { v.nameChanges = { from: {}, to: {} }; }), 'NAMES_WOULD_CHANGE');
  assert.equal(variant(v => { v.corrected.delivery = { route: 'normal', holdReason: null }; }), 'RECOUNT_ROUTE_UNEXPECTED');
  assert.equal(variant(v => { v.source.productId = 2; }), 'RECOUNT_SOURCE_CHANGED');
  assert.equal(variant(v => { v.corrected.delivery = { route: 'hold', holdReason: 'prior_exposure' }; }), null,
    'an already exposed successor keeps the ordinary UPDATE route');
  assert.equal(variant(v => { v.corrected.delivery = { route: 'hold', holdReason: 'source_correction' }; }), 'RECOUNT_ROUTE_UNEXPECTED');
  // The recount rewrites an unchanged answers.weight in dot form; another value is still a change.
  const weighed = { ...product, details: { answers: { souvenir: 5, weight: '55.0' } } };
  const normalized = recountPreview('SV5111001'); normalized.corrected.answers.weight = 55;
  assert.equal(service.previewBlocker(normalized, weighed, request), null);
  normalized.corrected.answers.weight = 56;
  assert.equal(service.previewBlocker(normalized, weighed, request), 'ANSWERS_WOULD_CHANGE');
});

test('plan hash is deterministic and binds actor, items, statuses and preview evidence', async t => {
  let token = 't'.repeat(64);
  t.mock.method(products, 'buildProductRecountPreview', async payload => {
    assert.deepEqual(payload.answers, { stone_processing: 1 }); assert.deepEqual(payload.pricingDecision, { mode: 'manual_uah', manualPriceUah: 5000 });
    return recountPreview(payload.sourceSku, { previewToken: token });
  });
  const pool = database(), request = input([{ sku: 'SV5111001' }, { sku: 'SV5111002' }]);
  const first = await service.preview(request, options(pool));
  assert.equal(first.summary.ready, 2); assert.match(first.planHash, /^[a-f0-9]{64}$/);
  assert.equal(first.items[0].internalSkuBefore, 'SV5111001'); assert.equal(first.items[0].internalSkuAfter, null);
  assert.equal((await service.preview(request, options(pool))).planHash, first.planHash);
  assert.ok(pool.statements.every(sql => !/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)));
  assert.notEqual((await service.preview(request, options(pool, { actorUserId: 8 }))).planHash, first.planHash);
  assert.notEqual((await service.preview(input([{ sku: 'SV5111002' }, { sku: 'SV5111001' }]), options(pool))).planHash, first.planHash);
  token = 'u'.repeat(64);
  assert.notEqual((await service.preview(request, options(pool))).planHash, first.planHash);
});

test('preview reports absent, prior-run and conflicting answers without calling recount for them', async t => {
  const calls = t.mock.method(products, 'buildProductRecountPreview', async payload => recountPreview(payload.sourceSku));
  const rows = sku => sku === 'SV5111404' ? [] : [{ id: Number(sku.slice(-3)), full_sku: sku === 'SV5111003' ? null : sku, category: 'SV',
    corrected_from_product_id: sku === 'SV5111001' ? null : 9, public_sku: sku, route: 'hold',
    hold_reason: ['SV5111002', 'SV5111005'].includes(sku) ? 'prior_exposure' : 'historical_ambiguity',
    // SV5111002 is already confirmed; SV5111005 is born prior_exposure by its recount and still needs the confirmation.
    lifecycle_origin: sku === 'SV5111002' ? 'reconciliation' : 'recount', exposure_confirmed: sku === 'SV5111002',
    details: sku === 'SV5111001' ? { answers: { souvenir: 5 }, manualPriceUah: 5000 }
      : sku === 'SV5111004' ? { answers: { stone_processing: '0' } }
        : { answers: { stone_processing: '1' }, correction: { changes: [{ key: 'stone_processing', from: null, to: 1 }] } } }];
  const plan = await service.preview(input(['SV5111001', 'SV5111002', 'SV5111003', 'SV5111004', 'SV5111005', 'SV5111404'].map(sku => ({ sku }))),
    options(database({ rows })));
  assert.deepEqual(plan.items.map(i => [i.sku, i.status, i.code ?? null]), [['SV5111001', 'ready', null],
    ['SV5111002', 'already_applied', null], ['SV5111003', 'recovery_pending', null], ['SV5111004', 'blocked', 'ANSWER_ALREADY_PRESENT'],
    ['SV5111005', 'recovery_pending', null], ['SV5111404', 'blocked', 'PRODUCT_NOT_FOUND']]);
  assert.equal(calls.mock.callCount(), 1);
});

test('catalog, administrator and permission checks fail closed before any product preview', async t => {
  const calls = t.mock.method(products, 'buildProductRecountPreview', async () => assert.fail('must not preview'));
  await assert.rejects(service.preview(input(undefined, { answers: { stone_processing: 2 } }), options(database())), { code: 'LEGACY_ANSWER_OPTION_INVALID' });
  await assert.rejects(service.preview(input(undefined, { answers: { missing: 1 } }), options(database())), { code: 'LEGACY_ANSWER_OPTION_INVALID' });
  await assert.rejects(service.preview(input(), options(database({ admin: false }))), { code: 'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED' });
  await assert.rejects(service.preview(input(), options(database({ permitted: false }))), { code: 'ADMIN_PERMISSION_REVOKED' });
  await assert.rejects(service.preview(input(), options(database(), { expectedDatabase: 'other_test' })), { code: 'LEGACY_ANSWER_DATABASE_MISMATCH' });
  assert.equal(calls.mock.callCount(), 0);
});

test('apply refuses a changed or blocked plan before any write and journals the fresh preview', async t => {
  t.mock.method(products, 'buildProductRecountPreview', async payload => recountPreview(payload.sourceSku));
  const writes = t.mock.method(products, 'applyProductRecount', async () => assert.fail('no write'));
  const recoveries = t.mock.method(recovery, 'apply', async () => assert.fail('no recovery'));
  const journal = [], append = async value => { journal.push(value); };
  await assert.rejects(service.apply(input(), options(database(), { planHash: 'f'.repeat(64), append })), { code: 'PLAN_CHANGED' });
  assert.equal(journal[0].type, 'fresh_preview');
  await assert.rejects(service.apply(input(), options(database(), { append })), { code: 'LEGACY_ANSWER_PLAN_HASH_REQUIRED' });
  const blocked = database({ rows: () => [] }), plan = await service.preview(input(), options(blocked));
  await assert.rejects(service.apply(input(), options(blocked, { planHash: plan.planHash, append })), { code: 'LEGACY_ANSWER_PLAN_BLOCKED' });
  assert.equal(writes.mock.callCount(), 0); assert.equal(recoveries.mock.callCount(), 0);
});

test('CLI preview writes a new fsynced journal and refuses an existing output', async t => {
  t.mock.method(products, 'buildProductRecountPreview', async payload => recountPreview(payload.sourceSku));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-legacy-answer-batch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'input.json'), output = path.join(dir, 'preview.jsonl');
  await fs.writeFile(file, JSON.stringify(input()));
  const args = ['--mode', 'preview', '--input', file, '--output', output, '--expected-database', 'amber_test', '--actor-id', '7'];
  const printed = [], errors = [];
  const run = () => runner.main(args, { pool: database(), config: { configured: false }, print: v => printed.push(JSON.parse(v)), printError: v => errors.push(JSON.parse(v)) });
  assert.equal(await run(), 0);
  const lines = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => l.type), ['start', 'item', 'complete']);
  assert.equal(lines[2].planHash, printed.at(-1).planHash); assert.equal(printed[0].status, 'ready');
  assert.equal(await run(), 1); assert.deepEqual(errors, [{ ok: false, code: 'LEGACY_ANSWER_OUTPUT_EXISTS' }]);
});

test('weightFromAnswer mode: exact answer weight, truncated physical weight, price and SKU guards', () => {
  const request = { category: 'SV', weightFromAnswer: true, reason: 'Owner verified exact weight from Magento', items: [{ sku: 'SV5111001' }] };
  assert.deepEqual(service.validateInput(request), { ...request, answers: {} });
  assert.deepEqual(service.validateInput(input(undefined, { weightFromAnswer: true })), input(undefined, { weightFromAnswer: true }));
  const product = (weight, answer) => ({ id: 1, public_sku: 'SV5111001', weight, details: { answers: { souvenir: 5, weight: answer } } });
  assert.deepEqual(service.answerWeight(product('37.000', '37,6')), { exact: 37.6, physical: 37, weight: '37.6' });
  assert.deepEqual(service.answerWeight(product('38.000', '37.6')), { exact: 37.6, physical: 38, weight: '37.6' });
  assert.equal(service.answerWeight(product('37.600', '37,6')).consistent, true);
  for (const [weight, answer, code] of [['36.000', '37,6', 'WEIGHT_NOT_TRUNCATED_ANSWER'], ['37.000', undefined, 'WEIGHT_ANSWER_INVALID'],
    ['37.000', '37,6,1', 'WEIGHT_ANSWER_INVALID'], ['0.000', '0', 'WEIGHT_ANSWER_INVALID'], ['37.000', '37.6123', 'WEIGHT_ANSWER_INVALID']]) {
    assert.equal(service.answerWeight(product(weight, answer)).blocked, code, `${weight} ${answer}`);
  }
  const preview = mutate => {
    const value = recountPreview('SV5111001');
    Object.assign(value.source, { weight: 37, answers: { souvenir: 5, weight: '37,6' } });
    Object.assign(value.corrected, { weight: 37.6, answers: { souvenir: 5, weight: 37.6 } });
    value.changes = [{ key: 'weight', from: '37,6', to: 37.6 }, { key: 'weight', from: 37, to: 37.6 }];
    mutate(value); return service.previewBlocker(value, product('37.000', '37,6'), service.validateInput(request));
  };
  assert.equal(preview(() => {}), null);
  assert.equal(preview(v => { v.corrected.totalPriceUah = 5016; }), 'PRICE_CHANGED');
  assert.equal(preview(v => { v.corrected.internalSku = 'SV5111044'; }), 'SKU_CHANGED');
  assert.equal(preview(v => { v.corrected.weight = 37; }), 'WEIGHT_WOULD_CHANGE');
  assert.equal(preview(v => { v.corrected.answers.color = 2; }), 'ANSWERS_WOULD_CHANGE');
  assert.equal(preview(v => { v.changes.push({ key: 'color', from: 1, to: 2 }); }), 'ANSWERS_WOULD_CHANGE');
  const combined = service.validateInput(input(undefined, { weightFromAnswer: true })), both = recountPreview('SV5111001');
  Object.assign(both.source, { weight: 37, answers: { souvenir: 5, weight: '37,6' } });
  Object.assign(both.corrected, { weight: 37.6, answers: { souvenir: 5, weight: 37.6, stone_processing: 1 } });
  both.changes.push({ key: 'weight', from: 37, to: 37.6 });
  assert.equal(service.previewBlocker(both, product('37.000', '37,6'), combined), null);
  both.corrected.answers.stone_processing = 0;
  assert.equal(service.previewBlocker(both, product('37.000', '37,6'), combined), 'ANSWERS_WOULD_CHANGE');
});

test('recovery retries while the worker holds the product lane, then journals the receipt', async t => {
  t.mock.method(products, 'buildProductRecountPreview', async payload => recountPreview(payload.sourceSku));
  t.mock.method(products, 'applyProductRecount', async () => ({ success: true, correctedProductId: 901, source: { productId: 1 },
    corrected: { publicSku: 'SV5111001', totalPriceUah: 5000, internalSku: null } }));
  t.mock.method(recovery, 'productRecovery', async () => ({ article: 'SV5111001', lifecycle: { availableKinds: ['stable_recount_exposure'] } }));
  t.mock.method(recovery, 'preview', async () => ({ eligible: true, review: {}, reviewHash: 'r'.repeat(64) }));
  const busy = () => Object.assign(Error('busy'), { code: 'EXPOSURE_SYNC_BUSY' });
  let calls = 0;
  t.mock.method(recovery, 'apply', async () => {
    if (++calls < 3) throw busy();
    return { productId: 901, sku: 'SV5111001', handoffId: 'h1', holdReason: 'prior_exposure' };
  });
  const plan = await service.preview(input(), options(database()));
  const journal = [], waits = [], append = async value => { journal.push(value); };
  const result = await service.apply(input(), options(database(), { planHash: plan.planHash, append, busyWait: async ms => { waits.push(ms); } }));
  assert.deepEqual(result.items, [{ sku: 'SV5111001', status: 'applied', productId: 901, handoffId: 'h1' }]);
  assert.deepEqual(waits, [5000, 5000]);
  assert.deepEqual(journal.filter(row => /^recovery_/.test(row.type)).map(row => row.type),
    ['recovery_previewed', 'recovery_busy', 'recovery_previewed', 'recovery_busy', 'recovery_previewed', 'recovery_applied']);
  calls = -100;
  await assert.rejects(service.apply(input(), options(database(), { planHash: plan.planHash, append: async () => {}, busyWait: async () => {} })),
    { code: 'EXPOSURE_SYNC_BUSY' }, 'a lane that stays busy still stops the run');
});

test('recovery retries while the worker changes the successor during preview; other blockers still stop', async t => {
  t.mock.method(products, 'buildProductRecountPreview', async payload => recountPreview(payload.sourceSku));
  t.mock.method(products, 'applyProductRecount', async () => ({ success: true, correctedProductId: 901, source: { productId: 1 },
    corrected: { publicSku: 'SV5111001', totalPriceUah: 5000, internalSku: null } }));
  t.mock.method(recovery, 'productRecovery', async () => ({ article: 'SV5111001', lifecycle: { availableKinds: ['stable_recount_exposure'] } }));
  let previews = 0, blockers = ['LOCAL_EVIDENCE_CHANGED'];
  t.mock.method(recovery, 'preview', async () => (++previews < 3 ? { eligible: false, blockers } : { eligible: true, review: {}, reviewHash: 'r'.repeat(64) }));
  t.mock.method(recovery, 'apply', async () => ({ productId: 901, sku: 'SV5111001', handoffId: 'h1' }));
  const plan = await service.preview(input(), options(database()));
  const journal = [], waits = [];
  const result = await service.apply(input(), options(database(), { planHash: plan.planHash, append: async row => { journal.push(row); },
    busyWait: async ms => { waits.push(ms); } }));
  assert.equal(result.items[0].status, 'applied'); assert.deepEqual(waits, [5000, 5000]);
  assert.equal(journal.filter(row => row.type === 'recovery_busy' && row.reason === 'LOCAL_EVIDENCE_CHANGED').length, 2);
  previews = 0; blockers = ['LOCAL_EVIDENCE_CHANGED', 'SYNC_NOT_SENDABLE'];
  await assert.rejects(service.apply(input(), options(database(), { planHash: plan.planHash, append: async () => {}, busyWait: async () => {} })),
    { code: 'LEGACY_ANSWER_RECOVERY_BLOCKED' });
});

test('a missing durable Magento ID blocks before any recount and on a pending recovery', async t => {
  const calls = t.mock.method(products, 'buildProductRecountPreview', async payload => recountPreview(payload.sourceSku));
  const done = { answers: { stone_processing: '1' }, correction: { changes: [{ key: 'stone_processing', from: null, to: 1 }] } };
  const rows = sku => [{ id: Number(sku.slice(-3)), full_sku: sku, category: 'SV', corrected_from_product_id: sku === 'SV5111001' ? null : 9,
    public_sku: sku, route: 'hold', hold_reason: sku === 'SV5111003' ? 'prior_exposure' : 'historical_ambiguity',
    lifecycle_origin: sku === 'SV5111003' ? 'reconciliation' : 'recount', exposure_confirmed: sku === 'SV5111003',
    details: sku === 'SV5111001' ? { answers: { souvenir: 5 }, manualPriceUah: 5000 } : done }];
  // No shared name state and no acknowledged job: no product has a durable Magento ID.
  const plan = await service.preview(input(['SV5111001', 'SV5111002', 'SV5111003'].map(sku => ({ sku }))),
    options(database({ rows, remoteIds: () => null })));
  assert.deepEqual(plan.items.map(i => [i.sku, i.status, i.code ?? null]), [['SV5111001', 'blocked', 'MAGENTO_REMOTE_ID_REQUIRED'],
    ['SV5111002', 'blocked', 'MAGENTO_REMOTE_ID_REQUIRED'], ['SV5111003', 'already_applied', null]]);
  assert.equal(calls.mock.callCount(), 0, 'no recount preview without the durable ID');
});
