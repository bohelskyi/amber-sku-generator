const fs = require('node:fs/promises');
const path = require('node:path');
const { parseMagentoConfig } = require('../src/config/magento');
const service = require('../src/services/magento/exposure-reconciliation');
const bulk = require('../src/services/magento/exposure-bulk-reconciliation');
const { createReceiptWriter } = require('./exposure-bulk-receipt');
const { assertEvidenceSafe } = require('../src/services/magento/binding-evidence-audit');
const { createReadOnlyPool, databaseSecrets } = require('./magento-binding-evidence-audit');

const HELP = `node scripts/magento-reconcile-exposure.js --expected-database NAME --output NEW_FILE
  --sku EXACT_SKU [--binding-revision UUID]
Preview only: read-only Amber and Magento GETs; optional full hypothetical sync preview.
Stable-public-SKU recount preview (single product, current public-SKU binding required):
  --stable-recount --sku EXACT_PUBLIC_SKU --binding-revision UUID
Stable recount apply: add --stable-recount to the reviewed single-product apply command.
This mode proves unchanged public identity and atomically records a reviewed resync handoff.
Bulk preview, bounded to an explicit candidate file (maximum 5000):
  --bulk --candidates FILE --expected-database NAME --output NEW_PREVIEW_FILE
Apply a reviewed single-product plan:
  --apply --plan PREVIEW_FILE --expected-hash SHA256 --actor-user-id ID
  --expected-database NAME --output NEW_RECEIPT_FILE
Bulk apply: add --bulk; --output must be a NEW receipt directory.
Resume the SAME plan/hash into another NEW directory; committed rows are skipped.
Only hold/historical_ambiguity -> hold/prior_exposure; no publication or Magento writes.
Requires exports.reconcile for apply. Exclusions, corrections and acknowledgements are never cleared.`;
function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const flags = { '--sku': 'sku', '--binding-revision': 'bindingRevisionId', '--expected-database': 'expectedDatabase',
    '--output': 'output', '--plan': 'planPath', '--expected-hash': 'expectedHash', '--actor-user-id': 'actorUserId',
    '--candidates': 'candidatesPath' };
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !out.apply) { out.apply = true; continue; }
    if (args[i] === '--bulk' && !out.bulk) { out.bulk = true; continue; }
    if (args[i] === '--stable-recount' && !out.stableRecount) { out.stableRecount = true; continue; }
    const key = flags[args[i]]; const value = args[++i];
    if (!key || Object.hasOwn(out, key) || !value || value.startsWith('--') || value.length > 4096
      || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('EXPOSURE_ARGUMENTS');
    out[key] = value;
  }
  if (!out.expectedDatabase || !out.output) throw new Error('EXPOSURE_ARGUMENTS');
  if (out.apply ? (!out.planPath || !/^[a-f0-9]{64}$/.test(out.expectedHash || '')
    || !/^[1-9]\d*$/.test(out.actorUserId || '') || !Number.isSafeInteger(Number(out.actorUserId)) || out.sku || out.bindingRevisionId || out.candidatesPath)
    : (out.planPath || out.expectedHash || out.actorUserId || (out.bulk
      ? (!out.candidatesPath || out.sku || out.bindingRevisionId) : (!out.sku || out.candidatesPath)))) throw new Error('EXPOSURE_ARGUMENTS');
  if (out.bindingRevisionId) require('../src/services/magento/binding-contract').identity(out.bindingRevisionId);
  if (out.stableRecount && (out.bulk || (!out.apply && !out.bindingRevisionId))) throw new Error('EXPOSURE_ARGUMENTS');
  return out;
}
async function run({ args = [], env = process.env, databasePool, fetchImpl, signal, print = console.log } = {}) {
  let ownedPool; let output;
  try {
    const input = parseArguments(args);
    if (input.help) { print(HELP); return 0; }
    const config = parseMagentoConfig(env);
    if (!config.configured) throw Object.assign(new Error(), { code: 'MAGENTO_NOT_CONFIGURED' });
    if (!databasePool) {
      ownedPool = input.apply ? require('../src/db/pool') : createReadOnlyPool(env);
      databasePool = ownedPool;
    }
    const options = { databasePool, fetchImpl, signal, expectedDatabase: input.expectedDatabase,
      sensitiveValues: databaseSecrets(env), bindingRevisionId: input.bindingRevisionId,
      mutationContext: { actorUserId: input.actorUserId, requestId: 'magento-exposure-cli' } };
    if (input.bulk && input.apply) {
      const stored = JSON.parse(await fs.readFile(input.planPath, 'utf8'));
      bulk.verify(stored.plan, input.expectedHash, config, input.expectedDatabase);
      const write = await createReceiptWriter(input.output);
      const result = await bulk.apply(config, stored.plan, input.expectedHash, { ...options, checkpoint: async receipt => {
        assertEvidenceSafe(receipt, config, options.sensitiveValues);
        await write(receipt);
      } });
      print(JSON.stringify({ action: 'bulk-apply', output: path.join(input.output, 'summary.json'),
        planHash: result.planHash, complete: result.complete, counts: result.counts }));
      return result.complete && !result.counts.conflicted && !result.counts.failed ? 0 : 2;
    }
    // Reserve the output before any mutation. Never overwrite review evidence.
    output = await fs.open(input.output, 'wx');
    let result;
    const selected = input.stableRecount ? require('../src/services/magento/stable-recount-exposure') : service;
    if (input.apply) {
      const stored = JSON.parse(await fs.readFile(input.planPath, 'utf8'));
      result = await selected.apply(config, stored.plan, input.expectedHash, options);
    } else {
      const plan = input.bulk ? await bulk.preview(config, JSON.parse(await fs.readFile(input.candidatesPath, 'utf8')), options)
        : await selected.preview(config, input.sku, options);
      result = { plan, ...(!input.stableRecount && input.bindingRevisionId && plan.eligible
        ? { syncPreview: await service.hypotheticalSync(config, plan, options) } : {}) };
    }
    assertEvidenceSafe(result, config, options.sensitiveValues);
    await output.writeFile(JSON.stringify(result, null, 2) + '\n');
    await output.sync();
    print(JSON.stringify({ action: input.apply ? 'apply' : 'preview', output: input.output,
      planHash: result.plan?.planHash || result.planHash, eligible: result.plan?.eligible,
      blockers: result.plan?.blockers, hypotheticalSendable: result.syncPreview?.hypothetical.sendable,
      ...(input.bulk ? { action: 'bulk-preview', counts: result.plan.summary } : {}),
      alreadyApplied: result.alreadyApplied }));
    return input.bulk && (result.plan.summary.conflicted || result.plan.summary.failed) ? 2 : 0;
  } catch (cause) {
    print(JSON.stringify({ code: /^(MAGENTO|EXPOSURE|REPAIR|ADMIN|EXPORT|LIFECYCLE)_[A-Z_]+$/.test(cause.code || '')
      ? cause.code : cause.message === 'EXPOSURE_ARGUMENTS' ? cause.message : 'EXPOSURE_RECONCILIATION_FAILED' }));
    return 1;
  } finally { if (output) await output.close(); if (ownedPool) await ownedPool.end(); }
}
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  run({ args: process.argv.slice(2), signal: controller.signal }).then((code) => { process.exitCode = code; })
    .finally(() => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
}
module.exports = { run, parseArguments };
