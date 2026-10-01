// Explicit local operator workflow. Preview performs Amber reads and exact
// Magento GETs only. Apply mutates one local lifecycle row per transaction and
// never calls a Magento write API.
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { parseMagentoConfig } = require('../src/config/magento');
const service = require('../src/services/magento/external-delivery-acknowledgement');
const { createReceiptWriter } = require('./exposure-bulk-receipt');
const { assertEvidenceSafe } = require('../src/services/magento/binding-evidence-audit');
const { createReadOnlyPool, databaseSecrets } = require('./magento-binding-evidence-audit');

const HELP = `npm run magento:external-delivery -- preview --expected-database NAME --candidates FILE --output NEW_PLAN_FILE
npm run magento:external-delivery -- apply --expected-database NAME --actor-user-id ID --plan PLAN_FILE --expected-hash SHA256 --output NEW_RECEIPT_DIRECTORY
Preview is read-only and uses exact Magento SKU GETs. Apply requires exports.reconcile, rechecks every exact counterpart, and acknowledges only reviewed normal/replacement revisions before API delivery cutover. It performs no Magento mutation and never confirms or creates a snapshot.`;

function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const [action, ...rest] = args;
  if (!['preview', 'apply'].includes(action)) throw new Error('INVALID_ARGUMENTS');
  const names = { '--expected-database': 'expectedDatabase', '--candidates': 'candidatesPath',
    '--output': 'output', '--actor-user-id': 'actorUserId', '--plan': 'planPath', '--expected-hash': 'expectedHash' };
  const result = { action };
  for (let i = 0; i < rest.length; i += 2) {
    const key = names[rest[i]]; const value = rest[i + 1];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(result, key)
      || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('INVALID_ARGUMENTS');
    result[key] = value;
  }
  const required = action === 'preview' ? ['expectedDatabase', 'candidatesPath', 'output']
    : ['expectedDatabase', 'actorUserId', 'planPath', 'expectedHash', 'output'];
  if (required.some((key) => !result[key])
    || (action === 'preview' && (result.actorUserId || result.planPath || result.expectedHash))
    || (action === 'apply' && (result.candidatesPath || !/^[a-f0-9]{64}$/.test(result.expectedHash)
      || !/^[1-9]\d*$/.test(result.actorUserId) || !Number.isSafeInteger(Number(result.actorUserId))))) {
    throw new Error('INVALID_ARGUMENTS');
  }
  if (result.actorUserId) result.actorUserId = Number(result.actorUserId);
  return result;
}

async function readJson(file) {
  const content = await fs.readFile(path.resolve(file), 'utf8');
  if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error('INVALID_PLAN');
  return JSON.parse(content);
}

async function run({ args = process.argv.slice(2), env = process.env, databasePool,
  fetchImpl, signal, print = console.log, printError = console.error } = {}) {
  let owned; let output;
  try {
    const input = parse(args);
    if (input.help) { print(HELP); return 0; }
    const config = parseMagentoConfig(env);
    if (!config.configured) throw new Error('MAGENTO_NOT_CONFIGURED');
    if (!databasePool) {
      if (input.action === 'preview') owned = createReadOnlyPool(env);
      else {
        if (!env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
        owned = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
      }
      databasePool = owned;
    }
    const options = { databasePool, expectedDatabase: input.expectedDatabase, fetchImpl, signal,
      sensitiveValues: databaseSecrets(env),
      mutationContext: input.actorUserId ? { actorUserId: input.actorUserId, requestId: 'magento-external-delivery-cli' } : undefined };
    if (input.action === 'preview') {
      output = await fs.open(path.resolve(input.output), 'wx');
      const plan = await service.preview(config, await readJson(input.candidatesPath), options);
      assertEvidenceSafe(plan, config, options.sensitiveValues);
      await output.writeFile(`${JSON.stringify(plan, null, 2)}\n`); await output.sync();
      print(JSON.stringify({ ok: plan.summary.skipped === 0 && plan.summary.conflicted === 0 && plan.summary.failed === 0,
        action: 'preview', output: path.resolve(input.output), planHash: plan.planHash, summary: plan.summary }));
      return plan.summary.skipped || plan.summary.conflicted || plan.summary.failed ? 2 : 0;
    }
    const plan = await readJson(input.planPath);
    service.verify(plan, input.expectedHash, config, input.expectedDatabase);
    const write = await createReceiptWriter(path.resolve(input.output));
    const result = await service.apply(config, plan, input.expectedHash, { ...options, checkpoint: async (receipt) => {
      assertEvidenceSafe(receipt, config, options.sensitiveValues);
      await write(receipt);
    } });
    print(JSON.stringify({ ok: result.complete && !result.counts.skipped && !result.counts.conflicted && !result.counts.failed,
      action: 'apply', output: path.join(path.resolve(input.output), 'summary.json'),
      planHash: result.planHash, complete: result.complete, counts: result.counts }));
    return result.complete && !result.counts.skipped && !result.counts.conflicted && !result.counts.failed ? 0 : 2;
  } catch (cause) {
    printError(JSON.stringify({ code: /^(EXTERNAL_DELIVERY|MAGENTO|REPAIR|ADMIN|EXPORT|LIFECYCLE)_[A-Z_]+$/.test(cause.code || '')
      ? cause.code : cause.message || 'EXTERNAL_DELIVERY_FAILED' }));
    return 1;
  } finally {
    if (output) await output.close().catch(() => {});
    if (owned) await owned.end().catch(() => {});
  }
}

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  run({ signal: controller.signal }).then((code) => { process.exitCode = code; })
    .finally(() => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
}

module.exports = { HELP, parse, readJson, run };
