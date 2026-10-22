const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../src/services/correction-request-batch.service');
const evidence = require('../src/services/correction-request-batch-evidence');
const receipts = require('../src/services/correction-request-batch-receipts');
const requests = require('../src/services/correction-request.service');
const gate = require('../src/services/full-product-cutover-gate');
test.before(() => test.mock.method(require('node:net').Socket.prototype, 'connect',
  () => assert.fail('Batch unit tests must not open network connections')));

function fixture(t, ids = [1]) {
  const decision = { mode: 'manual_uah', manualPriceUah: 100, marketingRoundingEnabled: false };
  const f = { calls: [], queries: [], checkpoints: [], released: 0, connects: 0, rows: new Map(), sources: new Map(),
    phases: new Map(), previews: new Map(), guardErrors: new Map(), permissions: ['corrections.view', 'corrections.complete', 'corrections.claim'] };
  for (const id of ids) {
    f.rows.set(id, { id, source_product_id: id + 10, request_type: 'price_change', status: 'pending',
      claimed_by_user_id: null, claim_token_hash: null, claim_version: '2', pricing_mode: 'manual_uah',
      pricing_manual_uah: 100, pricing_rounding_enabled: false, old_payload: { stateSignature: `source-${id}` },
      proposed_payload: { pricing: { manualPriceUah: 100 }, totalPriceUah: 100, pricingDecision: decision },
      preview_signature: `preview-${id}` });
    f.sources.set(id + 10, { product: { id: id + 10, status: 'active', corrected_to_product_id: null,
      public_sku: `AG-${String(id).padStart(6, '0')}`, public_product_identity_id: id + 100,
      characteristic_version_id: 1, full_sku: null, base_sku: null, sequence_number: null, sku_schema_version_id: null },
      lifecycle: { route: 'normal' }, current_identity_count: 1 });
    f.previews.set(id, { productId: id + 10, publicSku: `AG-${String(id).padStart(6, '0')}`,
      resultingPricing: { manualPriceUah: 100 }, resultingPriceUah: 100, pricingDecision: decision,
      productStateSignature: `source-${id}`, previewToken: `preview-${id}` });
    f.phases.set(id, []);
  }
  f.client = { release: () => { f.released++; f.calls.push('release'); }, query: async (sql, values) => {
    f.queries.push({ sql, values });
    if (sql.startsWith('SELECT pg_try_advisory_lock')) {
      f.calls.push('lane'); return { rows: [{ held: !f.busy }] };
    }
    if (/^SELECT pg_advisory_(lock|unlock)/.test(sql) || /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SAVEPOINT|RELEASE SAVEPOINT)/.test(sql)) return { rows: [] };
    if (sql.includes("to_regclass('full_product_export_activation')")) return { rows: [{ present: true }] };
    if (sql === 'SELECT * FROM full_product_export_activation WHERE singleton=TRUE') return { rows: [{ phase: 'legacy', required_writer_version: 1 }] };
    if (sql.includes('FROM application_users u')) {
      assert.deepEqual(values, [7, 'corrections.view']);
      assert.ok(!sql.includes('FOR KEY SHARE'), 'Preflight access read stays read-only');
      return { rows: [{ status: f.actorStatus || 'active', has_permission: true }] };
    }
    if (sql.startsWith('SELECT DISTINCT rp.permission_key')) return { rows: f.permissions.map((permission_key) => ({ permission_key })) };
    if (sql.startsWith('SELECT id FROM correction_requests WHERE status IN')) {
      assert.deepEqual(values, [f.options.limit + 1]); return { rows: ids.map((id) => ({ id })) };
    }
    assert.fail(`Unexpected SQL: ${sql}`);
  } };
  const databasePool = {
    query: async (sql) => {
      assert.equal(sql, 'SELECT current_database() name'); f.calls.push('database');
      return { rows: [{ name: f.databaseName || 'batch_test' }] };
    },
    connect: async () => { f.connects++; f.calls.push('connect'); return f.client; },
  };
  const rateObservation = { rateInfo: null };
  f.options = { databasePool, expectedDatabase: 'batch_test', actorUserId: 7, connectionTargetHash: 'target', buildId: 'unit-build', requestIds: ids,
    observeRate: async ({ databasePool: actual }) => { assert.equal(actual, databasePool); f.calls.push('observe'); return rateObservation; },
    checkpoint: async (report) => { f.checkpoints.push(structuredClone(report)); },
  };
  t.mock.method(receipts, 'databaseIdentity', async (client, target) => {
    assert.equal(client, f.client); assert.equal(target, 'target');
    return { name: f.identityName || 'batch_test', connectionTargetHash: target };
  });
  t.mock.method(receipts, 'readRequest', async (client, id) => {
    assert.ok(client === f.client || client === databasePool);
    const row = f.rows.get(id); assert.ok(row, `Unexpected request ${id}`);
    return { row, requestHash: evidence.hash(row) };
  });
  t.mock.method(receipts, 'readSource', async (client, id) => { assert.equal(client, f.client); return f.sources.get(id); });
  t.mock.method(requests, 'deriveCorrectionRequestRefresh', async (row, options) => {
    assert.equal(options.queryable, f.client); assert.equal(options.rateObservation, rateObservation);
    f.calls.push(`derive:${row.id}`);
    if (f.deriveError) throw f.deriveError;
    return { preview: f.previews.get(row.id), signature: `signature-${row.id}` };
  });
  t.mock.method(receipts, 'begin', async (client, options, permission) => {
    assert.equal(permission, 'corrections.complete');
    assert.equal(options.batchReview.actorUserId, 7);
    assert.equal(options.batchReview.mutationActorUserId, 7);
    assert.equal(options.rateObservation, rateObservation);
    await gate.begin(client);
  });
  t.mock.method(receipts, 'release', (client) => gate.release(client));
  t.mock.method(receipts, 'steps', async (client, review) => {
    assert.equal(client, f.client); return f.phases.get(review.entry.requestId);
  });
  t.mock.method(receipts, 'guard', async (client, review) => {
    assert.equal(client, f.client); const id = review.entry.requestId;
    f.calls.push(`guard:${id}`);
    if (f.abortOnGuard) f.abortOnGuard.abort();
    if (f.guardErrors.has(id)) throw f.guardErrors.get(id);
    return f.rows.get(id);
  });
  const checkStep = async (id, options) => {
    assert.equal(options.batchReview.entry.requestId, id);
    assert.equal(options.mutationContext.actorUserId, 7);
    assert.equal(options.mutationContext.requestId, `correction-batch:${options.batchReview.planHash}`);
    assert.equal(options.rateObservation, rateObservation);
    const borrowed = await options.databasePool.connect(); borrowed.release();
    assert.equal(f.released, f.connects - 1, 'Borrowed client release must not return the live lane connection');
  };
  t.mock.method(requests, 'claimCorrectionRequest', async (id, options) => {
    await checkStep(id, options); f.calls.push(`claim:${id}`);
    f.rows.get(id).claim_version = '3'; f.rows.get(id).claimed_by_user_id = 7;
    f.phases.get(id).push({ details: { phase: 'refreshed' } });
  });
  t.mock.method(requests, 'refreshCorrectionRequest', async (id, version, token, options) => {
    await checkStep(id, options); assert.equal(version, Number(f.rows.get(id).claim_version)); assert.equal(token, null);
    f.calls.push(`refresh:${id}`); f.phases.get(id).push({ details: { phase: 'refreshed' } });
  });
  t.mock.method(requests, 'completeCorrectionRequest', async (id, version, token, options) => {
    await checkStep(id, options); assert.equal(version, Number(f.rows.get(id).claim_version)); assert.equal(token, null);
    f.calls.push(`complete:${id}`);
    if (!f.omitCompletionReceipt) f.phases.get(id).push({ details: { phase: 'completed', result: { productId: id + 10 } } });
    if (f.completeError) throw f.completeError;
    return { draftSyncFailures: f.draftWarnings || [] };
  });
  f.sealed = () => {
    const entries = ids.map((requestId) => ({ requestId, publicArticle: f.sources.get(requestId + 10).product.public_sku,
      classification: 'SAFE_TO_COMPLETE', postDeliveryReviewRequired: false }));
    const body = { format: evidence.FORMAT, policyVersion: evidence.POLICY_VERSION, toolContract: evidence.TOOL_CONTRACT,
      actorUserId: 7, databaseIdentity: { name: 'batch_test', connectionTargetHash: 'target' }, buildId: 'unit-build',
      requestIds: ids, entries: entries.map((entry) => ({ ...entry, entryHash: evidence.hash(entry) })) };
    const plan = { ...body, planHash: evidence.hash(body) };
    const selection = service.select(plan, plan.planHash, ids);
    Object.assign(f.options, { expectedHash: plan.planHash, expectedSelectionHash: selection.selectionHash });
    return { plan, selection };
  };
  f.entry = async () => { const { plan, selection } = f.sealed(); return service.applyEntry(plan, selection, plan.entries[0], f.options); };
  return f;
}

function assertClean(f) {
  assert.equal(f.released, f.connects);
  const held = f.queries.filter(({ sql }) => sql.startsWith('SELECT pg_advisory_lock_shared')).length;
  assert.equal(f.queries.filter(({ sql }) => sql.startsWith('SELECT pg_advisory_unlock_shared')).length, held);
  assert.ok(!f.queries.some(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/.test(sql)), 'Orchestrator must delegate business writes');
}

test('preflight rejects invalid actor and wrong target before rate observation or client lease', async (t) => {
  const f = fixture(t);
  await assert.rejects(service.preflight({ ...f.options, actorUserId: 0 }), { code: 'CORRECTION_BATCH_ARGUMENTS' });
  assert.deepEqual(f.calls, []);
  f.databaseName = 'different_test';
  await assert.rejects(service.preflight(f.options), { code: 'CORRECTION_BATCH_DATABASE_MISMATCH' });
  assert.deepEqual(f.calls, ['database']);
});

test('preflight seals current intent in a read-only snapshot after rate observation', async (t) => {
  const f = fixture(t), plan = await service.preflight(f.options);
  evidence.verifyPlan(plan, plan.planHash);
  assert.deepEqual(f.calls.slice(0, 3), ['database', 'observe', 'connect']);
  assert.ok(f.queries.some(({ sql }) => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.equal(plan.entries[0].classification, 'SAFE_TO_COMPLETE');
  assert.equal(plan.summary.SAFE_TO_COMPLETE, 1);
  assert.deepEqual(plan.entries[0].requiredPermissions, ['corrections.view', 'corrections.complete', 'corrections.claim']);
  assert.equal(plan.entries[0].publicArticle, 'AG-000001');
  assert.deepEqual(plan.entries[0].rateEvidence, { unavailable: true }); assertClean(f);
});

for (const [label, mutate, code] of [
  ['disabled actor', (f) => { f.actorStatus = 'disabled'; }, 'ADMIN_PERMISSION_REVOKED'],
  ['changed database identity', (f) => { f.identityName = 'changed_test'; }, 'CORRECTION_BATCH_DATABASE_MISMATCH'],
  ['invalid all-active bound', (f) => { delete f.options.requestIds; f.options.allActive = true; f.options.limit = 0; }, 'CORRECTION_BATCH_SCOPE_INVALID'],
  ['ambiguous explicit/all-active scope', (f) => { f.options.allActive = true; f.options.limit = 1; }, 'CORRECTION_BATCH_SCOPE_INVALID'],
]) {
  test(`preflight refuses ${label} and releases its read-only transaction`, async (t) => {
    const f = fixture(t); mutate(f);
    await assert.rejects(service.preflight(f.options), { code });
    assert.ok(f.queries.some(({ sql }) => sql === 'ROLLBACK')); assertClean(f);
  });
}

test('all-active scope fetches limit+1 and refuses overflow rather than silently truncating', async (t) => {
  const f = fixture(t, [1, 2]); delete f.options.requestIds; Object.assign(f.options, { allActive: true, limit: 1 });
  await assert.rejects(service.preflight(f.options), { code: 'CORRECTION_BATCH_SCOPE_OVERFLOW' });
  assert.ok(!f.calls.some((call) => call.startsWith('derive:'))); assertClean(f);
  f.options.limit = 2;
  const plan = await service.preflight(f.options);
  assert.deepEqual(plan.requestIds, [1, 2]); assert.deepEqual(plan.selection, { kind: 'all_active', bound: 2 }); assertClean(f);
});

test('missing claim permission excludes otherwise safe unowned requests', async (t) => {
  const f = fixture(t); f.permissions = ['corrections.view', 'corrections.complete'];
  const plan = await service.preflight(f.options);
  assert.equal(plan.entries[0].classification, 'INVALID_OR_BLOCKED');
  assert.deepEqual(plan.entries[0].missingPermissions, ['corrections.claim']);
  assert.deepEqual(plan.entries[0].reasons, ['REQUIRED_PERMISSION_MISSING']); assertClean(f);
});

test('identity ambiguity blocks derivation and cannot be masked by valid pricing evidence', async (t) => {
  const f = fixture(t); f.sources.get(11).current_identity_count = 2;
  const plan = await service.preflight(f.options);
  assert.deepEqual(plan.entries[0].reasons, ['PRODUCT_IDENTITY_OR_DELETION_BLOCKED']);
  assert.equal(plan.entries[0].refreshedResult, null); assert.ok(!f.calls.includes('derive:1')); assertClean(f);
});

for (const [code, status, classification] of [
  ['PRODUCT_PRICE_UNCHANGED', 409, 'STALE_OR_OBSOLETE'], ['INVALID_TARGET', 422, 'INVALID_OR_BLOCKED'],
]) {
  test(`known preview refusal ${code} is isolated by savepoint and produces a bounded diagnostic`, async (t) => {
    const f = fixture(t); f.deriveError = Object.assign(new Error(`line\n${'x'.repeat(700)}`), { code, statusCode: status });
    const plan = await service.preflight(f.options), entry = plan.entries[0];
    assert.equal(entry.classification, classification); assert.deepEqual(entry.reasons, [code]);
    assert.equal(entry.validationMessage.length, 500); assert.ok(!entry.validationMessage.includes('\n'));
    assert.ok(f.queries.some(({ sql }) => sql === 'ROLLBACK TO SAVEPOINT correction_batch_preview'));
    assert.ok(f.queries.some(({ sql }) => sql === 'COMMIT')); assertClean(f);
  });
}

test('unexpected preview failure aborts the whole plan instead of producing a safe entry', async (t) => {
  const f = fixture(t); f.deriveError = Object.assign(new Error('database unavailable'), { code: '08006' });
  await assert.rejects(service.preflight(f.options), f.deriveError);
  assert.ok(f.queries.some(({ sql }) => sql === 'ROLLBACK'));
  assert.ok(!f.queries.some(({ sql }) => sql === 'COMMIT')); assertClean(f);
});

test('apply entry observes before the lane lock and claims an unowned request exactly once', async (t) => {
  const f = fixture(t), result = await f.entry();
  assert.deepEqual(f.calls.slice(0, 3), ['observe', 'connect', 'lane']);
  assert.deepEqual(f.calls.filter((call) => /^(claim|refresh|complete):/.test(call)), ['claim:1', 'complete:1']);
  assert.deepEqual(result, { status: 'completed', reason: 'COMMITTED', result: { productId: 11 }, warnings: [] }); assertClean(f);
});

test('completed receipt is replayed without claiming, refreshing, or completing again', async (t) => {
  const f = fixture(t); f.phases.set(1, [{ details: { phase: 'completed', result: { productId: 11 } } }]);
  assert.deepEqual(await f.entry(), { status: 'skipped', reason: 'ALREADY_APPLIED', result: { productId: 11 } });
  assert.ok(!f.calls.some((call) => /^(guard|claim|refresh|complete):/.test(call))); assertClean(f);
});

for (const refreshed of [false, true]) {
  test(`actor-owned entry ${refreshed ? 'resumes its refresh receipt' : 'refreshes the current claim epoch'}`, async (t) => {
    const f = fixture(t); Object.assign(f.rows.get(1), { status: 'in_progress', claimed_by_user_id: 7, claim_version: '9' });
    f.phases.set(1, [{ details: { phase: refreshed ? 'refreshed' : 'claimed' } }]);
    await f.entry();
    assert.deepEqual(f.calls.filter((call) => /^(claim|refresh|complete):/.test(call)), refreshed ? ['complete:1'] : ['refresh:1', 'complete:1']); assertClean(f);
  });
}

test('busy request lane fails without a claim and is never unlocked by the losing runner', async (t) => {
  const f = fixture(t); f.busy = true;
  await assert.rejects(f.entry(), { code: 'CORRECTION_BATCH_BUSY' });
  assert.ok(!f.calls.includes('claim:1'));
  assert.ok(!f.queries.some(({ sql }) => sql === 'SELECT pg_advisory_unlock(hashtext($1))')); assertClean(f);
});

test('abort after guarded review releases the lane before any business command', async (t) => {
  const f = fixture(t); f.abortOnGuard = new AbortController(); f.options.signal = f.abortOnGuard.signal;
  await assert.rejects(f.entry(), { code: 'CORRECTION_BATCH_INTERRUPTED' });
  assert.ok(!f.calls.includes('claim:1')); assertClean(f);
});

test('post-commit reply loss is recovered from immutable completion receipt and remains a warning', async (t) => {
  const f = fixture(t); f.completeError = new Error('reply lost after commit');
  const result = await f.entry();
  assert.equal(result.status, 'completed'); assert.deepEqual(result.warnings, [{ code: 'POST_COMMIT_FOLLOWUP_FAILED' }]);
  assert.equal(f.calls.filter((call) => call === 'complete:1').length, 1); assertClean(f);
});

for (const throws of [false, true]) {
  test(`completion without an atomic receipt ${throws ? 'preserves its failure' : 'fails closed'}`, async (t) => {
    const f = fixture(t); f.omitCompletionReceipt = true;
    if (throws) f.completeError = Object.assign(new Error('write failed'), { code: '08006' });
    await assert.rejects(f.entry(), throws ? f.completeError : { code: 'CORRECTION_BATCH_RECEIPT_MISSING' }); assertClean(f);
  });
}

for (const [label, change, code] of [
  ['actor', (f) => { f.options.actorUserId = 8; }, 'CORRECTION_BATCH_ACTOR_MISMATCH'],
  ['build', (f) => { f.options.buildId = 'other'; }, 'CORRECTION_BATCH_BUILD_MISMATCH'],
  ['database', (f) => { f.options.expectedDatabase = 'other_test'; }, 'CORRECTION_BATCH_DATABASE_MISMATCH'],
  ['connection target', (f) => { f.options.connectionTargetHash = 'other'; }, 'CORRECTION_BATCH_DATABASE_MISMATCH'],
  ['checkpoint', (f) => { delete f.options.checkpoint; }, 'CORRECTION_BATCH_RECEIPT_REQUIRED'],
]) {
  test(`apply rejects mismatched ${label} before observations or writes`, async (t) => {
    const f = fixture(t), { plan, selection } = f.sealed(); change(f);
    await assert.rejects(service.apply(plan, selection, f.options), { code });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.checkpoints, []);
  });
}

test('tampered plan fails at apply even with unchanged selected IDs', async (t) => {
  const f = fixture(t), { plan, selection } = f.sealed(); plan.entries[0].publicArticle = 'AG-999999';
  await assert.rejects(service.apply(plan, selection, f.options), { code: 'CORRECTION_BATCH_PLAN_INVALID' });
  assert.deepEqual(f.calls, []);
});

test('business conflicts retain visible claim and continue sequentially to the next request', async (t) => {
  const f = fixture(t, [1, 2]), { plan, selection } = f.sealed();
  f.guardErrors.set(1, Object.assign(new Error('stale reviewed evidence'), { statusCode: 409, code: 'CORRECTION_BATCH_DRIFT' }));
  const result = await service.apply(plan, selection, f.options);
  assert.equal(result.finished, true); assert.equal(result.stoppedReason, null);
  assert.deepEqual(result.ids, { completed: [2], skipped: [], conflicted: [1], failed: [], pending: [] });
  assert.deepEqual(result.outcomes[0].currentClaim, { status: 'pending', ownerUserId: null, claimVersion: '2' });
  assert.equal(f.checkpoints.length, 3); assert.equal(f.checkpoints[0].counts.pending, 2); assertClean(f);
});

test('receipt integrity failure stops the batch and leaves later IDs pending', async (t) => {
  const f = fixture(t, [1, 2]), { plan, selection } = f.sealed();
  f.guardErrors.set(1, Object.assign(new Error('receipt conflict'), { statusCode: 409, code: 'CORRECTION_BATCH_RECEIPT_CONFLICT' }));
  const result = await service.apply(plan, selection, f.options);
  assert.equal(result.finished, false); assert.equal(result.stoppedReason, 'CORRECTION_BATCH_RECEIPT_CONFLICT');
  assert.deepEqual(result.ids.failed, [1]); assert.deepEqual(result.ids.pending, [2]);
  assert.ok(!f.calls.includes('guard:2')); assertClean(f);
});

test('initial disk checkpoint failure prevents every observation and request operation', async (t) => {
  const f = fixture(t), { plan, selection } = f.sealed(), failure = new Error('disk full');
  f.options.checkpoint = async () => { throw failure; };
  await assert.rejects(service.apply(plan, selection, f.options), failure); assert.deepEqual(f.calls, []);
});

test('disk failure after completion escapes immediately with receipt intact and later requests untouched', async (t) => {
  const f = fixture(t, [1, 2]), { plan, selection } = f.sealed(), failure = new Error('disk full');
  let checkpoints = 0;
  f.options.checkpoint = async () => { if (++checkpoints === 2) throw failure; };
  await assert.rejects(service.apply(plan, selection, f.options), failure);
  assert.ok(f.phases.get(1).some((phase) => phase.details.phase === 'completed'));
  assert.ok(!f.calls.includes('guard:2')); assertClean(f);
});

test('aborted batch checkpoints pending work without opening a connection', async (t) => {
  const f = fixture(t), { plan, selection } = f.sealed();
  const controller = new AbortController(); controller.abort(); f.options.signal = controller.signal;
  const result = await service.apply(plan, selection, f.options);
  assert.equal(result.stoppedReason, 'CORRECTION_BATCH_INTERRUPTED'); assert.deepEqual(result.ids.pending, [1]);
  assert.equal(f.checkpoints.length, 2); assert.deepEqual(f.calls, []);
});
