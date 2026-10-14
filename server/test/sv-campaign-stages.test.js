'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const stages = require('../scripts/sv-campaign-stages');
const c = require('../src/services/magento/binding-contract');
const batch = require('../src/services/magento/first-sync-batch-preflight');
const first = require('../src/services/magento/first-sync.service');
const names = require('../scripts/first-sync-campaign-names');
const campaign = require('../scripts/first-sync-campaign');
const binding = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
const config = { configured: true, baseUrl: 'https://sv-stage-fixture.invalid' };
const scope = { bindingRevisionId: binding, expectedDefinitionHash: 'a'.repeat(64), installationKey: 'fixture' };
const item = { sku: 'AG-SYNTHETIC-SV-1', productId: 1, remoteProductId: 101, category: 'SV' };
const clone = value => structuredClone(value);
const present = value => ({ known: true, present: true, value });
function fixture(initial = 'fields') {
  const state = { phase: initial, events: [], checkpoints: [], verified: [], protected: false, singleton: true,
    preparations: 0, writes: 0, sourceMutation: false };
  const product = { id: item.productId, public_product_identity_id: 201, public_sku: item.sku, full_sku: item.sku,
    category: 'SV', status: 'active', corrected_to_product_id: null, corrected_from_product_id: null,
    is_test_product: false, exclude_from_export: 0, weight: '12.3', total_price_uah: '100', details: { answers: { weight: '12.3', souvenir: 5 } },
    exportState: { route: 'normal', business_exclusion_state: 'none', recount_compatibility_excluded: false } };
  const observation = { amber: { product, revision: { id: binding, state: 'published', installationKey: 'fixture',
    definitionHash: scope.expectedDefinitionHash, originHash: c.originHash(config.baseUrl) }, compiled: { hash: scope.expectedDefinitionHash } },
  raw: { id: item.remoteProductId, sku: item.sku }, domainEvidence: { failures: [] } };
  const report = { mode: 'update', identity: { state: 'found', article: item.sku, observedMagentoId: item.remoteProductId },
    blockers: [], evaluation: { ready: true }, syncEligibility: { eligible: true }, sendable: true };
  const field = (target, status, after, remote = after) => ({ target, scope: 'all', status, received: false,
    local: present(after), remote: present(remote), canKeepLocal: status === 'conflict',
    record: { target, scope: 'all', state: status, before: present(after), remote: present(remote), after,
      mappingHash: 'b'.repeat(64), source: { kind: 'product', field: target, productId: 1,
        bindingRevisionId: binding, definitionHash: scope.expectedDefinitionHash, routeKey: 'SV' } } });
  const price = field('price', 'conflict', '100', '90');
  const equal = field('price', 'equal', '100');
  const name = field('name', 'imported', 'Magento name'); name.record.state = 'name_received';
  const pending = clone(price); pending.status = 'pending_outward_confirmation';
  pending.record.state = 'pending_outward_confirmation'; pending.record.source.decision = 'keep_local';
  const preparedFor = rows => ({ rows: clone(rows), manifest: rows.map(({ target, scope: fieldScope }) => ({ target, scope: fieldScope })),
    manifestHash: 'c'.repeat(64), blockers: [], complete: rows.every(row => ['equal', 'name_received'].includes(row.record.state)), readyForOutbound: true });
  const baseFor = () => {
    const phase = state.phase;
    const rows = phase === 'names' ? [name, price] : phase === 'equal' ? [equal] : phase === 'pending' ? [pending] : [price];
    const base = { mode: phase === 'ordinary' ? 'ordinary' : phase === 'history' ? 'review' : 'first',
      observation, previewToken: 'd'.repeat(64), currencyEvidence: { verified: true, currency: 'UAH' },
      fields: clone(rows), projection: { fields: clone(rows), plan: { fields: clone(rows) },
        projection: rows.map(row => ({ target: row.target, scope: row.scope, persistence: row.target })) },
      prepared: preparedFor(rows), blockers: [], readyForOutbound: true,
      first: { mode: phase === 'ordinary' ? 'ordinary' : phase === 'history' ? 'review' : 'first', key: { originHash: c.originHash(config.baseUrl), publicIdentityId: '201' },
        evidenceHash: 'e'.repeat(64), admissionGuards: { protectedWork: state.protected, otherOrigin: false }, progress: null } };
    if (phase === 'pending') base.first.progress = { session: { id: session, revision: '1', completed_at: null,
      initial_product_id: 1, initial_binding_revision_id: binding }, fields: [clone(pending.record)] };
    if (phase === 'history') {
      base.blockers = [{ code: 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED' }];
      base.historyReviewAssessment = { status: 'available', legacySnapshotFlag: true, code: 'FIRST_SYNC_LEGACY_SNAPSHOT_FLAG_REVIEW_AVAILABLE' };
      base.historyReview = { scope: 'first_sync_review_only', doesNotAcknowledgeExport: true, legacySnapshotFlag: true,
        sku: item.sku, remoteProductId: 101, previewToken: 'f'.repeat(64) };
    }
    return base;
  };
  const resultFor = proof => ({ sessionId: session, revision: proof.expectedRevision, completed: proof.complete, complete: proof.complete,
    alreadyApplied: false, readyForOutbound: proof.readyForOutbound, localChanged: state.phase === 'names',
    changedFields: clone(proof.changedFields), terminalScopes: clone(proof.terminalScopes) });
  const client = { query: async sql => { state.events.push(sql); return { rows: [], command: sql }; }, release() {} };
  const run = { databasePool: { connect: async () => client, query: async () => ({ rows: [] }) }, actorUserId: 1,
    installation: 'fixture', sensitiveValues: [], fetchImpl: async () => { throw Error('No network allowed in fixture'); } };
  const runtime = { c, batch: { ...batch, validatePacketDecision: (_base, _report, _request, _item, choices) => {
    assert.equal(choices[0].target, 'price'); state.events.push('packet'); } },
  admission: { rootId: () => null },
  history: { read: async () => ({ complete: true, hasRecount: !state.singleton, identityChanged: false,
    issues: [], corrections: [], products: [{ productId: 1 }] }) },
  preview: async (_config, options) => { state.events.push('preview:' + state.phase); await options.onObservation(observation); return report; },
  readSnapshot: async () => ({ product: state.sourceMutation ? { ...product, total_price_uah: '101' } : product }),
  price: { readCurrencyEvidence: async () => ({ verified: true, currency: 'UAH' }) },
  policy: { assertObservation: (_config, data) => { state.events.push('policy:' + data.stage); assert.equal(data.currencyEvidence.verified, true); },
    selectChoices: () => state.phase === 'fields' ? [{ target: 'price', scope: 'all', choice: 'keep_local' }] : [],
    assertPrepared: (prepared, options) => {
      state.events.push('prepared-policy:' + options.stage);
      if (options.stage === 'equal') assert.ok(prepared.rows.every(row => row.record.state === 'equal' || row.received));
      if (state.policyFailure) throw Object.assign(Error('policy'), { code: 'SV_CAMPAIGN_DISALLOWED_FIELD', statusCode: 409 });
    } },
  first: { decisions: first.decisions,
    inspect: async () => { state.events.push('inspect:' + state.phase); return baseFor(); },
    prepareDecision: async () => { state.preparations++; return { prepared: preparedFor([pending]) }; },
    applyWithPreparedValidation: async (_config, command, options) => {
      state.events.push('canonical-apply');
      await options.validateFirstSyncDecision(baseFor(), report, command.choices);
      await options.validatePreparedFirstSyncDecision(preparedFor([pending]));
      if (state.applyFailure) throw state.applyFailure;
      state.writes++; state.phase = 'pending';
      return { sku: item.sku, choices: command.choices, receipt: { sessionId: session, revision: '1', alreadyApplied: false,
        fields: [{ target: 'price', scope: 'all', state: 'pending_outward_confirmation' }] }, readyForOutbound: true, complete: false };
    } },
  boundary: { guard: async (_config, _input, _options, callback) => { state.events.push('guard'); return callback({ productId: 1 }); },
    observe: async (_config, _input, options) => { let observed;
      const value = await (options.preview || runtime.preview)(config, { ...options, onObservation: data => { observed = data; } });
      return { observation: observed, report: value }; } },
  campaign: { expectedReceipt: campaign.expectedReceipt, verifyRecorded: async () => { state.verified.push('fields'); if (state.verifyFailure) throw Error('receipt missing'); } },
  names: { commitProof: names.commitProof, expectedReceipt: names.expectedReceipt,
    verifyRecorded: async (_runtime, _config, selected) => { state.verified.push(selected.preview.initialImports.length ? 'names' : 'equal'); } },
  nameCommit: async (_runtime, _config, _state, base) => {
    state.events.push('canonical-commit'); state.writes++;
    const result = resultFor(names.commitProof(runtime, base, run));
    if (state.commitFailure) throw state.commitFailure;
    state.phase = state.phase === 'names' ? 'fields' : 'ordinary'; if (state.workerAfterNames) state.protected = true;
    return result;
  },
  historyBatch: { runItem: async (_runtime, _config, _item, _scope, _run, options) => {
    assert.deepEqual(Object.keys(_item).sort(), ['productId', 'remoteProductId', 'sku']);
    await options.append({ type: 'prepared', command: { sku: item.sku, bindingRevisionId: binding, previewToken: 'f'.repeat(64) } });
    state.events.push('history-apply'); state.writes++; state.phase = 'names';
    return { ..._item, status: 'recorded', receipt: { auditEventId: '1', alreadyApplied: false } };
  } },
  historyCampaign: { verifyHistoricalReceipt: async (_runtime, _config, _scope, saved) => {
    assert.equal(saved.preparedCommand.previewToken, 'f'.repeat(64)); state.verified.push('history'); } },
  initialNames: {
    previewItem: async (current, _config, _scope, _item, options) => {
      let observed; const value = await current.preview(config, { ...options, onObservation: data => { observed = data; } });
      const base = await current.first.inspect(config, observed, options);
      assert.equal(value, report);
      return { status: 'available', selection: { item: { sku: item.sku, remoteProductId: 101, expectedProduct: batch.source(product) },
        request: { bindingRevisionId: binding, expectedDefinitionHash: scope.expectedDefinitionHash },
        preview: { initialImports: [{ target: 'name', scope: 'all' }] }, report: { applyInput: { previewToken: base.previewToken } } } };
    },
    runItem: async (current, _config, _scope, selected, options, hooks) => {
      let observed; await current.preview(config, { ...options, onObservation: data => { observed = data; } });
      const base = await current.first.inspect(config, observed, options), proof = names.commitProof(runtime, base, run);
      await hooks.append({ type: 'prepared', proof });
      const result = await hooks.commit(runtime, config, {}, base, options);
      return { status: 'recorded', sku: item.sku, proof, result };
    },
  } };
  const hooks = { authority: async () => { state.events.push('authority'); },
    checkpoint: async saved => { state.events.push('checkpoint:' + saved.type + ':' + saved.stage); state.checkpoints.push(clone(saved)); } };
  return { runtime, state, run, hooks, product, observation, report, baseFor };
}

test('GET-only boundary rejects Request methods and any request body', async () => {
  const calls = [], fetch = stages.getOnly(async (...args) => { calls.push(args); });
  await fetch('https://fixture.invalid', { method: 'GET' });
  assert.throws(() => fetch({ method: 'POST' }), /SV_CAMPAIGN_REMOTE_WRITE_DENIED/);
  assert.throws(() => fetch({ method: 'GET', body: {} }), /SV_CAMPAIGN_REMOTE_WRITE_DENIED/);
  assert.throws(() => fetch('https://fixture.invalid', { body: '' }), /SV_CAMPAIGN_REMOTE_WRITE_DENIED/);
  assert.equal(calls.length, 1);
});
test('inspection accepts category SV with AG public identity and keeps owned observation', async () => {
  const f = fixture(); const evidence = await stages.inspect(f.runtime, config, item, scope, f.run);
  assert.equal(evidence.observation, f.observation); assert.equal(evidence.base.observation, f.observation);
  assert.equal(evidence.sourceHash, c.hash(batch.source(f.product))); assert.equal(f.state.writes, 0);
  assert.ok(f.state.events.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
});
test('pinned full publication hash detects changed bindings despite unchanged revision and definition IDs', async () => {
  const f = fixture();
  const pinned = { ...scope, publicationHash: c.hash(f.observation.amber.revision) };
  await stages.inspect(f.runtime, config, item, pinned, f.run);
  f.observation.amber.revision.bindings = { attributes: [] };
  await assert.rejects(stages.advance(f.runtime, config, item, pinned, f.run, f.hooks), { code: 'SV_CAMPAIGN_PUBLICATION_CHANGED' });
  assert.equal(f.state.writes, 0); assert.equal(f.state.checkpoints.length, 0);
});
test('inspection rejects remote/publication/lifecycle/singleton/protected/source changes', async t => {
  for (const [label, change, code] of [
    ['remote', f => { f.observation.raw.id++; }, 'EXACT_IDENTITY_REQUIRED'],
    ['publication', f => { f.observation.amber.revision.definitionHash = 'b'.repeat(64); }, 'PUBLICATION_CHANGED'],
    ['hold', f => { f.product.exportState.route = 'hold'; }, 'NORMAL_SINGLETON_REQUIRED'],
    ['lineage', f => { f.state.singleton = false; }, 'NORMAL_SINGLETON_REQUIRED'],
    ['protected', f => { f.state.protected = true; }, 'PROTECTED_WORK'],
    ['source', f => { f.state.sourceMutation = true; }, 'SOURCE_CHANGED_DURING_READ'],
  ]) await t.test(label, async () => {
    const f = fixture(); change(f);
    await assert.rejects(stages.inspect(f.runtime, config, item, scope, f.run), { code: 'SV_CAMPAIGN_' + code });
    assert.equal(f.state.writes, 0);
  });
});
test('price stage journals intent before apply, validates actual prepared plan and verifies receipt before fresh readiness', async () => {
  const f = fixture(); const result = await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
  assert.equal(result.status, 'ready'); assert.equal(f.state.writes, 1); assert.deepEqual(f.state.verified, ['fields']);
  assert.equal(f.state.checkpoints.length, 2);
  assert.ok(f.state.events.indexOf('checkpoint:prepared:fields') < f.state.events.indexOf('canonical-apply'));
  assert.ok(f.state.events.indexOf('checkpoint:receipt:fields') < f.state.events.lastIndexOf('preview:pending'));
  assert.deepEqual(f.state.checkpoints[0].selection.command.choices, [{ target: 'price', scope: 'all', choice: 'keep_local' }]);
});
test('equal-only path commits complete unchanged inspection without empty apply choices', async () => {
  const f = fixture('equal');
  f.runtime.first.applyWithPreparedValidation = async () => assert.fail('empty choices must not call apply');
  const result = await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
  assert.equal(result.status, 'ready'); assert.equal(f.state.writes, 1); assert.deepEqual(f.state.verified, ['equal']);
  const saved = f.state.checkpoints.at(-1);
  assert.deepEqual(saved.selection.preview.initialImports, []); assert.equal(saved.receipt.result.completed, true);
  assert.ok(f.state.events.indexOf('checkpoint:prepared:equal') < f.state.events.indexOf('canonical-commit'));
});
test('history, Magento names and fields advance sequentially with fresh evidence and no outer nested SKU guard', async () => {
  const f = fixture('history');
  const result = await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
  assert.equal(result.status, 'ready'); assert.equal(f.state.writes, 3);
  assert.deepEqual(f.state.verified, ['history', 'names', 'fields']);
  assert.deepEqual(f.state.checkpoints.filter(row => row.type === 'receipt').map(row => row.stage), ['history', 'names', 'fields']);
  assert.ok(!f.state.events.includes('guard'));
});
test('names stage opts into pristine first-sync at both canonical selection boundaries', async () => {
  const f = fixture('names'), helper = f.runtime.initialNames, calls = [];
  const preview = helper.previewItem, apply = helper.runItem;
  helper.previewItem = async (...args) => {
    assert.deepEqual(args[7], { allowPristineFirst: true }); calls.push('preview');
    return preview(...args);
  };
  helper.runItem = async (...args) => {
    assert.equal(args[5].allowPristineFirst, true); calls.push('apply');
    return apply(...args);
  };
  const result = await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
  assert.equal(result.status, 'ready'); assert.deepEqual(calls, ['preview', 'apply']);
  assert.deepEqual(f.state.verified, ['names', 'fields']);
  assert.ok(!f.state.events.includes('history-apply'));
});
test('unsupported history proposal is quarantined without history writes', async () => {
  const f = fixture('history'), inspect = f.runtime.first.inspect;
  f.runtime.first.inspect = async (...args) => { const base = await inspect(...args); base.historyReviewAssessment.legacySnapshotFlag = false; return base; };
  const result = await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
  assert.equal(result.status, 'review'); assert.equal(f.state.writes, 0); assert.equal(f.state.checkpoints.length, 0);
});
test('names-triggered protected worker work remains untouched and stops later stages', async () => {
  const f = fixture('names'); f.state.workerAfterNames = true;
  const result = await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
  assert.deepEqual(result, { status: 'review', reason: 'SV_CAMPAIGN_PROTECTED_WORK' });
  assert.equal(f.state.writes, 1); assert.deepEqual(f.state.verified, ['names']);
});
test('already confirmed stage never repeats when fresh state still requests it', async () => {
  const f = fixture(); f.hooks.completedStages = new Set(['fields']);
  const result = await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
  assert.equal(result.status, 'review'); assert.equal(result.reason, 'SV_CAMPAIGN_STAGE_ALREADY_RECORDED');
  assert.equal(f.state.writes, 0); assert.equal(f.state.checkpoints.length, 0);
});
test('full-plan policy failure stops before any write or durable mutation intent', async () => {
  const f = fixture(); f.state.policyFailure = true;
  const result = await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
  assert.equal(result.status, 'review'); assert.equal(f.state.writes, 0); assert.equal(f.state.checkpoints.length, 0);
});
test('missing prepared validator quarantines rather than falling back to unvalidated apply', async () => {
  const f = fixture(); delete f.runtime.first.applyWithPreparedValidation;
  const result = await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
  assert.equal(result.reason, 'SV_CAMPAIGN_PREPARED_VALIDATOR_REQUIRED'); assert.equal(f.state.writes, 0);
});
test('failed durable intent prevents write; failed post-commit receipt is uncertain and never retried', async t => {
  await t.test('prepared', async () => {
    const f = fixture(); f.hooks.checkpoint = async () => { throw Error('fsync failed'); };
    await assert.rejects(stages.advance(f.runtime, config, item, scope, f.run, f.hooks), { journalFailure: true });
    assert.equal(f.state.writes, 0);
  });
  await t.test('receipt', async () => {
    const f = fixture(); f.hooks.checkpoint = async row => { if (row.type === 'receipt') throw Error('fsync failed'); };
    await assert.rejects(stages.advance(f.runtime, config, item, scope, f.run, f.hooks), { uncertain: true });
    assert.equal(f.state.writes, 1);
  });
});
test('canonical apply or receipt-verification ambiguity throws uncertain', async t => {
  for (const failure of ['applyFailure', 'verifyFailure']) await t.test(failure, async () => {
    const f = fixture(); f.state[failure] = Error('synthetic failure');
    await assert.rejects(stages.advance(f.runtime, config, item, scope, f.run, f.hooks), { uncertain: true });
    assert.equal(f.state.checkpoints.filter(row => row.type === 'receipt').length, 0);
  });
});
test('resume verification checks exact saved scope before canonical immutable verifier', async () => {
  const f = fixture(); await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
  const saved = clone(f.state.checkpoints.at(-1));
  await stages.verifyReceipt(f.runtime, config, item, scope, saved, f.run);
  saved.selection.request.expectedDefinitionHash = 'f'.repeat(64);
  await assert.rejects(stages.verifyReceipt(f.runtime, config, item, scope, saved, f.run), { code: 'SV_CAMPAIGN_RECEIPT_SCOPE_CHANGED' });
});
test('resume verification binds helper receipts to their prepared proof and exact product', async t => {
  await t.test('history identity', async () => {
    const f = fixture('history'); await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
    const saved = clone(f.state.checkpoints.find(row => row.type === 'receipt' && row.stage === 'history'));
    saved.receipt.productId = 2;
    await assert.rejects(stages.verifyReceipt(f.runtime, config, item, scope, saved, f.run), { code: 'SV_CAMPAIGN_RECEIPT_SCOPE_CHANGED' });
  });
  await t.test('zero-choice proof', async () => {
    const f = fixture('equal'); await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
    const saved = clone(f.state.checkpoints.at(-1)); saved.prepared.proof = { ...saved.prepared.proof, commandHash: '0'.repeat(64) };
    await assert.rejects(stages.verifyReceipt(f.runtime, config, item, scope, saved, f.run), { code: 'SV_CAMPAIGN_RECEIPT_SCOPE_CHANGED' });
  });
});
test('interruption is checked before reading or mutating', async () => {
  const f = fixture(); f.hooks.stopping = () => true;
  await assert.rejects(stages.advance(f.runtime, config, item, scope, f.run, f.hooks), { code: 'SV_CAMPAIGN_INTERRUPTED' });
  assert.equal(f.state.events.length, 0); assert.equal(f.state.writes, 0);
});
test('global authority changes stop the campaign instead of becoming a per-SKU review', async t => {
  for (const error of [
    { code: 'SYNTHETIC_AUTH', statusCode: 403 }, { code: 'SV_CAMPAIGN_PUBLICATION_CHANGED', statusCode: 409 },
    { code: 'ACTOR_NOT_ACTIVE', statusCode: 409 }, { code: 'EXPORT_CUTOVER_PREPARING', statusCode: 409 },
  ]) await t.test(error.code, async () => {
    const f = fixture(); f.hooks.authority = async () => { throw Object.assign(Error(error.code), error); };
    await assert.rejects(stages.advance(f.runtime, config, item, scope, f.run, f.hooks), { code: error.code });
    assert.equal(f.state.writes, 0);
  });
});
test('a global failure returned by an existing stage helper stops the campaign after resolving its blocked receipt', async () => {
  const f = fixture('history');
  f.runtime.historyBatch.runItem = async (_runtime, _config, _item, _scope, _run, options) => {
    await options.append({ command: { sku: item.sku, bindingRevisionId: binding, previewToken: 'f'.repeat(64) } });
    return { status: 'blocked', code: 'ACTOR_NOT_ACTIVE' };
  };
  await assert.rejects(stages.advance(f.runtime, config, item, scope, f.run, f.hooks), { code: 'ACTOR_NOT_ACTIVE' });
  assert.equal(f.state.writes, 0); assert.equal(f.state.checkpoints.at(-1).receipt.status, 'blocked');
});
test('runtime loads standalone policy and existing canonical services without starting the application', () => {
  const runtime = stages.createRuntime(path.resolve(__dirname, '..'));
  assert.equal(runtime.first, first);
  assert.equal(runtime.names, names);
  assert.equal(runtime.policy.POLICY, 'sv-manager-v1');
  assert.equal(typeof runtime.boundary.guard, 'function');
  assert.equal(typeof runtime.historyBatch.runItem, 'function');
  assert.equal(typeof runtime.price.readCurrencyEvidence, 'function');
  assert.equal(typeof runtime.readSnapshot, 'function');
});
test('real prepared policy composes with names then Manager price without rejecting unresolved unchanged price evidence', async () => {
  const f = fixture('names'), policy = require('../scripts/sv-campaign-policy').createPolicy(path.resolve(__dirname, '..'));
  f.runtime.policy.selectChoices = policy.selectChoices;
  f.runtime.policy.assertPrepared = policy.assertPrepared;
  const result = await stages.advance(f.runtime, config, item, scope, f.run, f.hooks);
  assert.equal(result.status, 'ready', result.reason);
  assert.deepEqual(f.state.verified, ['names', 'fields']); assert.equal(f.state.writes, 2);
});
