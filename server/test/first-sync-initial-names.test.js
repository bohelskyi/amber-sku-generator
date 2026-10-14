'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const c = require('../src/services/magento/binding-contract');
const batch = require('../src/services/magento/first-sync-batch-preflight');
const audit = require('../src/services/magento/binding-evidence-audit');
const { planFirstSyncFields } = require('../src/services/magento/first-sync-field-plan');
const { prepareProgress } = require('../src/services/magento/first-sync-progress-plan');
const core = require('../scripts/first-sync-initial-name-plan');
const runner = require('../scripts/first-sync-initial-names');
const names = require('../scripts/first-sync-campaign-names');
const binding = '11111111-1111-4111-8111-111111111111';
const session = '22222222-2222-4222-8222-222222222222';
const definitionHash = 'a'.repeat(64);
const config = { configured: true, baseUrl: 'https://initial-names.invalid' };
const run = { actorUserId: 7, installation: 'fixture' };
const clone = value => structuredClone(value);
const present = value => ({ known: true, present: true, value });
const key = field => field.scope + '/' + field.target;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const scopeFor = items => ({ bindingRevisionId: binding, expectedDefinitionHash: definitionHash,
  installationKey: 'fixture', choice: 'magento', items });

// Real canonical field/progress planners. Synthetic boundaries cannot mint a
// proof for a cloned product object or a different root/remote identity.
function fixture(id = 1, scopes = ['all', 'en']) {
  const sku = 'SV-INITIAL-NAMES-' + id, identity = String(100 + id);
  const item = { sku, productId: id, remoteProductId: 1000 + id };
  const scope = scopeFor([item]);
  const product = { id, public_product_identity_id: identity, full_sku: sku, public_sku: sku,
    category: 'SV', origin: 'legacy', status: 'active', exclude_from_export: 0, corrected_to_product_id: null,
    corrected_from_product_id: null, is_test_product: false, total_price_uah: '100.00', weight: '32.300',
    details: { answers: {} }, exportState: { route: 'normal', business_exclusion_state: 'none',
      recount_compatibility_excluded: false, independentExclusion: false } };
  const fields = [...scopes.map(scope => ({ target: 'name', scope, kind: 'name', type: 'text', required: true,
    mapping: { proven: true }, local: present('Manager ' + scope), remote: present('Magento ' + scope) })),
  { target: 'price', scope: 'all', kind: 'scalar', type: 'decimal', scale: 2, required: true,
    mapping: { proven: true }, local: present('100.00'), remote: present('100.00') }];
  const projection = { fields, blockers: [], projection: fields.map(field => ({ target: field.target,
    scope: field.scope, persistence: field.target === 'name' ? 'name' : 'price',
    outwardPolicy: 'authoritative_create_update', mappingHash: c.hash(key(field)),
    source: { kind: field.target === 'name' ? 'name' : 'product',
      field: field.target === 'name' ? `magento_name_override.values.${field.scope}` : field.target, productId: id, bindingRevisionId: binding,
      definitionHash, routeKey: 'SV' } })) };
  const proof = Object.freeze({}), root = '99';
  const observation = { amber: { product, compiled: { hash: definitionHash }, revision: { id: binding,
    installationKey: 'fixture', state: 'published', originHash: c.originHash(config.baseUrl), definitionHash } },
  raw: { id: item.remoteProductId, sku }, domainEvidence: { english: { id: item.remoteProductId, sku,
    fields: { name: 'Magento en' } }, failures: [] } };
  const first = { mode: 'first', blockers: [], progress: null, historyAdmission: proof, historyAdmissionHash: 'b'.repeat(64),
    key: { originHash: c.originHash(config.baseUrl), publicIdentityId: identity }, evidenceHash: 'e'.repeat(64),
    admissionGuards: { protectedWork: false, otherOrigin: false } };
  const base = { mode: 'first', first, observation, projection, previewToken: c.hash({ sku, phase: 'fresh' }) };
  const report = { mode: 'update', bindingRevision: { id: binding, state: 'published' }, identity: { state: 'found', article: sku, observedMagentoId: item.remoteProductId },
    evaluation: { ready: true }, syncEligibility: { eligible: true }, sendable: true, blockers: [] };
  const runtime = { c, batch, audit, admission: {
    allows: (actual, token) => token === proof && actual.amber.product === product
      && actual.raw?.id === item.remoteProductId && actual.raw?.sku === sku,
    rootId: token => token === proof ? root : null,
  } };
  const f = { item, scope, product, fields, projection, observation, base, report, runtime, proof, root };
  f.replan = () => {
    projection.plan = planFirstSyncFields({ fields });
    base.prepared = prepareProgress(projection, first.progress);
    base.fields = base.prepared.rows.map(row => ({ ...row }));
    base.blockers = base.prepared.blockers; base.readyForOutbound = base.prepared.readyForOutbound;
    base.complete = base.prepared.complete;
  };
  f.replan();
  f.select = expected => core.selectionFor(runtime, scope, item, base, report, run, { expected });
  return f;
}

function priorPrice(f, state = 'pending_outward_confirmation') {
  const price = f.fields.find(row => row.target === 'price'); price.remote = present('90.00'); f.replan();
  const prior = prepareProgress(f.projection, null, { target: 'price', scope: 'all', choice: 'keep_local' })
    .rows.find(row => row.target === 'price').record;
  prior.state = state;
  f.base.first.progress = { session: { id: session, revision: '4', initial_product_id: f.item.productId,
    initial_binding_revision_id: binding }, fields: [{ ...clone(prior), revision: '4' }], historyAdmissionEventId: f.root };
  f.replan(); return prior;
}

test('exact explicit scope is detached, bounded to 2000 and unique by SKU and both identities', () => {
  const f = fixture(), validated = core.validateScope(f.scope, f.runtime);
  assert.deepEqual(validated, f.scope); assert.notEqual(validated, f.scope); assert.notEqual(validated.items, f.scope.items);
  const largest = scopeFor(Array.from({ length: 2000 }, (_, index) => ({ sku: 'SV' + index,
    productId: index + 1, remoteProductId: index + 2001 })));
  assert.equal(core.validateScope(largest, f.runtime).items.length, 2000);
  assert.throws(() => core.validateScope({ ...largest, items: [...largest.items, { sku: 'OVER', productId: 9000, remoteProductId: 9000 }] }, f.runtime));
  for (const property of ['sku', 'productId', 'remoteProductId']) {
    const duplicate = { sku: 'SV2', productId: 2, remoteProductId: 2002, [property]: f.item[property] };
    assert.throws(() => core.validateScope({ ...f.scope, items: [f.item, duplicate] }, f.runtime));
  }
});

for (const [name, change] of [
  ['automatic choice', scope => { scope.choice = 'amber'; }],
  ['extra field choices', scope => { scope.fields = ['price']; }],
  ['extra item property', scope => { scope.items[0].choice = 'keep_local'; }],
  ['empty scope', scope => { scope.items = []; }],
  ['sparse scope', scope => { scope.items.length = 2; }],
  ['whitespace SKU', scope => { scope.items[0].sku += ' '; }],
  ['control SKU', scope => { scope.items[0].sku += '\n'; }],
  ['empty SKU', scope => { scope.items[0].sku = ''; }],
  ['string product ID', scope => { scope.items[0].productId = '1'; }],
  ['zero remote ID', scope => { scope.items[0].remoteProductId = 0; }],
  ['unsafe integer', scope => { scope.items[0].remoteProductId = Number.MAX_SAFE_INTEGER + 1; }],
  ['bad definition hash', scope => { scope.expectedDefinitionHash = 'bad'; }],
  ['bad binding UUID', scope => { scope.bindingRevisionId = 'bad'; }],
  ['missing installation', scope => { delete scope.installationKey; }],
]) test(`scope rejects ${name}`, () => {
  const f = fixture(); change(f.scope); assert.throws(() => core.validateScope(f.scope, f.runtime));
});

test('canonical UA and EN names produce a sealed selection without editing any projection or receipt', () => {
  const f = fixture(), before = clone(f.base), selected = f.select();
  assert.deepEqual(f.base, before);
  assert.equal(selected.preview.sku, f.item.sku);
  assert.deepEqual(selected.preview.initialImports.map(row => key(row)).sort(), ['all/name', 'en/name']);
  assert.deepEqual(selected.preview.initialImports.map(row => row.after).sort(), ['Magento all', 'Magento en']);
  assert.deepEqual(selected.item.expectedProduct, batch.source(f.product));
  assert.equal(selected.historyRoot, '99');
  assert.equal(selected.report.applyInput.previewToken, f.base.previewToken);
  assert.deepEqual(f.select(selected), selected);
});

for (const scopes of [['all'], ['en']]) test(`one unreceived language ${scopes[0]} may be selected without fabricating the other`, () => {
  const f = fixture(1, scopes), selected = f.select();
  assert.deepEqual(selected.preview.initialImports.map(row => row.scope), scopes);
});

test('ordinary NAME_BASELINE_REQUIRED is explicitly disclosed while canonical name inspection remains intact', () => {
  const f = fixture();
  f.report.blockers = [{ code: 'NAME_BASELINE_REQUIRED', scope: 'all' }]; f.report.sendable = false;
  const selected = f.select();
  assert.deepEqual(selected.ordinaryBlockers, f.report.blockers);
  assert.equal(selected.preview.initialImports.length, 2);
});

test('pristine first names require explicit opt-in and retain a null admission root', () => {
  const f = fixture(); f.base.first.historyAdmission = null; f.base.first.historyAdmissionHash = null;
  f.report.blockers = [{ code: 'NAME_BASELINE_REQUIRED' }]; f.report.sendable = false;
  f.runtime.admission = { allows: () => assert.fail('No admission proof may be invented'),
    rootId: () => assert.fail('No admission root exists') };
  const before = clone(f.base);
  assert.throws(() => f.select(), { code: 'INITIAL_NAMES_HISTORY_ADMISSION_REQUIRED' });
  const selected = core.selectionFor(f.runtime, f.scope, f.item, f.base, f.report, run, { allowPristineFirst: true });
  assert.equal(selected.historyRoot, null);
  assert.deepEqual(selected.report.applyInput.choices, []);
  assert.deepEqual(selected.preview.initialImports.map(row => key(row)).sort(), ['all/name', 'en/name']);
  assert.deepEqual(core.selectionFor(f.runtime, f.scope, f.item, f.base, f.report, run,
    { expected: selected, allowPristineFirst: true }), selected);
  assert.deepEqual(f.base, before);
});

for (const [label, mutate] of [
  ['existing progress without admission', f => { f.base.first.progress = { session: { revision: '1' }, fields: [] }; }],
  ['missing progress evidence', f => { delete f.base.first.progress; }],
  ['missing admission evidence', f => { delete f.base.first.historyAdmission; }],
  ['forged admission', f => { f.base.first.historyAdmission = {}; }],
  ['protected work', f => { f.base.first.admissionGuards.protectedWork = true; }],
  ['other origin', f => { f.base.first.admissionGuards.otherOrigin = true; }],
  ['canonical review mode', f => { f.base.first.mode = 'review'; }],
  ['unready evaluation', f => { f.report.evaluation.ready = false; }],
  ['ineligible lifecycle', f => { f.report.syncEligibility.eligible = false; }],
  ['unknown local names', f => { f.base.prepared.rows[0].local = { known: false }; }],
  ['incomplete manifest', f => { f.base.prepared.manifest.pop(); }],
  ['non-name import', f => { f.base.prepared.rows.find(row => row.target === 'price').record.state = 'imported'; }],
  ['extra ordinary blocker', f => { f.report.blockers = [{ code: 'NAME_READ_UNAVAILABLE' }]; }],
]) test(`pristine opt-in still rejects ${label}`, () => {
  const f = fixture(); f.base.first.historyAdmission = null; f.base.first.historyAdmissionHash = null; mutate(f);
  assert.throws(() => core.selectionFor(f.runtime, f.scope, f.item, f.base, f.report, run, { allowPristineFirst: true }));
});

test('pristine opt-in is strict and does not replace an existing admitted root', () => {
  const f = fixture();
  assert.equal(core.selectionFor(f.runtime, f.scope, f.item, f.base, f.report, run,
    { allowPristineFirst: true }).historyRoot, f.root);
  f.base.first.historyAdmission = null;
  for (const value of [false, 1, 'true']) assert.throws(() => core.selectionFor(f.runtime, f.scope, f.item, f.base, f.report, run,
    { allowPristineFirst: value }), { code: 'INITIAL_NAMES_HISTORY_ADMISSION_REQUIRED' });
});

test('pristine preview and commit opt-in both require fresh validation before durable intent', async () => {
  const f = fixture(); f.base.first.historyAdmission = null; f.base.first.historyAdmissionHash = null;
  const records = [], events = [], runtime = { ...f.runtime,
    preview: async (_config, options) => { options.onObservation(f.observation); return f.report; },
    first: { inspect: async () => f.base },
    boundary: { guard: async (_config, _input, _run, callback) => callback({}),
      observe: async () => ({ observation: f.observation, report: f.report }) },
  };
  const authority = async () => {}, stopping = () => false;
  assert.equal(runner.pristineFirstVersion, 1);
  assert.equal((await runner.previewItem(runtime, config, f.scope, f.item, run, authority, stopping)).code,
    'INITIAL_NAMES_HISTORY_ADMISSION_REQUIRED');
  const preview = await runner.previewItem(runtime, config, f.scope, f.item, run, authority, stopping, { allowPristineFirst: true });
  assert.equal(preview.status, 'available'); assert.equal(preview.selection.historyRoot, null);
  const append = async value => { events.push('prepared'); records.push(value); };
  const commit = async (_runtime, _config, _state, base, options) => {
    assert.strictEqual(base, f.base); assert.deepEqual(events, ['prepared']); events.push('commit');
    const proof = names.commitProof(runtime, base, options);
    return { sessionId: session, revision: proof.expectedRevision, completed: proof.complete, complete: proof.complete,
      readyForOutbound: proof.readyForOutbound, alreadyApplied: false, localChanged: true,
      changedFields: clone(proof.changedFields), terminalScopes: clone(proof.terminalScopes) };
  };
  const defaultResult = await runner.runItem(runtime, config, f.scope, preview.selection, run, { append, authority, commit });
  assert.equal(defaultResult.status, 'blocked'); assert.equal(defaultResult.code, 'INITIAL_NAMES_HISTORY_ADMISSION_REQUIRED');
  assert.deepEqual(records, []);
  const result = await runner.runItem(runtime, config, f.scope, preview.selection, run,
    { append, authority, commit, allowPristineFirst: true });
  assert.equal(result.status, 'recorded'); assert.deepEqual(events, ['prepared', 'commit']);
  assert.equal(records.length, 1); assert.equal(records[0].proof.commandHash, result.proof.commandHash);
  f.base.first.progress = { session: { revision: '1' }, fields: [] };
  const changed = await runner.runItem(runtime, config, f.scope, preview.selection, run,
    { append, authority, commit, allowPristineFirst: true });
  assert.equal(changed.status, 'blocked'); assert.equal(changed.code, 'INITIAL_NAMES_HISTORY_ADMISSION_REQUIRED');
  assert.deepEqual(events, ['prepared', 'commit']);
});

for (const [name, change] of [
  ['ordinary identity not found', f => { f.report.identity.state = 'missing'; }],
  ['ordinary wrong Magento ID', f => { f.report.identity.observedMagentoId++; }],
  ['ordinary wrong article', f => { f.report.identity.article = 'OTHER'; }],
  ['ordinary create mode', f => { f.report.mode = 'create'; }],
  ['additional ordinary blocker', f => { f.report.blockers = [{ code: 'NAME_BASELINE_REQUIRED' }, { code: 'CATEGORY_IDENTITIES_REVIEW_REQUIRED' }]; }],
  ['unready evaluation', f => { f.report.evaluation.ready = false; }],
  ['ordinary lifecycle ineligible', f => { f.report.syncEligibility.eligible = false; }],
  ['canonical ordinary mode', f => { f.base.mode = 'ordinary'; }],
  ['wrong local product', f => { f.product.id++; }],
  ['wrong remote ID', f => { f.observation.raw.id++; }],
  ['wrong remote SKU', f => { f.observation.raw.sku = 'OTHER'; }],
  ['wrong binding', f => { f.observation.amber.revision.id = session; }],
  ['wrong installation', f => { f.observation.amber.revision.installationKey = 'other'; }],
  ['wrong definition', f => { f.observation.amber.compiled.hash = 'f'.repeat(64); }],
  ['missing cutover admission', f => { f.base.first.historyAdmission = null; }],
  ['forged cutover admission', f => { f.base.first.historyAdmission = {}; }],
  ['protected history work', f => { f.base.first.admissionGuards.protectedWork = true; }],
  ['other history origin', f => { f.base.first.admissionGuards.otherOrigin = true; }],
  ['malformed preview token', f => { f.base.previewToken = 'bad'; }],
  ['malformed evidence hash', f => { f.base.first.evidenceHash = 'bad'; }],
  ['retired local product', f => { f.product.status = 'retired'; }],
  ['held lifecycle', f => { f.product.exportState.route = 'hold'; f.report.syncEligibility.eligible = false; }],
  ['test product despite ready report', f => { f.product.is_test_product = true; }],
  ['missing explicit test-product status', f => { delete f.product.is_test_product; }],
  ['business exclusion despite ready report', f => { f.product.exportState.business_exclusion_state = 'excluded'; }],
  ['recount exclusion despite ready report', f => { f.product.exportState.recount_compatibility_excluded = true; }],
  ['independent exclusion despite ready report', f => { f.product.exportState.independentExclusion = true; }],
  ['missing normal lifecycle', f => { delete f.product.exportState; }],
]) test(`fresh selection rejects ${name}`, () => {
  const f = fixture(); change(f); assert.throws(() => f.select());
});

for (const [name, change] of [
  ['missing manifest field', f => { f.base.prepared.manifest.pop(); }],
  ['duplicate manifest field', f => { f.base.prepared.manifest.push(clone(f.base.prepared.manifest[0])); }],
  ['missing prepared field', f => { f.base.prepared.rows.pop(); }],
  ['missing projection field', f => { f.projection.fields.pop(); }],
  ['missing projection metadata', f => { f.projection.projection.pop(); }],
  ['bad manifest hash', f => { f.base.prepared.manifestHash = 'f'.repeat(64); }],
  ['duplicate prepared field', f => { f.base.prepared.rows.push(clone(f.base.prepared.rows[0])); }],
  ['new local choice', f => { f.base.prepared.rows.find(row => row.target === 'price').record.source.decision = 'keep_local'; }],
  ['new non-name import', f => { f.base.prepared.rows.find(row => row.target === 'price').record.state = 'imported'; }],
  ['unknown name local', f => { f.base.prepared.rows[0].local = { known: false }; }],
  ['unknown name remote', f => { f.base.prepared.rows[0].remote = { known: false }; }],
  ['empty received name', f => { f.base.prepared.rows[0].record.after = ''; }],
  ['received value mismatch', f => { f.base.prepared.rows[0].record.after = 'Another'; }],
  ['wrong name persistence', f => { f.projection.projection[0].persistence = 'price'; }],
  ['unproven name mapping', f => { f.projection.fields[0].mapping.proven = false; }],
]) test(`full canonical manifest rejects ${name}`, () => {
  const f = fixture(); change(f); assert.throws(() => f.select());
});

test('genuine pending and terminal local receipts remain exact and never become new choices', () => {
  for (const state of ['pending_outward_confirmation', 'outward_verified']) {
    const f = fixture(), prior = priorPrice(f, state), before = clone(f.base);
    assert.equal(f.select().preview.initialImports.length, 2);
    assert.deepEqual(f.base, before);
    assert.deepEqual(f.base.prepared.rows.find(row => row.target === 'price').record, prior);
    f.base.prepared.rows.find(row => row.target === 'price').record.after = '999';
    assert.throws(() => f.select());
  }
});

for (const [name, change] of [
  ['source snapshot', f => { f.product.details.answers.unmapped = 'drift'; }],
  ['preview token', f => { f.base.previewToken = 'f'.repeat(64); }],
  ['eligibility hash', f => { f.base.first.evidenceHash = 'd'.repeat(64); }],
  ['fresh ordinary blockers', f => { f.report.blockers = [{ code: 'NAME_BASELINE_REQUIRED' }]; f.report.sendable = false; }],
  ['remote names', f => { f.fields[0].remote.value = 'Changed Magento'; f.replan(); }],
]) test(`sealed selection rejects later ${name} drift`, () => {
  const f = fixture(), selected = f.select(); change(f); assert.throws(() => f.select(selected));
});

test('equal initial names still select truthful first receipts without changing the values', () => {
  const f = fixture(); for (const field of f.fields.filter(row => row.target === 'name')) field.local = clone(field.remote);
  f.replan(); const selected = f.select();
  assert.equal(selected.preview.initialImports.length, 2);
  assert.ok(selected.preview.initialImports.every(row => row.before.value === row.after));
  assert.ok(f.base.prepared.rows.filter(row => row.target === 'name').every(row => row.record.state === 'name_received'));
});

test('unresolved price conflict stays visible in the untouched manifest without creating a local choice', () => {
  const f = fixture(); f.fields.find(row => row.target === 'price').remote = present('90.00'); f.replan();
  const before = clone(f.base), selected = f.select();
  assert.deepEqual(selected.report.applyInput.choices, []);
  assert.deepEqual(selected.remainingBlockers, f.base.prepared.blockers);
  assert.ok(selected.remainingBlockers.some(row => row.target === 'price'));
  assert.ok(selected.preview.initialImports.every(row => row.target === 'name'));
  assert.equal(f.base.prepared.readyForOutbound, false); assert.deepEqual(f.base, before);
});

test('an already received language is preserved while the other first receipt is selected', () => {
  const f = fixture(), all = clone(f.base.prepared.rows.find(row => row.target === 'name' && row.scope === 'all').record);
  f.base.first.progress = { session: { id: session, revision: '3', initial_product_id: f.item.productId,
    initial_binding_revision_id: binding }, fields: [{ ...all, revision: '3' }], historyAdmissionEventId: f.root };
  f.replan(); const selected = f.select();
  assert.deepEqual(selected.preview.initialImports.map(row => row.scope), ['en']);
  assert.deepEqual(f.base.prepared.rows.find(row => row.target === 'name' && row.scope === 'all').record, all);
});

for (const [name, change] of [
  ['blank remote text', field => { field.remote = present('  '); }],
  ['too long remote text', field => { field.remote = present('x'.repeat(1025)); }],
  ['control character text', field => { field.remote = present('bad\nname'); }],
  ['unknown remote', field => { field.remote = { known: false }; }],
]) test(`malformed or unknown canonical name cannot be selected: ${name}`, () => {
  const f = fixture(); change(f.fields[0]); f.replan(); assert.throws(() => f.select());
});

test('confirmed empty remote language is not adopted and cannot invent a name receipt', () => {
  const f = fixture(); f.fields[0].remote = { known: true, present: false, value: '' }; f.replan();
  const selected = f.select(); assert.deepEqual(selected.preview.initialImports.map(row => row.scope), ['en']);
  assert.notEqual(f.base.prepared.rows[0].record.state, 'name_received');
});

test('prior pending SEO and its immutable provenance are not replaced while names are selected', () => {
  const f = fixture(), seo = { target: 'meta_title', scope: 'en', kind: 'seo', type: 'text', required: false,
    mapping: { proven: true }, local: present('Manager SEO'), remote: present('Magento SEO') };
  f.fields.push(seo); f.projection.projection.push({ target: seo.target, scope: seo.scope, persistence: 'seo_snapshot',
    outwardPolicy: 'authoritative_create_update', mappingHash: c.hash(key(seo)), source: { kind: 'derived', field: 'meta_title',
      productId: f.product.id, bindingRevisionId: binding, definitionHash, routeKey: 'SV' } });
  f.replan();
  const old = prepareProgress(f.projection, null, { target: seo.target, scope: seo.scope, choice: 'accept_remote' })
    .rows.find(row => key(row) === key(seo)).record;
  f.base.first.progress = { session: { id: session, revision: '4' }, fields: [{ ...clone(old), revision: '4' }], historyAdmissionEventId: f.root };
  f.replan(); const selected = f.select();
  assert.ok(selected.preview.initialImports.every(row => row.target === 'name'));
  assert.deepEqual(f.base.prepared.rows.find(row => key(row) === key(seo)).record, old);
  f.base.prepared.rows.find(row => key(row) === key(seo)).record.after = 'Rewritten SEO';
  assert.throws(() => f.select());
});

// CLI tests use actual private scope/review/journal files and real artifact
// validators. Only external service and database boundaries are synthetic.
async function cliFixture(t, products = [fixture()]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'initial-names-unit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input.json'), previewDirectory = path.join(directory, 'preview');
  const output = path.join(directory, 'apply'), scope = scopeFor(products.map(row => row.item));
  const bytes = Buffer.from(JSON.stringify(scope, null, 2) + '\n'); await fs.writeFile(input, bytes, { mode: 0o600 });
  const calls = { preview: [], inspect: [], guard: [], observe: [], commit: [], verify: [], authority: 0, fetch: 0 };
  const logs = [], errors = [], codeHash = 'c'.repeat(64);
  const publication = { bindingRevisionId: binding, expectedDefinitionHash: definitionHash, publicationHash: 'd'.repeat(64) };
  const settings = { database: 'initial_names_test', readOnly: 'on', publication, previewHook: null, commitHook: null,
    authorityHook: null, verifyHook: null };
  const find = sku => products.find(row => row.item.sku === sku);
  const runtime = { ...products[0].runtime,
    admission: { allows: (observation, proof) => products.some(row => row.runtime.admission.allows(observation, proof)),
      rootId: proof => products.find(row => row.proof === proof)?.root || null },
    pool: { databaseSecrets: () => [] },
    first: { inspect: async (_config, observation) => {
      calls.inspect.push(observation.raw.sku); return find(observation.raw.sku).base;
    }, apply: () => assert.fail('The HTTP apply shortcut must never be called'),
    prepareDecision: () => assert.fail('No new local choice may be prepared') },
    preview: async (_config, options) => {
      calls.preview.push(options.sku);
      if (settings.previewHook) await settings.previewHook(options);
      const f = find(options.sku); options.onObservation(f.observation); return f.report;
    },
    boundary: { guard: async (_config, input, _run, callback) => {
      calls.guard.push(input.sku); return callback({ sku: input.sku });
    }, observe: async (_config, input) => {
      calls.observe.push(input.sku); const f = find(input.sku); return { observation: f.observation, report: f.report };
    } },
  };
  const pool = { query: async sql => {
    if (sql === 'SELECT current_database() AS name') return { rows: [{ name: settings.database }] };
    if (sql === 'SHOW default_transaction_read_only') return { rows: [{ default_transaction_read_only: settings.readOnly }] };
    assert.fail('Unexpected SQL boundary: ' + sql);
  } };
  const dependencies = { runtime, config, pool, env: {}, print: value => logs.push(value), printError: value => errors.push(JSON.parse(value)),
    implementationHash: async () => codeHash,
    readAuthority: async () => {
      calls.authority++; if (settings.authorityHook) await settings.authorityHook(calls.authority);
      return clone(settings.publication);
    },
    fetchImpl: async () => { calls.fetch++; assert.fail('No network request is expected'); },
    runNameCommit: async (_runtime, _config, state, base, options) => {
      assert.strictEqual(base, find(state.sku).base);
      const journal = await readJournalFile(output), last = journal.at(-1);
      assert.equal(last.type, 'prepared'); assert.equal(last.sku, state.sku);
      assert.equal(last.proof.previewHash, base.previewToken);
      assert.deepEqual(last.deliveryEffect, runner.deliveryEffect);
      calls.commit.push(state.sku);
      if (settings.commitHook) await settings.commitHook(base);
      const proof = names.commitProof(runtime, base, options);
      return { sessionId: proof.expectedSessionId || session, revision: proof.expectedRevision,
        completed: proof.complete, complete: proof.complete, readyForOutbound: proof.readyForOutbound,
        alreadyApplied: false, localChanged: false, changedFields: clone(proof.changedFields), terminalScopes: clone(proof.terminalScopes) };
    },
    verifyRecorded: async (_runtime, _config, selected, receipt) => {
      calls.verify.push(selected.item.sku); assert.equal(receipt.status, 'recorded');
      assert.equal(receipt.proof.previewHash, selected.report.applyInput.previewToken);
      if (settings.verifyHook) await settings.verifyHook(receipt);
    },
  };
  const args = (mode = 'preview', reviewHash = '') => ['--mode', mode, '--server-root', path.resolve(__dirname, '..'),
    '--output', mode === 'preview' ? previewDirectory : output, '--expected-database', 'initial_names_test', '--actor-id', '7',
    ...(mode === 'preview' ? ['--input', input, '--scope-sha256', hash(bytes)]
      : ['--review', previewDirectory, '--review-sha256', reviewHash])];
  const preview = async () => {
    const code = await runner.main(args(), dependencies);
    const bytes = await fs.readFile(path.join(previewDirectory, 'review.json'));
    return { code, review: JSON.parse(bytes), reviewHash: hash(bytes), bytes };
  };
  return { directory, input, previewDirectory, output, scope, bytes, calls, logs, errors, codeHash,
    settings, runtime, dependencies, args, preview, products };
}
async function readJournalFile(directory) {
  return (await fs.readFile(path.join(directory, 'results.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
}
function coded(code, extra = {}) { return Object.assign(Error(code), { code, ...extra }); }

test('CLI accepts only the distinct preview or reviewed apply/resume contracts', () => {
  const shared = ['--output', '/tmp/new', '--expected-database', 'initial_names_test', '--actor-id', '7'];
  const preview = ['--mode', 'preview', '--input', '/tmp/scope', '--scope-sha256', definitionHash, ...shared];
  assert.equal(runner.argumentsFor(preview).actor, 7);
  for (const mode of ['apply', 'resume']) assert.equal(runner.argumentsFor(['--mode', mode, '--review', '/tmp/review',
    '--review-sha256', definitionHash, ...shared]).mode, mode);
  for (const invalid of [[], [...preview, '--mode', 'apply'], [...preview, '--choice', 'magento'],
    [...preview, '--review', '/tmp/review'], [...preview, '--actor-id', '8'], preview.slice(0, -1),
    preview.map(value => value === definitionHash ? 'bad' : value), preview.map(value => value === '7' ? '0' : value),
    ['--help', '--mode', 'preview']]) assert.throws(() => runner.argumentsFor(invalid), { code: 'INITIAL_NAMES_ARGUMENTS' });
});

test('help has no filesystem, runtime, database or network prerequisite', async () => {
  const printed = [], dependencies = { print: value => printed.push(value),
    printError: () => assert.fail('Help must succeed') };
  Object.defineProperty(dependencies, 'runtime', { get() { assert.fail('Help must not load runtime'); } });
  assert.equal(await runner.main(['--help'], dependencies), 0);
  assert.match(printed[0], /--scope-sha256/); assert.match(printed[0], /automatic sync request/);
});

test('preview seals sequential fresh observations and actual scope bytes in private files without a commit', async t => {
  const f = await cliFixture(t, [fixture(1), fixture(2)]), result = await f.preview();
  assert.equal(result.code, 0, JSON.stringify(f.errors)); assert.equal(result.review.complete, true);
  assert.deepEqual(result.review.counts, { total: 2, checked: 2, selected: 2, blocked: 0, notChecked: 0 });
  assert.deepEqual(f.calls.preview, f.scope.items.map(row => row.sku)); assert.deepEqual(f.calls.inspect, f.calls.preview);
  assert.deepEqual(f.calls.guard, []); assert.deepEqual(f.calls.commit, []); assert.equal(f.calls.fetch, 0);
  assert.deepEqual(await fs.readFile(path.join(f.previewDirectory, 'scope.json')), f.bytes);
  assert.equal((await fs.stat(f.previewDirectory)).mode & 0o777, 0o700);
  for (const name of ['scope.json', 'review.json', 'results.jsonl'])
    assert.equal((await fs.stat(path.join(f.previewDirectory, name))).mode & 0o777, 0o600);
  const journal = await readJournalFile(f.previewDirectory);
  assert.deepEqual(journal.map(row => row.type), ['start', 'result', 'result', 'summary']);
  const printed = JSON.parse(f.logs.at(-1)); assert.equal(printed.reviewSha256, result.reviewHash);
  const loaded = await runner.loadReview(runner.argumentsFor(f.args('apply', result.reviewHash)), f.runtime, f.codeHash);
  assert.deepEqual(loaded.scope, f.scope); assert.equal(loaded.selections.length, 2);
});

for (const [label, change, expected] of [
  ['writable preview pool', f => { f.settings.readOnly = 'off'; }, 'INITIAL_NAMES_READ_ONLY_DATABASE_REQUIRED'],
  ['wrong database', f => { f.settings.database = 'another_test'; }, 'INITIAL_NAMES_DATABASE_MISMATCH'],
  ['wrong raw scope hash', async f => { await fs.appendFile(f.input, ' '); }, 'INITIAL_NAMES_SCOPE_HASH_CHANGED'],
]) test(`preview rejects ${label} before observations or writes`, async t => {
  const f = await cliFixture(t); await change(f);
  assert.equal(await runner.main(f.args(), f.dependencies), 1);
  assert.equal(f.errors.at(-1).code, expected); assert.deepEqual(f.calls.preview, []); assert.deepEqual(f.calls.commit, []);
  await assert.rejects(fs.stat(f.previewDirectory), { code: 'ENOENT' });
});

test('an existing preview directory is never overwritten or used for fresh observations', async t => {
  const f = await cliFixture(t); await fs.mkdir(f.previewDirectory); const marker = path.join(f.previewDirectory, 'original');
  await fs.writeFile(marker, 'preserved');
  assert.equal(await runner.main(f.args(), f.dependencies), 1);
  assert.equal(f.errors.at(-1).code, 'INITIAL_NAMES_OUTPUT_EXISTS');
  assert.equal(await fs.readFile(marker, 'utf8'), 'preserved'); assert.deepEqual(f.calls.preview, []);
});

test('a blocked preview row remains disclosed while only the available row applies and verifies on resume', async t => {
  const products = [fixture(1), fixture(2)]; products[0].report.blockers = [{ code: 'CATEGORY_IDENTITIES_REVIEW_REQUIRED' }];
  const f = await cliFixture(t, products), result = await f.preview();
  assert.equal(result.code, 2); assert.equal(result.review.complete, true);
  assert.deepEqual(result.review.counts, { total: 2, checked: 2, selected: 1, blocked: 1, notChecked: 0 });
  assert.deepEqual(result.review.results[0].ordinaryBlockers, products[0].report.blockers);
  assert.equal(await runner.main(f.args('apply', result.reviewHash), f.dependencies), 0, JSON.stringify(f.errors));
  assert.deepEqual(f.calls.commit, [products[1].item.sku]); assert.deepEqual(f.calls.observe, f.calls.commit);
  const journal = await readJournalFile(f.output);
  assert.deepEqual(journal.map(row => row.type), ['start', 'prepared', 'receipt', 'summary']);
  assert.equal(journal[0].mode, 'apply'); assert.equal(journal.at(-1).previewBlocked, 1);
  assert.equal(journal[2].result.localChanged, false); assert.equal(journal[2].status, 'recorded');
  assert.equal((await fs.stat(f.output)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(f.output, 'results.jsonl'))).mode & 0o777, 0o600);
  const observations = f.calls.observe.length;
  assert.equal(await runner.main(f.args('resume', result.reviewHash), f.dependencies), 0, JSON.stringify(f.errors));
  assert.deepEqual(f.calls.verify, [products[1].item.sku]); assert.equal(f.calls.commit.length, 1);
  assert.equal(f.calls.observe.length, observations); await assert.rejects(fs.stat(path.join(f.output, 'run.lock')), { code: 'ENOENT' });
});

test('publication loss after a completed row invalidates the whole preview and prevents apply', async t => {
  const f = await cliFixture(t, [fixture(1), fixture(2)]);
  f.settings.authorityHook = count => { if (count === 4) throw coded('TEST_AUTHORITY_UNAVAILABLE'); };
  const result = await f.preview();
  assert.equal(result.code, 2); assert.equal(result.review.complete, false);
  assert.equal(result.review.globalFailure, 'TEST_AUTHORITY_UNAVAILABLE');
  assert.equal(result.review.counts.selected, 1); assert.equal(result.review.counts.notChecked, 1);
  assert.equal(await runner.main(f.args('apply', result.reviewHash), f.dependencies), 1);
  assert.equal(f.errors.at(-1).code, 'INITIAL_NAMES_REVIEW_INVALID'); assert.deepEqual(f.calls.commit, []);
});

test('missing canonical observation cannot be replaced by an ordinary report', async t => {
  const f = await cliFixture(t); f.runtime.preview = async () => f.products[0].report;
  const result = await f.preview(); assert.equal(result.code, 2);
  assert.equal(result.review.results[0].code, 'INITIAL_NAMES_OBSERVATION_REQUIRED');
  assert.deepEqual(f.calls.inspect, []); assert.deepEqual(f.calls.commit, []);
});

for (const [label, mutate, expected] of [
  ['actor', review => { review.actorUserId++; }, 'INITIAL_NAMES_REVIEW_INVALID'],
  ['database', review => { review.database = 'other_test'; }, 'INITIAL_NAMES_REVIEW_INVALID'],
  ['implementation', review => { review.implementationHash = 'f'.repeat(64); }, 'INITIAL_NAMES_REVIEW_INVALID'],
  ['installation', review => { review.installationKey = 'other'; }, 'INITIAL_NAMES_REVIEW_INVALID'],
  ['publication', review => { review.publication.expectedDefinitionHash = 'f'.repeat(64); }, 'INITIAL_NAMES_REVIEW_INVALID'],
  ['counts', review => { review.counts.selected = 0; }, 'INITIAL_NAMES_REVIEW_INVALID'],
  ['index', review => { review.results[0].index = 1; }, 'INITIAL_NAMES_REVIEW_INVALID'],
  ['remote identity', review => { review.results[0].selection.item.remoteProductId++; }, 'INITIAL_NAMES_REVIEW_INVALID'],
  ['delivery effect', review => { review.deliveryEffect.ordinaryAutomaticRequest = 'No sync requests'; }, 'INITIAL_NAMES_REVIEW_INVALID'],
]) test(`rehashed review with changed ${label} is rejected before apply`, async t => {
  const f = await cliFixture(t), result = await f.preview(); mutate(result.review);
  const bytes = Buffer.from(JSON.stringify(result.review)); await fs.writeFile(path.join(f.previewDirectory, 'review.json'), bytes);
  assert.equal(await runner.main(f.args('apply', hash(bytes)), f.dependencies), 1);
  assert.equal(f.errors.at(-1).code, expected); assert.deepEqual(f.calls.guard, []); assert.deepEqual(f.calls.commit, []);
});

test('raw review and original scope byte hashes are independently enforced', async t => {
  const f = await cliFixture(t), result = await f.preview(), reviewFile = path.join(f.previewDirectory, 'review.json');
  await fs.appendFile(reviewFile, ' ');
  assert.equal(await runner.main(f.args('apply', result.reviewHash), f.dependencies), 1);
  assert.equal(f.errors.at(-1).code, 'INITIAL_NAMES_REVIEW_HASH_CHANGED');
  await fs.writeFile(reviewFile, result.bytes); await fs.appendFile(path.join(f.previewDirectory, 'scope.json'), ' ');
  assert.equal(await runner.main(f.args('apply', result.reviewHash), f.dependencies), 1);
  assert.equal(f.errors.at(-1).code, 'INITIAL_NAMES_SCOPE_HASH_CHANGED'); assert.deepEqual(f.calls.commit, []);
});

for (const [label, change] of [
  ['local source', f => { f.product.details.answers.unmapped = 'new'; }],
  ['fresh preview token', f => { f.base.previewToken = 'f'.repeat(64); }],
  ['remote name', f => { f.fields[0].remote.value = 'Changed Magento'; f.replan(); }],
]) test(`apply revalidates ${label} despite a valid sealed review and stops before commit`, async t => {
  const f = await cliFixture(t), result = await f.preview(); change(f.products[0]);
  assert.equal(await runner.main(f.args('apply', result.reviewHash), f.dependencies), 2);
  const journal = await readJournalFile(f.output);
  assert.deepEqual(journal.map(row => row.type), ['start', 'receipt', 'summary']);
  assert.equal(journal[1].status, 'blocked'); assert.equal(journal[1].code, 'INITIAL_NAMES_REVIEW_CHANGED');
  assert.deepEqual(f.calls.commit, []);
});

test('lost commit response stops the tail and resume cannot repeat an unknown write', async t => {
  const f = await cliFixture(t, [fixture(1), fixture(2)]), result = await f.preview();
  f.settings.commitHook = () => { throw coded('TEST_REPLY_LOST', { unconfirmed: true }); };
  assert.equal(await runner.main(f.args('apply', result.reviewHash), f.dependencies), 2);
  const journal = await readJournalFile(f.output);
  assert.equal(journal[2].status, 'unconfirmed'); assert.equal(journal.at(-1).notChecked, 1);
  assert.deepEqual(f.calls.commit, [f.products[0].item.sku]);
  f.settings.commitHook = null;
  assert.equal((await fs.stat(path.join(f.output, 'run.lock'))).mode & 0o777, 0o600);
  assert.equal(await runner.main(f.args('resume', result.reviewHash), f.dependencies), 1);
  assert.equal(f.errors.at(-1).code, 'INITIAL_NAMES_OUTPUT_EXISTS'); assert.equal(f.calls.commit.length, 1);
});

test('a prepared-only crash journal cannot resume a possibly completed commit', async t => {
  const f = await cliFixture(t), result = await f.preview();
  assert.equal(await runner.main(f.args('apply', result.reviewHash), f.dependencies), 0);
  const journal = await readJournalFile(f.output);
  await fs.writeFile(path.join(f.output, 'results.jsonl'), journal.slice(0, 2).map(row => JSON.stringify(row) + '\n').join(''));
  assert.equal(await runner.main(f.args('resume', result.reviewHash), f.dependencies), 1);
  assert.equal(f.errors.at(-1).code, 'CAMPAIGN_NAMES_JOURNAL_UNCONFIRMED'); assert.equal(f.calls.commit.length, 1);
});

test('recorded receipt verification failure blocks resume without observations or another commit', async t => {
  const f = await cliFixture(t), result = await f.preview();
  assert.equal(await runner.main(f.args('apply', result.reviewHash), f.dependencies), 0);
  const observations = f.calls.observe.length;
  f.settings.verifyHook = () => { throw coded('CAMPAIGN_NAMES_RECORDED_RECEIPT_UNCONFIRMED'); };
  assert.equal(await runner.main(f.args('resume', result.reviewHash), f.dependencies), 1);
  assert.equal(f.errors.at(-1).code, 'CAMPAIGN_NAMES_RECORDED_RECEIPT_UNCONFIRMED');
  assert.equal(f.calls.commit.length, 1); assert.equal(f.calls.observe.length, observations);
});

test('the preview transport rejects remote write attempts before the underlying fetch boundary', async t => {
  const f = await cliFixture(t);
  f.settings.previewHook = options => options.fetchImpl('https://initial-names.invalid/rest/all/V1/products/test', { method: 'PUT', body: '{}' });
  const result = await f.preview(); assert.equal(result.code, 2); assert.equal(result.review.results[0].status, 'blocked');
  assert.equal(f.calls.fetch, 0); assert.deepEqual(f.calls.commit, []); assert.deepEqual(f.calls.inspect, []);
});

function failOneSync(t, file, shouldFail = async () => true) {
  const open = fs.open; let failed = false;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (String(args[0]) === file) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, 'sync', async () => {
        if (!failed && await shouldFail()) { failed = true; throw coded('EIO'); }
        return sync();
      });
    }
    return handle;
  });
  return () => failed;
}

for (const boundary of ['file', 'directory']) test(`failed review ${boundary} fsync cannot leave a loadable complete review for apply`, async t => {
  const f = await cliFixture(t), reviewFile = path.join(f.previewDirectory, 'review.json');
  const failed = failOneSync(t, boundary === 'file' ? reviewFile : f.previewDirectory, async () => {
    try { await fs.stat(reviewFile); return true; } catch (error) { assert.equal(error.code, 'ENOENT'); return false; }
  });
  assert.equal(await runner.main(f.args(), f.dependencies), 1); assert.equal(failed(), true);
  assert.equal(f.errors.at(-1).code, 'EIO'); assert.deepEqual(f.calls.commit, []);
  let bytes;
  try { bytes = await fs.readFile(reviewFile); } catch (error) { assert.equal(error.code, 'ENOENT'); return; }
  await assert.rejects(runner.loadReview(runner.argumentsFor(f.args('apply', hash(bytes))), f.runtime, f.codeHash));
});

test('failed receipt fsync leaves an unresolved outcome that blocks resume and the remaining tail', async t => {
  const f = await cliFixture(t, [fixture(1), fixture(2)]), result = await f.preview();
  const failed = failOneSync(t, path.join(f.output, 'results.jsonl'), async () =>
    (await readJournalFile(f.output)).at(-1).type === 'receipt');
  assert.equal(await runner.main(f.args('apply', result.reviewHash), f.dependencies), 1);
  assert.equal(failed(), true); assert.equal(f.errors.at(-1).localResultUnconfirmed, true);
  assert.deepEqual(f.calls.commit, [f.products[0].item.sku]);
  assert.equal(await runner.main(f.args('resume', result.reviewHash), f.dependencies), 1);
  assert.deepEqual(f.calls.commit, [f.products[0].item.sku]); assert.deepEqual(f.calls.verify, []);
});
