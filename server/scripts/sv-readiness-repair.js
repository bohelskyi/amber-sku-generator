const fs = require('node:fs/promises');
const path = require('node:path');
const service = require('../src/services/sv-readiness-repair');
const { createReadOnlyPool } = require('./magento-binding-evidence-audit');
const { createReceiptWriter } = require('./exposure-bulk-receipt');
function parseArguments(args) {
  const flags = { '--expected-database': 'expectedDatabase', '--binding-revision': 'bindingRevisionId',
    '--output': 'output', '--plan': 'planPath', '--expected-hash': 'expectedHash', '--actor-user-id': 'actorUserId' };
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !out.apply) { out.apply = true; continue; }
    const key = flags[args[i]], value = args[++i];
    if (!key || Object.hasOwn(out, key) || !value || value.startsWith('--') || /[\u0000-\u001f]/.test(value)) throw new Error('SV_REPAIR_ARGUMENTS');
    out[key] = value;
  }
  if (!out.expectedDatabase || !out.output || (out.apply
    ? (!out.planPath || !/^[a-f0-9]{64}$/.test(out.expectedHash || '') || !/^[1-9]\d*$/.test(out.actorUserId || '') || !Number.isSafeInteger(Number(out.actorUserId)) || out.bindingRevisionId)
    : (!out.bindingRevisionId || out.planPath || out.expectedHash || out.actorUserId))) throw new Error('SV_REPAIR_ARGUMENTS');
  if (out.bindingRevisionId) require('../src/services/magento/binding-contract').identity(out.bindingRevisionId);
  return out;
}
async function run(args = process.argv.slice(2)) {
  let pool, output;
  try {
    const input = parseArguments(args);
    pool = input.apply ? require('../src/db/pool') : createReadOnlyPool(process.env);
    const options = { ...input, databasePool: pool, mutationContext: { actorUserId: input.actorUserId, requestId: 'sv-readiness-cli' } };
    if (input.apply) {
      const plan = JSON.parse(await fs.readFile(input.planPath, 'utf8'));
      service.verify(plan, input.expectedHash, input.expectedDatabase);
      const checkpoint = await createReceiptWriter(input.output);
      const result = await service.apply(plan, { ...options, checkpoint });
      console.log(JSON.stringify({ output: input.output, counts: result.counts }));
      return result.failed.length || result.conflicted.length ? 2 : 0;
    }
    output = await fs.open(input.output, 'wx');
    const plan = await service.preview(options);
    await output.writeFile(JSON.stringify(plan, null, 2) + '\n'); await output.sync();
    console.log(JSON.stringify({ output: input.output, planHash: plan.planHash, summary: plan.summary })); return 0;
  } catch (e) { console.error(/^SV_REPAIR_/.test(e.code || e.message) ? e.code || e.message : 'SV_REPAIR_FAILED'); return 1; }
  finally { if (output) await output.close(); if (pool) await pool.end(); }
}
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  run().then(code => { process.exitCode = code; });
}
module.exports = { parseArguments, run };
