const test = require('node:test');
const assert = require('node:assert/strict');
const { safeDiagnostics, problemPage, problemDetail } = require('../src/services/magento/sync-problems');

test('evaluation diagnostics preserve exact operator messages with only bounded allowlisted fields', () => {
  const [result] = safeDiagnostics([{ code: 'PRODUCT_EVALUATION_NOT_READY', issueFields: ['name'], evaluationIssues: [
    { field: 'name', code: 'MISSING_NAME', message: 'Заповніть українську назву.\nEN перевірено.', raw: { password: 'secret' }, token: 'secret' },
  ], raw: 'secret' }]);
  assert.deepEqual(result.evaluationIssues, [{ code: 'MISSING_NAME', field: 'name', message: 'Заповніть українську назву. EN перевірено.' }]);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  const [mapping] = safeDiagnostics([{ code: 'PERSISTED_BINDING_INVALID', diagnostic: { code: 'ATTRIBUTE_NOT_FOUND', target: 'kamin_obrobka', token: 'secret' } }]);
  assert.equal(mapping.target, 'kamin_obrobka');
  assert.equal(mapping.diagnosticCode, 'ATTRIBUTE_NOT_FOUND');
  assert.equal(JSON.stringify(mapping).includes('secret'), false);
});

test('problem filters share parameterized literal search and reason classification across page/count', async () => {
  const calls = [];
  const result = await problemPage({ configured: false }, { search: 'AG_%\\', reason: 'product', category: 'SV', limit: 500 }, {
    query: async (sql, values) => { calls.push({ sql, values }); return { rows: sql.includes('SELECT COUNT(*)') ? [{ count: 4 }] : [] }; },
  });
  assert.equal(result.pageInfo.limit, 100);
  assert.deepEqual(calls[0].values, ['unconfigured', 'SV', '%AG\\_\\%\\\\%', 'product', 100, 0]);
  assert.deepEqual(calls[1].values, calls[0].values.slice(0, -2));
  assert.match(calls[0].sql, /ILIKE \$3 ESCAPE/);
  assert.match(calls[1].sql, /PRODUCT_EVALUATION_NOT_READY/);
  assert.ok(calls.every((call) => call.sql.startsWith('SELECT')));
});

test('exact product read retains pending or synchronized product without reporting old problems as current', async () => {
  for (const state of ['pending', 'synced', 'not_tracked']) {
    const calls = [];
    const result = await problemDetail({ configured: false }, '7', { query: async (sql, values) => {
      calls.push({ sql, values }); return { rows: [{ productId: 7, article: 'AG-000007', category: 'SV', product_status: 'active',
        state, diagnostics: [{ code: 'PRODUCT_EVALUATION_NOT_READY', issueFields: ['name'] }] }] };
    } });
    assert.equal(result.state, state);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(calls[0].values, ['unconfigured', 7]);
    assert.match(calls[0].sql, /WHERE p.id=\$2$/);
    assert.doesNotMatch(calls[0].sql, /UPDATE|INSERT|DELETE/);
  }
});

test('exact read cannot fall back to another product and invalid filter is rejected before any query', async () => {
  const db = { query: async () => ({ rows: [] }) };
  await assert.rejects(problemDetail({}, 123, db), (error) => error.statusCode === 404);
  await assert.rejects(problemDetail({}, '7 OR 1=1', db), (error) => error.statusCode === 422);
  await assert.rejects(problemPage({}, { reason: "product' OR true" }, { query: () => assert.fail('No query allowed') }), (error) => error.statusCode === 422);
});
