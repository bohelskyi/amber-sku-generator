const test = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../src/services/magento/first-sync-ledger');
const uuid = '11111111-1111-4111-8111-111111111111';
function command() {
  return { key: { originHash: 'a'.repeat(64), publicIdentityId: '1' },
    identity: { installationKey: 'fixture', publicSku: 'SV1', remoteProductId: '42',
      initialProductId: 1, initialBindingRevisionId: uuid, contractVersion: 'v1' },
    expectedRevision: '0', previewHash: 'b'.repeat(64), actorUserId: 1,
    fields: [{ target: 'name', scope: 'en', state: 'unknown', before: null, remote: null, after: null,
      source: { kind: 'product', field: 'name', productId: 1, bindingRevisionId: uuid, definitionHash: 'c'.repeat(64), routeKey: 'SV.souvenir=value_id:6&!is_calibrated' },
      mappingHash: 'd'.repeat(64) }] };
}
test('ledger rejects malformed, executable, oversized or duplicate evidence before database access', async () => {
  const client = { query() { assert.fail('Invalid evidence reached database'); }, release() {} };
  for (const mutate of [
    x => x.fields.push(x.fields[0]), x => x.fields = Array(501).fill(x.fields[0]),
    x => x.fields[0].state = 'synced', x => x.fields[0].remote = new Date(),
    x => x.fields[0].remote = NaN, x => x.fields[0].remote = { value: 'x'.repeat(1024 * 1024) },
    x => Object.defineProperty(x.fields[0], 'remote', { get() { assert.fail('Getter executed'); }, enumerable: true }),
    x => x.fields[0].source.key = 'also', x => delete x.fields[0].source.productId,
    x => x.identity.remoteProductId = 42, x => x.expectedRevision = '-1',
    x => { x.complete = true; x.requiredScopes = []; },
    x => x.fields = [, x.fields[0]],
    x => x.fields[0].remote = Object.create({ inherited: true }),
    x => x.fields[0].remote = { [Symbol('hidden')]: 'bad' },
  ]) {
    const input = command(); mutate(input);
    await assert.rejects(ledger.recordProgressOnClient(client, input), { code: 'FIRST_SYNC_LEDGER_INPUT' });
  }
});
test('ledger rejects autocommit before writes and leaves caller evidence unchanged', async () => {
  const input = command(), before = structuredClone(input), sql = [];
  const client = { release() {}, async query(query) { sql.push(query); return { rows: [{ id: String(sql.length) }] }; } };
  await assert.rejects(ledger.recordProgressOnClient(client, input), { code: 'FIRST_SYNC_LEDGER_TRANSACTION_REQUIRED' });
  assert.equal(sql.length, 2); assert.ok(sql.every(query => query === 'SELECT txid_current()::text id'));
  assert.deepEqual(input, before);
});
test('read requires exact stable session key', async () => {
  const client = { query() { assert.fail('Invalid key reached database'); } };
  await assert.rejects(ledger.readOnClient(client, { originHash: 'a'.repeat(64), publicIdentityId: '1', contractVersion: 'v2' }),
    { code: 'FIRST_SYNC_LEDGER_INPUT' });
});

function clientFixture(latest = []) {
  const input = command(), progress = [], fields = [];
  const session = { id: uuid, revision: '1', installation_key: input.identity.installationKey,
    public_sku: input.identity.publicSku, remote_product_id: input.identity.remoteProductId,
    initial_product_id: 1, initial_binding_revision_id: uuid, completed_at: null };
  const client = { release() {}, async query(sql, values = []) {
    if (sql === 'SELECT txid_current()::text id') return { rows: [{ id: '42' }] };
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('SELECT * FROM magento_first_sync_sessions')) return { rows: [session] };
    if (sql.startsWith('SELECT DISTINCT ON')) return { rows: latest.map(evidence => ({ evidence, revision: '1', recorded_at: '2026-10-09T00:00:00Z' })) };
    if (sql.startsWith('SELECT id FROM magento_first_sync_sessions')) return { rows: [{ id: uuid }] };
    if (sql.startsWith('SELECT command_hash,result')) return { rows: [] };
    if (sql.includes('SELECT display_name, preferred_username')) return { rows: [{ display_name: 'Fixture', preferred_username: null }] };
    if (sql.includes('INSERT INTO audit_events')) return { rows: [{ id: '1' }] };
    if (sql.startsWith('INSERT INTO magento_first_sync_progress')) { progress.push(JSON.parse(values[4])); return { rows: [] }; }
    if (sql.startsWith('INSERT INTO magento_first_sync_fields')) { fields.push(JSON.parse(values[5])); return { rows: [] }; }
    if (sql.startsWith('UPDATE magento_first_sync_sessions')) return { rowCount: 1, rows: [{ id: uuid }] };
    assert.fail('Unexpected SQL: ' + sql);
  } };
  return { client, progress, fields };
}
test('only new imported/name_received fields reach a detached local callback subset', async () => {
  const input = command(); input.expectedRevision = '1';
  input.fields[0].state = 'name_received'; input.fields[0].after = 'Name';
  const imported = structuredClone(input.fields[0]); imported.target = 'weight'; imported.state = 'imported'; imported.after = '5.2';
  const pending = structuredClone(input.fields[0]); pending.target = 'price'; pending.state = 'pending_outward_confirmation';
  input.fields.push(imported, pending);
  const before = structuredClone(input), fixture = clientFixture(); let called = 0;
  input.applyLocal = async (client, acceptedFields) => {
    called++; assert.equal(client, fixture.client);
    assert.deepEqual(acceptedFields.map(f => f.state).sort(), ['imported', 'name_received']);
    acceptedFields[0].after = 'Changed callback copy';
    acceptedFields[0].source.field = 'Changed nested copy';
  };
  await ledger.recordProgressOnClient(fixture.client, input);
  assert.equal(called, 1);
  assert.ok(fixture.fields.every(f => f.after !== 'Changed callback copy' && f.source.field !== 'Changed nested copy'));
  const after = { ...input }; delete after.applyLocal; assert.deepEqual(after, before);
});
test('equal, unresolved and outward-only progress never invokes the local patch callback', async () => {
  for (const state of ['equal', 'optional_empty', 'unknown', 'conflict', 'review_required', 'pending_outward_confirmation', 'outward_verified']) {
    const input = command(); input.expectedRevision = '1'; input.fields[0].state = state;
    input.applyLocal = () => assert.fail('Non-import state invoked local patch: ' + state);
    await ledger.recordProgressOnClient(clientFixture().client, input);
  }
});
test('fresh preview terminal replay and completion-only progress cannot restore an old name', async () => {
  const original = command().fields[0]; original.state = 'name_received'; original.after = 'Original imported name';
  let localName = 'Manager edited name';
  for (const complete of [false, true]) {
    const input = command(); input.expectedRevision = '1'; input.previewHash = (complete ? 'e' : 'f').repeat(64);
    input.fields = complete ? [] : [structuredClone(original)];
    if (complete) { input.complete = true; input.requiredScopes = [{ target: 'name', scope: 'en' }]; }
    const fixture = clientFixture([original]);
    input.applyLocal = () => { localName = 'Original imported name'; };
    const result = await ledger.recordProgressOnClient(fixture.client, input);
    assert.equal(localName, 'Manager edited name'); assert.equal(fixture.fields.length, 0);
    assert.deepEqual(result.changedFields, []);
  }
});
