// Local reviewed-decision carry-forward. Remote access is restricted to bounded
// Magento GET verification; no command publishes, activates, or writes Magento.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const c = require('../src/services/magento/binding-contract');
const { parseMagentoConfig } = require('../src/config/magento');
const service = require('../src/services/magento/binding-carry-forward');

const HELP = `npm run magento:binding-carry-forward -- preflight --expected-database NAME --actor-user-id ID --source UUID --source-revision N --target UUID --target-revision N --output NEW_FILE
npm run magento:binding-carry-forward -- apply --expected-database NAME --actor-user-id ID --plan FILE --expected-hash SHA256
Preflight is read-only and may perform bounded Magento GET verification. Apply repeats that GET verification, updates only the reviewed target draft, and writes an audit receipt. Neither command publishes, activates delivery, or writes Magento.`;

function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const [action, ...rest] = args;
  if (!['preflight', 'apply'].includes(action)) throw new Error('MAGENTO_BINDING_CARRY_ARGUMENTS');
  const names = { '--expected-database': 'expectedDatabase', '--actor-user-id': 'actorUserId',
    '--source': 'sourceId', '--source-revision': 'sourceRevision', '--target': 'targetId',
    '--target-revision': 'targetRevision', '--output': 'output', '--plan': 'planPath',
    '--expected-hash': 'planHash' };
  const result = { action };
  for (let index = 0; index < rest.length; index += 2) {
    const key = names[rest[index]]; const value = rest[index + 1];
    if (!key || !value || Object.hasOwn(result, key) || value.startsWith('--')
      || /[\u0000-\u001f]/.test(value)) throw new Error('MAGENTO_BINDING_CARRY_ARGUMENTS');
    result[key] = value;
  }
  const required = action === 'preflight'
    ? ['expectedDatabase','actorUserId','sourceId','sourceRevision','targetId','targetRevision','output']
    : ['expectedDatabase','actorUserId','planPath','planHash'];
  if (required.some((key) => !result[key]) || !/^[1-9][0-9]*$/.test(result.actorUserId || '')
    || !Number.isSafeInteger(Number(result.actorUserId))
    || (action === 'apply' && !/^[a-f0-9]{64}$/.test(result.planHash || ''))) {
    throw new Error('MAGENTO_BINDING_CARRY_ARGUMENTS');
  }
  result.actorUserId = Number(result.actorUserId);
  if (action === 'preflight') {
    c.identity(result.sourceId); c.identity(result.targetId);
    c.counter(result.sourceRevision); c.counter(result.targetRevision);
  }
  return result;
}

async function readJson(file) {
  const text = await fs.readFile(path.resolve(file), 'utf8');
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('MAGENTO_BINDING_CARRY_PLAN_INVALID');
  try { return JSON.parse(text); } catch { throw new Error('MAGENTO_BINDING_CARRY_PLAN_INVALID'); }
}

function createPool(env, action) {
  if (action === 'preflight') return require('./magento-binding-evidence-audit').createReadOnlyPool(env);
  if (action !== 'apply') throw new Error('MAGENTO_BINDING_CARRY_ARGUMENTS');
  const config = require('../src/config/env').loadConfig(env);
  return new Pool({ ...config.databaseOptions, ssl: config.useSsl ? { rejectUnauthorized: false } : false,
    max: 2, idleTimeoutMillis: config.pgIdleTimeoutMs, connectionTimeoutMillis: config.pgConnectTimeoutMs,
    query_timeout: config.pgQueryTimeoutMs, statement_timeout: config.pgStatementTimeoutMs });
}

async function run({ args = process.argv.slice(2), env = process.env, print = console.log,
  printError = console.error, databasePool, fetchImpl } = {}) {
  let owned;
  try {
    const input = parse(args);
    if (input.help) { print(HELP); return 0; }
    if (!databasePool) { owned = createPool(env, input.action); databasePool = owned; }
    const config = parseMagentoConfig(env);
    if (!config.configured) throw new Error('MAGENTO_NOT_CONFIGURED');
    if (input.action === 'preflight') {
      const artifact = await service.preflight(input, { databasePool, config, fetchImpl });
      await fs.writeFile(path.resolve(input.output), `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
      print(JSON.stringify({ ok: artifact.blockers.length === 0, planHash: artifact.planHash,
        summary: artifact.plan.summary, blockers: artifact.blockers, output: path.resolve(input.output) }));
      return artifact.blockers.length ? 2 : 0;
    }
    const artifact = await readJson(input.planPath);
    if (artifact?.artifactVersion !== 1
      || artifact.kind !== 'amber-magento-binding-reviewed-carry-forward-preflight'
      || artifact.planHash !== input.planHash || artifact.plan?.database !== input.expectedDatabase
      || artifact.plan?.actorUserId !== input.actorUserId || artifact.blockers?.length) {
      throw new Error('MAGENTO_BINDING_CARRY_PLAN_INVALID');
    }
    const receipt = await service.apply({ expectedDatabase: input.expectedDatabase,
      actorUserId: input.actorUserId, plan: artifact.plan, planHash: input.planHash }, { databasePool, config, fetchImpl,
      mutationContext: { actorUserId: input.actorUserId, requestId: `magento-binding-carry-${randomUUID()}` } });
    print(JSON.stringify({ ok: true, ...receipt }));
    return 0;
  } catch (error) {
    const code = error.code || (/^MAGENTO_[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'MAGENTO_BINDING_CARRY_FAILED');
    printError(JSON.stringify({ code }));
    return 1;
  } finally { if (owned) await owned.end().catch(() => {}); }
}

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  run({}).then((code) => { process.exitCode = code; });
}

module.exports = { parse, readJson, createPool, run };
