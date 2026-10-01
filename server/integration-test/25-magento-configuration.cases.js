const { test, assert, Pool, runNodeInDatabase, recreateTestDatabase, dropTestDatabase } = require('./suite-context');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');
const category = require('../src/services/magento/configuration-category');
const actions = require('../src/services/magento/configuration-actions');
const fixture = require('../test/fixtures/magento-v4');
const { REQUIRED } = require('../src/services/export-templates/column-contract');

async function setup(name) {
  const url = await recreateTestDatabase(name); const db = new Pool({ connectionString: url });
  try {
    await runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Configuration admin') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const options = { databasePool: db, mutationContext: { actorUserId: actor } };
    await db.query("INSERT INTO categories(code,name) VALUES('XG','Нова категорія')");
    const config = { configured: true, baseUrl: 'https://configuration.invalid', consumerKey: 'fixture-consumer-key', consumerSecret: 'fixture-consumer-secret', accessToken: 'fixture-access-token', accessTokenSecret: 'fixture-token-secret' };
    const path = 'Default/Сувеніри/Нова підкатегорія';
    const definition = fixture.definition(); definition.sources = { sku: definition.sources.sku };
    definition.tables = {}; definition.questionContracts = {};
    for (const group of definition.groups) {
      group.columns = [...REQUIRED, 'categories'];
      for (const row of group.rows) {
        delete row.cells.kolir; delete row.cells.new_note;
        row.cells.price = { op: 'literal', value: '42' }; row.cells.categories = { op: 'literal', value: row.id === 'base' ? path : '' };
      }
    }
    const f = await templates.createTemplate({ key: 'configuration', displayName: 'Configuration', definition }, options);
    const v = await templates.publishTemplate(f.id, { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash }, options);
    const draft = await bindings.createDraft({ installationKey: 'configuration', origin: config.baseUrl,
      templateVersionId: v.id, observedAt: '2026-10-01T00:00:00.000Z', schema: fixture.observation(),
      bindings: { routes: [{ routeKey: 'XG:all', enabled: false, setId: null, reviewState: 'review_required' }],
        attributes: [{ routeKey: 'XG:all', rowId: 'base', target: 'categories', strategy: 'transport_control', attributeCode: null, transportTarget: 'product.extension_attributes.category_links',
          reviewState: 'review_required', evidence: { categories: [{ requestedPath: path, normalizedPath: path,
            categoryId: null, candidates: [], reviewState: 'review_required' }] } }], options: [], policies: [] } }, options);
    const input = { bindingRevisionId: draft.id, expectedRevision: draft.revision,
      bindingKey: draft.bindings.attributes[0].bindingKey, path, parentId: 10 };
    return { db, options, config, draft, input, actor };
  } catch (cause) { await db.end(); await dropTestDatabase(name); throw cause; }
}
function fakeMagento(db, { loseResponse = false, failVerification = false } = {}) {
  let created = false; let posts = 0;
  return { get posts() { return posts; }, fetch: async (url, init) => {
    const path = new URL(url).pathname;
    if (init.method === 'POST') {
      assert.equal(path, '/rest/all/V1/categories');
      const row = (await db.query("SELECT * FROM magento_configuration_actions WHERE state='dispatched'")).rows[0];
      assert.ok(row); assert.equal(row.remote_id, null); posts++; created = true;
      if (loseResponse) throw new Error('Response lost after write');
      return new Response(JSON.stringify({ id: 6001 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    assert.equal(init.method, 'GET');
    let data;
    if (path.endsWith('/store/storeGroups')) data = [{ id: 802, root_category_id: 803 }];
    else if (path.endsWith('/categories/6001')) {
      if (failVerification) { failVerification = false; throw new Error('GET unavailable'); }
      data = { id: 6001, parent_id: 10, name: 'Нова підкатегорія', is_active: true, include_in_menu: false };
    }
    else if (path.endsWith('/categories')) data = { id: 803, name: 'Default', children_data: [{ id: 10, parent_id: 803, name: 'Сувеніри', children_data: created ?
      [{ id: 6001, parent_id: 10, name: 'Нова підкатегорія', children_data: [] }] : [] }] };
    else throw new Error(`Unexpected GET ${path}`);
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } };
}
test('reviewed category ledger: exact verified creation, concurrent apply sends once and never approves binding', async () => {
  const name = 'amber_configuration_category_test'; const { db, options, config, draft, input } = await setup(name);
  const second = new Pool({ connectionString: db.options.connectionString });
  try {
    const remote = fakeMagento(db); const opt = { ...options, fetchImpl: remote.fetch };
    const reviewed = await category.preview(config, input, opt);
    assert.equal(remote.posts, 0);
    let arrivals = 0; let release;
    const rendezvous = new Promise((resolve) => { release = resolve; });
    const raceFetch = async (url, init) => {
      if (new URL(url).pathname.endsWith('/store/storeGroups') && arrivals < 2) {
        if (++arrivals === 2) release(); await rendezvous;
      }
      return remote.fetch(url, init);
    };
    const results = await Promise.allSettled([category.apply(config, { ...input, previewToken: reviewed.previewToken }, { ...opt, fetchImpl: raceFetch }),
      category.apply(config, { ...input, previewToken: reviewed.previewToken }, { ...opt, fetchImpl: raceFetch, databasePool: second })]);
    assert.equal(arrivals, 2);
    assert.ok(results.some((r) => r.status === 'fulfilled')); assert.equal(remote.posts, 1);
    const ledger = (await db.query('SELECT * FROM magento_configuration_actions')).rows;
    assert.equal(ledger.length, 1); assert.equal(ledger[0].state, 'verified'); assert.equal(ledger[0].remote_id, '6001');
    assert.deepEqual(await bindings.getRevision(draft.id, options), draft);
    await assert.rejects(db.query("UPDATE magento_configuration_actions SET intent='{}' WHERE id=$1", [ledger[0].id]), /immutable/);
    await assert.rejects(db.query('DELETE FROM magento_configuration_actions WHERE id=$1', [ledger[0].id]), /permanent/);
    const receipt = await category.reconcile(config, { actionId: ledger[0].id }, opt);
    assert.equal(receipt.bound, false); assert.equal(receipt.remoteId, '6001'); assert.equal(remote.posts, 1);
  } finally { await second.end(); await db.end(); await dropTestDatabase(name); }
});
test('category returned identity survives failed verification and resumes GET-only; revoked apply sends nothing', async () => {
  const name = 'amber_configuration_recovery_test'; const { db, options, config, input, actor } = await setup(name);
  try {
    const remote = fakeMagento(db, { failVerification: true }); const opt = { ...options, fetchImpl: remote.fetch };
    const reviewed = await category.preview(config, input, opt);
    await db.query("UPDATE application_users SET status='disabled' WHERE id=$1", [actor]);
    await assert.rejects(category.apply(config, { ...input, previewToken: reviewed.previewToken }, opt), { code: 'ADMIN_PERMISSION_REVOKED' });
    assert.equal(remote.posts, 0); assert.equal((await db.query('SELECT count(*)::int n FROM magento_configuration_actions')).rows[0].n, 0);
    await db.query("UPDATE application_users SET status='active' WHERE id=$1", [actor]);
    await assert.rejects(category.apply(config, { ...input, previewToken: reviewed.previewToken }, opt), { code: 'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED' });
    const row = (await db.query('SELECT * FROM magento_configuration_actions')).rows[0];
    assert.equal(row.state, 'returned'); assert.equal(row.remote_id, '6001'); assert.equal(actions.receipt(row).canReconcile, true);
    const receipt = await category.reconcile(config, { actionId: row.id }, opt);
    assert.equal(receipt.state, 'verified'); assert.equal(remote.posts, 1);
    await assert.rejects(db.query("UPDATE magento_configuration_actions SET state='sealed',remote_id=NULL WHERE id=$1", [row.id]), /immutable/);
  } finally { await db.end(); await dropTestDatabase(name); }
});
test('lost category CREATE response stays uncertain despite equal path discovery and cannot be blindly resent', async () => {
  const name = 'amber_configuration_uncertain_test'; const { db, options, config, draft, input } = await setup(name);
  try {
    const remote = fakeMagento(db, { loseResponse: true }); const opt = { ...options, fetchImpl: remote.fetch };
    const reviewed = await category.preview(config, input, opt);
    await assert.rejects(category.apply(config, { ...input, previewToken: reviewed.previewToken }, opt), { code: 'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED' });
    const row = (await db.query('SELECT * FROM magento_configuration_actions')).rows[0];
    assert.equal(row.state, 'dispatched'); assert.equal(row.remote_id, null);
    await assert.rejects(category.reconcile(config, { actionId: row.id }, opt), { code: 'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED' });
    await assert.rejects(category.apply(config, { ...input, previewToken: reviewed.previewToken }, opt));
    assert.equal(remote.posts, 1); assert.equal(actions.receipt(row).canReconcile, false);
    assert.deepEqual(await bindings.getRevision(draft.id, options), draft);
  } finally { await db.end(); await dropTestDatabase(name); }
});
