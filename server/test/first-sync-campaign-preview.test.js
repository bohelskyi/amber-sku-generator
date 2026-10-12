'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const campaign = require('../scripts/first-sync-campaign-preview');
const c = require('../src/services/magento/binding-contract');
const batch = require('../src/services/magento/first-sync-batch-preflight');
const first = require('../src/services/magento/first-sync.service');
const normalize = require('../src/services/magento/first-sync-field-plan').normalizeDecimal;
const audit = require('../src/services/magento/binding-evidence-audit');

const binding = '11111111-1111-4111-8111-111111111111';
const definitionHash = 'a'.repeat(64);
const publication = { bindingRevisionId: binding, expectedDefinitionHash: definitionHash, publicationHash: 'b'.repeat(64) };
const config = { configured: true, baseUrl: 'https://campaign.example.invalid' };
const database = 'campaign_fixture_test';
const runtime = { c, batch, first, normalize, audit, pool: { databaseSecrets: () => [] } };
const clone = value => structuredClone(value);
const rawHash = value => crypto.createHash('sha256').update(value).digest('hex');
const field = (target = 'meta_title', scope = 'all', local = 'Amber title', remote = 'Magento title') => ({ target, scope, local, remote });
const candidate = (id = 1, fields = [field()], category = 'NM') => ({ sku: category + id, productId: id,
  category, remoteProductId: 1000 + id, fields });
const product = item => batch.source({ id: item.productId, public_product_identity_id: String(item.productId),
  full_sku: item.sku + '-internal', public_sku: item.sku, category: item.category, status: 'active',
  exclude_from_export: 0, weight: '12.400', total_price_uah: '1200.00', details: { answers: {} } });
const packetItem = item => ({ sku: item.sku, expectedProduct: item.expectedProduct || product(item),
  remoteProductId: item.remoteProductId || 1000 + item.productId,
  fields: item.fields.map(({ target, scope, local, remote }) => ({ target, scope, local, remote })) });
function historyRow(item, index = 0, legacySnapshotFlag = true) {
  const remoteProductId = item.remoteProductId || 1000 + item.productId;
  return { sku: item.sku, productId: item.productId, category: item.category, inputIndex: index, remoteProductId,
    status: 'blocked', mode: 'review', blockers: [{ code: 'DISCOVERY_FIRST_SYNC_REVIEW_REQUIRED' }],
    firstSyncBlockers: [{ code: 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED' }], ordinaryBlockers: [], remainingBlockers: [], changes: [],
    sourceSnapshot: item.expectedProduct || product(item), historyReviewAssessment: { status: 'available', legacySnapshotFlag,
      code: legacySnapshotFlag ? 'FIRST_SYNC_LEGACY_SNAPSHOT_FLAG_REVIEW_AVAILABLE' : 'FIRST_SYNC_CUTOVER_REVIEW_AVAILABLE' },
    historyReview: { scope: 'first_sync_review_only', sku: item.sku, remoteProductId, doesNotAcknowledgeExport: true,
      previewToken: definitionHash, ...(legacySnapshotFlag ? { legacySnapshotFlag: true } : {}) } };
}
const packet = items => ({ bindingRevisionId: binding, expectedDefinitionHash: definitionHash, items: items.map(packetItem) });
const descriptor = (value, index = 1) => ({ file: 'packet-' + String(index).padStart(4, '0') + '.json', sha256: c.hash(value), count: value.items.length });
function manifestFor(input, packets) {
  return { contract: 'first-sync-local-discovery-v1', readOnly: true, database, actorUserId: 7,
    installationKey: 'amber', inputSha256: c.hash(input), publication: clone(publication), offset: 0,
    selected: input.items.length, total: input.items.length, startedAt: '2026-10-12T00:00:00.000Z',
    requiresLocalBatchPreview: true, directRemoteWrites: 0, directlyEnqueuedJobs: 0, complete: true,
    globalFailure: null, finishedAt: '2026-10-12T00:01:00.000Z', packets: packets.map((p, i) => descriptor(p, i + 1)),
    checked: input.items.length, candidates: packets.reduce((n, p) => n + p.items.length, 0), blocked: 0,
    invalidatedCandidates: 0, noSelectedChange: 0, notChecked: 0, nextOffset: input.items.length, remainingInput: 0 };
}
function resultFor(item) {
  return { sku: item.sku, mode: 'first', status: 'first_sync_choices', blockers: [], remainingBlockers: [],
    readyForApply: true, readyForOutboundAfterChoices: true, initialImports: [], applyInput: { sku: item.sku,
      bindingRevisionId: binding, previewToken: definitionHash,
      choices: item.fields.map(f => ({ target: f.target, scope: f.scope, choice: 'keep_local' })) } };
}
function reportFor(request) {
  return { contract: 'first-sync-local-authority-batch-v1', readOnly: true, bindingRevisionId: binding,
    results: request.items.map(resultFor), counts: { total: request.items.length, readyForApply: request.items.length,
      blocked: 0, notChecked: 0, noChange: 0, ordinaryPreviewRequired: 0 }, execution: 'Synthetic canonical preflight' };
}
const nameImports = () => [
  { target: 'name', scope: 'all', before: { known: true, present: false, value: null }, after: 'Назва з Magento' },
  { target: 'name', scope: 'en', before: { known: true, present: false, value: null }, after: 'Magento English name' },
];
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function fixture(t, items = [candidate()]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-campaign-preview-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = { items }, packets = [];
  for (let i = 0; i < items.length; i += 10) packets.push(packet(items.slice(i, i + 10)));
  const manifest = manifestFor(input, packets), inputFile = path.join(dir, 'input.json');
  const discoveryDir = path.join(dir, 'discovery'), manifestFile = path.join(discoveryDir, 'manifest.json');
  const bytes = Buffer.from(JSON.stringify(input, null, 2) + '\n');
  await fs.writeFile(inputFile, bytes); await fs.mkdir(discoveryDir);
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  for (let i = 0; i < packets.length; i++) await fs.writeFile(path.join(discoveryDir, manifest.packets[i].file), JSON.stringify(packets[i]));
  const messages = [], errors = [], calls = [], authorities = [], queries = [];
  const output = path.join(dir, 'review');
  const cli = { input: inputFile, scopeHash: rawHash(bytes), manifest: manifestFile, output, database, actor: 7,
    installation: 'amber', serverRoot: path.join(__dirname, '..') };
  const dependencies = { runtime, config, env: {}, print: value => messages.push(JSON.parse(value)),
    printError: value => errors.push(JSON.parse(value)), readAuthority: async (...params) => { authorities.push(params); return clone(publication); },
    pool: { query: async sql => { queries.push(sql); assert.equal(sql, 'SELECT current_database() AS name'); return { rows: [{ name: database }] }; } },
    preflight: async (...params) => { calls.push(params); return reportFor(params[1]); } };
  const f = { dir, input, packets, manifest, discoveryDir, inputFile, manifestFile, output, cli, dependencies, messages,
    errors, calls, authorities, queries };
  await saveDiscoveryJournal(f); return f;
}
const args = f => ['--server-root', f.cli.serverRoot, '--input', f.inputFile, '--scope-sha256', f.cli.scopeHash,
  '--discovery-manifest', f.manifestFile, '--output-dir', f.output, '--expected-database', database,
  '--actor-id', '7', '--installation-key', 'amber'];
async function saveDiscoveryJournal(f) {
  const headerKeys = ['contract', 'readOnly', 'database', 'actorUserId', 'installationKey', 'inputSha256', 'publication',
    'offset', 'selected', 'total', 'startedAt', 'requiresLocalBatchPreview', 'directRemoteWrites', 'directlyEnqueuedJobs'];
  const header = Object.fromEntries(headerKeys.map(key => [key, f.manifest[key]]));
  const rows = f.discoveryResults || f.input.items.slice(f.manifest.offset, f.manifest.nextOffset).map((item, index) => {
    const selected = f.packets.flatMap(p => p.items).find(p => p.sku === item.sku);
    return { sku: item.sku, productId: item.productId, category: item.category, status: 'candidate',
      inputIndex: f.manifest.offset + index, remoteProductId: selected.remoteProductId, blockers: [], changes: [],
      ordinaryBlockers: [], firstSyncBlockers: [], mode: 'first', requiresLocalBatchPreview: true,
      observedAt: '2026-10-12T00:00:30.000Z', sourceSnapshot: selected.expectedProduct, packetItem: selected };
  });
  const journal = [{ kind: 'start', ...header }, ...rows.map(row => ({ kind: 'result', ...row })), { kind: 'complete', ...f.manifest }];
  await fs.writeFile(path.join(f.discoveryDir, 'results.jsonl'), journal.map(row => JSON.stringify(row)).join('\n') + '\n');
}
async function saveManifest(f) { await fs.writeFile(f.manifestFile, JSON.stringify(f.manifest)); await saveDiscoveryJournal(f); }
async function savePacket(f, index = 0, rehash = true) {
  if (rehash) f.manifest.packets[index] = descriptor(f.packets[index], index + 1);
  await fs.writeFile(path.join(f.discoveryDir, f.manifest.packets[index].file), JSON.stringify(f.packets[index]));
  await saveManifest(f);
}
async function historyFixture(t, items = [candidate()]) {
  const f = await fixture(t, items);
  f.packets = []; f.manifest.packets = []; f.manifest.candidates = 0; f.manifest.blocked = items.length;
  f.discoveryResults = items.map((item, index) => historyRow(item, index));
  await saveManifest(f); return f;
}
const validate = (f, p = f.packets[0], d = f.manifest.packets[0], seen = new Set()) =>
  campaign.validatePacket(p, d, f.manifest, f.input, runtime, seen);

test('runtime resolves the existing canonical preflight without starting it', () => {
  const actual = campaign.createRuntime(path.join(__dirname, '..'));
  assert.equal(actual.batch, batch); assert.equal(actual.first, first);
});

test('strict CLI has no mutation mode and help loads no runtime or database', async t => {
  const f = await fixture(t), parsed = campaign.argumentsFor(args(f));
  assert.equal(parsed.actor, 7); assert.equal(parsed.scopeHash, f.cli.scopeHash);
  for (const bad of [[], ['--apply'], [...args(f), '--mode', 'apply'], [...args(f), '--actor-id', '7'],
    args(f).filter((_, i) => i !== 5), [...args(f).slice(0, -2), '--installation-key', ''],
    args(f).map(x => x === f.cli.scopeHash ? 'A'.repeat(64) : x)]) assert.throws(() => campaign.argumentsFor(bad));
  const lines = [], deps = { print: line => lines.push(line) };
  for (const key of ['runtime', 'pool', 'config']) Object.defineProperty(deps, key, { get() { assert.fail('Help accessed ' + key); } });
  assert.equal(await campaign.main(['--help'], deps), 0); assert.equal(lines.length, 1);
});

test('strict candidates retain approved policies and reject duplicate or sparse identities and unknown fields', () => {
  const input = { items: [candidate(1, [field('price', 'all', '1200.00', 1500), field('decor_weight', 'all', '12.4', 12), field()])] };
  input.items[0].fields[0].policy = 'manager_price'; input.items[0].fields[1].policy = 'manager_weight_rounding';
  input.items[0].fields[2].policy = 'amber_seo';
  assert.doesNotThrow(() => campaign.validateInput(input, runtime));
  const changes = [v => { v.items.push(clone(v.items[0])); }, v => { v.items.push({ ...candidate(2), productId: 1 }); },
    v => { v.items = Array(1); }, v => { v.items[0].fields = Array(1); }, v => { v.items[0].fields[0].policy = 'accept_remote'; },
    v => { v.items[0].fields[0].target = 'media_gallery'; }, v => { v.items[0].fields[0].scope = 'en'; },
    v => { v.items[0].fields.push(clone(v.items[0].fields[0])); }, v => { v.items[0].sku = ' NM1'; },
    v => { v.items[0].productId = '1'; }, v => { v.items[0].remoteProductId = '1001'; },
    v => { v.items[0].fields[0].local = {}; }, v => { v.items[0].unexpected = true; }, v => { v.bindingRevisionId = binding; }];
  for (const change of changes) { const value = clone(input); change(value); assert.throws(() => campaign.validateInput(value, runtime)); }
  assert.throws(() => campaign.validateInput({ items: Array.from({ length: 2001 }, (_, i) => candidate(i + 1)) }, runtime));
});

test('discovery completion, actor, database, installation and exact original input hash are required', async t => {
  const f = await fixture(t);
  assert.doesNotThrow(() => campaign.validateDiscoveryManifest(f.manifest, f.input, f.cli, runtime));
  for (const [key, value] of Object.entries({ complete: false, readOnly: false, globalFailure: 'ACTOR_NOT_ACTIVE',
    actorUserId: 8, database: 'other_test', installationKey: 'other', inputSha256: 'f'.repeat(64),
    invalidatedCandidates: 1, notChecked: 1, directRemoteWrites: 1, directlyEnqueuedJobs: 1 })) {
    const manifest = { ...clone(f.manifest), [key]: value };
    assert.throws(() => campaign.validateDiscoveryManifest(manifest, f.input, f.cli, runtime), key);
  }
  for (const value of [{ file: '../packet.json', sha256: f.manifest.packets[0].sha256, count: 1 },
    { file: '/tmp/packet.json', sha256: f.manifest.packets[0].sha256, count: 1 },
    { ...f.manifest.packets[0], count: 11 }, { ...f.manifest.packets[0], sha256: 'wrong' }]) {
    const manifest = { ...clone(f.manifest), packets: [value] };
    assert.throws(() => campaign.validateDiscoveryManifest(manifest, f.input, f.cli, runtime));
  }
  const repeated = { ...clone(f.manifest), packets: [clone(f.manifest.packets[0]), clone(f.manifest.packets[0])] };
  assert.throws(() => campaign.validateDiscoveryManifest(repeated, f.input, f.cli, runtime));
});

test('a completed discovery slice owns only its exact original input positions', async t => {
  const f = await fixture(t, [candidate(1), candidate(2), candidate(3)]);
  const scoped = packet([f.input.items[1]]);
  f.manifest = { ...f.manifest, offset: 1, selected: 1, checked: 1, nextOffset: 2, remainingInput: 1,
    candidates: 1, packets: [descriptor(scoped)] };
  assert.doesNotThrow(() => campaign.validateDiscoveryManifest(f.manifest, f.input, f.cli, runtime));
  assert.doesNotThrow(() => validate(f, scoped, descriptor(scoped)));
  const outside = packet([f.input.items[0]]);
  assert.throws(() => validate(f, outside, descriptor(outside)));
});

test('packet ownership seals exact SKU, source product, category, remote identity and every selected field', async t => {
  const f = await fixture(t, [candidate(1, [field(), field('meta_title', 'en', 'English Amber', 'English Magento')])]);
  assert.doesNotThrow(() => validate(f));
  const changes = [p => { p.items[0].sku = 'NM2'; }, p => { p.items[0].expectedProduct.id = 2; },
    p => { p.items[0].expectedProduct.category = 'SV'; }, p => { p.items[0].expectedProduct.public_sku = 'NM2'; },
    p => { p.items[0].remoteProductId++; }, p => { p.items[0].fields[0].local += ' changed'; },
    p => { p.items[0].fields[1].remote += ' changed'; }, p => { p.items[0].fields.pop(); },
    p => { p.items[0].fields.push(field('meta_description')); }, p => { p.expectedDefinitionHash = 'c'.repeat(64); },
    p => { p.bindingRevisionId = '22222222-2222-4222-8222-222222222222'; }];
  for (const [index, change] of changes.entries()) { const p = clone(f.packets[0]); change(p);
    assert.throws(() => validate(f, p, descriptor(p)), 'Ownership mutation ' + index); }
  const seen = new Set(); validate(f, f.packets[0], f.manifest.packets[0], seen);
  assert.throws(() => validate(f, f.packets[0], f.manifest.packets[0], seen));
  const extra = clone(f.packets[0]); extra.items[0].expectedProduct.unowned = true;
  assert.throws(() => validate(f, extra, descriptor(extra)));
});

test('frozen expectedProduct is exact while numeric field formatting uses canonical decimal equivalence', async t => {
  const item = candidate(1, [field('price', 'all', '1200.00', 1500), field('decor_weight', 'all', '12,400', 12)]);
  item.expectedProduct = product(item);
  const f = await fixture(t, [item]), value = clone(f.packets[0]);
  value.items[0].fields[0].local = 1200; value.items[0].fields[0].remote = '1500.000';
  value.items[0].fields[1].local = '12.4'; value.items[0].fields[1].remote = '12.000';
  assert.doesNotThrow(() => validate(f, value, descriptor(value)));
  value.items[0].expectedProduct.total_price_uah = '1201.00';
  assert.throws(() => validate(f, value, descriptor(value)));
});

test('discovery may omit a frozen field whose local and remote values were already equal', async t => {
  const f = await fixture(t, [candidate(1, [field(), field('price', 'all', '1200.00', 1200)])]);
  const narrowed = clone(f.packets[0]); narrowed.items[0].fields.pop();
  assert.doesNotThrow(() => validate(f, narrowed, descriptor(narrowed)));
});

test('canonical readiness alone never selects imports, remaining blockers or malformed choices', async t => {
  const request = packet([candidate()]);
  const baseline = reportFor(request), accepted = campaign.selectReport(baseline, request, runtime);
  assert.equal(accepted.selections.length, 1); assert.equal(accepted.selections[0].sku, 'NM1');
  assert.deepEqual(accepted.selections[0].applyInput, baseline.results[0].applyInput);
  assert.equal(accepted.selections[0].commandSha256, c.hash(baseline.results[0].applyInput));
  const changes = {
    imports: r => { r.results[0].initialImports = [{ target: 'name', scope: 'all', before: '', after: 'Imported' }]; },
    remaining: r => { r.results[0].remainingBlockers = [{ code: 'HISTORY_REQUIRED' }]; },
    blocked: r => { r.results[0].blockers = [{ code: 'BATCH_PRODUCT_CHANGED' }]; },
    notOutboundReady: r => { r.results[0].readyForOutboundAfterChoices = false; },
    notReady: r => { r.results[0].readyForApply = false; },
    remote: r => { r.results[0].applyInput.choices[0].choice = 'accept_remote'; },
    unowned: r => { r.results[0].applyInput.choices[0].target = 'meta_description'; },
    wrongSku: r => { r.results[0].applyInput.sku = 'NM2'; },
    wrongBinding: r => { r.results[0].applyInput.bindingRevisionId = '22222222-2222-4222-8222-222222222222'; },
    malformedToken: r => { r.results[0].applyInput.previewToken = 'abc'; },
    noImportsProof: r => { delete r.results[0].initialImports; },
    noRemainingProof: r => { delete r.results[0].remainingBlockers; },
  };
  for (const [label, change] of Object.entries(changes)) await t.test(label, () => {
    const report = clone(baseline); change(report);
    let selected;
    try { selected = campaign.selectReport(report, request, runtime); }
    catch (e) { assert.ok(e.code); return; }
    assert.equal(selected.selections.length, 0);
  });
  assert.deepEqual(baseline, reportFor(request));
});

test('report contract cannot substitute another SKU, publication, result count or duplicate result', () => {
  const request = packet([candidate(1), candidate(2)]), baseline = reportFor(request);
  const changes = [r => { r.readOnly = false; }, r => { r.contract = 'other'; }, r => { r.results.reverse(); },
    r => { r.bindingRevisionId = '22222222-2222-4222-8222-222222222222'; }, r => { r.results.pop(); },
    r => { r.results[1] = clone(r.results[0]); }];
  for (const change of changes) { const report = clone(baseline); change(report); assert.throws(() => campaign.selectReport(report, request, runtime)); }
});

test('exception groups retain exact reasons and field scopes while counting unique SKUs', () => {
  const common = { code: 'BATCH_FIELD_CHANGED', target: 'meta_title', scope: 'all' };
  const rows = [{ sku: 'NM1', ...common }, { sku: 'NM1', ...common }, { sku: 'NM2', ...common },
    { sku: 'NM1', ...common, scope: 'en' }, { sku: 'NM3', code: 'HISTORY_REQUIRED', reason: 'Unconfirmed exposure' }];
  assert.deepEqual(campaign.groupExceptions(rows), [
    { ...common, count: 2, skus: ['NM1', 'NM2'] },
    { ...common, scope: 'en', count: 1, skus: ['NM1'] },
    { code: 'HISTORY_REQUIRED', reason: 'Unconfirmed exposure', count: 1, skus: ['NM3'] },
  ]);
});

test('authority fence uses its own repeatable-read read-only transaction and exact active Administrator checks', async () => {
  const queries = [], calls = [], options = { actorUserId: 7, installation: 'amber' };
  const revision = { id: binding, state: 'published', installationKey: 'amber', definitionHash,
    originHash: c.originHash(config.baseUrl), schema: { storeCode: 'all' } };
  const client = { query: async (sql, values) => { queries.push(sql);
    if (sql.startsWith('SELECT')) { assert.deepEqual(values, ['amber']); return { rows: [{ id: binding }] }; }
    return { rows: [] }; }, release: () => calls.push('release') };
  options.databasePool = { connect: async () => client };
  const authorityRuntime = { c,
    access: { assertActorStillAuthorized: async (...params) => { calls.push('access'); assert.equal(params[0], client);
      assert.equal(params[1], 7); assert.equal(params[2], 'export_templates.publish'); assert.deepEqual(params[4], { readOnly: true }); } },
    publication: { administrator: async (selectedClient, actor) => { calls.push('administrator'); assert.equal(selectedClient, client); assert.equal(actor, 7); } },
    gate: { readGate: async selectedClient => { assert.equal(selectedClient, client); return { phase: 'active' }; } },
    bindings: { readRevisionOnClient: async (selectedClient, id) => { assert.equal(selectedClient, client); assert.equal(id, binding); return revision; } } };
  assert.deepEqual(await campaign.readAuthority(authorityRuntime, config, options), {
    bindingRevisionId: binding, expectedDefinitionHash: definitionHash, publicationHash: c.hash(revision) });
  assert.equal(queries[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(queries.at(-1), 'COMMIT'); assert.deepEqual(calls, ['access', 'administrator', 'release']);
  assert.ok(queries.every(sql => /^(BEGIN|SELECT|COMMIT)$/.test(sql.split(' ')[0])));
  queries.length = 0; calls.length = 0;
  authorityRuntime.gate.readGate = async () => ({ phase: 'preparing' });
  await assert.rejects(campaign.readAuthority(authorityRuntime, config, options), { code: 'EXPORT_CUTOVER_PREPARING' });
  assert.equal(queries.at(-1), 'ROLLBACK'); assert.equal(calls.at(-1), 'release');
});

test('campaign preflights packets sequentially and retains untouched request/report plus bounded plan hashes', async t => {
  const f = await fixture(t, Array.from({ length: 21 }, (_, i) => candidate(i + 1)));
  let active = false;
  const returned = [];
  f.dependencies.preflight = async (cfg, request, run) => {
    assert.equal(active, false); active = true; assert.equal(cfg, config);
    assert.equal(run.databasePool, f.dependencies.pool); assert.equal(run.actorUserId, 7);
    assert.equal(run.installation, 'amber'); assert.ok(request.items.length <= 10);
    assert.deepEqual(request, f.packets[f.calls.length]);
    if (f.calls.length) {
      const lines = (await fs.readFile(path.join(f.output, 'results.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.ok(lines.length >= f.calls.length + 1);
    }
    f.calls.push([cfg, clone(request), run]); await new Promise(resolve => setImmediate(resolve));
    const report = reportFor(request); returned.push(clone(report)); active = false; return report;
  };
  assert.equal(await campaign.main(args(f), f.dependencies), 0, JSON.stringify(f.errors));
  const review = await json(path.join(f.output, 'review.json'));
  assert.equal(review.contract, 'first-sync-campaign-review-v1'); assert.equal(review.complete, true);
  assert.equal(review.readOnly, true); assert.equal(review.globalFailure, null);
  assert.deepEqual(review.plans.map(p => p.count), [10, 10, 1]);
  assert.deepEqual(review.plans.map(p => p.selectedCount), [10, 10, 1]);
  assert.deepEqual(f.calls.map(call => call[1].items.map(i => i.sku)), f.packets.map(p => p.items.map(i => i.sku)));
  for (let i = 0; i < review.plans.length; i++) {
    const info = review.plans[i], plan = await json(path.join(f.output, info.file));
    assert.equal(plan.contract, 'first-sync-campaign-packet-review-v1'); assert.equal(c.hash(plan), info.sha256);
    assert.deepEqual(plan.request, f.packets[i]); assert.deepEqual(plan.report, returned[i]);
    assert.ok(plan.selections.length <= 10);
  }
  assert.deepEqual(review.publication, publication); assert.equal(review.scopeSha256, f.cli.scopeHash);
  assert.equal(review.inputSha256, c.hash(f.input));
  assert.equal(review.discoveryManifestSha256, rawHash(await fs.readFile(f.manifestFile)));
});

test('changed raw scope, packet digest and later packet ownership fail before any preflight or output', async t => {
  for (const kind of ['rawBytes', 'packetHash', 'secondPacketOwnership']) await t.test(kind, async t => {
    const f = await fixture(t, Array.from({ length: 11 }, (_, i) => candidate(i + 1)));
    if (kind === 'rawBytes') await fs.appendFile(f.inputFile, '\n');
    if (kind === 'packetHash') { f.packets[0].items[0].fields[0].remote += ' changed'; await savePacket(f, 0, false); }
    if (kind === 'secondPacketOwnership') { f.packets[1].items[0].expectedProduct.category = 'SV'; await savePacket(f, 1); }
    assert.equal(await campaign.main(args(f), f.dependencies), 1);
    assert.equal(f.calls.length, 0); await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  });
});

test('discovery journal must match start authority, complete manifest, exact input indices and candidate packets', async t => {
  const changes = {
    start: rows => { rows[0].actorUserId = 8; },
    complete: rows => { rows.at(-1).candidates = 0; },
    index: rows => { rows[1].inputIndex = 1; },
    candidateHash: rows => { rows[1].packetItem.fields[0].local += ' forged'; },
    duplicateIdentity: rows => { rows[2].sku = rows[1].sku; },
    missingResult: rows => { rows.splice(1, 1); },
    statusCounts: rows => { rows[1].status = 'blocked'; rows[1].blockers = [{ code: 'HISTORY_REQUIRED' }]; delete rows[1].packetItem; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
    const f = await fixture(t, [candidate(1), candidate(2)]), file = path.join(f.discoveryDir, 'results.jsonl');
    const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse); change(rows);
    await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    assert.equal(await campaign.main(args(f), f.dependencies), 1, JSON.stringify(f.errors));
    assert.equal(f.calls.length, 0); await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
  });
});

test('discovery blockers and available history review remain visible even though only candidates are preflighted', async t => {
  const f = await fixture(t, [candidate(1), candidate(2), candidate(3)]);
  const rows = (await fs.readFile(path.join(f.discoveryDir, 'results.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    .filter(row => row.kind === 'result').map(({ kind: _kind, ...row }) => row);
  rows[1] = historyRow(f.input.items[1], 1);
  rows[2].status = 'no_selected_change'; delete rows[2].packetItem;
  f.discoveryResults = rows; f.packets = [packet([f.input.items[0]])];
  f.manifest.packets = [descriptor(f.packets[0])]; f.manifest.candidates = 1; f.manifest.blocked = 1; f.manifest.noSelectedChange = 1;
  await savePacket(f);
  assert.equal(await campaign.main(args(f), f.dependencies), 2, JSON.stringify(f.errors));
  const review = await json(path.join(f.output, 'review.json'));
  assert.equal(review.complete, true); assert.equal(review.counts.discoveryBlocked, 1);
  assert.equal(review.counts.discoveryHistoryReviewAvailable, 1);
  assert.equal(review.counts.discoveryNoSelectedChange, 1); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][1].items.map(item => item.sku), ['NM1']);
  assert.ok(review.exceptions.some(group => group.skus.includes('NM2') && group.code === 'DISCOVERY_FIRST_SYNC_REVIEW_REQUIRED'));
  assert.ok(review.exceptions.some(group => group.skus.includes('NM2') && group.code === 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED'));
  await assert.doesNotReject(campaign.loadReview(f.output, rawHash(await fs.readFile(path.join(f.output, 'review.json'))), runtime, f.cli));
});

test('derived history scope contains only exact legacy-flag candidates in original input order', async t => {
  const f = await historyFixture(t, [candidate(9), candidate(2), candidate(7, [field()], 'SV')]);
  f.discoveryResults[1] = historyRow(f.input.items[1], 1, false);
  assert.deepEqual(campaign.deriveHistoryScope(f.discoveryResults, f.manifest, f.input, runtime), {
    bindingRevisionId: binding, expectedDefinitionHash: definitionHash, installationKey: 'amber',
    items: [{ sku: 'NM9', productId: 9, remoteProductId: 1009 }, { sku: 'SV7', productId: 7, remoteProductId: 1007 }],
  });
  const nullable = clone(f.input); nullable.items[0].remoteProductId = null;
  assert.equal(campaign.deriveHistoryScope(f.discoveryResults, f.manifest, nullable, runtime).items[0].remoteProductId, 1009);
});

test('every history proof, blocker, source and exact-identity guard excludes malformed or unauthorized rows', async t => {
  const f = await historyFixture(t);
  const changes = {
    notBlocked: r => { r.status = 'no_selected_change'; },
    wrongMode: r => { r.mode = 'first'; },
    rowIdDrift: r => { r.productId = 2; },
    rowSkuDrift: r => { r.sku = 'NM2'; },
    rowCategoryDrift: r => { r.category = 'SV'; },
    wrongDiscoveryBlocker: r => { r.blockers[0].code = 'OTHER_BLOCKER'; },
    extraDiscoveryBlocker: r => { r.blockers.push({ code: 'OTHER_BLOCKER' }); },
    discoveryBlockerExtraKey: r => { r.blockers[0].reason = 'extra'; },
    wrongHistoryBlocker: r => { r.firstSyncBlockers[0].code = 'OTHER_BLOCKER'; },
    extraHistoryBlocker: r => { r.firstSyncBlockers.push({ code: 'OTHER_BLOCKER' }); },
    historyBlockerExtraKey: r => { r.firstSyncBlockers[0].target = 'price'; },
    ordinaryBlocker: r => { r.ordinaryBlockers = [{ code: 'PAYLOAD_UNREADY' }]; },
    missingOrdinaryProof: r => { delete r.ordinaryBlockers; },
    remainingBlocker: r => { r.remainingBlockers = [{ code: 'OTHER_BLOCKER' }]; },
    malformedRemaining: r => { r.remainingBlockers = null; },
    changedFacts: r => { r.changes = [{ target: 'price' }]; },
    malformedChanges: r => { r.changes = {}; },
    proposedAssessment: r => { r.historyReviewAssessment.status = 'proposed'; },
    missingLegacyAssessment: r => { delete r.historyReviewAssessment.legacySnapshotFlag; },
    stringLegacyAssessment: r => { r.historyReviewAssessment.legacySnapshotFlag = 'true'; },
    nonLegacyAssessment: r => { r.historyReviewAssessment.legacySnapshotFlag = false;
      r.historyReviewAssessment.code = 'FIRST_SYNC_CUTOVER_REVIEW_AVAILABLE'; delete r.historyReview.legacySnapshotFlag; },
    wrongAssessmentCode: r => { r.historyReviewAssessment.code = 'FIRST_SYNC_CUTOVER_REVIEW_AVAILABLE'; },
    assessmentExtraKey: r => { r.historyReviewAssessment.unapproved = true; },
    reviewExtraKey: r => { r.historyReview.unapproved = true; },
    wrongScope: r => { r.historyReview.scope = 'full_sync'; },
    wrongReviewSku: r => { r.historyReview.sku = 'NM2'; },
    wrongReviewIdentity: r => { r.historyReview.remoteProductId = 1002; },
    exportAcknowledgment: r => { r.historyReview.doesNotAcknowledgeExport = false; },
    stringAcknowledgment: r => { r.historyReview.doesNotAcknowledgeExport = 'true'; },
    malformedPreviewToken: r => { r.historyReview.previewToken = 'not-a-token'; },
    missingLegacyReview: r => { delete r.historyReview.legacySnapshotFlag; },
    falseLegacyReview: r => { r.historyReview.legacySnapshotFlag = false; },
    noObservedIdentity: r => { r.remoteProductId = 0; },
    unsafeObservedIdentity: r => { r.remoteProductId = Number.MAX_SAFE_INTEGER + 1; },
    frozenRemoteIdentityDrift: r => { r.remoteProductId = 1002; r.historyReview.remoteProductId = 1002; },
    sourceIdDrift: r => { r.sourceSnapshot.id = 2; },
    sourceSkuDrift: r => { r.sourceSnapshot.public_sku = 'NM2'; },
    sourceCategoryDrift: r => { r.sourceSnapshot.category = 'SV'; },
    sourceRetired: r => { r.sourceSnapshot.status = 'retired'; },
    sourceExcluded: r => { r.sourceSnapshot.exclude_from_export = 1; },
    sourceUnknownExclusion: r => { r.sourceSnapshot.exclude_from_export = null; },
    sourceFalseExclusion: r => { r.sourceSnapshot.exclude_from_export = false; },
    sourceCorrected: r => { r.sourceSnapshot.corrected_to_product_id = 2; },
    sourceUnknownCorrection: r => { r.sourceSnapshot.corrected_to_product_id = undefined; },
    sourceMissingKey: r => { delete r.sourceSnapshot.answers; },
    sourceExtraKey: r => { r.sourceSnapshot.unapproved = true; },
    frozenSourceDrift: r => { r.sourceSnapshot.total_price_uah = '1201.00'; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const input = clone(f.input), rows = clone(f.discoveryResults); change(rows[0]);
    if (name === 'frozenSourceDrift') input.items[0].expectedProduct = product(input.items[0]);
    assert.equal(campaign.deriveHistoryScope(rows, f.manifest, input, runtime), null);
  });
  const absentEmpty = clone(f.discoveryResults); delete absentEmpty[0].remainingBlockers; delete absentEmpty[0].changes;
  assert.equal(campaign.deriveHistoryScope(absentEmpty, f.manifest, f.input, runtime).items.length, 1);
});

test('completed review saves a private hash-bound history input containing no admission token or command', async t => {
  const f = await historyFixture(t, [candidate(9), candidate(2)]);
  assert.equal(await campaign.main(args(f), f.dependencies), 2, JSON.stringify(f.errors));
  const reviewFile = path.join(f.output, 'review.json'), review = await json(reviewFile);
  assert.equal(review.complete, true); assert.equal(review.counts.discoveryHistoryReviewAvailable, 2); assert.equal(f.calls.length, 0);
  const scopeFile = path.join(f.output, 'history-scope.json'), bytes = await fs.readFile(scopeFile), scope = JSON.parse(bytes);
  assert.deepEqual(review.historyScope, { file: 'history-scope.json', sha256: rawHash(bytes), count: 2 });
  assert.equal((await fs.stat(scopeFile)).mode & 0o777, 0o600);
  assert.deepEqual(scope, { bindingRevisionId: binding, expectedDefinitionHash: definitionHash, installationKey: 'amber',
    items: [{ sku: 'NM9', productId: 9, remoteProductId: 1009 }, { sku: 'NM2', productId: 2, remoteProductId: 1002 }] });
  assert.ok(!bytes.toString().includes('previewToken'));
  await assert.doesNotReject(campaign.loadReview(f.output, rawHash(await fs.readFile(reviewFile)), runtime, f.cli));
});

test('nonlegacy and malformed extra-key hints remain grouped exceptions without a history scope file', async t => {
  for (const kind of ['canonicalNonlegacy', 'assessmentExtraKey', 'reviewExtraKey']) await t.test(kind, async t => {
    const f = await historyFixture(t);
    if (kind === 'canonicalNonlegacy') f.discoveryResults[0] = historyRow(f.input.items[0], 0, false);
    if (kind === 'assessmentExtraKey') f.discoveryResults[0].historyReviewAssessment.extra = 'unapproved';
    if (kind === 'reviewExtraKey') f.discoveryResults[0].historyReview.extra = 'unapproved';
    await saveManifest(f);
    assert.equal(await campaign.main(args(f), f.dependencies), 2, JSON.stringify(f.errors));
    const file = path.join(f.output, 'review.json'), review = await json(file);
    assert.equal(review.complete, true); assert.equal(review.historyScope, null);
    assert.equal(review.counts.discoveryHistoryReviewAvailable, 0); assert.equal(f.calls.length, 0);
    assert.ok(review.exceptions.some(group => group.skus.includes('NM1') && group.code === 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED'));
    await assert.rejects(fs.stat(path.join(f.output, 'history-scope.json')), { code: 'ENOENT' });
    await assert.doesNotReject(campaign.loadReview(f.output, rawHash(await fs.readFile(file)), runtime, f.cli));
  });
});

test('review loader rejects history scope file and descriptor tampering even with recalculated review hash', async t => {
  for (const kind of ['fileBytes', 'forgedJsonRehashed', 'descriptorCount', 'descriptorPath', 'descriptorHash', 'missingFile', 'omittedDescriptor']) {
    await t.test(kind, async t => {
      const f = await historyFixture(t); assert.equal(await campaign.main(args(f), f.dependencies), 2);
      const file = path.join(f.output, 'review.json'), review = await json(file), scopeFile = path.join(f.output, 'history-scope.json');
      if (kind === 'fileBytes') await fs.appendFile(scopeFile, '\n');
      if (kind === 'forgedJsonRehashed') { const scope = await json(scopeFile); scope.items[0].remoteProductId++;
        await fs.writeFile(scopeFile, JSON.stringify(scope)); review.historyScope.sha256 = rawHash(await fs.readFile(scopeFile)); }
      if (kind === 'descriptorCount') review.historyScope.count++;
      if (kind === 'descriptorPath') review.historyScope.file = '../history-scope.json';
      if (kind === 'descriptorHash') review.historyScope.sha256 = 'f'.repeat(64);
      if (kind === 'missingFile') await fs.unlink(scopeFile);
      if (kind === 'omittedDescriptor') review.historyScope = null;
      await fs.writeFile(file, JSON.stringify(review));
      await assert.rejects(campaign.loadReview(f.output, rawHash(await fs.readFile(file)), runtime, f.cli));
    });
  }
});

test('publication drift and authority revocation invalidate every earlier selection and stop subsequent packets', async t => {
  for (const stage of ['between', 'final', 'revoked']) await t.test(stage, async t => {
    const f = await fixture(t, Array.from({ length: 21 }, (_, i) => candidate(i + 1))); let checks = 0;
    f.dependencies.readAuthority = async () => {
      const failAt = stage === 'final' ? 8 : 4;
      if (++checks === failAt) {
        if (stage === 'revoked') throw Object.assign(Error('private database connection detail'), { code: 'ACTOR_NOT_ACTIVE', statusCode: 403 });
        return { ...publication, publicationHash: 'c'.repeat(64) };
      }
      return clone(publication);
    };
    assert.equal(await campaign.main(args(f), f.dependencies), 2, JSON.stringify(f.errors));
    const review = await json(path.join(f.output, 'review.json'));
    assert.equal(review.complete, false); assert.ok(review.globalFailure);
    assert.equal(review.counts.selected, 0);
    assert.equal(review.counts.invalidatedSelections, stage === 'final' ? 21 : 10);
    await assert.rejects(campaign.loadReview(f.output, rawHash(await fs.readFile(path.join(f.output, 'review.json'))), runtime, f.cli));
    assert.equal(f.calls.length, stage === 'final' ? 3 : 1);
    assert.ok(!JSON.stringify(review).includes('private database connection detail'));
  });
});

test('global canonical preflight failure invalidates previous packet selections and stops the campaign', async t => {
  const f = await fixture(t, Array.from({ length: 21 }, (_, i) => candidate(i + 1)));
  f.dependencies.preflight = async (_cfg, request) => {
    f.calls.push(request); const report = reportFor(request);
    if (f.calls.length === 2) { report.globalFailure = 'ADMIN_PERMISSION_REVOKED';
      for (const row of report.results) { row.status = 'blocked'; row.readyForApply = false;
        delete row.applyInput; row.blockers.push({ code: report.globalFailure }); }
      report.counts.readyForApply = 0; report.counts.blocked = request.items.length; }
    return report;
  };
  assert.equal(await campaign.main(args(f), f.dependencies), 2);
  const review = await json(path.join(f.output, 'review.json'));
  assert.equal(review.globalFailure, 'ADMIN_PERMISSION_REVOKED'); assert.equal(review.counts.selected, 0);
  assert.equal(review.counts.invalidatedSelections, 10);
  await assert.rejects(campaign.loadReview(f.output, rawHash(await fs.readFile(path.join(f.output, 'review.json'))), runtime, f.cli));
  assert.equal(f.calls.length, 2);
});

test('preflight cannot mutate the sealed source snapshot or field facts and continue to another packet', async t => {
  for (const mutation of ['source', 'field']) await t.test(mutation, async t => {
    const f = await fixture(t, Array.from({ length: 11 }, (_, i) => candidate(i + 1)));
    f.dependencies.preflight = async (_config, request) => {
      f.calls.push(request);
      if (mutation === 'source') request.items[0].expectedProduct.total_price_uah = '9999.00';
      else request.items[0].fields[0].local = 'Changed inside preflight';
      return reportFor(request);
    };
    assert.equal(await campaign.main(args(f), f.dependencies), 2);
    const review = await json(path.join(f.output, 'review.json'));
    assert.equal(review.complete, false); assert.equal(review.globalFailure, 'CAMPAIGN_PACKET_CHANGED');
    assert.equal(review.counts.selected, 0); assert.equal(f.calls.length, 1);
    await assert.rejects(campaign.loadReview(f.output, rawHash(await fs.readFile(path.join(f.output, 'review.json'))), runtime, f.cli));
  });
});

test('mixed blockers are review exceptions, and cannot enter selected local commands', async t => {
  const f = await fixture(t, [candidate(1), candidate(2), candidate(3)]);
  f.dependencies.preflight = async (_cfg, request) => {
    const report = reportFor(request);
    report.results[1].initialImports = [{ target: 'name', scope: 'en', before: '', after: 'Imported name' }];
    report.results[2].remainingBlockers = [{ code: 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED', target: 'meta_title', scope: 'all' }];
    return report;
  };
  assert.equal(await campaign.main(args(f), f.dependencies), 2);
  const review = await json(path.join(f.output, 'review.json')), plan = await json(path.join(f.output, review.plans[0].file));
  assert.equal(review.complete, true); assert.equal(plan.selections.length, 1); assert.equal(plan.selections[0].sku, 'NM1');
  assert.ok(plan.exceptions.some(e => e.sku === 'NM2')); assert.ok(plan.exceptions.some(e => e.sku === 'NM3'));
  assert.ok(review.exceptions.length > 0); assert.equal(plan.report.results[1].readyForApply, true);
});

test('canonical name-only imports receive separate-preview classification while all decisions stay excluded', async t => {
  const request = packet([candidate()]);
  for (const imports of [nameImports(), [nameImports()[0]], [nameImports()[1]]]) await t.test(imports.map(row => row.scope).join('+'), () => {
    const report = reportFor(request); report.results[0].initialImports = imports;
    const before = clone(report), selected = campaign.selectReport(report, request, runtime);
    assert.deepEqual(selected.selections, []);
    assert.deepEqual(selected.exceptions, [{ sku: 'NM1', code: 'CAMPAIGN_NAME_IMPORTS_SEPARATE_PREVIEW' }]);
    assert.deepEqual(report, before);
  });
});

test('mixed imports, other blockers and incomplete readiness retain generic import-review classification', async t => {
  const request = packet([candidate()]);
  const mutations = {
    mixedPrice: row => { row.initialImports.push({ target: 'price', scope: 'all', before: null, after: 1500 }); },
    priceOnly: row => { row.initialImports = [{ target: 'price', scope: 'all', before: null, after: 1500 }]; },
    unsupportedNameScope: row => { row.initialImports[0].scope = 'ua'; },
    duplicateNameScope: row => { row.initialImports.push(clone(row.initialImports[0])); },
    noncanonicalExtraKey: row => { row.initialImports[0].unapproved = true; },
    rowBlocker: row => { row.blockers.push({ code: 'BATCH_PRODUCT_CHANGED' }); },
    remainingBlocker: row => { row.remainingBlockers.push({ code: 'FIRST_SYNC_HISTORY_REVIEW_REQUIRED' }); },
    outboundFalse: row => { row.readyForOutboundAfterChoices = false; },
    localDecisionFalse: row => { row.readyForApply = false; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => {
    const report = reportFor(request); report.results[0].initialImports = nameImports(); mutate(report.results[0]);
    const selected = campaign.selectReport(report, request, runtime);
    assert.deepEqual(selected.selections, []);
    assert.ok(selected.exceptions.some(row => row.code === 'CAMPAIGN_INITIAL_IMPORTS_REQUIRE_REVIEW'));
    assert.ok(!selected.exceptions.some(row => row.code === 'CAMPAIGN_NAME_IMPORTS_SEPARATE_PREVIEW'));
  });
});

test('review derives exact name-only preview identities and unchanged import facts without commands', async t => {
  const f = await fixture(t, [candidate(9), candidate(2), candidate(7)]), reports = [];
  f.dependencies.preflight = async (_config, request) => {
    const report = reportFor(request);
    report.results[0].initialImports = nameImports(); report.results[1].initialImports = [nameImports()[1]];
    report.results[2].initialImports = [...nameImports(), { target: 'price', scope: 'all', before: null, after: 1500 }];
    reports.push(clone(report)); return report;
  };
  assert.equal(await campaign.main(args(f), f.dependencies), 2, JSON.stringify(f.errors));
  const file = path.join(f.output, 'review.json'), review = await json(file);
  assert.equal(review.complete, true); assert.equal(review.counts.selected, 0);
  assert.deepEqual(review.nameOnlyPreview, [
    { sku: 'NM9', productId: 9, remoteProductId: 1009, planFile: review.plans[0].file, initialImports: nameImports() },
    { sku: 'NM2', productId: 2, remoteProductId: 1002, planFile: review.plans[0].file, initialImports: [nameImports()[1]] },
  ]);
  const plan = await json(path.join(f.output, review.plans[0].file));
  assert.deepEqual(plan.selections, []); assert.deepEqual(plan.report, reports[0]);
  assert.ok(review.exceptions.some(row => row.code === 'CAMPAIGN_NAME_IMPORTS_SEPARATE_PREVIEW' && row.count === 2));
  assert.ok(review.exceptions.some(row => row.code === 'CAMPAIGN_INITIAL_IMPORTS_REQUIRE_REVIEW' && row.skus.includes('NM7')));
  await assert.doesNotReject(campaign.loadReview(f.output, rawHash(await fs.readFile(file)), runtime, f.cli));
});

test('rehashing forged derived name-only preview metadata never survives review loading', async t => {
  const changes = {
    sourceIdentity: review => { review.nameOnlyPreview[0].productId++; },
    remoteIdentity: review => { review.nameOnlyPreview[0].remoteProductId++; },
    importValue: review => { review.nameOnlyPreview[0].initialImports[0].after = 'Unreviewed replacement'; },
    extraAction: review => { review.nameOnlyPreview[0].applyInput = { action: 'import' }; },
    planReference: review => { review.nameOnlyPreview[0].planFile = 'plan-0002.json'; },
    omittedRow: review => { review.nameOnlyPreview = []; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async t => {
    const f = await fixture(t);
    f.dependencies.preflight = async (_config, request) => {
      const report = reportFor(request); report.results[0].initialImports = nameImports(); return report;
    };
    assert.equal(await campaign.main(args(f), f.dependencies), 2, JSON.stringify(f.errors));
    const file = path.join(f.output, 'review.json'), review = await json(file); change(review);
    await fs.writeFile(file, JSON.stringify(review));
    await assert.rejects(campaign.loadReview(f.output, rawHash(await fs.readFile(file)), runtime, f.cli));
  });
});

test('private output is exclusive, fsynced, and cannot overwrite completed review', async t => {
  const f = await fixture(t), events = [];
  f.dependencies.fs = { ...fs, open: async (...params) => {
    const handle = await fs.open(...params); const name = path.basename(params[0]);
    return new Proxy(handle, { get(target, key) {
      if (key === 'sync') return async () => { events.push(name); return target.sync(); };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  assert.equal(await campaign.main(args(f), f.dependencies), 0, JSON.stringify(f.errors));
  assert.equal((await fs.stat(f.output)).mode & 0o777, 0o700);
  const before = new Map();
  for (const name of await fs.readdir(f.output)) {
    const file = path.join(f.output, name); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    before.set(name, await fs.readFile(file, 'utf8')); assert.ok(events.includes(name), 'No fsync for ' + name);
  }
  const preflights = f.calls.length;
  assert.equal(await campaign.main(args(f), f.dependencies), 1); assert.equal(f.calls.length, preflights);
  for (const [name, bytes] of before) assert.equal(await fs.readFile(path.join(f.output, name), 'utf8'), bytes);
});

test('failed checkpoint fsync stops before another packet and leaves no usable completed review', async t => {
  const f = await fixture(t, Array.from({ length: 11 }, (_, i) => candidate(i + 1))); let checkpointSyncs = 0;
  f.dependencies.fs = { ...fs, open: async (...params) => {
    const handle = await fs.open(...params);
    if (path.basename(params[0]) !== 'results.jsonl') return handle;
    return new Proxy(handle, { get(target, key) {
      if (key === 'sync') return async () => {
        if (++checkpointSyncs === 2) throw Object.assign(Error('Private disk detail'), { code: 'EIO' });
        return target.sync();
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
  assert.equal(await campaign.main(args(f), f.dependencies), 2); assert.equal(f.calls.length, 1);
  const file = path.join(f.output, 'review.json'), review = await json(file);
  assert.equal(review.complete, false); assert.equal(review.globalFailure, 'EIO'); assert.equal(review.counts.selected, 0);
  assert.ok(!JSON.stringify(review).includes('Private disk detail'));
  await assert.rejects(campaign.loadReview(f.output, rawHash(await fs.readFile(file)), runtime, f.cli));
});

test('zero-progress plan writes and failed final review fsync never leave a loadable complete review', async t => {
  for (const failure of ['zeroPlanWrite', 'finalReviewSync']) await t.test(failure, async t => {
    const f = await fixture(t, Array.from({ length: 11 }, (_, i) => candidate(i + 1)));
    f.dependencies.fs = { ...fs, open: async (...params) => {
      const handle = await fs.open(...params), name = path.basename(params[0]);
      if (!(failure === 'zeroPlanWrite' && name === 'plan-0001.json'
        || failure === 'finalReviewSync' && name === 'review.json')) return handle;
      return new Proxy(handle, { get(target, key) {
        if (failure === 'zeroPlanWrite' && key === 'write') return async () => ({ bytesWritten: 0 });
        if (failure === 'finalReviewSync' && key === 'sync') return async () => { throw Object.assign(Error('Private fsync detail'), { code: 'EIO' }); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    } };
    assert.equal(await campaign.main(args(f), f.dependencies), failure === 'zeroPlanWrite' ? 2 : 1);
    assert.equal(f.calls.length, failure === 'zeroPlanWrite' ? 1 : 2);
    const file = path.join(f.output, 'review.json'), bytes = await fs.readFile(file);
    if (failure === 'finalReviewSync') assert.equal(bytes.length, 0);
    else assert.equal(JSON.parse(bytes).complete, false);
    await assert.rejects(campaign.loadReview(f.output, rawHash(bytes), runtime, f.cli));
    assert.ok(!JSON.stringify(f.errors).includes('Private fsync detail'));
  });
});

test('sealed review loader verifies raw review hash, actor and every packet plan digest', async t => {
  const f = await fixture(t);
  assert.equal(await campaign.main(args(f), f.dependencies), 0);
  const reviewFile = path.join(f.output, 'review.json'), bytes = await fs.readFile(reviewFile), review = JSON.parse(bytes);
  await assert.doesNotReject(campaign.loadReview(f.output, rawHash(bytes), runtime, f.cli));
  await assert.rejects(campaign.loadReview(f.output, 'f'.repeat(64), runtime, f.cli));
  await assert.rejects(campaign.loadReview(f.output, rawHash(bytes), runtime, { ...f.cli, actor: 8 }));
  await assert.rejects(campaign.loadReview(f.output, rawHash(bytes), runtime, { ...f.cli, database: 'other_test' }));
  await assert.rejects(campaign.loadReview(f.output, rawHash(bytes), runtime, { ...f.cli, installation: 'other' }));
  const planFile = path.join(f.output, review.plans[0].file), plan = await json(planFile);
  plan.request.items[0].fields[0].local = 'Unreviewed replacement';
  await fs.writeFile(planFile, JSON.stringify(plan));
  await assert.rejects(campaign.loadReview(f.output, rawHash(bytes), runtime, f.cli));
});

test('rehashing a forged plan cannot authorize an unselected field or remote choice', async t => {
  for (const kind of ['unownedField', 'acceptRemote']) await t.test(kind, async t => {
    const f = await fixture(t);
    assert.equal(await campaign.main(args(f), f.dependencies), 0);
    const reviewFile = path.join(f.output, 'review.json'), review = await json(reviewFile);
    const info = review.plans[0], planFile = path.join(f.output, info.file), plan = await json(planFile);
    const command = plan.selections[0].applyInput;
    if (kind === 'unownedField') command.choices[0].target = 'meta_description';
    else command.choices[0].choice = 'accept_remote';
    plan.selections[0].commandSha256 = c.hash(command);
    info.sha256 = c.hash(plan);
    await fs.writeFile(planFile, JSON.stringify(plan)); await fs.writeFile(reviewFile, JSON.stringify(review));
    await assert.rejects(campaign.loadReview(f.output, rawHash(await fs.readFile(reviewFile)), runtime, f.cli));
  });
});

test('database identity mismatch aborts before output and GET transport rejects all mutation forms', async t => {
  const f = await fixture(t);
  f.dependencies.pool.query = async () => ({ rows: [{ name: 'other_test' }] });
  assert.equal(await campaign.main(args(f), f.dependencies), 1); assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(path.join(f.output, 'review.json')), { code: 'ENOENT' });
  const g = await fixture(t), delegated = [];
  g.dependencies.fetchImpl = async (...params) => { delegated.push(params); return 'read'; };
  g.dependencies.preflight = async (_cfg, request, options) => {
    assert.equal(await options.fetchImpl(config.baseUrl), 'read');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      assert.throws(() => options.fetchImpl(config.baseUrl, { method }));
      assert.throws(() => options.fetchImpl(new Request(config.baseUrl, { method })));
    }
    assert.throws(() => options.fetchImpl(config.baseUrl, { method: 'GET', body: 'untrusted' }));
    return reportFor(request);
  };
  assert.equal(await campaign.main(args(g), g.dependencies), 0); assert.equal(delegated.length, 1);
});
