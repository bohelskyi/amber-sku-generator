const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parse, run } = require('../scripts/magento-delivery-cutover');
const deliveryCutoverService = require('../src/services/magento/delivery-cutover.service');

const planHash = 'a'.repeat(64);
const args = (planPath, hash = planHash) => ['apply', '--expected-database', 'amber',
  '--installation', 'amber', '--actor-user-id', '1', '--plan', planPath, '--expected-hash', hash];
const env = { DATABASE_URL: 'postgresql://unused.invalid/amber', MAGENTO_BASE_URL: 'https://fixture.invalid',
  MAGENTO_CONSUMER_KEY: 'consumer', MAGENTO_CONSUMER_SECRET: 'secret',
  MAGENTO_ACCESS_TOKEN: 'token', MAGENTO_ACCESS_TOKEN_SECRET: 'token-secret' };
const artifact = (overrides = {}) => ({ artifactVersion: 1,
  kind: 'amber-magento-delivery-cutover-preflight', planHash,
  plan: { database: 'amber', installationKey: 'amber', actor: { authorized: true } },
  blockers: [], ...overrides });

test('delivery cutover CLI apply strips planPath after validating the plan artifact', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-delivery-cutover-cli-'));
  const planPath = path.join(directory, 'preflight.json');
  try {
    await fs.writeFile(planPath, JSON.stringify(artifact()));
    const parsed = parse(args(planPath));
    assert.equal(parsed.planPath, planPath);
    let received;
    const status = await run({ args: args(planPath), env, databasePool: {}, print() {},
      printError: assert.fail, service: { apply: async (input) => {
        received = input;
        return { enabled: true, legacyProductCsvEnabled: false };
      } } });
    assert.equal(status, 0);
    assert.deepEqual(received, { expectedDatabase: 'amber', installationKey: 'amber', actorUserId: 1,
      origin: 'https://fixture.invalid', planHash });
    assert.equal(Object.hasOwn(received, 'planPath'), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('delivery cutover CLI rejects invalid plan artifacts before calling apply', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-delivery-cutover-cli-invalid-'));
  try {
    for (const [name, value, hash] of [
      ['kind', artifact({ kind: 'wrong-kind' }), planHash],
      ['hash', artifact(), 'b'.repeat(64)],
      ['database', artifact({ plan: { database: 'other', installationKey: 'amber', actor: { authorized: true } } }), planHash],
      ['installation', artifact({ plan: { database: 'amber', installationKey: 'other', actor: { authorized: true } } }), planHash],
      ['actor', artifact({ plan: { database: 'amber', installationKey: 'amber', actor: { authorized: false } } }), planHash],
    ]) {
      const planPath = path.join(directory, `${name}.json`);
      await fs.writeFile(planPath, JSON.stringify(value));
      let called = false;
      const errors = [];
      assert.equal(await run({ args: args(planPath, hash), env, databasePool: {}, print() {},
        printError: (message) => errors.push(JSON.parse(message)),
        service: { apply: async () => { called = true; } } }), 1, name);
      assert.equal(called, false, name);
      assert.deepEqual(errors, [{ code: 'INVALID_PLAN' }], name);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('strict service validation rejects CLI-only planPath before database access', async () => {
  let connected = false;
  await assert.rejects(deliveryCutoverService.apply({ expectedDatabase: 'amber', installationKey: 'amber',
    actorUserId: 1, origin: 'https://fixture.invalid', planHash, planPath: 'preflight.json' },
  { databasePool: { connect: async () => { connected = true; throw new Error('DATABASE_TOUCHED'); } } }),
  { code: 'MAGENTO_BINDING_INVALID' });
  assert.equal(connected, false);
});
