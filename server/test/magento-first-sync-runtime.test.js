const { test } = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../src/services/magento/first-sync-runtime');
const service = require('../src/services/magento/first-sync.service');
const ledger = require('../src/services/magento/first-sync-ledger');

function fixture() {
  const state = { productId: 7, publicIdentityId: '17', publicSku: 'AG-000017',
    revision: { id: 'binding-a', originHash: 'origin-a', installationKey: 'installation-a' } };
  const observation = { raw: null, amber: { product: { id: 7, public_product_identity_id: '17', public_sku: state.publicSku },
    revision: { ...state.revision } } };
  const job = { id: 'job-a', product_id: 7, binding_revision_id: state.revision.id,
    installation_key: state.revision.installationKey,
    public_product_identity_id: '17', sku: state.publicSku, origin_hash: state.revision.originHash,
    remote_product_id: 77, baseline: { raw: null },
    intent: { mode: 'create', operations: [{ domain: 'coreProduct', payload: { product: { sku: state.publicSku } } }] } };
  return { state, observation, job };
}
function receipts() {
  const fields = [
    { target: 'name', scope: 'all', state: 'name_received', after: 'UA' },
    { target: 'name', scope: 'en', state: 'name_received', after: 'EN' },
    { target: 'price', scope: 'all', state: 'pending_outward_confirmation', after: '200' },
  ];
  const progress = { session: { revision: '4', public_sku: 'AG-000017', remote_product_id: '77',
    installation_key: 'installation-a', completed_at: null }, fields };
  return { mode: 'first', readyForOutbound: true,
    first: { key: { originHash: 'origin-a', publicIdentityId: '17' }, progress },
    prepared: { rows: fields.map(field => ({ target: field.target, scope: field.scope, record: { ...field } })),
      manifest: fields.map(({ target, scope }) => ({ target, scope })), complete: false } };
}
async function withDependencies(operation) {
  const calls = { inspect: [], commit: [], read: [], query: [], http: 0 };
  const controls = { inspection: { mode: 'create', readyForOutbound: true }, current: null,
    verified: true, commitResult: { revision: '5', localChanged: false }, commitError: null };
  const client = { async query(sql, params) {
    calls.query.push({ sql, params });
    assert.match(sql, /^SELECT 1 FROM magento_sync_steps/);
    assert.deepEqual(params, ['job-a']);
    return { rowCount: controls.verified ? 1 : 0, rows: [] };
  } };
  const options = { databasePool: client };
  const patches = [
    [service, 'inspect', async (...args) => { calls.inspect.push(args); return controls.inspection; }],
    [service, 'commit', async (...args) => { calls.commit.push(args); if (controls.commitError) throw controls.commitError; return controls.commitResult; }],
    [ledger, 'readOnClient', async (received, key) => { assert.equal(received, client); calls.read.push(key); return controls.current; }],
    [globalThis, 'fetch', async () => { calls.http++; assert.fail('Runtime guard must not perform HTTP'); }],
  ];
  const restore = patches.map(([object, key, value]) => { const original = object[key]; object[key] = value; return () => { object[key] = original; }; });
  try { await operation({ controls, calls, client, options }); assert.equal(calls.http, 0); }
  finally { restore.reverse().forEach(fn => fn()); }
}
const rejection = code => ({ code: 'MAGENTO_FIRST_SYNC_' + code });

test('CREATE proof stays opaque and reusable only for the same absent-product job', async () => {
  await withDependencies(async ({ options, calls }) => {
    const f = fixture();
    const lane = await runtime.enforce({}, f.observation, f.state, options, { job: f.job });
    assert.equal(runtime.isCreateLane(lane), true); assert.equal(Object.isFrozen(lane), true);
    assert.equal(runtime.isCreateLane({}), false);
    assert.equal(await runtime.enforce({}, f.observation, f.state, options, { job: f.job, createLane: lane }), lane);
    assert.equal(calls.inspect.length, 1); assert.equal(calls.query.length, 0);
    await assert.rejects(runtime.enforce({}, f.observation, f.state, options, { job: f.job, createLane: {} }), rejection('CREATE_CONTEXT_CHANGED'));
  });
});

const contextChanges = [
  ['job ID', f => { f.job.id = 'job-b'; }],
  ['product', f => { f.state.productId = 8; f.job.product_id = 8; }],
  ['binding', f => { f.state.revision.id = 'binding-b'; f.job.binding_revision_id = 'binding-b'; }],
  ['origin', f => { f.state.revision.originHash = 'origin-b'; f.job.origin_hash = 'origin-b'; }],
  ['installation', f => { f.state.revision.installationKey = 'installation-b'; }],
  ['public identity', f => { f.state.publicIdentityId = '18'; f.job.public_product_identity_id = '18'; }],
  ['SKU', f => { f.state.publicSku = 'AG-000018'; f.job.sku = 'AG-000018'; }],
  ['job product', f => { f.job.product_id = 8; }],
  ['job binding', f => { f.job.binding_revision_id = 'binding-b'; }],
  ['job installation', f => { f.job.installation_key = 'installation-b'; }],
  ['job origin', f => { f.job.origin_hash = 'origin-b'; }],
  ['job identity', f => { f.job.public_product_identity_id = '18'; }],
  ['job SKU', f => { f.job.sku = 'AG-000018'; }],
  ['UPDATE intent', f => { f.job.intent.mode = 'update'; }],
  ['missing job', f => { f.job = null; }],
];
for (const [label, change] of contextChanges) test('CREATE reuse rejects changed ' + label, async () => {
  await withDependencies(async ({ options, calls }) => {
    const original = fixture();
    const lane = await runtime.enforce({}, original.observation, original.state, options, { job: original.job });
    const changed = structuredClone(original); change(changed);
    await assert.rejects(runtime.enforce({}, changed.observation, changed.state, options,
      { job: changed.job, createLane: lane }), rejection('CREATE_CONTEXT_CHANGED'));
    assert.equal(calls.inspect.length, 1); assert.equal(calls.query.length, 0);
  });
});

test('newly visible remote product continues CREATE only after its own verified core step', async () => {
  await withDependencies(async ({ options, calls, controls }) => {
    const f = fixture();
    const lane = await runtime.enforce({}, f.observation, f.state, options, { job: f.job });
    f.observation.raw = { id: 77, sku: f.job.sku };
    controls.verified = false;
    await assert.rejects(runtime.enforce({}, f.observation, f.state, options, { job: f.job, createLane: lane }), rejection('CREATE_IDENTITY_CHANGED'));
    controls.verified = true;
    assert.equal(await runtime.enforce({}, f.observation, f.state, options, { job: f.job, createLane: lane }), lane);
    assert.equal(calls.query.length, 2); assert.equal(calls.inspect.length, 1);
  });
});

for (const [label, change] of [
  ['remote ID', f => { f.observation.raw.id = 78; }],
  ['remote SKU', f => { f.observation.raw.sku = 'AG-000018'; }],
  ['observed identity', f => { f.observation.amber.product.public_product_identity_id = '18'; }],
  ['observed origin', f => { f.observation.amber.revision.originHash = 'origin-b'; }],
  ['existing baseline', f => { f.job.baseline.raw = { id: 77 }; }],
  ['CREATE payload SKU', f => { f.job.intent.operations[0].payload.product.sku = 'AG-000018'; }],
  ['core step position', f => { f.job.intent.operations.unshift({ domain: 'images' }); }],
]) test('visible CREATE continuation rejects changed ' + label, async () => {
  await withDependencies(async ({ options, calls }) => {
    const f = fixture();
    const lane = await runtime.enforce({}, f.observation, f.state, options, { job: f.job });
    f.observation.raw = { id: 77, sku: f.job.sku }; change(f);
    await assert.rejects(runtime.enforce({}, f.observation, f.state, options, { job: f.job, createLane: lane }), rejection('CREATE_IDENTITY_CHANGED'));
    assert.equal(calls.query.length, 0); assert.equal(calls.inspect.length, 1);
  });
});

test('UPDATE cannot obtain owned CREATE continuation from a verified core step', async () => {
  await withDependencies(async ({ controls, options, calls }) => {
    const f = fixture(); f.job.intent.mode = 'update'; f.observation.raw = { id: 77, sku: f.job.sku };
    controls.inspection = { mode: 'review', readyForOutbound: false };
    await assert.rejects(runtime.enforce({}, f.observation, f.state, options, { job: f.job }), rejection('FIELDS_UNRESOLVED'));
    assert.equal(calls.inspect.length, 1); assert.equal(calls.query.length, 0);
  });
});

test('restart can recover its own verified CREATE continuation without adopting the remote product', async () => {
  await withDependencies(async ({ options, calls }) => {
    const f = fixture(); f.observation.raw = { id: 77, sku: f.job.sku };
    const lane = await runtime.enforce({}, f.observation, f.state, options, { job: f.job });
    assert.equal(runtime.isCreateLane(lane), true);
    assert.equal(calls.query.length, 1); assert.equal(calls.inspect.length, 0); assert.equal(calls.commit.length, 0);
  });
});

test('ordinary dispatch authority cannot be reused as a CREATE proof', async () => {
  await withDependencies(async ({ options, controls }) => {
    const f = fixture(); controls.inspection = { mode: 'ordinary', readyForOutbound: true };
    const lane = await runtime.enforce({}, f.observation, f.state, options, { job: f.job });
    assert.equal(runtime.isCreateLane(lane), false);
    await assert.rejects(runtime.enforce({}, f.observation, f.state, options, { job: f.job, createLane: lane }), rejection('CREATE_CONTEXT_CHANGED'));
  });
});

async function firstLane(context) {
  const f = fixture(); f.job.intent.mode = 'update'; f.observation.raw = { id: 77, sku: f.job.sku };
  context.controls.inspection = receipts(); context.controls.current = structuredClone(context.controls.inspection.first.progress);
  const lane = await runtime.enforce({}, f.observation, f.state, context.options, { job: f.job });
  assert.equal(context.calls.commit.length, 0, 'unchanged receipt rows do not need a commit');
  return lane;
}

test('dispatch rereads full receipt manifest on its supplied client, including EN and pending outward confirmation', async () => {
  await withDependencies(async context => {
    const lane = await firstLane(context);
    assert.equal(runtime.isCreateLane(lane), false);
    await runtime.assertDispatchOnClient(context.client, lane);
    assert.deepEqual(context.calls.read, [{ originHash: 'origin-a', publicIdentityId: '17' }]);
    assert.equal(context.calls.query.length, 0);
    await assert.rejects(runtime.assertDispatchOnClient(context.client, {}), rejection('DISPATCH_REVIEW_REQUIRED'));
  });
});

for (const [label, change, code] of [
  ['receipt revision advances after inspection', current => { current.session.revision = '5'; }, 'DISPATCH_RECEIPT_CHANGED'],
  ['SKU', current => { current.session.public_sku = 'AG-000018'; }, 'DISPATCH_RECEIPT_CHANGED'],
  ['remote ID', current => { current.session.remote_product_id = 78; }, 'DISPATCH_RECEIPT_CHANGED'],
  ['installation', current => { current.session.installation_key = 'installation-b'; }, 'DISPATCH_RECEIPT_CHANGED'],
  ['missing English receipt', current => { current.fields = current.fields.filter(field => field.scope !== 'en'); }, 'FIELDS_UNRESOLVED'],
  ['conflicted English receipt', current => { current.fields[1].state = 'conflict'; }, 'FIELDS_UNRESOLVED'],
  ['unresolved prior scope outside current manifest', current => { current.fields.push({ target: 'old_target', scope: 'all', state: 'review_required' }); }, 'FIELDS_UNRESOLVED'],
]) test('dispatch rejects ' + label, async () => {
  await withDependencies(async context => {
    const lane = await firstLane(context); change(context.controls.current);
    await assert.rejects(runtime.assertDispatchOnClient(context.client, lane), rejection(code));
    assert.equal(context.calls.read.length, 1);
  });
});

test('dispatch rejects deleted session and incomplete proof manifest', async () => {
  await withDependencies(async context => {
    const lane = await firstLane(context); context.controls.current = null;
    await assert.rejects(runtime.assertDispatchOnClient(context.client, lane), rejection('DISPATCH_RECEIPT_CHANGED'));
    context.controls.inspection.prepared.manifest = [];
    const f = fixture();
    const incomplete = await runtime.enforce({}, f.observation, f.state, context.options, { job: f.job });
    await assert.rejects(runtime.assertDispatchOnClient(context.client, incomplete), rejection('DISPATCH_REVIEW_REQUIRED'));
  });
});

test('committed canonical imports require a fresh Amber snapshot before dispatch authority is issued', async () => {
  await withDependencies(async context => {
    const f = fixture(); context.controls.inspection = receipts();
    context.controls.inspection.first.progress = null;
    context.controls.commitResult.localChanged = true;
    await assert.rejects(runtime.enforce({}, f.observation, f.state, context.options, { job: f.job }), { code: 'MAGENTO_SYNC_AMBER_CHANGED' });
    assert.equal(context.calls.commit.length, 1);
  });
});

test('ledger compare-and-swap failure retains the first-sync error classification', async () => {
  await withDependencies(async context => {
    const f = fixture(); context.controls.inspection = receipts();
    context.controls.inspection.first.progress = null;
    context.controls.commitError = Object.assign(new Error('revision advanced'), { code: 'FIRST_SYNC_REVISION_CHANGED' });
    await assert.rejects(runtime.enforce({}, f.observation, f.state, context.options, { job: f.job }), rejection('REVISION_CHANGED'));
    assert.equal(context.calls.commit.length, 1);
  });
});
