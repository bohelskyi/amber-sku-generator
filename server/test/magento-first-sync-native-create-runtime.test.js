const test = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../src/services/magento/first-sync-runtime');
const service = require('../src/services/magento/first-sync.service');
const ledger = require('../src/services/magento/first-sync-ledger');
const optional = require('../src/services/magento/first-sync-optional-receipt-audit');
const birth = require('../src/services/magento/first-sync-native-create');
const recovery = require('../src/services/magento/sync-job-recovery');

function fixture() {
  const state = { productId: 7, publicIdentityId: '17', publicSku: 'AG-000017',
    revision: { id: 'binding-a', originHash: 'origin-a', installationKey: 'installation-a' } };
  const observation = { raw: null, domainEvidence: {}, schema: {}, categoryNodes: [],
    amber: { product: { id: 7, public_product_identity_id: '17', public_sku: state.publicSku }, revision: { ...state.revision } } };
  const job = { id: 'job-a', product_id: 7, public_product_identity_id: '17', sku: state.publicSku,
    binding_revision_id: state.revision.id, installation_key: state.revision.installationKey,
    origin_hash: state.revision.originHash, remote_product_id: null, plan_hash: 'plan-a',
    baseline: { raw: null, allocatedFirstCreate: { format: 'test-reference' } },
    intent: { mode: 'create', operations: [{ domain: 'coreProduct', payload: { product: { sku: state.publicSku, status: 2 } } }] } };
  return { state, observation, job };
}

async function dependencies(operation) {
  const calls = { inspect: 0, commit: 0, issue: [], assertions: [], sql: [], releases: 0, http: 0 };
  const issued = new WeakSet();
  const originalProof = Object.freeze({}); issued.add(originalProof);
  const control = { inspection: { mode: 'create', readyForOutbound: true, first: { nativeCreate: originalProof } },
    available: true, current: true, verifiedCore: true, optionalBlockers: [] };
  const client = { async query(sql) {
    calls.sql.push(sql);
    assert.match(sql, /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|COMMIT|ROLLBACK)$/);
    return { rows: [], rowCount: 0 };
  }, release() { calls.releases++; } };
  const databasePool = { async connect() { return client; }, async query(sql) {
    calls.sql.push(sql); assert.match(sql, /^SELECT 1 FROM magento_sync_steps/);
    return { rows: [], rowCount: control.verifiedCore ? 1 : 0 };
  } };
  const options = { databasePool, automatic: { generation: '1' } };
  const patches = [
    [service, 'inspect', async () => { calls.inspect++; return control.inspection; }],
    [service, 'commit', async () => { calls.commit++; assert.fail('CREATE must not import or write first-sync progress'); }],
    [ledger, 'readOnClient', async () => null],
    [optional, 'assessOnClient', async () => ({ blockers: control.optionalBlockers, evidence: [] })],
    [birth, 'readOnClient', async (received, config, observation, details) => {
      assert.equal(received, client); calls.issue.push({ config, raw: observation.raw, ...details });
      if (!control.available || observation.raw === undefined) return null;
      const proof = Object.freeze({}); issued.add(proof); return proof;
    }],
    [birth, 'assertOnClient', async (received, proof) => {
      assert.equal(received, client); calls.assertions.push(proof);
      if (!issued.has(proof) || !control.current) throw Object.assign(new Error('stale'), { code: 'MAGENTO_FIRST_SYNC_NATIVE_CREATE_CHANGED' });
    }],
    [birth, 'baselineReference', proof => {
      assert.equal(issued.has(proof), true); return { format: 'test-reference' };
    }],
    [globalThis, 'fetch', async () => { calls.http++; assert.fail('Runtime proof must not perform HTTP'); }],
  ];
  const restore = patches.map(([object, key, replacement]) => {
    const old = object[key]; object[key] = replacement; return () => { object[key] = old; };
  });
  try { await operation({ calls, control, client, options, originalProof }); assert.equal(calls.http, 0); assert.equal(calls.commit, 0); }
  finally { restore.reverse().forEach(fn => fn()); }
}
const changed = { code: 'MAGENTO_FIRST_SYNC_NATIVE_CREATE_CHANGED' };

test('new birth proof cannot mint a manual job; ordinary legacy CREATE retains its existing lane', async () => {
  await dependencies(async context => {
    const f = fixture(); const manual = { databasePool: context.options.databasePool };
    await assert.rejects(runtime.enforce({}, f.observation, f.state, manual),
      { code: 'MAGENTO_FIRST_SYNC_NATIVE_CREATE_AUTOMATIC_REQUIRED' });
    context.control.inspection = { mode: 'create', readyForOutbound: true };
    const legacy = await runtime.enforce({}, f.observation, f.state, manual);
    assert.equal(runtime.isCreateLane(legacy), true);
    assert.equal(runtime.nativeCreateReference(legacy), null);
  });
});

test('initial automatic enqueue authority must recheck birth evidence on the supplied dispatch client', async () => {
  await dependencies(async context => {
    const f = fixture(); const lane = await runtime.enforce({}, f.observation, f.state, context.options);
    assert.deepEqual(runtime.nativeCreateReference(lane), { format: 'test-reference' });
    await runtime.assertDispatchOnClient(context.client, lane);
    assert.deepEqual(context.calls.assertions, [context.originalProof]);
    context.control.current = false;
    await assert.rejects(runtime.assertDispatchOnClient(context.client, lane), changed);
  });
});

test('marked job cannot fall through a plain CREATE or ordinary inspection without its birth proof', async () => {
  await dependencies(async context => {
    const f = fixture();
    for (const mode of ['create', 'ordinary']) {
      context.control.inspection = { mode, readyForOutbound: true };
      await assert.rejects(runtime.enforce({}, f.observation, f.state, context.options, { job: f.job }), changed);
    }
  });
});

test('reusing a marked absent CREATE lane freshly rereads birth/media proof and rejects stale evidence', async () => {
  await dependencies(async context => {
    const f = fixture(); const lane = await runtime.enforce({}, f.observation, f.state, context.options, { job: f.job });
    assert.equal(await runtime.enforce({}, f.observation, f.state, context.options, { job: f.job, createLane: lane }), lane);
    assert.equal(context.calls.issue.length, 1);
    assert.equal(context.calls.issue[0].referenceOnly, false);
    assert.equal(context.calls.issue[0].jobId, f.job.id);
    context.control.available = false;
    await assert.rejects(runtime.enforce({}, f.observation, f.state, context.options, { job: f.job, createLane: lane }), changed);
    assert.equal(context.calls.inspect, 1);
    assert.equal(context.calls.releases, 2);
  });
});

test('unknown remote state cannot redeem a marked lane as reference-only evidence', async () => {
  await dependencies(async context => {
    const f = fixture(); const lane = await runtime.enforce({}, f.observation, f.state, context.options, { job: f.job });
    delete f.observation.raw;
    await assert.rejects(runtime.enforce({}, f.observation, f.state, context.options, { job: f.job, createLane: lane }), changed);
    assert.equal(context.calls.issue[0].referenceOnly, false);
    assert.equal(context.calls.issue[0].raw, undefined);
  });
});

test('verified own core CREATE still rechecks the marked birth/media reference before later dispatch', async () => {
  await dependencies(async context => {
    const f = fixture(); f.job.remote_product_id = 77; f.observation.raw = { id: 77, sku: f.job.sku };
    const lane = await runtime.enforce({}, f.observation, f.state, context.options, { job: f.job });
    assert.equal(context.calls.inspect, 0);
    assert.equal(context.calls.issue[0].referenceOnly, true);
    await runtime.assertDispatchOnClient(context.client, lane);
    assert.equal(context.calls.assertions.length, 1);
    context.control.current = false;
    await assert.rejects(runtime.assertDispatchOnClient(context.client, lane), changed);
    context.control.available = false;
    await assert.rejects(runtime.enforce({}, f.observation, f.state, context.options, { job: f.job, createLane: lane }), changed);
  });
});

for (const [label, alter] of [
  ['remote identity', f => { f.observation.raw.id = 78; }],
  ['foreign SKU', f => { f.observation.raw.sku = 'AG-000018'; }],
  ['unverified core step', (_f, context) => { context.control.verifiedCore = false; }],
]) test('marked CREATE continuation rejects ' + label + ' before reference-only issuance', async () => {
  await dependencies(async context => {
    const f = fixture(); const lane = await runtime.enforce({}, f.observation, f.state, context.options, { job: f.job });
    f.job.remote_product_id = 77; f.observation.raw = { id: 77, sku: f.job.sku }; alter(f, context);
    await assert.rejects(runtime.enforce({}, f.observation, f.state, context.options, { job: f.job, createLane: lane }),
      { code: 'MAGENTO_FIRST_SYNC_CREATE_IDENTITY_CHANGED' });
    assert.equal(context.calls.issue.length, 0);
  });
});

test('opaque reviewed recovery cannot bypass stale birth/media proof before first CREATE dispatch', async () => {
  await dependencies(async context => {
    const f = fixture(); const review = { jobId: f.job.id, planHash: f.job.plan_hash,
      jobFingerprint: recovery.fingerprint(f.job, []), remoteFingerprint: recovery.remoteFingerprint(f.observation), blockers: [] };
    const proof = runtime.reviewedRecovery(f.job, [], f.observation, review);
    context.control.available = false;
    await assert.rejects(runtime.enforce({}, f.observation, f.state,
      { ...context.options, firstSyncRecoveryProof: proof }, { job: f.job }), changed);
    assert.equal(context.calls.inspect, 0);
    assert.equal(context.calls.issue[0].referenceOnly, false);
  });
});

test('ordinary legacy reviewed CREATE recovery does not require a new allocated birth reference', async () => {
  await dependencies(async context => {
    const f = fixture(); delete f.job.baseline.allocatedFirstCreate;
    const review = { jobId: f.job.id, planHash: f.job.plan_hash,
      jobFingerprint: recovery.fingerprint(f.job, []), remoteFingerprint: recovery.remoteFingerprint(f.observation), blockers: [] };
    const proof = runtime.reviewedRecovery(f.job, [], f.observation, review);
    const lane = await runtime.enforce({}, f.observation, f.state,
      { ...context.options, firstSyncRecoveryProof: proof }, { job: f.job });
    await runtime.assertDispatchOnClient(context.client, lane);
    assert.equal(context.calls.issue.length, 0);
    assert.equal(context.calls.assertions.length, 0);
  });
});

test('optional-receipt quarantine still wins for a marked birth lane', async () => {
  await dependencies(async context => {
    const f = fixture(); const lane = await runtime.enforce({}, f.observation, f.state, context.options, { job: f.job });
    context.control.optionalBlockers = [{ code: 'FIRST_SYNC_OPTIONAL_EMPTY_RECEIPT_REVIEW_REQUIRED' }];
    await assert.rejects(runtime.assertDispatchOnClient(context.client, lane),
      { code: 'MAGENTO_FIRST_SYNC_OPTIONAL_EMPTY_RECEIPT_REVIEW_REQUIRED' });
    assert.equal(context.calls.assertions.length, 0);
  });
});
