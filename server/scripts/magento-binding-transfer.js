// Portable reviewed-binding promotion. Export is local/read-only. Import and
// verify use Magento GETs only; neither command publishes a binding or writes Magento.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { parseMagentoConfig } = require('../src/config/magento');
const transfer = require('../src/services/magento/binding-transfer');

const HELP = `npm run magento:binding-transfer -- export --revision UUID --expected-revision N --expected-database NAME --output NEW_FILE
npm run magento:binding-transfer -- import --artifact FILE --expected-hash SHA256 --expected-database NAME --installation KEY --actor-user-id ID [--reconcile-target-source-support]
npm run magento:binding-transfer -- verify --revision DRAFT_UUID --expected-database NAME
Export contains the exact frozen template publication, schema observation and reviewed decisions, but no users, jobs, product state or credentials. Import creates/reuses an audited local template publication and creates only a NEW binding DRAFT. Import/verify perform GET-only live Magento drift checks. Target source-support reconciliation is opt-in and demotion-only.`;

function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const [action, ...rest] = args;
  if (!['export','import','verify'].includes(action)) throw new Error('INVALID_ARGUMENTS');
  const flags = { '--revision': 'revisionId', '--expected-revision': 'expectedRevision',
    '--expected-database': 'expectedDatabase', '--output': 'output', '--artifact': 'artifactPath',
    '--expected-hash': 'expectedHash', '--installation': 'installationKey', '--actor-user-id': 'actorUserId' };
  const result = { action };
  for (let i = 0; i < rest.length;) {
    if (rest[i] === '--reconcile-target-source-support') {
      if (action !== 'import' || result.reconcileTargetSourceSupport) throw new Error('INVALID_ARGUMENTS');
      result.reconcileTargetSourceSupport = true; i += 1; continue;
    }
    const key = flags[rest[i]]; const value = rest[i + 1];
    if (!key || !value || value.startsWith('--') || Object.hasOwn(result, key)) throw new Error('INVALID_ARGUMENTS');
    result[key] = value; i += 2;
  }
  const required = action === 'export' ? ['revisionId','expectedRevision','expectedDatabase','output']
    : action === 'import' ? ['artifactPath','expectedHash','expectedDatabase','installationKey','actorUserId']
      : ['revisionId','expectedDatabase'];
  if (required.some((key) => !result[key])) throw new Error('INVALID_ARGUMENTS');
  if (result.actorUserId) {
    if (!/^[1-9][0-9]*$/.test(result.actorUserId) || !Number.isSafeInteger(Number(result.actorUserId))) throw new Error('INVALID_ARGUMENTS');
    result.actorUserId = Number(result.actorUserId);
  }
  return result;
}

async function loadArtifact(file) {
  const text = await fs.readFile(path.resolve(file), 'utf8');
  if (Buffer.byteLength(text) > 64 * 1024 * 1024) throw new Error('ARTIFACT_TOO_LARGE');
  return JSON.parse(text);
}

async function run({ args = process.argv.slice(2), env = process.env, print = console.log, printError = console.error,
  databasePool, fetchImpl } = {}) {
  let owned;
  try {
    const input = parse(args);
    if (input.help) { print(HELP); return 0; }
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL_REQUIRED');
    if (!databasePool) { owned = new Pool({ connectionString: env.DATABASE_URL, max: 2 }); databasePool = owned; }
    if (input.action === 'export') {
      const wrapper = await transfer.exportArtifact(input.revisionId, input, { databasePool });
      await fs.writeFile(path.resolve(input.output), `${JSON.stringify(wrapper, null, 2)}\n`, { flag: 'wx' });
      print(JSON.stringify({ ok: true, artifactHash: wrapper.artifactHash, output: path.resolve(input.output),
        installationKey: wrapper.artifact.installationKey, sourceRevisionId: wrapper.artifact.source.revisionId }));
      return 0;
    }
    const config = parseMagentoConfig(env);
    if (!config.configured) throw new Error('MAGENTO_NOT_CONFIGURED');
    if (input.action === 'import') {
      const wrapper = await loadArtifact(input.artifactPath);
      const result = await transfer.importArtifact(wrapper, input, config, { databasePool, fetchImpl,
        mutationContext: { actorUserId: input.actorUserId, requestId: `magento-binding-import-${randomUUID()}` } });
      print(JSON.stringify({ ok: true, ...result })); return 0;
    }
    const result = await transfer.verifyImported(input.revisionId, input, config, { databasePool, fetchImpl });
    print(JSON.stringify({ ok: result.valid, ...result })); return result.valid ? 0 : 2;
  } catch (error) {
    const diagnostic = { code: error.code || error.publicCode || error.message || 'MAGENTO_BINDING_TRANSFER_FAILED' };
    if (Array.isArray(error.details?.diagnostics)) diagnostic.diagnostics = error.details.diagnostics;
    printError(JSON.stringify(diagnostic)); return 1;
  } finally { if (owned) await owned.end().catch(() => {}); }
}

if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  run({}).then((code) => { process.exitCode = code; });
}
module.exports = { parse, run };
