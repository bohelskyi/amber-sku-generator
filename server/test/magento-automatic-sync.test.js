const { test } = require('node:test');
const assert = require('node:assert/strict');
const { presentStatus } = require('../src/services/magento/automatic-sync-status');

test('automatic sync status exposes only a closed state and safe reason, never remote evidence', () => {
  assert.deepEqual(presentStatus(null), { state: 'not_tracked', reason: null });
  const status = presentStatus({ state: 'needs_attention', reason_code: 'reconciliation_required', failure: 'secret OAuth body' });
  assert.equal(status.state, 'needs_attention'); assert.match(status.reason, /адміністратором/);
  assert.deepEqual(Object.keys(status), ['state', 'reason']);
  assert.doesNotMatch(JSON.stringify(status), /secret|OAuth|body/);
});

test('automatic status CLI help and missing explicit database never start a worker', async () => {
  const { run } = require('../scripts/magento-auto-status'); const output = [];
  assert.equal(await run(['--help'], {}, (value) => output.push(value)), 0);
  assert.equal(await run(['--expected-database', 'amber'], {}, (value) => output.push(value)), 1);
  assert.match(output[0], /no .env loading/);
  assert.equal(JSON.parse(output[1]).code, 'EXPLICIT_DATABASE_REQUIRED');
});
