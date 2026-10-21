const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { recordedDiagnostics, safeDiagnostics, problemSelectSql } = require('../src/services/magento/sync-problems');
const { groupPage, groupProducts } = require('../src/services/magento/problem-groups');

test('shared causes capture the original unambiguous semantic value including zero, never labels as identity', () => {
  const bindingRevisionId = randomUUID();
  const blocker = { code: 'OPTION_BINDING_REVIEW_REQUIRED', target: 'color' };
  const report = { attributeSet: { amberGroup: 'KL', routeKey: 'KL.base' }, attributes: [{ target: 'color',
    source: [{ kind: 'semantic', questionKey: 'kolir', storedValue: 0, label: 'Медовий', password: 'secret' }],
    persistedDecision: { routeKey: 'KL.base' } }] };
  const recorded = safeDiagnostics(recordedDiagnostics([blocker], report, bindingRevisionId))[0];
  assert.equal(recorded.causeContext.bindingRevisionId, bindingRevisionId);
  assert.equal(recorded.value, '0'); assert.equal(recorded.question, 'kolir');
  assert.equal(JSON.stringify(recorded).includes('secret'), false);
  assert.equal(JSON.stringify(recorded).includes('Медовий'), false);
  for (const source of [[...report.attributes[0].source, { kind: 'semantic', questionKey: 'other', storedValue: 0 }],
    [{ kind: 'semantic', questionKey: 'kolir', storedValue: null }], [{ kind: 'literal', storedValue: 0 }]]) {
    const other = { ...report, attributes: [{ ...report.attributes[0], source }] };
    assert.equal(safeDiagnostics(recordedDiagnostics([blocker], other, bindingRevisionId))[0].causeContext, undefined);
  }
  assert.equal(safeDiagnostics([blocker])[0].causeContext, undefined, 'Legacy diagnostics acquire no inferred context');
});

test('group page applies literal bounded parameters and returns whole-query counts in one read', async () => {
  const calls = [];
  const result = await groupPage({ configured: false }, { search: 'AG_%\\', category: 'KL', reason: 'integration', limit: 999, offset: 200 }, {
    async query(sql, values) { calls.push({ sql, values }); return { rows: [{ items: [], total: 300, product_count: 901, diagnostic_count: 1200, categories: [], reason_counts: [] }] }; },
  });
  assert.equal(calls.length, 1); assert.equal(result.pageInfo.limit, 100);
  assert.equal(result.pageInfo.total, 300); assert.equal(result.summary.productCount, 901);
  assert.equal(result.summary.diagnosticCount, 1200);
  assert.deepEqual(calls[0].values, ['unconfigured', 'KL', '%AG\\_\\%\\\\%', 'integration', 100, 200]);
  assert.doesNotMatch(calls[0].sql, /\b(UPDATE|INSERT|DELETE)\b/);
  assert.match(calls[0].sql, /count\(DISTINCT identity_id\)/);
});

test('invalid group identity and paging fail before database access', async () => {
  const db = { query: () => assert.fail('No query for invalid request') };
  await assert.rejects(groupProducts({}, "' OR true", {}, db), error => error.statusCode === 422);
  await assert.rejects(groupPage({}, { offset: -1 }, db), error => error.statusCode === 422);
  await assert.rejects(groupPage({}, { reason: 'unknown' }, db), error => error.statusCode === 422);
});

test('group queries use the explicit shared identity projection and retain unfinished identity deletions', async () => {
  assert.match(problemSelectSql, /\bi\.id AS identity_id\b/, 'The shared SELECT owns the identity column; consumers never inject it by string replacement');
  const calls = [];
  const db = { async query(sql) { calls.push(sql); return { rows: [] }; } };
  await groupPage({ configured: false }, {}, db);
  await groupProducts({ configured: false }, 'a'.repeat(32), {}, db);
  for (const sql of calls) {
    assert.ok(sql.includes(problemSelectSql), 'Both grouped reads use the complete shared projection unchanged');
    assert.match(sql, /WHERE \(r\.state='needs_attention' OR d\.state<>'finalized'\)/);
    assert.doesNotMatch(sql, /d\.product_id\s*=\s*p\.id/, 'Unfinished deletions follow the identity join just like the legacy queue');
  }
});

test('group samples select one member per group without accumulating every member as JSON', async () => {
  let statement;
  const db = { async query(sql) { statement = sql; return { rows: [] }; } };
  await groupPage({ configured: false }, {}, db);
  assert.match(statement, /SELECT DISTINCT ON \(group_id\)/);
  assert.match(statement, /ORDER BY group_id,"productId"/);
  assert.doesNotMatch(statement, /\barray_agg\s*\(/i);
});
