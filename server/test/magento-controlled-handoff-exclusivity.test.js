const test = require('node:test');
const assert = require('node:assert/strict');
const editor = require('../src/services/magento/integration-editor.service');
const repository = require('../src/services/magento/binding-repository');
const previews = require('../src/services/magento/sync-preview-db');
const evidence = require('../src/services/magento/binding-evidence-products');

function fixture(t) {
  const state = { items: [], handoffs: [], audits: [], calls: [], request: null, clients: 0 };
  const binding = { id: '11111111-1111-4111-8111-111111111111', state: 'published',
    revision: '2', installationKey: 'fixture', originHash: 'a'.repeat(64) };
  const product = { id: 7, public_product_identity_id: '77', public_sku: 'AG-FIXTURE',
    category: 'SV', status: 'active', corrected_to_product_id: null, exclude_from_export: 0 };
  const rows = values => ({ rows: values, rowCount: values.length });
  const db = { connect: async () => {
    const clientId = ++state.clients;
    return { release() {}, query: async (sql, values = []) => {
      state.calls.push({ sql, values, clientId });
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql) || /pg_advisory/.test(sql)) return rows([]);
      if (sql.includes("to_regclass('full_product_export_activation')")) return rows([{ present: false }]);
      if (sql.includes('FROM application_users u')) return rows([{ status: 'active', has_permission: true }]);
      if (sql.includes('FROM user_role_assignments')) return rows([{}]);
      if (sql.includes('SELECT id FROM magento_binding_handoffs')) return rows(state.handoffs.filter(row =>
        row.binding_revision_id === values[0] && row.kind === values[1] && row.preview_hash === values[2]));
      if (sql.includes('SELECT id FROM products WHERE id=ANY')) return rows([{ id: product.id }]);
      if (sql.includes('FROM magento_name_sync_states') || sql.includes('FROM magento_test_deletions')
        || sql.includes('FROM magento_sync_jobs')) return rows([]);
      if (sql.includes('SELECT * FROM magento_product_sync_requests')) return rows(state.request ? [state.request] : []);
      if (sql.includes('SELECT 1 FROM magento_binding_handoff_items')) {
        assert.deepEqual(values, [product.id, product.public_product_identity_id]);
        assert.match(sql, /product_id=\$1 OR public_product_identity_id=\$2/);
        assert.match(sql, /state IN \('pending','protected'\)/);
        return rows(state.items.filter(item => (item.product_id === values[0] || item.public_product_identity_id === values[1])
          && ['pending', 'protected'].includes(item.state)).slice(0, 1));
      }
      if (sql.includes('INSERT INTO magento_binding_handoffs(')) {
        state.handoffs.push({ id: values[0], binding_revision_id: values[1], kind: values[2], preview_hash: values[3] });
        return rows([]);
      }
      if (sql.includes('INSERT INTO magento_binding_handoff_items(')) {
        for (const item of JSON.parse(values[1])) state.items.push({ handoff_id: values[0], product_id: item.productId,
          public_product_identity_id: item.publicIdentityId, state: 'pending' });
        return rows([]);
      }
      if (sql.includes('SELECT display_name, preferred_username')) return rows([{ display_name: 'Fixture', preferred_username: null }]);
      if (sql.includes('INSERT INTO audit_events')) { state.audits.push(values); return rows([{ id: '1' }]); }
      assert.fail('Unexpected SQL: ' + sql);
    } };
  } };
  const prior = { selected: editor.selected, current: repository.current,
    read: previews.readPreviewProductOnClient, evaluate: evidence.evaluate };
  editor.selected = async () => binding;
  repository.current = async () => binding;
  previews.readPreviewProductOnClient = async () => ({ product: { ...product }, nameState: null });
  evidence.evaluate = () => ({ base: { name: 'Fixture' }, english: { name: 'Fixture EN' }, generatedNames: {} });
  const servicePath = require.resolve('../src/services/magento/binding-controlled-actions');
  delete require.cache[servicePath];
  const service = require(servicePath);
  t.after(() => {
    editor.selected = prior.selected; repository.current = prior.current;
    previews.readPreviewProductOnClient = prior.read; evidence.evaluate = prior.evaluate;
    delete require.cache[servicePath];
  });
  const input = { bindingRevisionId: binding.id, expectedRevision: binding.revision, kind: 'broader_resync',
    productIds: [product.id], reason: 'Reviewed fixture resync' };
  const options = { databasePool: db, mutationContext: { actorUserId: 1, requestId: 'fixture' } };
  const prepare = async (request = input) => ({ ...request, previewToken: (await service.preview({}, request, options)).previewToken });
  return { service, state, input, options, prepare };
}

test('capability version advertises canonical atomic handoff exclusion', t => {
  assert.equal(fixture(t).service.handoffExclusivityVersion, 1);
});

test('preview blocks pending/protected handoffs matching product OR public identity, regardless of origin', async t => {
  const f = fixture(t);
  for (const state of ['pending', 'protected']) for (const item of [
    { product_id: 7, public_product_identity_id: '999' },
    { product_id: 999, public_product_identity_id: '77' },
  ]) {
    f.state.items = [{ ...item, state, origin_hash: 'other-origin' }];
    const report = await f.service.preview({}, f.input, f.options);
    assert.deepEqual(report.blockers, [{ productId: 7, code: 'EXISTING_HANDOFF' }]);
  }
  assert.equal(f.state.handoffs.length, 0);
});

test('unrelated and settled handoffs do not prevent a newly reviewed action', async t => {
  const f = fixture(t);
  f.state.items = [{ product_id: 8, public_product_identity_id: '88', state: 'pending' },
    { product_id: 7, public_product_identity_id: '77', state: 'enrolled' },
    { product_id: 7, public_product_identity_id: '77', state: 'retired' }];
  assert.deepEqual((await f.service.preview({}, f.input, f.options)).blockers, []);
});

test('handoff appearing after preview is rejected by locked final inspection', async t => {
  const f = fixture(t), command = await f.prepare();
  f.state.items = [{ product_id: 7, public_product_identity_id: '77', state: 'protected' }];
  f.state.calls = [];
  await assert.rejects(f.service.apply({}, command, f.options), { code: 'MAGENTO_CONTROLLED_ACTION_STALE' });
  const check = f.state.calls.findIndex(call => call.sql.includes('SELECT 1 FROM magento_binding_handoff_items'));
  const locks = f.state.calls.slice(0, check);
  assert.ok(locks.some(call => call.values[0] === 'amber_application_user_admin_active_administrators'));
  assert.ok(locks.some(call => call.values[0] === 'amber_full_product_cutover'));
  assert.ok(locks.some(call => call.values[0] === 'amber_magento_binding:fixture'));
  assert.ok(locks.some(call => call.sql.includes('ORDER BY id FOR NO KEY UPDATE')));
  assert.equal(new Set(f.state.calls.map(call => call.clientId)).size, 1);
  assert.equal(f.state.handoffs.length, 0); assert.equal(f.state.audits.length, 0);
});

test('different preview tokens cannot duplicate an outstanding handoff; same token replays its receipt', async t => {
  const f = fixture(t), first = await f.prepare(), second = await f.prepare({ ...f.input, reason: 'Different reviewed reason' });
  assert.notEqual(first.previewToken, second.previewToken);
  const result = await f.service.apply({}, first, f.options);
  assert.equal(result.alreadyApplied, false);
  await assert.rejects(f.service.apply({}, second, f.options), { code: 'MAGENTO_CONTROLLED_ACTION_STALE' });
  assert.deepEqual(await f.service.apply({}, first, f.options), { handoffId: result.handoffId, alreadyApplied: true });
  assert.equal(f.state.handoffs.length, 1); assert.equal(f.state.items.length, 1); assert.equal(f.state.audits.length, 1);
});

test('enrollment into a request after preview still invalidates the previous token', async t => {
  const f = fixture(t), first = await f.prepare(), second = await f.prepare({ ...f.input, reason: 'Different reviewed reason' });
  await f.service.apply({}, first, f.options);
  f.state.items[0].state = 'enrolled';
  f.state.request = { product_id: 7, public_product_identity_id: '77', desired_generation: '1', state: 'pending' };
  await assert.rejects(f.service.apply({}, second, f.options), { code: 'MAGENTO_CONTROLLED_ACTION_STALE' });
  assert.equal(f.state.handoffs.length, 1); assert.equal(f.state.audits.length, 1);
});
