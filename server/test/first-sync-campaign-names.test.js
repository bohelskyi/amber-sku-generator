'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const runner = require('../scripts/first-sync-campaign-names');
const c = require('../src/services/magento/binding-contract');
const batch = require('../src/services/magento/first-sync-batch-preflight');
const audit = require('../src/services/magento/binding-evidence-audit');
const first = require('../src/services/magento/first-sync.service');
const { planFirstSyncFields } = require('../src/services/magento/first-sync-field-plan');
const { prepareProgress } = require('../src/services/magento/first-sync-progress-plan');
const binding = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
const identity = '101';
const definitionHash = 'a'.repeat(64), config = { configured: true, baseUrl: 'https://names-fixture.invalid' };
const run = { actorUserId: 1, installation: 'fixture' };
const clone = value => structuredClone(value);
const present = value => ({ known: true, present: true, value });
const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
const key = field => field.scope + '/' + field.target;
const cliArgs = (mode = 'preview') => ['--mode', mode, '--review', '/synthetic/review', '--review-sha256', 'b'.repeat(64),
  '--output', '/synthetic/output', '--expected-database', 'names_test', '--actor-id', '1', '--installation-key', 'fixture'];
function fixture(id = 1, scopes = ['all', 'en']) {
  const sku = 'SYNTHETIC-NAMES-' + id;
  const product = { id, public_product_identity_id: identity, full_sku: sku, public_sku: sku, category: 'NM', status: 'active',
    exclude_from_export: 0, corrected_to_product_id: null, is_test_product: false, total_price_uah: '100.00', weight: '32.3',
    details: { answers: {} }, exportState: { route: 'normal', business_exclusion_state: 'none', recount_compatibility_excluded: false } };
  const item = { sku, expectedProduct: clone(batch.source(product)), remoteProductId: 1000 + id,
    fields: [{ target: 'price', scope: 'all', local: '100.00', remote: '90.00' }] };
  const request = { bindingRevisionId: binding, expectedDefinitionHash: definitionHash, items: [item] };
  const fields = [
    ...scopes.map(scope => ({ target: 'name', scope, kind: 'name', type: 'text', required: true,
      mapping: { proven: true }, local: present('Manager ' + scope), remote: present('Remote ' + scope) })),
    { target: 'price', scope: 'all', kind: 'scalar', type: 'decimal', scale: 2, required: true,
      mapping: { proven: true }, local: present('100.00'), remote: present('90.00') },
  ];
  const projection = { fields, blockers: [], plan: planFirstSyncFields({ fields }), projection: fields.map(field => ({
    target: field.target, scope: field.scope, persistence: field.target === 'name' ? 'name' : 'price',
    outwardPolicy: 'authoritative_create_update', mappingHash: c.hash(key(field)),
    source: { kind: 'product', field: field.target, productId: id, bindingRevisionId: binding,
      definitionHash, routeKey: 'NM' },
  })) };
  const prepared = prepareProgress(projection, null);
  const observation = { amber: { product, compiled: { hash: definitionHash }, revision: { id: binding, installationKey: 'fixture' } },
    raw: { sku, id: item.remoteProductId }, domainEvidence: { english: { sku, id: item.remoteProductId,
      fields: { name: 'Remote en' } }, failures: [] } };
  const base = { mode: 'first', previewToken: c.hash({ sku }), observation, projection, prepared,
    first: { mode: 'first', blockers: [], progress: null, key: { originHash: c.originHash(config.baseUrl), publicIdentityId: identity },
      evidenceHash: 'e'.repeat(64) }, fields: prepared.rows.map(row => ({ ...row })),
    blockers: prepared.blockers, readyForOutbound: prepared.readyForOutbound, complete: prepared.complete };
  const choices = [{ target: 'price', scope: 'all', choice: 'keep_local' }];
  const initialImports = prepared.rows.filter(row => row.record.state === 'name_received')
    .map(row => ({ target: row.target, scope: row.scope, before: clone(row.local), after: row.record.after }));
  const report = { sku, mode: 'first', status: 'first_sync_choices', readyForApply: true, readyForOutboundAfterChoices: true,
    blockers: [], remainingBlockers: [], initialImports,
    applyInput: { sku, bindingRevisionId: binding, previewToken: base.previewToken, choices } };
  const preview = { sku, productId: id, remoteProductId: item.remoteProductId, planFile: 'plan-0001.json', initialImports: clone(initialImports) };
  const selected = { preview, request, item, report, scopeHash: c.hash({ preview, request, item, report }) };
  const ordinary = { mode: 'update', identity: { state: 'found', article: sku, observedMagentoId: item.remoteProductId },
    evaluation: { ready: true }, syncEligibility: { eligible: true }, sendable: true, blockers: [] };
  return { product, item, request, projection, observation, base, report, selected, ordinary };
}
function runtimeFor(fixtures = [fixture()]) {
  const state = { events: [], commits: [], inspections: [], decisions: [] };
  const runtime = { c, batch, audit, pool: { databaseSecrets: () => [] }, boundary: {
    guard: async (_config, input, _run, fn) => {
      state.events.push('guard:' + input.sku);
      const f = fixtures.find(row => row.item.sku === input.sku);
      return fn({ publicSku: f.item.sku, publicIdentityId: identity, revision: f.observation.amber.revision });
    },
    observe: async (_config, input) => {
      state.events.push('observe:' + input.sku);
      const f = fixtures.find(row => row.item.sku === input.sku);
      return { observation: f.observation, report: f.ordinary };
    },
  }, first: {
    decisions: first.decisions,
    inspect: async (_config, observation, _run, options) => {
      assert.equal(options?.decision, undefined, 'Fresh inspection cannot apply the historical local choices');
      state.events.push('inspect:' + observation.raw.sku); state.inspections.push(observation);
      return fixtures.find(f => f.observation === observation).base;
    },
    prepareDecision: async (_config, base, choices) => {
      state.events.push('dry-run:' + base.observation.raw.sku); state.decisions.push(clone(choices));
      const prepared = prepareProgress(base.projection, base.first.progress, choices);
      state.changeDryRun?.(prepared); return { ...base, prepared };
    },
    apply: async () => assert.fail('The names adapter cannot use the choices apply endpoint'),
    commit: async () => assert.fail('The names adapter must delegate to runNameCommit'),
  } };
  return { runtime, state, fixtures };
}
function loadedFor(fixtures) {
  const publication = { bindingRevisionId: binding, expectedDefinitionHash: definitionHash, installationKey: 'fixture' };
  const plans = fixtures.map((f, index) => {
    f.selected.preview.planFile = 'plan-' + String(index + 1).padStart(4, '0') + '.json';
    f.selected.scopeHash = c.hash({ preview: f.selected.preview, request: f.request, item: f.item, report: f.report });
    return { publication, request: f.request, report: { contract: 'first-sync-local-authority-batch-v1', readOnly: true,
      bindingRevisionId: binding, results: [f.report], counts: { total: 1, readyForApply: 1, blocked: 0,
        notChecked: 0, noChange: 0, ordinaryPreviewRequired: 0 } }, selections: [],
      exceptions: [{ sku: f.item.sku, code: 'CAMPAIGN_NAME_IMPORTS_SEPARATE_PREVIEW' }] };
  });
  const review = { complete: true, readOnly: true, globalFailure: null, publication, actorUserId: 1, database: 'names_test', installationKey: 'fixture',
    nameOnlyPreview: fixtures.map(f => f.selected.preview), plans: plans.map((plan, index) => ({ file: fixtures[index].selected.preview.planFile,
      sha256: c.hash(plan) })) };
  return { review, plans };
}
function withPriorPriceReceipt(f) {
  const record = prepareProgress(f.projection, null, f.report.applyInput.choices).rows.find(row => row.target === 'price').record;
  f.base.first.progress = { session: { id: session, revision: '4', initial_product_id: f.product.id,
    initial_binding_revision_id: binding }, fields: [{ ...clone(record), revision: '4', recordedAt: '2026-10-13T00:00:00Z' }] };
  f.base.prepared = prepareProgress(f.projection, f.base.first.progress);
  f.base.fields = f.base.prepared.rows.map(row => ({ ...row }));
  f.base.blockers = f.base.prepared.blockers; f.base.readyForOutbound = f.base.prepared.readyForOutbound;
  return record;
}
function canonicalResult(f) {
  const previous = f.base.first.progress;
  return { sessionId: previous?.session.id || session, revision: String(BigInt(previous?.session.revision || '0') + 1n),
    completed: false, complete: false, readyForOutbound: !!previous, localChanged: true, alreadyApplied: false,
    changedFields: [...f.selected.preview.initialImports.map(({ target, scope }) => ({ target, scope, state: 'name_received' })),
      { target: 'price', scope: 'all', state: previous ? 'pending_outward_confirmation' : 'conflict' }],
    terminalScopes: f.selected.preview.initialImports.map(({ target, scope }) => ({ target, scope, state: 'name_received' })) };
}
function storedRow(f) {
  const clean = row => Object.fromEntries(['target', 'scope', 'state', 'before', 'remote', 'after', 'source', 'mappingHash']
    .map(key => [key, row[key]]));
  const sort = rows => [...rows].sort((a, b) => (a.target + '\u0000' + a.scope).localeCompare(b.target + '\u0000' + b.scope, 'en'));
  const command = { key: f.base.first.key, identity: { installationKey: 'fixture', publicSku: f.item.sku,
    remoteProductId: String(f.item.remoteProductId), contractVersion: 'first-sync-v1', initialProductId: f.product.id,
    initialBindingRevisionId: binding }, expectedRevision: f.base.first.progress?.session.revision || '0',
  previewHash: f.base.previewToken, fields: sort(f.base.prepared.rows.map(row => clean(row.record))), actorUserId: 1,
  requiredScopes: sort(f.base.prepared.manifest), complete: false, readyForOutbound: f.base.prepared.readyForOutbound };
  const { complete: _complete, localChanged: _changed, ...result } = canonicalResult(f);
  return { preview_hash: command.previewHash, command_hash: c.hash(command), command, result, actor_user_id: 1,
    origin_hash: c.originHash(config.baseUrl), public_product_identity_id: identity, public_sku: f.item.sku,
    remote_product_id: f.item.remoteProductId, installation_key: 'fixture', audit_event_id: '100',
    event_key: 'magento.first_sync_progress_recorded', subject_type: 'magento_first_sync', subject_id: result.sessionId,
    details: { commandHash: c.hash(command), result: clone(result) } };
}

test('sealed name-only rows select their exact packet, source identity and complete report', () => {
  const fixtures = [fixture(), fixture(2, ['en'])], { runtime } = runtimeFor(fixtures), loaded = loadedFor(fixtures);
  const before = clone(loaded), selected = runner.selectedNames(loaded, runtime);
  assert.deepEqual(selected, fixtures.map(f => f.selected));
  assert.deepEqual(loaded, before);
});

test('CLI requires an explicit bounded action, sealed review hash and exact actor/database/installation', () => {
  for (const mode of ['preview', 'apply', 'resume']) {
    const cli = runner.argumentsFor(cliArgs(mode)); assert.equal(cli.mode, mode); assert.equal(cli.actor, 1);
    assert.equal(cli.reviewHash, 'b'.repeat(64)); assert.equal(cli.database, 'names_test'); assert.equal(cli.installation, 'fixture');
  }
  assert.deepEqual(runner.argumentsFor(['--help']), { help: true });
  for (const args of [[], cliArgs('automatic'), cliArgs().slice(2), [...cliArgs(), '--actor-id', '2'],
    cliArgs().map(value => value === '1' ? '0' : value), cliArgs().map(value => value === 'b'.repeat(64) ? 'bad' : value),
    [...cliArgs(), '--enqueue', 'true']]) assert.throws(() => runner.argumentsFor(args));
});

test('an incomplete or globally invalidated review cannot authorize a names scope', () => {
  const fixtures = [fixture()], { runtime } = runtimeFor(fixtures), loaded = loadedFor(fixtures);
  loaded.review.complete = false; assert.throws(() => runner.selectedNames(loaded, runtime));
  loaded.review.complete = true; loaded.review.globalFailure = 'ACTOR_NOT_ACTIVE';
  assert.throws(() => runner.selectedNames(loaded, runtime));
});

test('fresh names-only validation keeps the complete projection and dry-runs only the old local choices', async t => {
  for (const scopes of [['all', 'en'], ['all'], ['en']]) await t.test(scopes.join('+'), async () => {
    const f = fixture(1, scopes), { runtime, state } = runtimeFor([f]), before = clone(f.base);
    const proof = await runner.validateNames(runtime, config, f.selected, f.base, f.ordinary, run);
    assert.ok(proof); assert.deepEqual(f.base, before);
    assert.deepEqual(state.decisions, [f.report.applyInput.choices]);
    assert.equal(f.base.prepared.rows.length, scopes.length + 1);
    assert.equal(f.base.prepared.rows.find(row => row.target === 'price').record.state, 'conflict');
    assert.deepEqual(state.commits, []);
  });
});

for (const [label, change] of [
  ['changed source price', f => { f.product.total_price_uah = '101.00'; }],
  ['changed source answers', f => { f.product.details.answers.unreviewed = 'change'; }],
  ['test product', f => { f.product.is_test_product = true; }],
  ['inactive lifecycle', f => { f.product.status = 'archived'; }],
  ['excluded product', f => { f.product.exclude_from_export = 1; }],
  ['corrected product', f => { f.product.corrected_to_product_id = 99; }],
  ['held lifecycle route', f => { f.product.exportState.route = 'hold'; }],
  ['changed raw SKU', f => { f.observation.raw.sku = 'OTHER'; }],
  ['changed raw Magento identity', f => { f.observation.raw.id++; }],
  ['changed ordinary Magento identity', f => { f.ordinary.identity.observedMagentoId++; }],
  ['changed ordinary SKU', f => { f.ordinary.identity.article = 'OTHER'; }],
  ['ordinary create mode', f => { f.ordinary.mode = 'create'; }],
  ['ordinary blocker', f => { f.ordinary.blockers.push({ code: 'OTHER_BLOCKER' }); }],
  ['ordinary not sendable', f => { f.ordinary.sendable = false; }],
  ['changed binding', f => { f.observation.amber.revision.id = session; }],
  ['changed definition', f => { f.observation.amber.compiled.hash = 'f'.repeat(64); }],
  ['history mode', f => { f.base.mode = 'review'; }],
  ['changed name value', f => { f.base.prepared.rows[0].record.after = 'Unreviewed name'; }],
  ['unknown name remote', f => { f.base.prepared.rows[0].remote = { known: false }; }],
  ['empty name remote', f => { f.base.prepared.rows[0].remote = { known: true, present: false }; }],
  ['duplicate new name', f => { f.base.prepared.rows.push(clone(f.base.prepared.rows[0])); }],
  ['new price import', f => { f.base.prepared.rows.find(row => row.target === 'price').record.state = 'imported'; }],
  ['missing reviewed name', f => { f.base.prepared.rows.splice(0, 1); }],
  ['unreviewed name scope', f => { f.base.prepared.rows[0].scope = 'ua'; f.base.prepared.rows[0].record.scope = 'ua'; }],
]) test('fresh names-only validation rejects ' + label, async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f]); change(f);
  await assert.rejects(runner.validateNames(runtime, config, f.selected, f.base, f.ordinary, run));
  assert.deepEqual(state.commits, []);
});

test('dry-run remaining conflicts and extra imports cannot expand names authorization', async t => {
  for (const [label, change] of [
    ['blocker', prepared => { prepared.blockers.push({ code: 'FIRST_SYNC_FIELD_CONFLICT' }); prepared.readyForOutbound = false; }],
    ['not ready', prepared => { prepared.readyForOutbound = false; }],
    ['extra import', prepared => { prepared.rows.find(row => row.target === 'price').record.state = 'imported'; }],
  ]) await t.test(label, async () => {
    const f = fixture(), { runtime, state } = runtimeFor([f]); state.changeDryRun = change;
    await assert.rejects(runner.validateNames(runtime, config, f.selected, f.base, f.ordinary, run));
  });
});

test('previous keep-local price receipt stays exact while new names are prepared', async () => {
  const f = fixture(), prior = withPriorPriceReceipt(f), { runtime } = runtimeFor([f]);
  const before = clone(f.base), proof = await runner.validateNames(runtime, config, f.selected, f.base, f.ordinary, run);
  assert.ok(proof); assert.deepEqual(f.base, before);
  assert.deepEqual(f.base.prepared.rows.find(row => row.target === 'price').record, prior);
  assert.equal(f.base.prepared.rows.length, 3);
});

test('changed canonical token requires a new sealed name preview', async () => {
  const f = fixture(); withPriorPriceReceipt(f); f.base.previewToken = 'f'.repeat(64);
  const { runtime } = runtimeFor([f]);
  await assert.rejects(runner.validateNames(runtime, config, f.selected, f.base, f.ordinary, run),
    { code: 'CAMPAIGN_NAMES_FRESH_EVIDENCE_CHANGED' });
  assert.equal(f.report.applyInput.previewToken, c.hash({ sku: f.item.sku }));
  assert.notEqual(f.base.previewToken, f.report.applyInput.previewToken);
});

for (const [label, change] of [
  ['state', record => { record.state = 'outward_verified'; }],
  ['before', record => { record.before.value = '101.00'; }],
  ['remote', record => { record.remote.value = '89.00'; }],
  ['after', record => { record.after = '101.00'; }],
  ['mapping', record => { record.mappingHash = 'f'.repeat(64); }],
  ['authority source', record => { record.source.decision = 'accept_remote'; }],
]) test('names-only proof rejects overwritten prior price receipt ' + label, async () => {
  const f = fixture(); withPriorPriceReceipt(f); const { runtime } = runtimeFor([f]);
  change(f.base.prepared.rows.find(row => row.target === 'price').record);
  await assert.rejects(runner.validateNames(runtime, config, f.selected, f.base, f.ordinary, run));
});

test('canonical receipt includes name states in terminalScopes and retains the whole manifest', async () => {
  const f = fixture(), { runtime } = runtimeFor([f]);
  const proof = await runner.validateNames(runtime, config, f.selected, f.base, f.ordinary, run);
  const result = canonicalResult(f);
  assert.equal(runner.expectedReceipt(runtime, f.selected, proof, result), true);
  assert.deepEqual(result.terminalScopes, [{ target: 'name', scope: 'all', state: 'name_received' },
    { target: 'name', scope: 'en', state: 'name_received' }]);
  assert.equal(proof.commandHash, storedRow(f).command_hash);
  assert.equal(result.changedFields.at(-1).state, 'conflict'); assert.equal(result.readyForOutbound, false);
});

test('preview performs fresh canonical guards without preparing a durable write or calling commit', async () => {
  const f = fixture(), { runtime, state } = runtimeFor([f]), before = clone(f.base);
  const result = await runner.runItem(runtime, config, f.selected, run, { mode: 'preview',
    authority: async () => state.events.push('authority'), append: async () => assert.fail('Preview cannot journal a prepared write'),
    commit: async () => assert.fail('Preview cannot commit') });
  assert.equal(result.status, 'available'); assert.deepEqual(f.base, before);
  assert.deepEqual(state.events, ['authority', 'guard:' + f.item.sku, 'observe:' + f.item.sku,
    'inspect:' + f.item.sku, 'dry-run:' + f.item.sku, 'authority']);
});

test('apply delegates untouched full inspection after the durable prepared intent', async () => {
  const f = fixture(); withPriorPriceReceipt(f); const { runtime, state } = runtimeFor([f]), before = clone(f.base);
  const rows = [];
  const result = await runner.runItem(runtime, config, f.selected, run, { mode: 'apply',
    authority: async () => state.events.push('authority'), append: async row => { rows.push(clone(row)); state.events.push('durable-intent'); },
    commit: async (actualRuntime, actualConfig, guarded, base, options) => {
      state.events.push('commit'); assert.equal(actualRuntime, runtime); assert.equal(actualConfig, config);
      assert.equal(guarded.publicSku, f.item.sku); assert.equal(base, f.base); assert.deepEqual(base, before);
      assert.equal(Object.hasOwn(options, 'firstSyncDecision'), false); assert.equal(Object.hasOwn(options, 'automatic'), false);
      assert.equal(rows.length, 1); assert.equal(rows[0].type, 'prepared');
      assert.deepEqual(rows[0].proof.changedFields, canonicalResult(f).changedFields);
      return canonicalResult(f);
    } });
  assert.equal(result.status, 'recorded'); assert.deepEqual(result.result, canonicalResult(f)); assert.deepEqual(f.base, before);
  assert.deepEqual(state.events.slice(-3), ['authority', 'durable-intent', 'commit']);
});

test('failed prepared fsync or interruption cannot reach the commit helper', async t => {
  for (const stop of [false, true]) await t.test(stop ? 'signal' : 'fsync failure', async () => {
    const f = fixture(), { runtime } = runtimeFor([f]); let stopping = false, commits = 0;
    const task = runner.runItem(runtime, config, f.selected, run, { authority: async () => {}, stopping: () => stopping,
      append: async () => { if (stop) stopping = true; else throw Object.assign(Error('Synthetic fsync failure'), { journalFailure: true }); },
      commit: async () => { commits++; return canonicalResult(f); } });
    if (stop) assert.equal((await task).status, 'blocked');
    else await assert.rejects(task, cause => cause.journalFailure === true);
    assert.equal(commits, 0);
  });
});

test('unknown commit and malformed receipt are never reported as a known rollback', async t => {
  for (const [label, commit] of [
    ['lost response', async () => { throw Error('Lost response'); }],
    ['unconfirmed transaction', async () => { throw Object.assign(Error('Unknown COMMIT'), { unconfirmed: true }); }],
    ['already applied shortcut', async f => ({ ...canonicalResult(f), alreadyApplied: true })],
    ['missing name state', async f => ({ ...canonicalResult(f), terminalScopes: [{ target: 'name', scope: 'all' }] })],
    ['extra imported field', async f => ({ ...canonicalResult(f), changedFields: [...canonicalResult(f).changedFields,
      { target: 'length', scope: 'all', state: 'imported' }] })],
  ]) await t.test(label, async () => {
    const f = fixture(), { runtime } = runtimeFor([f]);
    const result = await runner.runItem(runtime, config, f.selected, run, { authority: async () => {}, append: async () => {},
      commit: async () => commit(f) });
    assert.equal(result.status, 'unconfirmed'); assert.equal(result.stop, true);
  });
});

test('commit-helper proven rollback remains a blocker without claiming a receipt', async () => {
  const f = fixture(), { runtime } = runtimeFor([f]);
  const result = await runner.runItem(runtime, config, f.selected, run, { authority: async () => {}, append: async () => {},
    commit: async () => { throw Object.assign(Error('Guard rejected'), { code: 'ACTOR_NOT_ACTIVE', nameCommitRolledBack: true }); } });
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'ACTOR_NOT_ACTIVE'); assert.equal(result.stop, true);
  assert.equal(Object.hasOwn(result, 'result'), false);
});

async function receiptFixture() {
  const f = fixture(), { runtime } = runtimeFor([f]), rows = [];
  const result = await runner.runItem(runtime, config, f.selected, run, { authority: async () => {}, append: async row => rows.push(row),
    commit: async () => canonicalResult(f) });
  assert.equal(result.status, 'recorded');
  return { f, runtime, prepared: rows[0], receipt: { type: 'receipt', ...result } };
}
test('journal accepts only complete ordered intent and canonical receipt pairs', async () => {
  const { f, runtime, prepared, receipt } = await receiptFixture(), header = { type: 'start', contract: 'synthetic-names' };
  assert.deepEqual(runner.readJournal(encode([header, prepared, receipt]), header, [f.selected], runtime), [receipt]);
  for (const rows of [[header, prepared], [header, prepared, { ...receipt, status: 'unconfirmed' }]])
    assert.throws(() => runner.readJournal(encode(rows), header, [f.selected], runtime), { code: 'CAMPAIGN_NAMES_JOURNAL_UNCONFIRMED' });
  for (const rows of [[header, receipt], [header, prepared, prepared], [header, { ...prepared, scopeHash: 'f'.repeat(64) }],
    [header, prepared, { ...receipt, proof: { ...receipt.proof, commandHash: 'f'.repeat(64) } }]])
    assert.throws(() => runner.readJournal(encode(rows), header, [f.selected], runtime));
  const bytes = encode([header, prepared, receipt]);
  assert.throws(() => runner.readJournal(bytes.subarray(0, bytes.length - 1), header, [f.selected], runtime));
  assert.throws(() => runner.readJournal(bytes, { ...header, actorUserId: 2 }, [f.selected], runtime));
});

test('resume verifies exact immutable receipt and audit evidence using parameterized SELECT only', async () => {
  const { f, runtime, receipt } = await receiptFixture(), calls = [];
  await runner.verifyRecorded(runtime, config, f.selected, receipt, { ...run, databasePool: {
    query: async (sql, values) => { assert.match(sql, /^SELECT /); calls.push(values); return { rows: [storedRow(f)] }; },
  } });
  assert.deepEqual(calls, [[session, '1', f.base.previewToken]]);
});
for (const [label, change] of [
  ['actor', row => { row.actor_user_id = 2; }], ['origin', row => { row.origin_hash = 'f'.repeat(64); }],
  ['public identity', row => { row.public_product_identity_id = '102'; }], ['SKU', row => { row.public_sku = 'OTHER'; }],
  ['Magento identity', row => { row.remote_product_id++; }], ['installation', row => { row.installation_key = 'other'; }],
  ['command hash', row => { row.command_hash = 'f'.repeat(64); }], ['stored fields', row => { row.command.fields.pop(); }],
  ['audit hash', row => { row.details.commandHash = 'f'.repeat(64); }], ['audit subject', row => { row.subject_id = binding; }],
  ['audit event', row => { row.event_key = 'other'; }], ['audit result', row => { row.details.result.revision = '2'; }],
  ['result imported scope', row => { row.result.changedFields.push({ target: 'price', scope: 'en', state: 'imported' }); }],
]) test('resume refuses mismatching persisted ' + label, async () => {
  const { f, runtime, receipt } = await receiptFixture(), row = storedRow(f); change(row);
  await assert.rejects(runner.verifyRecorded(runtime, config, f.selected, receipt, { ...run, databasePool: {
    query: async () => ({ rows: [row] }),
  } }), { code: 'CAMPAIGN_NAMES_RECORDED_RECEIPT_UNCONFIRMED' });
});

test('PostgreSQL bigint actor strings preserve exact actor ownership during receipt verification', async () => {
  const { f, runtime, receipt } = await receiptFixture(), row = storedRow(f); row.actor_user_id = '1';
  const options = { ...run, databasePool: { query: async () => ({ rows: [row] }) } };
  await runner.verifyRecorded(runtime, config, f.selected, receipt, options);
  row.actor_user_id = '2';
  await assert.rejects(runner.verifyRecorded(runtime, config, f.selected, receipt, options),
    { code: 'CAMPAIGN_NAMES_RECORDED_RECEIPT_UNCONFIRMED' });
});

test('durable output handles partial writes, fsyncs, and rejects zero progress or failed fsync', async t => {
  const runtime = { audit: { assertEvidenceSafe() {} } }, chunks = [], events = [];
  const handle = { stat: async () => ({ size: 0 }), write: async (bytes, offset, length) => {
    const size = Math.min(length, 3); chunks.push(bytes.subarray(offset, offset + size)); events.push('write'); return { bytesWritten: size };
  }, sync: async () => events.push('sync') };
  await runner.durableWrite(handle, { type: 'prepared' }, runtime, {}, []);
  assert.equal(Buffer.concat(chunks).toString(), '{"type":"prepared"}\n'); assert.equal(events.at(-1), 'sync');
  for (const [label, altered] of [
    ['zero progress', { ...handle, write: async () => ({ bytesWritten: 0 }) }],
    ['fsync failure', { ...handle, sync: async () => { throw Error('Synthetic fsync failure'); } }],
    ['journal bound', { ...handle, stat: async () => ({ size: 32 * 1024 * 1024 }) }],
  ]) await t.test(label, async () => {
    await assert.rejects(runner.durableWrite(altered, { type: 'prepared' }, runtime, {}, []), cause => cause.journalFailure === true);
  });
});

async function setup(t, count = 2) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-names-unit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixtures = Array.from({ length: count }, (_, index) => fixture(index + 1)), h = runtimeFor(fixtures), loaded = loadedFor(fixtures);
  const output = path.join(dir, 'journal'), errors = [], messages = [], reads = [], authorities = [];
  const pool = { query: async (sql, values) => {
    assert.match(sql, /^SELECT /); reads.push({ sql, values });
    if (sql.includes('current_database')) return { rows: [{ name: 'names_test' }] };
    const f = fixtures.find(f => f.base.previewToken === values[2] && h.state.commits.includes(f.item.sku));
    return { rows: f ? [storedRow(f)] : [] };
  } };
  const deps = { runtime: h.runtime, pool, config, env: {}, implementationHash: async () => 'c'.repeat(64),
    loadReview: async (directory, rawHash, runtime, cli) => {
      assert.equal(directory, path.join(dir, 'review')); assert.equal(rawHash, 'b'.repeat(64));
      assert.equal(runtime, h.runtime); assert.equal(cli.actor, 1); return loaded;
    },
    readAuthority: async () => { authorities.push('authority'); return loaded.review.publication; },
    runNameCommit: async (_runtime, _config, _state, base, options) => {
      const sku = base.observation.raw.sku; h.state.events.push('commit:' + sku);
      assert.equal(Object.hasOwn(options, 'firstSyncDecision'), false);
      const rows = (await fs.readFile(path.join(output, 'results.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
      assert.equal(rows.at(-1).type, 'prepared'); assert.equal(rows.at(-1).sku, sku);
      if (h.state.failure) throw h.state.failure;
      h.state.commits.push(sku); h.state.afterCommit?.(); return canonicalResult(fixtures.find(f => f.item.sku === sku));
    }, print: value => messages.push(JSON.parse(value)), printError: value => errors.push(JSON.parse(value)) };
  const args = mode => cliArgs(mode).map(value => value === '/synthetic/review' ? path.join(dir, 'review')
    : value === '/synthetic/output' ? output : value);
  return { ...h, loaded, dir, output, errors, messages, reads, authorities, deps, args };
}

test('main preview creates private exclusive output and never enters the commit helper', async t => {
  const f = await setup(t);
  assert.equal(await runner.main(f.args('preview'), f.deps), 0, JSON.stringify(f.errors));
  assert.equal((await fs.stat(f.output)).mode & 0o777, 0o700);
  const file = path.join(f.output, 'results.jsonl'), bytes = await fs.readFile(file);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600); assert.deepEqual(f.state.commits, []);
  const rows = bytes.toString().trimEnd().split('\n').map(JSON.parse);
  assert.equal(rows.some(row => row.type === 'prepared'), false);
  assert.equal(rows.at(-1).available, 2); assert.equal(rows.at(-1).readOnly, true);
  const events = clone(f.state.events);
  assert.equal(await runner.main(f.args('apply'), f.deps), 1);
  assert.equal(f.errors.at(-1).code, 'CAMPAIGN_NAMES_OUTPUT_EXISTS'); assert.deepEqual(f.state.events, events);
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('main apply is sequential and resume verifies confirmed receipts before continuing the untouched tail', async t => {
  const f = await setup(t); f.state.afterCommit = () => process.emit('SIGINT');
  assert.equal(await runner.main(f.args('apply'), f.deps), 2, JSON.stringify(f.errors));
  assert.deepEqual(f.state.commits, [f.fixtures[0].item.sku]); delete f.state.afterCommit;
  assert.equal(await runner.main(f.args('resume'), f.deps), 0, JSON.stringify(f.errors));
  assert.deepEqual(f.state.commits, f.fixtures.map(row => row.item.sku));
  assert.equal(f.reads.filter(row => row.sql.includes('JOIN audit_events')).length, 1);
  assert.equal(f.messages.at(-1).recorded, 2); assert.equal(f.messages.at(-1).complete, true);
  assert.equal(f.messages.at(-1).deliveryEffect.directRemoteWrites, 0);
  assert.equal(f.messages.at(-1).deliveryEffect.directlyEnqueuedJobs, 0);
});

test('unknown commit stops the untouched tail and resume performs zero domain calls or journal writes', async t => {
  const f = await setup(t); f.state.failure = Error('Synthetic lost COMMIT response');
  assert.equal(await runner.main(f.args('apply'), f.deps), 2, JSON.stringify(f.errors));
  assert.equal(f.state.events.filter(event => event.startsWith('commit:')).length, 1);
  assert.equal(f.messages.at(-1).unconfirmed, 1); assert.equal(f.messages.at(-1).notChecked, 1);
  const before = await fs.readFile(path.join(f.output, 'results.jsonl')), events = clone(f.state.events), authorityCount = f.authorities.length;
  delete f.state.failure;
  assert.equal(await runner.main(f.args('resume'), f.deps), 1);
  assert.equal(f.errors.at(-1).code, 'CAMPAIGN_NAMES_JOURNAL_UNCONFIRMED'); assert.deepEqual(f.state.events, events);
  assert.equal(f.authorities.length, authorityCount); assert.deepEqual(await fs.readFile(path.join(f.output, 'results.jsonl')), before);
});

test('unresolved durable intent cannot be retried even if no receipt was written', async t => {
  const f = await setup(t); f.state.failure = Error('Synthetic lost response');
  assert.equal(await runner.main(f.args('apply'), f.deps), 2);
  const file = path.join(f.output, 'results.jsonl'), rows = (await fs.readFile(file, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  await fs.writeFile(file, encode(rows.slice(0, 2))); const bytes = await fs.readFile(file), events = clone(f.state.events);
  delete f.state.failure;
  assert.equal(await runner.main(f.args('resume'), f.deps), 1);
  assert.equal(f.errors.at(-1).code, 'CAMPAIGN_NAMES_JOURNAL_UNCONFIRMED');
  assert.deepEqual(f.state.events, events); assert.deepEqual(await fs.readFile(file), bytes);
});

test('resume refuses a missing immutable database receipt before entering another SKU', async t => {
  const f = await setup(t); f.state.afterCommit = () => process.emit('SIGINT');
  assert.equal(await runner.main(f.args('apply'), f.deps), 2); delete f.state.afterCommit;
  f.deps.pool.query = async sql => ({ rows: sql.includes('current_database') ? [{ name: 'names_test' }] : [] });
  const events = clone(f.state.events);
  assert.equal(await runner.main(f.args('resume'), f.deps), 1);
  assert.equal(f.errors.at(-1).code, 'CAMPAIGN_NAMES_RECORDED_RECEIPT_UNCONFIRMED'); assert.deepEqual(f.state.events, events);
});

test('resume refuses changed implementation ownership without another domain call', async t => {
  const f = await setup(t); f.state.afterCommit = () => process.emit('SIGINT');
  assert.equal(await runner.main(f.args('apply'), f.deps), 2); delete f.state.afterCommit;
  f.deps.implementationHash = async () => 'd'.repeat(64); const events = clone(f.state.events);
  assert.equal(await runner.main(f.args('resume'), f.deps), 1);
  assert.equal(f.errors.at(-1).code, 'CAMPAIGN_NAMES_JOURNAL_SCOPE_CHANGED'); assert.deepEqual(f.state.events, events);
});

test('publication change blocks all fresh canonical calls', async t => {
  const f = await setup(t); f.deps.readAuthority = async () => ({ ...f.loaded.review.publication, bindingRevisionId: session });
  assert.equal(await runner.main(f.args('apply'), f.deps), 1);
  assert.equal(f.errors.at(-1).code, 'CAMPAIGN_NAMES_PUBLICATION_CHANGED'); assert.deepEqual(f.state.events, []);
});

test('read-only network boundary refuses mutation verbs before reaching the injected transport', async t => {
  const f = await setup(t); let transports = 0;
  f.deps.fetchImpl = async () => { transports++; assert.fail('Mutation cannot reach transport'); };
  f.runtime.boundary.observe = async (_config, _input, options) => {
    await options.fetchImpl('https://names-fixture.invalid/rest/V1/products', { method: 'POST' });
    assert.fail('A remote mutation was allowed');
  };
  assert.equal(await runner.main(f.args('preview'), f.deps), 2);
  assert.equal(transports, 0); assert.deepEqual(f.state.commits, []);
});

test('forged or rehashed derived name scope never becomes a command', async t => {
  for (const [label, change] of [
    ['extra action', loaded => { loaded.review.nameOnlyPreview[0].action = 'apply'; }],
    ['changed name', loaded => { loaded.review.nameOnlyPreview[0].initialImports[0].after = 'Unreviewed'; }],
    ['wrong product', loaded => { loaded.review.nameOnlyPreview[0].productId++; }],
    ['wrong remote', loaded => { loaded.review.nameOnlyPreview[0].remoteProductId++; }],
    ['wrong packet', loaded => { loaded.review.nameOnlyPreview[0].planFile = 'plan-0002.json'; }],
    ['duplicate SKU', loaded => { loaded.review.nameOnlyPreview.push(clone(loaded.review.nameOnlyPreview[0])); }],
    ['missing derived row', loaded => { loaded.review.nameOnlyPreview = []; }],
    ['changed packet source', loaded => { loaded.plans[0].request.items[0].expectedProduct.total_price_uah = '999'; }],
  ]) await t.test(label, async t => {
    const f = await setup(t); change(f.loaded);
    assert.equal(await runner.main(f.args('apply'), f.deps), 1); assert.deepEqual(f.state.events, []);
  });
});
