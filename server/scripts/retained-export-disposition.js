// Operator CLI for one retained legacy export file (migration 082).
// preview: read-only; Magento GET only. apply: records the disposition and its
// audit event after a fresh readback that must reproduce the preview token.
const path = require('node:path');
const service = require('../src/services/magento/retained-export-disposition');
const { createReadOnlyPool } = require('./magento-binding-evidence-audit');
const HELP = 'node retained-export-disposition.js --mode preview|apply --snapshot-id ID --expected-database NAME '
  + '[--actor-user-id ID --preview-token SHA256 --reason TEXT]';
const fail = code => { throw Object.assign(Error(code), { code }); };
function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const flags = { '--mode': 'mode', '--snapshot-id': 'snapshotId', '--expected-database': 'expectedDatabase',
    '--actor-user-id': 'actorUserId', '--preview-token': 'previewToken', '--reason': 'reason' }, values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = flags[args[i]], value = args[i + 1];
    if (!key || Object.hasOwn(values, key) || !value || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) fail('RETAINED_DISPOSITION_ARGUMENTS');
    values[key] = value;
  }
  if (!['preview', 'apply'].includes(values.mode) || !values.snapshotId || !values.expectedDatabase) fail('RETAINED_DISPOSITION_ARGUMENTS');
  if (values.mode === 'apply') {
    if (!/^[1-9]\d{0,17}$/.test(values.actorUserId || '') || !/^[a-f0-9]{64}$/.test(values.previewToken || '') || !values.reason) fail('RETAINED_DISPOSITION_ARGUMENTS');
    values.actorUserId = Number(values.actorUserId);
  } else if (values.actorUserId || values.previewToken || values.reason) fail('RETAINED_DISPOSITION_ARGUMENTS');
  return values;
}
async function run(args = process.argv.slice(2), { print = console.log, printError = console.error } = {}) {
  let pool;
  try {
    const input = parseArguments(args);
    if (input.help) { print(HELP); return 0; }
    const config = require('../src/config/env').magento;
    pool = input.mode === 'apply' ? require('../src/db/pool') : createReadOnlyPool(process.env);
    const database = (await pool.query('SELECT current_database() AS name')).rows[0].name;
    if (database !== input.expectedDatabase) fail('RETAINED_DISPOSITION_DATABASE_MISMATCH');
    const result = input.mode === 'preview'
      ? await service.preview(config, { snapshotId: input.snapshotId }, { databasePool: pool })
      : await service.apply(config, input, { databasePool: pool, actorUserId: input.actorUserId });
    print(JSON.stringify(result));
    return 0;
  } catch (cause) {
    printError(/^(RETAINED_DISPOSITION_|MAGENTO_)[A-Z0-9_]*$/.test(cause.code || '') ? cause.code : 'RETAINED_DISPOSITION_FAILED');
    return 1;
  } finally { if (pool) await pool.end(); }
}
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  run().then(code => { process.exitCode = code; });
}
module.exports = { parseArguments, run };
