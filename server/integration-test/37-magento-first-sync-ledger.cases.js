// Registered by magento-first-sync-ledger.test.js; owns a unique disposable database.
// Run only on the canonical disposable PostgreSQL after coordinating with the suite owner.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { Client, Pool } = require('pg');
const exec = promisify(execFile);

test('first-sync durable partial receipts, caller transaction rollback, CAS and immutable completion', async t => {
  const source = new URL(process.env.TEST_DATABASE_URL || '');
  assert.equal(source.hostname, '127.0.0.1'); assert.equal(source.port, '55432'); assert.ok(source.pathname.endsWith('_test'));
  const name = 'amber_first_sync_ledger_' + process.pid + '_test';
  const control = new Client({ connectionString: source.toString() });
  await control.connect(); let created = false, db;
  try {
    assert.equal((await control.query('SELECT count(*)::int n FROM pg_database WHERE datname=$1', [name])).rows[0].n, 0);
    await control.query('CREATE DATABASE ' + name); created = true;
    const target = new URL(source); target.pathname = '/' + name;
    await exec(process.execPath, ['-e', "require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});"],
      { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: target.toString() } });
    db = new Pool({ connectionString: target.toString(), max: 6 });
    t.mock.method(globalThis, 'fetch', () => assert.fail('Ledger must never perform external I/O'));
    const ledger = require('../src/services/magento/first-sync-ledger');
    const templates = require('../src/services/export-templates/template.service');
    const bindings = require('../src/services/magento/binding.service');
    const fixture = require('../test/fixtures/magento-bindings');
    const { insertProductFixture } = require('./product-fixture');
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','First sync fixture') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const options = { databasePool: db, mutationContext: { actorUserId: actor } };
    for (const code of ['BR','NM','KL','CH','AR','SV']) await db.query('INSERT INTO categories(code,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [code]);
    const definition = structuredClone(fixture.definition()), schema = fixture.schema();
    definition.sources = { sku: definition.sources.sku }; definition.tables = {};
    for (const group of definition.groups) for (const row of group.rows) {
      delete row.cells.kolir; delete row.cells.decor_weight; delete row.cells.dovzhyna_brasletu_diuimiv;
    }
    const family = await templates.createTemplate({ key: 'first-sync-' + randomUUID(), displayName: 'First sync', definition }, options);
    const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    let binding = await bindings.createDraft({ installationKey: 'first-sync-fixture', origin: 'https://first-sync.invalid',
      templateVersionId: version.id, observedAt: '2026-10-09T00:00:00Z', schema }, options);
    binding = await bindings.updateDraft(binding.id, { expectedRevision: binding.revision, bindings: fixture.approvedBindings(definition, schema, 'SV') }, options);
    binding = await bindings.publishDraft(binding.id, { expectedRevision: binding.revision, expectedCurrentId: null }, options);
    const products = (await insertProductFixture(db, "INSERT INTO products(full_sku,category,weight,total_price_uah,details) VALUES('SV900001','SV',5,420,'{\"answers\":{}}'),('SV900002','SV',5,420,'{\"answers\":{}}') RETURNING id,full_sku,public_product_identity_id")).rows;
    const product = products[0];
    await db.query('CREATE TABLE first_sync_local_fixture(value integer NOT NULL,local_name text)');
    await db.query('INSERT INTO first_sync_local_fixture(value) VALUES(0)');
    const key = { originHash: binding.originHash, publicIdentityId: product.public_product_identity_id };
    const identity = { installationKey: binding.installationKey, publicSku: product.full_sku, remoteProductId: '801',
      initialProductId: product.id, initialBindingRevisionId: binding.id, contractVersion: 'v1' };
    const field = (target, scope, state, after = null) => ({ target, scope, state, before: null, remote: after, after,
      mappingHash: 'c'.repeat(64), source: { kind: 'product', field: target, productId: product.id,
        bindingRevisionId: binding.id, definitionHash: version.definitionHash, routeKey: 'SV' } });
    const input = (revision, fields, overrides = {}) => ({ key, identity, expectedRevision: revision,
      previewHash: require('../src/services/magento/binding-contract').hash(randomUUID()), fields, actorUserId: actor, ...overrides });
    async function transaction(operation) {
      const client = await db.connect();
      try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    const record = command => transaction(client => ledger.recordProgressOnClient(client, command));
    const read = () => ledger.readOnClient(db, key);
    const counts = async () => (await db.query(`SELECT
      (SELECT count(*)::int FROM magento_first_sync_sessions) sessions,
      (SELECT count(*)::int FROM magento_first_sync_progress) progress,
      (SELECT count(*)::int FROM magento_first_sync_fields) fields,
      (SELECT count(*)::int FROM audit_events WHERE event_key='magento.first_sync_progress_recorded') audit,
      (SELECT value FROM first_sync_local_fixture) value`)).rows[0];
    let first;
    await t.test('migration is fresh, repeat startup is inert, and autocommit is refused', async () => {
      const before = (await db.query("SELECT checksum FROM schema_migrations WHERE name='073_magento_first_sync_ledger.sql'")).rows;
      assert.equal(before.length, 1);
      await exec(process.execPath, ['-e', "require('./src/db/run-migrations').runMigrations().then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});"],
        { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: target.toString() } });
      assert.deepEqual((await db.query("SELECT checksum FROM schema_migrations WHERE name='073_magento_first_sync_ledger.sql'")).rows, before);
      const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-first-sync-migration-'));
      try {
        const migration = await fs.readFile(path.resolve(__dirname, '../migrations/073_magento_first_sync_ledger.sql'), 'utf8');
        await fs.writeFile(path.join(temporary, '073_magento_first_sync_ledger.sql'), migration + '\n-- altered fixture\n');
        await assert.rejects(exec(process.execPath, ['-e', "require('./src/db/run-migrations').runMigrations({directory:process.env.FIRST_SYNC_MIGRATION_FIXTURE}).catch(e=>{console.error(e.message);process.exitCode=1;});"],
          { cwd: path.resolve(__dirname, '..'), env: { ...process.env, DATABASE_URL: target.toString(), FIRST_SYNC_MIGRATION_FIXTURE: temporary } }), /Migration checksum mismatch/);
        assert.deepEqual((await db.query("SELECT checksum FROM schema_migrations WHERE name='073_magento_first_sync_ledger.sql'")).rows, before);
      } finally {
        assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
        await fs.rm(temporary, { recursive: true });
      }
      const client = await db.connect();
      try { await assert.rejects(ledger.recordProgressOnClient(client, input('0', [field('name','en','unknown')])), { code: 'FIRST_SYNC_LEDGER_TRANSACTION_REQUIRED' }); }
      finally { client.release(); }
      assert.equal(await read(), null); assert.deepEqual(await counts(), { sessions: 0, progress: 0, fields: 0, audit: 0, value: 0 });
    });
    await t.test('partial safe import persists independently; unresolved scopes remain unresolved', async () => {
      first = input('0', [field('name','all','name_received','Name UA'), field('name','en','unknown'),
        field('color','all','conflict'), field('price','all','pending_outward_confirmation')], {
        applyLocal: async (client, acceptedFields) => {
          assert.equal(acceptedFields.length, 1); assert.equal(acceptedFields[0].scope, 'all');
          assert.equal(acceptedFields[0].state, 'name_received');
          acceptedFields[0].after = 'Callback copy only';
          await client.query("UPDATE first_sync_local_fixture SET value=value+1,local_name='Name UA'");
        } });
      const result = await record(first);
      assert.equal(result.revision, '1'); assert.equal(result.completed, false);
      const state = await read();
      assert.equal(state.session.completed_at, null);
      assert.equal(state.fields.find(f => f.target === 'name' && f.scope === 'all').state, 'name_received');
      assert.equal(state.fields.find(f => f.target === 'name' && f.scope === 'all').after, 'Name UA');
      assert.equal(state.fields.find(f => f.target === 'price').state, 'pending_outward_confirmation');
      assert.deepEqual(await counts(), { sessions: 1, progress: 1, fields: 4, audit: 1, value: 1 });
      const repeat = await record(first); assert.equal(repeat.alreadyApplied, true);
      assert.deepEqual(await counts(), { sessions: 1, progress: 1, fields: 4, audit: 1, value: 1 });
      await assert.rejects(record({ ...first, fields: [field('name','all','name_received','Changed')] }), { code: 'FIRST_SYNC_LEDGER_RECEIPT_CONFLICT' });
    });
    await t.test('terminal receipts survive contract changes and cannot be replaced; unsafe completion is refused', async () => {
      await assert.rejects(record(input('1', [field('name','all','name_received','Changed')])), { code: 'FIRST_SYNC_LEDGER_TERMINAL' });
      await assert.rejects(record(input('1', [], { complete: true, requiredScopes: [{ target: 'name', scope: 'all' }] })), { code: 'FIRST_SYNC_LEDGER_INCOMPLETE' });
      const result = await record(input('1', [field('name','en','review_required')], { identity: { ...identity, contractVersion: 'v2' } }));
      assert.equal(result.revision, '2');
      assert.equal((await read()).fields.find(f => f.target === 'name' && f.scope === 'all').revision, '1');
      assert.equal((await read()).session.initial_contract_version, 'v1');
      await assert.rejects(record(input('2', [field('name','en','unknown')], { identity: { ...identity, remoteProductId: '802' } })), { code: 'FIRST_SYNC_LEDGER_IDENTITY' });
    });
    await t.test('fresh preview of an identical terminal name leaves a later manager edit unchanged', async () => {
      await db.query("UPDATE first_sync_local_fixture SET value=7,local_name='Manager edited name'");
      let called = false;
      const before = await counts();
      const result = await record(input('2', [first.fields.find(f => f.target === 'name' && f.scope === 'all')], {
        applyLocal: async client => { called = true; await client.query("UPDATE first_sync_local_fixture SET value=1,local_name='Name UA'"); }
      }));
      assert.equal(result.revision, '3'); assert.deepEqual(result.changedFields, []); assert.equal(called, false);
      const after = await counts();
      assert.equal(after.value, 7); assert.equal(after.fields, before.fields);
      assert.equal((await db.query('SELECT local_name FROM first_sync_local_fixture')).rows[0].local_name, 'Manager edited name');
      assert.equal((await read()).fields.find(f => f.target === 'name' && f.scope === 'all').revision, '1');
    });
    await t.test('callback failure, audit failure and caller rollback leave no partial progress or local patch', async () => {
      const before = await counts();
      await assert.rejects(record(input('3', [field('name','en','imported','Name EN')], {
        applyLocal: async client => { await client.query('UPDATE first_sync_local_fixture SET value=99'); throw new Error('callback-failed'); }
      })), /callback-failed/);
      assert.deepEqual(await counts(), before);
      await db.query(`CREATE FUNCTION fail_first_sync_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_key='magento.first_sync_progress_recorded' THEN RAISE EXCEPTION 'audit-failed'; END IF; RETURN NEW; END $$`);
      await db.query('CREATE TRIGGER fail_first_sync_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_first_sync_audit()');
      try { await assert.rejects(record(input('3', [field('name','en','imported','Name EN')], {
        applyLocal: client => client.query('UPDATE first_sync_local_fixture SET value=99') })), /audit-failed/); }
      finally { await db.query('DROP TRIGGER fail_first_sync_audit ON audit_events'); await db.query('DROP FUNCTION fail_first_sync_audit()'); }
      assert.deepEqual(await counts(), before);
      await assert.rejects(transaction(async client => {
        await ledger.recordProgressOnClient(client, input('3', [field('name','en','imported','Name EN')], {
          applyLocal: c => c.query('UPDATE first_sync_local_fixture SET value=99') }));
        throw new Error('caller-failed');
      }), /caller-failed/);
      assert.deepEqual(await counts(), before);
    });
    await t.test('real independent transaction race yields one CAS winner and rejects stale local patch', async () => {
      const holder = await db.connect(), contender = await db.connect();
      let pending;
      try {
        await holder.query('BEGIN'); await contender.query('BEGIN');
        const command = input('3', [field('name','en','name_received','Name EN')]);
        const winner = await ledger.recordProgressOnClient(holder, command);
        let callbackRan = false;
        pending = ledger.recordProgressOnClient(contender, input('3', [field('color','all','equal','amber')], {
          applyLocal: async () => { callbackRan = true; }
        })); pending.catch(() => {});
        let blocked = false;
        const pid = (await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        for (let n = 0; n < 200; n++) {
          blocked = (await db.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND pid<>$2 AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%') blocked", [name,pid])).rows[0].blocked;
          if (blocked) break; await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true);
        await holder.query('COMMIT'); await assert.rejects(pending, { code: 'FIRST_SYNC_LEDGER_STALE' });
        await contender.query('ROLLBACK'); assert.equal(callbackRan, false); assert.equal(winner.revision, '4');
        const replay = await record(command); assert.equal(replay.alreadyApplied, true);
      } finally { await holder.query('ROLLBACK'); await contender.query('ROLLBACK'); if (pending) await Promise.allSettled([pending]); holder.release(); contender.release(); }
    });
    await t.test('remote identity cannot be rebound to a second public identity', async () => {
      const other = products[1], before = await counts();
      await assert.rejects(record(input('0', [field('name','en','unknown')], {
        key: { ...key, publicIdentityId: other.public_product_identity_id },
        identity: { ...identity, publicSku: other.full_sku, initialProductId: other.id } })), { code: '23505' });
      assert.deepEqual(await counts(), before);
    });
    await t.test('completion requires all unresolved scopes terminal and cannot be reopened', async () => {
      const complete = input('4', [field('color','all','equal','amber'), field('price','all','outward_verified','420.00')], {
        applyLocal: () => assert.fail('Equal/outward completion must not patch local values'),
        complete: true, requiredScopes: ['all','en'].map(scope => ({ target: 'name', scope })).concat([{ target: 'color', scope: 'all' }, { target: 'price', scope: 'all' }]) });
      const result = await record(complete); assert.equal(result.completed, true); assert.equal(result.revision, '5');
      assert.ok((await read()).session.completed_at);
      const before = await counts();
      assert.equal((await record(complete)).alreadyApplied, true);
      await assert.rejects(record(input('5', [field('weight','all','unknown')])), { code: 'FIRST_SYNC_LEDGER_COMPLETED' });
      assert.deepEqual(await counts(), before);
      for (const table of ['magento_first_sync_progress','magento_first_sync_fields']) {
        await assert.rejects(db.query('DELETE FROM ' + table), /FIRST_SYNC_EVIDENCE_IMMUTABLE/);
        await assert.rejects(db.query('TRUNCATE ' + table + ' CASCADE'), /FIRST_SYNC_/);
      }
      await assert.rejects(db.query("UPDATE magento_first_sync_sessions SET public_sku='SV999'"), /FIRST_SYNC_SESSION_IMMUTABLE/);
      await assert.rejects(db.query('DELETE FROM magento_first_sync_sessions'), /FIRST_SYNC_SESSION_PERMANENT/);
      assert.deepEqual(await counts(), before);
    });
  } finally {
    if (db) await db.end();
    if (created) await control.query('DROP DATABASE ' + name);
    await control.end();
  }
});
