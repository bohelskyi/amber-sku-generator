const test = require('node:test');
const assert = require('node:assert/strict');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { normalizeSchema, hash } = require('../src/services/magento/binding-contract');
const { normalizeBindings, requirements } = require('../src/services/magento/binding-validation');
const { assessOnClient, CODE } = require('../src/services/magento/first-sync-optional-receipt-audit');
const real = require('./fixtures/legacy-sv-schema6');
const saved = require('./fixtures/legacy-sv-publication.json');
const BINDING = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

function fixture({ optional = false, inactive = false, unknownRule = false, remoteRequired = false } = {}) {
  const publication = real.publication(), tables = structuredClone(saved.tables);
  // The copied read-only fixture omits review evidence; real SQL rows include its default object.
  for (const name of ['routes', 'attributes', 'options', 'field_policies']) {
    tables[name].forEach(row => { row.evidence ||= {}; });
  }
  if (optional) publication.definition.questionContracts['SV.stone_processing'].required = false;
  if (unknownRule) publication.definition.questionContracts['SV.stone_processing'].rule = { 'SV.color': 1 };
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
