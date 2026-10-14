const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const classify = require('../scripts/first-sync-local-classify');
const c = require('../src/services/magento/binding-contract');
const batch = require('../src/services/magento/first-sync-batch-preflight');
const audit = require('../src/services/magento/binding-evidence-audit');

const binding = '11111111-1111-4111-8111-111111111111';
const definitionHash = 'a'.repeat(64);
const publication = { bindingRevisionId: binding, expectedDefinitionHash: definitionHash, publicationHash: 'b'.repeat(64) };
const config = { configured: true, baseUrl: 'https://classify.example.invalid' };
const clone = value => structuredClone(value);
const candidate = (id = 1, sku = 'SV-' + id) => ({ sku, productId: id, category: 'SV', remoteProductId: null });
const inputFor = items => ({ bindingRevisionId: binding, expectedDefinitionHash: definitionHash, items });
const rawHash = bytes => createHash('sha256').update(bytes).digest('hex');
const failWrite = () => assert.fail('A read-only classifier invoked a writer or decision preparation');

function scenario(item = candidate()) {
  const product = { id: item.productId, public_product_identity_id: String(item.productId), full_sku: item.sku,
    public_sku: item.sku, category: 'SV', status: 'active', exclude_from_export: 0,
    corrected_to_product_id: null, sku_schema_version_id: binding, characteristic_version_id: null,
    weight: '12.400', total_price_uah: '1200.00', details: { answers: { souvenir: 5, weight: '12.4' } },
    exportState: { route: 'normal', business_exclusion_state: 'none', recount_compatibility_excluded: false, independentExclusion: false },
    is_test_product: false };
  const observation = { amber: { product, revision: { id: binding, state: 'published', installationKey: 'amber', definitionHash },
    compiled: { hash: definitionHash } }, raw: { id: 1000 + item.productId, sku: item.sku },
    domainEvidence: { failures: [] }, categoryFailures: [] };
  const report = { generatedAt: '2026-10-14T00:00:00.000Z', mode: 'update',
    identity: { state: 'found', article: item.sku, observedMagentoId: observation.raw.id },
    amberProduct: { publicSku: item.sku }, bindingRevision: { id: binding, state: 'published' },
    evaluation: { ready: true }, syncEligibility: { eligible: true }, sendable: true, blockers: [] };
  const base = { mode: 'ordinary', observation, blockers: [], first: { mode: 'ordinary', blockers: [], progress: { fields: [] } },
    fields: [], prepared: { rows: [], blockers: [], readyForOutbound: true, complete: true },
    projection: { projection: [] }, readyForOutbound: true, complete: true };
  return { item, product, observation, report, base, freshProduct: null, initialSelection: null };
}

function historyScenario(s = scenario()) {
  s.base.mode = s.base.first.mode = 'review';
  s.base.historyReview = { sku: s.item.sku, productId: s.item.productId, remoteProductId: s.observation.raw.id,
    previewToken: 'c'.repeat(64), scope: 'first_sync_review_only', doesNotAcknowledgeExport: true, legacySnapshotFlag: true };
  s.base.historyReviewAssessment = { status: 'available', legacySnapshotFlag: true,
    code: 'FIRST_SYNC_LEGACY_SNAPSHOT_FLAG_REVIEW_AVAILABLE' };
  s.base.first.historyReview = clone(s.base.historyReview);
  s.base.blockers = s.base.first.blockers = [{ code: 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED' }];
  return s;
}

function namesScenario(s = scenario()) {
  s.base.mode = s.base.first.mode = 'first';
  s.base.first.historyAdmission = { eventId: '1' };
  s.initialSelection = { historyRoot: '1', preview: { sku: s.item.sku, productId: s.item.productId,
    remoteProductId: s.observation.raw.id, initialImports: [{ target: 'name', scope: 'all', after: 'Existing name' }] } };
  s.report.sendable = false; s.report.blockers = [{ code: 'NAME_BASELINE_REQUIRED' }];
  return s;
}

function createScenario(s = scenario()) {
  s.observation.raw = null; s.report.mode = 'create';
  s.report.identity = { state: 'absent', article: s.item.sku, observedMagentoId: null };
  s.base.mode = s.base.first.mode = 'create';
  return s;
}

function runtimeFor(scenarios) {
  const calls = [];
  const runtime = { c, batch, audit, pool: { databaseSecrets: () => [] },
    admission: { descriptor: value => clone(value), allows: () => true, rootId: () => '1', apply: failWrite },
    initialNameSelection: (_runtime, _scope, item) => {
      calls.push({ stage: 'name-selection', sku: item.sku });
      const current = scenarios.find(s => s.item.sku === item.sku);
      if (!current.initialSelection) throw Object.assign(Error('No initial names'), { code: 'INITIAL_NAMES_NO_NEW_NAMES' });
      return clone(current.initialSelection);
    },
    preview: async (_config, options) => {
      calls.push({ stage: 'preview', sku: options.sku });
      const current = scenarios.find(s => s.item.sku === options.sku);
      options.onObservation(current.observation);
      return current.report;
    },
    first: {
      inspect: async (_config, observation) => {
        const current = scenarios.find(s => s.observation === observation);
        calls.push({ stage: 'inspect', sku: current.item.sku });
        return current.base;
      },
      prepareDecision: failWrite, apply: failWrite, commit: failWrite,
    },
    readSnapshot: async (_pool, input) => {
      calls.push({ stage: 'snapshot', sku: input.sku });
      const current = scenarios.find(s => s.item.sku === input.sku);
      return { product: current.freshProduct || clone(current.product) };
    },
  };
  return { runtime, calls };
}

async function inspect(s) {
  const f = runtimeFor([s]);
  f.result = await classify.classifyItem(f.runtime, config, s.item, publication,
    { databasePool: {}, actorUserId: 7, installation: 'amber', sensitiveValues: [], fetchImpl: failWrite });
  return f;
}

async function fixture(t, items = [candidate()]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-classify-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenarios = items.map(item => scenario(item)), f = runtimeFor(scenarios), messages = [], errors = [], queries = [];
  const input = path.join(dir, 'input.json'), output = path.join(dir, 'results');
  await fs.writeFile(input, JSON.stringify(inputFor(items), null, 2) + '\n');
  const dependencies = { runtime: f.runtime, config, env: {}, print: value => messages.push(JSON.parse(value)),
    printError: value => errors.push(JSON.parse(value)), readAuthority: async () => clone(publication),
    pool: { query: async sql => {
      queries.push(sql);
      if (sql === 'SELECT current_database() AS name') return { rows: [{ name: 'classify_fixture_test' }] };
      if (sql === 'SHOW default_transaction_read_only') return { rows: [{ default_transaction_read_only: 'on' }] };
      assert.fail('Unexpected SQL: ' + sql);
    } } };
  return { ...f, dir, input, output, scenarios, messages, errors, queries, dependencies };
}
const args = f => ['--input', f.input, '--output-dir', f.output, '--expected-database', 'classify_fixture_test',
  '--actor-id', '7', '--installation-key', 'amber'];
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const journal = async f => (await fs.readFile(path.join(f.output, 'results.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);

test('runtime uses canonical read services and pure initial-name selection without starting the app', () => {
  const runtime = classify.createRuntime(path.join(__dirname, '..'));
  assert.equal(runtime.preview, require('../src/services/magento/sync-preview').previewProduct);
  assert.equal(runtime.first, require('../src/services/magento/first-sync.service'));
  assert.equal(runtime.batch, batch);
  assert.equal(runtime.readSnapshot, require('../src/services/magento/sync-preview-db').readPreviewProduct);
  assert.equal(runtime.initialNameSelection, require('../scripts/first-sync-initial-name-plan').selectionFor);
});

test('exact public AG identity in category SV is classified without guessing from SKU prefix or changing input', async () => {
  const s = scenario(candidate(1, 'AG-SYNTHETIC')), before = clone(s.item);
  const { result, calls } = await inspect(s);
  assert.equal(result.route, 'ordinary');
  assert.equal(result.expectedRemoteProductId, null);
  assert.equal(result.observedRemoteProductId, 1001);
  assert.equal(result.eligibilityMode, 'ordinary');
  assert.equal(result.inspectionMode, 'ordinary');
  assert.deepEqual(s.item, before);
  assert.deepEqual(calls.filter(call => ['preview', 'inspect', 'snapshot'].includes(call.stage)).map(call => call.stage),
    ['preview', 'inspect', 'snapshot']);
});

test('exact identity requires agreement of local ID/category/public SKU, report and raw Magento identity', async t => {
  const changes = [s => { s.item.remoteProductId = 999; }, s => { s.product.id = 2; },
    s => { s.product.category = 'NM'; }, s => { s.product.public_sku = 'AG-OTHER'; },
    s => { s.observation.raw.sku = 'SV-OTHER'; }, s => { s.observation.raw.id = 1002; },
    s => { s.report.identity.article = 'SV-OTHER'; }, s => { s.report.amberProduct.publicSku = 'SV-OTHER'; },
    s => { s.report.identity.observedMagentoId = null; }, s => { s.report.identity.state = 'unknown'; }];
  for (const [index, change] of changes.entries()) await t.test(String(index), async () => {
    const s = scenario(); change(s);
    const { result } = await inspect(s);
    assert.equal(result.route, 'review');
    assert.ok(result.blockers.length > 0);
    if (s.item.remoteProductId === 999) {
      assert.equal(result.expectedRemoteProductId, 999);
      assert.equal(result.observedRemoteProductId, 1001);
    }
  });
});

test('only exact absent remote evidence and canonical create eligibility produce create route', async t => {
  assert.equal((await inspect(createScenario())).result.route, 'create');
  const changes = [s => { s.report.identity.state = 'unknown'; }, s => { s.report.mode = 'update'; },
    s => { s.base.first.mode = 'blocked'; }, s => { s.observation.raw = { id: 1001, sku: s.item.sku }; },
    s => { s.item.remoteProductId = 1001; }];
  for (const [index, change] of changes.entries()) await t.test(String(index), async () => {
    const s = createScenario(); change(s);
    assert.equal((await inspect(s)).result.route, 'review');
  });
});

test('underlying first eligibility and projection review are reported independently', async () => {
  const s = scenario(); s.base.mode = 'review'; s.base.first.mode = 'first';
  s.base.blockers = [{ code: 'CANONICAL_WEIGHT_ANSWER_INCOHERENT', target: 'decor_weight', scope: 'all' }];
  s.base.first.blockers = [];
  const { result } = await inspect(s);
  assert.equal(result.route, 'review');
  assert.equal(result.eligibilityMode, 'first');
  assert.equal(result.inspectionMode, 'review');
  assert.ok(result.fieldBlockers.some(b => b.code === 'CANONICAL_WEIGHT_ANSWER_INCOHERENT'));
});

test('ordinary workflow classification never upgrades old local ACK to remote readiness', async () => {
  const s = scenario(); s.report.sendable = false;
  s.report.blockers = [{ code: 'MAGENTO_ATTRIBUTE_REVIEW_REQUIRED', target: 'fraction', scope: 'all' }];
  const { result } = await inspect(s);
  assert.equal(result.route, 'ordinary');
  assert.ok(result.ordinaryBlockers.some(b => b.code === 'MAGENTO_ATTRIBUTE_REVIEW_REQUIRED'));
  assert.notEqual(result.readyForApply, true);
  assert.notEqual(result.readyForOutbound, true);
});

test('history eligibility remains visible with a separate name-baseline ordinary blocker', async () => {
  const s = historyScenario();
  s.report.sendable = false; s.report.blockers = [{ code: 'NAME_BASELINE_REQUIRED' }];
  const { result } = await inspect(s);
  assert.equal(result.route, 'history');
  assert.ok(result.ordinaryBlockers.some(b => b.code === 'NAME_BASELINE_REQUIRED'));
  assert.ok(result.eligibilityBlockers.some(b => b.code === 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED'));
});

test('initial-name route relies on existing pure selection proof and never prepares decisions', async () => {
  const s = namesScenario();
  const { result, calls } = await inspect(s);
  assert.equal(result.route, 'initial_names');
  assert.ok(calls.some(call => call.stage === 'name-selection'));
});

test('initial names rejected by canonical history-admission validation remain review-only', async () => {
  const s = namesScenario(), f = runtimeFor([s]);
  f.runtime.initialNameSelection = () => {
    throw Object.assign(Error('A canonical admission is required'), { code: 'INITIAL_NAMES_HISTORY_ADMISSION_REQUIRED' });
  };
  const result = await classify.classifyItem(f.runtime, config, s.item, publication,
    { databasePool: {}, actorUserId: 7, installation: 'amber', sensitiveValues: [], fetchImpl: failWrite });
  assert.equal(result.route, 'review');
  assert.equal(result.reviewKind, 'blocked');
  assert.ok(result.blockers.some(blocker => blocker.code === 'INITIAL_NAMES_HISTORY_ADMISSION_REQUIRED'));
  assert.equal(result.observedRemoteProductId, 1001);
  assert.equal(Object.hasOwn(result, 'initialNames'), false);
  assert.equal(Object.hasOwn(result, 'applyInput'), false);
  assert.equal(result.freshRemoteEquivalenceEstablished, false);
});

test('canonical first-sync without new names remains field-stage review with original numeric and SEO facts', async () => {
  const s = scenario(); s.base.mode = s.base.first.mode = 'first';
  s.product.weight = '0'; s.product.details.answers.weight = '12,400';
  s.base.fields = [{ target: 'decor_weight', scope: 'all', local: { known: true, present: true, value: '0' },
    remote: { known: true, present: true, value: 12 }, canKeepLocal: false }];
  s.base.blockers = [{ code: 'CANONICAL_WEIGHT_ANSWER_INCOHERENT', target: 'decor_weight', scope: 'all' }];
  const before = clone(s.product), { result } = await inspect(s);
  assert.equal(result.route, 'review');
  assert.equal(result.reviewKind, 'field_stage');
  assert.deepEqual(result.fields, s.base.fields);
  assert.deepEqual(result.sourceSnapshot, batch.source(before));
  assert.deepEqual(s.product, before);
  assert.equal(Object.hasOwn(result, 'applyInput'), false);
  assert.equal(Object.hasOwn(result, 'choices'), false);
  assert.equal(result.freshRemoteEquivalenceEstablished, false);
});

test('history route requires the complete canonical available proposal instead of a generic history hint', async t => {
  const changes = [s => { s.base.historyReviewAssessment.status = 'blocked'; },
    s => { s.base.historyReview.scope = 'export_acknowledgement'; },
    s => { s.base.historyReview.legacySnapshotFlag = false; },
    s => { s.base.historyReview.doesNotAcknowledgeExport = false; },
    s => { s.base.historyReview.remoteProductId = 999; },
    s => { s.base.historyReview.previewToken = 'unsealed'; },
    s => { s.base.blockers.push({ code: 'PROTECTED_WORK' }); }];
  for (const [index, change] of changes.entries()) await t.test(String(index), async () => {
    const s = historyScenario(); change(s);
    assert.equal((await inspect(s)).result.route, 'review');
  });
});

test('lifecycle exclusions and final local source drift retain review route', async t => {
  const changes = [s => { s.product.status = 'archived'; }, s => { s.product.is_test_product = true; },
    s => { s.product.exportState.route = 'held'; }, s => { s.product.corrected_to_product_id = 2; },
    s => { s.product.exportState.business_exclusion_state = 'excluded'; },
    s => { s.freshProduct = clone(s.product); s.freshProduct.details.answers.weight = '13'; }];
  for (const [index, change] of changes.entries()) await t.test(String(index), async () => {
    const s = scenario(); change(s);
    const { result } = await inspect(s);
    assert.equal(result.route, 'review');
    assert.ok(result.blockers.length > 0);
  });
});

test('strict input cannot carry values, decisions, other categories or duplicated identities', () => {
  const runtime = { c, batch }, original = inputFor([candidate()]);
  assert.doesNotThrow(() => classify.validateInput(original, runtime));
  const changes = [i => { delete i.bindingRevisionId; }, i => { delete i.expectedDefinitionHash; },
    i => { i.items[0].fields = [{ target: 'price', local: 1, remote: 2 }]; },
    i => { i.items[0].category = 'NM'; }, i => { i.items[0].sku = ' SV-1'; },
    i => { i.items[0].remoteProductId = '1001'; }, i => { i.items[0].remoteProductId = 0; },
    i => { i.items[0].productId = null; }, i => { i.items.push(clone(i.items[0])); },
    i => { i.items.push({ ...candidate(2), productId: 1 }); }, i => { i.items = Array(1); },
    i => { i.items = [{ ...candidate(1), remoteProductId: 1001 }, { ...candidate(2), remoteProductId: 1001 }]; },
    i => { i.items = []; }, i => { i.items = Array.from({ length: 2001 }, (_, n) => candidate(n + 1)); }];
  for (const change of changes) { const input = clone(original); change(input); assert.throws(() => classify.validateInput(input, runtime)); }
  const cli = ['--input', 'scope.json', '--output-dir', 'new-output', '--expected-database', 'amber', '--actor-id', '7', '--installation-key', 'amber'];
  assert.equal(classify.argumentsFor(cli).limit, 10);
  assert.equal(classify.argumentsFor([...cli, '--limit', '2000']).limit, 2000);
  for (const extra of [['--limit', '2001'], ['--offset', '-1'], ['--mode', 'apply'], ['--input', 'another']])
    assert.throws(() => classify.argumentsFor([...cli, ...extra]));
});

test('GET firewall denies mutations, bodies and Request-method bypass before delegation', async () => {
  const calls = [], get = classify.getOnly(async (...args) => { calls.push(args); return 'read'; });
  assert.equal(await get('https://classify.example.invalid'), 'read');
  assert.equal(await get('https://classify.example.invalid', { method: 'get' }), 'read');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    assert.throws(() => get('https://classify.example.invalid', { method }));
    assert.throws(() => get(new Request('https://classify.example.invalid', { method })));
  }
  assert.throws(() => get('https://classify.example.invalid', { method: 'GET', body: 'no' }));
  assert.equal(calls.length, 2);
});

test('help needs no configured runtime, database or output', async () => {
  const printed = [], dependencies = { env: {}, print: value => printed.push(value), printError: failWrite };
  Object.defineProperty(dependencies, 'runtime', { get: failWrite });
  Object.defineProperty(dependencies, 'pool', { get: failWrite });
  assert.equal(await classify.main(['--help'], dependencies), 0);
  assert.equal(printed.length, 1);
});

test('bounded sequential classification checkpoints every SKU and preserves the exact scope', async t => {
  const f = await fixture(t, Array.from({ length: 12 }, (_, n) => candidate(n + 1))), before = await fs.readFile(f.input);
  const preview = f.runtime.preview; let count = 0, active = false;
  f.runtime.preview = async (...params) => {
    assert.equal(active, false); active = true;
    const records = await journal(f);
    assert.equal(records.filter(record => record.kind === 'result').length, count);
    assert.equal((await fs.readdir(f.output)).includes('manifest.json'), false);
    await new Promise(resolve => setImmediate(resolve));
    const report = await preview(...params); count++; active = false; return report;
  };
  assert.equal(await classify.main([...args(f), '--offset', '1', '--limit', '10'], f.dependencies), 0, JSON.stringify(f.errors));
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.checked, 10);
  assert.equal(manifest.nextOffset, 11);
  assert.equal(manifest.remainingInput, 1);
  assert.equal(manifest.inputSha256, rawHash(before));
  assert.equal(manifest.canonicalInputSha256, c.hash(inputFor(f.scenarios.map(s => s.item))));
  assert.deepEqual(await fs.readFile(f.input), before);
  assert.deepEqual(await fs.readFile(path.join(f.output, 'scope.json')), before);
  assert.deepEqual(await json(path.join(f.output, 'scope.json')), JSON.parse(before));
  assert.deepEqual(f.calls.filter(call => call.stage === 'preview').map(call => call.sku),
    f.scenarios.slice(1, 11).map(s => s.item.sku));
});

test('database identity, read-only mode and frozen publication are enforced before SKU reads', async t => {
  for (const kind of ['database', 'readonly', 'publication', 'actor']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'database') f.dependencies.pool.query = async () => ({ rows: [{ name: 'other_test' }] });
    if (kind === 'readonly') f.dependencies.pool.query = async sql => ({ rows: [sql.startsWith('SELECT')
      ? { name: 'classify_fixture_test' } : { default_transaction_read_only: 'off' }] });
    if (kind === 'publication') f.dependencies.readAuthority = async () => ({ ...publication, expectedDefinitionHash: 'c'.repeat(64) });
    if (kind === 'actor') f.dependencies.readAuthority = async () => { throw Object.assign(Error('Private detail'), { code: 'ACTOR_NOT_ACTIVE' }); };
    assert.equal(await classify.main(args(f), f.dependencies), 1);
    assert.equal(f.calls.length, 0);
    assert.equal(f.errors.length, 1);
    assert.ok(!JSON.stringify(f.errors).includes('Private detail'));
    await assert.rejects(fs.stat(path.join(f.output, 'manifest.json')), { code: 'ENOENT' });
  });
});

test('known per-SKU read failure is recorded as review and does not skip later candidates', async t => {
  const f = await fixture(t, [candidate(1), candidate(2)]), preview = f.runtime.preview;
  f.runtime.preview = async (...params) => {
    if (params[1].sku === 'SV-1') throw Object.assign(Error('Private network address'), { code: 'ECONNRESET' });
    return preview(...params);
  };
  assert.equal(await classify.main(args(f), f.dependencies), 2);
  const manifest = await json(path.join(f.output, 'manifest.json')), records = await journal(f);
  const rows = records.filter(record => record.kind === 'result');
  assert.equal(manifest.complete, true);
  assert.equal(manifest.checked, 2);
  assert.equal(rows[0].route, 'review');
  assert.equal(rows[1].route, 'ordinary');
  assert.ok(!JSON.stringify(records).includes('Private network address'));
});

test('late authority change invalidates prior classifications and publishes no usable subsets', async t => {
  const f = await fixture(t, [candidate(1), candidate(2)]); let reads = 0;
  f.dependencies.readAuthority = async () => ++reads === 4 ? { ...publication, publicationHash: 'c'.repeat(64) } : clone(publication);
  assert.equal(await classify.main(args(f), f.dependencies), 2);
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.complete, false);
  assert.ok(manifest.globalFailure);
  assert.deepEqual((await fs.readdir(f.output)).sort(), ['manifest.json', 'results.jsonl', 'scope.json']);
});

test('exclusive output retains completed evidence byte for byte on retry', async t => {
  const f = await fixture(t);
  assert.equal(await classify.main(args(f), f.dependencies), 0);
  const names = await fs.readdir(f.output), before = new Map();
  for (const name of names) before.set(name, await fs.readFile(path.join(f.output, name)));
  const reads = f.calls.length;
  assert.equal(await classify.main(args(f), f.dependencies), 1);
  assert.equal(f.calls.length, reads);
  assert.deepEqual(await fs.readdir(f.output), names);
  for (const name of names) assert.deepEqual(await fs.readFile(path.join(f.output, name)), before.get(name));
});

test('completed manifest seals disjoint subsets for all five routes with exact reusable history/name scope', async t => {
  const f = await fixture(t, Array.from({ length: 5 }, (_, n) => candidate(n + 1)));
  historyScenario(f.scenarios[1]); namesScenario(f.scenarios[2]); createScenario(f.scenarios[3]);
  f.scenarios[4].base.mode = f.scenarios[4].base.first.mode = 'first';
  assert.equal(await classify.main(args(f), f.dependencies), 2);
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.globalFailure, null);
  assert.deepEqual(manifest.counts, { ordinary: 1, history: 1, initial_names: 1, create: 1, review: 1 });
  assert.equal(manifest.subsets.length, 5);
  const seen = [];
  for (const descriptor of manifest.subsets) {
    const bytes = await fs.readFile(path.join(f.output, descriptor.file)), subset = JSON.parse(bytes);
    assert.equal(descriptor.sha256, rawHash(bytes));
    assert.equal(descriptor.count, subset.items.length);
    assert.equal(subset.bindingRevisionId, binding);
    assert.equal(subset.expectedDefinitionHash, definitionHash);
    assert.equal(subset.installationKey, 'amber');
    seen.push(...subset.items.map(item => item.sku));
    if (descriptor.route === 'history') {
      require('../scripts/first-sync-history-batch').validateInput(subset, f.runtime);
      assert.deepEqual(subset.items, [{ sku: 'SV-2', productId: 2, remoteProductId: 1002 }]);
    } else if (descriptor.route === 'initial_names') {
      require('../scripts/first-sync-initial-name-plan').validateScope(subset, f.runtime);
      assert.equal(subset.choice, 'magento');
      assert.deepEqual(subset.items, [{ sku: 'SV-3', productId: 3, remoteProductId: 1003 }]);
    } else {
      assert.equal(subset.requiresFreshActionPreview, true);
      assert.equal(Object.hasOwn(subset, 'choices'), false);
    }
  }
  assert.deepEqual(seen.sort(), f.scenarios.map(s => s.item.sku).sort());
  assert.equal(new Set(seen).size, 5);
  assert.equal((await fs.readdir(f.output)).includes('incomplete'), false);
});

test('scope mutation after the last SKU invalidates results without publishing subsets', async t => {
  const f = await fixture(t), original = f.runtime.readSnapshot;
  f.runtime.readSnapshot = async (...params) => {
    const snapshot = await original(...params);
    await fs.writeFile(f.input, JSON.stringify(inputFor([candidate(2)])));
    return snapshot;
  };
  assert.equal(await classify.main(args(f), f.dependencies), 2);
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.complete, false);
  assert.equal(manifest.globalFailure, 'CLASSIFY_SCOPE_CHANGED_DURING_READ');
  assert.deepEqual(manifest.subsets, []);
  assert.deepEqual((await fs.readdir(f.output)).sort(), ['manifest.json', 'results.jsonl', 'scope.json']);
});

test('observed publication drift and permission failures invalidate previously classified rows', async t => {
  for (const failure of ['publication', 'permission']) await t.test(failure, async t => {
    const f = await fixture(t, [candidate(1), candidate(2), candidate(3)]);
    if (failure === 'publication') f.scenarios[1].observation.amber.revision.id = '22222222-2222-4222-8222-222222222222';
    else {
      const preview = f.runtime.preview;
      f.runtime.preview = async (...params) => {
        if (params[1].sku === 'SV-2') throw Object.assign(Error('Private authorization detail'), { code: 'FORBIDDEN', statusCode: 403 });
        return preview(...params);
      };
    }
    assert.equal(await classify.main(args(f), f.dependencies), 2);
    const manifest = await json(path.join(f.output, 'manifest.json'));
    assert.equal(manifest.complete, false);
    assert.equal(manifest.checked, 2);
    assert.equal(manifest.notChecked, 1);
    assert.ok(manifest.globalFailure);
    assert.deepEqual(manifest.subsets, []);
    assert.ok(!JSON.stringify(await journal(f)).includes('Private authorization detail'));
  });
});

test('final publication recheck occurs before any subsets are created', async t => {
  const f = await fixture(t); let reads = 0;
  f.dependencies.readAuthority = async () => ++reads === 4 ? { ...publication, publicationHash: 'c'.repeat(64) } : clone(publication);
  assert.equal(await classify.main(args(f), f.dependencies), 2);
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.checked, 1);
  assert.equal(manifest.complete, false);
  assert.deepEqual(manifest.subsets, []);
});

test('row fsync failure leaves incomplete marker, no manifest, and never advances to another SKU', async t => {
  const f = await fixture(t, [candidate(1), candidate(2)]); let syncs = 0;
  f.dependencies.io = { ...fs, open: async (...params) => {
    const handle = await fs.open(...params);
    if (path.basename(params[0]) !== 'results.jsonl') return handle;
    return { stat: handle.stat.bind(handle), write: handle.write.bind(handle), close: handle.close.bind(handle),
      sync: async () => {
        if (++syncs === 2) throw Object.assign(Error('Private disk detail'), { code: 'EIO' });
        await handle.sync();
      } };
  } };
  assert.equal(await classify.main(args(f), f.dependencies), 1);
  assert.deepEqual(f.calls.filter(call => call.stage === 'preview').map(call => call.sku), ['SV-1']);
  assert.deepEqual((await fs.readdir(f.output)).sort(), ['incomplete', 'results.jsonl', 'scope.json']);
  assert.equal(f.errors[0].incompleteMarkerRequired, true);
  assert.equal(f.errors[0].sealed, false);
  assert.ok(!JSON.stringify(f.errors).includes('Private disk detail'));
});

test('subset output failure cannot leave a usable manifest or erase incomplete marker', async t => {
  const f = await fixture(t);
  f.dependencies.io = { ...fs, open: async (...params) => {
    if (path.basename(params[0]) === 'ordinary-scope.json') throw Object.assign(Error('No space'), { code: 'ENOSPC' });
    return fs.open(...params);
  } };
  assert.equal(await classify.main(args(f), f.dependencies), 1);
  assert.deepEqual((await fs.readdir(f.output)).sort(), ['incomplete', 'results.jsonl', 'scope.json']);
  assert.equal(f.errors[0].incompleteMarkerRequired, true);
  assert.equal(f.errors[0].sealed, false);
});

test('failure after the final marker unlink restores incomplete despite a readable complete manifest', async t => {
  const f = await fixture(t); let removed = false;
  f.dependencies.io = { ...fs, unlink: async file => {
    assert.equal(path.basename(file), 'incomplete');
    await fs.unlink(file);
    removed = true;
    throw Object.assign(Error('Private final directory durability detail'), { code: 'EIO' });
  } };
  assert.equal(await classify.main(args(f), f.dependencies), 1);
  assert.equal(removed, true);
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.complete, true);
  assert.equal(manifest.globalFailure, null);
  assert.ok(manifest.subsets.length > 0);
  assert.equal((await json(path.join(f.output, 'incomplete'))).complete, false);
  assert.equal(f.errors[0].code, 'EIO');
  assert.equal(f.errors[0].sealed, false);
  assert.equal(f.errors[0].incompleteMarkerRequired, true);
  assert.ok(!JSON.stringify(f.errors).includes('Private final directory durability detail'));
});

test('SIGINT checkpoints the current row, stops the slice and removes only its own listeners', async t => {
  const f = await fixture(t, [candidate(1), candidate(2)]), preview = f.runtime.preview;
  const before = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
  f.runtime.preview = async (...params) => {
    const report = await preview(...params);
    process.emit('SIGINT');
    return report;
  };
  assert.equal(await classify.main(args(f), f.dependencies), 2);
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.checked, 1);
  assert.equal(manifest.notChecked, 1);
  assert.equal(manifest.complete, false);
  assert.equal(manifest.globalFailure, 'CLASSIFY_INTERRUPTED');
  assert.deepEqual(manifest.subsets, []);
  assert.equal(process.listenerCount('SIGINT'), before.SIGINT);
  assert.equal(process.listenerCount('SIGTERM'), before.SIGTERM);
});

test('oversized input and out-of-range offset fail before opening the output', async t => {
  for (const kind of ['size', 'offset']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'size') await fs.writeFile(f.input, Buffer.alloc(4 * 1024 * 1024 + 1, 32));
    assert.equal(await classify.main([...args(f), ...(kind === 'offset' ? ['--offset', '1'] : [])], f.dependencies), 1);
    assert.equal(f.calls.length, 0);
    await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  });
});

test('inspection and final reread errors preserve already verified observed identity without inventing readiness', async t => {
  for (const stage of ['inspect', 'snapshot']) await t.test(stage, async t => {
    const f = await fixture(t, [candidate(1), candidate(2)]);
    if (stage === 'inspect') {
      const original = f.runtime.first.inspect;
      f.runtime.first.inspect = async (...params) => {
        if (params[1].raw.sku === 'SV-1') throw Object.assign(Error('Private DB detail'), { code: 'ECONNRESET' });
        return original(...params);
      };
    } else {
      const original = f.runtime.readSnapshot;
      f.runtime.readSnapshot = async (...params) => {
        if (params[1].sku === 'SV-1') throw Object.assign(Error('Private DB detail'), { code: 'ECONNRESET' });
        return original(...params);
      };
    }
    assert.equal(await classify.main(args(f), f.dependencies), 2);
    const rows = (await journal(f)).filter(row => row.kind === 'result');
    assert.equal(rows[0].route, 'review');
    assert.equal(rows[0].expectedRemoteProductId, null);
    assert.equal(rows[0].observedRemoteProductId, 1001);
    assert.equal(rows[0].freshRemoteEquivalenceEstablished, false);
    assert.deepEqual(rows[0].sourceSnapshot, batch.source(f.scenarios[0].product));
    assert.equal(rows[1].route, 'ordinary');
    assert.ok(!JSON.stringify(rows).includes('Private DB detail'));
  });
});

test('in-place canonical observation mutation cannot rewrite the frozen source or lifecycle checkpoint', async t => {
  for (const changed of ['answers', 'exportState']) await t.test(changed, async () => {
    const s = scenario(), f = runtimeFor([s]), before = clone(batch.source(s.product));
    const expectedHash = c.hash(before), original = f.runtime.first.inspect;
    f.runtime.first.inspect = async (...params) => {
      assert.equal(params[1], s.observation, 'Canonical inspection must keep its original proof-owning observation');
      if (changed === 'answers') s.product.details.answers.weight = '99.900';
      else s.product.exportState.route = 'held';
      return original(...params);
    };
    const result = await classify.classifyItem(f.runtime, config, s.item, publication,
      { databasePool: {}, actorUserId: 7, installation: 'amber', sensitiveValues: [], fetchImpl: failWrite });
    assert.equal(result.route, 'review');
    assert.ok(result.blockers.some(blocker => blocker.code === 'CLASSIFY_SOURCE_CHANGED_DURING_READ'));
    assert.deepEqual(result.sourceSnapshot, before);
    assert.equal(result.sourceHash, expectedHash);
    assert.equal(c.hash(result.sourceSnapshot), expectedHash);
    assert.equal(result.sourceSnapshot.answers.weight, '12.4');
  });
});

test('duplicate freshly observed Magento IDs invalidate the full run before publishing history subsets', async t => {
  const f = await fixture(t, [candidate(1), candidate(2)]);
  f.scenarios[1].observation.raw.id = f.scenarios[0].observation.raw.id;
  f.scenarios[1].report.identity.observedMagentoId = f.scenarios[0].observation.raw.id;
  f.scenarios.forEach(historyScenario);
  assert.equal(await classify.main(args(f), f.dependencies), 2);
  const manifest = await json(path.join(f.output, 'manifest.json'));
  assert.equal(manifest.complete, false);
  assert.equal(manifest.globalFailure, 'CLASSIFY_DUPLICATE_OBSERVED_IDENTITY');
  assert.equal(manifest.checked, 2);
  assert.deepEqual(manifest.subsets, []);
  const rows = (await journal(f)).filter(row => row.kind === 'result');
  assert.deepEqual(rows.map(row => row.sku), ['SV-1', 'SV-2']);
  assert.ok(rows.every(row => row.route === 'history' && row.observedRemoteProductId === 1001));
  assert.deepEqual((await fs.readdir(f.output)).sort(), ['manifest.json', 'results.jsonl', 'scope.json']);
});
