// Historical encoded recount chains must be constructed under their recorded
// runtime checkpoint. Native creation060 has a separate current-schema suite.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
module.exports = async function migrateHistoricalRuntimeFixture(suite, url) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-historical-059-'));
  try {
    for (const file of (await fs.readdir(path.join(suite.serverRoot, 'migrations'))).filter((file) => file.endsWith('.sql') && file < '060')) {
      await fs.copyFile(path.join(suite.serverRoot, 'migrations', file), path.join(directory, file));
    }
    await suite.runNodeInDatabase(url, `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}})
      .finally(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});`);
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('amber-historical-059-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
};
