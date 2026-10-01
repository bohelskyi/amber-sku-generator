const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const bulk = require('../src/services/magento/exposure-bulk-reconciliation');
const { hash, originHash } = require('../src/services/magento/binding-contract');
const { parseArguments } = require('../scripts/magento-reconcile-exposure');
const { createReceiptWriter } = require('../scripts/exposure-bulk-receipt');
const config = { baseUrl: 'https://fixture.invalid' };
const candidate = { amberProductId: 12, sku: 'BR/EXACT', magentoProductId: 34 };
const source = () => ({ database: 'amber_test', originHash: originHash(config.baseUrl), count: 1, candidates: [candidate] });
const seal = body => ({ ...body, planHash: hash(body) });
const skippedPlan = () => seal({ format: 'magento-prior-exposure-bulk-v1', database: 'amber_test', originHash: originHash(config.baseUrl),
  entries: [{ productId: 12, sku: 'BR/EXACT', magentoProductId: 34, status: 'skipped', reasons: ['HOLD_NOT_HISTORICALLY_AMBIGUOUS'] }],
  summary: { eligible: 0, skipped: 1, conflicted: 0, failed: 0 } });

test('bulk requires explicit bounded unique scope and matching database and origin', () => {
  assert.equal(bulk.candidates(source(), config, 'amber_test').length, 1);
  for (const change of [s => { s.count++; }, s => { s.database = 'other'; }, s => { s.originHash = 'a'.repeat(64); },
    s => { s.candidates = Array(5001).fill(candidate); s.count = 5001; },
    s => { s.candidates.push({ ...candidate }); s.count++; }, s => { s.candidates[0].magentoProductId = 0; }]) {
    const s = structuredClone(source()); change(s); assert.throws(() => bulk.candidates(s, config, 'amber_test'));
  }
});
test('CLI defaults bulk to preview and requires reviewed plan/hash/actor for explicit apply', () => {
  const base = ['--expected-database', 'amber_test', '--output', 'new'];
  assert.equal(parseArguments([...base, '--bulk', '--candidates', 'scope.json']).apply, undefined);
  assert.equal(parseArguments([...base, '--bulk', '--apply', '--plan', 'plan.json', '--expected-hash', 'a'.repeat(64), '--actor-user-id', '1']).bulk, true);
  for (const args of [['--candidates', 'scope.json'], ['--bulk'], ['--bulk', '--sku', 'X'],
    ['--bulk', '--candidates', 'scope.json', '--binding-revision', 'X'], ['--bulk', '--apply', '--candidates', 'scope.json'],
    ['--bulk', '--bulk', '--candidates', 'scope.json']]) assert.throws(() => parseArguments([...base, ...args]));
});
test('bulk hash, per-entry evidence and summary tampering fail before any checkpoint', async () => {
  const plan = skippedPlan(); bulk.verify(plan, plan.planHash, config, 'amber_test');
  for (const mutate of [p => { p.entries[0].status = 'eligible'; }, p => { p.summary.skipped = 0; },
    p => { p.entries.push(p.entries[0]); }, p => { p.entries[0].productId = 0; }]) {
    const p = structuredClone(plan); mutate(p); const { planHash: _old, ...body } = p; const tampered = seal(body);
    await assert.rejects(bulk.apply(config, tampered, tampered.planHash, { expectedDatabase: 'amber_test', checkpoint: () => assert.fail('must not checkpoint') }));
  }
});
test('ineligible rows are skipped, never successful; initial and final summaries account for every ID', async () => {
  const plan = skippedPlan(); const checkpoints = [];
  const result = await bulk.apply(config, plan, plan.planHash, { expectedDatabase: 'amber_test', checkpoint: async s => checkpoints.push(structuredClone(s)) });
  assert.deepEqual(checkpoints[0].ids.pending, [12]);
  assert.deepEqual(result.counts, { succeeded: 0, skipped: 1, conflicted: 0, failed: 0, pending: 0 });
  assert.deepEqual(result.ids.skipped, [12]); assert.equal(result.complete, true);
  await assert.rejects(bulk.apply(config, plan, plan.planHash, { expectedDatabase: 'amber_test', checkpoint: () => { throw new Error('disk full'); } }), /disk full/);
});
test('summary writer atomically replaces durable summaries and rejects an existing receipt directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-exposure-receipt-'));
  try {
    const directory = path.join(root, 'run'); const write = await createReceiptWriter(directory);
    await write({ complete: false, ids: { pending: [12] } });
    await write({ complete: true, ids: { succeeded: [12] } });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'summary.json'), 'utf8')), { complete: true, ids: { succeeded: [12] } });
    assert.deepEqual(await fs.readdir(directory), ['summary.json']);
    await assert.rejects(createReceiptWriter(directory), { code: 'EEXIST' });
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  }
});
