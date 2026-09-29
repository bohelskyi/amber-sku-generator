// Local schema-045 compatibility repair. Preflight is read-only; stage performs
// only the reviewed local retirement/staging transaction and never calls Magento.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const service = require('../src/services/legacy-sku-repair.service');

const HELP = `npm run legacy-sku-repair -- preflight --expected-database NAME --actor-user-id ID --decisions FILE --output NEW_FILE
npm run legacy-sku-repair -- stage --expected-database NAME --actor-user-id ID --plan FILE --expected-hash SHA256
Preflight is read-only and requires schema 045 before migration 046. Stage atomically retires reviewed duplicates and temporarily stages reviewed split-public-identity rows. No command writes Magento.`;

function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const [action, ...rest] = args;
  if (!['preflight', 'stage'].includes(action)) throw new Error('LEGACY_SKU_REPAIR_ARGUMENTS');
  const names = { '--expected-database': 'expectedDatabase', '--actor-user-id': 'actorUserId',
    '--decisions': 'decisionsPath', '--output': 'output', '--plan': 'planPath', '--expected-hash': 'planHash' };
  const result = { action };
  for (let i = 0; i < rest.length; i += 2) {
    const key = names[rest[i]]; const value = rest[i + 1];
    if (!key || !value || Object.hasOwn(result, key) || value.startsWith('--')
      || /[\u0000-\u001f]/.test(value)) throw new Error('LEGACY_SKU_REPAIR_ARGUMENTS');
    result[key] = value;
  }
  const required = action === 'preflight'
    ? ['expectedDatabase', 'actorUserId', 'decisionsPath', 'output']
    : ['expectedDatabase', 'actorUserId', 'planPath', 'planHash'];
  if (required.some((key) => !result[key]) || !/^[1-9][0-9]*$/.test(result.actorUserId || '')
    || !Number.isSafeInteger(Number(result.actorUserId))
    || (action === 'stage' && !/^[a-f0-9]{64}$/.test(result.planHash || ''))) {
    throw new Error('LEGACY_SKU_REPAIR_ARGUMENTS');
  }
  result.actorUserId = Number(result.actorUserId);
  return result;
}

async function readJson(file, code) {
  const text = await fs.readFile(path.resolve(file), 'utf8');
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error(code);
  try { return JSON.parse(text); } catch { throw new Error(code); }
}

async function run({ args = process.argv.slice(2), env = process.env, print = console.log,
  printError = console.error, databasePool } = {}) {
  let owned;
  try {
    const input = parse(args);
    if (input.help) { print(HELP); return 0; }
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
    if (!databasePool) { owned = new Pool({ connectionString: env.DATABASE_URL, max: 2 }); databasePool = owned; }
    if (input.action === 'preflight') {
      const decisions = await readJson(input.decisionsPath, 'LEGACY_SKU_REPAIR_DECISIONS_INVALID');
      const artifact = await service.preflight({ ...input, decisions }, { databasePool });
      await fs.writeFile(path.resolve(input.output), `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
      print(JSON.stringify({ ok: artifact.blockers.length === 0, planHash: artifact.planHash,
        blockers: artifact.blockers, output: path.resolve(input.output) }));
      return artifact.blockers.length ? 2 : 0;
    }
    const artifact = await readJson(input.planPath, 'LEGACY_SKU_REPAIR_PLAN_INVALID');
    if (artifact?.artifactVersion !== 1 || artifact.kind !== 'amber-legacy-sku-repair-preflight'
      || artifact.planHash !== input.planHash || artifact.plan?.database !== input.expectedDatabase
      || artifact.plan?.actorUserId !== input.actorUserId || artifact.blockers?.length) {
      throw new Error('LEGACY_SKU_REPAIR_PLAN_INVALID');
    }
    const result = await service.stage({ ...input, plan: artifact.plan }, { databasePool,
      mutationContext: { actorUserId: input.actorUserId, requestId: `legacy-sku-repair-${randomUUID()}` } });
    print(JSON.stringify({ ok: true, ...result }));
    return 0;
  } catch (error) {
    printError(JSON.stringify({ code: error.code || error.message || 'LEGACY_SKU_REPAIR_FAILED' }));
    return 1;
  } finally { if (owned) await owned.end().catch(() => {}); }
}

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  run({}).then((code) => { process.exitCode = code; });
}

module.exports = { parse, readJson, run };
