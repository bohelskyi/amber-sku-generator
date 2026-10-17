'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const script = require('../scripts/first-sync-keep-local');
const c = require('../src/services/magento/binding-contract');
const { roundedWeight } = require('../src/services/magento/first-sync-batch-preflight');

const common = ['--server-root', path.resolve(__dirname, '..'), '--expected-database', 'amber_test', '--actor-id', '1', '--installation-key', 'amber'];
const targets = ['--targets', 'price,vaha_vyrobu,diametr_namystyny,dovzhyna_namystyny,rozmir_kameniu'];
const keepable = (target, local, remote, extra = {}) => ({ target, scope: 'all', status: 'review_required', canKeepLocal: true,
  received: false, local: { known: true, present: true, value: local }, remote: { known: true, present: true, value: remote }, ...extra });
function fakeRuntime({ inspections, applied = [], prepared = null }) {
  return {
    c: { hash: c.hash, installation: () => {} }, roundedWeight,
    config: { parseMagentoConfig: () => ({ configured: true }) },
    pool: { databaseSecrets: () => [] },
    first: {
      decisions: input => [...input.choices].sort((a, b) => (a.scope + '/' + a.target).localeCompare(b.scope + '/' + b.target)),
      async review(_config, input) { return inspections[input.sku]; },
      async applyWithPreparedValidation(_config, command, options) {
        await options.validateFirstSyncDecision(inspections[command.sku], {}, this.decisions(command));
        const rows = prepared?.[command.sku] || command.choices.map(choice => ({ ...choice, received: false,
          record: { state: 'pending_outward_confirmation', source: { decision: 'keep_local' } } }));
        options.validatePreparedFirstSyncDecision({ rows });
        applied.push(command);
        return { receipt: { sessionId: 's', revision: '2', alreadyApplied: false,
          fields: command.choices.map(choice => ({ ...choice, state: 'pending_outward_confirmation' })) }, complete: false, readyForOutbound: true };
      },
    },
  };
}
async function run(mode, runtime, extra = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'keep-local-'));
  const input = path.join(directory, 'input.json');
  await fs.writeFile(input, JSON.stringify({ bindingRevisionId: 'binding', items: [{ sku: 'CH1' }, { sku: 'CH2' }, { sku: 'CH3' }] }));
  const lines = [], errors = [];
  const pool = { query: async () => ({ rows: [{ name: 'amber_test' }] }) };
  const code = await script.main(['--mode', mode, '--input', input, '--output', path.join(directory, 'out.jsonl'), ...common, ...targets, ...extra],
    { runtime, pool, getOnly: fetch => fetch, fetchImpl: async () => ({}), print: line => lines.push(JSON.parse(line)), printError: line => errors.push(line) });
  return { code, lines, errors };
}
const inspections = () => ({
  CH1: { mode: 'first', previewToken: 'a'.repeat(64), fields: [keepable('diametr_namystyny', '7.4', '14.700000'),
    keepable('vaha_vyrobu', '19.500', '20.000000'), keepable('price', '6700.00', '6600'),
    keepable('meta_title', 'Amber', 'Magento'), { target: 'dovzhyna_vyrobu', scope: 'all', status: 'equal', canKeepLocal: false }] },
  CH2: { mode: 'ordinary', fields: [] },
  CH3: { mode: 'first', previewToken: 'b'.repeat(64), fields: [keepable('vaha_vyrobu', '107.000', '20.000000'),
    keepable('rozmir_kameniu', '14,7×7,4', '7.4×14.7'), { target: 'kolir', scope: 'all', status: 'imported', received: false }] },
});

test('arguments require explicit approved targets; --allow-imports only applies', () => {
  assert.throws(() => script.argumentsFor(['--mode', 'preview', '--input', 'x', '--output', 'y', ...common]), /KEEP_LOCAL_ARGUMENTS/);
  for (const list of ['meta_title', 'price,price', 'kolir'])
    assert.throws(() => script.argumentsFor(['--mode', 'preview', '--input', 'x', '--output', 'y', ...common, '--targets', list]), /KEEP_LOCAL_ARGUMENTS/);
  assert.throws(() => script.argumentsFor(['--mode', 'preview', '--input', 'x', '--output', 'y', ...common, ...targets, '--allow-imports']), /KEEP_LOCAL_ARGUMENTS/);
  assert.deepEqual([...script.argumentsFor(['--mode', 'apply', '--input', 'x', '--output', 'y', ...common, ...targets]).targets],
    ['price', 'vaha_vyrobu', 'diametr_namystyny', 'dovzhyna_namystyny', 'rozmir_kameniu']);
});

test('preview selects only offered approved targets and whole-gram weight rounding', async () => {
  const applied = [], result = await run('preview', fakeRuntime({ inspections: inspections(), applied }));
  assert.equal(result.code, 0); assert.equal(applied.length, 0);
  assert.deepEqual(result.lines[0], { sku: 'CH1', status: 'keepable', fields: ['all/diametr_namystyny', 'all/vaha_vyrobu', 'all/price'], imports: [] });
  assert.deepEqual(result.lines[1], { sku: 'CH2', status: 'skipped', mode: 'ordinary' });
  assert.deepEqual(result.lines[2], { sku: 'CH3', status: 'keepable', fields: ['all/rozmir_kameniu'], imports: ['all/kolir'], notRounding: ['all/vaha_vyrobu'] });
  assert.equal(result.lines.at(-1).magentoWrites, 0);
});

test('apply records keep_local and skips products with Magento imports unless allowed', async () => {
  const applied = [], result = await run('apply', fakeRuntime({ inspections: inspections(), applied }));
  assert.equal(result.code, 2);
  assert.deepEqual(applied.map(command => command.sku), ['CH1']);
  assert.deepEqual(applied[0].choices.map(choice => choice.choice), ['keep_local', 'keep_local', 'keep_local']);
  assert.equal(result.lines[0].status, 'kept');
  assert.equal(result.lines[2].code, 'KEEP_LOCAL_OTHER_IMPORTS_PRESENT');
  const allowed = [], second = await run('apply', fakeRuntime({ inspections: inspections(), applied: allowed }), ['--allow-imports']);
  assert.equal(second.code, 0); assert.deepEqual(allowed.map(command => command.sku), ['CH1', 'CH3']);
});

test('a changed fresh transition or a new import is refused before commit', async () => {
  const prepared = { CH1: [{ target: 'diametr_namystyny', scope: 'all', received: false, record: { state: 'review_required', source: {} } }] };
  const applied = [], result = await run('apply', fakeRuntime({ inspections: inspections(), applied, prepared }));
  assert.equal(result.lines[0].code, 'KEEP_LOCAL_TRANSITION_CHANGED'); assert.equal(applied.filter(item => item.sku === 'CH1').length, 0);
  assert.throws(() => script.validatePrepared({ rows: [
    { target: 'price', scope: 'all', record: { state: 'pending_outward_confirmation', source: { decision: 'keep_local' } } },
    { target: 'kolir', scope: 'all', record: { state: 'imported' } }] }, [{ target: 'price', scope: 'all' }], false),
  /KEEP_LOCAL_OTHER_IMPORTS_PRESENT/);
});

test('a global authority failure stops the run', async () => {
  const runtime = fakeRuntime({ inspections: inspections() });
  runtime.first.review = async () => { throw Object.assign(Error('x'), { code: 'ADMIN_PERMISSION_REVOKED' }); };
  const result = await run('preview', runtime);
  assert.equal(result.code, 1); assert.equal(result.lines.length, 2); assert.equal(result.lines.at(-1).counts.stopped, 'ADMIN_PERMISSION_REVOKED');
});

test('an equal name receipt is not an import; a fresh name import still is', () => {
  const kept = { target: 'price', scope: 'all', status: 'pending_outward_confirmation', record: { state: 'pending_outward_confirmation', source: { decision: 'keep_local' } } };
  const equalName = { target: 'name', scope: 'all', status: 'equal', record: { state: 'name_received' } };
  const importedName = { target: 'name', scope: 'en', status: 'imported', record: { state: 'name_received' } };
  script.validatePrepared({ rows: [kept, equalName] }, [{ target: 'price', scope: 'all' }], false);
  assert.throws(() => script.validatePrepared({ rows: [kept, importedName] }, [{ target: 'price', scope: 'all' }], false), /KEEP_LOCAL_OTHER_IMPORTS_PRESENT/);
  script.validatePrepared({ rows: [kept, importedName] }, [{ target: 'price', scope: 'all' }], true);
});
