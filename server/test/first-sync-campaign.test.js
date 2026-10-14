'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const runner = require('../scripts/first-sync-campaign');
const c = require('../src/services/magento/binding-contract');
const batch = require('../src/services/magento/first-sync-batch-preflight');
const audit = require('../src/services/magento/binding-evidence-audit');
const binding = '11111111-1111-4111-8111-111111111111', session = '22222222-2222-4222-8222-222222222222';
const definitionHash = 'a'.repeat(64), config = { configured: true, baseUrl: 'https://campaign-fixture.invalid' };
const clone = value => structuredClone(value), encode = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const present = value => ({ known: true, present: true, value });
function fixture(id = 1) {
  const sku = 'SYNTHETIC-CAMPAIGN-' + id;
  const product = { id, public_product_identity_id: id + 100, full_sku: sku, public_sku: sku, category: 'NM', status: 'active',
    exclude_from_export: 0, corrected_to_product_id: null, is_test_product: false, total_price_uah: '100.00', weight: '32.3',
    details: { answers: {} }, exportState: { route: 'normal', business_exclusion_state: 'none', recount_compatibility_excluded: false } };
  const item = { sku, expectedProduct: batch.source(product), remoteProductId: id + 1000,
    fields: [{ target: 'price', scope: 'all', local: '100.00', remote: '90.00' }] };
  const request = { bindingRevisionId: binding, expectedDefinitionHash: definitionHash, items: [item] };
  const command = { sku, bindingRevisionId: binding, previewToken: String(id).repeat(64).slice(0, 64),
    choices: [{ target: 'price', scope: 'all', choice: 'keep_local' }] };
  const selected = { request, item, command, commandSha256: c.hash(command) };
  const report = { mode: 'update', identity: { state: 'found', article: sku, observedMagentoId: item.remoteProductId },
    evaluation: { ready: true }, syncEligibility: { eligible: true }, sendable: true, blockers: [] };
  const base = { mode: 'first', previewToken: command.previewToken, observation: { amber: { product, compiled: { hash: definitionHash } },
    raw: { sku, id: item.remoteProductId } }, first: { progress: null },
  fields: [{ target: 'price', scope: 'all', local: present('100.00'), remote: present('90.00'), canKeepLocal: true }],
  projection: { projection: [{ target: 'price', scope: 'all', persistence: 'price' }] } };
  const prepared = { rows: [{ target: 'price', scope: 'all', received: false,
    record: { target: 'price', scope: 'all', state: 'pending_outward_confirmation', source: { decision: 'keep_local' } } }],
  blockers: [], readyForOutbound: true, complete: false };
  const result = { sku, choices: clone(command.choices), receipt: { sessionId: session, revision: String(id), alreadyApplied: false,
    fields: [{ target: 'price', scope: 'all', state: 'pending_outward_confirmation' }] }, complete: false, readyForOutbound: true };
  return { product, selected, base, report, prepared, result };
}
function runtimeFor(fixtures = [fixture()], { preparedValidation = false } = {}) {
  const state = { applied: [], callbacks: 0, preparations: 0, events: [] };
  const runtime = { c, batch, audit, pool: { databaseSecrets: () => [] }, first: {
    prepareDecision: async (_config, base) => { state.preparations++; return { prepared: fixtures.find(f => f.base === base).prepared }; },
    apply: async (_config, command, options) => {
      const f = fixtures.find(f => f.selected.command.sku === command.sku);
      state.events.push('apply:' + command.sku);
      if (state.already) return { ...f.result, receipt: { ...f.result.receipt, alreadyApplied: true } };
      await options.validateFirstSyncDecision(f.base, f.report, command.choices); state.callbacks++;
      if (state.failure) throw state.failure;
      state.applied.push(command.sku); state.afterApply?.(); return f.result;
    } } };
  if (preparedValidation) runtime.first.applyWithPreparedValidation = async (_config, command, options) => {
    const f = fixtures.find(f => f.selected.command.sku === command.sku);
    assert.equal(typeof options.validateFirstSyncDecision, 'function');
    assert.equal(typeof options.validatePreparedFirstSyncDecision, 'function');
    state.events.push('apply:' + command.sku);
    if (state.already) return { ...f.result, receipt: { ...f.result.receipt, alreadyApplied: true } };
    await options.validateFirstSyncDecision(f.base, f.report, command.choices);
    state.preparations++;
    await options.validatePreparedFirstSyncDecision(clone(f.prepared)); state.callbacks++;
    if (state.failure) throw state.failure;
    state.applied.push(command.sku); state.afterApply?.(); return f.result;
  };
  return { runtime, state, fixtures };
}
const preparedRecord = f => ({ type: 'prepared', sku: f.selected.item.sku, commandSha256: f.selected.commandSha256, command: f.selected.command });
const recorded = f => ({ type: 'receipt', sku: f.selected.item.sku, commandSha256: f.selected.commandSha256, status: 'recorded', result: f.result });
const header = { contract: 'synthetic-campaign', type: 'start' };
function storedRow(f) {
  const command = { key: { originHash: c.originHash(config.baseUrl), publicIdentityId: String(f.product.public_product_identity_id) },
    identity: { initialProductId: f.product.id, publicIdentityId: String(f.product.public_product_identity_id), publicSku: f.product.public_sku,
      remoteProductId: f.selected.item.remoteProductId, installationKey: 'fixture', initialBindingRevisionId: binding },
    fields: [{ target: 'price', scope: 'all', state: 'pending_outward_confirmation', source: { decision: 'keep_local' },
      before: present('100.00'), remote: present('90.00'), after: '100.00' }] };
  const result = { sessionId: session, revision: f.result.receipt.revision, completed: false, readyForOutbound: true,
    alreadyApplied: false, changedFields: [{ target: 'price', scope: 'all', state: 'pending_outward_confirmation' }] };
  return { preview_hash: c.hash({ previewToken: f.selected.command.previewToken, choices: f.selected.command.choices }),
    command, command_hash: c.hash(command), result, actor_user_id: 1, public_sku: f.product.public_sku, installation_key: 'fixture',
    remote_product_id: f.selected.item.remoteProductId, origin_hash: c.originHash(config.baseUrl),
    initial_product_id: f.product.id, public_product_identity_id: String(f.product.public_product_identity_id),
    audit_event_id: '100', event_key: 'magento.first_sync_progress_recorded', subject_type: 'magento_first_sync', subject_id: session,
    details: { commandHash: c.hash(command), result } };
}

test('resume verifies a matching immutable database receipt with parameterized SELECT only', async () => {
  const f = fixture(), runtime = runtimeFor([f]).runtime, calls = [];
  await runner.verifyRecorded(runtime, config, f.selected, recorded(f), { actorUserId: 1, installation: 'fixture', databasePool: {
    query: async (sql, args) => { assert.match(sql, /^SELECT /); calls.push(args); return { rows: [storedRow(f)] }; },
  } });
  assert.deepEqual(calls, [[session, '1', c.hash({ previewToken: f.selected.command.previewToken, choices: f.selected.command.choices })]]);
});
for (const [label, change] of [
  ['origin', row => { row.origin_hash = 'f'.repeat(64); }],
  ['actor', row => { row.actor_user_id = 2; }],
  ['SKU', row => { row.public_sku = 'OTHER'; }],
  ['installation', row => { row.installation_key = 'other'; }],
  ['remote identity', row => { row.remote_product_id++; }],
  ['preview hash', row => { row.preview_hash = 'f'.repeat(64); }],
  ['command hash', row => { row.command_hash = 'f'.repeat(64); }],
  ['session', row => { row.result.sessionId = binding; }],
  ['revision', row => { row.result.revision = '2'; }],
  ['completed flag', row => { row.result.completed = true; }],
  ['outbound readiness', row => { row.result.readyForOutbound = false; }],
  ['idempotency flag', row => { row.result.alreadyApplied = true; }],
  ['new import', row => { row.result.changedFields.push({ target: 'other', scope: 'all', state: 'imported' }); }],
  ['new name receipt', row => { row.result.changedFields.push({ target: 'name', scope: 'all', state: 'name_received' }); }],
  ['decision', row => { row.command.fields[0].source.decision = 'accept_remote'; }],
  ['missing selected field', row => { row.command.fields = []; }],
  ['duplicate selected field', row => { row.command.fields.push(clone(row.command.fields[0])); }],
]) test('database receipt verification rejects changed ' + label, async () => {
  const f = fixture(), runtime = runtimeFor([f]).runtime, row = storedRow(f); change(row);
  await assert.rejects(runner.verifyRecorded(runtime, config, f.selected, recorded(f), { actorUserId: 1, installation: 'fixture',
    databasePool: { query: async () => ({ rows: [row] }) } }), { code: 'CAMPAIGN_RECORDED_RECEIPT_UNCONFIRMED' });
});
test('missing historical database receipt blocks journal skip', async () => {
  const f = fixture(), runtime = runtimeFor([f]).runtime;
  await assert.rejects(runner.verifyRecorded(runtime, config, f.selected, recorded(f), { actorUserId: 1, installation: 'fixture',
    databasePool: { query: async () => ({ rows: [] }) } }), { code: 'CAMPAIGN_RECORDED_RECEIPT_UNCONFIRMED' });
});

test('fresh hook preserves canonical approved price rules and records only selected pending receipt', async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f]), events = state.events;
  const result = await runner.runItem(runtime, config, f.selected, {}, { authority: async () => events.push('authority'),
    append: async row => { assert.equal(row.type, 'prepared'); events.push('durable-prepared'); } });
  assert.equal(result.status, 'recorded'); assert.equal(state.callbacks, 1);
  assert.deepEqual(events, ['authority', 'durable-prepared', 'apply:' + f.selected.item.sku]);
});
test('new runtime prepares once and campaign validates the detached canonical plan without another preparation', async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f], { preparedValidation: true });
  runtime.first.prepareDecision = async () => assert.fail('Campaign must consume the already prepared plan');
  runtime.first.apply = async () => assert.fail('Use the supported prepared-validation capability');
  const result = await runner.runItem(runtime, config, f.selected, {}, { authority: async () => {}, append: async () => {} });
  assert.equal(result.status, 'recorded'); assert.equal(state.preparations, 1); assert.equal(state.callbacks, 1);
  assert.deepEqual(state.applied, [f.selected.item.sku]);
});
test('older runtime retains pre-prepare validation and never receives an unsupported hook', async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f]), oldApply = runtime.first.apply;
  runtime.first.apply = async (cfg, command, options) => {
    assert.equal(options.validatePreparedFirstSyncDecision, undefined);
    assert.equal(typeof options.validateFirstSyncDecision, 'function');
    return oldApply(cfg, command, options);
  };
  const result = await runner.runItem(runtime, config, f.selected, {}, { authority: async () => {}, append: async () => {} });
  assert.equal(result.status, 'recorded'); assert.equal(state.preparations, 1); assert.equal(state.callbacks, 1);
});
for (const invalid of ['missing callbacks', 'missing pre-hook', 'missing post-hook', 'already applied', 'missing preparation'])
  test('prepared runtime fails closed: ' + invalid, async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f], { preparedValidation: true });
  if (invalid === 'already applied') state.already = true;
  else runtime.first.applyWithPreparedValidation = async (_config, command, options) => {
    if (invalid === 'missing preparation' || invalid === 'missing post-hook')
      await options.validateFirstSyncDecision(f.base, f.report, command.choices);
    if (invalid === 'missing preparation') await options.validatePreparedFirstSyncDecision();
    if (invalid === 'missing pre-hook') await options.validatePreparedFirstSyncDecision(clone(f.prepared));
    return f.result;
  };
  const result = await runner.runItem(runtime, config, f.selected, {}, { authority: async () => {}, append: async () => {} });
  assert.equal(result.status, ['missing preparation', 'missing pre-hook'].includes(invalid) ? 'blocked' : 'unconfirmed');
  assert.equal(state.callbacks, 0); assert.equal(state.preparations, 0); assert.deepEqual(state.applied, []);
});
function changeSelectedField(f, { target, scope = 'all', local, remote, persistence }) {
  f.selected.item.fields = [{ target, scope, local, remote }];
  f.selected.command.choices = [{ target, scope, choice: 'keep_local' }]; f.selected.commandSha256 = c.hash(f.selected.command);
  f.base.fields = [{ target, scope, local: present(local), remote: present(remote), canKeepLocal: true }];
  f.base.projection.projection = [{ target, scope, persistence }];
  f.prepared.rows = [{ target, scope, received: false, record: { target, scope, state: 'pending_outward_confirmation', source: { decision: 'keep_local' } } }];
  f.result.choices = clone(f.selected.command.choices); f.result.receipt.fields = [{ target, scope, state: 'pending_outward_confirmation' }];
}
test('canonical physical-weight rounding choice passes but nonrounding discrepancy blocks', async () => {
  const f = fixture(); changeSelectedField(f, { target: 'decor_weight', local: '32.3', remote: '32', persistence: 'weight' });
  const { runtime } = runtimeFor([f]);
  await runner.validateDecision(runtime, config, f.selected, f.base, f.report, f.selected.command.choices, {});
  f.selected.item.fields[0].remote = f.base.fields[0].remote.value = '31';
  await assert.rejects(runner.validateDecision(runtime, config, f.selected, f.base, f.report, f.selected.command.choices, {}), { code: 'BATCH_PLAN_CHANGED' });
});
test('physical-weight target without a proven physical persistence route blocks', async () => {
  const f = fixture(); changeSelectedField(f, { target: 'decor_weight', local: '32.3', remote: '32', persistence: 'information' });
  const { runtime } = runtimeFor([f]);
  await assert.rejects(runner.validateDecision(runtime, config, f.selected, f.base, f.report, f.selected.command.choices, {}), { code: 'BATCH_PLAN_CHANGED' });
});
for (const scope of ['all', 'en']) test('Amber SEO keeps exact text in ' + scope + ' and refuses changed text', async () => {
  const f = fixture(); changeSelectedField(f, { target: 'meta_title', scope, local: 'Synthetic local title', remote: 'Synthetic remote title', persistence: 'seo' });
  const { runtime } = runtimeFor([f]);
  await runner.validateDecision(runtime, config, f.selected, f.base, f.report, f.selected.command.choices, {});
  f.base.fields[0].local.value += ' changed';
  await assert.rejects(runner.validateDecision(runtime, config, f.selected, f.base, f.report, f.selected.command.choices, {}), { code: 'BATCH_PLAN_CHANGED' });
});
test('length remains outside the campaign approved choice scope', async () => {
  const f = fixture(); changeSelectedField(f, { target: 'dovzhyna_namysta_tochna', local: '32', remote: '32.00', persistence: 'information' });
  const { runtime } = runtimeFor([f]);
  await assert.rejects(runner.validateDecision(runtime, config, f.selected, f.base, f.report, f.selected.command.choices, {}), { code: 'BATCH_PLAN_CHANGED' });
});
for (const preparedValidation of [false, true]) for (const importedState of ['imported', 'name_received'])
  test('fresh decision rejects new ' + importedState + ' before mutation, prepared hook=' + preparedValidation, async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f], { preparedValidation });
  f.prepared.rows.push({ target: 'name', scope: 'all', received: false, record: { state: importedState } });
  const result = await runner.runItem(runtime, config, f.selected, {}, { authority: async () => {}, append: async () => {} });
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'CAMPAIGN_UNAPPROVED_INITIAL_IMPORT'); assert.deepEqual(state.applied, []);
});
test('already received imported field does not authorize a new local patch', async () => {
  const f = fixture(), { runtime } = runtimeFor([f]);
  f.prepared.rows.push({ target: 'name', scope: 'all', received: true, record: { state: 'name_received' } });
  await runner.validateDecision(runtime, config, f.selected, f.base, f.report, f.selected.command.choices, {});
});
for (const preparedValidation of [false, true]) for (const [label, change] of [
  ['source price', f => { f.product.total_price_uah = '101'; }],
  ['test product', f => { f.product.is_test_product = true; }],
  ['lifecycle', f => { f.product.exportState.route = 'hold'; }],
  ['remote identity', f => { f.report.identity.observedMagentoId++; }],
  ['ordinary blocker', f => { f.report.blockers.push({ code: 'OTHER_BLOCKER' }); }],
  ['stale token', f => { f.base.previewToken = 'f'.repeat(64); }],
  ['remaining conflict', f => { f.prepared.blockers.push({ code: 'FIRST_SYNC_FIELD_CONFLICT' }); }],
  ['selected state', f => { f.prepared.rows[0].record.state = 'outward_verified'; }],
  ['duplicate selected field', f => { f.prepared.rows.push(clone(f.prepared.rows[0])); }],
]) test('fresh canonical callback blocks drift: ' + label + ', prepared hook=' + preparedValidation, async () => {
  const f = fixture(); change(f); const { runtime, state } = runtimeFor([f], { preparedValidation });
  const result = await runner.runItem(runtime, config, f.selected, {}, { authority: async () => {}, append: async () => {} });
  assert.equal(result.status, 'blocked'); assert.deepEqual(state.applied, []);
});
test('failed prepared fsync prevents canonical apply', async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f]);
  await assert.rejects(runner.runItem(runtime, config, f.selected, {}, { authority: async () => {}, append: async () => {
    throw Object.assign(Error('Synthetic fsync failed'), { journalFailure: true });
  } }), error => error.journalFailure === true);
  assert.deepEqual(state.events, []);
});
test('signal after durable prepared does not enter apply', async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f]); let stopping = false;
  const result = await runner.runItem(runtime, config, f.selected, {}, { authority: async () => {},
    append: async () => { stopping = true; }, stopping: () => stopping });
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'CAMPAIGN_INTERRUPTED'); assert.deepEqual(state.events, []);
});
test('signal during canonical preparation stops the new hook before a write', async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f], { preparedValidation: true });
  const result = await runner.runItem(runtime, config, f.selected, {}, { authority: async () => {}, append: async () => {},
    stopping: () => state.preparations > 0 });
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'CAMPAIGN_INTERRUPTED');
  assert.equal(state.preparations, 1); assert.equal(state.callbacks, 0); assert.deepEqual(state.applied, []);
});
test('canonical alreadyApplied shortcut cannot impersonate a freshly validated action', async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f]); state.already = true;
  const result = await runner.runItem(runtime, config, f.selected, {}, { authority: async () => {}, append: async () => {} });
  assert.equal(result.status, 'unconfirmed'); assert.equal(state.callbacks, 0);
});
test('unknown canonical outcome remains unconfirmed', async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f]); state.failure = Error('Synthetic lost receipt');
  const result = await runner.runItem(runtime, config, f.selected, {}, { authority: async () => {}, append: async () => {} });
  assert.equal(result.status, 'unconfirmed'); assert.deepEqual(state.applied, []);
});
for (const statusCode of [401, 403]) test('HTTP ' + statusCode + ' is a global stop regardless of error code spelling', async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f]); state.failure = Object.assign(Error('Denied'), { code: 'DENIED', statusCode });
  const result = await runner.runItem(runtime, config, f.selected, {}, { authority: async () => {}, append: async () => {} });
  assert.equal(result.status, 'blocked'); assert.equal(result.globalFailure, true);
});
test('unexpected authority failure is global and never dispatches a prepared action', async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f]);
  const result = await runner.runItem(runtime, config, f.selected, {}, { authority: async () => { throw Error('Synthetic read failure'); },
    append: async () => assert.fail('No intent after authority failure') });
  assert.equal(result.status, 'blocked'); assert.equal(result.globalFailure, true); assert.deepEqual(state.events, []);
});
test('journal requires complete ordered prepared and matching confirmed receipt', () => {
  const fixtures = [fixture(), fixture(2)], runtime = runtimeFor(fixtures).runtime;
  const rows = [header, preparedRecord(fixtures[0]), recorded(fixtures[0]), { type: 'summary', complete: false }];
  assert.deepEqual(runner.readJournal(encode(rows), header, fixtures.map(f => f.selected), runtime), [recorded(fixtures[0])]);
});
for (const [label, build] of [
  ['unresolved prepared', f => [header, preparedRecord(f)]],
  ['receipt without intent', f => [header, recorded(f)]],
  ['duplicate intent', f => [header, preparedRecord(f), preparedRecord(f)]],
  ['different command', f => [header, { ...preparedRecord(f), commandSha256: 'f'.repeat(64) }]],
  ['unconfirmed result', f => [header, preparedRecord(f), { ...recorded(f), status: 'unconfirmed' }]],
  ['global authority blocker', f => [header, { ...recorded(f), status: 'blocked', code: 'ACTOR_NOT_ACTIVE' }]],
  ['forged success identity', f => [header, preparedRecord(f), { ...recorded(f), result: { ...f.result, sku: 'OTHER' } }]],
  ['wrong revision', f => [header, preparedRecord(f), { ...recorded(f), result: { ...f.result, receipt: { ...f.result.receipt, revision: '0' } } }]],
  ['terminal field substituted', f => [header, preparedRecord(f), { ...recorded(f), result: { ...f.result, receipt: { ...f.result.receipt,
    fields: [{ target: 'price', scope: 'all', state: 'imported' }] } } }]],
]) test('resume rejects ' + label, () => {
  const f = fixture(), runtime = runtimeFor([f]).runtime;
  assert.throws(() => runner.readJournal(encode(build(f)), header, [f.selected], runtime));
});
test('journal truncation and malformed JSON are never treated as a resumable prefix', () => {
  const f = fixture(), runtime = runtimeFor([f]).runtime, bytes = encode([header, preparedRecord(f), recorded(f)]);
  assert.throws(() => runner.readJournal(bytes.subarray(0, bytes.length - 1), header, [f.selected], runtime));
  assert.throws(() => runner.readJournal(Buffer.from('{bad}\n'), header, [f.selected], runtime));
  assert.throws(() => runner.readJournal(bytes, { ...header, review: 'changed' }, [f.selected], runtime));
});
test('durableWrite handles partial writes, fsyncs, and fails on zero-length progress', async () => {
  const runtime = { audit: { assertEvidenceSafe() {} } }, events = [], bytes = [];
  const handle = { stat: async () => ({ size: 0 }), write: async (data, offset, length) => {
    const size = Math.min(length, 4); bytes.push(data.subarray(offset, offset + size)); events.push('write'); return { bytesWritten: size };
  }, sync: async () => events.push('sync') };
  await runner.durableWrite(handle, { type: 'prepared' }, runtime, {}, []);
  assert.equal(Buffer.concat(bytes).toString(), '{"type":"prepared"}\n'); assert.equal(events.at(-1), 'sync');
  handle.write = async () => ({ bytesWritten: 0 });
  await assert.rejects(runner.durableWrite(handle, {}, runtime, {}, []), error => error.journalFailure === true);
});
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-campaign-unit-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = runtimeFor([fixture(), fixture(2)]), output = path.join(dir, 'journal'), messages = [], errors = [];
  const publication = { bindingRevisionId: binding, expectedDefinitionHash: definitionHash, installationKey: 'fixture' };
  const review = { complete: true, publication }, plans = f.fixtures.map(one => ({ request: one.selected.request,
    selections: [{ sku: one.selected.item.sku, commandSha256: one.selected.commandSha256, applyInput: one.selected.command }] }));
  const pool = { query: async (sql, args) => {
    assert.match(sql, /^SELECT /);
    if (sql.includes('current_database')) return { rows: [{ name: 'campaign_test' }] };
    const one = f.fixtures.find(one => one.result.receipt.revision === args[1] && f.state.applied.includes(one.selected.item.sku));
    return { rows: one ? [storedRow(one)] : [] };
  } };
  const deps = { runtime: f.runtime, config, pool, env: {}, loadReview: async () => ({ review, plans }),
    implementationHash: async () => 'c'.repeat(64),
    readAuthority: async () => publication, print: value => messages.push(JSON.parse(value)), printError: value => errors.push(JSON.parse(value)) };
  const args = mode => ['--mode', mode, '--review', path.join(dir, 'review'), '--review-sha256', 'b'.repeat(64), '--output', output,
    '--expected-database', 'campaign_test', '--actor-id', '1', '--installation-key', 'fixture'];
  return { ...f, dir, output, deps, args, messages, errors };
}
test('interrupted campaign resumes at the untouched item and never repeats the confirmed action', async t => {
  const f = await setup(t); f.state.afterApply = () => process.emit('SIGINT');
  assert.equal(await runner.main(f.args('apply'), f.deps), 2); assert.equal(f.state.applied.length, 1);
  delete f.state.afterApply;
  assert.equal(await runner.main(f.args('resume'), f.deps), 0); assert.equal(f.state.applied.length, 2);
  assert.equal(new Set(f.state.applied).size, 2); assert.equal(f.messages.at(-1).allRecorded, true);
});
test('unknown result stops the tail and resume refuses a retry', async t => {
  const f = await setup(t); f.state.failure = Error('Synthetic lost receipt');
  assert.equal(await runner.main(f.args('apply'), f.deps), 2); assert.equal(f.state.events.length, 1);
  delete f.state.failure;
  assert.equal(await runner.main(f.args('resume'), f.deps), 1); assert.equal(f.state.events.length, 1);
  assert.equal(f.errors.at(-1).code, 'CAMPAIGN_JOURNAL_UNCONFIRMED');
});
test('resume rejects changed implementation hash before another action', async t => {
  const f = await setup(t); f.state.afterApply = () => process.emit('SIGINT');
  assert.equal(await runner.main(f.args('apply'), f.deps), 2); delete f.state.afterApply;
  f.deps.implementationHash = async () => 'd'.repeat(64);
  assert.equal(await runner.main(f.args('resume'), f.deps), 1); assert.equal(f.state.applied.length, 1);
  assert.equal(f.errors.at(-1).code, 'CAMPAIGN_JOURNAL_SCOPE_CHANGED');
});
test('resume refuses a missing persisted receipt before dispatching the untouched tail', async t => {
  const f = await setup(t); f.state.afterApply = () => process.emit('SIGINT');
  assert.equal(await runner.main(f.args('apply'), f.deps), 2); delete f.state.afterApply;
  f.deps.pool.query = async sql => ({ rows: sql.includes('current_database') ? [{ name: 'campaign_test' }] : [] });
  assert.equal(await runner.main(f.args('resume'), f.deps), 1); assert.equal(f.state.applied.length, 1);
  assert.equal(f.errors.at(-1).code, 'CAMPAIGN_RECORDED_RECEIPT_UNCONFIRMED');
});
test('exclusive run lock blocks another process and is never stolen or removed', async t => {
  const f = await setup(t); await fs.mkdir(f.output);
  const lock = path.join(f.output, 'run.lock'); await fs.writeFile(lock, 'synthetic other owner');
  assert.equal(await runner.main(f.args('resume'), f.deps), 1);
  assert.equal(await fs.readFile(lock, 'utf8'), 'synthetic other owner'); assert.equal(f.state.events.length, 0);
});
test('changed current publication stops before any canonical apply', async t => {
  const f = await setup(t); f.deps.readAuthority = async () => ({ bindingRevisionId: session });
  assert.equal(await runner.main(f.args('apply'), f.deps), 1); assert.deepEqual(f.state.events, []);
  assert.equal(f.errors.at(-1).code, 'CAMPAIGN_PUBLICATION_CHANGED');
});
