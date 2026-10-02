const { test, assert, Pool, fs, os, path, serverRoot, runNodeInDatabase, recreateTestDatabase, dropTestDatabase } = require('./suite-context');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');
const category = require('../src/services/magento/configuration-category');
const actions = require('../src/services/magento/configuration-actions');
const fixture = require('../test/fixtures/magento-v4');
const { REQUIRED } = require('../src/services/export-templates/column-contract');

async function setup(name, checkpoint=false) {
  const url = await recreateTestDatabase(name); const db = new Pool({ connectionString: url });
  try {
    if(checkpoint){
      const directory=await fs.mkdtemp(path.join(os.tmpdir(),'amber-reseal-upgrade-'));
      try{
        for(const file of (await fs.readdir(path.join(serverRoot,'migrations'))).filter(f=>f.endsWith('.sql') && f<'056'))
          await fs.copyFile(path.join(serverRoot,'migrations',file),path.join(directory,file));
        await runNodeInDatabase(url,`require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
      }finally{
        assert.equal(path.dirname(directory),os.tmpdir());await fs.rm(directory,{recursive:true,force:true});
      }
    }else await runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const actor = Number((await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Configuration admin') RETURNING id")).rows[0].id);
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const options = { databasePool: db, mutationContext: { actorUserId: actor } };
    await db.query("INSERT INTO categories(code,name) VALUES('XG','Нова категорія')");
    const config = { configured: true, baseUrl: 'https://configuration.invalid', consumerKey: 'fixture-consumer-key', consumerSecret: 'fixture-consumer-secret', accessToken: 'fixture-access-token', accessTokenSecret: 'fixture-token-secret' };
    const categoryPath = 'Default/Сувеніри/Нова підкатегорія';
    const definition = fixture.definition(); definition.sources = { sku: definition.sources.sku };
    definition.tables = {}; definition.questionContracts = {};
    for (const group of definition.groups) {
      group.columns = [...REQUIRED, 'categories'];
      for (const row of group.rows) {
        delete row.cells.kolir; delete row.cells.new_note;
        row.cells.price = { op: 'literal', value: '42' }; row.cells.categories = { op: 'literal', value: row.id === 'base' ? categoryPath : '' };
      }
    }
    const f = await templates.createTemplate({ key: 'configuration', displayName: 'Configuration', definition }, options);
    const v = await templates.publishTemplate(f.id, { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash }, options);
    const draft = await bindings.createDraft({ installationKey: 'configuration', origin: config.baseUrl,
      templateVersionId: v.id, observedAt: '2026-10-01T00:00:00.000Z', schema: fixture.observation(),
      bindings: { routes: [{ routeKey: 'XG:all', enabled: false, setId: null, reviewState: 'review_required' }],
        attributes: [{ routeKey: 'XG:all', rowId: 'base', target: 'categories', strategy: 'transport_control', attributeCode: null, transportTarget: 'product.extension_attributes.category_links',
          reviewState: 'review_required', evidence: { categories: [{ requestedPath: categoryPath, normalizedPath: categoryPath,
            categoryId: null, candidates: [], reviewState: 'review_required' }] } }], options: [], policies: [] } }, options);
    const input = { bindingRevisionId: draft.id, expectedRevision: draft.revision,
      bindingKey: draft.bindings.attributes[0].bindingKey, path: categoryPath, parentId: 10 };
    return { db, options, config, draft, input, actor };
  } catch (cause) { await db.end(); await dropTestDatabase(name); throw cause; }
}
function fakeMagento(db, { loseResponse = false, failVerification = false } = {}) {
  let created = false; let posts = 0;
  const observation = [];
  return { observation, hideCreated:()=>{created=false;}, get posts() { return posts; }, fetch: async (url, init) => {
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
      [{ id: 6001, parent_id: 10, name: 'Нова підкатегорія', children_data: [] }] : [] }, ...observation] };
    else throw new Error(`Unexpected GET ${path}`);
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } };
}
test('migration 056 upgrades checkpoint 055 with sealed/dispatched evidence unchanged, rolls back and verifies repeat startup',async()=>{
  const name='amber_reseal_upgrade_test',f=await setup(name,true);
  try{
    const c=require('../src/services/magento/binding-contract'),remote=fakeMagento(f.db),proof=await category.preview(f.config,f.input,{...f.options,fetchImpl:remote.fetch});
    const first='00000000-0000-0000-0000-000000000001',second='00000000-0000-0000-0000-000000000002';
    for(const [id,resource] of [[first,proof.resource],[second,{path:'other required path'}]])await f.db.query(`INSERT INTO magento_configuration_actions
      (id,kind,origin_hash,resource_key,binding_revision_id,binding_revision,actor_user_id,preview_hash,intent)
      VALUES($1,'category',$2,$3,$4,$5,$6,$7,$8::jsonb)`,[id,c.originHash(f.config.baseUrl),c.hash(resource),f.draft.id,f.draft.revision,f.actor,proof.previewToken,JSON.stringify(proof)]);
    await f.db.query("UPDATE magento_configuration_actions SET state='dispatched',dispatched_at=CURRENT_TIMESTAMP WHERE id=$1",[second]);
    const original=(await f.db.query('SELECT * FROM magento_configuration_actions ORDER BY id')).rows;
    const sql=await fs.readFile(path.join(serverRoot,'migrations/056_magento_configuration_reseal.sql'),'utf8'),client=await f.db.connect();
    try{await client.query('BEGIN');await client.query(sql);await client.query('ROLLBACK');}finally{client.release();}
    assert.deepEqual((await f.db.query('SELECT * FROM magento_configuration_actions ORDER BY id')).rows,original);
    await runNodeInDatabase(f.db.options.connectionString,"require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const upgraded=(await f.db.query('SELECT * FROM magento_configuration_actions ORDER BY id')).rows;
    assert.deepEqual(upgraded.map(({supersedes_id,...row})=>{assert.equal(supersedes_id,null);return row;}),original);
    await assert.rejects(f.db.query("UPDATE magento_configuration_actions SET state='superseded' WHERE id=$1",[first]),/permanent successor/);
    await assert.rejects(f.db.query("UPDATE magento_configuration_actions SET state='superseded' WHERE id=$1",[second]),/immutable/);
    const fresh={...proof,observationHash:c.hash('new observation'),previewToken:c.hash('new review')};
    const successor=await actions.seal(f.config,fresh,f.options);assert.equal(successor.supersedes_id,first);
    await runNodeInDatabase(f.db.options.connectionString,"require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    assert.equal((await f.db.query("SELECT count(*)::int n FROM schema_migrations WHERE name LIKE '056%'")).rows[0].n,1);
    assert.equal((await f.db.query('SELECT state FROM magento_configuration_actions WHERE id=$1',[second])).rows[0].state,'dispatched');assert.equal(remote.posts,0);
  }finally{await f.db.end();await dropTestDatabase(name);}
});
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

test('sealed category crash recovery: fresh reviewed observation supersedes intent and concurrent restart POSTs once', async () => {
  const name='amber_category_reseal_test',f=await setup(name),second=new Pool({connectionString:f.db.options.connectionString});
  try {
    const remote=fakeMagento(f.db),options={...f.options,fetchImpl:remote.fetch};
    const first=await category.preview(f.config,f.input,options);
    // Independent process commits only seal and exits; no dispatch/POST occurred.
    await runNodeInDatabase(f.db.options.connectionString,`require('./src/services/magento/configuration-actions').seal(${JSON.stringify(f.config)},${JSON.stringify(first)},{mutationContext:{actorUserId:${f.actor}}}).then(()=>require('./src/db/pool').end()).catch(e=>{console.error(e);process.exitCode=1;});`);
    const prior=(await f.db.query('SELECT * FROM magento_configuration_actions')).rows[0];
    remote.observation.push({id:99,parent_id:803,name:'Other category',children_data:[]});
    const fresh=await category.preview(f.config,f.input,options);assert.notEqual(fresh.previewToken,first.previewToken);
    const results=await Promise.allSettled([category.apply(f.config,{...f.input,previewToken:fresh.previewToken},options),
      category.apply(f.config,{...f.input,previewToken:fresh.previewToken},{...options,databasePool:second})]);
    assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(remote.posts,1);
    const rows=(await f.db.query('SELECT * FROM magento_configuration_actions ORDER BY created_at')).rows;
    assert.equal(rows.length,2);assert.equal(rows[0].state,'superseded');assert.deepEqual(rows[0].intent,prior.intent);
    assert.equal(rows[1].state,'verified');assert.equal(rows[1].supersedes_id,prior.id);
    await assert.rejects(actions.transition(prior.id,'sealed','dispatched',{},options));
    await assert.rejects(actions.seal(f.config,first,options));assert.equal(remote.posts,1);
  } finally {await second.end();await f.db.end();await dropTestDatabase(name);}
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
    remote.hideCreated();
    const restarted=new Pool({connectionString:db.options.connectionString});
    try {
      const again=await category.preview(config,input,{...opt,databasePool:restarted});
      await assert.rejects(category.apply(config,{...input,previewToken:again.previewToken},{...opt,databasePool:restarted}),{code:'MAGENTO_CONFIGURATION_RECONCILIATION_REQUIRED'});
    }finally{await restarted.end();}
    assert.equal(remote.posts, 1); assert.equal(actions.receipt(row).canReconcile, false);
    assert.deepEqual(await bindings.getRevision(draft.id, options), draft);
  } finally { await db.end(); await dropTestDatabase(name); }
});
