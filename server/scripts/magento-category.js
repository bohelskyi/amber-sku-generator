const path = require('node:path');
const { randomUUID } = require('node:crypto');
const c = require('../src/services/magento/binding-contract');
const { parseMagentoConfig } = require('../src/config/magento');
const { createCategory, PATH } = require('../src/services/magento/category-create');
const { assertEvidenceSafe } = require('../src/services/magento/binding-evidence-audit');
const HELP = `npm run magento:category -- --revision UUID --path "${PATH}" [--json]
Add --apply --expected-revision N --actor-user-id ID to create/bind this one category.
Default: GET-only preview. No recursive creation, product writes or publication.
Apply uses existing template publish permission for remote dispatch and manage for binding persistence.
Uncertain prior attempts are never automatically repeated; rerun to look up the exact path.`;
function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const flags = { '--revision': 'id', '--path': 'path', '--expected-revision': 'expectedRevision',
    '--actor-user-id': 'actorUserId', '--apply': 'apply', '--json': 'json' };
  const input = {};
  for (let i = 0; i < args.length; i++) {
    const key = flags[args[i]];
    if (!key || Object.hasOwn(input, key)) c.invalid();
    if (['apply', 'json'].includes(key)) { input[key] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith('--')) c.invalid();
    input[key] = value;
  }
  c.identity(input.id);
  if (input.path !== PATH) c.invalid();
  if (input.apply && (!input.expectedRevision || !input.actorUserId)) c.invalid();
  if (input.expectedRevision) c.counter(input.expectedRevision);
  if (input.actorUserId && (!/^[1-9]\d*$/.test(input.actorUserId) || !Number.isSafeInteger(Number(input.actorUserId)))) c.invalid();
  return input;
}
async function runCategory({ args = [], env = process.env, databasePool, fetchImpl, execute = createCategory,
  print = console.log, printError = console.error } = {}) {
  let ownedPool;
  try {
    const input = parseArguments(args);
    if (input.help) { print(HELP); return 0; }
    const config = parseMagentoConfig(env);
    if (!config.configured) throw c.error(422, 'MAGENTO_NOT_CONFIGURED', 'Configuration required');
    if (!databasePool) { ownedPool = require('../src/db/pool'); databasePool = ownedPool; }
    const result = await execute(config, input, { databasePool, fetchImpl,
      mutationContext: { actorUserId: input.actorUserId, requestId: `magento-category-${randomUUID()}` } });
    assertEvidenceSafe(result, config);
    if (input.json) print(JSON.stringify({ ok: true, ...result }));
    else {
      print(`${result.status}: ${result.path}; source ${result.source}; parent ID ${result.parentId}; category ID ${result.categoryId || 'missing'}`);
      if (result.operation) print(JSON.stringify(result.operation, null, 2));
      print(input.apply ? `Magento create attempted: ${result.magentoWriteAttempted ? 'YES' : 'NO'}` : 'PREVIEW ONLY. Magento writes: NONE. Add --apply to execute.');
    }
    return 0;
  } catch (cause) {
    const code = typeof cause.code === 'string' && /^(MAGENTO|ADMIN|LIFECYCLE)_[A-Z0-9_]+$/.test(cause.code)
      ? cause.code : 'MAGENTO_CATEGORY_COMMAND_FAILED';
    printError(JSON.stringify({ code }));
    if (args.includes('--json')) print(JSON.stringify({ ok: false }));
    return 1;
  } finally { if (ownedPool) await ownedPool.end().catch(() => {}); }
}
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), override: false, quiet: true });
  runCategory({ args: process.argv.slice(2) }).then((code) => { process.exitCode = code; });
}
module.exports = { parseArguments, runCategory };
