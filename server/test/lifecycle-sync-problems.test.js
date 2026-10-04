const test = require('node:test');
const assert = require('node:assert/strict');
const { presentProblems, problems, problemPage } = require('../src/services/magento/sync-problems');
const { presentStatus, readStatuses } = require('../src/services/magento/automatic-sync-status');
const lifecycle = { route: 'hold', hold_reason: 'historical_ambiguity', delivery_version: '1',
  source_correction_id: 1509, evidence: { classification: 'historical_ambiguous',
    primaryReason: 'INFERRED_HISTORY_WITHOUT_EXACT_MEMBERSHIP', ancestorProductIds: [1368], secret: 'not-for-browser' } };
const diagnostics = [{ code: 'AMBER_SYNC_ELIGIBILITY_UNRESOLVED' }];
const row = { productId: 5033, product_id: 5033, article: 'SV5111010', category: 'SV',
  state: 'needs_attention', reason_code: 'data_or_binding', diagnostics, lifecycle };

test('held successor uses authoritative lifecycle evidence instead of a mapping action', () => {
  const [problem] = presentProblems(diagnostics, lifecycle);
  assert.equal(problem.resolution, 'lifecycle_reconciliation');
  assert.equal(problem.message, 'Потрібне підтвердження історії доставки');
  assert.deepEqual(problem.eligibilityIssue, { type: 'historical_ambiguity', lifecycleRoute: 'hold',
    holdReason: 'historical_ambiguity', primaryReason: lifecycle.evidence.primaryReason,
    classification: 'historical_ambiguous', sourceCorrectionId: 1509, ancestorProductIds: [1368], deliveryVersion: '1' });
  assert.equal(JSON.stringify(problem).includes('not-for-browser'), false);
  assert.equal(presentStatus(row).reason, problem.message);
});

test('unresolved eligibility without matching current evidence does not guess a mapping or historical class', () => {
  for (const state of [null, { ...lifecycle, route: 'normal' }, { ...lifecycle, hold_reason: 'prior_exposure' },
    { ...lifecycle, evidence: {} }]) {
    const [problem] = presentProblems(diagnostics, state);
    assert.equal(problem.resolution, 'administrator');
    assert.equal(problem.eligibilityIssue, undefined);
  }
  assert.deepEqual(presentStatus({ ...row, state: 'synced' }), { state: 'synced', reason: null });
  assert.equal(presentStatus({ ...row, reason_code: 'reconciliation_required' }).problems, undefined);
  assert.equal(presentProblems([{ code: 'reconciliation_required' }], lifecycle)[0].resolution, 'administrator');
});

test('product readiness, mapping and resource configuration retain their own recovery paths', () => {
  for (const [code, resolution] of [['PRODUCT_EVALUATION_NOT_READY', 'product'],
    ['OPTION_UNRESOLVED', 'integration_configuration'], ['OPTION_BINDING_REVIEW_REQUIRED', 'integration_configuration'],
    ['configuration', 'integration_preparation'], ['ATTRIBUTE_NOT_FOUND', 'integration_preparation']]) {
    assert.equal(presentProblems([{ code }], lifecycle)[0].resolution, resolution);
  }
});

test('all local problem reads retain public article and safe lifecycle projection without any writes', async () => {
  const calls = [];
  const db = { query: async (sql) => {
    calls.push(sql);
    assert.match(sql, /^SELECT/);
    return { rows: sql.includes('COUNT(*)::int') ? [{ count: 1 }] : [row] };
  } };
  const list = await problems({ configured: false }, db);
  const page = await problemPage({ configured: false }, {}, db);
  const statuses = await readStatuses(db, [5033]);
  for (const item of [list[0], page.items[0]]) {
    assert.equal(item.article, 'SV5111010');
    assert.equal(item.problems[0].resolution, 'lifecycle_reconciliation');
  }
  assert.equal(statuses.get(5033).problems[0].resolution, 'lifecycle_reconciliation');
  assert.equal(calls.filter((sql) => sql.includes('JOIN product_full_export_state')).length, 4);
});
