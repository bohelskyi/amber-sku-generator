'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/services/magento/binding-contract');
const cutover = require('../src/services/magento/first-sync-cutover-admission');
const historyAdmission = require('../src/services/magento/first-sync-history-admission');
const eligibility = require('../src/services/magento/first-sync-eligibility');
const ledger = require('../src/services/magento/first-sync-ledger');
const histories = require('../src/services/magento/recovery-history');
const repair = require('../src/services/export-exposure/repair-loader');
const service = require('../src/services/magento/first-sync.service');
const { fixture } = require('./fixtures/first-sync-cutover-admission');

const EVENT = 'product.magento_first_sync_cutover_reviewed';
const CHANGED = 'MAGENTO_FIRST_SYNC_HISTORY_ADMISSION_CHANGED';
const EVIDENCE_CHANGED = 'MAGENTO_FIRST_SYNC_EVIDENCE_CHANGED';
const retainedInput = () => ({ products: [{ id: 7, full_sku: 'SV7', public_sku: 'SV7', category: 'SV' }],
  registry: [{ full_sku: 'SV7', first_product_id: 7 }], snapshots: [], artifacts: [], members: [],
  revisions: [{ product_id: 7, has_product_snapshot: true }], events: [], state: [{ exported_to_product_id: 7 }] });

// Actual admission, latest-receipt validation, retained-file index, eligibility
// classification and evidence hashes. Only storage transport and unrelated
// history/ledger loading are synthetic; the new combined guard is never mocked.
function harness(t) {
  const f = fixture({ malformed: false }), originalQuery = f.client.query.bind(f.client);
  Object.assign(f.observation.amber.product, { status: 'active', exclude_from_export: 0, full_sku: 'SV7' });
  f.retained = retainedInput(); f.progress = null; f.receipts = [];
  f.facts = { ...f.options.facts, historical_evidence: true, snapshot_evidence: false };
  f.calls = { captures: 0, retained: 0, eligibility: [], lookups: 0, locks: 0, trace: [] };
  const clients = new Set([f.client]);
  f.newClient = () => { const client = { query: f.client.query, release() {} }; clients.add(client); return client; };
  f.reset = () => {
    Object.assign(f.calls, { captures: 0, retained: 0, lookups: 0, locks: 0 });
    f.calls.trace.length = 0; f.calls.eligibility.length = 0;
  };
  f.client.release = () => { f.calls.trace.push('release'); };
  f.client.query = async function (sql, params) {
    assert.ok(clients.has(this));
    if (sql === 'BEGIN') { f.calls.trace.push('BEGIN'); return { rows: [] }; }
    assert.match(sql, /^(SELECT\s|LOCK TABLE )/, 'History assertion has no business-write authority');
    if (/FOR (UPDATE|SHARE) NOWAIT$/.test(sql) || sql.startsWith('LOCK TABLE ')) {
      f.calls.locks++; f.calls.trace.push('lock');
      if (f.lockError) throw Object.assign(new Error('Synthetic locked writer'), { code: '55P03' });
      if (sql.startsWith('LOCK TABLE ')) return { rows: [] };
      const expected = sql.includes('WHERE public_sku=')
        ? [...new Set(f.options.history.products.map(row => row.article))].sort()
        : f.options.history.products.map(row => row.productId).sort((a, b) => a - b);
      assert.deepEqual(params, [expected]);
      return { rows: expected.map(id => ({ id, product_id: id, full_sku: String(id) })) };
    }
    if (sql.includes("details->'admission'->'identity'->>'publicIdentityId'")) {
      f.calls.lookups++; f.calls.trace.push('receipt');
      assert.deepEqual(params, [EVENT, String(f.observation.amber.product.public_product_identity_id),
        f.observation.amber.revision.originHash, f.observation.amber.revision.id]);
      if (f.beforeLookup) f.beforeLookup(f.calls.lookups);
      return { rows: [...f.receipts].sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, 1) };
    }
    if (sql.startsWith('SELECT to_jsonb(a) receipt')) return { rows: f.recountReceipts || [] };
    if (sql.includes('AS acknowledged_remote_id')) {
      f.calls.trace.push('facts');
      const facts = { ...f.facts };
      if (f.requiredOptions) facts.protected_work = params[4] !== f.requiredOptions.jobId || params[6] !== f.requiredOptions.reviewedRecovery;
      return { rows: [facts] };
    }
    if (sql.startsWith('SELECT phase')) { f.calls.captures++; f.calls.trace.push('capture'); }
    if (f.extraQuery) { const result = f.extraQuery(sql, params); if (result) return result; }
    return originalQuery(sql, params);
  };
  t.mock.method(globalThis, 'fetch', () => assert.fail('Commit history checks must never call HTTP'));
  t.mock.method(repair, 'readRepairInput', async client => {
    assert.ok(clients.has(client)); f.calls.retained++; f.calls.trace.push('retained');
    return f.clientRetained?.get(client) || f.retained;
  });
  t.mock.method(ledger, 'readOnClient', async client => { assert.ok(clients.has(client)); return f.progress; });
  t.mock.method(histories, 'read', async (client, productId) => {
    assert.ok(clients.has(client)); assert.equal(productId, 7); return f.options.history;
  });
  const readEligibility = eligibility.readFirstSyncEligibility;
  t.mock.method(eligibility, 'readFirstSyncEligibility', async (client, config, observation, options) => {
    f.calls.eligibility.push({ client, config, observation, options: { ...options } });
    return readEligibility(client, config, observation, options);
  });
  f.issue = async () => {
    const envelope = await cutover.proposal(f.client, f.config, f.observation, f.options);
    assert.ok(envelope); f.receipts.push({ id: '4', details: { admission: structuredClone(envelope) } });
    return envelope;
  };
  f.inspect = options => eligibility.readFirstSyncEligibility(f.client, f.config, f.observation, options);
  f.assert = (first, options, client = f.client, observation = f.observation) => historyAdmission.assertCommitOnClient(
    client, f.config, observation, first.historyAdmission, first.evidenceHash, options);
  f.withProgress = rootEnvelope => {
    const sessionId = '22222222-2222-4222-8222-222222222222', command = { historyAdmissionEventId: '4' };
    const result = { sessionId, revision: '1', historyAdmissionState: { revision: '1', csvRetiredRevision: '0' } };
    f.progress = { session: { id: sessionId, revision: '1', completed_at: null, public_sku: 'SV7',
      installation_key: 'review', remote_product_id: '77' }, fields: [], historyAdmissionEventId: '4',
    admissionProgress: { command, command_hash: c.hash(command), result, audit_event_id: '5' } };
    f.extraQuery = sql => {
      if (sql.startsWith('SELECT event_key,subject_type,subject_id,details')) return { rows: [{
        event_key: 'magento.first_sync_progress_recorded', subject_type: 'magento_first_sync', subject_id: sessionId,
        details: { commandHash: c.hash(command), result } }] };
      if (sql.startsWith('SELECT event_key,subject_type,details')) return { rows: [{ event_key: EVENT,
        subject_type: 'magento_first_sync_cutover_admission', details: { admission: rootEnvelope } }] };
    };
  };
  return f;
}

async function ready(t) {
  const f = harness(t); await f.issue(); const first = await f.inspect();
  assert.equal(first.mode, 'first'); assert.ok(first.historyAdmission); f.reset();
  return { f, first };
}

function commitHarness(t, f, first) {
  const trace = f.calls.trace, state = { fixture: 'original locked state' };
  const inspection = { mode: 'first', first, observation: f.observation, projection: { projection: [] },
    previewToken: 'a'.repeat(64), reviewedRecovery: false,
    prepared: { rows: [], manifest: [], complete: false, readyForOutbound: true } };
  const options = { databasePool: { connect: async () => f.client }, actorUserId: 9 };
  const committed = { sessionId: '33333333-3333-4333-8333-333333333333', revision: '1', alreadyApplied: false };
  let writes = 0, captured;
  t.mock.method(require('../src/services/magento/sync-job-transaction'), 'revalidate', async (client, config, actualState, actualOptions) => {
    trace.push('revalidate'); assert.equal(client, f.client); assert.equal(config, f.config);
    assert.equal(actualState, state); assert.equal(actualOptions, options);
    if (f.revalidationError) throw f.revalidationError;
  });
  t.mock.method(ledger, 'recordProgressOnClient', async (client, input) => {
    trace.push('ledger'); assert.equal(client, f.client); writes++; captured = input; return committed;
  });
  for (const method of ['commit', 'rollback', 'release']) t.mock.method(
    require('../src/services/full-product-cutover-gate'), method, async () => { trace.push(method); });
  return { inspection, options, committed, get writes() { return writes; }, get captured() { return captured; },
    commit: jobOptions => service.commit(f.config, inspection, state, options, jobOptions) };
}

test('actual commit captures cutover eligibility once and preserves root, guards and progress outcome', async t => {
  const { f, first } = await ready(t), h = commitHarness(t, f, first);
  const result = await h.commit({ jobId: 'job-7' });
  assert.deepEqual(result, { ...h.committed, localChanged: false, readyForOutbound: true, complete: false });
  assert.equal(f.calls.retained, 1); assert.equal(f.calls.captures, 1); assert.equal(f.calls.eligibility.length, 1);
  assert.equal(f.calls.locks, 6); assert.equal(h.writes, 1); assert.equal(h.captured.historyAdmissionEventId, '4');
  assert.equal(h.captured.expectedRevision, '0'); assert.equal(h.captured.previewHash, h.inspection.previewToken);
  assert.deepEqual(f.calls.eligibility[0].options, { jobId: 'job-7', reviewedRecovery: false });
  assert.ok(f.calls.trace.indexOf('revalidate') < f.calls.trace.indexOf('lock'));
  assert.ok(f.calls.trace.indexOf('retained') < f.calls.trace.indexOf('ledger'));
  assert.ok(f.calls.trace.indexOf('ledger') < f.calls.trace.indexOf('commit'));
});

test('combined guard exports no reusable result and every subsequent call captures fresh evidence', async t => {
  const { f, first } = await ready(t);
  assert.equal(await f.assert(first), undefined);
  assert.equal(await f.assert(first), undefined);
  assert.equal(f.calls.retained, 2); assert.equal(f.calls.eligibility.length, 2); assert.equal(f.calls.locks, 12);
  f.retained.revisions[0].has_product_snapshot = false;
  await assert.rejects(f.assert(first), { code: CHANGED });
  assert.ok(f.calls.retained > 2);
});

test('a second transaction on the same client cannot reuse a prior commit guard', async t => {
  const { f, first } = await ready(t), h = commitHarness(t, f, first);
  await h.commit(); assert.equal(h.writes, 1);
  f.facts.snapshot_evidence = true; // Changes the full hash without changing the admission envelope.
  await assert.rejects(h.commit(), { code: EVIDENCE_CHANGED });
  assert.equal(h.writes, 1); assert.equal(f.calls.retained, 2);
  assert.equal(f.calls.trace.filter(value => value === 'BEGIN').length, 2);
  assert.equal(f.calls.trace.filter(value => value === 'revalidate').length, 2);
  assert.ok(f.calls.trace.includes('rollback'));
});

test('another client obtains its own retained evidence instead of reusing the previous client result', async t => {
  const { f, first } = await ready(t);
  assert.equal(await f.assert(first), undefined);
  const other = f.newClient(), changed = structuredClone(f.retained);
  changed.revisions[0].has_product_snapshot = false; f.clientRetained = new Map([[other, changed]]);
  await assert.rejects(f.assert(first, undefined, other), { code: CHANGED });
  assert.equal(f.calls.eligibility.at(-1).client, other);
  assert.ok(f.calls.retained > 1);
});

for (const [name, mutate, code] of [
  ['forged empty proof', (f, first) => { first.historyAdmission = Object.freeze({}); }, CHANGED],
  ['serialized proof', (f, first) => { first.historyAdmission = structuredClone(first.historyAdmission); }, CHANGED],
  ['wrong eligibility hash', (f, first) => { first.evidenceHash = 'f'.repeat(64); }, EVIDENCE_CHANGED],
  ['new latest matching receipt', f => { f.receipts.push({ ...structuredClone(f.receipts[0]), id: '6' }); }, CHANGED],
  ['malformed latest receipt', f => { f.receipts.push({ id: '6', details: { admission: {} } }); }, CHANGED],
  ['missing receipt', f => { f.receipts.length = 0; }, CHANGED],
  ['changed receipt during capture', f => { f.beforeLookup = count => { if (count === 2) f.receipts.push({ ...structuredClone(f.receipts[0]), id: '6' }); }; }, CHANGED],
  ['changed retained legacy flag', f => { f.retained.revisions[0].has_product_snapshot = false; }, CHANGED],
  ['unindexed retained membership', f => { f.retained.members.push({ snapshot_id: 'missing', product_id: 7 }); }, CHANGED],
  ['changed baseline provenance', f => { f.row.details.deliveryNotProven = false; }, CHANGED],
  ['changed recovery history', f => { f.options.history.identityChanged = true; }, CHANGED],
  ['protected work', f => { f.facts.protected_work = true; }, CHANGED],
  ['different origin work', f => { f.facts.other_origin = true; }, CHANGED],
  ['retired lifecycle', f => { f.observation.amber.product.status = 'retired'; }, CHANGED],
]) test(`commit rejects ${name} before ledger mutation`, async t => {
  const { f, first } = await ready(t), h = commitHarness(t, f, first);
  mutate(f, first);
  await assert.rejects(h.commit(), { code });
  assert.equal(h.writes, 0); assert.ok(f.calls.trace.includes('rollback'));
  assert.ok(!f.calls.trace.includes('commit'));
});

for (const [name, mutate] of [
  ['another product object', observation => { observation.amber.product = { ...observation.amber.product }; }],
  ['another product identity', observation => { observation.amber.product.public_product_identity_id = '18'; }],
  ['another SKU', observation => { observation.amber.product.public_sku = 'SV8'; }],
  ['another remote identity', observation => { observation.raw.id = 78; }],
  ['another publication', observation => { observation.amber.revision.id = '22222222-2222-4222-8222-222222222222'; }],
]) test(`admission proof cannot authorize ${name}`, async t => {
  const { f, first } = await ready(t); mutate(f.observation);
  await assert.rejects(f.assert(first), { code: CHANGED });
  assert.equal(f.calls.retained, 0); assert.equal(f.calls.eligibility.length, 0);
});

test('job and reviewed recovery are forwarded exactly and changed contexts must be revalidated', async t => {
  const f = harness(t), envelope = await f.issue(); f.withProgress(envelope);
  f.requiredOptions = { jobId: 'exact-job', reviewedRecovery: true };
  const first = await f.inspect(f.requiredOptions); assert.equal(first.mode, 'first'); f.reset();
  await f.assert(first, f.requiredOptions);
  assert.equal(f.calls.retained, 1);
  assert.deepEqual(f.calls.eligibility[0].options, f.requiredOptions);
  for (const options of [{ jobId: 'other-job', reviewedRecovery: true },
    { jobId: 'exact-job', reviewedRecovery: false }, { jobId: null, reviewedRecovery: true }]) {
    await assert.rejects(f.assert(first, options), { code: CHANGED });
    assert.deepEqual(f.calls.eligibility.at(-1).options, options);
  }
});

test('ordinary eligibility keeps full revalidation and cannot enter a first-sync progress commit', async t => {
  const { f, first } = await ready(t), h = commitHarness(t, f, first);
  f.facts.previous_delivery = true; f.facts.acknowledged_remote_id = '77';
  await assert.rejects(h.commit(), { code: EVIDENCE_CHANGED });
  assert.equal(h.writes, 0); assert.ok(f.calls.eligibility.length >= 2);
  assert.ok(f.calls.retained >= 2);
});

test('no-admission first-sync still performs its canonical direct eligibility read before commit', async t => {
  const f = harness(t); f.facts.historical_evidence = false;
  const first = await f.inspect(); assert.equal(first.mode, 'first'); assert.equal(first.historyAdmission, null); f.reset();
  const h = commitHarness(t, f, first);
  await h.commit(); assert.equal(h.writes, 1); assert.equal(f.calls.eligibility.length, 1);
  assert.equal(f.calls.retained, 0); assert.equal(f.calls.locks, 0);
});

test('existing product/binding/access revalidation failure prevents both optimization and ledger writes', async t => {
  const { f, first } = await ready(t), h = commitHarness(t, f, first);
  f.revalidationError = Object.assign(new Error('Changed locked source'), { code: 'MAGENTO_SYNC_SOURCE_CHANGED' });
  await assert.rejects(h.commit(), { code: 'MAGENTO_SYNC_SOURCE_CHANGED' });
  assert.equal(h.writes, 0); assert.equal(f.calls.eligibility.length, 0); assert.equal(f.calls.retained, 0);
});

// The existing reviewed-recount recipe, with a genuine private admission from
// history.readOnClient rather than a substitute cutover proof or mocked guard.
async function recountReady(t) {
  const f = harness(t), history = f.options.history;
  history.hasRecount = true; history.identityChanged = true;
  Object.assign(history.products[0], { route: 'hold', holdReason: 'prior_exposure', lifecycleOrigin: 'reconciliation',
    previousProductId: 6, internalSku: 'SVNEW' });
  history.products.push({ productId: 6, article: 'SV6', internalSku: 'SV6', status: 'corrected',
    nextProductId: 7, previousProductId: null, route: 'retired', holdReason: null,
    lifecycleOrigin: 'migration_039', businessExclusion: 'unknown' });
  history.corrections = [{ correctionId: 9, sourceProductId: 6, successorProductId: 7 }];
  f.retained.products[0].full_sku = 'SVNEW'; f.retained.registry[0].full_sku = 'SVNEW';
  f.retained.products.push({ id: 6, full_sku: 'SV6', public_sku: 'SV6', category: 'SV' });
  f.retained.registry.push({ full_sku: 'SV6', first_product_id: 6 });
  const identity = { productId: 7, publicIdentityId: '17', sku: 'SV7', originHash: f.observation.amber.revision.originHash,
    installationKey: 'review', bindingRevisionId: f.observation.amber.revision.id, remoteId: 77 };
  const envelope = await historyAdmission.captureOnClient(f.client, identity, { history });
  const planHash = 'b'.repeat(64), handoffId = '22222222-2222-4222-8222-222222222222';
  const result = { productId: 7, publicIdentityId: '17', sku: 'SV7', planHash, handoffId,
    route: 'hold', holdReason: 'prior_exposure', deliveryVersion: '2' };
  f.recountReceipts = [{ receipt: { id: '91', actor_user_id: 9,
    event_key: 'product.magento_historical_recount_exposure_reconciled', subject_type: 'magento_exposure_resolution',
    subject_id: planHash, details: { beforeFingerprint: 'c'.repeat(64), originHash: identity.originHash,
      bindingRevisionId: identity.bindingRevisionId, remote: { id: 77, sku: 'SV7' }, result,
      lineageProductIds: [6, 7], doesNotAcknowledgeExport: true, firstSyncAdmission: structuredClone(envelope) } },
  handoff: { id: handoffId, actor_user_id: 9, kind: 'broader_resync', preview_hash: planHash,
    binding_revision_id: identity.bindingRevisionId, evidence: { source: 'historical_recount_exposure', planHash,
      doesNotAcknowledgeExport: true, firstSyncAdmission: structuredClone(envelope) } },
  item: { handoff_id: handoffId, product_id: 7, public_product_identity_id: '17', reason: 'reviewed_resync', state: 'enrolled', generation: '4' },
  binding: { id: identity.bindingRevisionId, origin_hash: identity.originHash, installation_key: 'review', state: 'published' },
  lifecycle: { product_id: 7, route: 'hold', hold_reason: 'prior_exposure', evidence: { origin: 'reconciliation',
    action: 'magento_historical_recount_prior_exposure', magentoPriorExposure: { originHash: identity.originHash,
      productId: 77, sku: 'SV7', planHash, doesNotAcknowledgeExport: true } } },
  request: { product_id: 7, public_product_identity_id: '17', desired_generation: '5', state: 'pending' } }];
  const first = await f.inspect();
  assert.equal(first.mode, 'first'); assert.ok(first.historyAdmission);
  assert.equal(historyAdmission.allows(f.observation, first.historyAdmission), true);
  assert.equal(cutover.allows(f.observation, first.historyAdmission), false);
  f.reset(); return { f, first };
}

test('actual reviewed recount admission retains its separate assertion and eligibility captures at commit', async t => {
  const { f, first } = await recountReady(t), h = commitHarness(t, f, first);
  const result = await h.commit({ jobId: 'recount-job' });
  assert.deepEqual(result, { ...h.committed, localChanged: false, readyForOutbound: true, complete: false });
  assert.equal(f.calls.retained, 2); assert.equal(f.calls.eligibility.length, 1); assert.equal(f.calls.locks, 6);
  assert.equal(h.writes, 1); assert.equal(h.captured.historyAdmissionEventId, undefined);
  const firstCapture = f.calls.trace.indexOf('retained'), facts = f.calls.trace.indexOf('facts');
  assert.ok(firstCapture < facts && facts < f.calls.trace.lastIndexOf('retained'));
  assert.deepEqual(f.calls.eligibility[0].options, { jobId: 'recount-job', reviewedRecovery: false });
});

test('reviewed recount fallback checks the full fresh eligibility hash before any ledger mutation', async t => {
  const { f, first } = await recountReady(t), h = commitHarness(t, f, first);
  f.facts.snapshot_evidence = true;
  await assert.rejects(h.commit(), { code: EVIDENCE_CHANGED });
  assert.equal(f.calls.retained, 2); assert.equal(f.calls.eligibility.length, 1);
  assert.equal(h.writes, 0); assert.ok(f.calls.trace.includes('rollback'));
});

test('changed recount admission envelope fails in its original assertion before the separate eligibility read', async t => {
  const { f, first } = await recountReady(t), h = commitHarness(t, f, first);
  f.recountReceipts[0].handoff.evidence.firstSyncAdmission.retainedHash = 'f'.repeat(64);
  await assert.rejects(h.commit(), { code: CHANGED });
  assert.equal(h.writes, 0); assert.equal(f.calls.eligibility.length, 0); assert.equal(f.calls.retained, 0);
});

for (const [name, freshProof] of [['missing', null], ['forged', Object.freeze({})]]) {
  test(`first-mode eligibility with ${name} reusable proof preserves the full fallback reads`, async t => {
    const { f, first } = await ready(t), readEligibility = eligibility.readFirstSyncEligibility;
    let reads = 0;
    t.mock.method(eligibility, 'readFirstSyncEligibility', async (...args) => {
      const result = await readEligibility(...args);
      return ++reads === 1 ? { ...result, historyAdmission: freshProof } : result;
    });
    assert.equal(await f.assert(first), undefined);
    assert.equal(reads, 2); assert.equal(f.calls.retained, 3);
    assert.equal(f.calls.locks, 6);
  });
}

test('a conflicting lifecycle/history lock prevents eligibility reuse and any ledger mutation', async t => {
  const { f, first } = await ready(t), h = commitHarness(t, f, first); f.lockError = true;
  await assert.rejects(h.commit(), { code: CHANGED });
  assert.equal(h.writes, 0); assert.equal(f.calls.eligibility.length, 0); assert.equal(f.calls.retained, 0);
  assert.ok(f.calls.trace.includes('rollback'));
});
