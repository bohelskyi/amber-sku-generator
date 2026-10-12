'use strict';
require('../test/setup-env');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { fixture, category } = require('../test/fixtures/magento-category-evidence');
const bindings = require('../src/services/magento/binding.service');
const templates = require('../src/services/export-templates/template.service');
const successor = require('../src/services/magento/integration-successor');
const { hash } = require('../src/services/magento/binding-contract');
const { insertProductFixture } = require('./product-fixture');
const server = path.resolve(__dirname, '..');
const migration = '077_magento_category_binding_evidence.sql';
const orderedBindings = value => Object.fromEntries(Object.entries(value).map(([kind, rows]) =>
  [kind, rows.map(row => {
    // The repository adds the compiled evaluator label to stored route views.
    const { evaluatorSetName, ...decision } = row; void evaluatorSetName;
    return decision;
  }).sort((a, b) => hash(a).localeCompare(hash(b)))]));

function migrate(url, directory = path.join(server, 'migrations')) {
  return spawnSync(process.execPath, ['--require', './test/setup-env.js', '-e',
    "require('./src/db/run-migrations').runMigrations({directory:process.env.CATEGORY_TEST_MIGRATIONS}).catch(e=>{console.error(e);process.exitCode=1})"],
  { cwd: server, env: { ...process.env, DATABASE_URL: url, CATEGORY_TEST_MIGRATIONS: directory, NODE_ENV: 'test' },
    encoding: 'utf8', timeout: 120000, windowsHide: true });
}
function migrated(result) { assert.equal(result.status, 0, result.stderr || result.error?.message); }
async function database(name, operation) {
  assert.match(name, /^[a-z_]+_test$/);
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.match(url.pathname, /_test$/);
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect(); let created = false, db;
  try {
    assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name])).rowCount, 0);
    await admin.query(`CREATE DATABASE ${name}`); created = true; url.pathname = '/' + name;
    db = new Pool({ connectionString: url.toString(), max: 4 });
    await operation(db, url.toString());
  } finally {
    if (db) await db.end();
    if (created) await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
}
async function snapshot(db) {
  const result = {};
  for (const { tablename } of (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    assert.match(tablename, /^[a-z_]+$/);
    result[tablename] = (await db.query(`SELECT COALESCE(jsonb_agg(j ORDER BY j::text),'[]'::jsonb) rows
      FROM (SELECT to_jsonb(t) j FROM public."${tablename}" t) entries`)).rows[0].rows;
  }
  return result;
}
const constraint = async db => (await db.query(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
  WHERE conrelid='magento_binding_attributes'::regclass AND conname='magento_binding_attributes_evidence_check'`)).rows[0].definition;

async function seed(db) {
  const f = fixture();
  const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Category fixture admin') RETURNING id")).rows[0].id);
  await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
  const options = { databasePool: db, mutationContext: { actorUserId: actor } };
  for (const group of f.definition.groups) await db.query('INSERT INTO categories(code,name) VALUES($1,$1)', [group.route]);
  for (const [id, source] of Object.entries(f.definition.sources)) {
    if (source.kind === 'product') continue;
    const question = (await db.query(`INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required)
      VALUES($1,$2,$2,$3,0,0) RETURNING id`, [source.category, source.key, source.kind === 'semantic' ? 'options' : 'text'])).rows[0];
    const values = [...new Set(Object.values(f.definition.questionContracts).filter(q => q.source === id).flatMap(q => q.allowed))];
    for (const value of values) await db.query('INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,$2,$3,$3)', [question.id, value, value]);
  }
  const family = await templates.createTemplate({ key: 'category-evidence', displayName: 'Category evidence fixture', definition: f.definition }, options);
  const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
  const source = structuredClone(f.sourceBindings);
  for (const route of source.routes) { route.enabled = true; route.reviewState = 'approved'; }
  for (const attribute of source.attributes) {
    attribute.reviewState = 'approved';
    for (const row of attribute.evidence.categories || []) row.reviewState = row.categoryId ? 'approved' : 'blocked';
  }
  for (const option of source.options) option.reviewState = option.optionId ? 'approved' : 'blocked';
  for (const policy of source.policies) {
    const attribute = source.attributes.find(a => a.bindingKey === policy.bindingKey);
    policy.reviewState = 'approved';
    policy.policy = attribute.target === 'product_online' ? 'initialize_create_only'
      : attribute.target === 'name' ? 'magento_managed' : 'authoritative_create_update';
    if (policy.policy === 'initialize_create_only') policy.evidence.createValue = 2;
  }
  const config = { configured: true, baseUrl: 'https://successor.invalid', consumerKey: 'fixture-key', consumerSecret: 'fixture-secret',
    accessToken: 'fixture-token', accessTokenSecret: 'fixture-token-secret' };
  let draft = await bindings.createDraft({ installationKey: 'category-evidence', origin: config.baseUrl,
    templateVersionId: version.id, observedAt: '2026-10-12T00:00:00.000Z', schema: f.schema }, options);
  draft = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: source }, options);
  const published = await bindings.publishDraft(draft.id, { expectedRevision: draft.revision, expectedCurrentId: null }, options);
  const products = [];
  for (const [index, product] of [...f.products, { ...f.selectedProduct, full_sku: 'NM-SYNTH-SELECTED' }].entries()) {
    products.push((await insertProductFixture(db, `INSERT INTO products(full_sku,category,weight,total_price_uah,details)
      VALUES($1,'NM',$2,$3,$4::jsonb) RETURNING *`, [product.full_sku, product.weight, product.total_price_uah, JSON.stringify(product.details)])).rows[0]);
    assert.equal(products[index].full_sku, product.full_sku);
  }
  return { ...f, db, options, config, version, published, products };
}

function categoryTree(f) {
  const root = { id: 703, name: 'Default', children_data: [] }; let next = 9000;
  for (const node of f.nodes) {
    let parent = root, prefix = 'Default';
    for (const part of node.path.split('/').slice(1)) {
      prefix += '/' + part;
      let child = parent.children_data.find(row => row.name === part);
      if (!child) {
        child = { id: Number(f.nodes.find(row => row.path === prefix)?.categoryId || next++), name: part,
          parent_id: parent.id, children_data: [] };
        parent.children_data.push(child);
      }
      parent = child;
    }
  }
  return root;
}
async function rollback(db, operation) {
  const client = await db.connect();
  try { await client.query('BEGIN'); await operation(client); }
  finally { await client.query('ROLLBACK'); client.release(); }
}

test('077 upgrades 076 atomically and persists bounded category successor evidence without changing current state', async t => {
  await database('amber_category_evidence_upgrade_test', async (db, url) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-category-076-'));
    try {
      for (const file of (await fs.readdir(path.join(server, 'migrations'))).filter(n => n.endsWith('.sql') && n < '077')) {
        await fs.copyFile(path.join(server, 'migrations', file), path.join(directory, file));
      }
      migrated(migrate(url, directory));
      const f = await seed(db), before = await snapshot(db), oldConstraint = await constraint(db);
      assert.equal(Buffer.byteLength(JSON.stringify(category(f.published.bindings).evidence)), 6087);
      const sql = await fs.readFile(path.join(server, 'migrations', migration), 'utf8');
      await t.test('failed forward migration rolls back its DDL, checksums and all existing rows', async () => {
        await fs.writeFile(path.join(directory, migration), sql + '\nSELECT 1/0;');
        const failed = migrate(url, directory);
        assert.notEqual(failed.status, 0); assert.match(failed.stderr, /division by zero/);
        assert.equal(await constraint(db), oldConstraint); assert.deepEqual(await snapshot(db), before);
      });
      await t.test('upgrade and repeated LF/CRLF/CR startup preserve every prior row and checksum', async () => {
        await fs.writeFile(path.join(directory, migration), sql); migrated(migrate(url, directory));
        const after = await snapshot(db), applied = after.schema_migrations.filter(row => row.name === migration);
        assert.equal(applied.length, 1);
        after.schema_migrations = after.schema_migrations.filter(row => row.name !== migration);
        assert.deepEqual(after, before); assert.notEqual(await constraint(db), oldConstraint);
        const stable = await snapshot(db);
        for (const ending of ['\n', '\r\n', '\r']) {
          await fs.writeFile(path.join(directory, migration), sql.replace(/\r?\n/g, ending));
          const result = migrate(url, directory); migrated(result); assert.doesNotMatch(result.stdout, /Applied migration/);
          assert.deepEqual(await snapshot(db), stable);
        }
      });
      let created;
      await t.test('real read-only prepare carries 17 paths; actual draft apply round-trips 24 paths above the old SQL limit', async () => {
        const calls = [], tree = categoryTree(f);
        const remote = { ...f.options, discover: async () => ({ schema: f.schema, categories: f.nodes, observedAt: '2026-10-12T00:00:00.000Z' }),
          fetchImpl: async (url, init) => {
            assert.equal(init.method, 'GET'); const parsed = new URL(url);
            assert.equal(parsed.origin, f.config.baseUrl); assert.equal(parsed.pathname, '/rest/all/V1/categories');
            assert.equal(parsed.searchParams.get('rootCategoryId'), '703'); calls.push(parsed.pathname);
            return new Response(JSON.stringify(tree), { headers: { 'content-type': 'application/json' } });
          } };
        const readonly = new Pool({ connectionString: url, max: 4, options: '-c default_transaction_read_only=on' });
        const input = { sourceId: f.published.id, expectedSourceRevision: f.published.revision, templateVersionId: f.version.id,
          productIds: [Number(f.products.at(-1).id)] };
        const initial = await snapshot(db); let prepared;
        try {
          await assert.rejects(readonly.query("UPDATE magento_binding_attributes SET evidence=evidence"), { code: '25006' });
          const one = await successor.prepare(f.config, input, { ...remote, databasePool: readonly });
          assert.deepEqual(one.blockers, []); assert.equal(category(one.bindings).evidence.categories.length, 19);
          assert.ok(Buffer.byteLength(JSON.stringify(category(one.bindings).evidence)) > 6500);
          assert.ok(calls.length > 0, 'source-only paths require exact live category GET');
          input.productIds = f.products.slice(0, 50).map(p => Number(p.id));
          prepared = await successor.prepare(f.config, input, { ...remote, databasePool: readonly });
          assert.deepEqual(prepared.blockers, []);
        } finally { await readonly.end(); }
        assert.deepEqual(await snapshot(db), initial);
        assert.equal(category(prepared.bindings).evidence.categories.length, 24);
        const evidence = category(prepared.bindings).evidence;
        assert.ok(Buffer.byteLength(JSON.stringify(evidence)) > 8192);
        for (const old of category(f.published.bindings).evidence.categories) {
          assert.deepEqual(evidence.categories.find(row => row.normalizedPath === old.normalizedPath), old);
        }
        assert.ok(evidence.categories.filter(row => !category(f.published.bindings).evidence.categories.some(old => old.normalizedPath === row.normalizedPath))
          .every(row => row.reviewState !== 'approved'));
        created = await successor.apply(f.config, { ...input, previewToken: prepared.previewToken }, remote);
        assert.equal(created.state, 'draft'); assert.deepEqual(orderedBindings(created.bindings), orderedBindings(prepared.bindings));
        assert.deepEqual((await bindings.getRevision(created.id, f.options)).bindings, created.bindings);
        const stored = (await db.query(`SELECT evidence,octet_length(evidence::text) bytes FROM magento_binding_attributes
          WHERE revision_id=$1 AND binding_key=$2`, [created.id, category(created.bindings).bindingKey])).rows[0];
        assert.deepEqual(stored.evidence, evidence); assert.ok(stored.bytes > 8192 && stored.bytes <= 81920);
        const after = await snapshot(db);
        const audit = after.audit_events.filter(row => row.subject_id === created.id);
        assert.deepEqual(audit.map(row => row.event_key).sort(), ['magento_binding.created', 'magento_binding.successor_prepared']);
        for (const table of Object.keys(after)) {
          if (table === 'audit_events') after[table] = after[table].filter(row => row.subject_id !== created.id);
          else if (table === 'magento_binding_revisions') after[table] = after[table].filter(row => row.id !== created.id);
          else if (table.startsWith('magento_binding_')) after[table] = after[table].filter(row => row.revision_id !== created.id);
        }
        assert.deepEqual(after, initial, 'only new draft rows and its two audit events may change');
        assert.deepEqual(await bindings.getRevision(f.published.id, f.options), f.published);
        assert.equal((await bindings.getCurrentPublished('category-evidence', f.options)).id, f.published.id);
        await assert.rejects(bindings.publishDraft(created.id, { expectedRevision: created.revision, expectedCurrentId: f.published.id }, f.options),
          { code: 'MAGENTO_BINDING_INVALID' });
      });
      await t.test('SQL accepts only bounded category transport expansion and keeps ordinary evidence and immutable publication guards', async () => {
        assert.ok(created);
        const stable = await snapshot(db), key = category(created.bindings).bindingKey;
        const set = (table, where, evidence, extra = '') => client => client.query(`UPDATE ${table} SET evidence=$1::jsonb ${extra}
          WHERE revision_id=$2 AND ${where}`, [JSON.stringify(evidence), created.id]);
        const exact = size => ({ note: 'x'.repeat(size - 12) }); // JSONB text: {"note": "..."}
        await rollback(db, async client => {
          const result = await set('magento_binding_attributes', "target='categories' AND route_key='NM:all' AND row_id='base'", exact(81920))(client);
          assert.equal(result.rowCount, 1);
          assert.equal((await client.query('SELECT octet_length(evidence::text) bytes FROM magento_binding_attributes WHERE revision_id=$1 AND binding_key=$2', [created.id, key])).rows[0].bytes, 81920);
        });
        for (const bad of [exact(81921), [], null]) await assert.rejects(rollback(db,
          set('magento_binding_attributes', "target='categories' AND route_key='NM:all' AND row_id='base'", bad)), { code: '23514' });
        const targets = [
          ['magento_binding_attributes', "target='name'", ''],
          ['magento_binding_attributes', "target='store_view_code'", ''],
          ['magento_binding_attributes', "target='name' AND row_id='english'", ", target='categories'"],
          ['magento_binding_routes', "route_key='NM:all'", ''],
          ['magento_binding_options', 'TRUE', ''],
          ['magento_binding_field_policies', 'TRUE', ''],
        ];
        for (const [table, where, extra] of targets) {
          await rollback(db, async client => assert.ok((await set(table, where, exact(8192), extra)(client)).rowCount > 0));
          await assert.rejects(rollback(db, set(table, where, exact(8193), extra)), { code: '23514' });
        }
        await assert.rejects(db.query('UPDATE magento_binding_attributes SET evidence=evidence WHERE revision_id=$1', [f.published.id]),
          /published Magento bindings are immutable/);
        assert.deepEqual(await snapshot(db), stable);
      });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
});

test('077 fresh installation has the same scoped validated constraint and no binding seeds', async () => {
  await database('amber_category_evidence_fresh_test', async (db, url) => {
    migrated(migrate(url));
    const definition = await constraint(db);
    assert.match(definition, /81920/); assert.match(definition, /8192/);
    assert.match(definition, /categories/); assert.match(definition, /transport_control/);
    assert.equal((await db.query("SELECT convalidated FROM pg_constraint WHERE conrelid='magento_binding_attributes'::regclass AND conname='magento_binding_attributes_evidence_check'")).rows[0].convalidated, true);
    assert.equal((await db.query('SELECT count(*)::int n FROM magento_binding_revisions')).rows[0].n, 0);
    const files = (await fs.readdir(path.join(server, 'migrations'))).filter(file => file.endsWith('.sql')).sort();
    assert.deepEqual((await db.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(row => row.name), files);
  });
});
