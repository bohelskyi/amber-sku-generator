const test = require('node:test');
const assert = require('node:assert/strict');
const { safeDiagnostics, presentProblem, presentProblems } = require('../src/services/magento/sync-problems');
const { getBatchSyncStatus } = require('../src/services/repricing/batch-read-model');

test('sync problems project specific planner evidence and exclude remote payloads and credentials', () => {
  const [safe] = safeDiagnostics([{ code: 'BINDING_DRIFT_REVIEW_REQUIRED',
    diagnostic: { code: 'attribute_not_in_selected_set', token: 'secret' }, target: 'kolir',
    payload: { password: 'secret' }, url: 'https://private.example' }]);
  assert.equal(presentProblem(safe).message, 'Характеристика не входить до потрібного набору Magento.');
  assert.equal(JSON.stringify(safe).includes('secret'), false);
  assert.equal(JSON.stringify(safe).includes('private.example'), false);
  assert.match(presentProblem({ code: 'reconciliation_required' }).message, /надіслав зміну.*не зміг підтвердити/);
  for (const code of ['ATTRIBUTE_METADATA_UNRESOLVED','OPTION_UNRESOLVED','OPTION_BINDING_REVIEW_REQUIRED',
    'CATEGORY_PATH_MISSING','CATEGORY_IDENTITIES_REVIEW_REQUIRED','PRODUCT_ATTRIBUTE_SET_MISMATCH',
    'REQUIRED_ATTRIBUTE_VALUE_MISSING','NAME_CONFLICT']) {
    assert.notEqual(presentProblem({ code }).message, presentProblem({ code: 'data_or_binding' }).message);
  }
});
test('local name readiness reclassifies only the co-occurring name-unavailable presentation', () => {
  const presented = presentProblems([
    { code: 'NAME_READ_UNAVAILABLE' },
    { code: 'PRODUCT_EVALUATION_NOT_READY', issueFields: ['kamin_obrobka', 'name', 'rozmir_suveniriv'] },
  ]);
  assert.equal(presented[0].message, 'Назви товару в Amber потрібно заповнити або виправити.');
  assert.equal(presented[0].code, 'NAME_READ_UNAVAILABLE');
  assert.match(presented[1].message, /Товар не готовий до синхронізації/);
  assert.deepEqual(presented[1].issueFields, ['kamin_obrobka', 'name', 'rozmir_suveniriv']);
  assert.equal(presentProblems([{ code: 'NAME_READ_UNAVAILABLE' }])[0].message,
    'Не вдалося прочитати назву Magento для перевірки.');
});
test('repricing progress follows captured generations, including later edits and exact bigint comparisons', async () => {
  const database = { query: async (sql) => ({ rows: sql.startsWith('SELECT id,')
    ? [{ id: 3, status: 'completed', changed_count: 5 }]
    : [{ magento_sync_generation: '9007199254740993', synced_generation: '9007199254740992', state: 'pending' },
      { magento_sync_generation: '8', synced_generation: '8', state: 'pending' },
      { magento_sync_generation: '7', synced_generation: '6', state: 'needs_attention' },
      { magento_sync_generation: '2', synced_generation: '5', state: 'synced' },
      { magento_sync_generation: null, synced_generation: '100', state: 'synced' }] }) };
  assert.deepEqual(await getBatchSyncStatus(3, database), { batchId: 3, status: 'completed', total: 5,
    synced: 2, pending: 1, needsAttention: 1, notTracked: 1 });
});

test('unknown failure remains administrator diagnosis rather than a fabricated mapping defect', () => {
  const result = presentProblem({ code: 'unexpected_failure', target: 'price' });
  assert.equal(result.resolution, 'administrator');
  assert.match(result.message, /^Не вдалося завершити синхронізацію/);
  assert.equal(result.target, 'price');
  assert.notEqual(result.message, presentProblem({ code: 'data_or_binding' }).message);
});

test('first sync field diagnostics preserve language and exact reason without remote payloads',()=>{
  const rows=safeDiagnostics([{code:'FIRST_SYNC_FIELD_CONFLICT',target:'name',scope:'en',reason:'VALUES_DIFFER',raw:{secret:'no'}},
    {code:'FIRST_SYNC_FIELD_REVIEW_REQUIRED',target:'decor_weight',scope:'all',reason:'CANONICAL_WEIGHT_SETTER_UNSUPPORTED'}]);
  assert.equal(rows[0].scope,'en');assert.equal(rows[0].reason,'VALUES_DIFFER');
  assert.equal(JSON.stringify(rows).includes('secret'),false);
  assert.equal(presentProblem(rows[0]).resolution,'first_sync_fields');
  assert.match(presentProblem(rows[0]).message,/Адміністратор.*цього поля/);
  assert.match(presentProblem(rows[1]).message,/ваги.*пов.*дані/);
});
