'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const outbound = require('../scripts/sv-campaign-outbound');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clone = value => structuredClone(value);
function fixture() {
  const config = { baseUrl: 'https://synthetic.invalid' }, origin = 'a'.repeat(64);
  const item = { sku: 'AG-000020', productId: 7, remoteProductId: 70, category: 'SV' };
  const binding = { id: '11111111-1111-4111-8111-111111111111', revision: '9', definitionHash: 'b'.repeat(64),
    installationKey: 'amber', originHash: origin, state: 'published' };
  const scope = { bindingRevisionId: binding.id, expectedDefinitionHash: binding.definitionHash, installationKey: 'amber' };
  const product = { id: 7, public_product_identity_id: '77', public_sku: item.sku, category: 'SV', total_price_uah: '50',
    exportState: { route: 'normal' } };
  const observation = { amber: { product, revision: binding, compiled: { hash: binding.definitionHash } },
    raw: { id: 70, sku: item.sku }, domainEvidence: { failures: [] } };
  const memory = { locked: false, busy: false, unlocks: 0, releases: 0, request: null, jobs: [], handoffs: [], items: [], audits: [],
    outstandingHandoffs: [], workReads: [], onHandoffRead: null,
    applyCalls: 0, previewCalls: 0, getCalls: 0, checkpoints: [], appliedAfterPrepared: false, snapshotChanged: false };
  const result = rows => ({ rows, rowCount: rows.length });
  async function query(sql, args = []) {
    if (sql.includes('FROM public_product_identities')) return result([{ id: 7, category: 'SV', status: 'active',
      exclude_from_export: 0, corrected_to_product_id: null, public_identity_id: '77', public_sku: item.sku }]);
    if (sql.includes('pg_try_advisory_lock')) { assert.equal(args[0], 'amber_magento_public_identity:77');
      memory.locked = !memory.busy; return result([{ held: memory.locked }]); }
    if (sql.includes('pg_advisory_unlock')) { memory.locked = false; memory.unlocks++; return result([{ pg_advisory_unlock: true }]); }
    if (sql.includes('FROM magento_product_sync_requests')) { memory.workReads.push('request'); return result(memory.request ? [clone(memory.request)] : []); }
    if (sql.includes('FROM magento_sync_jobs')) return result(clone(memory.jobs));
    if (sql.includes('FROM magento_binding_handoff_items') && sql.includes("state IN ('pending','protected')")) {
      assert.deepEqual(args, ['77']); assert.equal(sql.includes('origin_hash'), false);
      memory.workReads.push('handoffs');
      const rows = clone(memory.outstandingHandoffs); memory.onHandoffRead?.(); return result(rows);
    }
    if (sql.includes('FROM magento_binding_handoff_items')) return result(clone(memory.items));
    if (sql.includes('FROM magento_binding_handoffs')) return result(clone(memory.handoffs));
    if (sql.includes('FROM audit_events')) return result(clone(memory.audits));
    throw Error('Unexpected synthetic query: ' + sql);
  }
  const databasePool = { query, connect: async () => ({ query, release() { memory.releases++; } }) };
  const run = { databasePool, actorUserId: 1, fetchImpl: async (_url, init) => {
    memory.getCalls++; assert.equal(init.method, 'GET'); return { ok: true };
  } };
  const base = { mode: 'ordinary', readyForOutbound: true, blockers: [],
    first: { admissionGuards: { protectedWork: false, otherOrigin: false } } };
  const report = { sendable: true };
  const runtime = {
    c: { hash, originHash: () => origin },
    batch: { source: p => ({ id: p.id, publicIdentityId: p.public_product_identity_id, price: p.total_price_uah }) },
    boundary: { guard: async (_config, _input, _run, operation) => operation({}),
      observe: async (_config, _input, options) => { await options.fetchImpl('https://synthetic.invalid/read', { method: 'GET' });
        return { observation: clone(observation), report: clone(report) }; } },
    first: { inspect: async () => clone(base) },
    history: { read: async () => ({ complete: true, hasRecount: false, identityChanged: false, issues: [], corrections: [], products: [{ productId: 7 }] }) },
    price: { readCurrencyEvidence: async () => ({ verified: true, currency: 'UAH' }) },
    jobPlan: { intent: current => { assert.equal(current.sendable, true); return { mode: 'update', operations: [
      { domain: 'coreProduct' }, { domain: 'categoryLinkSave' }, { domain: 'websites' }] }; }, baseline: () => ({ raw: { id: 70 } }) },
    policy: { assertIntent: () => true },
    nameProof: { issue: () => ({ proof: true }) },
    outboundPreview: { applyFirstSyncNameProof: current => current },
    readSnapshot: async () => { const copy = clone(observation.amber); if (memory.snapshotChanged) copy.product.total_price_uah = '51'; return copy; },
    controlled: { handoffExclusivityVersion: 1, preview: async (_config, request) => { memory.previewCalls++; assert.deepEqual(request.productIds, [7]);
      const response = { revision: clone(binding), products: [{ productId: 7, publicIdentityId: '77', article: item.sku }], blockers: [] };
      return { ...response, previewToken: hash({ input: request, report: response }) }; },
    apply: async (_config, command, options) => {
      memory.applyCalls++; assert.equal(memory.locked, true); assert.equal(options.mutationContext.actorUserId, 1);
      memory.appliedAfterPrepared = memory.checkpoints.at(-1)?.type === 'prepared';
      const prepared = memory.checkpoints.at(-1).prepared;
      memory.handoffs = [{ id: '22222222-2222-4222-8222-222222222222', binding_revision_id: binding.id,
        kind: 'broader_resync', preview_hash: command.previewToken, actor_user_id: 1,
        evidence: { reason: command.reason.trim(), products: [{ productId: 7, publicIdentityId: '77', article: item.sku }] } }];
      assert.equal(hash(memory.handoffs[0].evidence), prepared.evidenceHash);
      memory.items = [{ product_id: 7, public_product_identity_id: '77', reason: 'reviewed_resync' }];
      memory.audits = [{ actor_user_id: 1, details: { previewToken: command.previewToken, productCount: 1, reason: command.reason.trim() } }];
      return { handoffId: memory.handoffs[0].id, alreadyApplied: false };
    } }
  };
  const options = { authority: async () => {}, checkpoint: async record => memory.checkpoints.push(clone(record)), stopping: () => false };
  const pending = state => ({ public_product_identity_id: '77', product_id: 7, desired_generation: '3', synced_generation: '2',
    state, reason_code: null, active_job_id: null, active_generation: null });
  return { runtime, config, item, scope, run, memory, options, pending, base, report };
}
test('whole-SKU public identity lane is exclusive and releases once', async () => {
  const f = fixture(); const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
  assert.equal(lane.status, 'acquired'); assert.equal(f.memory.locked, true);
  await lane.release(); await lane.release(); assert.equal(f.memory.unlocks, 1);
  f.memory.busy = true; const busy = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
  assert.equal(busy.status, 'review'); assert.equal(busy.reason, 'SV_CAMPAIGN_OUTBOUND_BUSY');
});
test('ANY unfinished job blocks local entry without adoption or retry', async () => {
  for (const job of [{ id: 'x', state: 'queued', automatic_generation: '2', has_steps: false },
    { id: 'x', state: 'uncertain', dispatched: true }, { id: 'x', state: 'blocked', automatic_generation: null }]) {
    const f = fixture(); f.memory.jobs = [job];
    const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
    assert.equal(lane.status, 'review'); assert.equal(f.memory.locked, false); assert.equal(f.memory.applyCalls, 0);
  }
});
test('pending and protected handoffs on the identity block local entry before requests exist', async () => {
  for (const state of ['pending', 'protected']) {
    const f = fixture(); f.memory.outstandingHandoffs = [{ handoff_id: 'earlier-handoff', product_id: 7, state }];
    const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
    assert.equal(lane.status, 'review'); assert.equal(lane.reason, 'SV_CAMPAIGN_OUTBOUND_EXISTING_HANDOFF');
    assert.equal(f.memory.locked, false); assert.equal(f.memory.applyCalls, 0); assert.equal(f.memory.getCalls, 0);
    assert.deepEqual(f.memory.workReads, ['handoffs', 'request']);
  }
});
test('new pending request permits pipeline and yields existing generation without duplicate handoff', async () => {
  const f = fixture(); f.memory.request = f.pending('pending');
  const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
  try {
    const result = await outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options);
    assert.equal(result.status, 'already_pending'); assert.equal(result.receipt.generation, '3');
    assert.equal(f.memory.applyCalls, 0); assert.equal(f.memory.previewCalls, 0); assert.equal(f.memory.getCalls, 1);
    assert.equal(f.memory.checkpoints.length, 1);
    await outbound.verifyReceipt(f.runtime, f.config, f.item, f.scope, f.memory.checkpoints[0], f.run);
  } finally { await lane.release(); }
});
test('no request, synced and needs_attention use one reviewed canonical full-product handoff', async () => {
  for (const state of [null, 'synced', 'needs_attention']) {
    const f = fixture(); f.memory.request = state ? f.pending(state) : null;
    const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
    try {
      const result = await outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options);
      assert.equal(result.status, 'queued'); assert.equal(f.memory.applyCalls, 1); assert.equal(f.memory.appliedAfterPrepared, true);
      assert.deepEqual(f.memory.checkpoints.map(record => record.type), ['prepared', 'receipt']);
      await outbound.verifyReceipt(f.runtime, f.config, f.item, f.scope, f.memory.checkpoints[1], f.run);
      f.memory.items.push({ product_id: 8, public_product_identity_id: '78', reason: 'reviewed_resync' });
      await assert.rejects(outbound.verifyReceipt(f.runtime, f.config, f.item, f.scope, f.memory.checkpoints[1], f.run),
        { code: 'SV_CAMPAIGN_HANDOFF_RECEIPT_UNCONFIRMED' });
    } finally { await lane.release(); }
  }
});
test('pending request appearing during controlled preview is not re-enrolled', async () => {
  const f = fixture(), original = f.runtime.controlled.preview;
  f.runtime.controlled.preview = async (...args) => { const report = await original(...args); f.memory.request = f.pending('pending'); return report; };
  const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
  try { const result = await outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options);
    assert.equal(result.status, 'already_pending'); assert.equal(f.memory.applyCalls, 0);
  } finally { await lane.release(); }
});
test('pending or protected handoff appearing during preview prevents another enrollment', async () => {
  for (const state of ['pending', 'protected']) {
    const f = fixture(), original = f.runtime.controlled.preview;
    f.runtime.controlled.preview = async (...args) => {
      const report = await original(...args);
      f.memory.outstandingHandoffs = [{ handoff_id: 'concurrent-handoff', product_id: 7, state }]; return report;
    };
    const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
    try {
      const result = await outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options);
      assert.equal(result.status, 'review'); assert.equal(result.reason, 'SV_CAMPAIGN_OUTBOUND_EXISTING_HANDOFF');
      assert.equal(f.memory.applyCalls, 0); assert.equal(f.memory.checkpoints.length, 0);
    } finally { await lane.release(); }
  }
});
test('handoff enrollment between reads cannot hide both pending item and resulting request', async () => {
  const f = fixture(); const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
  // Simulate the enrollment transaction committing just after the outstanding
  // item read. The subsequent request read must observe its new generation.
  f.memory.onHandoffRead = () => { f.memory.request = f.pending('pending'); f.memory.onHandoffRead = null; };
  try {
    const result = await outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options);
    assert.equal(result.status, 'already_pending'); assert.equal(f.memory.applyCalls, 0); assert.equal(f.memory.previewCalls, 0);
    for (let index = 0; index < f.memory.workReads.length; index += 2)
      assert.deepEqual(f.memory.workReads.slice(index, index + 2), ['handoffs', 'request']);
  } finally { await lane.release(); }
});
test('source drift and genuine policy conflicts produce review without handoff', async () => {
  for (const change of [f => { f.memory.snapshotChanged = true; },
    f => { f.runtime.policy.assertIntent = () => { throw Object.assign(Error('conflict'), { code: 'SV_CAMPAIGN_POLICY_CONFLICT', statusCode: 409 }); }; }]) {
    const f = fixture(); const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run); change(f);
    try { const result = await outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options);
      assert.equal(result.status, 'review'); assert.equal(f.memory.applyCalls, 0);
    } finally { await lane.release(); }
  }
});
test('prepared checkpoint failure makes zero mutations; unknown apply and receipt failures stop recovery', async () => {
  for (const stage of ['prepared', 'apply', 'receipt', 'verify']) {
    const f = fixture(); const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
    if (stage === 'apply') f.runtime.controlled.apply = async () => { throw Error('lost reply'); };
    if (stage === 'verify') { const original = f.runtime.controlled.apply;
      f.runtime.controlled.apply = async (...args) => { const result = await original(...args); f.memory.audits = []; return result; }; }
    const checkpoint = f.options.checkpoint;
    if (['prepared', 'receipt'].includes(stage)) f.options.checkpoint = async record => {
      if (record.type === stage) throw Error('disk unavailable'); await checkpoint(record);
    };
    try { await assert.rejects(outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options), error => {
      assert.equal(error.uncertain === true, stage !== 'prepared');
      if (stage === 'prepared') assert.equal(f.memory.applyCalls, 0);
      return true;
    }); } finally { await lane.release(); }
  }
});
test('unlocked or wrong-SKU handoff and non-GET network attempts fail closed', async () => {
  const f = fixture();
  await assert.rejects(outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options), { code: 'SV_CAMPAIGN_OUTBOUND_LANE_REQUIRED' });
  const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
  try {
    await assert.rejects(outbound.handoff(f.runtime, f.config, { ...f.item, productId: 8 }, f.scope, f.run, f.options),
      { code: 'SV_CAMPAIGN_OUTBOUND_LANE_REQUIRED' });
    f.runtime.boundary.observe = async (_config, _input, run) => run.fetchImpl('https://synthetic.invalid', { method: 'PUT', body: '{}' });
    const result = await outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options);
    assert.equal(result.status, 'review'); assert.equal(result.reason, 'SV_CAMPAIGN_REMOTE_WRITE_DENIED');
    assert.equal(f.memory.getCalls, 0); assert.equal(f.memory.applyCalls, 0);
  } finally { await lane.release(); }
});
test('GET override cannot hide a body carried by the Request object', async () => {
  for (const request of [{ method: 'GET', body: 'forbidden' },
    new Request('https://synthetic.invalid', { method: 'POST', body: 'forbidden' })]) {
    const f = fixture(); const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
    try {
      f.runtime.boundary.observe = async (_config, _input, run) => run.fetchImpl(request, { method: 'GET' });
      const result = await outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options);
      assert.equal(result.status, 'review'); assert.equal(result.reason, 'SV_CAMPAIGN_REMOTE_WRITE_DENIED');
      assert.equal(f.memory.getCalls, 0); assert.equal(f.memory.applyCalls, 0);
    } finally { await lane.release(); }
  }
});
test('401/403 without codes and named global authority errors escape per-SKU review', async () => {
  for (const details of [{ statusCode: 401 }, { statusCode: 403 }, { code: 'ADMIN_PERMISSION_REVOKED' },
    { code: 'CAMPAIGN_AUTHORITY_CHANGED', statusCode: 409 }, { code: 'MAGENTO_BINDING_CONFLICT', statusCode: 409 },
    { code: 'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED', statusCode: 409 },
    { code: 'MAGENTO_PUBLICATION_ADMINISTRATOR_REQUIRED' }, { code: 'ACTOR_NOT_ACTIVE' }]) {
    const f = fixture(); const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
    const failure = Object.assign(Error('global authority failure'), details);
    f.options.authority = async () => { throw failure; };
    try {
      await assert.rejects(outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options), error => error === failure);
      assert.equal(f.memory.applyCalls, 0); assert.equal(f.memory.getCalls, 0);
    } finally { await lane.release(); }
  }
});
test('publication drift stops the entire run before any handoff', async () => {
  const f = fixture(); const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
  f.scope.expectedDefinitionHash = 'c'.repeat(64);
  try {
    await assert.rejects(outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options),
      { code: 'SV_CAMPAIGN_PUBLICATION_CHANGED' });
    assert.equal(f.memory.applyCalls, 0);
  } finally { await lane.release(); }
});
test('marked authority failures remain global even with local-looking 409 codes', async () => {
  for (const authorityCall of [1, 2]) {
    const f = fixture(); const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
    const failure = Object.assign(Error('authority unavailable'), {
      code: 'LOCAL_LOOKING_CONFLICT', statusCode: 409, svAuthorityFailure: true
    });
    let calls = 0;
    f.options.authority = async () => { if (++calls === authorityCall) throw failure; };
    try {
      await assert.rejects(outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options), error => error === failure);
      assert.equal(f.memory.applyCalls, 0); assert.equal(f.memory.checkpoints.length, 0);
    } finally { await lane.release(); }
  }
});

test('adapter rejects a deployed runtime without atomic handoff exclusion before any work', async () => {
  for (const version of [undefined, 0, '1', 2]) {
    const f = fixture(); f.runtime.controlled.handoffExclusivityVersion = version;
    f.options.authority = async () => assert.fail('No authority or database reads before capability check');
    await assert.rejects(outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options),
      { code: 'SV_CAMPAIGN_ATOMIC_HANDOFF_GUARD_REQUIRED' });
    assert.equal(f.memory.getCalls, 0); assert.equal(f.memory.applyCalls, 0); assert.equal(f.memory.checkpoints.length, 0);
  }
});

test('operator run ID passes through the canonical mutation context', async () => {
  const f = fixture(); f.run.requestId = '33333333-3333-4333-8333-333333333333';
  const original = f.runtime.controlled.apply;
  f.runtime.controlled.apply = async (config, command, options) => {
    assert.equal(options.mutationContext.requestId, f.run.requestId);
    return original(config, command, options);
  };
  const lane = await outbound.acquireLane(f.runtime, f.config, f.item, f.run);
  try { assert.equal((await outbound.handoff(f.runtime, f.config, f.item, f.scope, f.run, f.options)).status, 'queued'); }
  finally { await lane.release(); }
});
