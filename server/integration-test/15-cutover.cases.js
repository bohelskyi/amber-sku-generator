const { test, assert, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = require('./suite-context');
test('cutover canonical ordering, bounded rollback/retry, activation and lifecycle selection with real races', async () => {
  const name = 'amber_cutover_contract_test'; const url = await recreateTestDatabase(name);
  try {
    const result = await runNodeInDatabase(url, "delete process.env.NODE_TEST_CONTEXT; require('./integration-test/cutover-isolated.cases')", { NODE_TEST_CONTEXT:'' })
      .catch((error) => { process.stdout.write(error.stdout || ''); throw error; });
    process.stdout.write(result.stdout); assert.match(result.stdout,/# fail 0/);
  } finally { await dropTestDatabase(name); }
});
