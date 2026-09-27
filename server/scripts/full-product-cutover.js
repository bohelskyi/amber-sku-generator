// Explicit operator command. Nothing runs at startup or on importing this file.
const fs = require('node:fs/promises');
const cutover = require('../src/services/full-product-cutover.service');
const { dryRunRepair } = require('../src/services/recount-repair.service');
const { reconcileFullProduct, setBusinessExclusion } = require('../src/services/full-product-reconciliation.service');

async function run(command, options) {
  const manifest = command.manifestPath ? JSON.parse(await fs.readFile(command.manifestPath, 'utf8')) : null;
  switch (command.action) {
    case 'prepare': return cutover.prepare(options);
    case 'index-manifest': return cutover.generate('index', options);
    case 'cutover-manifest': return cutover.generate('cutover', options);
    case 'amendment-manifest': return cutover.generate('amendment', options);
    case 'index': return cutover.indexHistorical(manifest, command.manifestHash, options);
    case 'approve': return cutover.approve(manifest, command.manifestHash, command.reason, options);
    case 'batch': return cutover.applyBatch(command.manifestHash, command.batchNumber, options);
    case 'validate': return cutover.validate(command.manifestHash, options);
    case 'activate': return cutover.activate(command.manifestHash, options);
    case 'status': return cutover.status(options);
    case 'review': {
      const result = await dryRunRepair(options.databasePool, options);
      return result.repairEntries.filter((e) => command.productIds?.includes(e.productId));
    }
    case 'resolve': return reconcileFullProduct(command.resolution, options);
    case 'business-exclusion': return setBusinessExclusion(command.resolution, options);
    default: throw new Error('Unknown explicit cutover command');
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !process.env.DATABASE_URL) throw new Error('Usage: DATABASE_URL=<explicit target> node scripts/full-product-cutover.js command.json result.json');
  const command = JSON.parse(await fs.readFile(args[0], 'utf8'));
  if (!command.expectedDatabase || !Number.isSafeInteger(command.actorUserId) || command.actorUserId <= 0) throw new Error('Exact expectedDatabase and application actorUserId required');
  // Refuse overwriting evidence before executing a mutation.
  const output = await fs.open(args[1], 'wx');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const result = await run(command, { databasePool: pool, expectedDatabase: command.expectedDatabase, deploymentEvidence:command.deploymentEvidence,
      mutationContext: { actorUserId: command.actorUserId, requestId: command.requestId || null } });
    await output.writeFile(`${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({ action: command.action, resultPath: args[1], manifestHash: result.contentSha256 || result.manifestHash || null }));
  } finally { await output.close(); await pool.end(); }
}
if (require.main === module) main().catch((error) => { console.error(`${error.code || 'CUTOVER_ERROR'}: ${error.message}`); process.exitCode = 1; });
module.exports = { run };
