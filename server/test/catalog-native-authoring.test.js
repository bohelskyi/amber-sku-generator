const test = require('node:test');
const assert = require('node:assert/strict');
const { getCatalogWorkflow, resolveNewQuestionKey } = require('../src/services/catalog/catalog-workflow');
const { getAppConfig } = require('../src/services/catalog/catalog-read-model');

function database(enabled) {
  const queries = [];
  return { queries, async query(sql) {
    queries.push(sql);
    if (sql.includes('FROM public_sku_activation')) return { rows: enabled === undefined ? [] : [{ enabled }] };
    if (sql.includes('FROM categories c') || sql.includes('FROM questions q')) return { rows: [] };
    assert.fail('Unexpected SQL: ' + sql);
  } };
}
test('catalog view exposes authoritative mode and only strict true enables generated keys', async () => {
  for (const enabled of [false, undefined, 'true', 1]) {
    const db = database(enabled);
    assert.deepEqual((await getAppConfig(db)).catalogWorkflow, { identityMode: 'encoded_sku', serverGeneratedQuestionKeys: false });
    await assert.rejects(resolveNewQuestionKey(undefined, db), { statusCode: 400 });
  }
  assert.deepEqual(await getCatalogWorkflow(database(true)), { identityMode: 'public_identity', serverGeneratedQuestionKeys: true });
});
test('native missing keys are distinct opaque stable identifiers independent of the label; explicit keys retain legacy contract', async () => {
  const db = database(true);
  const first = await resolveNewQuestionKey(undefined, db), second = await resolveNewQuestionKey('', db);
  assert.match(first, /^q_[a-f0-9]{32}$/); assert.match(second, /^q_[a-f0-9]{32}$/); assert.notEqual(first, second);
  const legacy = database(false);
  assert.equal(await resolveNewQuestionKey(' existing_key ', legacy), 'existing_key');
  assert.equal(legacy.queries.length, 0);
});

test('native create stores generated key and zero SKU defaults inside audited lifecycle transaction; legacy omission rolls back', async () => {
  const pool = require('../src/db/pool');
  const { createQuestion } = require('../src/services/catalog/question-commands');
  const original = pool.connect;
  let enabled = true;
  const calls = [];
  const client = { release() {}, async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('to_regclass')) return { rows: [{ present: false }] };
    if (sql.includes('FROM public_sku_activation')) return { rows: [{ enabled }] };
    if (sql.includes('INSERT INTO questions')) return { rows: [{ id: 90 }] };
    if (sql.includes('FROM application_users')) return { rows: [{ display_name: 'Fixture' }] };
    if (sql.includes('INSERT INTO audit_events')) return { rows: [{ id: 91 }] };
    return { rows: [] };
  } };
  pool.connect = async () => client;
  try {
    const created = await createQuestion({ category_code: 'XX', label: 'Same visible label', required: 0 }, { mutationContext: { actorUserId: 1 } });
    assert.match(created.key, /^q_[a-f0-9]{32}$/);
    const insertion = calls.find(c => c.sql.includes('INSERT INTO questions'));
    assert.equal(insertion.values[1], created.key); assert.equal(insertion.values[3], 0); assert.equal(insertion.values[6], 0);
    const audit = calls.find(c => c.sql.includes('INSERT INTO audit_events'));
    assert.equal(JSON.parse(audit.values[6]).key, created.key);
    assert.ok(calls.findIndex(c => c.sql === 'BEGIN') < calls.findIndex(c => c.sql.includes('FROM public_sku_activation')));
    assert.ok(calls.some(c => c.sql === 'COMMIT'));
    calls.length = 0; enabled = false;
    await assert.rejects(createQuestion({ category_code: 'XX', label: 'Same visible label' }, { mutationContext: { actorUserId: 1 } }), { statusCode: 400 });
    assert.ok(calls.some(c => c.sql === 'ROLLBACK')); assert.ok(!calls.some(c => c.sql.includes('INSERT INTO questions')));
  } finally { pool.connect = original; }
});
