const test = require('node:test');
const assert = require('node:assert/strict');
const { product, emptyEvidence } = require('./fixtures/export-exposure');
const { baseline } = require('../src/services/export-exposure/repair-manifest');
const loader = require('../src/services/export-exposure/repair-loader');
const audit = require('../src/audit/audit-events');
test.before(() => test.mock.method(require('node:net').Socket.prototype, 'connect',
  () => assert.fail('Cutover unit tests must not open network connections')));

let current;
const mocks = [
  test.mock.method(loader, 'loadRepairInput', async (pool, options) => {
    assert.equal(pool, current.options.databasePool);
    assert.equal(options.expectedDatabase, 'fixture_test'); return current.input;
  }),
  test.mock.method(loader, 'readRepairInput', async (client) => {
    assert.equal(client, current.client); return current.input;
  }),
  test.mock.method(audit, 'writeAuditEvent', async (client, event) => {
    assert.equal(client, current.client); current.audits.push(event);
    if (current.auditError) throw current.auditError;
    const id = current.audits.length;
    current.events.set(id, event);
    return { id };
  }),
];
const service = require('../src/services/full-product-cutover.service');
test.after(() => mocks.forEach((mock) => mock.mock.restore()));

function fixture(t, count = 1) {
  const products = Array.from({ length: count }, (_, index) => product(index + 1));
  const activation = { singleton: true, phase: 'preparing', generation: '2',
    required_writer_version: 1, historical_index_event_id: 10, approval_event_id: null, manifest_hash: null };
  const f = { input: { ...emptyEvidence({ products }), activation, lifecyclePresent: true, migrations: [], members: [],
    registry: products.map((row) => ({ full_sku: row.full_sku, first_product_id: row.id })),
    lifecycle: products.map((row) => ({ ...baseline(row), cutover_baseline_revision: '0',
      business_exclusion_state: 'none', recount_compatibility_excluded: false })),
  }, calls: [], audits: [], events: new Map(), released: 0, connects: 0, actorStatus: 'active', hasPermission: true };
  f.client = { release: () => { f.released++; }, query: async (sql, values) => {
    f.calls.push({ sql, values });
    if (/^SELECT pg_advisory_(lock|unlock)/.test(sql) || /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [] };
    if (sql.includes("to_regclass('full_product_export_activation')")) return { rows: [{ present: true }] };
    if (sql === 'SELECT * FROM full_product_export_activation WHERE singleton=TRUE') return { rows: [activation] };
    if (sql.includes('FROM application_users u')) {
      assert.deepEqual(values, [7, 'exports.reconcile']);
      return { rows: [{ status: f.actorStatus, has_permission: f.hasPermission }] };
    }
    if (sql === 'SELECT current_database() name') return { rows: [{ name: 'fixture_test' }] };
    if (sql === 'SELECT details FROM audit_events WHERE id=$1') return { rows: [{ details: f.events.get(values[0]).details }] };
    if (sql.includes('FROM audit_events WHERE event_key=$1')) {
      return { rows: [...f.events.values()].filter((event) => event.eventKey === values[0] && event.subjectId === values[1])
        .map((event) => ({ details: event.details })) };
    }
    if (sql.startsWith('SELECT id FROM products WHERE id=ANY')) return { rows: values[0].map((id) => ({ id })) };
    if (sql.startsWith('SELECT * FROM product_full_export_state')) {
      assert.match(sql, /ORDER BY product_id FOR UPDATE/);
      return { rows: f.input.lifecycle.filter((row) => values[0].includes(row.product_id)) };
    }
    if (sql.startsWith('UPDATE product_full_export_state SET route=')) {
      const [id, route, holdReason, deliveryVersion, baselineRevision, , exclusion, recountExcluded, evidence, hash] = values;
      Object.assign(f.input.lifecycle.find((row) => row.product_id === id), { route, hold_reason: holdReason,
        delivery_version: deliveryVersion, cutover_baseline_revision: baselineRevision,
        business_exclusion_state: exclusion, recount_compatibility_excluded: recountExcluded,
        evidence: JSON.parse(evidence), repair_manifest_hash: hash });
      return { rowCount: 1 };
    }
    if (sql.startsWith('UPDATE full_product_export_activation')) {
      if (sql.includes("phase='preparing'")) activation.phase = 'preparing';
      else if (sql.includes('historical_index_event_id=$1')) activation.historical_index_event_id = values[0];
      else if (sql.includes('manifest_hash=$1')) { activation.manifest_hash = values[0]; activation.approval_event_id = values[1]; }
      else if (sql.includes("phase='active'")) { activation.phase = 'active'; activation.selector_version = 1; }
      else assert.fail(`Unexpected gate update: ${sql}`);
      return { rows: [activation], rowCount: 1 };
    }
    if (sql.startsWith('SELECT p.id FROM products p LEFT JOIN product_full_export_state')) return { rows: f.invalidProjection ? [{ id: 1 }] : [] };
    assert.fail(`Unexpected SQL: ${sql}`);
  } };
  f.options = { expectedDatabase: 'fixture_test', mutationContext: { actorUserId: 7, requestId: 'cutover-unit' },
    databasePool: { connect: async () => { f.connects++; return f.client; }, query: (...args) => f.client.query(...args) },
    deploymentEvidence: 'Reviewed writer, drained instances and maintained freeze' };
  current = f;
  t.after(() => { current = null; });
  f.approve = async () => {
    const manifest = await service.generate('cutover', f.options);
    await service.approve(manifest, manifest.contentSha256, 'Reviewed legacy inventory', f.options);
    return manifest;
  };
  return f;
}

function assertReleased(f, rollback = false) {
  assert.equal(f.released, f.connects);
  assert.ok(f.calls.some(({ sql }) => sql === (rollback ? 'ROLLBACK' : 'COMMIT')));
  assert.equal(f.calls.filter(({ sql }) => sql.startsWith('SELECT pg_advisory_lock_shared')).length,
    f.calls.filter(({ sql }) => sql.startsWith('SELECT pg_advisory_unlock_shared')).length);
}

for (const evidence of [undefined, '', ' ', 'x'.repeat(4001)]) {
  test(`cutover rejects invalid deployment evidence (${String(evidence).length} chars) without connecting`, async (t) => {
    const f = fixture(t);
    await assert.rejects(service.prepare({ ...f.options, deploymentEvidence: evidence }),
      { statusCode: 422, code: 'CUTOVER_DEPLOYMENT_EVIDENCE_REQUIRED' });
    assert.equal(f.connects, 0); assert.deepEqual(f.audits, []);
  });
}

test('preparation records deployment evidence under exclusive authority and is idempotent', async (t) => {
  const f = fixture(t); f.input.activation.phase = 'legacy';
  assert.equal((await service.prepare(f.options)).phase, 'preparing');
  await service.prepare(f.options);
  assert.equal(f.audits.length, 1); assert.equal(f.audits[0].eventKey, 'full_product_cutover.preparing');
  assert.equal(f.audits[0].details.deploymentEvidence, f.options.deploymentEvidence);
  assert.ok(f.calls.some(({ sql }) => sql === 'SELECT pg_advisory_lock(hashtext($1))'));
  assert.ok(f.calls.some(({ sql }) => sql === "SET LOCAL amber.lifecycle_maintenance = 'on'"));
  assertReleased(f);
});

for (const [label, mutate, error] of [
  ['already active', (f) => { f.input.activation.phase = 'active'; }, { code: 'REPAIR_MANIFEST_STALE' }],
  ['disabled actor', (f) => { f.actorStatus = 'disabled'; }, { statusCode: 403, code: 'ADMIN_PERMISSION_REVOKED' }],
  ['revoked permission', (f) => { f.hasPermission = false; }, { statusCode: 403, code: 'ADMIN_PERMISSION_REVOKED' }],
  ['wrong database', (f) => { f.options.expectedDatabase = 'other_test'; }, { code: 'REPAIR_DATABASE_MISMATCH' }],
]) {
  test(`preparation refuses ${label} and releases its transaction/authority`, async (t) => {
    const f = fixture(t); mutate(f);
    await assert.rejects(service.prepare(f.options), error);
    assert.deepEqual(f.audits, []); assertReleased(f, true);
  });
}

test('failed preparation audit cannot advance the activation gate', async (t) => {
  const f = fixture(t); f.input.activation.phase = 'legacy'; f.auditError = new Error('audit failed');
  await assert.rejects(service.prepare(f.options), f.auditError);
  assert.equal(f.input.activation.phase, 'legacy');
  assert.ok(!f.calls.some(({ sql }) => sql.startsWith('UPDATE full_product_export_activation')));
  assertReleased(f, true);
});

test('fresh cutover manifest binds unexposed first delivery without claiming import or confirmation', async (t) => {
  const f = fixture(t), before = structuredClone(f.input);
  const manifest = await service.generate('cutover', f.options);
  assert.equal(manifest.entries[0].action, 'first_delivery');
  assert.equal(manifest.entries[0].after.route, 'normal');
  assert.equal(manifest.entries[0].after.confirmed_revision, '0');
  assert.equal(manifest.entries[0].after.cutover_baseline_revision, '0');
  assert.equal(manifest.entries[0].after.evidence.currentPayloadEquality, 'not_proven');
  assert.equal(manifest.policy.batchSize, 100);
  assert.deepEqual(f.input, before); assert.equal(f.connects, 0); assert.deepEqual(f.audits, []);
});

for (const [label, mutate] of [
  ['ordinary business exclusion', (f) => { f.input.products[0].exclude_from_export = 1; }],
  ['post-migration origin', (f) => { f.input.lifecycle[0].evidence.origin = 'ordinary_save'; }],
  ['noninitial revision', (f) => { f.input.lifecycle[0].revision = '2'; }],
  ['already approved gate', (f) => { f.input.activation.approval_event_id = 9; }],
  ['missing historical index', (f) => { f.input.activation.historical_index_event_id = null; }],
]) {
  test(`manifest generation refuses ${label} without writes`, async (t) => {
    const f = fixture(t); mutate(f);
    await assert.rejects(service.generate('cutover', f.options), { code: 'REPAIR_MANIFEST_STALE' });
    assert.deepEqual(f.calls, []); assert.deepEqual(f.audits, []);
  });
}

test('historical indexing seals a fresh receipt, refuses changed evidence, and replays without another audit', async (t) => {
  const f = fixture(t); f.input.activation.historical_index_event_id = null;
  const manifest = await service.generate('index', f.options);
  f.input.products[0].weight = 5;
  await assert.rejects(service.indexHistorical(manifest, manifest.contentSha256, f.options), { code: 'REPAIR_MANIFEST_STALE' });
  delete f.input.products[0].weight;
  const first = await service.indexHistorical(manifest, manifest.contentSha256, f.options);
  assert.equal(first.indexedMemberships, 0);
  const repeated = await service.indexHistorical(manifest, manifest.contentSha256, f.options);
  assert.equal(repeated.alreadyApplied, true); assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].eventKey, 'full_product_cutover.indexed'); assertReleased(f);
});

test('approval rejects changed seals and missing business reason before opening a transaction', async (t) => {
  const f = fixture(t), manifest = await service.generate('cutover', f.options);
  await assert.rejects(service.approve({ ...manifest, database: 'other_test' }, manifest.contentSha256, 'Reviewed', f.options), { code: 'CUTOVER_MANIFEST_INVALID' });
  await assert.rejects(service.approve(manifest, manifest.contentSha256, ' ', f.options), { code: 'CUTOVER_REASON_REQUIRED' });
  assert.equal(f.connects, 0);
});

test('approval records business assertion, stays idempotent and detects later inventory drift', async (t) => {
  const f = fixture(t), manifest = await f.approve();
  assert.equal(f.audits[0].details.acceptanceIsBusinessAssertion, true);
  assert.equal(f.audits[0].details.confirmsMagentoImport, false);
  assert.equal((await service.approve(manifest, manifest.contentSha256, 'Reviewed again', f.options)).alreadyApproved, true);
  assert.equal(f.audits.length, 1);
  f.input.products[0].weight = 8;
  await assert.rejects(service.applyBatch(manifest.contentSha256, 0, f.options), { code: 'REPAIR_MANIFEST_STALE' });
  assert.ok(!f.calls.some(({ sql }) => sql.startsWith('UPDATE product_full_export_state')));
  assertReleased(f, true);
});

test('batch bounds reject invalid ordinals and missing approved slices', async (t) => {
  const f = fixture(t);
  for (const number of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(service.applyBatch('hash', number, f.options), { code: 'CUTOVER_BATCH_INVALID' });
  }
  assert.equal(f.connects, 0);
  const manifest = await f.approve();
  await assert.rejects(service.applyBatch(manifest.contentSha256, 1, f.options), { code: 'CUTOVER_BATCH_INVALID' });
  assertReleased(f, true);
});

test('stale lifecycle evidence blocks a whole batch before any lifecycle write', async (t) => {
  const f = fixture(t), manifest = await f.approve();
  f.input.lifecycle[0].delivery_version = '2';
  await assert.rejects(service.applyBatch(manifest.contentSha256, 0, f.options), /Stale entry 1/);
  assert.ok(!f.calls.some(({ sql }) => sql.startsWith('UPDATE product_full_export_state')));
  assertReleased(f, true);
});

test('101 products require two bounded receipts, exact revalidation, and idempotent activation', async (t) => {
  const f = fixture(t, 101), manifest = await f.approve(), hash = manifest.contentSha256;
  const first = await service.applyBatch(hash, 0, f.options);
  assert.deepEqual(first.productIds, Array.from({ length: 100 }, (_, index) => index + 1));
  const countBeforeRetry = f.audits.length;
  assert.equal((await service.applyBatch(hash, 0, f.options)).alreadyApplied, true);
  assert.equal(f.audits.length, countBeforeRetry);
  await assert.rejects(service.validate(hash, f.options), /Unfinished or stale entry 101/);
  assert.deepEqual((await service.applyBatch(hash, 1, f.options)).productIds, [101]);
  assert.deepEqual(await service.validate(hash, f.options), { manifestHash: hash, products: 101, batches: 2, mutations: 101 });
  assert.equal((await service.activate(hash, f.options)).alreadyActive, false);
  assert.equal((await service.activate(hash, f.options)).alreadyActive, true);
  assert.equal(f.audits.filter((event) => event.eventKey === 'full_product_cutover.activated').length, 1);
  assert.equal(f.audits.at(-1).details.successorExclusionsReleased, 0);
  assert.ok(f.input.lifecycle.every((row) => row.confirmed_revision === '0'));
  assertReleased(f);
});

test('activation refuses inconsistent exclusions even with all batch receipts', async (t) => {
  const f = fixture(t), manifest = await f.approve();
  await service.applyBatch(manifest.contentSha256, 0, f.options); f.invalidProjection = true;
  await assert.rejects(service.activate(manifest.contentSha256, f.options), /Exclusion\/lifecycle projection inconsistent/);
  assert.equal(f.input.activation.phase, 'preparing');
  assert.ok(!f.audits.some((event) => event.eventKey === 'full_product_cutover.activated'));
  assertReleased(f, true);
});

test('reviewed amendment accepts untouched lifecycle with changed payload but refuses completed payload drift', async (t) => {
  const f = fixture(t), manifest = await f.approve();
  f.input.products[0].weight = 5;
  const amendment = await service.generate('amendment', f.options);
  assert.equal(amendment.parentManifestHash, manifest.contentSha256);
  assert.notEqual(amendment.entries[0].payloadHash, manifest.entries[0].payloadHash);
  delete f.input.products[0].weight;
  await service.applyBatch(manifest.contentSha256, 0, f.options);
  assert.equal((await service.generate('amendment', f.options)).entries[0].action, 'preserve');
  f.input.products[0].weight = 6;
  await assert.rejects(service.generate('amendment', f.options), /Completed product 1 payload changed/);
});
