const { loadCorrectionExposureManifest } = require('../src/services/export-exposure.service');
const { serializeManifest } = require('../src/services/export-exposure/manifest');

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--database-name' || !args[1]) {
    throw new Error('Usage: node scripts/inventory-correction-exposure.js --database-name EXPECTED_NAME');
  }
  // Uses the normal configured connection, but never server/startup/migrations.
  const pool = require('../src/db/pool');
  try {
    const manifest = await loadCorrectionExposureManifest(pool, { expectedDatabase: args[1] });
    process.stdout.write(serializeManifest(manifest));
  } finally { await pool.end(); }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`Correction exposure inventory failed: ${error.message}\n`);
  process.exitCode = 1;
});

module.exports = { main };
