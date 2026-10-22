const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');
const {
  cleanupTemplateDatabase,
  createTestDatabase,
  databaseUrlFor,
  dropTestDatabase,
  ensureTemplateDatabase,
  execFileAsync,
  migrationManifest,
  serverRoot,
  templateNameFor,
  verifiedTemplateDatabaseNames,
} = require('./harness');

test('template setup preserves isolated databases, fresh migrations and exact checksum/list evidence', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-template-test-'));
  const migration = path.join(directory, '000_template_probe.sql');
  const sql = `-- Unique disposable fixture ${crypto.randomUUID()}\n`
    + 'SELECT pg_sleep(0.2);\nCREATE TABLE template_probe(id integer PRIMARY KEY, value text);\n'
    + "INSERT INTO template_probe VALUES(1, 'template seed');\n";
  await fs.writeFile(migration, sql);
  const cloneNames = Array.from({ length: 4 }, (_, i) => `amber_clone_probe_${process.pid}_${i}_test`);
  const clients = [];
  const connect = async name => {
    const client = new Client({ connectionString: databaseUrlFor(name) });
    await client.connect();
    clients.push(client);
    return client;
  };
  const closeClients = async () => {
    for (const client of clients.splice(0)) await client.end();
  };
  const templateExists = async () => {
    const control = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await control.connect();
    try {
      return (await control.query('SELECT 1 FROM pg_database WHERE datname = $1',
        [templateNameFor(await migrationManifest(directory))])).rowCount;
    } finally { await control.end(); }
  };
  try {
    await t.test('database-only imports preserve caller configuration and reject unsafe targets', async () => {
      const result = await execFileAsync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const previous = { ...process.env };
        const harness = require('./integration-test/harness');
        assert.equal(process.env.NBU_RATE_OVERRIDE, previous.NBU_RATE_OVERRIDE);
        assert.equal(process.env.DATABASE_URL, previous.DATABASE_URL);
        assert.equal(require.cache[require.resolve('./src/db/pool')], undefined);
        for (const name of ['production', 'x_test;DROP DATABASE amber_test', 'a'.repeat(64) + '_test']) {
          assert.throws(() => harness.databaseUrlFor(name), /Unsafe test database name/);
        }
      `], { cwd: serverRoot, env: { ...process.env, NBU_RATE_OVERRIDE: '', DATABASE_URL: '' }, windowsHide: true });
      assert.equal(result.stderr, '');
      await assert.rejects(createTestDatabase(new URL(process.env.TEST_DATABASE_URL).pathname.slice(1)), /control\/template database/);
    });

    await t.test('independent processes race cold creation and receive the same migration receipt in distinct clones', async () => {
      assert.equal(await templateExists(), 0);
      await Promise.all(cloneNames.slice(0, 2).map(name => execFileAsync(process.execPath, ['-e', `
        require('./integration-test/harness').createTestDatabase(process.env.CLONE_NAME, {
          directory: process.env.CLONE_MIGRATIONS,
        }).catch(error => { console.error(error); process.exitCode = 1; });
      `], { cwd: serverRoot, windowsHide: true,
        env: { ...process.env, CLONE_NAME: name, CLONE_MIGRATIONS: directory } })));
      assert.equal(await templateExists(), 1);
      const a = await connect(cloneNames[0]), b = await connect(cloneNames[1]);
      const receipt = client => client.query('SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name');
      const first = (await receipt(a)).rows;
      assert.equal(first.length, 1);
      assert.deepEqual((await receipt(b)).rows, first, 'Both clones inherit the one original migration timestamp');
      assert.notEqual((await a.query('SELECT current_database() name')).rows[0].name,
        (await b.query('SELECT current_database() name')).rows[0].name);
      await a.query("INSERT INTO template_probe VALUES(2, 'only first clone')");
      await b.query("UPDATE template_probe SET value = 'only second clone' WHERE id = 1");
      assert.equal((await b.query('SELECT count(*)::int n FROM template_probe')).rows[0].n, 1);
      assert.equal((await a.query('SELECT value FROM template_probe WHERE id=1')).rows[0].value, 'template seed');
      await createTestDatabase(cloneNames[2], { directory });
      const pristine = await connect(cloneNames[2]);
      assert.deepEqual((await pristine.query('SELECT * FROM template_probe')).rows, [{ id: 1, value: 'template seed' }]);
      assert.deepEqual((await receipt(pristine)).rows, first);
      await assert.rejects(createTestDatabase(cloneNames[2], { directory }), { code: '42P04' });
      assert.deepEqual((await pristine.query('SELECT * FROM template_probe')).rows, [{ id: 1, value: 'template seed' }]);
      await closeClients();
    });

    await t.test('manifest hashes canonical line endings and changes with migration content and file list', async () => {
      const original = await migrationManifest(directory);
      await fs.writeFile(migration, sql.replace(/\n/g, '\r\n'));
      assert.deepEqual(await migrationManifest(directory), original);
      await fs.writeFile(migration, sql.replace(/\n/g, '\r'));
      assert.deepEqual(await migrationManifest(directory), original);
      await fs.writeFile(migration, sql + '-- changed checksum\n');
      assert.notEqual(templateNameFor(await migrationManifest(directory)), templateNameFor(original));
      await fs.writeFile(migration, sql);
      const added = path.join(directory, '001_new.sql');
      await fs.writeFile(added, 'SELECT 1;\n');
      assert.notEqual(templateNameFor(await migrationManifest(directory)), templateNameFor(original));
      await fs.unlink(added);
      assert.equal(await ensureTemplateDatabase({ directory }), templateNameFor(original));
    });

    await t.test('a changed migration creates a fresh cache while the previous verified cache stays recognizable', async () => {
      const originalName = templateNameFor(await migrationManifest(directory));
      try {
        await fs.writeFile(migration, sql + 'ALTER TABLE template_probe ADD COLUMN added text;\n');
        const changedName = await ensureTemplateDatabase({ directory });
        assert.notEqual(changedName, originalName);
        const knownCaches = await verifiedTemplateDatabaseNames();
        assert.ok(knownCaches.includes(originalName));
        assert.ok(knownCaches.includes(changedName));
        await createTestDatabase(cloneNames[3], { directory });
        const changed = await connect(cloneNames[3]);
        assert.deepEqual((await changed.query('SELECT * FROM template_probe')).rows,
          [{ id: 1, value: 'template seed', added: null }]);
      } finally {
        await closeClients();
        await dropTestDatabase(cloneNames[3]);
        await cleanupTemplateDatabase({ directory });
        await fs.writeFile(migration, sql);
      }
    });

    for (const [kind, tamper] of [
      ['checksum', "UPDATE schema_migrations SET checksum = repeat('0', 64)"],
      ['missing migration', 'DELETE FROM schema_migrations'],
      ['extra migration', "INSERT INTO schema_migrations(name, checksum) VALUES('unexpected.sql', repeat('0', 64))"],
    ]) {
      await t.test(`existing template with ${kind} mismatch fails closed without creating a target`, async () => {
        const template = await ensureTemplateDatabase({ directory });
        const client = await connect(template);
        await client.query(tamper);
        await closeClients();
        await assert.rejects(createTestDatabase(cloneNames[3], { directory }), /migration list\/checksum mismatch/);
        const control = new Client({ connectionString: process.env.TEST_DATABASE_URL });
        await control.connect();
        try {
          assert.equal((await control.query('SELECT 1 FROM pg_database WHERE datname=$1', [cloneNames[3]])).rowCount, 0);
        } finally { await control.end(); }
        // Deliberately corrupted evidence is discarded, never rewritten as valid.
        await cleanupTemplateDatabase({ directory });
      });
    }

    await t.test('failed template migrations leave no cache and can be retried after repairing only fixture SQL', async () => {
      await fs.writeFile(migration, sql + 'SELECT 1/0;\n');
      await assert.rejects(createTestDatabase(cloneNames[3], { directory }), /division by zero/);
      assert.equal(await templateExists(), 0);
      await fs.writeFile(migration, sql);
      await ensureTemplateDatabase({ directory });
      assert.equal(await templateExists(), 1);
    });

    await t.test('legacy recreate helper defaults to an empty database for upgrade and migration tests', async () => {
      await require('./harness').recreateTestDatabase(cloneNames[3]);
      const fresh = await connect(cloneNames[3]);
      assert.equal((await fresh.query("SELECT to_regclass('schema_migrations') name")).rows[0].name, null);
      assert.equal((await fresh.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
      await closeClients();
    });

    await t.test('legacy mixed helpers clone ordinary fixtures but keep their upgrade names fresh', async () => {
      const recreate = require('./harness').recreateTestDatabase;
      const expectedManifest = await migrationManifest();
      // Both legacy setup(name, checkpoint) helpers call recreate with only name.
      // Their exact normal/upgrade identities must therefore retain opposite modes.
      for (const [name, migrated] of [
        ['amber_configuration_category_test', true],
        ['amber_reseal_upgrade_test', false],
        ['amber_attribute_race_test', true],
        ['amber_attribute_upgrade_test', false],
        ['amber_magento_binding_fresh_test', false],
        ['amber_stable_exposure_test', false],
      ]) {
        try {
          await recreate(name);
          const db = await connect(name);
          const ledger = (await db.query("SELECT to_regclass('schema_migrations') name")).rows[0].name;
          assert.equal(ledger !== null, migrated, name);
          if (migrated) {
            assert.deepEqual((await db.query('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows,
              expectedManifest);
            assert.equal((await db.query('SELECT count(*)::int n FROM categories')).rows[0].n, 0);
          } else {
            assert.equal((await db.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
          }
        } finally {
          await closeClients();
          await dropTestDatabase(name);
        }
      }
    });

    await t.test('an explicit fresh request overrides an ordinary fixture registry entry', async () => {
      const name = 'amber_configuration_category_test';
      try {
        await require('./harness').recreateTestDatabase(name, { template: false });
        const fresh = await connect(name);
        assert.equal((await fresh.query("SELECT to_regclass('schema_migrations') name")).rows[0].name, null);
        assert.equal((await fresh.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
      } finally {
        await closeClients();
        await dropTestDatabase(name);
      }
    });
  } finally {
    await closeClients();
    for (const name of cloneNames) await dropTestDatabase(name);
    await cleanupTemplateDatabase({ directory });
    await fs.rm(directory, { recursive: true, force: true });
  }
});
