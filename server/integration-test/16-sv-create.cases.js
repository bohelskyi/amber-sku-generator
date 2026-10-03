const { test, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = require('./suite-context');

test('new SV creation validates route inputs and explicit recount repairs missing processing without inferred zero', async () => {
  const name = 'amber_sv_create_test';
  const url = await recreateTestDatabase(name);
  try {
    await runNodeInDatabase(url, `require('./integration-test/sv-create-worker').run().catch(e=>{console.error(e);process.exitCode=1;})`);
  } finally { await dropTestDatabase(name); }
});
