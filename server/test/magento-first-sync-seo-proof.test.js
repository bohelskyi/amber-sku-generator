const test = require('node:test');
const assert = require('node:assert/strict');
const seo = require('../src/services/magento/first-sync-seo-proof');
const preview = require('../src/services/magento/sync-preview');
const plan = require('../src/services/magento/sync-job-plan');
const { hash } = require('../src/services/magento/binding-contract');
const { planFirstSyncFields } = require('../src/services/magento/first-sync-field-plan');
const { prepareProgress } = require('../src/services/magento/first-sync-progress-plan');

const bindingId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const present = value => ({ known: true, present: true, value });
const attributes = ['meta_title', 'meta_description'];
const codes = product => (product?.custom_attributes || []).map(a => a.attribute_code);
const error = { code: 'MAGENTO_FIRST_SYNC_SEO_RECEIPT_CHANGED' };

// Synthetic NM data only; the four populated remote values deliberately differ
// from the active templates, and the physical weight remains Manager-owned.
function fixture() {
  const product = { id: 7, public_product_identity_id: '17', public_sku: 'NM-fixture-17', category: 'NM', weight: '22.000' };
  const schema = { attributes: attributes.map((attribute_code, index) => ({ attribute_code,
    attribute_id: 50 + index, frontend_input: index ? 'textarea' : 'text', scope: 'store' })) };
  const observation = { amber: { product, compiled: { hash: 'a'.repeat(64) }, revision: {
    id: bindingId, installationKey: 'fixture_shop', originHash: 'b'.repeat(64), schema: structuredClone(schema) } },
  schema, raw: { id: 77, sku: product.public_sku, name: 'Received UA name', status: 2,
    custom_attributes: attributes.map(attribute_code => ({ attribute_code, value: 'Magento UA ' + attribute_code })) },
  domainEvidence: { english: { id: 77, sku: product.public_sku,
    fields: Object.fromEntries(attributes.map(target => [target, 'Magento EN ' + target])), preservedFieldHashes: {} }, failures: [] } };
  const prepared = { readyForOutbound: true, blockers: [], rows: [] }, projection = { projection: [] };
  for (const scope of ['all', 'en']) for (const target of attributes) {
    const value = scope === 'all' ? observation.raw.custom_attributes.find(a => a.attribute_code === target).value
      : observation.domainEvidence.english.fields[target];
    const record = { target, scope, state: seo.PENDING, before: present('Active template ' + scope + ' ' + target),
      remote: present(value), after: value, mappingHash: hash(scope + '/' + target), source: {
        kind: 'seo_snapshot', field: target, category: 'NM', seoContract: seo.CONTRACT,
        productId: product.id, bindingRevisionId: bindingId, definitionHash: observation.amber.compiled.hash, routeKey: 'NM' } };
    prepared.rows.push({ target, scope, status: seo.PENDING, record });
    projection.projection.push({ target, scope, persistence: 'seo_snapshot', mappingHash: record.mappingHash });
  }
  const other = { target: 'vaha_vyrobu', scope: 'all', state: 'outward_verified', before: present('22.000'),
    remote: present('22'), after: '22.000', mappingHash: hash('physical-weight'), source: {
      kind: 'product', field: 'weight', productId: product.id, bindingRevisionId: bindingId,
      definitionHash: observation.amber.compiled.hash, routeKey: 'NM', decision: 'keep_local' } };
  const progress = { session: { id: sessionId, revision: '2', public_sku: product.public_sku,
    public_product_identity_id: product.public_product_identity_id, origin_hash: observation.amber.revision.originHash,
    remote_product_id: '77', installation_key: 'fixture_shop' },
  fields: [...prepared.rows.map(row => structuredClone(row.record)), other] };
  const command = { key: { originHash: progress.session.origin_hash, publicIdentityId: '17' }, expectedRevision: '1',
    fields: structuredClone(progress.fields), requiredScopes: progress.fields.map(({target, scope}) => ({target, scope})), readyForOutbound: true };
  const report = { mode: 'update', sendable: true, blockers: [], categories: { current: [] }, candidatePayload: { product: {
    sku: product.public_sku, price: 100, custom_attributes: [
      ...attributes.map(attribute_code => ({ attribute_code, value: 'Active UA template ' + attribute_code })),
      { attribute_code: 'vaha_vyrobu', value: '22.000' }],
    extension_attributes: { category_links: [{ category_id: '10', position: 0 }] } } },
  diff: [...attributes.map(target => ({ target, action: 'would_update', includedInPayload: true })),
    { target: 'vaha_vyrobu', action: 'would_update', includedInPayload: true }],
  transport: { inventory: { candidatePayload: null }, websites: { requested: [], operations: [] }, storeViews: {
    action: 'would_update', preservedFields: [], diff: [...attributes.map(target => ({ target, candidate: 'Active EN template ' + target,
      action: 'would_update', authority: 'authoritative' })), { target: 'short_description', candidate: 'Active EN description',
      action: 'would_update', authority: 'authoritative' }], candidatePayload: { product: { sku: product.public_sku, custom_attributes: [
        ...attributes.map(attribute_code => ({ attribute_code, value: 'Active EN template ' + attribute_code })),
        { attribute_code: 'short_description', value: 'Active EN description' }] } } } } };
  return { observation, prepared, projection, progress, command, report };
}

function durable(f = fixture()) {
  const token = seo.issue(f.observation, f.prepared, f.projection);
  assert.ok(token);
  const report = preview.applyFirstSyncSeoProof(f.report, f.observation, token);
  const intent = plan.intent(report);
  const job = { id: '33333333-3333-4333-8333-333333333333', product_id: 7, public_product_identity_id: '17',
    sku: f.observation.raw.sku, binding_revision_id: bindingId, origin_hash: f.progress.session.origin_hash,
    installation_key: 'fixture_shop', plan_hash: hash(intent), intent,
    baseline: { raw: structuredClone(f.observation.raw), domainEvidence: structuredClone(f.observation.domainEvidence),
      firstSyncSeo: seo.baselineReceipt(f.observation, token, f.progress) } };
  return { ...f, job };
}

test('four populated Magento SEO snapshots omit only their core/EN payloads and English expected writes', () => {
  const f = fixture(), before = structuredClone(f), token = seo.issue(f.observation, f.prepared, f.projection);
  assert.ok(token); assert.equal(Object.isFrozen(token), true); assert.equal(seo.allows(f.observation, token), true);
  const report = preview.applyFirstSyncSeoProof(f.report, f.observation, token), intent = plan.intent(report);
  assert.deepEqual(codes(report.candidatePayload.product), ['vaha_vyrobu']);
  assert.deepEqual(codes(report.sendability.operations.coreProduct.candidatePayload.product), ['vaha_vyrobu']);
  assert.deepEqual(codes(report.transport.storeViews.candidatePayload.product), ['short_description']);
  assert.deepEqual(intent.englishValues, { short_description: 'Active EN description' });
  assert.deepEqual(report.transport.storeViews.preservedFields.sort(), attributes.slice().sort());
  assert.equal(report.diff.find(d => d.target === 'vaha_vyrobu').includedInPayload, true);
  assert.equal(report.candidatePayload.product.price, 100);
  assert.deepEqual(report.candidatePayload.product.extension_attributes, before.report.candidatePayload.product.extension_attributes);
  assert.ok(report.diff.filter(d => attributes.includes(d.target)).every(d => d.action === 'preserve' && !d.includedInPayload));
  assert.deepEqual(f, before, 'no local product, template, receipt, observation or original report is changed');
});

test('SEO-only English payload is removed while unrelated core writes remain', () => {
  const f = fixture(); f.report.transport.storeViews.diff.pop(); f.report.transport.storeViews.candidatePayload.product.custom_attributes.pop();
  const report = preview.applyFirstSyncSeoProof(f.report, f.observation, seo.issue(f.observation, f.prepared, f.projection));
  assert.equal(report.transport.storeViews.candidatePayload, null); assert.equal(report.transport.storeViews.action, 'unchanged');
  assert.deepEqual(plan.intent(report).englishValues, {});
  assert.equal(plan.intent(report).operations.length, 2, 'core plus exact category-link addition; no store-view POST');
});

for (const [label, change] of [
  ['non-NM category', f => { f.observation.amber.product.category = 'SV'; }],
  ['wrong current product', f => { f.observation.amber.product.id++; }],
  ['wrong SKU identity', f => { f.observation.raw.sku = 'NM-other'; }],
  ['unavailable remote', f => { f.observation.raw = null; }],
  ['unsafe remote ID', f => { f.observation.raw.id = 1.5; }],
  ['foreign EN product', f => { f.observation.domainEvidence.english.id++; }],
  ['foreign EN SKU', f => { f.observation.domainEvidence.english.sku = 'NM-other'; }],
  ['failed English GET', f => { f.observation.domainEvidence.failures.push({ operation: 'storeViews' }); }],
  ['missing English value', f => { delete f.observation.domainEvidence.english.fields.meta_title; }],
  ['duplicate native attribute', f => { f.observation.raw.custom_attributes.push({ ...f.observation.raw.custom_attributes[0] }); }],
  ['unknown accepted read', f => { f.prepared.rows[0].record.remote.known = false; }],
  ['malformed remote text', f => { f.prepared.rows[0].record.after = 42; }],
  ['control character in remote text', f => { f.prepared.rows[0].record.after = 'bad\nvalue'; }],
  ['non-SEO target', f => { f.prepared.rows[0].record.target = 'description'; }],
  ['unsupported scope', f => { f.prepared.rows[0].record.scope = 'fr'; }],
  ['duplicate receipt scope', f => { f.prepared.rows.push(structuredClone(f.prepared.rows[0])); }],
  ['foreign binding provenance', f => { f.prepared.rows[0].record.source.bindingRevisionId = '44444444-4444-4444-8444-444444444444'; }],
  ['foreign definition provenance', f => { f.prepared.rows[0].record.source.definitionHash = 'c'.repeat(64); }],
  ['different metadata identity', f => { f.observation.schema.attributes[0].attribute_id++; }],
  ['unsupported metadata input', f => { f.observation.schema.attributes[0].frontend_input = 'select'; }],
  ['unsupported EN global metadata', f => { f.observation.schema.attributes[0].scope = 'global'; }],
  ['unproven projection', f => { f.projection.projection[0].reason = 'FIELD_BINDING_NOT_APPROVED'; }],
  ['unverified projection read', f => { f.projection.projection[0].readReason = 'REMOTE_READ_UNKNOWN'; }],
  ['unresolved other business field', f => { f.prepared.readyForOutbound = false; f.prepared.blockers.push({ code: 'FIRST_SYNC_FIELD_CONFLICT' }); }],
]) test('SEO proof rejects ' + label, () => {
  const f = fixture(); change(f); assert.equal(seo.issue(f.observation, f.prepared, f.projection), null);
});

test('opaque proof cannot be forged or reused after remote/schema/binding drift', () => {
  const f = fixture(), token = seo.issue(f.observation, f.prepared, f.projection);
  assert.equal(seo.allows(f.observation, {}), false);
  assert.throws(() => seo.baselineReceipt(f.observation, {}, f.progress), error);
  assert.throws(() => preview.applyFirstSyncSeoProof(f.report, f.observation, {}), error);
  for (const mutate of [o => { o.raw.custom_attributes[0].value += ' changed'; }, o => { o.amber.revision.id = 'new-binding'; },
    o => { o.amber.compiled.hash = 'c'.repeat(64); }, o => { o.schema.attributes[0].is_required = true; }]) {
    const changed = structuredClone(f.observation); mutate(changed);
    assert.equal(seo.allows(changed, token), false);
    assert.throws(() => preview.applyFirstSyncSeoProof(f.report, changed, token), error);
  }
});

test('durable recovery proof binds the original job, preserves snapshots, and supports baseline replan inputs', () => {
  const f = durable(), before = structuredClone(f), token = seo.restore(f);
  assert.ok(token); assert.equal(seo.allows(f.observation, token), false, 'recovery token needs its own job');
  assert.equal(seo.allows(f.observation, token, f.job), true);
  const baselineObservation = { ...f.observation, raw: f.job.baseline.raw, domainEvidence: f.job.baseline.domainEvidence };
  const report = preview.applyFirstSyncSeoProof(f.report, baselineObservation, token, { job: f.job, freshObservation: f.observation });
  assert.deepEqual(plan.intent(report), f.job.intent);
  assert.deepEqual(f, before, 'reconstruction performs no receipt or product mutation');
  const wrongJob = structuredClone(f.job); wrongJob.id = '55555555-5555-4555-8555-555555555555';
  assert.equal(seo.allows(f.observation, token, wrongJob), false);
  assert.throws(() => preview.applyFirstSyncSeoProof(f.report, f.observation, token, { job: wrongJob }), error);
});

for (const [label, change] of [
  ['missing durable reference', f => { delete f.job.baseline.firstSyncSeo; }],
  ['foreign session reference', f => { f.job.baseline.firstSyncSeo.sessionId = 'other-session'; }],
  ['wrong job identity', f => { f.job.public_product_identity_id = '18'; }],
  ['wrong original command identity', f => { f.command.key.publicIdentityId = '18'; }],
  ['foreign progress origin', f => { f.progress.session.origin_hash = 'c'.repeat(64); }],
  ['foreign progress public identity', f => { f.progress.session.public_product_identity_id = '18'; }],
  ['progress older than baseline receipt', f => { f.progress.session.revision = '1'; }],
  ['invalid zero reference revision', f => { f.job.baseline.firstSyncSeo.revision = '0'; }],
  ['duplicate reference scope', f => { f.job.baseline.firstSyncSeo.fields[1] = structuredClone(f.job.baseline.firstSyncSeo.fields[0]); }],
  ['CREATE job cannot inherit SEO snapshot', f => { f.job.intent.mode = 'create'; }],
  ['wrong reference snapshot hash', f => { f.job.baseline.firstSyncSeo.fields[0].valueHash = 'f'.repeat(64); }],
  ['wrong reference mapping hash', f => { f.job.baseline.firstSyncSeo.fields[0].mappingHash = 'f'.repeat(64); }],
  ['snapshot replaced in latest progress', f => { f.progress.fields[0].after = 'Changed'; }],
  ['latest mapping changed', f => { f.progress.fields[0].mappingHash = 'f'.repeat(64); }],
  ['core SEO write resurrected', f => { f.job.intent.operations[0].payload.product.custom_attributes.push({ attribute_code: 'meta_title', value: 'Template' }); }],
  ['English SEO write resurrected', f => { f.job.intent.operations.find(op => op.domain === 'storeViews').payload.product.custom_attributes.push({ attribute_code: 'meta_title', value: 'Template' }); }],
  ['English expectation resurrected', f => { f.job.intent.englishValues.meta_title = 'Template'; }],
  ['fresh remote SEO changed', f => { f.observation.domainEvidence.english.fields.meta_title = 'Changed externally'; }],
]) test('durable SEO proof rejects ' + label, () => {
  const f = durable(); change(f); assert.equal(seo.restore(f), null);
});

test('ack transitions only pending SEO, keeps weight evidence, and repeated same-job receipt is stable', () => {
  const f = durable(), token = seo.restore(f), before = structuredClone(f.progress);
  const fields = seo.receivedFields(f.progress, token, f.job);
  assert.equal(fields.filter(f => f.state === seo.RECEIVED).length, 4);
  assert.deepEqual(fields.at(-1), before.fields.at(-1));
  assert.ok(fields.slice(0, 4).every(field => field.source.seoDelivery.jobId === f.job.id
    && field.source.seoDelivery.planHash === f.job.plan_hash));
  assert.deepEqual(f.progress, before, 'ack construction is pure; ledger transaction owns persistence');
  const received = { ...f.progress, fields };
  assert.deepEqual(seo.receivedFields(received, token, f.job), fields, 'no second terminal transition is constructed');
  const wrongJob = { ...f.job, id: '55555555-5555-4555-8555-555555555555' };
  assert.throws(() => seo.receivedFields(received, token, wrongJob), error);
  assert.throws(() => seo.receivedFields(f.progress, token, wrongJob), error);
});

test('old equal SEO receipt is shielded beside new pending scopes and remains byte-for-byte equal at ack', () => {
  const f = fixture(), old = f.prepared.rows[0].record;
  old.state = 'equal'; old.before = present(old.after); old.source = { ...old.source, kind: 'derived' };
  delete old.source.category; delete old.source.seoContract;
  f.progress.fields[0] = structuredClone(old); f.command.fields[0] = structuredClone(old);
  const d = durable(f), token = seo.restore(d), fields = seo.receivedFields(d.progress, token, d.job);
  assert.deepEqual(fields[0], old); assert.equal(fields.filter(f => f.state === seo.RECEIVED).length, 3);
  assert.deepEqual(codes(d.job.intent.operations[0].payload.product), ['vaha_vyrobu']);
});

test('ordinary generation without proof retains active SEO template writes and never opens a completed first phase', () => {
  const f = fixture();
  assert.equal(preview.applyFirstSyncSeoProof(f.report, f.observation, null), f.report);
  for (const row of f.prepared.rows) row.record.state = 'equal';
  assert.equal(seo.issue(f.observation, f.prepared, f.projection), null);
  assert.deepEqual(codes(f.report.candidatePayload.product), ['meta_title', 'meta_description', 'vaha_vyrobu']);
  assert.throws(() => preview.applyFirstSyncSeoProof(f.report, f.observation, null, { job: durable().job }), error);
});

test('preview-owned token cannot acknowledge a job or attach a foreign progress identity', () => {
  const f = fixture(), token = seo.issue(f.observation, f.prepared, f.projection);
  assert.throws(() => seo.receivedFields(f.progress, token, durable().job), error);
  for (const change of [p => { p.session.origin_hash = 'c'.repeat(64); },
    p => { p.session.public_product_identity_id = '18'; }, p => { p.session.remote_product_id = '78'; }]) {
    const progress = structuredClone(f.progress); change(progress);
    assert.throws(() => seo.baselineReceipt(f.observation, token, progress), error);
  }
  seo.baselineReceipt(f.observation, token, f.progress);
  const progress = structuredClone(f.progress); progress.session.id = '44444444-4444-4444-8444-444444444444';
  assert.throws(() => seo.baselineReceipt(f.observation, token, progress), error);
});

function projected(f) {
  const fields = f.prepared.rows.map(({ record }) => ({ target: record.target, scope: record.scope, kind: 'seo', type: 'text',
    required: false, mapping: { proven: true }, local: record.before, remote: record.remote }));
  return { fields, plan: planFirstSyncFields({ fields }), blockers: [], projection: f.prepared.rows.map(({ record }) => ({
    target: record.target, scope: record.scope, source: record.source, mappingHash: record.mappingHash,
    persistence: 'seo_snapshot', outwardPolicy: 'authoritative_create_update' })) };
}

test('populated equal or differing SEO remains pending after unchanged reread without claiming canonical import', () => {
  const f = fixture(), projection = projected(f);
  projection.fields[0].local = structuredClone(projection.fields[0].remote);
  projection.plan = planFirstSyncFields({ fields: projection.fields });
  const first = prepareProgress(projection, null), progress = { fields: first.rows.map(row => structuredClone(row.record)) };
  assert.ok(first.rows.every(row => row.record.state === seo.PENDING));
  assert.equal(first.complete, false); assert.equal(first.readyForOutbound, true);
  const reread = prepareProgress(projection, progress);
  assert.equal(reread.complete, false); assert.equal(reread.readyForOutbound, true);
  assert.ok(reread.rows.every(row => !row.canAcceptRemote && !row.terminal));
  assert.deepEqual(reread.rows.map(row => row.record), progress.fields, 'fresh preview never resets the adopted SEO evidence');
});

for (const [label, change] of [
  ['unknown fresh remote', p => { p.fields[0].remote = { known: false }; }],
  ['confirmed empty fresh remote', p => { p.fields[0].remote = { known: true, present: false }; }],
  ['changed fresh remote', p => { p.fields[0].remote = present('External change'); }],
  ['changed mapping', p => { p.projection[0].mappingHash = 'f'.repeat(64); }],
  ['unproven mapping', p => { p.fields[0].mapping = { proven: false, reason: 'FIELD_BINDING_NOT_APPROVED' }; }],
]) test('pending SEO evidence stays permanent while ' + label + ' blocks delivery', () => {
  const f = fixture(), projection = projected(f), first = prepareProgress(projection, null);
  const progress = { fields: first.rows.map(row => structuredClone(row.record)) }, before = structuredClone(progress);
  change(projection); projection.plan = planFirstSyncFields({ fields: projection.fields });
  const result = prepareProgress(projection, progress);
  assert.deepEqual(result.rows.map(row => row.record), before.fields);
  assert.deepEqual(progress, before); assert.equal(result.readyForOutbound, false); assert.equal(result.complete, false);
});
