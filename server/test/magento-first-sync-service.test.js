
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../src/services/magento/binding-contract');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { normalizeBindings } = require('../src/services/magento/binding-validation');
const fixture = require('./fixtures/magento-bindings');
const service = require('../src/services/magento/first-sync.service');

function observation() {
  const definition = structuredClone(fixture.definition());
  definition.sources.size.key = 'braclet_size';
  const schemaInput = structuredClone(fixture.schema());
  schemaInput.attributes.find(a => a.attribute_code === 'name').scope = 'store';
  const size = schemaInput.attributes.find(a => a.attribute_code === 'dovzhyna_brasletu_diuimiv');
  size.frontend_input = 'text'; size.options = [];
  const compiled = compileDefinition(definition), schema = c.normalizeSchema(schemaInput);
  const approved = fixture.approvedBindings(compiled.definition, schema, 'BR');
  for (const policy of approved.policies) policy.policy = 'authoritative_create_update';
  const revision = { id: '11111111-1111-4111-8111-111111111111', state: 'published', installationKey: 'service-fixture',
    templateVersionId: '22222222-2222-4222-8222-222222222222', definitionHash: compiled.hash,
    evaluatorVersion: compiled.definition.evaluatorVersion, outputContract: compiled.definition.outputContract,
    formatVersion: compiled.definition.formatVersion, schemaFingerprint: c.hash(schema),
    topologyFingerprint: c.hash(schema.storeTopology), schema, bindings: normalizeBindings(approved) };
  const product = { id: 7, category: 'BR', full_sku: 'BR-service', public_sku: 'BR-service',
    weight: '5.000', total_price_uah: '42.00', details: { answers: { binding_test_semantic: 7, braclet_size: '17' } } };
  const raw = { id: 81, sku: product.public_sku, attribute_set_id: 8001, name: 'Remote UA', price: '43.00',
    custom_attributes: [{ attribute_code: 'kolir', value: 'red-id' }, { attribute_code: 'decor_weight', value: 'small-id' },
      { attribute_code: 'dovzhyna_brasletu_diuimiv', value: '18' }] };
  return { amber: { product, compiled, revision,
    template: { kind: 'published', versionId: revision.templateVersionId, definitionHash: compiled.hash } },
    raw, schema, categoryNodes: [], categoryFailures: [], domainEvidence: { english: { id: raw.id, sku: raw.sku, fields: { name: 'Remote EN' } }, failures: [] } };
}

// These fakes stop at external authority, storage and canonical mutation boundaries.
// Projection, decision planning, public command validation and retry routing are real.
function harness(t) {
  const config = { baseUrl: 'https://service-fixture.invalid' }, observed = observation();
  const state = { publicSku: observed.amber.product.public_sku, publicIdentityId: '33333333-3333-4333-8333-333333333333',
    revision: observed.amber.revision };
  const calls = { observed: 0, authorized: 0, receiptRead: 0, ledger: 0, local: 0, price: 0, validated: 0 };
  const receipts = new Map(), writes = [], trace = [];
  let progress = null, revoked = false, failObservation = false, ledgerInput;
  const client = { query: async () => ({ rows: [] }), release() {} };
  const databasePool = { connect: async () => client, query: async (sql, values) => {
    assert.match(sql, /FROM magento_first_sync_progress/); calls.receiptRead++; trace.push('receipt');
    const receipt = receipts.get(values[2]); return { rows: receipt ? [receipt] : [] };
  } };
  const options = { databasePool, actorUserId: 9, observeRate: async () => null };
  const boundary = require('../src/services/magento/sync-job.service').recoveryBoundary;
  t.mock.method(boundary, 'guard', async (_config, _input, _options, fn) => fn(state));
  t.mock.method(boundary, 'observe', async () => {
    calls.observed++; if (failObservation) throw Object.assign(new Error('Read failed'), { code: 'REMOTE_READ_FAILED' });
    return { observation: observed };
  });
  t.mock.method(require('../src/services/magento/binding-publication'), 'administrator', async () => {
    calls.authorized++; trace.push('authorize');
    if (revoked) throw Object.assign(new Error('Revoked'), { code: 'ADMIN_PERMISSION_REVOKED' });
  });
  t.mock.method(require('../src/services/magento/first-sync-eligibility'), 'readFirstSyncEligibility', async () =>
    ({ mode: 'first', blockers: [], key: { originHash: c.originHash(config.baseUrl), publicIdentityId: state.publicIdentityId },
      evidenceHash: 'e'.repeat(64), progress }));
  t.mock.method(require('../src/services/magento/sync-job-transaction'), 'revalidate', async () => {});
  const price = require('../src/services/magento/first-sync-price');
  t.mock.method(price, 'readCurrencyEvidence', async () => ({ verified: false }));
  t.mock.method(price, 'prepareFirstSyncPrice', async () => ({ blockedFields: [] }));
  t.mock.method(price, 'applyFirstSyncPrice', async (_client, input) => {
    calls.price++; assert.equal(input.acceptedFields.length, 0); return { changed: false };
  });
  const local = require('../src/services/magento/first-sync-local-apply');
  t.mock.method(local, 'prepareFirstSyncLocal', async () => { calls.validated++; return { blockedFields: [] }; });
  t.mock.method(local, 'applyFirstSyncLocal', async (_client, input) => {
    calls.local++; writes.push(structuredClone(input.acceptedFields)); return { changed: input.acceptedFields.length > 0 };
  });
  for (const method of ['commit', 'rollback', 'release']) t.mock.method(require('../src/services/full-product-cutover-gate'), method, async () => {});
  t.mock.method(require('../src/services/magento/first-sync-ledger'), 'recordProgressOnClient', async (tx, input) => {
    calls.ledger++; ledgerInput = structuredClone(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'applyLocal')));
    const accepted = input.fields.filter(field => ['imported', 'name_received'].includes(field.state)
      && !progress?.fields.some(prior => prior.target === field.target && prior.scope === field.scope && prior.state === field.state));
    if (accepted.length) await input.applyLocal(tx, accepted);
    const result = { sessionId: '44444444-4444-4444-8444-444444444444', revision: '1',
      completed: input.complete, readyForOutbound: input.readyForOutbound, alreadyApplied: false };
    receipts.set(input.previewHash, { command: ledgerInput, result: structuredClone(result),
      public_sku: state.publicSku, installation_key: state.revision.installationKey });
    return result;
  });
  return { config, observed, options, state, calls, receipts, writes, trace,
    get ledgerInput() { return ledgerInput; }, set progress(value) { progress = value; },
    set revoked(value) { revoked = value; }, set failObservation(value) { failObservation = value; } };
}
async function inputFor(h) {
  const preview = await service.review(h.config, { sku: h.state.publicSku, bindingRevisionId: h.state.revision.id }, h.options);
  assert.equal(preview.mode, 'first');
  return { sku: h.state.publicSku, bindingRevisionId: h.state.revision.id, previewToken: preview.previewToken,
    target: 'dovzhyna_brasletu_diuimiv', scope: 'all', choice: 'accept_remote' };
}

test('public apply recovers a lost response exactly and retains blocked whole-product readiness', async t => {
  const h = harness(t), input = await inputFor(h);
  const originalAmber = h.observed.amber;
  const committed = await service.apply(h.config, input, h.options);
  assert.equal(h.observed.amber, originalAmber);
  assert.equal(committed.readyForOutbound, false); assert.equal(committed.complete, false);
  assert.equal(committed.receipt.state, 'imported'); assert.equal(h.calls.local, 1);
  assert.ok(h.writes[0].some(field => field.target === input.target && field.after === '18'));
  const before = { ...h.calls };
  h.failObservation = true; // Recovery must succeed even if a new remote read would fail.
  const retry = await service.apply(h.config, input, h.options);
  assert.deepEqual(retry, { ...committed, receipt: { ...committed.receipt, alreadyApplied: true } });
  for (const key of ['observed', 'ledger', 'local', 'price', 'validated']) assert.equal(h.calls[key], before[key], key);
  assert.equal(h.calls.authorized, before.authorized + 1);
  assert.deepEqual(h.trace.slice(-2), ['authorize', 'receipt']);
});

test('historical decision replay stays idempotent while fresh optional-receipt review blocks new work', async t => {
  const h=harness(t),input=await inputFor(h),committed=await service.apply(h.config,input,h.options);
  const blockers=[{code:'FIRST_SYNC_OPTIONAL_EMPTY_RECEIPT_REVIEW_REQUIRED',target:'kamin_obrobka',scope:'all'}];
  t.mock.method(require('../src/services/magento/first-sync-eligibility'),'readFirstSyncEligibility',
    async()=>({mode:'review',blockers}));
  const before={...h.calls};
  const replay=await service.apply(h.config,input,h.options);
  assert.deepEqual(replay,{...committed,receipt:{...committed.receipt,alreadyApplied:true}});
  const review=await service.review(h.config,{sku:h.state.publicSku,bindingRevisionId:h.state.revision.id},h.options);
  assert.deepEqual(review.blockers,blockers);assert.equal(review.mode,'review');
  assert.equal(review.complete,false);assert.equal(review.readyForOutbound,false);assert.deepEqual(review.fields,[]);
  await assert.rejects(service.apply(h.config,{...input,previewToken:'a'.repeat(64)},h.options),
    {code:'MAGENTO_FIRST_SYNC_PREVIEW_STALE'});
  for(const key of ['ledger','local','price','validated'])assert.equal(h.calls[key],before[key],key);
});

test('changed choice, target, scope or preview hash cannot reuse a committed decision receipt', async t => {
  const h = harness(t), input = await inputFor(h);
  await service.apply(h.config, input, h.options);
  const writes = h.calls.local;
  h.failObservation = true;
  for (const patch of [{ choice: 'keep_local' }, { target: 'name' }, { scope: 'en' }, { previewToken: 'f'.repeat(64) }]) {
    const observations = h.calls.observed;
    await assert.rejects(service.apply(h.config, { ...input, ...patch }, h.options), { code: 'REMOTE_READ_FAILED' });
    assert.equal(h.calls.observed, observations + 1);
    assert.equal(h.calls.local, writes); assert.equal(h.calls.ledger, 1);
  }
});

test('receipt recovery rechecks administrator authority before reading durable progress', async t => {
  const h = harness(t), input = await inputFor(h);
  await service.apply(h.config, input, h.options);
  const before = { ...h.calls }; h.revoked = true;
  await assert.rejects(service.apply(h.config, input, h.options), { code: 'ADMIN_PERMISSION_REVOKED' });
  assert.equal(h.calls.receiptRead, before.receiptRead);
  assert.equal(h.calls.observed, before.observed); assert.equal(h.calls.local, before.local);
});

test('stored receipt identity or decision mismatch fails closed without transport or mutation', async t => {
  const h = harness(t), input = await inputFor(h);
  await service.apply(h.config, input, h.options);
  const hash = c.hash({ previewToken: input.previewToken, decision: { target: input.target, scope: input.scope, choice: input.choice } });
  const original = structuredClone(h.receipts.get(hash)), before = { ...h.calls };
  for (const alter of [
    receipt => { receipt.public_sku = 'OTHER'; },
    receipt => { receipt.installation_key = 'other-installation'; },
    receipt => { receipt.command.fields.find(field => field.target === input.target).source.decision = 'keep_local'; },
  ]) {
    const broken = structuredClone(original); alter(broken); h.receipts.set(hash, broken);
    await assert.rejects(service.apply(h.config, input, h.options), { code: 'MAGENTO_FIRST_SYNC_RECEIPT_CONFLICT' });
  }
  assert.equal(h.calls.observed, before.observed); assert.equal(h.calls.local, before.local); assert.equal(h.calls.ledger, 1);
});

test('descendant progress retains terminal ancestor source product identity and initialization evidence', async t => {
  const h = harness(t);
  const initial = await service.inspect(h.config, h.observed, h.options);
  const ancestor = structuredClone(initial.prepared.rows.find(row => row.target === 'name' && row.scope === 'all').record);
  ancestor.source.productId = 3;
  h.progress = { session: { revision: '4', initial_product_id: 3,
    initial_binding_revision_id: '55555555-5555-4555-8555-555555555555' },
    fields: [{ ...ancestor, revision: '1', recordedAt: '2026-10-09T00:00:00Z' }] };
  const descendant = await service.inspect(h.config, h.observed, h.options);
  assert.deepEqual(descendant.prepared.rows.find(row => row.target === 'name' && row.scope === 'all').record, ancestor);
  await service.commit(h.config, descendant, h.state, h.options);
  assert.deepEqual(h.ledgerInput.fields.find(field => field.target === 'name' && field.scope === 'all'), ancestor);
  assert.equal(h.ledgerInput.identity.initialProductId, 3);
  assert.equal(h.ledgerInput.identity.initialBindingRevisionId, '55555555-5555-4555-8555-555555555555');
  assert.ok(h.writes.every(fields => fields.every(field => field.target !== 'name' || field.scope !== 'all')));
});

test('unknown reads keep public review blocked and failed observation cannot apply local changes', async t => {
  const h = harness(t);
  h.observed.domainEvidence = { failures: [{ operation: 'storeViews', code: 'STORE_VIEW_READ_UNAVAILABLE' }] };
  const preview = await service.review(h.config, { sku: h.state.publicSku, bindingRevisionId: h.state.revision.id }, h.options);
  assert.equal(preview.readyForOutbound, false); assert.equal(preview.complete, false);
  assert.ok(preview.fields.some(field => field.scope === 'en' && field.status === 'unknown'));
  assert.equal(h.calls.local, 0); assert.equal(h.calls.ledger, 0);
  await assert.rejects(service.apply(h.config, { sku: h.state.publicSku, bindingRevisionId: h.state.revision.id,
    previewToken: preview.previewToken, target: 'name', scope: 'en', choice: 'accept_remote' }, h.options),
  { code: 'MAGENTO_FIRST_SYNC_DECISION_NOT_AVAILABLE' });
  assert.equal(h.calls.local, 0); assert.equal(h.calls.ledger, 0);
  h.failObservation = true;
  await assert.rejects(service.apply(h.config, { sku: h.state.publicSku, bindingRevisionId: h.state.revision.id,
    previewToken: preview.previewToken, target: 'name', scope: 'en', choice: 'accept_remote' }, h.options), { code: 'REMOTE_READ_FAILED' });
  assert.equal(h.calls.local, 0); assert.equal(h.calls.ledger, 0);
});
