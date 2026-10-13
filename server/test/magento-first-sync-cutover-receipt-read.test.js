'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const admission = require('../src/services/magento/first-sync-cutover-admission');
const eligibility = require('../src/services/magento/first-sync-eligibility');
const ledger = require('../src/services/magento/first-sync-ledger');
const recovery = require('../src/services/magento/recovery-history');
const repair = require('../src/services/export-exposure/repair-loader');
const c = require('../src/services/magento/binding-contract');
const { fixture } = require('./fixtures/first-sync-cutover-admission');

const EVENT = 'product.magento_first_sync_cutover_reviewed';
const LOOKUP = `SELECT id,details FROM audit_events WHERE event_key=$1 AND subject_type='magento_first_sync_cutover_admission'
  AND details->'admission'->'identity'->>'publicIdentityId'=$2 AND details->'admission'->'identity'->>'originHash'=$3
  AND details->'admission'->'identity'->>'bindingRevisionId'=$4 ORDER BY id DESC LIMIT 1`.replace(/\s+/g, ' ').trim();
const empty = { admission: null, evidenceHash: null };
const retainedInput = () => ({ products: [{ id: 7, full_sku: 'SV7', public_sku: 'SV7', category: 'SV' }],
  registry: [{ full_sku: 'SV7', first_product_id: 7 }], snapshots: [], artifacts: [], members: [],
  revisions: [{ product_id: 7, has_product_snapshot: true }], events: [], state: [{ singleton: true, exported_to_product_id: 7 }] });
const retainedSnapshot = csv => ({ id: 'retained', status: 'generated', row_count: 1,
  exported_to_product_id: 7, from_sku: 'SV7', to_sku: 'SV7', resolved_to_sku: 'SV7', reexport_revisions: [],
  file_name: 'retained.csv', csv_content: csv });

function harness(t) {
  const f = fixture({ malformed: false }), original = f.client.query.bind(f.client);
  Object.assign(f.observation.amber.product, { status: 'active', exclude_from_export: 0, full_sku: 'SV7' });
  f.retained = retainedInput(); f.receipts = []; f.progress = null;
  f.facts = { ...f.options.facts, historical_evidence: true, snapshot_evidence: false };
  f.calls = { lookups: [], captures: 0, retained: 0, order: [] };
  f.reset = () => { f.calls.lookups.length = 0; f.calls.captures = 0; f.calls.retained = 0; f.calls.order.length = 0; f.queries.length = 0; };
  f.client.query = async (sql, params) => {
    assert.match(sql, /^SELECT\s/, 'Qualification may only SELECT');
    if (sql.includes("details->'admission'->'identity'->>'publicIdentityId'")) {
      assert.equal(sql.replace(/\s+/g, ' ').trim(), LOOKUP, 'The exact latest-receipt query must retain its original filters and ordering');
      f.queries.push(sql); f.calls.lookups.push(structuredClone(params)); f.calls.order.push('lookup');
      if (f.beforeLookup) await f.beforeLookup(f.calls.lookups.length);
      return { rows: f.receipts.filter(row => {
        const identity = row.details?.admission?.identity;
        return params[0] === EVENT && identity?.publicIdentityId === params[1]
          && identity?.originHash === params[2] && identity?.bindingRevisionId === params[3];
      }).sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, 1) };
    }
    if (sql.includes('AS acknowledged_remote_id')) {
      f.queries.push(sql); assert.equal(params[2], f.observation.amber.product.public_sku);
      return { rows: [f.facts] };
    }
    if (sql.startsWith('SELECT phase')) { f.calls.captures++; f.calls.order.push('capture'); }
    if (f.extraQuery) { const result = await f.extraQuery(sql, params); if (result) return result; }
    return original(sql, params);
  };
  t.mock.method(globalThis, 'fetch', () => assert.fail('Local history qualification must never perform HTTP'));
  t.mock.method(repair, 'readRepairInput', async client => {
    assert.equal(client, f.client); f.calls.retained++; f.calls.order.push('retained'); return f.retained;
  });
  // Keep actual admission, classification, optional-receipt and ownership checks.
  // Only the unrelated ledger/history loaders and SQL transport are synthetic.
  t.mock.method(ledger, 'readOnClient', async client => { assert.equal(client, f.client); return f.progress; });
  t.mock.method(recovery, 'read', async (client, productId) => {
    assert.equal(client, f.client); assert.equal(productId, f.observation.amber.product.id); return f.options.history;
  });
  f.read = () => admission.readOnClient(f.client, f.config, f.observation, { history: f.options.history, progress: f.progress });
  f.eligible = () => eligibility.readFirstSyncEligibility(f.client, f.config, f.observation);
  f.issue = async (id = '4') => {
    const envelope = await admission.proposal(f.client, f.config, f.observation, { ...f.options, progress: f.progress });
    assert.ok(envelope); f.receipts.push({ id, details: { admission: structuredClone(envelope) } });
    f.reset(); return envelope;
  };
  return f;
}

test('absent no-session receipt uses one exact lookup and skips capture without creating an admission', async t => {
  const f = harness(t);
  assert.deepEqual(await f.read(), empty);
  assert.deepEqual(f.calls.lookups, [[EVENT, '17', c.originHash(f.config.baseUrl), f.observation.amber.revision.id]]);
  assert.equal(f.calls.captures, 0); assert.equal(f.calls.retained, 0);
  assert.deepEqual(f.calls.order, ['lookup']);
});

test('missing receipt still produces the same canonical proposal, descriptor and diagnostics with one eligibility capture', async t => {
  const f = harness(t);
  const expected = await admission.assessProposal(f.client, f.config, f.observation, f.options);
  const descriptor = admission.descriptor(expected.proposal, f.observation); f.reset();
  const result = await f.eligible();
  assert.equal(result.mode, 'review'); assert.deepEqual(result.blockers, [{ code: 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED' }]);
  assert.deepEqual(result.historyReview, expected.proposal);
  assert.deepEqual(result.historyReviewAssessment, expected.assessment);
  assert.deepEqual(admission.descriptor(result.historyReview, f.observation), descriptor);
  assert.equal(result.historyAdmission, null); assert.equal(result.historyAdmissionHash, null);
  assert.equal(f.calls.lookups.length, 1); assert.equal(f.calls.captures, 1); assert.equal(f.calls.retained, 1);
  assert.deepEqual(f.calls.order, ['lookup', 'capture', 'retained']);
});

test('matching existing receipt retains fresh full capture and an opaque identity-bound proof', async t => {
  const f = harness(t), envelope = await f.issue();
  const result = await f.read();
  assert.deepEqual(result.admission, {}); assert.equal(Object.isFrozen(result.admission), true);
  assert.equal(admission.allows(f.observation, result.admission), true);
  assert.equal(admission.allows(structuredClone(f.observation), result.admission), false);
  assert.equal(admission.allows(f.observation, {}), false); assert.equal(admission.rootId(result.admission), '4');
  assert.equal(result.evidenceHash, c.hash({ stored: envelope, auditId: '4' }));
  assert.equal(f.calls.captures, 1); assert.equal(f.calls.retained, 1); assert.equal(f.calls.lookups.length, 2);
  assert.deepEqual(f.calls.order, ['lookup', 'capture', 'retained', 'lookup']);
  f.reset(); const fresh = await f.eligible();
  assert.equal(fresh.mode, 'first'); assert.deepEqual(fresh.blockers, []); assert.equal(fresh.historyReview, null);
  assert.equal(fresh.historyAdmissionHash, result.evidenceHash); assert.notEqual(fresh.historyAdmission, result.admission);
  assert.equal(f.calls.captures, 1); assert.equal(f.calls.retained, 1); assert.equal(f.calls.lookups.length, 2);
});

test('latest malformed or mismatched receipt never falls back to an earlier valid receipt', async t => {
  for (const [name, change] of [
    ['format', row => { row.format = 'unrecognized'; }],
    ['scope', row => { row.scope = 'ordinary_delivery'; }],
    ['retained hash', row => { row.retainedHash = 'a'.repeat(64); }],
    ['remote ID', row => { row.identity.remoteId++; }],
    ['SKU', row => { row.identity.sku = 'OTHER'; }],
    ['unexpected root', row => { row.rootAdmissionEventId = '4'; }],
  ]) await t.test(name, async sub => {
    const f = harness(sub); await f.issue();
    const latest = structuredClone(f.receipts[0]); latest.id = '5'; change(latest.details.admission); f.receipts.push(latest);
    assert.deepEqual(await f.read(), empty);
    assert.equal(f.calls.captures, 1); assert.equal(f.calls.retained, 1); assert.equal(f.calls.lookups.length, 2);
  });
});

test('existing receipt is freshly reread after capture, including concurrent replacement or disappearance', async t => {
  for (const change of ['mismatch', 'removed', 'new matching']) await t.test(change, async sub => {
    const f = harness(sub), envelope = await f.issue();
    f.beforeLookup = number => {
      if (number !== 2) return;
      if (change === 'removed') f.receipts.length = 0;
      else { const latest = structuredClone(f.receipts[0]); latest.id = '5';
        if (change === 'mismatch') latest.details.admission.retainedHash = 'b'.repeat(64);
        f.receipts.push(latest); }
    };
    const result = await f.read();
    if (change === 'new matching') {
      assert.equal(admission.rootId(result.admission), '5');
      assert.equal(result.evidenceHash, c.hash({ stored: envelope, auditId: '5' }));
    } else assert.deepEqual(result, empty);
    assert.equal(f.calls.lookups.length, 2); assert.equal(f.calls.retained, 1);
  });
});

test('existing receipt does not waive absent, invalid or changed remote identity', async t => {
  for (const raw of [null, { id: 0, sku: 'SV7' }, { id: '77', sku: 'SV7' },
    { id: 77, sku: 'OTHER' }, { id: 78, sku: 'SV7' }]) await t.test(JSON.stringify(raw), async sub => {
    const f = harness(sub); await f.issue(); f.observation.raw = raw;
    assert.deepEqual(await f.read(), empty);
    assert.equal(f.calls.lookups.length, raw?.id === 78 ? 2 : 1);
    assert.equal(f.calls.retained, raw?.id === 78 ? 1 : 0);
  });
});

test('stale retained evidence is fully revalidated and remains a newly reviewed proposal, never an admission', async t => {
  const f = harness(t); await f.issue(); f.retained.revisions[0].has_product_snapshot = false;
  const expected = await admission.assessProposal(f.client, f.config, f.observation, f.options); f.reset();
  const result = await f.eligible();
  assert.equal(result.mode, 'review'); assert.equal(result.historyAdmission, null);
  assert.deepEqual(result.historyReview, expected.proposal); assert.deepEqual(result.historyReviewAssessment, expected.assessment);
  assert.equal(result.historyReviewAssessment.code, 'FIRST_SYNC_CUTOVER_REVIEW_AVAILABLE');
  assert.equal(f.calls.captures, 2); assert.equal(f.calls.retained, 2);
  assert.equal(f.calls.lookups.length, 2, 'Existing stale evidence deliberately keeps both original full captures');
});

test('absent receipt cannot hide malformed retained files or change blocked diagnostics', async t => {
  for (const [name, change, expected] of [
    ['malformed CSV', f => f.retained.snapshots.push(retainedSnapshot('sku,price_uah\r\n"SV7,42')),
      { status: 'blocked', code: 'FIRST_SYNC_RETAINED_FILES_UNRESOLVED', legacySnapshotFlag: true }],
    ['unindexed membership', f => f.retained.snapshots.push(retainedSnapshot('sku,price_uah\r\nSV7,42\r\n')),
      { status: 'blocked', code: 'FIRST_SYNC_RETAINED_FILE_REVIEW_REQUIRED', legacySnapshotFlag: true }],
    ['orphan indexed membership', f => f.retained.members.push({ snapshot_id: 'absent', product_id: 7 }),
      { status: 'blocked', code: 'FIRST_SYNC_RETAINED_FILES_UNRESOLVED', legacySnapshotFlag: true }],
    ['invalid baseline', f => { f.row.details.deliveryNotProven = false; },
      { status: 'blocked', code: 'FIRST_SYNC_CUTOVER_PROVENANCE_UNPROVEN' }],
  ]) await t.test(name, async sub => {
    const f = harness(sub); change(f);
    const canonical = await admission.assessProposal(f.client, f.config, f.observation, f.options);
    assert.deepEqual(canonical, { proposal: null, assessment: expected }); f.reset();
    const result = await f.eligible();
    assert.equal(result.mode, 'review'); assert.equal(result.historyReview, null); assert.equal(result.historyAdmission, null);
    assert.deepEqual(result.blockers, [{ code: 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED' }]);
    assert.deepEqual(result.historyReviewAssessment, expected);
    assert.equal(f.calls.lookups.length, 1); assert.equal(f.calls.captures, 1);
    assert.equal(f.calls.retained, name === 'invalid baseline' ? 0 : 1);
  });
});

test('earlier lifecycle and work blockers stay visible without an unnecessary no-receipt capture', async t => {
  for (const [name, change, code] of [
    ['lifecycle', f => { f.observation.amber.product.status = 'retired'; }, 'AMBER_PRODUCT_NOT_CURRENT'],
    ['protected work', f => { f.facts.protected_work = true; }, 'FIRST_SYNC_UNFINISHED_WORK'],
    ['other origin', f => { f.facts.other_origin = true; }, 'FIRST_SYNC_ORIGIN_REVIEW_REQUIRED'],
  ]) await t.test(name, async sub => {
    const f = harness(sub); change(f); const result = await f.eligible();
    assert.equal(result.mode, 'review'); assert.deepEqual(result.blockers, [{ code }]);
    assert.equal(result.historyReview, null); assert.equal(result.historyAdmission, null);
    assert.equal(Object.hasOwn(result, 'historyReviewAssessment'), false);
    assert.equal(f.calls.retained, 0); assert.equal(f.calls.captures, 0); assert.equal(f.calls.lookups.length, 1);
  });
});

test('repeated eligibility on the same client and observation captures fresh evidence without a cache', async t => {
  const f = harness(t), first = await f.eligible();
  f.retained.revisions[0].has_product_snapshot = false;
  const second = await f.eligible();
  assert.notEqual(first.historyReview.retainedHash, second.historyReview.retainedHash);
  assert.notEqual(admission.descriptor(first.historyReview, f.observation).previewToken,
    admission.descriptor(second.historyReview, f.observation).previewToken);
  assert.equal(f.calls.captures, 2); assert.equal(f.calls.retained, 2); assert.equal(f.calls.lookups.length, 2);
  await f.issue(); const granted = await f.read(); assert.equal(admission.allows(f.observation, granted.admission), true);
  f.receipts.length = 0; f.reset(); assert.deepEqual(await f.read(), empty);
  assert.equal(f.calls.lookups.length, 1); assert.equal(f.calls.retained, 0);
});

test('no receipt or proof is reused for another public identity, publication or SKU', async t => {
  const f = harness(t); await f.issue(); const old = await f.read(); f.reset();
  for (const mutate of [
    observation => { observation.amber.product.public_product_identity_id = '18'; },
    observation => { observation.amber.revision.id = '22222222-2222-4222-8222-222222222222'; },
    observation => { observation.amber.product.public_sku = 'SV8'; observation.raw.sku = 'SV8'; },
  ]) {
    const changed = structuredClone(f.observation); mutate(changed);
    assert.equal(admission.allows(changed, old.admission), false);
    assert.deepEqual(await admission.readOnClient(f.client, f.config, changed, f.options), empty);
    assert.deepEqual(f.calls.lookups.at(-1), [EVENT, String(changed.amber.product.public_product_identity_id),
      changed.amber.revision.originHash, changed.amber.revision.id]);
  }
  assert.equal(f.calls.lookups.length, 3); assert.equal(f.calls.retained, 0);
});

test('an existing progress session keeps capture and root validation before lookup and preserves its root through renewal', async t => {
  const f = harness(t), rootEnvelope = await f.issue('10');
  f.row.revision = '2'; f.row.csv_retired_revision = '1';
  const sessionId = '22222222-2222-4222-8222-222222222222', command = { historyAdmissionEventId: '10' };
  const result = { sessionId, revision: '1', historyAdmissionState: { revision: '2', csvRetiredRevision: '1' } };
  f.progress = { session: { id: sessionId, revision: '1', completed_at: null }, fields: [], historyAdmissionEventId: '10',
    admissionProgress: { command, command_hash: c.hash(command), result, audit_event_id: '11' } };
  const rootEvent = { event_key: EVENT, subject_type: 'magento_first_sync_cutover_admission', details: { admission: rootEnvelope } };
  const progressEvent = { event_key: 'magento.first_sync_progress_recorded', subject_type: 'magento_first_sync',
    subject_id: sessionId, details: { commandHash: c.hash(command), result } };
  f.extraQuery = (sql, params) => {
    if (sql.startsWith('SELECT event_key,subject_type,subject_id,details')) {
      assert.deepEqual(params, ['11']); f.calls.order.push('progress'); return { rows: [progressEvent] };
    }
    if (sql.startsWith('SELECT event_key,subject_type,details')) {
      assert.deepEqual(params, ['10']); f.calls.order.push('root'); return { rows: [rootEvent] };
    }
  };
  f.reset(); const original = await f.read();
  assert.equal(admission.allows(f.observation, original.admission), true); assert.equal(admission.rootId(original.admission), '10');
  assert.deepEqual(f.calls.order, ['capture', 'progress', 'retained', 'root', 'lookup']);
  assert.equal(f.calls.lookups.length, 1);
  f.observation.amber.revision.id = '33333333-3333-4333-8333-333333333333';
  const renewal = await admission.proposal(f.client, f.config, f.observation, { ...f.options, progress: f.progress });
  assert.equal(renewal.rootAdmissionEventId, '10'); f.receipts.push({ id: '20', details: { admission: renewal } });
  f.reset(); const renewed = await f.read();
  assert.equal(admission.allows(f.observation, renewed.admission), true); assert.equal(admission.rootId(renewed.admission), '10');
  assert.equal(renewed.evidenceHash, c.hash({ stored: renewal, auditId: '20' }));
  assert.deepEqual(f.calls.order, ['capture', 'progress', 'retained', 'root', 'lookup']);
  f.receipts.length = 0; f.reset(); assert.deepEqual(await f.read(), empty);
  assert.deepEqual(f.calls.order, ['capture', 'progress', 'retained', 'root', 'lookup'], 'Missing current receipt never short-circuits an existing session');
  rootEvent.details.admission.retainedHash = 'f'.repeat(64); f.reset();
  assert.deepEqual(await f.read(), empty); assert.equal(f.calls.lookups.length, 0);
  assert.deepEqual(f.calls.order, ['capture', 'progress', 'retained', 'root']);
});
