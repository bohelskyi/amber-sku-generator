const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { Client, Pool } = require('pg');

test('attention confirmation timestamps require exact PostgreSQL delivery receipts and read models perform no business I/O', async (t) => {
  const databaseName = `amber_attention_receipts_${randomBytes(6).toString('hex')}_test`;
  assert.match(databaseName, /^amber_attention_receipts_[a-f0-9]{12}_test$/);
  const maintenance = new Client({ connectionString: 'postgresql://amber_test:amber_test_local_only@127.0.0.1:55432/amber_test', connectionTimeoutMillis: 3000 });
  await maintenance.connect(); let created = false, db;
  try {
    assert.equal((await maintenance.query('SELECT current_database() AS name')).rows[0].name, 'amber_test');
    await maintenance.query(`CREATE DATABASE "${databaseName}"`); created = true;
    process.env.DATABASE_URL = `postgresql://amber_test:amber_test_local_only@127.0.0.1:55432/${databaseName}`;
    require('../test/setup-env');
    t.mock.method(globalThis, 'fetch', () => assert.fail('Receipt projection must never call Magento or any external HTTP'));
    await require('../src/db/run-migrations').runMigrations();
    db = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 3000 });
    const c = require('../src/services/magento/binding-contract');
    const { runAccessAdminMutation } = require('../src/services/access-admin-transaction');
    const fullExport = require('../src/services/full-product-export.service');
    const config = { configured: true, baseUrl: 'https://attention-receipts-fixture.invalid' };
    const origin = c.originHash(config.baseUrl), otherOrigin = c.originHash('https://other-receipts-fixture.invalid');
    const installationKey = 'attention-receipts-fixture';
    const actorUserId = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Receipt fixture') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actorUserId]);
    for (const category of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']) await db.query('INSERT INTO categories(code,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [category]);
    const options = { databasePool: db, mutationContext: { actorUserId, requestId: 'attention-receipts-fixture' } };
    const fixture = require('../test/fixtures/magento-bindings');
    const definition = structuredClone(fixture.definition()); definition.sources = { sku: definition.sources.sku }; definition.tables = {};
    for (const group of definition.groups) for (const row of group.rows) row.cells = Object.fromEntries(Object.entries(row.cells)
      .filter(([key]) => ['sku', 'store_view_code', 'name', 'attribute_set_code', 'product_type', 'price'].includes(key)));
    const templates = require('../src/services/export-templates/template.service');
    const bindings = require('../src/services/magento/binding.service');
    const template = await templates.createTemplate({ key: `receipts-${randomUUID()}`, displayName: 'Timestamp fixture', definition }, options);
    const version = await templates.publishTemplate(template.id, { expectedRevision: template.draft.revision, expectedDefinitionHash: template.draft.definitionHash }, options);
    let draft = await bindings.createDraft({ installationKey, origin: config.baseUrl, templateVersionId: version.id,
      observedAt: '2026-10-01T12:00:00.000Z', schema: fixture.schema() }, options);
    draft = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: fixture.approvedBindings(definition) }, options);
    const publication = await bindings.publishDraft(draft.id, { expectedRevision: draft.revision, expectedCurrentId: null }, options);
    await db.query('UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key=$1,actor_user_id=$2 WHERE singleton', [installationKey, actorUserId]);
    assert.equal((await db.query('SELECT count(*)::int n FROM magento_sync_jobs')).rows[0].n, 0, 'Publication/activation alone must not create delivery jobs');
    const acknowledgedAt = '2026-09-01T10:11:12.345Z', observedAt = '2026-10-04T22:33:44.555Z';
    async function makeProduct() {
      return runAccessAdminMutation({ databasePool: db, actorUserId, requiredPermission: 'products.archive', createError: c.error,
        operation: async (client) => {
          const product = (await client.query(`INSERT INTO products(full_sku,category,total_price_uah,details)
            VALUES($1,'KL',240,'{"answers":{"weight":12.7}}') RETURNING *`, [`KL3/RECEIPT-${randomUUID()}`])).rows[0];
          await fullExport.initializeNewProduct(client, product.id);
          await client.query(`UPDATE magento_product_sync_requests SET desired_generation=10,synced_generation=10,state='synced',
            reason_code=NULL,updated_at=$2 WHERE public_product_identity_id=$1`, [product.public_product_identity_id, observedAt]);
          return product;
        } });
    }
    async function insertJob(product, fields = {}) {
      const state = fields.state || 'succeeded';
      await db.query(`INSERT INTO magento_sync_jobs(id,product_id,sku,installation_key,origin_hash,binding_revision_id,binding_hash,
        amber_hash,plan_hash,intent,baseline,state,remote_product_id,created_by_user_id,acknowledged_at,automatic_generation,public_product_identity_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$7,$7,'{}','{}',$8,42,$9,$10,$11,$12)`,
      [randomUUID(), fields.productId || product.id, product.full_sku, installationKey, fields.origin || origin, publication.id,
        c.hash(randomUUID()), state, actorUserId, state === 'succeeded' ? acknowledgedAt : null,
        Object.hasOwn(fields, 'generation') ? fields.generation : '10', fields.identityId || product.public_product_identity_id]);
    }
    const statuses = require('../src/services/magento/automatic-sync-status');
    const problems = require('../src/services/magento/sync-problems');
    const snapshot = async () => (await db.query(`SELECT
      (SELECT jsonb_agg(p ORDER BY id) FROM products p) AS products,
      (SELECT jsonb_agg(f ORDER BY product_id) FROM product_full_export_state f) AS lifecycle,
      (SELECT jsonb_agg(r ORDER BY public_product_identity_id) FROM magento_product_sync_requests r) AS requests,
      (SELECT jsonb_agg(j ORDER BY id) FROM magento_sync_jobs j) AS jobs,
      (SELECT count(*)::int FROM audit_events) AS audits`)).rows[0];
    async function check(product, expected, expectedState = 'synced') {
      const before = await snapshot();
      const client = await db.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const summary = (await statuses.readStatuses(client, [product.id])).get(product.id);
        const detail = await problems.problemDetail(config, product.id, client);
        for (const [name, projection] of [['summary', summary], ['detail', detail]]) {
          assert.equal(projection.state, expectedState);
          if (expected) assert.equal(new Date(projection.confirmedAt).toISOString(), expected,
            `${name}: confirmation must be the stored acknowledgement, never observed_at or current time`);
          else assert.equal(Object.hasOwn(projection, 'confirmedAt'), false, `${name}: no matching receipt must expose no confirmation timestamp`);
        }
        assert.equal(new Date(detail.observedAt).toISOString(), observedAt, 'Observation stays separate from confirmation');
        await client.query('COMMIT');
      } finally { await client.query('ROLLBACK'); client.release(); }
      assert.deepEqual(await snapshot(), before, 'Status/detail reads must not create jobs, update products/requests, or write audits');
    }
    await t.test('exact product, immutable public identity, current generation and published installation origin return stored acknowledgement', async () => {
      const product = await makeProduct(); await insertJob(product); await check(product, acknowledgedAt);
    });
    for (const scenario of [
      ['old automatic generation', { generation: '9' }],
      ['different Magento origin', { origin: otherOrigin }],
      ['manual acknowledgement without automatic generation', { generation: null }],
      ['queued job without succeeded acknowledgement', { state: 'queued' }],
    ]) await t.test(`${scenario[0]} cannot confirm a synced request`, async () => {
      const product = await makeProduct(); await insertJob(product, scenario[1]); await check(product, null);
    });
    await t.test('another product sharing the requested public identity cannot donate its acknowledgement', async () => {
      const product = await makeProduct(), other = await makeProduct(); await insertJob(product, { productId: other.id }); await check(product, null);
    });
    await t.test('another public identity on the requested product cannot donate its acknowledgement', async () => {
      const product = await makeProduct(), other = await makeProduct(); await insertJob(product, { identityId: other.public_product_identity_id }); await check(product, null);
    });
    await t.test('fresh observed_at and current clock with no receipt are never confirmations', async () => {
      const product = await makeProduct(); await check(product, null);
    });
    for (const state of ['pending', 'needs_attention']) await t.test(`${state} hides a matching older delivery receipt`, async () => {
      const product = await makeProduct(); await insertJob(product);
      await db.query('UPDATE magento_product_sync_requests SET state=$2 WHERE public_product_identity_id=$1', [product.public_product_identity_id, state]);
      await check(product, null, state);
    });
    await t.test('an installation without a published binding exposes no timestamp and restoring current publication restores the exact receipt', async () => {
      const product = await makeProduct(); await insertJob(product);
      await db.query("UPDATE magento_auto_sync_activation SET installation_key='unpublished-fixture' WHERE singleton");
      await check(product, null);
      await db.query('UPDATE magento_auto_sync_activation SET installation_key=$1 WHERE singleton', [installationKey]);
      await check(product, acknowledgedAt);
    });
    await t.test('a request carrying a different public identity cannot borrow this product acknowledgement', async () => {
      const product = await makeProduct(), other = await makeProduct(); await insertJob(product);
      await db.query('DELETE FROM magento_product_sync_requests WHERE public_product_identity_id=$1', [other.public_product_identity_id]);
      await db.query('UPDATE magento_product_sync_requests SET public_product_identity_id=$2 WHERE product_id=$1', [product.id, other.public_product_identity_id]);
      await check(product, null);
    });
  } finally {
    if (db) await db.end();
    if (created) {
      await require('../src/db/pool').end();
      await maintenance.query(`DROP DATABASE "${databaseName}"`);
    }
    await maintenance.end();
  }
});
