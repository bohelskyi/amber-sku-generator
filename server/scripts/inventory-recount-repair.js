const { loadRepairInput } = require('../src/services/export-exposure/repair-loader');
const { buildRepairManifest } = require('../src/services/export-exposure/repair-manifest');
const { serializeManifest } = require('../src/services/export-exposure/manifest');

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--database-name' || !args[1]) {
    throw new Error('Usage: node scripts/inventory-recount-repair.js --database-name EXPECTED_NAME (read-only)');
  }
  const pool = require('../src/db/pool');
  try { process.stdout.write(serializeManifest(buildRepairManifest(await loadRepairInput(pool, { expectedDatabase:args[1] })))); }
  finally { await pool.end(); }
}
if (require.main === module) main().catch((error) => {
  process.stderr.write(`Repair inventory failed: ${error.message}\n`); process.exitCode = 1;
});
module.exports = { main };
