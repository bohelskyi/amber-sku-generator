const path = require('node:path');
const { parseMagentoConfig } = require('../src/config/magento');
const { enqueue, applyJob } = require('../src/services/magento/sync-job.service');
const { identity, error } = require('../src/services/magento/binding-contract');
const { databaseSecrets } = require('./magento-binding-evidence-audit');
const HELP = 'npm run magento:sync -- --sku SKU --binding-revision PUBLISHED_UUID --actor-user-id ID [--apply] [--json]\n'
  + 'Default: bind/enqueue only; GETs, no Magento writes. Retry a bound job: --job UUID --actor-user-id ID --apply.\n'
  + 'Requires migration 042 and the current immutable publication. No publish or force/retry-write flag.';
function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const out = {};
  const names = { '--sku': 'sku', '--binding-revision': 'bindingRevisionId', '--actor-user-id': 'actorUserId', '--job': 'jobId', '--apply': 'apply', '--json': 'json' };
  for (let i = 0; i < args.length; i++) {
    const key = names[args[i]];
    if (!key || Object.hasOwn(out, key)) throw error(422, 'MAGENTO_SYNC_ARGUMENTS', 'Invalid arguments');
    if (['apply', 'json'].includes(key)) { out[key] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--') || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw error(422, 'MAGENTO_SYNC_ARGUMENTS', 'Invalid arguments');
    out[key] = value;
  }
  if (!/^[1-9]\d*$/.test(out.actorUserId || '') || !Number.isSafeInteger(Number(out.actorUserId))
    || (out.jobId ? out.sku || out.bindingRevisionId || !out.apply : !out.sku || !out.bindingRevisionId)) throw error(422, 'MAGENTO_SYNC_ARGUMENTS', 'Select one product/publication or existing job');
  identity(out.jobId || out.bindingRevisionId); out.actorUserId = Number(out.actorUserId);
  return out;
}
async function run({ args = [], env = process.env, databasePool, fetchImpl, service = { enqueue, applyJob }, print = console.log, printError = console.error } = {}) {
  let owned;
  try {
    const input = parse(args);
    if (input.help) { print(HELP); return 0; }
    const config = parseMagentoConfig(env);
    if (!config.configured) throw error(422, 'MAGENTO_NOT_CONFIGURED', 'Magento configuration required');
    if (!databasePool) { owned = require('../src/db/pool'); databasePool = owned; }
    const options = { databasePool, fetchImpl, actorUserId: input.actorUserId, apply: input.apply === true,
      sensitiveValues: databaseSecrets(env) };
    let job = input.jobId ? { id: input.jobId } : await service.enqueue(config, input, options);
    if (input.apply) job = await service.applyJob(config, job.id, options);
    const receipt = { ok: !['blocked', 'uncertain', 'retryable'].includes(job.state), jobId: job.id, state: job.state,
      sku: job.sku, bindingRevisionId: job.binding_revision_id, planHash: job.plan_hash,
      attempts: job.attempts, failure: job.failure, operations: job.intent?.operations,
      acknowledgedAt: job.acknowledged_at, magentoMutationEnabled: options.apply };
    print(input.json ? JSON.stringify(receipt) : `Job ${job.id}: ${job.state}\nSKU: ${job.sku}\nPlan: ${job.plan_hash}\n`
      + `Operations: ${job.intent?.operations.map((o) => o.domain).join(' -> ')}\n`
      + (job.failure ? `Failure: ${job.failure.code}\n` : '')
      + (input.apply ? 'Acknowledged only after read verification.' : 'Magento writes: NONE. Add --apply to execute this bound job.'));
    return receipt.ok ? 0 : 2;
  } catch (e) {
    const code = /^(MAGENTO|ADMIN|EXPORT)_[A-Z_]+$/.test(e.code || '') ? e.code : 'MAGENTO_SYNC_FAILED';
    printError(JSON.stringify({ code })); if (args.includes('--json')) print(JSON.stringify({ ok: false, code })); return 1;
  } finally { if (owned) await owned.end(); }
}
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  run({ args: process.argv.slice(2) }).then((code) => { process.exitCode = code; });
}
module.exports = { parse, run };
