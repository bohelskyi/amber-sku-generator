const { test, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = require('./suite-context');

test('new SV creation rejects incomplete inputs before persistence and stores complete route inputs', async () => {
  const name = 'amber_sv_create_test';
  const url = await recreateTestDatabase(name);
  try {
    await runNodeInDatabase(url, `require('./integration-test/sv-create-worker').run().catch(e=>{console.error(e);process.exitCode=1;})`);
  } finally { await dropTestDatabase(name); }
});
