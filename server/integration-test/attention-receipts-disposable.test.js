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
    async function makeProduct(category = 'KL') {
      return runAccessAdminMutation({ databasePool: db, actorUserId, requiredPermission: 'products.archive', createError: c.error,
        operation: async (client) => {
          const product = (await client.query(`INSERT INTO products(full_sku,category,total_price_uah,details)
            VALUES($1,$2,240,'{"answers":{"weight":12.7}}') RETURNING *`, [`${category}3/RECEIPT-${randomUUID()}`, category])).rows[0];
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
    await t.test('cause groups count the whole queue, distinguish semantic identities and read exact bounded members without writes', async () => {
      const groups = require('../src/services/magento/problem-groups');
      const beforeGroups = await groups.groupPage(config, {}, db);
      const products = await Promise.all([makeProduct(), makeProduct(), makeProduct(), makeProduct()]);
      const context = value => ({ kind: 'semantic_option', bindingRevisionId: publication.id, category: 'KL',
        routeKey: 'KL.base', target: 'color', question: 'ux-color', value });
      const mapping = value => ({ code: 'OPTION_BINDING_REVIEW_REQUIRED', target: 'color', question: 'ux-color', value,
        causeContext: context(value) });
      const diagnostics = [[mapping('0'), mapping('0'), { code: 'FIRST_SYNC_FIELD_CONFLICT', target: 'weight', scope: 'all' }],
        [mapping('0')], [mapping('1')], [{ code: 'OPTION_BINDING_REVIEW_REQUIRED', target: 'color', question: 'ux-color', value: '0' }]];
      const placements = [
        { path: 'Прикраси/Кулони', routeKey: 'KL.base' },
        { path: 'Прикраси/Кулони', routeKey: 'KL.base' },
        { path: 'Подарунки/Кулони', routeKey: 'KL.base' },
        { path: 'Прикраси/Кулони', routeKey: 'KL.gifts' },
      ];
      diagnostics.forEach((entries, index) => entries.push({ code: 'CATEGORY_PATH_MISSING', target: 'categories', ...placements[index] }));
      for (const [index, product] of products.entries()) await db.query(`UPDATE magento_product_sync_requests SET state='needs_attention',
        reason_code='data_or_binding',diagnostics=$2::jsonb WHERE product_id=$1`, [product.id, JSON.stringify(diagnostics[index])]);
      const before = await snapshot();
      const client = await db.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const all = await groups.groupPage(config, { limit: 100 }, client);
        assert.equal(all.summary.productCount, beforeGroups.summary.productCount + 4, 'Each product counts once across causes');
        const zero = all.items.find(group => group.problem.causeContext?.value === '0');
        const one = all.items.find(group => group.problem.causeContext?.value === '1');
        assert.equal(zero.productCount, 2); assert.equal(zero.diagnosticCount, 3);
        const firstProduct = products.slice(0, 2).sort((left, right) => left.id - right.id)[0];
        assert.deepEqual(zero.exampleProduct, { productId: firstProduct.id, article: firstProduct.full_sku, category: 'KL' },
          'Selecting a sample separately preserves the first-product API contract');
        assert.equal(zero.sharedConfiguration, true); assert.notEqual(zero.id, one.id);
        const legacy = all.items.find(group => group.problem.code === 'OPTION_BINDING_REVIEW_REQUIRED' && !group.problem.causeContext);
        assert.equal(legacy.sharedConfiguration, false); assert.equal(legacy.productCount, 1);
        const placementGroups = all.items.filter(group => group.problem.code === 'CATEGORY_PATH_MISSING');
        assert.equal(placementGroups.length, 3, 'Different target paths or routes never share a sampled repair destination');
        assert.deepEqual(placementGroups.map(group => group.productCount).sort(), [1, 1, 2]);
        assert.equal(new Set(placementGroups.map(group => group.id)).size, 3);
        for (const group of placementGroups) {
          assert.equal(group.sharedConfiguration, false, 'Path evidence does not invent semantic source provenance');
          const page = await groups.groupProducts(config, group.id, {}, client);
          assert.equal(page.items.every(member => member.groupProblem.path === group.problem.path && member.groupProblem.routeKey === group.problem.routeKey), true);
        }
        const page = await groups.groupPage(config, { limit: 1 }, client);
        assert.equal(page.items.length, 1); assert.equal(page.summary.productCount, all.summary.productCount);
        assert.equal(page.pageInfo.total, all.pageInfo.total);
        const members = await groups.groupProducts(config, zero.id, { limit: 1 }, client);
        const next = await groups.groupProducts(config, zero.id, { limit: 1, offset: 1 }, client);
        assert.equal(members.pageInfo.total, 2); assert.equal(members.pageInfo.hasNext, true);
        assert.deepEqual(new Set([members.items[0].productId, next.items[0].productId]), new Set(products.slice(0, 2).map(product => product.id)));
        assert.equal(members.items[0].groupProblem.value, '0');
        assert.equal((await groups.groupPage(config, { search: '%_' }, client)).summary.productCount, 0);
        await client.query('COMMIT');
      } finally { await client.query('ROLLBACK'); client.release(); }
      assert.deepEqual(await snapshot(), before, 'Grouping never changes requests, products, jobs or receipts');
    });
    await t.test('category facets ignore all filters and reason counts ignore only the selected reason', async () => {
      const groups = require('../src/services/magento/problem-groups');
      const selected = await makeProduct('BR'), otherReason = await makeProduct('BR'), otherCategory = await makeProduct('CH');
      for (const [product, diagnostics] of [
        [selected, [{ code: 'PRODUCT_EVALUATION_NOT_READY' }, { code: 'OPTION_BINDING_REVIEW_REQUIRED', target: 'color' }]],
        [otherReason, [{ code: 'authorization' }]],
        [otherCategory, [{ code: 'NAME_CONFLICT' }]],
      ]) await db.query(`UPDATE magento_product_sync_requests SET state='needs_attention',reason_code='data_or_binding',
        diagnostics=$2::jsonb WHERE product_id=$1`, [product.id, JSON.stringify(diagnostics)]);
      const before = await snapshot();
      const client = await db.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const all = await groups.groupPage(config, { limit: 100 }, client);
        const category = await groups.groupPage(config, { category: 'BR' }, client);
        assert.deepEqual(category.categories, all.categories, 'Selecting BR keeps CH and KL available with their global counts');
        assert.deepEqual(category.categories.map(item => item.code), ['BR', 'CH', 'KL']);
        assert.equal(category.summary.productCount, 2);
        assert.deepEqual(category.summary.reasonCounts, [
          { reason: 'connection', count: 1 }, { reason: 'integration', count: 1 }, { reason: 'product', count: 1 },
        ]);
        const reason = await groups.groupPage(config, { category: 'BR', reason: 'product' }, client);
        assert.deepEqual(reason.categories, all.categories);
        assert.deepEqual(reason.summary.reasonCounts, category.summary.reasonCounts, 'Reason selection does not hide the other available reasons');
        assert.equal(reason.summary.productCount, 1);
        assert.deepEqual(reason.items.map(item => item.problem.code), ['PRODUCT_EVALUATION_NOT_READY']);
        const searched = await groups.groupPage(config, { category: 'BR', search: selected.full_sku, reason: 'product' }, client);
        assert.deepEqual(searched.categories, all.categories, 'Search also preserves the global category selector');
        assert.deepEqual(searched.summary.reasonCounts, [{ reason: 'integration', count: 1 }, { reason: 'product', count: 1 }],
          'Reason counts retain category and literal article search filters');
        const absent = await groups.groupPage(config, { category: 'BR', search: 'NO-SUCH-ARTICLE', reason: 'product' }, client);
        assert.deepEqual(absent.categories, all.categories);
        assert.deepEqual(absent.summary.reasonCounts, []);
        assert.equal(absent.summary.productCount, 0);
        await client.query('COMMIT');
      } finally { await client.query('ROLLBACK'); client.release(); }
      assert.deepEqual(await snapshot(), before, 'Facet reads perform no product, queue, job or audit mutations');
    });
    await t.test('name cause groups separate local readiness from remote reads and retain full diagnostic context', async () => {
      const groups = require('../src/services/magento/problem-groups');
      const unavailable = { code: 'NAME_READ_UNAVAILABLE' };
      const local = [unavailable, { code: 'PRODUCT_EVALUATION_NOT_READY', issueFields: ['weight', 'name'] }];
      const fixtures = [
        { diagnostics: local, resolution: 'product' }, { diagnostics: local, resolution: 'product' },
        { diagnostics: [unavailable], resolution: 'name' },
        ...[['weight'], 'name', { name: true }].map(issueFields => ({
          diagnostics: [unavailable, { code: 'PRODUCT_EVALUATION_NOT_READY', issueFields }], resolution: 'name',
        })),
        { diagnostics: local, nameConflict: true },
        { diagnostics: local, reason: 'reconciliation_required' },
        { diagnostics: [...local, { code: 'FIRST_SYNC_FIELD_CONFLICT', target: 'weight' }], nameConflict: true, resolution: 'product' },
      ];
      for (const fixture of fixtures) {
        fixture.product = await makeProduct('NM');
        await db.query(`UPDATE magento_product_sync_requests SET state='needs_attention',reason_code=$2,
          diagnostics=$3::jsonb WHERE product_id=$1`,
        [fixture.product.id, fixture.reason || 'data_or_binding', JSON.stringify(fixture.diagnostics)]);
        if (fixture.nameConflict) await db.query(`INSERT INTO magento_name_sync_states(origin_hash,public_product_identity_id,
          remote_product_id,observed_amber_names,observed_remote_names,state) VALUES($1,$2,42,'{}','{}','conflict')`,
        [origin, fixture.product.public_product_identity_id]);
      }
      const before = await snapshot();
      const namesBefore = (await db.query('SELECT * FROM magento_name_sync_states ORDER BY public_product_identity_id')).rows;
      const client = await db.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const all = await groups.groupPage(config, { category: 'NM', limit: 100 }, client);
        assert.equal(all.summary.productCount, 9);
        assert.equal(all.summary.diagnosticCount, 16, 'All effective diagnostics remain represented');
        assert.equal(all.pageInfo.total, 6);
        assert.deepEqual(all.summary.reasonCounts, [
          { reason: 'integration', count: 1 }, { reason: 'names', count: 5 },
          { reason: 'product', count: 6 }, { reason: 'recovery', count: 1 },
        ]);
        const nameGroups = all.items.filter(group => group.problem.code === unavailable.code);
        assert.equal(nameGroups.length, 2, 'Different repairs must not share a sampled cause');
        const localGroup = nameGroups.find(group => group.problem.resolution === 'product');
        const remoteGroup = nameGroups.find(group => group.problem.resolution === 'name');
        assert.notEqual(localGroup.id, remoteGroup.id);
        assert.equal(localGroup.productCount, 3); assert.equal(localGroup.diagnosticCount, 3);
        assert.equal(remoteGroup.productCount, 4); assert.equal(remoteGroup.diagnosticCount, 4);
        assert.equal(localGroup.problem.message, 'Назви товару в Amber потрібно заповнити або виправити.');
        assert.equal(remoteGroup.problem.message, 'Не вдалося прочитати назву Magento для перевірки.');
        for (const code of [unavailable.code, 'PRODUCT_EVALUATION_NOT_READY', 'NAME_CONFLICT', 'reconciliation_required']) {
          const oldId = (await client.query('SELECT md5(jsonb_build_array($1::text,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)::text) AS id', [code])).rows[0].id;
          assert.equal(all.items.find(group => group.problem.code === code && group !== localGroup).id, oldId,
            'Unrelated and remote group identifiers remain stable');
        }
        for (const group of nameGroups) {
          const members = await groups.groupProducts(config, group.id, { category: 'NM', limit: 100 }, client);
          const expected = fixtures.filter(fixture => fixture.resolution === group.problem.resolution);
          assert.deepEqual(members.items.map(member => member.productId).sort((a, b) => a - b), expected.map(fixture => fixture.product.id));
          for (const member of members.items) {
            assert.deepEqual(member.groupProblem, group.problem);
            assert.deepEqual(member.groupProblem, member.problems.find(problem => problem.code === unavailable.code));
          }
        }
        for (const [reason, expectedGroup] of [['product', localGroup], ['names', remoteGroup]]) {
          const filtered = await groups.groupPage(config, { category: 'NM', reason }, client);
          assert.deepEqual(filtered.items.filter(group => group.problem.code === unavailable.code).map(group => group.id), [expectedGroup.id]);
          assert.deepEqual(filtered.summary.reasonCounts, all.summary.reasonCounts);
        }
        for (const [index, code] of [[6, 'NAME_CONFLICT'], [7, 'reconciliation_required']]) {
          const group = all.items.find(item => item.problem.code === code);
          const members = await groups.groupProducts(config, group.id, { category: 'NM' }, client);
          assert.deepEqual(members.items.map(member => member.productId), [fixtures[index].product.id]);
          assert.deepEqual(members.items[0].problems.map(problem => problem.code), [code], 'Higher-priority recovery/name state still overrides diagnostics');
        }
        await client.query('COMMIT');
      } finally { await client.query('ROLLBACK'); client.release(); }
      assert.deepEqual(await snapshot(), before, 'Grouping changes no saved diagnostic, product, job, lifecycle or audit');
      assert.deepEqual((await db.query('SELECT * FROM magento_name_sync_states ORDER BY public_product_identity_id')).rows, namesBefore);
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
