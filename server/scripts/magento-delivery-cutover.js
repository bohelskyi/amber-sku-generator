// Explicit local operator command. Preflight is read-only; apply is the only CSV
// retirement/automatic activation boundary. No command writes Magento.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { parseMagentoConfig } = require('../src/config/magento');
const service = require('../src/services/magento/delivery-cutover.service');

const HELP = `npm run magento:delivery-cutover -- preflight --expected-database NAME --installation KEY --actor-user-id ID --output NEW_FILE
npm run magento:delivery-cutover -- apply --expected-database NAME --installation KEY --actor-user-id ID --plan FILE --expected-hash SHA256
npm run magento:delivery-cutover -- disable --expected-database NAME --actor-user-id ID --reason TEXT
Preflight performs local reads only. Apply atomically enables future automatic sync and permanently retires new Magento product CSV artifacts. Disable stops automatic dispatch but never re-enables CSV.`;

function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const [action, ...rest] = args;
  if (!['preflight','apply','disable'].includes(action)) throw new Error('INVALID_ARGUMENTS');
  const names = { '--expected-database': 'expectedDatabase', '--installation': 'installationKey',
    '--actor-user-id': 'actorUserId', '--output': 'output', '--plan': 'planPath',
    '--expected-hash': 'planHash', '--reason': 'reason' };
  const result = { action };
  for (let i = 0; i < rest.length; i += 2) {
    const key = names[rest[i]]; const value = rest[i + 1];
    if (!key || !value || Object.hasOwn(result, key) || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS');
    result[key] = value;
  }
  const required = action === 'preflight' ? ['expectedDatabase','installationKey','actorUserId','output']
    : action === 'apply' ? ['expectedDatabase','installationKey','actorUserId','planPath','planHash']
      : ['expectedDatabase','actorUserId','reason'];
  if (required.some((key) => !result[key]) || !/^[1-9][0-9]*$/.test(result.actorUserId)
    || !Number.isSafeInteger(Number(result.actorUserId))) throw new Error('INVALID_ARGUMENTS');
  result.actorUserId = Number(result.actorUserId);
  return result;
}

async function readJson(file) {
  const text = await fs.readFile(path.resolve(file), 'utf8');
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('INVALID_PLAN');
  return JSON.parse(text);
}

async function run({ args = process.argv.slice(2), env = process.env, print = console.log, printError = console.error,
  databasePool } = {}) {
  let owned;
  try {
    const input = parse(args);
    if (input.help) { print(HELP); return 0; }
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
    const config = parseMagentoConfig(env);
    if (input.action !== 'disable' && !config.configured) throw new Error('MAGENTO_NOT_CONFIGURED');
    if (!databasePool) { owned = new Pool({ connectionString: env.DATABASE_URL, max: 2 }); databasePool = owned; }
    if (input.action === 'preflight') {
      const artifact = await service.preflight({ ...input, origin: config.baseUrl }, { databasePool });
      await fs.writeFile(path.resolve(input.output), `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
      print(JSON.stringify({ ok: artifact.blockers.length === 0, planHash: artifact.planHash,
        blockers: artifact.blockers, output: path.resolve(input.output) }));
      return artifact.blockers.length === 0 ? 0 : 2;
    }
    if (input.action === 'apply') {
      const artifact = await readJson(input.planPath);
      if (artifact?.kind !== 'amber-magento-delivery-cutover-preflight' || artifact.planHash !== input.planHash
        || artifact.plan?.database !== input.expectedDatabase || artifact.plan?.installationKey !== input.installationKey
        || artifact.plan?.actor?.authorized !== true) throw new Error('INVALID_PLAN');
      const result = await service.apply({ ...input, origin: config.baseUrl }, { databasePool,
        mutationContext: { actorUserId: input.actorUserId, requestId: `magento-delivery-cutover-${randomUUID()}` } });
      print(JSON.stringify({ ok: true, ...result })); return 0;
    }
    const result = await service.disable(input, { databasePool,
      mutationContext: { actorUserId: input.actorUserId, requestId: `magento-delivery-disable-${randomUUID()}` } });
    print(JSON.stringify({ ok: true, ...result })); return 0;
  } catch (error) {
    printError(JSON.stringify({ code: error.code || error.publicCode || error.message || 'MAGENTO_CUTOVER_FAILED' }));
    return 1;
  } finally { if (owned) await owned.end().catch(() => {}); }
}

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  run({}).then((code) => { process.exitCode = code; });
}
module.exports = { parse, run };
