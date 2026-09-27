const suite = require('./suite-context');
const { test, assert, pool, Pool, TEST_DATABASE_URL, authenticateApplicationSession, crypto } = suite;
const { insertProductFixture } = require('./product-fixture');
const bindings = require('../src/services/magento/binding.service');
const templates = require('../src/services/export-templates/template.service');
const fixture = require('../test/fixtures/magento-bindings');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { previewProduct } = require('../src/services/magento/sync-preview');
const { enqueue, applyJob } = require('../src/services/magento/sync-job.service');
const { parseMagentoConfig } = require('../src/config/magento');
const config = parseMagentoConfig({ MAGENTO_BASE_URL: 'https://sync.example.invalid', MAGENTO_CONSUMER_KEY: 'fake-key',
  MAGENTO_CONSUMER_SECRET: 'fake-secret', MAGENTO_ACCESS_TOKEN: 'fake-access', MAGENTO_ACCESS_TOKEN_SECRET: 'fake-access-secret' });
const literal = (value) => ({ op: 'literal', value });

test('Magento sync migration 042 rolls back from checkpoint 041 and upgrades repeatedly without jobs', async () => {
  const { fs, os, path, serverRoot, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = suite;
  const name = 'amber_magento_sync_migration_test'; const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-sync-041-'));
  const db = new Pool({ connectionString: url });
  const migrate = () => runNodeInDatabase(url, `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
  try {
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations'))).filter((f) => f.endsWith('.sql') && f < '042')) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    await migrate(); const before = (await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    const file = '042_magento_sync_jobs.sql'; const sql = await fs.readFile(path.join(serverRoot, 'migrations', file), 'utf8');
    await fs.writeFile(path.join(directory, file), sql + '\nSELECT 1/0;');
    await assert.rejects(migrate(), /division by zero/);
    assert.equal((await db.query("SELECT to_regclass('magento_sync_jobs') AS present")).rows[0].present, null);
    assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows, before);
    await fs.writeFile(path.join(directory, file), sql); await migrate(); await migrate();
    assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n, 0);
    assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name<'042' ORDER BY name")).rows, before);
  } finally {
    await db.end();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('amber-sync-041-'));
    await fs.rm(directory, { recursive: true, force: true }); await dropTestDatabase(name);
  }
});

test('Magento sync durable jobs: real PostgreSQL persistence, dispatch races and exact verification', async (t) => {
  const admin = await authenticateApplicationSession(); const actorUserId = Number(admin.applicationUser.id);
  const mutations = { databasePool: pool, mutationContext: { actorUserId, requestId: 'sync-fixture' } };
  for (const group of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) await pool.query('INSERT INTO categories(code,name) VALUES($1,$1) ON CONFLICT(code) DO NOTHING', [group]);
  const d = structuredClone(fixture.definition()); d.sources = { sku: d.sources.sku }; d.tables = {};
  for (const g of d.groups) for (const row of g.rows) {
    const sku = row.cells.sku;
    row.cells = { sku, name: literal(row.id === 'base' ? 'Amber name' : 'English name'),
      attribute_set_code: literal('Historical CSV name'), product_type: literal('simple'), store_view_code: literal(row.id === 'base' ? '' : 'en') };
    if (row.id === 'base') Object.assign(row.cells, { price: literal('42'), product_online: literal('2'), visibility: literal('Catalog, Search'),
      categories: literal('Default/Fixture'), qty: literal('1'), is_in_stock: literal('1'), product_websites: literal('fixture') });
    else row.cells.meta_title = literal('English SEO');
  }
  const definition = compileDefinition(d).definition; const schema = structuredClone(fixture.schema());
  schema.attributeSets[0].attribute_set_name = 'Historical CSV name';
  for (const a of schema.attributes) { a.apply_to = []; if (a.attribute_code === 'name') a.scope = 'store'; }
  schema.attributes.push({ attribute_code: 'meta_title', attribute_id: 1101, scope: 'store', frontend_input: 'text', options: [], apply_to: [] });
  schema.attributeSets[0].attributeCodes.push('meta_title');
  const family = await templates.createTemplate({ key: `sync-${crypto.randomUUID()}`, displayName: 'Synthetic sync', definition }, mutations);
  const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, mutations);
  const installationKey = `sync-${crypto.randomUUID()}`;
  const makeDraft = async () => {
    let draft = await bindings.createDraft({ installationKey, origin: config.baseUrl, templateVersionId: version.id,
      observedAt: new Date().toISOString(), schema }, mutations);
    const b = fixture.approvedBindings(definition, schema);
    const native = { attribute_set_code: 'attribute_set_id', product_type: 'type_id', product_online: 'status', visibility: 'visibility',
      categories: 'extension_attributes.category_links', product_websites: 'extension_attributes.website_ids', qty: 'inventory.qty', is_in_stock: 'inventory.is_in_stock', store_view_code: 'store_view_code' };
    for (const a of b.attributes) {
      if (a.strategy === 'transport_control') a.transportTarget = `product.${native[a.target]}`;
      if (a.target === 'categories') a.evidence = { categories: [{ requestedPath: 'Default/Fixture', normalizedPath: 'Default/Fixture',
        categoryId: '9001', candidates: [{ categoryId: '9001', path: 'Default/Fixture' }], reviewState: 'approved' }] };
      const p = b.policies.find((p) => p.bindingKey === require('../src/services/magento/binding-validation').bindingKey(a.routeKey, a.rowId, a.target));
      p.policy = ['qty', 'is_in_stock', 'product_online'].includes(a.target) ? 'initialize_create_only'
        : a.rowId === 'english' && ['sku', 'attribute_set_code', 'product_type', 'store_view_code'].includes(a.target) ? 'magento_managed' : 'authoritative_create_update';
      if (a.target === 'product_online') p.evidence = { createValue: 2 };
    }
    draft = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: b }, mutations);
    return draft;
  };
  const draft = await makeDraft();
  const published = await bindings.publishDraft(draft.id, { expectedRevision: draft.revision, expectedCurrentId: null }, mutations);

  async function scenario({ create = false } = {}) {
    const sku = `BR/SYNC-${crypto.randomUUID()}`.toUpperCase();
    const product = (await insertProductFixture(pool, `INSERT INTO products
      (full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details)
      VALUES ($1,$1,0,'BR',5,10,42,2,40,'{"answers":{}}') RETURNING id`, [sku])).rows[0];
    await pool.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1", [product.id]);
    const initial = { id: product.id + 100000, sku, attribute_set_id: 8001, name: 'Old name', type_id: 'simple', price: 40,
      status: 1, visibility: 4, custom_attributes: [{ attribute_code: 'unknown_attribute', value: 'Keep me' }], media_gallery_entries: [{ id: 100 }],
      extension_attributes: { category_links: [], website_ids: [999] } };
    let remote = create ? null : structuredClone(initial);
    let english = create ? null : { ...structuredClone(initial), name: 'Old English', custom_attributes: [{ attribute_code: 'meta_title', value: 'Old SEO' }] };
    let sourceItems = create ? [] : [{ sku, source_code: 'default', quantity: 0, status: 0 }];
    const writes = []; const hooks = {};
    const response = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init) => {
      const u = new URL(url); const route = u.pathname.split('/V1/')[1];
      if (init.method === 'GET') {
        if (hooks.readFailure) throw new Error('synthetic GET failure');
        if (route === 'products') {
          assert.equal(u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'), sku);
          const p = u.pathname.includes('/en/') ? english : remote;
          return response({ total_count: p ? 1 : 0, items: p ? [p] : [] });
        }
        if (route === 'categories') return response({ id: 803, name: 'Default', parent_id: 1,
          children_data: [{ id: 9001, parent_id: 803, name: 'Fixture', children_data: [] }] });
        if (route === 'inventory/stock-resolver/website/base') return response({ stock_id: 1,
          extension_attributes: { sales_channels: [{ type: 'website', code: 'base' }] } });
        if (route === 'inventory/get-sources-assigned-to-stock-ordered-by-priority/1') return response([{ source_code: 'default', enabled: true }]);
        if (route === 'inventory/source-items') return response({ items: sourceItems, total_count: sourceItems.length });
        throw new Error(`Unexpected route ${route}`);
      }
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
      const body = JSON.parse(init.body); writes.push({ route, scope: u.pathname.split('/')[2], body });
      if (hooks.beforeWrite) await hooks.beforeWrite(writes.at(-1));
      if (hooks.noMutation) return response(true);
      if (route === 'inventory/source-items') sourceItems = body.sourceItems;
      else if (route.endsWith('/websites')) remote.extension_attributes.website_ids.push(body.productWebsiteLink.website_id);
      else {
        assert.equal(route, 'products'); const p = body.product;
        if (!remote) { remote = { ...initial, status: 2, custom_attributes: [], extension_attributes: { category_links: [], website_ids: [] } };
          english = structuredClone(remote); sourceItems = [{ sku, source_code: 'default', quantity: 0, status: 0 }]; }
        const target = u.pathname.includes('/en/') ? english : remote;
        for (const [key, value] of Object.entries(p)) {
          if (key === 'custom_attributes') { for (const a of value) {
            const old = target.custom_attributes.find((v) => v.attribute_code === a.attribute_code);
            if (old) old.value = a.value; else target.custom_attributes.push(a);
          } } else if (key === 'extension_attributes') Object.assign(target.extension_attributes, value);
          else target[key] = value;
        }
      }
      if (hooks.afterWrite) await hooks.afterWrite(writes.at(-1));
      return response(true);
    };
    const options = { databasePool: pool, actorUserId, apply: true, fetchImpl,
      preview: (cfg, opts) => previewProduct(cfg, { ...opts, discover: async () => schema }) };
    const input = { sku, bindingRevisionId: published.id };
    return { input, options, product, writes, hooks, remote: () => remote, english: () => english, sources: () => sourceItems,
      enqueue: () => enqueue(config, input, options), apply: (job) => applyJob(config, job.id, options) };
  }

  await t.test('idempotent concurrent enqueue binds a single immutable exact plan and published revision', async () => {
    const s = await scenario(); const other = new Pool({ connectionString: TEST_DATABASE_URL });
    try {
      const jobs = await Promise.all([s.enqueue(), enqueue(config, s.input, { ...s.options, databasePool: other })]);
      assert.equal(jobs[0].id, jobs[1].id); assert.equal(s.writes.length, 0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM magento_sync_jobs WHERE sku=$1', [s.input.sku])).rows[0].n, 1);
      await assert.rejects(pool.query("UPDATE magento_sync_jobs SET intent='{}' WHERE id=$1", [jobs[0].id]), /immutable/);
      const notPublished = await makeDraft();
      await assert.rejects(enqueue(config, { ...s.input, bindingRevisionId: notPublished.id }, s.options), { code: 'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED' });
    } finally { await other.end(); }
  });
  await t.test('duplicate apply prevention uses independent connections and a real in-flight race', async () => {
    const s = await scenario(); const job = await s.enqueue();
    let release; let entered; const barrier = new Promise((r) => { entered = r; });
    const hold = new Promise((r) => { release = r; });
    s.hooks.beforeWrite = async () => { entered(); await hold; };
    const running = s.apply(job); await barrier;
    const other = new Pool({ connectionString: TEST_DATABASE_URL });
    try { await assert.rejects(applyJob(config, job.id, { ...s.options, databasePool: other }), { code: 'MAGENTO_SYNC_BUSY' }); }
    finally { release(); await other.end(); }
    const done = await running; assert.equal(done.state, 'succeeded', JSON.stringify(done.failure));
    assert.equal(s.remote().status, 1); assert.equal(s.remote().media_gallery_entries[0].id, 100);
    assert.equal(s.sources()[0].quantity, 0); assert.deepEqual(s.remote().extension_attributes.website_ids, [999, 801]);
    assert.equal(s.writes.length, 4); assert.ok(s.writes.every((w) => w.body.product?.status === undefined));
    const count = s.writes.length; assert.equal((await s.apply(job)).state, 'succeeded');
    assert.equal((await s.enqueue()).id, job.id); assert.equal(s.writes.length, count);
    assert.equal((await pool.query("SELECT count(*)::int n FROM magento_sync_steps WHERE job_id=$1 AND state='verified'", [job.id])).rows[0].n, 4);
  });
  await t.test('stale Amber state is blocked before any write and is retained as structured failure', async () => {
    const s = await scenario(); const job = await s.enqueue();
    await pool.query('UPDATE products SET weight=weight+1 WHERE id=$1', [s.product.id]);
    const r = await s.apply(job); assert.equal(r.state, 'blocked'); assert.equal(r.failure.code, 'MAGENTO_SYNC_AMBER_CHANGED'); assert.equal(s.writes.length, 0);
  });
  await t.test('explicit apply and current active actor authorization are required before dispatch', async () => {
    const s = await scenario(); const job = await s.enqueue();
    await assert.rejects(applyJob(config, job.id, { ...s.options, apply: false }), { code: 'MAGENTO_SYNC_APPLY_REQUIRED' });
    await assert.rejects(applyJob(config, job.id, { ...s.options, actorUserId: 999999999 }), { code: 'ADMIN_PERMISSION_REVOKED' });
    assert.equal(s.writes.length, 0);
    assert.equal((await pool.query('SELECT attempts FROM magento_sync_jobs WHERE id=$1', [job.id])).rows[0].attempts, 0);
  });
  await t.test('changed live identity/plan blocks dispatch even with an unchanged Amber row', async () => {
    const s = await scenario(); const job = await s.enqueue(); const old = schema.attributeSets[0].attribute_set_name;
    schema.attributeSets[0].attribute_set_name = 'Drift';
    try { const r = await s.apply(job); assert.equal(r.state, 'blocked'); assert.equal(s.writes.length, 0); }
    finally { schema.attributeSets[0].attribute_set_name = old; }
  });
  await t.test('read failure before dispatch is retryable and does not poison a safe later attempt', async () => {
    const s = await scenario(); const job = await s.enqueue(); s.hooks.readFailure = true;
    assert.equal((await s.apply(job)).state, 'retryable'); assert.equal(s.writes.length, 0);
    s.hooks.readFailure = false; assert.equal((await s.apply(job)).state, 'succeeded');
  });
  await t.test('remote changes that expand the bound plan block all writes at preflight', async () => {
    const s = await scenario();
    s.english().name = 'English name'; // Initially satisfied, therefore absent from the scoped write payload.
    const job = await s.enqueue(); s.english().name = 'Concurrent merchandising edit';
    const result = await s.apply(job); assert.equal(result.state, 'blocked');
    assert.equal(result.failure.code, 'MAGENTO_SYNC_REMOTE_STATE_CHANGED'); assert.equal(s.writes.length, 0);
  });
  await t.test('read-after-write mismatch is uncertain; retries never redispatch it or acknowledge success', async () => {
    const s = await scenario(); const job = await s.enqueue(); s.hooks.noMutation = true;
    const failed = await s.apply(job); assert.equal(failed.state, 'uncertain'); assert.equal(failed.failure.code, 'MAGENTO_SYNC_VERIFICATION_MISMATCH');
    assert.equal(failed.acknowledged_at, null); s.hooks.noMutation = false;
    assert.equal((await s.apply(job)).state, 'uncertain'); assert.equal(s.writes.length, 1);
  });
  await t.test('partial success and lost response recover only by GET verification, then continue unsent steps', async () => {
    const s = await scenario(); const job = await s.enqueue();
    s.hooks.afterWrite = async () => { s.hooks.readFailure = true; throw new Error('lost response'); };
    assert.equal((await s.apply(job)).state, 'uncertain'); assert.equal(s.writes.length, 1);
    s.hooks.afterWrite = null; s.hooks.readFailure = false;
    const done = await s.apply(job); assert.equal(done.state, 'succeeded', JSON.stringify(done.failure));
    assert.equal(s.writes.length, 4); assert.ok(done.acknowledged_at);
    assert.equal(s.writes.filter((w) => w.body.product?.name === 'Amber name').length, 1);
  });
  await t.test('CREATE starts disabled, verifies the exact SKU, initializes MSI once, and updates scoped fields last', async () => {
    const s = await scenario({ create: true }); const job = await s.enqueue();
    assert.equal(job.intent.operations[0].payload.product.status, 2);
    const done = await s.apply(job); assert.equal(done.state, 'succeeded', JSON.stringify(done.failure));
    assert.equal(s.remote().status, 2); assert.equal(s.sources()[0].quantity, 1); assert.equal(s.sources()[0].status, 1);
    assert.deepEqual(job.intent.operations.map((o) => o.domain), ['coreProduct', 'categories', 'inventory', 'websites', 'storeViews']);
    assert.equal(s.writes.at(-1).scope, 'en'); assert.equal(s.english().name, 'English name');
  });
  await t.test('a newer publication makes the old bound job ineligible before any write', async () => {
    const s = await scenario(); const job = await s.enqueue(); const newer = await makeDraft();
    await bindings.publishDraft(newer.id, { expectedRevision: newer.revision, expectedCurrentId: published.id }, mutations);
    const result = await s.apply(job);
    assert.equal(result.state, 'blocked'); assert.equal(result.failure.code, 'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED'); assert.equal(s.writes.length, 0);
  });
});
