const test = require('node:test');
const assert = require('node:assert/strict');
const tasks = require('../src/services/product-integration-tasks.service');
const c = require('../src/services/product-integration-task-contract');
const id = '11111111-1111-4111-8111-111111111111';
const product = { categoryCode: 'SV', answers: { shape: 33 }, weight: 1, isTestProduct: true };
const input = { clientRequestId: id, expectedPreviewToken: 'a'.repeat(64), product };
function database(admin = true, saved = product) {
  const calls = [];
  const task = { id, actor_user_id: 1, revision: 1, state: 'open', category_code: 'SV', defect: { reasonCode: 'MAGENTO_CATEGORY_NOT_LINKED', valueId: null } };
  const db = { calls, release() {}, async connect() { return this; }, async query(sql) {
    calls.push(sql);
    if (sql.includes('has_permission')) return { rows: [{ status: 'active', has_permission: true }] };
    if (sql.includes("r.role_key='administrator'")) return { rows: admin ? [{}] : [], rowCount: admin ? 1 : 0 };
    if (sql.includes('request_hash')) return { rows: [{ task_id: id, request_hash: c.creationCommand(input).requestHash }] };
    if (sql.includes('SELECT t.*')) return { rows: [task] };
    if (sql.includes('SELECT * FROM product_integration_task_attempts')) return { rows: [{ creation_payload: saved }] };
    if (sql.includes('SELECT task_id')) return { rows: [{ task_id: id }] };
    return { rows: [] };
  } };
  return db;
}
const options = db => ({ databasePool: db, mutationContext: { actorUserId: 1 }, buildPreview() { assert.fail('Completed retry must not rebuild or write'); } });
test('completed TEST retry requires current actual Administrator before returning saved attempt; no downgrade or dispatch', async () => {
  const denied = database(false);
  await assert.rejects(tasks.create(input, options(denied)), { code: 'TEST_PRODUCT_ADMINISTRATOR_REQUIRED' });
  assert.ok(!denied.calls.some(sql => sql.includes('request_hash')));
  const allowed = database();
  const receipt = await tasks.create(input, options(allowed));
  assert.equal(receipt.creationContext.product.isTestProduct, true);
  assert.ok(!allowed.calls.some(sql => sql.includes('INSERT') || sql.includes('UPDATE')));
});
test('read and uncertain-attempt recovery preserve validated TEST facts after role revocation; malformed stored namespace fails closed', async () => {
  for (const recover of [false, true]) {
    const db = database(false);
    const receipt = await (recover ? tasks.recover(id, options(db)) : tasks.read(id, options(db)));
    assert.equal(receipt.creationContext.product.isTestProduct, true);
    assert.equal(receipt.deliveryAccepted, false);
  }
  const malformed = database(false, { ...product, isTestProduct: 'true' });
  await assert.rejects(tasks.recover(id, options(malformed)), { code: 'TEST_PRODUCT_FLAG_INVALID' });
});

test('fresh TEST task forwards namespace and actor to authoritative preview and rechecks Administrator before persistence', async () => {
  const db = database();
  const original = db.query;
  let authorityChecks = 0, previewCalls = 0;
  db.query = async sql => {
    if (sql.includes('request_hash')) { db.calls.push(sql); return { rows: [] }; }
    if (sql.includes('r.is_system=TRUE')) {
      db.calls.push(sql); ++authorityChecks;
      return { rows: authorityChecks === 1 ? [{}] : [], rowCount: authorityChecks === 1 ? 1 : 0 };
    }
    return original.call(db, sql);
  };
  await assert.rejects(tasks.create(input, { ...options(db), buildPreview: async (payload, previewOptions) => {
    ++previewCalls;
    assert.equal(payload.isTestProduct, true);
    assert.equal(previewOptions.mutationContext.actorUserId, 1);
    return { mode: 'public_identity', previewToken: input.expectedPreviewToken, normalizedAnswers: payload.answers, weightVal: 1,
      creationDeliveryReadiness: { scope: 'native_characteristic_source_support', status: 'configuration_required',
        code: 'MAGENTO_CATEGORY_NOT_LINKED', categoryCode: 'SV' } };
  } }), { code: 'TEST_PRODUCT_ADMINISTRATOR_REQUIRED' });
  assert.equal(previewCalls, 1); assert.equal(authorityChecks, 2);
  assert.ok(!db.calls.some(sql => sql.includes('INSERT')));
  assert.ok(db.calls.some(sql => sql === 'ROLLBACK'));
});
