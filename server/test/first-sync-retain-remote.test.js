'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const script = require('../scripts/first-sync-retain-remote');
const c = require('../src/services/magento/binding-contract');

const common = ['--server-root', path.resolve(__dirname, '..'), '--expected-database', 'amber_test', '--actor-id', '1', '--installation-key', 'amber'];
const retainable = (target, extra = {}) => ({ target, scope: 'all', status: 'review_required', canRetainRemote: true, received: false, ...extra });
function fakeRuntime({ inspections, applied = [], prepared = null }) {
  return {
    c: { hash: c.hash, installation: () => {} },
    config: { parseMagentoConfig: () => ({ configured: true }) },
    pool: { databaseSecrets: () => [] },
    first: {
      decisions: input => [...input.choices].sort((a, b) => (a.scope + '/' + a.target).localeCompare(b.scope + '/' + b.target)),
      async review(_config, input) { return inspections[input.sku]; },
      async applyWithPreparedValidation(_config, command, options) {
        const base = inspections[command.sku];
        await options.validateFirstSyncDecision(base, {}, command.choices);
        const rows = prepared?.[command.sku] || command.choices.map(choice => ({ ...choice, received: false,
          record: { state: 'remote_retained', after: null, source: { decision: 'retain_remote' } } }));
        options.validatePreparedFirstSyncDecision({ rows });
        applied.push(command);
        return { receipt: { sessionId: 's', revision: '2', alreadyApplied: false, fields: command.choices.map(choice => ({ ...choice, state: 'remote_retained' })) },
          complete: true, readyForOutbound: true };
      },
    },
  };
}
async function run(mode, runtime, extra = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'retain-remote-'));
  const input = path.join(directory, 'input.json');
  await fs.writeFile(input, JSON.stringify({ bindingRevisionId: 'binding', items: [{ sku: 'SV1' }, { sku: 'SV2' }, { sku: 'SV3' }] }));
  const lines = [], errors = [];
  const pool = { query: async () => ({ rows: [{ name: 'amber_test' }] }) };
  const code = await script.main(['--mode', mode, '--input', input, '--output', path.join(directory, 'out.jsonl'), ...common, ...extra],
    { runtime, pool, getOnly: fetch => fetch, fetchImpl: async () => ({}), print: line => lines.push(JSON.parse(line)), printError: line => errors.push(line) });
  return { code, lines, errors };
}
const inspections = () => ({
  SV1: { mode: 'first', previewToken: 'a'.repeat(64), fields: [retainable('kolir'), retainable('typy_obrobky_burshtynu'),
    { target: 'price', scope: 'all', status: 'equal', canRetainRemote: false }] },
  SV2: { mode: 'ordinary', fields: [] },
  SV3: { mode: 'first', previewToken: 'b'.repeat(64), fields: [retainable('kolir'), { target: 'rozmir_suveniriv', scope: 'all', status: 'imported', received: false }] },
});

test('arguments require an explicit mode, database, actor and installation; --allow-imports only applies', () => {
  assert.throws(() => script.argumentsFor(['--input', 'x', '--output', 'y', ...common]), /RETAIN_REMOTE_ARGUMENTS/);
  assert.throws(() => script.argumentsFor(['--mode', 'preview', '--input', 'x', '--output', 'y', ...common, '--allow-imports']), /RETAIN_REMOTE_ARGUMENTS/);
  assert.equal(script.argumentsFor(['--mode', 'apply', '--input', 'x', '--output', 'y', ...common, '--allow-imports']).allowImports, true);
  assert.throws(() => script.parseInput(Buffer.from('{"bindingRevisionId":"b","items":[{"sku":"A"},{"sku":"A"}]}')), /INPUT_INVALID/);
});

test('preview lists retainable fields and other imports without applying anything', async () => {
  const applied = [], result = await run('preview', fakeRuntime({ inspections: inspections(), applied }));
  assert.equal(result.code, 0); assert.equal(applied.length, 0);
  assert.deepEqual(result.lines[0], { sku: 'SV1', status: 'retainable', fields: ['all/kolir', 'all/typy_obrobky_burshtynu'], imports: [] });
  assert.deepEqual(result.lines[1], { sku: 'SV2', status: 'skipped', mode: 'ordinary' });
  assert.deepEqual(result.lines[2].imports, ['all/rozmir_suveniriv']);
  assert.equal(result.lines.at(-1).magentoWrites, 0);
});

test('apply retains only explicit choices and skips products with other imports unless allowed', async () => {
  const applied = [], result = await run('apply', fakeRuntime({ inspections: inspections(), applied }));
  assert.equal(result.code, 2);
  assert.deepEqual(applied.map(command => command.sku), ['SV1']);
  assert.deepEqual(applied[0].choices.map(choice => choice.choice), ['retain_remote', 'retain_remote']);
  assert.equal(result.lines[0].status, 'retained'); assert.equal(result.lines[0].complete, true);
  assert.equal(result.lines[2].code, 'RETAIN_REMOTE_OTHER_IMPORTS_PRESENT');
  const allowed = [], second = await run('apply', fakeRuntime({ inspections: inspections(), applied: allowed }), ['--allow-imports']);
  assert.equal(second.code, 0); assert.deepEqual(allowed.map(command => command.sku), ['SV1', 'SV3']);
});

test('a fresh prepared plan with a changed transition or a new import is refused before commit', async () => {
  const prepared = { SV1: [{ target: 'kolir', scope: 'all', received: false, record: { state: 'imported', after: '1', source: {} } },
    { target: 'typy_obrobky_burshtynu', scope: 'all', received: false, record: { state: 'remote_retained', after: null, source: { decision: 'retain_remote' } } }] };
  const applied = [], result = await run('apply', fakeRuntime({ inspections: inspections(), applied, prepared }));
  assert.equal(result.lines[0].code, 'RETAIN_REMOTE_TRANSITION_CHANGED'); assert.equal(applied.filter(c => c.sku === 'SV1').length, 0);
  assert.throws(() => script.validatePrepared({ rows: [
    { target: 'kolir', scope: 'all', record: { state: 'remote_retained', after: null, source: { decision: 'retain_remote' } } },
    { target: 'rozmir_suveniriv', scope: 'all', record: { state: 'imported' } }] }, [{ target: 'kolir', scope: 'all' }], false),
  /RETAIN_REMOTE_OTHER_IMPORTS_PRESENT/);
});

test('a global authority failure stops the run', async () => {
  const runtime = fakeRuntime({ inspections: inspections() });
  runtime.first.review = async () => { throw Object.assign(Error('x'), { code: 'ADMIN_PERMISSION_REVOKED' }); };
  const result = await run('preview', runtime);
  assert.equal(result.code, 1); assert.equal(result.lines.length, 2); assert.equal(result.lines.at(-1).counts.stopped, 'ADMIN_PERMISSION_REVOKED');
});

test('an equal name receipt is not an import for retain_remote; a fresh name import still is', () => {
  const retained = { target: 'kolir', scope: 'all', record: { state: 'remote_retained', after: null, source: { decision: 'retain_remote' } } };
  script.validatePrepared({ rows: [retained, { target: 'name', scope: 'all', status: 'equal', record: { state: 'name_received' } }] },
    [{ target: 'kolir', scope: 'all' }], false);
  assert.throws(() => script.validatePrepared({ rows: [retained, { target: 'name', scope: 'all', status: 'imported', record: { state: 'name_received' } }] },
    [{ target: 'kolir', scope: 'all' }], false), /RETAIN_REMOTE_OTHER_IMPORTS_PRESENT/);
});
