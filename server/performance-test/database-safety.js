const DATABASE_NAME_QUERY = 'SELECT current_database() AS database_name';

function isDisposableDatabaseName(value) {
  return typeof value === 'string' && value.endsWith('_test');
}

async function verifyConnectedTestDatabase(client) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('A connected PostgreSQL client is required.');
  }
  const result = await client.query(DATABASE_NAME_QUERY);
  const databaseName = result?.rows?.[0]?.database_name;
  if (!isDisposableDatabaseName(databaseName)) {
    throw new Error(
      `Phase 7 benchmark refused connected database ${JSON.stringify(databaseName)}; `
      + 'the database name must end in _test.'
    );
  }
  return databaseName;
}

async function resetDisposableSchema(client, reset) {
  await verifyConnectedTestDatabase(client);
  if (typeof reset !== 'function') {
    throw new TypeError('A fixture reset function is required.');
  }
  return reset(client);
}

module.exports = {
  DATABASE_NAME_QUERY,
  isDisposableDatabaseName,
  resetDisposableSchema,
  verifyConnectedTestDatabase,
};
