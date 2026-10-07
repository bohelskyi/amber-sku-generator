const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const cli = require('../scripts/magento-binding-carry-forward');
const service = require('../src/services/magento/binding-carry-forward');

const auth = { NODE_ENV: 'test', APP_BASE_URL: 'http://localhost:5173',
  OIDC_ISSUER_URL: 'https://auth.example.invalid/realms/test', OIDC_CLIENT_ID: 'cli-test',
  OIDC_CLIENT_SECRET: 'fixture-client-secret', OIDC_REDIRECT_URI: 'http://localhost:5000/api/auth/callback',
  SESSION_SECRET: 'fixture-session-secret-0123456789abcdef', SESSION_COOKIE_SECURE: 'false',
  MAGENTO_BASE_URL: 'https://magento.example.invalid', MAGENTO_CONSUMER_KEY: 'fixture-key',
  MAGENTO_CONSUMER_SECRET: 'fixture-secret', MAGENTO_ACCESS_TOKEN: 'fixture-token', MAGENTO_ACCESS_TOKEN_SECRET: 'fixture-token-secret',
  PGHOST: '127.0.0.1', PGPORT: '55432', PGSSL: 'true', PG_CONNECT_TIMEOUT_MS: '4321',
  PG_QUERY_TIMEOUT_MS: '8765', PG_STATEMENT_TIMEOUT_MS: '9876', PG_IDLE_TIMEOUT_MS: '3210' };
function environment(kind) {
  const fields = kind === 'PG' ? { PGDATABASE: 'carry_cli_test', PGUSER: 'fixture-user', PGPASSWORD: 'fixture-password' }
    : kind === 'POSTGRES' ? { POSTGRES_DB: 'carry_cli_test', POSTGRES_USER: 'fixture-user', POSTGRES_PASSWORD: 'fixture-password' }
      : { DATABASE_URL: 'postgresql://fixture-user:fixture-password@127.0.0.1:55432/carry_cli_test' };
  return { ...auth, ...fields };
}
async function cleanup(directory) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  assert.match(path.basename(directory), /^carry-cli-/);
  await fs.rm(directory, { recursive: true, force: true });
}
function preflightArgs(output) {
  return ['preflight', '--expected-database', 'carry_cli_test', '--actor-user-id', '1',
    '--source', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '--source-revision', '10',
    '--target', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '--target-revision', '148', '--output', output];
}
function assertOptions(pool, action, kind) {
  if (kind === 'URL') assert.equal(pool.options.connectionString, environment(kind).DATABASE_URL);
  else {
    assert.equal(pool.options.database, 'carry_cli_test'); assert.equal(pool.options.user, 'fixture-user');
    assert.equal(pool.options.password, 'fixture-password'); assert.equal(pool.options.host, '127.0.0.1');
    assert.equal(pool.options.port, 55432); assert.equal(pool.options.connectionString, undefined);
  }
  assert.deepEqual(pool.options.ssl, { rejectUnauthorized: false });
  assert.equal(pool.options.connectionTimeoutMillis, 4321);
  assert.equal(pool.options.query_timeout, 8765); assert.equal(pool.options.statement_timeout, 9876);
  assert.equal(pool.options.max, action === 'preflight' ? 1 : 2);
  assert.equal(pool.options.options, action === 'preflight' ? '-c default_transaction_read_only=on' : undefined);
  assert.equal(pool.totalCount, 0, 'No unit test may connect to a database');
}
test('carry CLI pools support URL, PG and POSTGRES settings with shared SSL/timeouts and read-only preflight', async () => {
  for (const kind of ['URL', 'PG', 'POSTGRES']) for (const action of ['preflight', 'apply']) {
    const pool = cli.createPool(environment(kind), action);
    try { assertOptions(pool, action, kind); } finally { await pool.end(); }
  }
});
test('carry CLI preflight runs with PG or POSTGRES settings without DATABASE_URL and closes its own pool', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'carry-cli-config-'));
  const original = service.preflight;
  try {
    for (const kind of ['PG', 'POSTGRES']) {
      const output = path.join(directory, kind + '.json'), errors = []; let captured;
      service.preflight = async (input, options) => {
        captured = options.databasePool; assertOptions(captured, 'preflight', kind);
        assert.equal(input.sourceRevision, '10'); assert.equal(input.targetRevision, '148');
        return { artifactVersion: 1, planHash: 'a'.repeat(64), blockers: [], plan: { summary: { safe: true } } };
      };
      const code = await cli.run({ args: preflightArgs(output), env: environment(kind), print: () => {}, printError: line => errors.push(line) });
      assert.equal(code, 0, JSON.stringify(errors)); assert.deepEqual(errors, []);
      assert.equal(captured.ended, true); assert.equal((JSON.parse(await fs.readFile(output, 'utf8'))).artifactVersion, 1);
    }
  } finally { service.preflight = original; await cleanup(directory); }
});
test('carry CLI apply supports POSTGRES settings, keeps writable pool and passes the sealed exact plan', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'carry-cli-apply-config-')), original = service.apply;
  const plan = { database: 'carry_cli_test', actorUserId: 1, target: { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', revision: 148 } }, planHash = 'a'.repeat(64);
  let captured;
  try {
    const file = path.join(directory, 'plan.json');
    await fs.writeFile(file, JSON.stringify({ artifactVersion: 1, kind: 'amber-magento-binding-reviewed-carry-forward-preflight', blockers: [], planHash, plan }));
    service.apply = async (input, options) => {
      captured = options.databasePool; assertOptions(captured, 'apply', 'POSTGRES');
      assert.deepEqual(input.plan, plan); assert.equal(input.planHash, planHash);
      assert.equal(options.mutationContext.actorUserId, 1); return { targetRevisionId: plan.target.id };
    };
    const errors = [], code = await cli.run({ args: ['apply', '--expected-database', 'carry_cli_test', '--actor-user-id', '1', '--plan', file, '--expected-hash', planHash], env: environment('POSTGRES'), print: () => {}, printError: line => errors.push(line) });
    assert.equal(code, 0, JSON.stringify(errors)); assert.equal(captured.ended, true);
  } finally { service.apply = original; await cleanup(directory); }
});
test('carry CLI accepts an injected pool without DATABASE_URL and never closes the borrowed pool', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'carry-cli-injected-')), original = service.preflight;
  const borrowed = { end: async () => assert.fail('Borrowed pool must remain owned by the caller') };
  try {
    service.preflight = async (_input, options) => {
      assert.equal(options.databasePool, borrowed);
      return { blockers: [], planHash: 'a'.repeat(64), plan: { summary: {} } };
    };
    const errors = [], code = await cli.run({ args: preflightArgs(path.join(directory, 'plan.json')), env: auth, databasePool: borrowed, print: () => {}, printError: line => errors.push(line) });
    assert.equal(code, 0, JSON.stringify(errors)); assert.deepEqual(errors, []);
  } finally { service.preflight = original; await cleanup(directory); }
});
test('carry CLI closes its owned pool on failure and prints an error code without connection secrets', async () => {
  const original = service.preflight; let captured;
  try {
    service.preflight = async (_input, options) => {
      captured = options.databasePool;
      throw new Error('Cannot connect: ' + environment('URL').DATABASE_URL);
    };
    const errors = [], code = await cli.run({ args: preflightArgs('unused-no-output.json'), env: environment('URL'), print: () => assert.fail('Failure must not print success'), printError: line => errors.push(line) });
    assert.equal(code, 1); assert.equal(captured.ended, true);
    assert.deepEqual(errors.map(JSON.parse), [{ code: 'MAGENTO_BINDING_CARRY_FAILED' }]);
    assert.ok(errors.every(line => !line.includes('fixture-password') && !line.includes('postgresql://')));
  } finally { service.preflight = original; }
});
