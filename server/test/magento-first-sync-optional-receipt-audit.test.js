const test = require('node:test');
const assert = require('node:assert/strict');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { normalizeSchema, hash } = require('../src/services/magento/binding-contract');
const { normalizeBindings, requirements } = require('../src/services/magento/binding-validation');
const { assessOnClient, CODE } = require('../src/services/magento/first-sync-optional-receipt-audit');
const real = require('./fixtures/legacy-sv-schema6');
const saved = require('./fixtures/legacy-sv-publication.json');
const originalProof = require('./fixtures/first-sync-original-revision.json');
const BINDING = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

function fixture({ optional = false, inactive = false, unknownRule = false, remoteRequired = false, production = false } = {}) {
  const publication = real.publication(), tables = structuredClone(saved.tables);
  // The copied read-only fixture omits review evidence; real SQL rows include its default object.
  for (const name of ['routes', 'attributes', 'options', 'field_policies']) {
    tables[name].forEach(row => { row.evidence ||= {}; });
  }
  if (optional) publication.definition.questionContracts['SV.stone_processing'].required = false;
  if (unknownRule) publication.definition.questionContracts['SV.stone_processing'].rule = { 'SV.color': 1 };
  if (production) {
    // Exact production dependency slice, detached from unrelated private AST.
    for (const node of originalProof.bindings) publication.definition.bindings.find(b => b.id === node.id).value = structuredClone(node.value);
    Object.assign(publication.definition.questionContracts, structuredClone(originalProof.questionContracts));
    Object.assign(publication.definition.sources, structuredClone(originalProof.sources));
    Object.assign(publication.definition.tables, structuredClone(originalProof.tables));
  }
  if (remoteRequired) {
    publication.schema.attributes.find(a => a.attribute_code === 'kamin_obrobka').is_required = true;
    tables.schema_attributes.find(a => a.code === 'kamin_obrobka').metadata.is_required = true;
  }
  const compiled = compileDefinition(publication.definition), schema = normalizeSchema(publication.schema);
  const bindings = normalizeBindings(publication.bindings), plans = requirements(compiled.definition, schema);
  const row = { id: BINDING, state: 'published', installation_key: 'fixture', origin_hash: 'a'.repeat(64),
    template_id: TEMPLATE, template_version_id: VERSION, template_definition_hash: compiled.hash,
    evaluator_version: compiled.definition.evaluatorVersion, output_contract: compiled.definition.outputContract,
    format_version: compiled.definition.formatVersion, schema_fingerprint: hash(schema),
    topology_fingerprint: hash(schema.storeTopology), observation_store_code: 'all' };
  const version = { id: VERSION, template_id: TEMPLATE, definition_hash: compiled.hash,
    evaluator_version: row.evaluator_version, output_contract: row.output_contract,
    format_version: row.format_version, definition: publication.definition };
  const routeKey = inactive ? 'SV.souvenir!=value_id:5' : 'SV.souvenir=value_id:5';
  const target = 'kamin_obrobka', scope = 'all';
  const expected = plans.find(plan => plan.routeKey === routeKey).attributes.find(a => a.rowId === 'base' && a.target === target);
  const binding = bindings.attributes.find(a => a.bindingKey === expected?.bindingKey);
  const policy = bindings.policies.find(p => p.bindingKey === expected?.bindingKey && p.storeCode === scope);
  const cell = compiled.definition.groups.find(g => g.route === 'SV').rows.find(r => r.id === 'base').cells[target];
  const mappingHash = hash({ definitionHash: compiled.hash, routeKey, cell, binding: binding || null,
    policy: policy || null, attributeRequired: schema.attributes.find(a => a.attribute_code === target).is_required ?? null,
    options: bindings.options.filter(o => o.bindingKey === expected?.bindingKey) });
  const field = { target, scope, state: 'optional_empty', before: { known: true, present: false },
    remote: { known: true, present: false }, after: null, mappingHash,
    source: { ...(inactive ? { kind: 'derived', field: target } : { kind: 'semantic', key: 'stone_processing' }),
      productId: 1919, bindingRevisionId: BINDING, definitionHash: compiled.hash, routeKey, manifestHash: 'b'.repeat(64) } };
  const progress = { session: { id: SESSION, origin_hash: row.origin_hash, installation_key: row.installation_key,
    public_product_identity_id: '800', revision: '1', completed_at: null }, fields: [field] };
  const calls = [], controls = { binding: row, version, product: { public_product_identity_id: '800' }, tables };
  const client = { async query(sql, params) {
    calls.push({ sql, params });
    assert.match(sql, /^SELECT\b/);
    assert.doesNotMatch(sql, /FOR UPDATE|advisory|current_timestamp|version_number DESC/i);
    if (sql.includes('FROM products ')) {
      assert.equal(sql, 'SELECT public_product_identity_id FROM products WHERE id=$1');
      assert.deepEqual(params, [1919]);
      return { rows: controls.product ? [structuredClone(controls.product)] : [] };
    }
    if (sql.includes('FROM export_template_versions')) {
      assert.deepEqual(params, [VERSION]);
      return { rows: controls.version ? [structuredClone(controls.version)] : [] };
    }
    if (sql.includes('FROM magento_first_sync_progress')) {
      assert.deepEqual(params, [SESSION, '1']);
      return { rows: controls.originalCommand ? [structuredClone(controls.originalCommand)] : [] };
    }
    assert.deepEqual(params, [BINDING]);
    const table = /FROM magento_binding_([a-z_]+)/.exec(sql)?.[1];
    if (table === 'revisions') return { rows: controls.binding ? [structuredClone(controls.binding)] : [] };
    assert.ok(Object.hasOwn(controls.tables, table), table);
    return { rows: structuredClone(controls.tables[table]) };
  } };
  return { client, calls, controls, progress, field, row, version, compiled };
}

test('no optional receipts performs no publication or product reads', async () => {
  const client = { query() { assert.fail('unexpected database read'); } };
  for (const progress of [null, { fields: [] }, { fields: [{ state: 'equal' }] }]) {
    const result = await assessOnClient(client, progress);
    assert.deepEqual(result.blockers, []); assert.deepEqual(result.evidence, []);
    assert.equal(result.evidenceHash, hash([]));
  }
});

function originalCommandFixture() {
  const f = fixture({ production: true }), routeKey = 'SV.souvenir!=value_id:5';
  const publication = real.publication(), bindings = normalizeBindings(publication.bindings);
  const plans = requirements(f.compiled.definition, normalizeSchema(publication.schema));
  const route = plans.find(p => p.routeKey === routeKey);
  const cells = f.compiled.definition.groups.find(g => g.route === 'SV').rows.find(r => r.id === 'base').cells;
  const records = originalProof.records.map(savedField => {
    const { key, originalMappingHash, ...field } = structuredClone(savedField);
    assert.match(originalMappingHash, /^[a-f0-9]{64}$/);
    const expected = route.attributes.find(a => a.rowId === 'base' && a.target === field.target);
    const binding = bindings.attributes.find(a => a.bindingKey === expected?.bindingKey);
    const policy = bindings.policies.find(p => p.bindingKey === expected?.bindingKey && p.storeCode === field.scope);
    return { ...field, source: { kind: 'semantic', key, productId: 1919, bindingRevisionId: BINDING,
      definitionHash: f.compiled.hash, routeKey, manifestHash: 'b'.repeat(64) },
    mappingHash: hash({ definitionHash: f.compiled.hash, routeKey, cell: cells[field.target],
      binding: binding || null, policy: policy || null,
      attributeRequired: publication.schema.attributes.find(a => a.attribute_code === field.target).is_required ?? null,
      options: bindings.options.filter(o => o.bindingKey === expected?.bindingKey) }) };
  });
  Object.assign(f.progress.session, { public_sku: 'fixture-sku', remote_product_id: '2979',
    initial_product_id: 1919, initial_binding_revision_id: BINDING, revision: '2' });
  f.progress.fields = records.filter(p => p.state === 'optional_empty').map(p => ({ ...structuredClone(p), revision: '1' }));
  const command = { key: { originHash: f.row.origin_hash, publicIdentityId: '800' },
    identity: { installationKey: f.row.installation_key, publicSku: 'fixture-sku', remoteProductId: '2979',
      initialProductId: 1919, initialBindingRevisionId: BINDING }, fields: records };
  f.controls.originalCommand = { session_id: SESSION, revision: '1', command, command_hash: hash(command) };
  f.seal = () => { f.controls.originalCommand.command_hash = hash(f.controls.originalCommand.command); };
  return f;
}

test('exact production conditional AST and original canonical observations prove all six old receipts without writes', async () => {
  assert.equal(originalProof.provenance.definitionHash, '898b6b6a1586d65f355d6aef188c9cc1fe2ca32ad4c7b4ccf3e966334eca9821');
  for (const completed of [null, '2026-10-10T12:00:00Z']) {
    const f = originalCommandFixture(); f.progress.session.completed_at = completed;
    f.progress.currentProduct = { details: { answers: { souvenir: 1, statuette: 1, '2': 2 } } };
    const before = JSON.stringify({ progress: f.progress, controls: f.controls });
    const result = await assessOnClient(f.client, f.progress);
    assert.deepEqual(result.blockers, []); assert.equal(result.evidence.length, 6);
    assert.ok(result.evidence.every(p => p.state === 'inactive'));
    assert.equal(f.calls.filter(c => c.sql.includes('FROM magento_first_sync_progress')).length, 1);
    assert.equal(JSON.stringify({ progress: f.progress, controls: f.controls }), before);
  }
});

test('historical evidence read, hash, identity, membership and bounds fail closed', async () => {
  for (const mutation of [
    f => { f.controls.originalCommand = null; },
    f => { f.controls.originalCommand.command_hash = '0'.repeat(64); },
    f => { f.controls.originalCommand.revision = '2'; },
    f => { f.controls.originalCommand.session_id = VERSION; },
    f => { f.controls.originalCommand.command.key.publicIdentityId = '801'; f.seal(); },
    f => { f.controls.originalCommand.command.identity.initialProductId = 1920; f.seal(); },
    f => { f.controls.originalCommand.command.fields = []; f.seal(); },
    f => { f.controls.originalCommand.command.padding = 'x'.repeat(1048576); f.seal(); },
    f => { f.controls.originalCommand.command.fields.push(...Array.from({ length: 501 }, () => ({}))); f.seal(); },
    f => { f.progress.fields.forEach(p => { p.revision = '3'; }); },
  ]) {
    const f = originalCommandFixture(); mutation(f);
    const result = await assessOnClient(f.client, f.progress);
    assert.equal(result.blockers.length, 6); assert.ok(result.evidence.every(p => p.state === 'unproven'));
  }
});

test('unproven, changed, contradictory or differently bound parents cannot prove historical inactivity', async () => {
  for (const mutation of [
    p => { p.before = { known: false }; },
    p => { p.before = { known: true, present: false, value: false }; },
    p => { p.before = { known: true, present: true, value: '4.0' }; },
    p => { p.before = { known: true, present: true, value: 99 }; },
    p => { p.source.productId = 1920; },
    p => { p.source.bindingRevisionId = VERSION; },
    p => { p.source.definitionHash = '0'.repeat(64); },
    p => { p.source.routeKey = 'SV.souvenir=value_id:5'; },
    p => { p.source.manifestHash = '0'.repeat(64); },
    p => { p.mappingHash = '0'.repeat(64); },
    p => { p.state = 'imported'; p.source.decision = 'accept_remote'; },
  ]) {
    const f = originalCommandFixture(), parent = f.controls.originalCommand.command.fields.find(p => p.target === 'suveniry');
    mutation(parent); f.seal();
    const result = await assessOnClient(f.client, f.progress);
    assert.ok(result.blockers.some(b => b.target === 'vyd_statuetky')); assert.ok(result.blockers.some(b => b.target === 'nastlni_ihry'));
  }
  const f = originalCommandFixture(), parent = f.controls.originalCommand.command.fields.find(p => p.target === 'suveniry');
  const other = structuredClone(parent); other.before.value = 1;
  f.controls.originalCommand.command.fields.push(other); f.seal();
  assert.ok((await assessOnClient(f.client, f.progress)).blockers.length > 0);
});

test('original required question active at the historical before value stays blocked regardless of later after', async () => {
  const f = originalCommandFixture(), parent = f.controls.originalCommand.command.fields.find(p => p.target === 'suveniry');
  parent.before.value = 1; parent.after = 4; f.seal();
  const result = await assessOnClient(f.client, f.progress);
  assert.equal(result.evidence.find(p => p.target === 'vyd_statuetky').state, 'required');
  assert.ok(result.blockers.some(p => p.target === 'vyd_statuetky'));
});

test('known absence follows evaluator scalar semantics while malformed frozen evidence never uses fallback', async () => {
  const classify = require('../src/services/magento/first-sync-semantic-requirement').classifySemanticRequirement;
  const f = originalCommandFixture(), definition = structuredClone(f.compiled.definition);
  definition.questionContracts['SV.2'].rule = { 'SV.statuette': 0 };
  const compiled = compileDefinition(definition), field = f.progress.fields.find(p => p.target === 'tematyka_vyrobu');
  for (const [observation, expected] of [[{ known: true, present: false }, 'inactive'],
    [{ known: true, present: false, value: null }, 'inactive'], [{ known: true, present: false, value: '' }, 'required'],
    [{ known: true, present: true, value: 0 }, 'required'], [{ known: true, present: false, value: false }, 'unproven']]) {
    const source = { ...field.source, definitionHash: compiled.hash, requirednessEvidence: { version: 1,
      definitionHash: compiled.hash, routeKey: field.source.routeKey, target: field.target, scope: field.scope,
      values: { 'SV.statuette': observation } } };
    assert.equal(classify({ compiled, target: field.target, scope: field.scope, source }).state, expected);
  }
  for (const receipt of f.progress.fields) receipt.source.requirednessEvidence = { version: 0 };
  const result = await assessOnClient(f.client, f.progress);
  assert.equal(result.blockers.length, 6); assert.equal(f.calls.some(c => c.sql.includes('FROM magento_first_sync_progress')), false);
});

test('old active required semantic receipt blocks incomplete and completed sessions without changing receipts', async () => {
  const f = fixture();
  for (const completed of [null, '2026-10-10T12:00:00Z']) {
    f.progress.session.completed_at = completed;
    const before = JSON.stringify(f.progress), result = await assessOnClient(f.client, f.progress);
    assert.equal(result.blockers[0].code, CODE);
    assert.equal(result.evidence[0].state, 'required');
    assert.ok(result.evidence[0].questionIds.includes('SV.stone_processing'));
    assert.equal(JSON.stringify(f.progress), before);
  }
});

test('original optional and route-proven inactive fields retain their permanent receipts', async () => {
  for (const options of [{ optional: true }, { inactive: true }]) {
    const f = fixture(options), result = await assessOnClient(f.client, f.progress);
    assert.deepEqual(result.blockers, []);
    assert.equal(result.evidence[0].state, options.inactive ? 'inactive' : 'optional');
  }
});

test('historical activation absent from original route remains unproven without using current answers', async () => {
  const f = fixture({ unknownRule: true });
  f.progress.currentProduct = { details: { answers: { color: 2, souvenir: 4 } } };
  f.controls.product.details = f.progress.currentProduct.details;
  const result = await assessOnClient(f.client, f.progress);
  assert.equal(result.evidence[0].state, 'unproven');
  assert.equal(result.blockers[0].code, CODE);
  assert.ok(f.calls.every(call => !/SELECT.*details/i.test(call.sql)));
});

test('new frozen predicate evidence proves original inactivity and rejects corrupted proof', async () => {
  const f = fixture({ unknownRule: true });
  const classified = require('../src/services/magento/first-sync-semantic-requirement').classifySemanticRequirement({
    compiled: f.compiled, target: f.field.target, scope: f.field.scope, source: f.field.source,
    product: { category: 'SV', details: { answers: { souvenir: 5, color: 2 } } },
  });
  assert.equal(classified.state, 'inactive');
  assert.ok(classified.evidence);
  f.field.source.requirednessEvidence = classified.evidence;
  f.progress.currentProduct = { category: 'SV', details: { answers: { souvenir: 5, color: 1 } } };
  assert.deepEqual((await assessOnClient(f.client, f.progress)).blockers, []);
  for (const mutate of [
    proof => { proof.definitionHash = '0'.repeat(64); },
    proof => { proof.routeKey = 'SV:all'; },
    proof => { proof.target = 'kolir'; },
    proof => { proof.values['SV.color'] = { known: false }; },
    proof => { proof.values['SV.souvenir'] = { known: true, present: true, value: 4 }; },
  ]) {
    f.field.source.requirednessEvidence = structuredClone(classified.evidence);
    mutate(f.field.source.requirednessEvidence);
    const result = await assessOnClient(f.client, f.progress);
    assert.equal(result.blockers[0].code, CODE); assert.equal(result.evidence[0].state, 'unproven');
  }
});

test('original native required metadata cannot be absolved by optional semantic metadata', async () => {
  const f = fixture({ optional: true, remoteRequired: true });
  const result = await assessOnClient(f.client, f.progress);
  assert.equal(result.evidence[0].state, 'required');
  assert.equal(result.blockers[0].reason, 'ORIGINAL_REQUIRED_FIELD_EMPTY');
});

test('saved original publication is required even when a hypothetical current publication is optional', async () => {
  const f = fixture();
  f.progress.currentBinding = { id: '99999999-9999-4999-8999-999999999999', definition: fixture({ optional: true }).version.definition };
  assert.equal((await assessOnClient(f.client, f.progress)).evidence[0].state, 'required');
  for (const mutation of [
    v => { v.controls.binding = null; },
    v => { v.row.state = 'draft'; },
    v => { v.controls.version = null; },
    v => { v.version.definition_hash = '0'.repeat(64); },
    v => { v.row.template_definition_hash = '0'.repeat(64); },
    v => { v.row.schema_fingerprint = '0'.repeat(64); },
    v => { v.row.origin_hash = '0'.repeat(64); },
  ]) {
    const changed = fixture({ optional: true }); mutation(changed);
    const result = await assessOnClient(changed.client, changed.progress);
    assert.equal(result.blockers[0].code, CODE); assert.equal(result.evidence[0].state, 'unproven');
  }
});

test('malformed or populated alleged empty evidence is never a safe optional receipt', async () => {
  for (const mutate of [
    f => { f.field.before = { known: false }; },
    f => { f.field.remote = { known: true, present: true, value: 0 }; },
    f => { f.field.remote = { known: true, present: false, value: false }; },
    f => { f.field.after = 0; },
    f => { delete f.field.source.productId; },
    f => { delete f.field.source.manifestHash; },
    f => { f.field.source.decision = null; },
    f => { f.field.source.field = 'stone_processing'; },
    f => { f.field.source.key = ''; },
    f => { f.field.source.kind = 'unverified'; },
  ]) {
    const f = fixture({ optional: true }); mutate(f);
    const result = await assessOnClient(f.client, f.progress);
    assert.equal(result.blockers[0].code, CODE); assert.equal(result.evidence[0].state, 'unproven');
    assert.equal(f.calls.length, 0);
  }
});

test('mapping, route and originating product identity must match immutable evidence', async () => {
  for (const mutate of [
    f => { f.field.mappingHash = '0'.repeat(64); },
    f => { f.field.source.routeKey = 'SV:all'; },
    f => { f.field.source.definitionHash = '0'.repeat(64); },
    f => { f.field.source.key = 'color'; },
    f => { f.controls.product.public_product_identity_id = '801'; },
    f => { f.controls.product = null; },
  ]) {
    const f = fixture({ optional: true }); mutate(f);
    const result = await assessOnClient(f.client, f.progress);
    assert.equal(result.blockers[0].code, CODE); assert.equal(result.evidence[0].state, 'unproven');
  }
});

test('read failure fails closed and evidence hashes are stable across reloaded timestamps', async () => {
  const f = fixture({ inactive: true });
  f.field.revision = '1'; f.field.recordedAt = new Date('2026-10-10T12:00:00Z');
  const first = await assessOnClient(f.client, f.progress);
  f.field.recordedAt = new Date('2026-10-10T12:00:00Z');
  assert.equal((await assessOnClient(f.client, f.progress)).evidenceHash, first.evidenceHash);
  const failed = await assessOnClient({ async query() { throw new Error('private database error'); } }, f.progress);
  assert.equal(failed.blockers[0].code, CODE);
  assert.equal(JSON.stringify(failed).includes('private database error'), false);
});

test('duplicate optional receipts and oversized sets fail closed', async () => {
  const f = fixture({ inactive: true });
  f.progress.fields.push(structuredClone(f.field));
  assert.equal((await assessOnClient(f.client, f.progress)).blockers[0].reason, 'ORIGINAL_RECEIPT_DUPLICATE');
  assert.equal(f.calls.filter(call => call.sql.includes('FROM magento_binding_revisions')).length, 1);
  assert.equal(f.calls.filter(call => call.sql.includes('FROM products ')).length, 1);
  const oversized = await assessOnClient(f.client, { fields: Array(501).fill(f.field) });
  assert.equal(oversized.blockers[0].reason, 'ORIGINAL_RECEIPT_SET_UNPROVEN');
});

test('distinct original publication reads are capped and the remainder explicitly blocks', async () => {
  const f = fixture();
  f.progress.fields = Array.from({ length: 33 }, (_, index) => ({ ...structuredClone(f.field),
    target: 'field_' + index, source: { ...f.field.source,
      bindingRevisionId: '11111111-1111-4111-8111-' + index.toString(16).padStart(12, '0') } }));
  let publications = 0;
  const result = await assessOnClient({ async query(sql) {
    assert.match(sql, /^SELECT\b/);
    if (sql.includes('FROM products ')) return { rows: [{ public_product_identity_id: '800' }] };
    assert.ok(sql.includes('FROM magento_binding_revisions')); publications++;
    return { rows: [] };
  } }, f.progress);
  assert.equal(publications, 32);
  assert.equal(result.blockers.length, 33);
  assert.equal(result.blockers.at(-1).reason, 'ORIGINAL_PUBLICATION_AUDIT_LIMIT');
});
