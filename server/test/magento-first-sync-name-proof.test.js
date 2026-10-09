const { test } = require('node:test');
const assert = require('node:assert/strict');
const proof = require('../src/services/magento/first-sync-name-proof');
const names = require('../src/services/magento/name-state');
const { compileDefinition } = require('../src/services/export-templates/definition');

function fixture() {
  const definition = require('./fixtures/magento-v4').definition(['CH']);
  for (const source of Object.values(definition.sources)) if (source.category === 'XG') source.category = 'CH';
  definition.groups[0].rows[0].cells.name = { op: 'literal', value: 'Accepted UA' };
  definition.groups[0].rows[1].cells.name = { op: 'literal', value: 'Local EN' };
  const amber = { product: { id: 7, public_product_identity_id: '17', public_sku: 'AG-000017',
    full_sku: 'CH1', category: 'CH', status: 'active', total_price_uah: '200', details: { answers: {} } },
  revision: { id: 'binding-a', installationKey: 'installation-a', originHash: 'origin-a' },
  compiled: compileDefinition(definition), nameState: { remote_product_id: 77, baseline_names: null, resolution: null, version: '1' } };
  const observation = { amber, schema: { marker: 'schema-a' }, raw: { id: 77, sku: 'AG-000017', name: 'Accepted UA' },
    domainEvidence: { english: { id: 77, sku: 'AG-000017', fields: { name: '' } }, failures: [] } };
  const projection = { fields: [], projection: [] }, prepared = { readyForOutbound: true, blockers: [], rows: [] };
  for (const [scope, value, remote, received] of [['all', 'Accepted UA', 'Accepted UA', true], ['en', 'Local EN', '', false]]) {
    projection.fields.push({ target: 'name', scope, kind: 'name', mapping: { proven: true },
      local: { known: true, present: true, value }, remote: { known: true, present: remote !== '', value: remote },
      ...(received ? { receipt: { state: 'name_received' } } : {}) });
    projection.projection.push({ target: 'name', scope, persistence: 'name', outwardPolicy: 'authoritative_create_update' });
    const state = received ? 'name_received' : 'pending_outward_confirmation';
    prepared.rows.push({ target: 'name', scope, received, status: state, record: { state } });
  }
  const job = { id: 'job-a', product_id: 7, public_product_identity_id: '17', sku: 'AG-000017',
    binding_revision_id: 'binding-a', installation_key: 'installation-a', origin_hash: 'origin-a',
    intent: { mode: 'update', englishValues: { name: 'Local EN' },
      operations: [{ domain: 'coreProduct', payload: { product: { sku: 'AG-000017', name: 'Accepted UA' } } }] },
    baseline: { raw: structuredClone(observation.raw), domainEvidence: structuredClone(observation.domainEvidence) } };
  return { observation, projection, prepared, job };
}

test('request-owned partial-name proof leaves actual ordinary baseline guard and stored state untouched', () => {
  const f = fixture(), before = JSON.stringify(f);
  assert.equal(names.decisionFor(f.observation).action, 'baseline_required');
  const token = proof.issue(f);
  assert.ok(token); assert.equal(Object.isFrozen(token), true);
  assert.equal(proof.allows(f.observation, token), true);
  assert.equal(proof.baselineAllows(f.job, f.observation, token), true);
  assert.equal(names.decisionFor(f.observation).action, 'baseline_required');
  assert.equal(JSON.stringify(f), before, 'no baseline, resolution, product or receipt is mutated');
  assert.equal(proof.allows(f.observation, {}), false);
});

for (const [label, change] of [
  ['received UA independently changed in Magento', f => { f.observation.raw.name = 'Remote changed UA'; f.projection.fields[0].remote.value = 'Remote changed UA'; }],
  ['received UA empty in Magento', f => { f.observation.raw.name = ''; f.projection.fields[0].remote = { known: true, present: false, value: '' }; }],
  ['unreceived populated EN conflict', f => { f.observation.domainEvidence.english.fields.name = 'Different EN'; f.projection.fields[1].remote = { known: true, present: true, value: 'Different EN' }; }],
  ['received EN awaiting outward write', f => { f.projection.fields[1].receipt = { state: 'name_received' }; }],
  ['received EN row evidence', f => { f.prepared.rows[1].received = true; }],
  ['unknown EN projection read', f => { f.projection.fields[1].remote.known = false; }],
  ['missing EN observation', f => { delete f.observation.domainEvidence.english; }],
  ['missing remote EN value', f => { delete f.observation.domainEvidence.english.fields.name; }],
  ['failed store-view read', f => { f.observation.domainEvidence.failures.push({ operation: 'storeViews' }); }],
  ['foreign EN identity', f => { f.observation.domainEvidence.english.id = 78; }],
  ['foreign remote SKU', f => { f.observation.raw.sku = 'AG-000018'; }],
  ['name-state remote identity changed', f => { f.observation.amber.nameState.remote_product_id = 78; }],
  ['native ownership absent', f => { f.observation.amber.product.characteristic_version_id = 3; }],
  ['unproven mapping', f => { f.projection.fields[1].mapping.proven = false; }],
  ['unapproved outward policy', f => { f.projection.projection[1].outwardPolicy = 'magento_managed'; }],
  ['mismatched evaluated local value', f => { f.projection.fields[1].local.value = 'Other EN'; }],
  ['non-pending plan decision', f => { f.prepared.rows[1].status = 'review_required'; }],
  ['non-pending receipt decision', f => { f.prepared.rows[1].record.state = 'review_required'; }],
  ['unresolved other field', f => { f.prepared.readyForOutbound = false; f.prepared.blockers.push({ code: 'UNKNOWN' }); }],
  ['missing received UA scope', f => { f.projection.fields.shift(); }],
  ['duplicate name scope', f => { f.projection.fields.push(structuredClone(f.projection.fields[1])); }],
]) test('proof refuses ' + label, () => {
  const f = fixture(); change(f); assert.equal(proof.issue(f), null);
});

test('both-sided received-UA conflict remains an actual ordinary conflict beside first EN', () => {
  const f = fixture();
  f.observation.amber.product.magento_name_override = { generated: { all: 'Accepted UA', en: 'Local EN' },
    values: { all: 'Manager UA', en: 'Local EN' } };
  f.observation.amber.nameState.baseline_names = { all: 'Previously common UA', en: 'Old EN' };
  f.observation.raw.name = 'Magento UA';
  f.projection.fields[0].local.value = 'Manager UA'; f.projection.fields[0].remote.value = 'Magento UA';
  assert.equal(names.decisionFor(f.observation).action, 'conflict');
  assert.equal(proof.issue(f), null);
  assert.equal(names.decisionFor(f.observation).action, 'conflict');
});

test('even an exact ordinary resolution does not let this proof bypass a received-language mismatch', () => {
  const f = fixture(); f.observation.raw.name = 'Remote UA'; f.projection.fields[0].remote.value = 'Remote UA';
  f.observation.amber.nameState.resolution = { amber: { all: 'Accepted UA', en: 'Local EN' }, remote: { all: 'Remote UA', en: '' } };
  assert.equal(names.decisionFor(f.observation).action, 'send_amber');
  assert.equal(proof.issue(f), null, 'existing ordinary resolution keeps its own separate authority');
});

for (const [label, change] of [
  ['local manager edit', f => { f.observation.amber.product.magento_name_override = { generated: { all: 'Accepted UA', en: 'Local EN' }, values: { all: 'Edited UA', en: 'Local EN' } }; }],
  ['remote write/readback', f => { f.observation.domainEvidence.english.fields.name = 'Local EN'; }],
  ['binding', f => { f.observation.amber.revision.id = 'binding-b'; }],
  ['origin', f => { f.observation.amber.revision.originHash = 'origin-b'; }],
  ['installation', f => { f.observation.amber.revision.installationKey = 'installation-b'; }],
  ['public identity', f => { f.observation.amber.product.public_product_identity_id = '18'; }],
  ['product', f => { f.observation.amber.product.id = 8; }],
  ['name-state revision', f => { f.observation.amber.nameState.version = '2'; }],
]) test('issued proof expires on changed ' + label, () => {
  const f = fixture(), token = proof.issue(f); assert.ok(token); change(f);
  assert.equal(proof.allows(f.observation, token), false);
  assert.equal(proof.baselineAllows(f.job, f.observation, token), false);
});

for (const [label, change] of [
  ['job ID', f => { f.job.id = 'job-b'; }],
  ['job intent', f => { f.job.intent.englishValues.name = 'Other EN'; }],
  ['job baseline', f => { f.job.baseline.raw.name = 'Changed UA'; }],
  ['job installation', f => { f.job.installation_key = 'installation-b'; }],
  ['job binding', f => { f.job.binding_revision_id = 'binding-b'; }],
]) test('historical permission rejects changed ' + label, () => {
  const f = fixture(), token = proof.issue(f); assert.ok(token); change(f);
  assert.equal(proof.allows(f.observation, token), true, 'fresh proof is independent of historical plan');
  assert.equal(proof.baselineAllows(f.job, f.observation, token), false);
});

test('baseline exception cannot initialize an already received language', () => {
  const f = fixture(); f.job.baseline.raw.name = '';
  const token = proof.issue(f); assert.ok(token);
  assert.equal(proof.allows(f.observation, token), true);
  assert.equal(proof.baselineAllows(f.job, f.observation, token), false);
});

test('baseline exception requires original empty EN and the exact intended outward value', () => {
  for (const change of [f => { f.job.baseline.domainEvidence.english.fields.name = 'Old populated EN'; },
    f => { f.job.intent.englishValues.name = 'Different EN'; },
    f => { f.job.baseline.domainEvidence.english.id = 78; }]) {
    const f = fixture(); change(f); const token = proof.issue(f); assert.ok(token);
    assert.equal(proof.baselineAllows(f.job, f.observation, token), false);
  }
});

test('unbound enqueue proof never authorizes a historical job baseline', () => {
  const f = fixture(); const token = proof.issue({ ...f, job: null }); assert.ok(token);
  assert.equal(proof.allows(f.observation, token), true);
  assert.equal(proof.baselineAllows(f.job, f.observation, token), false);
});

function bothEmpty() {
  const f = fixture();
  f.observation.raw.name = ''; f.job.baseline.raw.name = '';
  f.projection.fields[0].remote = { known: true, present: false, value: '' };
  delete f.projection.fields[0].receipt;
  f.prepared.rows[0] = { target: 'name', scope: 'all', received: false,
    status: 'pending_outward_confirmation', record: { state: 'pending_outward_confirmation' } };
  return f;
}

test('known empty UA and EN may receive their first outward values without fabricating a baseline', () => {
  const f = bothEmpty(), before = JSON.stringify(f);
  assert.equal(names.decisionFor(f.observation).action, 'unavailable');
  const token = proof.issue(f); assert.ok(token);
  assert.equal(proof.allows(f.observation, token), true);
  assert.equal(proof.baselineAllows(f.job, f.observation, token), true);
  assert.equal(JSON.stringify(f), before);
});

for (const [label, change] of [
  ['missing UA value', f => { delete f.observation.raw.name; }],
  ['missing EN value', f => { delete f.observation.domainEvidence.english.fields.name; }],
  ['unknown UA read', f => { f.projection.fields[0].remote.known = false; }],
  ['unknown EN read', f => { f.projection.fields[1].remote.known = false; }],
  ['UA receipt already terminal', f => { f.projection.fields[0].receipt = { state: 'name_received' }; }],
  ['UA policy not authoritative', f => { f.projection.projection[0].outwardPolicy = 'magento_managed'; }],
  ['UA field not pending', f => { f.prepared.rows[0].status = 'review_required'; }],
]) test('known-empty pair exception refuses ' + label, () => {
  const f = bothEmpty(); change(f); assert.equal(proof.issue(f), null);
});

function baselineObservation(f) {
  return { amber: f.observation.amber, schema: f.observation.schema,
    raw: structuredClone(f.job.baseline.raw), domainEvidence: structuredClone(f.job.baseline.domainEvidence) };
}

test('baseline observation proof accepts exact reconstruction with original Amber and schema objects', () => {
  const f = bothEmpty(), token = proof.issue(f), baseline = baselineObservation(f);
  assert.ok(token); baseline.raw.updated_at = 'fresh validated timestamp';
  assert.equal(proof.baselineObservationAllows(f.job, baseline, f.observation, token), true);
  assert.equal(proof.baselineObservationAllows(f.job, baseline, f.observation, {}), false);
});

for (const [label, change] of [
  ['copied Amber object', (f, baseline) => { baseline.amber = { ...baseline.amber }; }],
  ['copied schema object', (f, baseline) => { baseline.schema = { ...baseline.schema }; }],
  ['raw identity', (f, baseline) => { baseline.raw.id = 78; }],
  ['raw SKU', (f, baseline) => { baseline.raw.sku = 'AG-000018'; }],
  ['raw UA name', (f, baseline) => { baseline.raw.name = 'Different UA'; }],
  ['English identity', (f, baseline) => { baseline.domainEvidence.english.id = 78; }],
  ['English SKU', (f, baseline) => { baseline.domainEvidence.english.sku = 'AG-000018'; }],
  ['English name', (f, baseline) => { baseline.domainEvidence.english.fields.name = 'Different EN'; }],
  ['other English field', (f, baseline) => { baseline.domainEvidence.english.fields.description = 'Added field'; }],
  ['failed baseline store-view read', (f, baseline) => { baseline.domainEvidence.failures.push({ operation: 'storeViews' }); }],
  ['fresh remote changed', f => { f.observation.domainEvidence.english.fields.name = 'Local EN'; }],
  ['bound job changed', f => { f.job.intent.englishValues.name = 'Other EN'; }],
]) test('baseline observation proof rejects ' + label, () => {
  const f = bothEmpty(), token = proof.issue(f), baseline = baselineObservation(f); assert.ok(token);
  change(f, baseline);
  assert.equal(proof.baselineObservationAllows(f.job, baseline, f.observation, token), false);
});

test('actual preview proof removes only the name blocker and preserves unrelated blockers and scoped payloads', () => {
  const preview = require('../src/services/magento/sync-preview');
  const v4 = require('./fixtures/magento-v4');
  const f = fixture();
  f.observation.schema = v4.observation();
  f.observation.raw.attribute_set_id = 8001;
  f.observation.amber.revision.schema = f.observation.schema;
  f.observation.amber.revision.bindings = v4.approvedBindings(f.observation.amber.compiled.definition, f.observation.schema);
  f.observation.domainEvidence.failures = [
    { code: 'CATEGORY_TREE_UNAVAILABLE', operation: 'categories', rootCategoryId: 803 },
    { code: 'INVENTORY_READ_UNAVAILABLE', operation: 'inventory', reason: 'MAGENTO_TIMEOUT' },
  ];
  const token = proof.issue({ ...f, job: null }); assert.ok(token);
  const report = preview.planPreview(f.observation.amber, f.observation.schema, f.observation.raw, [],
    { domainEvidence: f.observation.domainEvidence });
  assert.ok(report.blockers.some(blocker => blocker.code === 'NAME_BASELINE_REQUIRED'));
  assert.ok(report.blockers.some(blocker => blocker.code === 'REQUIRED_NATIVE_FIELD_MISSING'));
  assert.ok(report.blockers.some(blocker => blocker.code === 'CATEGORY_TREE_UNAVAILABLE'));
  assert.ok(report.blockers.some(blocker => blocker.code === 'INVENTORY_READ_UNAVAILABLE'));
  const before = structuredClone(report);
  assert.equal(preview.applyFirstSyncNameProof(report, f.observation, {}), report, 'forged token leaves report object untouched');
  const result = preview.applyFirstSyncNameProof(report, f.observation, token);
  assert.deepEqual(result.blockers, report.blockers.filter(blocker => blocker.code !== 'NAME_BASELINE_REQUIRED'));
  assert.equal(result.sendable, false); assert.equal(result.sendability.sendable, false);
  assert.equal(result.sendability.overall.sendable, false);
  assert.deepEqual(result.sendability.overall.blockers, result.blockers);
  assert.deepEqual(result.candidatePayload, report.candidatePayload);
  assert.equal(result.transport, report.transport);
  for (const [domain, operation] of Object.entries(result.sendability.operations)) {
    const expected = result.blockers.filter(blocker => blocker.operation === domain || blocker.operation === 'all');
    assert.deepEqual(operation.blockers, expected); assert.equal(operation.sendable, expected.length === 0);
    const original = report.sendability.operations[domain];
    for (const key of ['candidatePayload', 'candidateLinks', 'plan']) assert.deepEqual(operation[key], original[key]);
  }
  assert.deepEqual(report, before, 'the original report is never mutated');
});

function durableFixture() {
  const f = bothEmpty(), sessionId = '11111111-1111-4111-8111-111111111111';
  const token = proof.issue({ ...f, job: null }); assert.ok(token);
  f.job.baseline.firstSyncNames = proof.baselineReceipt(f.observation, token, { sessionId, revision: '4' });
  const session = { id: sessionId, origin_hash: 'origin-a', public_product_identity_id: '17',
    public_sku: 'AG-000017', installation_key: 'installation-a', remote_product_id: '77',
    initial_product_id: 7, initial_binding_revision_id: 'binding-a', initial_contract_version: 'first-sync-v1', revision: '4' };
  const command = { key: { originHash: 'origin-a', publicIdentityId: '17' }, expectedRevision: '3', readyForOutbound: true,
    identity: { installationKey: 'installation-a', publicSku: 'AG-000017', remoteProductId: '77',
      initialProductId: 7, initialBindingRevisionId: 'binding-a', contractVersion: 'first-sync-v1' },
    requiredScopes: ['all', 'en'].map(scope => ({ target: 'name', scope })),
    fields: f.projection.fields.map(field => ({ target: 'name', scope: field.scope, state: 'pending_outward_confirmation',
      before: structuredClone(field.local), remote: structuredClone(field.remote), after: field.local.value,
      source: { kind: 'name', field: 'magento_name_override.values.' + field.scope, productId: 7,
        bindingRevisionId: 'binding-a', definitionHash: f.observation.amber.compiled.hash, routeKey: 'CH:all' },
      mappingHash: 'b'.repeat(64) })) };
  return { ...f, session, command, progress: { session: structuredClone(session), fields: structuredClone(command.fields) } };
}
function verifiedLanguage(f, scope) {
  const value = scope === 'all' ? 'Accepted UA' : 'Local EN';
  if (scope === 'all') f.observation.raw.name = value;
  else f.observation.domainEvidence.english.fields.name = value;
  const row = f.progress.fields.find(field => field.scope === scope);
  row.state = 'name_received'; row.remote = { known: true, present: true, value };
  f.session.revision = String(BigInt(f.session.revision) + 1n);
  f.progress.session = structuredClone(f.session);
}

test('durable receipt retains original scopes through UA verification, restart, and the remaining EN write', () => {
  const f = durableFixture();
  assert.deepEqual(f.job.baseline.firstSyncNames, { sessionId: f.session.id, revision: '4', scopes: ['all', 'en'] });
  verifiedLanguage(f, 'all');
  const before = JSON.stringify(f), token = proof.issueFromLedger(f); assert.ok(token);
  assert.equal(proof.allows(f.observation, token), true);
  assert.equal(proof.baselineAllows(f.job, f.observation, token), true);
  assert.equal(proof.baselineObservationAllows(f.job, baselineObservation(f), f.observation, token), true);
  assert.equal(proof.baselineReceipt(f.observation, token, { sessionId: f.session.id, revision: '5' }), null,
    'a restart proof cannot authorize a new initial receipt reference');
  assert.equal(JSON.stringify(f), before);
});

test('both names verified before acknowledgement can reconstruct only their original job baseline', () => {
  const f = durableFixture(); verifiedLanguage(f, 'all'); verifiedLanguage(f, 'en');
  f.session.completed_at = '2026-10-09T12:00:00Z'; f.progress.session = structuredClone(f.session);
  assert.equal(names.decisionFor(f.observation).action, 'confirm');
  const token = proof.issueFromLedger(f); assert.ok(token);
  assert.equal(proof.baselineObservationAllows(f.job, baselineObservation(f), f.observation, token), true);
  const otherJob = structuredClone(f.job); otherJob.id = 'job-b';
  assert.equal(proof.baselineAllows(otherJob, f.observation, token), false);
});

test('a received name changed independently after restart remains blocked', () => {
  const f = durableFixture(); verifiedLanguage(f, 'all');
  f.observation.amber.nameState.baseline_names = { all: 'Old UA', en: 'Old EN' };
  f.observation.raw.name = 'Magento changed UA';
  assert.equal(names.decisionFor(f.observation).action, 'conflict');
  assert.equal(proof.issueFromLedger(f), null);
});

for (const [label, change] of [
  ['foreign session reference', f => { f.job.baseline.firstSyncNames.sessionId = '22222222-2222-4222-8222-222222222222'; }],
  ['wrong reference revision', f => { f.job.baseline.firstSyncNames.revision = '3'; }],
  ['omitted original pending scope', f => { f.job.baseline.firstSyncNames.scopes = ['en']; }],
  ['duplicate pending scope', f => { f.job.baseline.firstSyncNames.scopes = ['en', 'en']; }],
  ['changed origin', f => { f.session.origin_hash = 'origin-b'; f.progress.session = structuredClone(f.session); }],
  ['changed public identity', f => { f.session.public_product_identity_id = '18'; f.progress.session = structuredClone(f.session); }],
  ['changed session SKU', f => { f.session.public_sku = 'AG-000018'; f.progress.session = structuredClone(f.session); }],
  ['changed installation', f => { f.session.installation_key = 'installation-b'; f.progress.session = structuredClone(f.session); }],
  ['changed remote identity', f => { f.session.remote_product_id = '78'; f.progress.session = structuredClone(f.session); }],
  ['changed contract', f => { f.session.initial_contract_version = 'first-sync-v2'; f.command.identity.contractVersion = 'first-sync-v2'; f.progress.session = structuredClone(f.session); }],
  ['stale current progress', f => { f.progress.session.revision = '3'; }],
  ['future original reference', f => { f.session.revision = '3'; f.progress.session = structuredClone(f.session); }],
  ['wrong command revision', f => { f.command.expectedRevision = '2'; }],
  ['wrong command key', f => { f.command.key.publicIdentityId = '18'; }],
  ['non-ready original command', f => { f.command.readyForOutbound = false; }],
  ['initial pending name was received', f => { f.command.fields[0].state = 'name_received'; }],
  ['original remote not known', f => { f.command.fields[0].remote.known = false; }],
  ['original remote not empty', f => { f.command.fields[0].remote.value = 'Original UA'; }],
  ['original before differs from intent', f => { f.command.fields[0].before.value = 'Different UA'; }],
  ['original source belongs to another binding', f => { f.command.fields[0].source.bindingRevisionId = 'binding-b'; }],
  ['original source belongs to another product', f => { f.command.fields[0].source.productId = 8; }],
  ['original source definition changed', f => { f.command.fields[0].source.definitionHash = 'a'.repeat(64); }],
  ['latest mapping changed', f => { f.progress.fields[0].mappingHash = 'c'.repeat(64); }],
  ['latest scope unresolved', f => { f.progress.fields[0].state = 'review_required'; }],
  ['missing latest scope', f => { f.progress.fields.shift(); }],
  ['original manifest omits a name', f => { f.command.requiredScopes.shift(); }],
  ['current local name differs from intent', f => { f.observation.amber.product.magento_name_override = {
    generated: { all: 'Accepted UA', en: 'Local EN' }, values: { all: 'Manager UA', en: 'Local EN' } }; }],
  ['populated pending remote differs', f => { f.observation.raw.name = 'Unaccepted UA'; }],
]) test('durable name authority rejects ' + label, () => {
  const f = durableFixture(); change(f); assert.equal(proof.issueFromLedger(f), null);
});

test('baseline receipt rejects forged or stale proof and invalid revision', () => {
  const f = bothEmpty(), token = proof.issue({ ...f, job: null }); assert.ok(token);
  const reference = { sessionId: '11111111-1111-4111-8111-111111111111', revision: '4' };
  assert.equal(proof.baselineReceipt(f.observation, {}, reference), null);
  assert.equal(proof.baselineReceipt(f.observation, token, { ...reference, revision: '0' }), null);
  f.observation.raw.name = 'Changed UA';
  assert.equal(proof.baselineReceipt(f.observation, token, reference), null);
});

for (const receivedScopes of [['all'], ['en'], ['all', 'en']]) test('lost-response readback restores proof while receipts remain pending: ' + receivedScopes.join('/'), () => {
  const f = durableFixture();
  if (receivedScopes.includes('all')) f.observation.raw.name = 'Accepted UA';
  if (receivedScopes.includes('en')) f.observation.domainEvidence.english.fields.name = 'Local EN';
  const before = JSON.stringify(f), token = proof.issueFromLedger(f);
  assert.ok(token);
  assert.equal(proof.allows(f.observation, token), true);
  assert.equal(proof.baselineObservationAllows(f.job, baselineObservation(f), f.observation, token), true);
  assert.ok(f.progress.fields.every(field => field.state === 'pending_outward_confirmation'));
  assert.equal(JSON.stringify(f), before, 'proof neither imports names nor records successful verification');
});

for (const [label, change] of [
  ['wrong filled UA', f => { f.observation.raw.name = 'Other UA'; }],
  ['wrong filled EN', f => { f.observation.domainEvidence.english.fields.name = 'Other EN'; }],
  ['missing UA read', f => { delete f.observation.raw.name; }],
  ['missing EN read', f => { delete f.observation.domainEvidence.english.fields.name; }],
  ['failed English read', f => { f.observation.domainEvidence.failures.push({ operation: 'storeViews' }); }],
  ['altered latest pending empty evidence', f => { f.progress.fields[0].remote.value = 'Accepted UA'; }],
]) test('pending receipt successful-readback exception rejects ' + label, () => {
  const f = durableFixture();
  f.observation.raw.name = 'Accepted UA'; f.observation.domainEvidence.english.fields.name = 'Local EN';
  change(f); assert.equal(proof.issueFromLedger(f), null);
});

function historicalTerminalFixture({ corrected = false } = {}) {
  const f = durableFixture();
  const oldBinding = '33333333-3333-4333-8333-333333333333';
  const newBinding = '44444444-4444-4444-8444-444444444444';
  f.observation.amber.revision.id = newBinding; f.job.binding_revision_id = newBinding;
  f.session.initial_binding_revision_id = oldBinding; f.command.identity.initialBindingRevisionId = oldBinding;
  f.job.baseline.firstSyncNames.scopes = ['en']; f.job.baseline.raw.name = 'Accepted UA';
  f.observation.raw.name = 'Accepted UA';
  const ua = f.command.fields[0]; ua.state = 'name_received';
  ua.remote = { known: true, present: true, value: 'Accepted UA' };
  ua.source.bindingRevisionId = oldBinding; ua.source.definitionHash = 'a'.repeat(64); ua.mappingHash = 'd'.repeat(64);
  f.command.fields[1].source.bindingRevisionId = newBinding;
  if (corrected) {
    ua.source.productId = 6; f.session.initial_product_id = 6; f.command.identity.initialProductId = 6;
    f.history = { productId: 7, complete: true, identityChanged: false, issues: [],
      products: [{ productId: 6, article: 'AG-000017', status: 'corrected' }, { productId: 7, article: 'AG-000017', status: 'active' }] };
  }
  f.progress = { session: structuredClone(f.session), fields: structuredClone(f.command.fields) };
  f.progress.fields[0].revision = '2'; f.progress.fields[0].recordedAt = '2026-10-08T00:00:00Z';
  return f;
}

test('immutable terminal UA survives a newer binding while only EN retains initial-write authority', () => {
  const f = historicalTerminalFixture(), before = JSON.stringify(f), token = proof.issueFromLedger(f);
  assert.ok(token); assert.equal(proof.baselineObservationAllows(f.job, baselineObservation(f), f.observation, token), true);
  assert.equal(JSON.stringify(f), before, 'historical binding, definition, and mapping provenance is not rewritten');
  f.job.baseline.raw.name = '';
  assert.equal(proof.baselineAllows(f.job, f.observation, token), false, 'old UA receipt never becomes an initialization scope');
});

test('verified same-identity correction history preserves the ancestor terminal UA and session identity', () => {
  const f = historicalTerminalFixture({ corrected: true }), before = JSON.stringify(f), token = proof.issueFromLedger(f);
  assert.ok(token); assert.equal(proof.allows(f.observation, token), true);
  assert.equal(proof.baselineObservationAllows(f.job, baselineObservation(f), f.observation, token), true);
  assert.equal(JSON.stringify(f), before);
});

for (const [label, change] of [
  ['missing history', f => { delete f.history; }],
  ['incomplete history', f => { f.history.complete = false; }],
  ['identity-changing history', f => { f.history.identityChanged = true; }],
  ['history graph issue', f => { f.history.issues.push({ code: 'DISCONNECTED_IDENTITY_HISTORY' }); }],
  ['history for a foreign current product', f => { f.history.productId = 8; }],
  ['foreign article in history', f => { f.history.products[0].article = 'AG-000018'; }],
  ['missing ancestor', f => { f.history.products.shift(); }],
  ['missing current product', f => { f.history.products.pop(); }],
  ['duplicate history product', f => { f.history.products.push({ ...f.history.products[0] }); }],
  ['source outside verified component', f => { f.command.fields[0].source.productId = 5; f.progress.fields[0].source.productId = 5; }],
  ['changed session command initial product', f => { f.command.identity.initialProductId = 7; }],
  ['terminal source rewrite', f => { f.progress.fields[0].source.productId = 7; }],
  ['terminal mapping rewrite', f => { f.progress.fields[0].mappingHash = 'c'.repeat(64); }],
  ['terminal before value rewrite', f => { f.progress.fields[0].before.value = 'Different historic UA'; }],
  ['terminal language field malformed', f => { f.command.fields[0].source.field = 'magento_name_override.values.en'; f.progress.fields[0].source.field = 'magento_name_override.values.en'; }],
  ['terminal binding malformed', f => { f.command.fields[0].source.bindingRevisionId = ''; f.progress.fields[0].source.bindingRevisionId = ''; }],
  ['terminal definition hash malformed', f => { f.command.fields[0].source.definitionHash = 'bad'; f.progress.fields[0].source.definitionHash = 'bad'; }],
  ['pending EN old-binding source', f => { f.command.fields[1].source.bindingRevisionId = f.session.initial_binding_revision_id; f.progress.fields[1].source.bindingRevisionId = f.session.initial_binding_revision_id; }],
  ['pending EN ancestor source', f => { f.command.fields[1].source.productId = 6; f.progress.fields[1].source.productId = 6; }],
  ['received UA remote mismatch', f => { f.observation.raw.name = 'Different current UA'; }],
]) test('historical terminal receipt rejects ' + label, () => {
  const f = historicalTerminalFixture({ corrected: true }); change(f); assert.equal(proof.issueFromLedger(f), null);
});

test('historical terminal route keys preserve every ledger-supported length from 161 through 512', () => {
  const f = historicalTerminalFixture();
  for (let length = 161; length <= 512; length++) {
    const routeKey = 'r'.repeat(length);
    f.command.fields[0].source.routeKey = routeKey; f.progress.fields[0].source.routeKey = routeKey;
    assert.ok(proof.issueFromLedger(f), 'supported route-key length ' + length);
  }
});

test('historical terminal route keys reject overflow, surrounding whitespace, and ledger control characters', () => {
  const f = historicalTerminalFixture();
  const invalid = ['', 'r'.repeat(513), ' leading', 'trailing ', '\ttrimmed', 'trimmed\n',
    ...Array.from({ length: 32 }, (_, code) => 'route' + String.fromCharCode(code) + 'key'), 'route\u007fkey'];
  for (const routeKey of invalid) {
    f.command.fields[0].source.routeKey = routeKey; f.progress.fields[0].source.routeKey = routeKey;
    assert.equal(proof.issueFromLedger(f), null, 'invalid route key ' + JSON.stringify(routeKey));
  }
});
