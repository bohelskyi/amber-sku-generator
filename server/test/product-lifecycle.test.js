const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/services/product-lifecycle-state');
const visibility = require('../src/services/magento/product-visibility-worker');
const { setVisibility } = require('../src/services/magento/product-visibility-transport');
const { originHash } = require('../src/services/magento/binding-contract');
const config = { configured: true, baseUrl: 'https://visibility-fixture.invalid', consumerKey: 'fixture-key',
  consumerSecret: 'fixture-secret', accessToken: 'fixture-token', accessTokenSecret: 'fixture-token-secret' };

function fixture() {
  const product = { id: 12, public_product_identity_id: '7', public_sku: 'KL3/11131351005', full_sku: 'KL3/11131351005',
    status: 'archived', corrected_to_product_id: null, exclude_from_export: 1, category: 'KL', total_price_uah: '240',
    details: { answers: { weight: 12.7, is_calibrated: 2 } } };
  const lifecycle = { product_id: 12, route: 'retired', hold_reason: null, revision: '3', delivery_version: '4',
    business_exclusion_state: 'none', recount_compatibility_excluded: false, evidence: { origin: 'ordinary_save' } };
  const facts = { newerRevision: false, activeSuccessor: false, correctionSource: false, correctionHistory: false,
    testDeletion: false, unfinishedJob: false, unresolvedStep: false, unresolvedVisibility: false, exported: false,
    anyRemoteJob: true, confirmedRemoteId: '71' };
  const intent = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', product_id: 12, public_product_identity_id: '7',
    public_sku: product.public_sku, origin_hash: originHash(config.baseUrl), installation_key: 'fixture', kind: 'hide',
    actor_user_id: '1', previous_product: { ...structuredClone(product), status: 'active', exclude_from_export: 0 },
    previous_lifecycle: { ...structuredClone(lifecycle), route: 'normal', delivery_version: '3' },
    local_fingerprint: state.fingerprint(product, lifecycle), remote_product_id: '71', target_status: 2,
    previous_remote_status: null, state: 'queued', dispatched_at: null, verified_at: null, reason_code: null };
  return { product, lifecycle, facts, intent };
}

test('restore accepts only captured current archive proof and preserves previous exclusions and lineage restrictions', () => {
  const f = fixture(); f.intent.state = 'verified'; f.intent.previous_remote_status = 1;
  const allowed = state.restoreProof(f.product, f.lifecycle, f.facts, f.intent);
  assert.equal(allowed.eligible, true); assert.equal(allowed.mode, 'update');
  assert.deepEqual(allowed.visibility, { action: 'restore_confirmed_status', status: 1, sourceHideId: f.intent.id });
  const cases = [
    (f) => { f.product.corrected_to_product_id = 13; },
    (f) => { f.facts.activeSuccessor = true; },
    (f) => { f.facts.newerRevision = true; },
    (f) => { f.facts.correctionSource = true; },
    (f) => { f.facts.unresolvedStep = true; },
    (f) => { f.facts.testDeletion = true; },
    (f) => { f.intent.previous_product.exclude_from_export = 1; },
    (f) => { f.intent.previous_lifecycle.business_exclusion_state = 'unknown'; },
    (f) => { f.intent.previous_lifecycle.recount_compatibility_excluded = true; },
    (f) => { f.intent.previous_lifecycle.route = 'hold'; f.intent.previous_lifecycle.hold_reason = 'historical_ambiguity'; },
    (f) => { f.product.total_price_uah = '300'; },
    (f) => { f.intent.state = 'dispatched'; },
    (f) => { f.facts.confirmedRemoteId = '72'; },
  ];
  for (const change of cases) { const changed = fixture(); change(changed); assert.equal(state.restoreProof(changed.product, changed.lifecycle, changed.facts, changed.intent).eligible, false); }
  assert.equal(state.restoreProof(f.product, f.lifecycle, f.facts, null).reasonCode, 'PRODUCT_ARCHIVE_PROOF_MISSING');
});

test('restore never infers enabling without a verified hide receipt or forces CREATE through unknown history', () => {
  const f = fixture();
  assert.equal(state.restoreProof(f.product, f.lifecycle, f.facts, f.intent).visibility.action, 'preserve');
  f.facts.confirmedRemoteId = null; f.intent.remote_product_id = null;
  assert.equal(state.restoreProof(f.product, f.lifecycle, f.facts, f.intent).eligible, false);
  f.facts.anyRemoteJob = false;
  assert.equal(state.restoreProof(f.product, f.lifecycle, f.facts, f.intent).mode, 'create');
  f.facts.exported = true;
  assert.equal(state.restoreProof(f.product, f.lifecycle, f.facts, f.intent).eligible, false);
  f.facts.exported = false; f.intent.previous_lifecycle.evidence.origin = 'migration_039';
  assert.equal(state.restoreProof(f.product, f.lifecycle, f.facts, f.intent).eligible, false);
});

test('unfinished photo delivery conflicts prevent restore without weakening a permanent media receipt', () => {
  const f = fixture();
  f.facts.unfinishedMedia = true;
  assert.deepEqual(state.restoreProof(f.product, f.lifecycle, f.facts, f.intent), {
    eligible: false, reasonCode: 'PRODUCT_MEDIA_RECONCILIATION_REQUIRED',
  });
  assert.throws(() => state.fail('PRODUCT_MEDIA_RECONCILIATION_REQUIRED'), (cause) =>
    cause.code === 'PRODUCT_MEDIA_RECONCILIATION_REQUIRED' && cause.statusCode === 409
    && cause.message.includes('передавання фото'));
  f.facts.unfinishedMedia = false;
  assert.equal(state.restoreProof(f.product, f.lifecycle, f.facts, f.intent).eligible, true);
});

test('restore input is bounded, exact and case-insensitively deduplicated without wildcard matching', () => {
  assert.deepEqual(state.inputSkus({ skus: [' ag-000012 ', 'AG-000012', 'kl3/1', 'KL3/1', '%literal%'] }), ['AG-000012', 'KL3/1', '%LITERAL%']);
  for (const skus of [[], Array(101).fill('AG-000012'), [''], [1], ['x\ny'], ['a'.repeat(257)]]) {
    assert.throws(() => state.inputSkus({ skus }), { code: 'PRODUCT_RESTORE_SELECTION_INVALID' });
  }
  assert.throws(() => state.inputSkus({ skus: ['a'], extra: true }));
});

test('visibility transport uses status-only legacy-safe PUT and never POST/DELETE or redirect/retry', async () => {
  const calls = [];
  await setVisibility(config, { sku: 'KL3/11131351005', status: 2 }, { apply: true, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, config.baseUrl + '/rest/all/V1/products/KL3%2F11131351005');
  assert.equal(calls[0].options.method, 'PUT'); assert.equal(calls[0].options.redirect, 'manual');
  assert.deepEqual(JSON.parse(calls[0].options.body), { product: { sku: 'KL3/11131351005', status: 2 } });
  let count = 0;
  await assert.rejects(setVisibility(config, { sku: 'KL3/11131351005', status: 2 }, { apply: true,
    fetchImpl: async () => { count++; return new Response('{}', { status: 302 }); } }), { code: 'PRODUCT_VISIBILITY_UNCERTAIN' });
  assert.equal(count, 1);
  for (const input of [{ sku: 'AG-000012', status: 3 }, { sku: 'a\nb', status: 2 }]) {
    await assert.rejects(setVisibility(config, input, { apply: true, fetchImpl: () => assert.fail('Invalid input called HTTP') }));
  }
  await assert.rejects(setVisibility(config, { sku: '..', status: 2 }, { apply: true, fetchImpl: () => assert.fail('Dot path called HTTP') }));
  await assert.rejects(setVisibility(config, { sku: 'AG-000012', status: 2 }, { fetchImpl: () => assert.fail('Missing APPLY called HTTP') }));
});

function workerDb(f) {
  const queries = [], events = []; let authorized = true;
  const db = { async connect() { return { query: this.query.bind(this), release() {} }; },
    queries, events, setAuthorized(value) { authorized = value; }, async query(sql, values = []) {
      queries.push({ sql, values });
      const result = (rows = []) => ({ rows, rowCount: rows.length });
      if (sql.includes('FROM application_users')) return result(sql.includes('display_name')
        ? [{ display_name: 'Fixture', preferred_username: 'fixture' }] : [{ status: authorized ? 'active' : 'disabled', has_permission: authorized }]);
      if (sql.includes("to_regclass('full_product_export_activation')")) return result([{ present: true }]);
      if (sql.includes('FROM full_product_export_activation')) return result([{ phase: 'active', required_writer_version: 1 }]);
      if (sql.includes('pg_try_advisory_lock')) return result([{ held: true }]);
      if (sql.includes('FROM magento_auto_sync_activation')) return result([{ enabled: true, legacy_product_csv_enabled: false, actor_user_id: '1', installation_key: 'fixture' }]);
      if (sql.includes('FROM magento_binding_revisions')) return result([{ id: 'publication' }]);
      if (sql.startsWith('SELECT p.*')) return result([structuredClone(f.product)]);
      if (sql.startsWith('SELECT * FROM product_full_export_state')) return result([structuredClone(f.lifecycle)]);
      if (sql.startsWith('SELECT\n    EXISTS')) return result([structuredClone(f.facts)]);
      if (sql.startsWith('SELECT 1 FROM magento_sync_jobs')) return result([{ exists: true }]);
      if (sql.includes('FROM magento_product_sync_requests')) return result([f.request || { product_id: 12, desired_generation: '4', synced_generation: '4', state: 'synced' }]);
      if (sql.startsWith('SELECT * FROM product_visibility_intents')) return result([structuredClone(f.intent)]);
      if (sql.startsWith('UPDATE product_visibility_intents')) {
        if (sql.includes('previous_remote_status=$2')) f.intent.previous_remote_status = values[1];
        if (sql.includes("state='dispatched'")) { f.intent.state = 'dispatched'; f.intent.dispatched_at = '2026-10-05T00:00:00Z'; }
        if (sql.includes("state='verified'")) { f.intent.state = 'verified'; f.intent.verified_at = '2026-10-05T00:00:01Z'; f.intent.reason_code = null; }
        if (sql.includes('reason_code=$2')) { f.intent.state = f.intent.dispatched_at ? 'dispatched' : 'blocked'; f.intent.reason_code = values[1]; }
        return result([structuredClone(f.intent)]);
      }
      if (sql.startsWith('INSERT INTO audit_events')) { events.push(values); return result([{ id: events.length }]); }
      return result();
    } };
  return db;
}

test('future archived visibility verifies exact identity and readback, then repeats without a second status write', async () => {
  const f = fixture(), db = workerDb(f); let status = 1, writes = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify({ items: [{ id: 71, sku: f.product.public_sku, status }], total_count: 1 }), { headers: { 'Content-Type': 'application/json' } });
  };
  const options = { databasePool: db, fetchImpl, setVisibility: async (config, payload) => { writes++; assert.deepEqual(payload, { sku: f.product.public_sku, status: 2 }); status = 2; } };
  await visibility.runIntent(config, f.intent.id, options);
  assert.equal(f.intent.state, 'verified'); assert.equal(f.intent.previous_remote_status, 1); assert.equal(writes, 1);
  assert.ok(f.intent.dispatched_at); assert.ok(f.intent.verified_at);
  await visibility.runIntent(config, f.intent.id, options); assert.equal(writes, 1);
  assert.deepEqual(f.product.details.answers, { weight: 12.7, is_calibrated: 2 });
});

test('timeout or rejection with unconfirmed readback stays dispatched and is never automatically resent after restart', async () => {
  const f = fixture(), db = workerDb(f); let writes = 0;
  const options = { databasePool: db, fetchImpl: async () => new Response(JSON.stringify({ items: [{ id: 71, sku: f.product.public_sku, status: 1 }], total_count: 1 }),
    { headers: { 'Content-Type': 'application/json' } }), setVisibility: async () => { writes++; throw new Error('Synthetic timeout'); } };
  await visibility.runIntent(config, f.intent.id, options);
  assert.equal(f.intent.state, 'dispatched'); assert.equal(f.intent.reason_code, 'PRODUCT_VISIBILITY_UNCERTAIN'); assert.equal(writes, 1);
  await visibility.runIntent(config, f.intent.id, options); assert.equal(writes, 1);
  const inspected = await visibility.inspect(config, f.intent.id, options);
  assert.equal(inspected.canConfirm, false); assert.equal(inspected.observedStatus, 1); assert.equal(writes, 1);
});

test('identity mismatch, active successor, local drift and revoked actor cannot dispatch a hide', async () => {
  for (const mutate of [
    (f) => { f.facts.activeSuccessor = true; },
    (f) => { f.product.total_price_uah = '500'; },
    (f) => { f.facts.confirmedRemoteId = '72'; },
    (_f, db) => { db.setAuthorized(false); },
  ]) {
    const f = fixture(), db = workerDb(f); mutate(f, db);
    await visibility.runIntent(config, f.intent.id, { databasePool: db, fetchImpl: () => assert.fail('Unsafe local state called Magento'),
      setVisibility: () => assert.fail('Unsafe state wrote Magento') });
    assert.equal(f.intent.state, 'blocked'); assert.equal(f.intent.dispatched_at, null);
  }
});

function restoredFixture() {
  const f = fixture();
  f.product.status = 'active'; f.product.exclude_from_export = 0; f.lifecycle.route = 'normal';
  f.intent.kind = 'restore'; f.intent.source_hide_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  f.intent.expected_generation = '4'; f.intent.target_status = 1;
  f.intent.local_fingerprint = state.fingerprint(f.product, f.lifecycle);
  return f;
}
const photoProof = () => ({ jobId: 'photo-fixture', version: '3', photoIds: ['cccccccc-cccc-cccc-cccc-cccccccccccc'],
  remoteProductId: 71, nativeGeneration: '4' });
const response = (f, status, id = 71) => new Response(JSON.stringify({ total_count: 1, items: [{ id, sku: f.product.public_sku, status }] }),
  { headers: { 'content-type': 'application/json' } });

test('visibility restore waits for exact current-generation native confirmation and refuses a later generation', async () => {
  const f = restoredFixture(), db = workerDb(f);
  f.request = { product_id: 12, desired_generation: '4', synced_generation: '3', state: 'pending' };
  await visibility.runIntent(config, f.intent.id, { databasePool: db, fetchImpl: () => assert.fail('Native pending called Magento'),
    setVisibility: () => assert.fail('Native pending enabled visibility') });
  assert.equal(f.intent.state, 'queued');
  f.request.desired_generation = '5';
  await visibility.runIntent(config, f.intent.id, { databasePool: db, fetchImpl: () => assert.fail('Later generation called Magento') });
  assert.equal(f.intent.state, 'blocked'); assert.equal(f.intent.reason_code, 'PRODUCT_VISIBILITY_GENERATION_CHANGED');
});

test('enabling requires fresh photo proof and local proof equality immediately before dispatch and acknowledgement', async () => {
  for (const phase of ['missing', 'before', 'after', 'unchanged']) {
    const f = restoredFixture(), db = workerDb(f); let status = 2, writes = 0, localVersion = '3', freshChecks = 0;
    const options = { databasePool: db, fetchImpl: async () => response(f, status),
      verifyPhotoSet: async () => {
        freshChecks++;
        if (phase === 'missing') throw Object.assign(new Error('No photographs'), { code: 'PHOTO_ACTIVATION_PROOF_REQUIRED' });
        if (phase === 'before') localVersion = '4';
        return { ...photoProof(), verifiedAt: '2026-10-05T01:00:00Z' };
      }, canEnable: async () => ({ ...photoProof(), version: localVersion }),
      setVisibility: async (_config, payload) => { writes++; assert.equal(payload.status, 1); status = 1; if (phase === 'after') localVersion = '4'; } };
    await visibility.runIntent(config, f.intent.id, options);
    assert.equal(freshChecks, 1);
    assert.equal(writes, ['after', 'unchanged'].includes(phase) ? 1 : 0);
    assert.equal(f.intent.state, phase === 'unchanged' ? 'verified' : phase === 'after' ? 'dispatched' : 'blocked');
    if (phase === 'after') {
      await visibility.runIntent(config, f.intent.id, options); assert.equal(writes, 1);
      const inspected = await visibility.inspect(config, f.intent.id, options);
      const result = await visibility.reconcile(config, { intentId: f.intent.id, reviewHash: inspected.reviewHash, confirmVerifiedResult: true },
        { ...options, mutationContext: { actorUserId: 1 }, verifyPhotoSet: async () => ({ ...photoProof(), version: '4', verifiedAt: '2026-10-05T01:01:00Z' }) });
      assert.equal(result.state, 'verified'); assert.equal(writes, 1);
    }
  }
});

test('uncertain dispatch can only be acknowledged after a fresh exact read-only inspection, never resent', async () => {
  const f = fixture(), db = workerDb(f); let status = 1, writes = 0;
  const options = { databasePool: db, fetchImpl: async () => response(f, status), mutationContext: { actorUserId: 1 },
    setVisibility: async () => { writes++; throw Error('Connection lost'); } };
  await visibility.runIntent(config, f.intent.id, options); assert.equal(f.intent.state, 'dispatched');
  status = 2;
  const inspected = await visibility.inspect(config, f.intent.id, options); assert.equal(inspected.canConfirm, true);
  await assert.rejects(visibility.reconcile(config, { intentId: f.intent.id, reviewHash: '0'.repeat(64), confirmVerifiedResult: true }, options),
    { code: 'PRODUCT_VISIBILITY_REVIEW_STALE' });
  assert.equal(f.intent.state, 'dispatched');
  const result = await visibility.reconcile(config, { intentId: f.intent.id, reviewHash: inspected.reviewHash, confirmVerifiedResult: true }, options);
  assert.equal(result.state, 'verified'); assert.ok(result.hiddenAt); assert.equal(writes, 1);
  await visibility.reconcile(config, { intentId: f.intent.id, reviewHash: inspected.reviewHash, confirmVerifiedResult: true }, options);
  assert.equal(writes, 1);
});

test('fresh Magento identity replacement cannot receive a status PUT', async () => {
  const f = fixture(), db = workerDb(f);
  await visibility.runIntent(config, f.intent.id, { databasePool: db, fetchImpl: async () => response(f, 1, 72),
    setVisibility: () => assert.fail('Identity replacement received PUT') });
  assert.equal(f.intent.state, 'blocked'); assert.equal(f.intent.reason_code, 'PRODUCT_REMOTE_IDENTITY_CHANGED');
});

test('blocked pre-dispatch failure can acknowledge only an exact already-observed target, without reconstructing prior visibility', async () => {
  const f = fixture(), db = workerDb(f); let writes = 0;
  await visibility.runIntent(config, f.intent.id, { databasePool: db, fetchImpl: async () => { throw Error('Synthetic GET outage'); },
    setVisibility: () => { writes++; } });
  assert.equal(f.intent.state, 'blocked'); assert.equal(f.intent.previous_remote_status, null); assert.equal(writes, 0);
  const options = { databasePool: db, fetchImpl: async () => response(f, 2), mutationContext: { actorUserId: 1 } };
  const inspected = await visibility.inspect(config, f.intent.id, options); assert.equal(inspected.canConfirm, true);
  await visibility.reconcile(config, { intentId: f.intent.id, reviewHash: inspected.reviewHash, confirmVerifiedResult: true }, options);
  assert.equal(f.intent.state, 'verified'); assert.equal(f.intent.previous_remote_status, null); assert.equal(writes, 0);
  assert.equal(state.restoreProof(f.product, f.lifecycle, f.facts, f.intent).visibility.action, 'preserve');
});
