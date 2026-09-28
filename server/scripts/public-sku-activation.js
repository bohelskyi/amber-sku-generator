const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const service = require('../src/services/public-sku-activation.service');

const HELP = `npm run public-sku:activation -- preflight --expected-database NAME --actor-user-id ID --output NEW_FILE
npm run public-sku:activation -- apply --expected-database NAME --actor-user-id ID --plan FILE --expected-hash SHA256`;

function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const [action, ...rest] = args;
  if (!['preflight', 'apply'].includes(action)) throw new Error('INVALID_ARGUMENTS');
  const names = { '--expected-database': 'expectedDatabase', '--actor-user-id': 'actorUserId',
    '--output': 'output', '--plan': 'planPath', '--expected-hash': 'planHash' };
  const result = { action };
  for (let i = 0; i < rest.length; i += 2) {
    const key = names[rest[i]]; const value = rest[i + 1];
    if (!key || !value || Object.hasOwn(result, key) || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    result[key] = value;
  }
  const required = action === 'preflight' ? ['expectedDatabase', 'actorUserId', 'output']
    : ['expectedDatabase', 'actorUserId', 'planPath', 'planHash'];
  if (required.some((key) => !result[key]) || !/^[1-9][0-9]*$/.test(result.actorUserId || '')) throw new Error('INVALID_ARGUMENTS');
  result.actorUserId = Number(result.actorUserId);
  return result;
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
      const artifact = await service.preflight(input, { databasePool });
      await fs.writeFile(path.resolve(input.output), `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
      print(JSON.stringify({ ok: artifact.blockers.length === 0, planHash: artifact.planHash,
        blockers: artifact.blockers, output: path.resolve(input.output) }));
      return artifact.blockers.length ? 2 : 0;
    }
    const artifact = JSON.parse(await fs.readFile(path.resolve(input.planPath), 'utf8'));
    if (artifact?.kind !== 'amber-public-sku-activation-preflight' || artifact.planHash !== input.planHash
      || artifact.plan?.database !== input.expectedDatabase) throw new Error('INVALID_PLAN');
    const result = await service.apply(input, { databasePool, mutationContext: { actorUserId: input.actorUserId,
      requestId: `public-sku-activation-${randomUUID()}` } });
    print(JSON.stringify({ ok: true, ...result })); return 0;
  } catch (error) { printError(JSON.stringify({ code: error.code || error.message || 'PUBLIC_SKU_ACTIVATION_FAILED' })); return 1; }
  finally { if (owned) await owned.end().catch(() => {}); }
}

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  run({}).then((code) => { process.exitCode = code; });
}
module.exports = { parse, run };
