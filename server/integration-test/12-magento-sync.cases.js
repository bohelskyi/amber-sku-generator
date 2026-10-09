const suite = require('./suite-context');
const { test, assert, pool, Pool, TEST_DATABASE_URL, authenticateApplicationSession, crypto } = suite;
const { insertProductFixture } = require('./product-fixture');
const bindings = require('../src/services/magento/binding.service');
const templates = require('../src/services/export-templates/template.service');
const fixture = require('../test/fixtures/magento-bindings');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { previewProduct, planPreview } = require('../src/services/magento/sync-preview');
const syncPlan = require('../src/services/magento/sync-job-plan');
const { hash } = require('../src/services/magento/binding-contract');
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
  const d = structuredClone(fixture.definition()); d.sources = { sku: d.sources.sku,
    price: { kind: 'product', field: 'total_price_uah', type: 'scalar' } }; d.tables = {};
  for (const g of d.groups) for (const row of g.rows) {
    const sku = row.cells.sku;
    row.cells = { sku, name: literal(row.id === 'base' ? 'Amber name' : 'English name'),
      attribute_set_code: literal('Historical CSV name'), product_type: literal('simple'), store_view_code: literal(row.id === 'base' ? '' : 'en') };
    if (row.id === 'base') Object.assign(row.cells, { price: { op: 'text', input: { op: 'source', id: 'price' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' }, product_online: literal('2'), visibility: literal('Catalog, Search'),
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

  async function scenario({ create = false, initialLinks = [] } = {}) {
    const sku = `BR/SYNC-${crypto.randomUUID()}`.toUpperCase();
    const insert = `INSERT INTO products
      (full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details)
      VALUES ($1,$1,0,'BR',5,10,42,2,40,'{"answers":{}}') RETURNING id,public_product_identity_id`;
    let product;
    if (create) product = (await insertProductFixture(pool, insert, [sku])).rows[0];
    else {
      // Seed a synthetic historical external-delivery snapshot, not a live command.
      // Ordinary UPDATE tests must not infer prior delivery from the name baseline.
      const client = await pool.connect(), gate = require('../src/services/full-product-cutover-gate');
      try {
        await gate.begin(client, 'BEGIN');
        product = (await client.query(insert, [sku])).rows[0];
        const audit = await require('../src/audit/audit-events').writeAuditEvent(client, {
          mutationContext: {actorUserId,requestId:'sync-fixture-prior-delivery'},
          eventKey:'product.external_delivery_acknowledged',subjectType:'product',subjectId:product.id,
          details:{fixture:true,fullRevision:'1',deliveryVersionBefore:'1',routeBefore:'normal',
            externalDeliverySemantic:true,snapshotConfirmationClaimed:false,payloadEqualityClaimed:false,
            automaticSyncSuccessClaimed:false,planHash:hash({fixture:'ordinary-sync-prior-delivery',productId:product.id,sku}),
            publicSku:sku,remote:{originHash:require('../src/services/magento/binding-contract').originHash(config.baseUrl),
              productId:product.id+100000,sku}} });
        await client.query(`INSERT INTO product_full_export_state(product_id,route,evidence,
          externally_delivered_revision,externally_delivered_event_id)
          VALUES($1,'normal','{"origin":"ordinary_save","fixture":true}'::jsonb,1,$2)`, [product.id,audit.id]);
        await gate.commit(client);
      } catch (cause) {await gate.rollback(client);throw cause;}
      finally {await gate.release(client);client.release();}
    }
    await pool.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1", [product.id]);
    const initial = { id: product.id + 100000, sku, attribute_set_id: 8001, name: 'Old name', type_id: 'simple', price: 40,
      status: 1, visibility: 4, custom_attributes: [{ attribute_code: 'unknown_attribute', value: 'Keep me' }], media_gallery_entries: [{ id: 100 }],
      extension_attributes: { category_links: initialLinks, website_ids: [999] } };
    let remote = create ? null : structuredClone(initial);
    let english = create ? null : { ...structuredClone(initial), name: 'Old English', custom_attributes: [{ attribute_code: 'meta_title', value: 'Old SEO' }] };
    let sourceItems = create ? [] : [{ sku, source_code: 'default', quantity: 0, status: 0 }];
    if (!create) await require('../src/services/magento/name-state').saveObservation(pool,
      require('../src/services/magento/binding-contract').originHash(config.baseUrl), product, initial.id,
      { action: 'confirm', amber: { all: 'Old name', en: 'Old English' }, remote: { all: 'Old name', en: 'Old English' } },
      { all: 'Old name', en: 'Old English' });
    const writes = []; const hooks = {};
    const response = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const fetchImpl = async (url, init) => {
      const u = new URL(url); const route = u.pathname.split('/V1/')[1];
      if (init.method === 'GET') {
        if (hooks.beforeRead) await hooks.beforeRead(route);
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
      assert.ok(['POST', 'DELETE'].includes(init.method)); assert.equal(init.redirect, 'manual');
      const body = init.body ? JSON.parse(init.body) : null;
      writes.push({ route, method: init.method, scope: u.pathname.split('/')[2], body });
      if (hooks.beforeWrite) await hooks.beforeWrite(writes.at(-1));
      if (hooks.noMutation) return response(true);
      if (hooks.noCategoryMutation && route.startsWith('categories/')) return response(true);
      if (route.startsWith('categories/')) {
        const categoryId = route.split('/')[1];
        if (init.method === 'DELETE') remote.extension_attributes.category_links = remote.extension_attributes.category_links
          .filter((link) => link.category_id !== categoryId);
        else {
          assert.equal(body.productLink.category_id, categoryId);
          remote.extension_attributes.category_links = remote.extension_attributes.category_links
            .filter((link) => link.category_id !== categoryId);
          remote.extension_attributes.category_links.push({ category_id: categoryId, position: body.productLink.position });
        }
      } else if (route === 'inventory/source-items') sourceItems = body.sourceItems;
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

  await require('./magento-manual-boundary-cases')({ t, suite, scenario, config, installationKey, actorUserId });

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
  await t.test('queued UPDATE replays required native timestamps omitted from its immutable baseline', async () => {
    const previousSchema = structuredClone(schema);
    for (const [index, code] of ['created_at', 'updated_at'].entries()) {
      schema.attributes.push({ attribute_code: code, attribute_id: 1201 + index, scope: 'global',
        frontend_input: 'date', is_required: true, apply_to: [], options: [] });
      schema.attributeSets[0].attributeCodes.push(code);
    }
    const createdAt = '2026-09-11 10:11:29'; const updatedAt = '2026-09-22 09:43:19';
    try {
      for (const variant of ['unchanged', 'resume', 'created_changed', 'created_missing', 'updated_missing']) {
        const s = await scenario();
        Object.assign(s.remote(), { created_at: createdAt, updated_at: updatedAt });
        // As in the real UPDATE, membership and inventory already need no write.
        s.remote().extension_attributes.website_ids.push(801);
        const job = await s.enqueue();
        assert.equal(job.state, 'queued'); assert.equal(s.writes.length, 0);
        assert.deepEqual(job.intent.operations.map((o) => o.domain), ['coreProduct', 'categoryLinkSave', 'storeViews']);
        assert.equal(job.baseline.raw.created_at, undefined); assert.equal(job.baseline.raw.updated_at, undefined);
        assert.equal(job.baseline.preservation['native.created_at'], hash(createdAt));
        assert.equal(job.baseline.preservation['native.updated_at'], undefined);
        let observation;
        const fresh = await s.options.preview(config, { ...s.options, sku: s.input.sku,
          bindingRevisionId: published.id, onObservation: (value) => { observation = value; } });
        assert.equal(fresh.sendable, true, JSON.stringify(fresh.blockers));
        assert.equal(hash(syncPlan.intent(fresh)), job.plan_hash);
        const minimized = planPreview(observation.amber, observation.schema, job.baseline.raw,
          observation.categoryNodes, { domainEvidence: job.baseline.domainEvidence });
        assert.deepEqual(minimized.blockers, ['created_at', 'updated_at'].map((target) => ({
          code: 'REQUIRED_ATTRIBUTE_VALUE_MISSING', operation: 'coreProduct', target,
        })));
        if (variant === 'created_changed') s.remote().created_at = '2026-09-12 10:11:29';
        if (variant === 'created_missing') delete s.remote().created_at;
        if (variant === 'updated_missing') delete s.remote().updated_at;
        // A repository save advances this Magento-owned field between partial steps.
        s.hooks.afterWrite = async () => {
          s.remote().updated_at = '2026-09-28 00:00:01';
          if (variant === 'resume') { s.hooks.readFailure = true; throw new Error('lost response'); }
        };
        let result = await s.apply(job);
        if (variant === 'resume') {
          assert.equal(result.state, 'uncertain'); assert.equal(s.writes.length, 1);
          s.hooks.afterWrite = null; s.hooks.readFailure = false;
          result = await s.apply(job);
        }
        if (['unchanged', 'resume'].includes(variant)) {
          assert.equal(result.state, 'succeeded', JSON.stringify(result.failure));
          assert.equal(s.remote().created_at, createdAt); assert.equal(s.remote().updated_at, '2026-09-28 00:00:01');
          assert.equal(s.writes.length, 3);
          assert.ok(s.writes.every((w) => w.body.product?.created_at === undefined && w.body.product?.updated_at === undefined));
        } else {
          assert.equal(result.state, 'blocked'); assert.equal(s.writes.length, 0);
          assert.equal(result.failure.code, variant === 'updated_missing'
            ? 'MAGENTO_SYNC_PLAN_NOT_SENDABLE' : 'MAGENTO_SYNC_PRESERVED_FIELD_CHANGED');
          assert.equal((await pool.query('SELECT count(*)::int n FROM magento_sync_steps WHERE job_id=$1', [job.id])).rows[0].n, 0);
        }
        const stored = (await pool.query('SELECT * FROM magento_sync_jobs WHERE id=$1', [job.id])).rows[0];
        assert.deepEqual(stored.intent, job.intent); assert.deepEqual(stored.baseline, job.baseline);
        assert.equal(stored.plan_hash, job.plan_hash); assert.equal(stored.binding_hash, job.binding_hash);
        assert.equal(stored.amber_hash, job.amber_hash);
      }
    } finally { Object.assign(schema, previousSchema); }
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
    await pool.query("UPDATE magento_name_sync_states SET baseline_names=jsonb_set(baseline_names,'{en}','\"English name\"') WHERE public_product_identity_id=$1", [s.product.public_product_identity_id]);
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
  await t.test('category replacement has independent dispatch steps and an unresolved removal blocks the later add', async () => {
    const s = await scenario({ initialLinks: [{ category_id: '375', position: 0 }] });
    const job = await s.enqueue();
    assert.deepEqual(job.intent.operations.map((o) => o.domain),
      ['coreProduct', 'categoryLinkDelete', 'categoryLinkSave', 'websites', 'storeViews']);
    s.hooks.noCategoryMutation = true;
    let result = await s.apply(job);
    assert.equal(result.state, 'uncertain');
    assert.equal(result.failure.code, 'MAGENTO_SYNC_VERIFICATION_MISMATCH');
    assert.equal(result.failure.ordinal, 1);
    assert.deepEqual(s.writes.map((w) => w.method), ['POST', 'DELETE']);
    let steps = (await pool.query('SELECT ordinal,state FROM magento_sync_steps WHERE job_id=$1 ORDER BY ordinal', [job.id])).rows;
    assert.deepEqual(steps.map((v) => [v.ordinal, v.state]), [[0, 'verified'], [1, 'dispatched']]);
    s.hooks.noCategoryMutation = false;
    result = await s.apply(job);
    assert.equal(result.state, 'uncertain');
    assert.equal(s.writes.length, 2, 'unresolved deletion is never resent and the add is not dispatched');
    assert.deepEqual(s.remote().extension_attributes.category_links, [{ category_id: '375', position: 0 }]);
    s.remote().extension_attributes.category_links = []; // Operator reconciliation in a disposable fake only.
    result = await s.apply(job);
    assert.equal(result.state, 'succeeded', JSON.stringify(result.failure));
    assert.deepEqual(s.remote().extension_attributes.category_links, [{ category_id: '9001', position: 0 }]);
    steps = (await pool.query('SELECT ordinal,state FROM magento_sync_steps WHERE job_id=$1 ORDER BY ordinal', [job.id])).rows;
    assert.deepEqual(steps.map((v) => [v.ordinal, v.state]),
      [[0, 'verified'], [1, 'verified'], [2, 'verified'], [3, 'verified'], [4, 'verified']]);
    assert.equal(s.writes.filter((w) => w.method === 'DELETE').length, 1);
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
    assert.deepEqual(job.intent.operations.map((o) => o.domain), ['coreProduct', 'categoryLinkSave', 'inventory', 'websites', 'storeViews']);
    assert.equal(s.writes.at(-1).scope, 'en'); assert.equal(s.english().name, 'English name');
  });
  await t.test('acceptance shared names establish CREATE common baseline and discover external edits without Magento writes', async () => {
    await pool.query('UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2', [installationKey, actorUserId]);
    try {
      const s = await scenario({ create: true });
      const worker = require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(config, { databasePool: pool, jobOptions: s.options });
      const state = async () => (await pool.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1', [s.product.id])).rows[0];
      const nameState = async () => (await pool.query('SELECT * FROM magento_name_sync_states WHERE public_product_identity_id=$1', [s.product.public_product_identity_id])).rows[0];
      await worker.runProduct(s.product.public_product_identity_id);
      assert.equal((await state()).state, 'synced');
      assert.deepEqual((await nameState()).baseline_names, { all: 'Amber name', en: 'English name' });
      s.remote().name = 'Назва з Magento без відновлюваних підметів'; s.english().name = 'External English name';
      const writes = s.writes.length; let gets = 0;
      const discovery = require('../src/services/magento/name-discovery').createNameDiscovery(config, { databasePool: pool,
        fetchImpl: async (...args) => { assert.equal(args[1].method, 'GET'); gets++; return s.options.fetchImpl(...args); }, batchSize: 1 });
      const origin = require('../src/services/magento/binding-contract').originHash(config.baseUrl);
      await pool.query(`INSERT INTO magento_name_discovery_cursors(origin_hash,after_identity_id) VALUES($1,$2)
        ON CONFLICT(origin_hash) DO UPDATE SET after_identity_id=$2,next_scan_at=CURRENT_TIMESTAMP`, [origin, Number(s.product.public_product_identity_id)-1]);
      await discovery.tick();
      assert.equal(gets, 2); assert.equal(s.writes.length, writes);
      assert.deepEqual((await nameState()).baseline_names, { all: s.remote().name, en: s.english().name });
      const imported = (await pool.query('SELECT magento_name_override,magento_name_subject_ua FROM products WHERE id=$1', [s.product.id])).rows[0];
      assert.equal(imported.magento_name_override.values.all, s.remote().name); assert.equal(imported.magento_name_subject_ua, null);
      await discovery.tick(); assert.equal(gets, 2, 'durable due time bounds repeated/restarted scans');
      const importedVersion = (await nameState()).version;
      await pool.query('UPDATE magento_name_discovery_cursors SET after_identity_id=$2,next_scan_at=CURRENT_TIMESTAMP WHERE origin_hash=$1',
        [origin, Number(s.product.public_product_identity_id)-1]);
      await discovery.tick();
      assert.equal((await nameState()).version, importedVersion, 'equal name observations do not create false preview staleness');
      const restarted = require('../src/services/magento/name-discovery').createNameDiscovery(config, { databasePool: pool,
        fetchImpl: async () => { throw new Error('restart must honor durable due time'); } });
      await restarted.tick();
      const productNames = require('../src/services/magento/product-names.service');
      const editOptions = { ...s.options, config, mutationContext: { actorUserId, requestId: 'exact-name-edit' } };
      const currentNames = await productNames.read(s.product.id, editOptions);
      assert.deepEqual(currentNames.names, { all: s.remote().name, en: s.english().name });
      assert.deepEqual(Object.keys(currentNames).sort(), ['nameConflict', 'names', 'previewToken', 'productId']);
      await assert.rejects(productNames.save({ productId: s.product.id, names: { all: '', en: 'English' },
        previewToken: currentNames.previewToken }, editOptions), { code: 'PRODUCT_NAMES_INVALID' });
      await assert.rejects(productNames.save({ productId: s.product.id, names: { all: 'Denied', en: 'Denied EN' },
        previewToken: currentNames.previewToken }, { ...editOptions, mutationContext: { actorUserId: 999999999 } }), { code: 'ADMIN_PERMISSION_REVOKED' });
      const editWrites = s.writes.length; const commonBeforeEdit = (await nameState()).baseline_names;
      await productNames.save({ productId: s.product.id, names: { all: 'Amber changed', en: 'Exact Amber English' },
        previewToken: currentNames.previewToken }, editOptions);
      assert.equal((await state()).state, 'pending'); assert.equal(s.writes.length, editWrites);
      assert.deepEqual((await nameState()).baseline_names, commonBeforeEdit, 'local edit cannot confirm the remote baseline');
      assert.equal((await pool.query('SELECT magento_name_subject_ua FROM products WHERE id=$1', [s.product.id])).rows[0].magento_name_subject_ua, null);
      await assert.rejects(productNames.save({ productId: s.product.id, names: { all: 'Stale', en: 'Stale EN' },
        previewToken: currentNames.previewToken }, editOptions), { code: 'PRODUCT_NAMES_STALE' });
      await worker.runProduct(s.product.public_product_identity_id);
      assert.equal((await state()).state, 'synced'); assert.equal(s.remote().name, 'Amber changed');
      assert.equal(s.english().name, 'Exact Amber English');
      assert.equal((await nameState()).baseline_names.all, 'Amber changed');
      await pool.query(`UPDATE products SET magento_name_override=jsonb_set(magento_name_override,'{values,all}','"Concurrent Amber"') WHERE id=$1`, [s.product.id]);
      s.remote().name = 'Concurrent Magento'; const beforeConflict = s.writes.length;
      await worker.runProduct(s.product.public_product_identity_id);
      assert.equal((await state()).state, 'needs_attention'); assert.equal((await nameState()).state, 'conflict');
      assert.equal(s.writes.length, beforeConflict); assert.equal(s.remote().name, 'Concurrent Magento');
      const conflictingNames = await productNames.read(s.product.id, editOptions);
      await productNames.save({ productId: s.product.id, names: { ...conflictingNames.names, en: 'Edited while conflicting' },
        previewToken: conflictingNames.previewToken }, editOptions);
      await worker.runProduct(s.product.public_product_identity_id);
      assert.equal((await nameState()).state, 'conflict'); assert.equal((await state()).state, 'needs_attention');
      assert.equal(s.writes.length, beforeConflict, 'ordinary name editing never approves a conflict');
      const resolution = require('../src/services/magento/name-resolution.service');
      const options = { ...s.options, config, mutationContext: { actorUserId, requestId: 'name-resolution-test' } };
      const preview = await resolution.preview({ productId: s.product.id, choice: 'amber' }, options);
      s.remote().name = 'Later Magento';
      await assert.rejects(resolution.apply({ productId: s.product.id, choice: 'amber', previewToken: preview.previewToken }, options), { code: 'MAGENTO_NAME_PREVIEW_STALE' });
      const fresh = await resolution.preview({ productId: s.product.id, choice: 'amber' }, options);
      await resolution.apply({ productId: s.product.id, choice: 'amber', previewToken: fresh.previewToken }, options);
      assert.equal(s.writes.length, beforeConflict, 'review itself never mutates Magento');
      await worker.runProduct(s.product.public_product_identity_id);
      assert.equal((await state()).state, 'synced'); assert.equal(s.remote().name, 'Concurrent Amber');
      assert.equal((await nameState()).baseline_names.all, 'Concurrent Amber');
      await pool.query(`UPDATE products SET magento_name_override=jsonb_set(magento_name_override,'{values,all}','"Both chose Amber"') WHERE id=$1`, [s.product.id]);
      s.remote().name = 'Different remote'; await worker.runProduct(s.product.public_product_identity_id);
      assert.equal((await state()).state, 'needs_attention');
      s.remote().name = 'Both chose Amber'; const beforeEqual = s.writes.length;
      await pool.query('UPDATE magento_name_discovery_cursors SET after_identity_id=$2,next_scan_at=CURRENT_TIMESTAMP WHERE origin_hash=$1',
        [origin, Number(s.product.public_product_identity_id)-1]);
      await discovery.tick();
      assert.equal((await nameState()).state, 'common'); assert.equal((await state()).state, 'pending');
      assert.equal(s.writes.length, beforeEqual, 'equal discovery resolves the blocker without a Magento mutation');
      await worker.runProduct(s.product.public_product_identity_id); assert.equal((await state()).state, 'synced');
      const unknown = await scenario();
      await pool.query('DELETE FROM magento_name_sync_states WHERE public_product_identity_id=$1', [unknown.product.public_product_identity_id]);
      const unknownWorker = require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(config,
        { databasePool: pool, jobOptions: unknown.options });
      await unknownWorker.runProduct(unknown.product.public_product_identity_id);
      assert.equal((await pool.query('SELECT state FROM magento_name_sync_states WHERE public_product_identity_id=$1', [unknown.product.public_product_identity_id])).rows[0].state, 'baseline_required');
      unknown.remote().name = 'Amber name'; unknown.english().name = 'English name';
      await pool.query('UPDATE magento_name_discovery_cursors SET after_identity_id=$2,next_scan_at=CURRENT_TIMESTAMP WHERE origin_hash=$1',
        [origin, Number(unknown.product.public_product_identity_id)-1]);
      await require('../src/services/magento/name-discovery').createNameDiscovery(config, { databasePool: pool,
        fetchImpl: unknown.options.fetchImpl, batchSize: 1 }).tick();
      assert.equal(unknown.writes.length, 0);
      assert.equal((await pool.query('SELECT state FROM magento_product_sync_requests WHERE product_id=$1', [unknown.product.id])).rows[0].state, 'pending');
      await unknownWorker.runProduct(unknown.product.public_product_identity_id);
      assert.equal((await pool.query('SELECT state FROM magento_product_sync_requests WHERE product_id=$1', [unknown.product.id])).rows[0].state, 'synced');
      const uncertain = await scenario();
      uncertain.hooks.afterWrite = async () => { uncertain.hooks.readFailure = true; throw new Error('lost response'); };
      const uncertainWorker = require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(config,
        { databasePool: pool, jobOptions: uncertain.options });
      await uncertainWorker.runProduct(uncertain.product.public_product_identity_id);
      assert.equal((await pool.query('SELECT reason_code FROM magento_product_sync_requests WHERE product_id=$1', [uncertain.product.id])).rows[0].reason_code, 'reconciliation_required');
      await pool.query('UPDATE magento_name_discovery_cursors SET after_identity_id=$2,next_scan_at=CURRENT_TIMESTAMP WHERE origin_hash=$1',
        [origin, Number(uncertain.product.public_product_identity_id)-1]);
      let unsafeReads = 0;
      await require('../src/services/magento/name-discovery').createNameDiscovery(config, { databasePool: pool,
        fetchImpl: async () => { unsafeReads++; throw new Error('uncertain work must not be rediscovered'); }, batchSize: 1 }).tick();
      assert.equal(unsafeReads, 0);
      await assert.rejects(resolution.preview({ productId: uncertain.product.id, choice: 'amber' },
        { ...uncertain.options, config }), { code: 'MAGENTO_SYNC_PREVIOUS_DISPATCH_UNRESOLVED' });
      const uncertainOptions = { ...uncertain.options, config, mutationContext: { actorUserId } };
      const uncertainNames = await productNames.read(uncertain.product.id, uncertainOptions);
      const uncertainWrites = uncertain.writes.length;
      await productNames.save({ productId: uncertain.product.id, names: { ...uncertainNames.names, all: 'Local change while uncertain' },
        previewToken: uncertainNames.previewToken }, uncertainOptions);
      await uncertainWorker.runProduct(uncertain.product.public_product_identity_id);
      assert.equal(uncertain.writes.length, uncertainWrites);
      assert.equal((await pool.query('SELECT reason_code FROM magento_product_sync_requests WHERE product_id=$1', [uncertain.product.id])).rows[0].reason_code, 'reconciliation_required');
    } finally { await pool.query('UPDATE magento_auto_sync_activation SET enabled=FALSE'); }
  });
  await require('./magento-automatic-worker-cases')({ t, suite, scenario, config, published, installationKey, actorUserId, makeDraft });
  await require('./magento-recovery-cases')({ t, suite, scenario, config });
  await t.test('a newer publication makes the old bound job ineligible before any write', async () => {
    const s = await scenario(); const job = await s.enqueue(); const newer = await makeDraft();
    await pool.query('UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2', [installationKey, actorUserId]);
    const automaticProduct = await scenario();
    const automaticJob = await enqueue(config, automaticProduct.input, { ...automaticProduct.options,
      automatic: { publicIdentityId: automaticProduct.product.public_product_identity_id,
        productId: automaticProduct.product.id, generation: '1', installationKey } });
    let release, entered;
    const arrived = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    s.hooks.beforeRead = async () => { s.hooks.beforeRead = null; entered(); await hold; };
    const applying = s.apply(job);
    await arrived;
    const publisher = new Pool({ connectionString: TEST_DATABASE_URL, statement_timeout: 2000 });
    let current;
    try {
      current = await bindings.publishDraft(newer.id, { expectedRevision: newer.revision, expectedCurrentId: published.id },
        { ...mutations, databasePool: publisher });
    } finally { release(); await publisher.end(); }
    const result = await applying;
    assert.equal(result.state, 'blocked'); assert.equal(result.failure.code, 'MAGENTO_SYNC_PUBLISHED_CURRENT_BINDING_REQUIRED'); assert.equal(s.writes.length, 0);
    try {
      const worker = require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(config,
        { databasePool: pool, jobOptions: automaticProduct.options });
      await worker.runProduct(automaticProduct.product.public_product_identity_id);
      const rows = (await pool.query('SELECT id,state,binding_revision_id FROM magento_sync_jobs WHERE product_id=$1 ORDER BY created_at', [automaticProduct.product.id])).rows;
      assert.equal(rows[0].id, automaticJob.id); assert.equal(rows[0].state, 'superseded');
      assert.equal(rows[1].state, 'succeeded'); assert.equal(rows[1].binding_revision_id, current.id);
    } finally { await pool.query('UPDATE magento_auto_sync_activation SET enabled=FALSE'); }
  });
});
