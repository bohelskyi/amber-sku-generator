const { test, assert, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = require('./suite-context');

test('phase3 disposable repair, reconciliation, staleness, rollback and real race suite', async () => {
  const name = 'amber_phase3_repair_test';
  const url = await recreateTestDatabase(name);
  try {
    const result = await runNodeInDatabase(url, "delete process.env.NODE_TEST_CONTEXT; require('./integration-test/phase3-isolated.cases')", { NODE_TEST_CONTEXT:'' })
      .catch((error) => { process.stdout.write(error.stdout || ''); throw error; });
    assert.match(result.stdout,/# fail 0/);
    process.stdout.write(result.stdout);
  } finally { await dropTestDatabase(name); }
});
