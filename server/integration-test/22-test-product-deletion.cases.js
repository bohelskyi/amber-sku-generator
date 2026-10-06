const suite = require('./suite-context');
const { insertProductFixture } = require('./product-fixture');

suite.test('test deletion endpoints retain authentication CSRF active-user and permission boundaries', async () => {
  if (!suite.authenticatedSession) suite.authenticatedSession=await suite.authenticateApplicationSession('/');
  const { assert, request }=suite; const userId=suite.authenticatedSession.applicationUser.id;
  for(const action of ['preview','apply']) {
    const path=`/api/products/test-delete/${action}`;
    assert.equal((await request(path,{method:'POST',body:{},authentication:null})).response.status,401);
    assert.equal((await request(path,{method:'POST',body:{},csrfToken:null})).response.status,403);
    try {
      for(const role of ['manager','storekeeper']) {
        await suite.replaceActiveRoleForTest(userId,role);
        assert.equal((await request(path,{method:'POST',body:{}})).response.status,403);
      }
    } finally { await suite.replaceActiveRoleForTest(userId,'administrator'); }
    assert.equal((await request(path,{method:'POST',body:{}})).response.status,422);
    try {
      await suite.pool.query("UPDATE application_users SET status='disabled',deactivated_at=CURRENT_TIMESTAMP WHERE id=$1",[userId]);
      assert.equal((await request(path,{method:'POST',body:{}})).response.status,403);
    } finally { await suite.pool.query("UPDATE application_users SET status='active',deactivated_at=NULL WHERE id=$1",[userId]); }
  }
});

suite.test('test deletion migration 050 upgrades 049 atomically with repeated startup and checksums', async () => {
  const { fs,os,path,Pool,assert,serverRoot,runNodeInDatabase,recreateTestDatabase,dropTestDatabase }=suite;
  const name='amber_delete_migration_test'; const url=await recreateTestDatabase(name);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'amber-delete-049-')); const db=new Pool({connectionString:url});
  const migrate=()=>runNodeInDatabase(url,`require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1})`);
  try {
    for(const file of (await fs.readdir(path.join(serverRoot,'migrations'))).filter((f)=>f.endsWith('.sql')&&f<'050')) {
      await fs.copyFile(path.join(serverRoot,'migrations',file),path.join(directory,file));
    }
    await migrate(); const before=(await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    const file='050_test_product_deletion.sql'; const sql=await fs.readFile(path.join(serverRoot,'migrations',file),'utf8');
    await fs.writeFile(path.join(directory,file),sql+'\nSELECT 1/0;'); await assert.rejects(migrate(),/division by zero/);
    assert.equal((await db.query("SELECT to_regclass('magento_test_deletions') AS present")).rows[0].present,null);
    assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows,before);
    await fs.writeFile(path.join(directory,file),sql); await migrate(); await migrate();
    assert.equal((await db.query('SELECT count(*)::int n FROM magento_test_deletions')).rows[0].n,0);
    assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name<'050' ORDER BY name")).rows,before);
    await fs.writeFile(path.join(directory,file),sql.replace(/\r?\n/g,'\r\n')); await migrate();
    await fs.appendFile(path.join(directory,file),'\n-- changed checksum'); await assert.rejects(migrate(),/checksum/i);
  } finally {
    await db.end(); assert.equal(path.dirname(directory),path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('amber-delete-049-'));
    await fs.rm(directory,{recursive:true,force:true}); await dropTestDatabase(name);
  }
});

suite.test('test deletion gap: ordinary archive retains identity and retires locally without remote DELETE', async () => {
  const { pool, assert } = suite;
  if (!suite.authenticatedSession) suite.authenticatedSession = await suite.authenticateApplicationSession('/');
  const connection=await pool.connect(); let product;
  const gate=require('../src/services/full-product-cutover-gate');
  try {
    await connection.query('BEGIN'); await gate.enterExisting(connection);
    product=(await require('./product-fixture').insertNativeProductFixture(connection, { category: 'ZZ' })).rows[0];
    await connection.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1",[product.id]);
    await gate.commit(connection);
  } catch(error) { await gate.rollback(connection); throw error; }
  finally { await gate.release(connection); connection.release(); }
  const originalFetch = global.fetch;
  global.fetch = async () => { assert.fail('Archive must never call Magento'); };
  try {
    const publicSku = (await pool.query('SELECT public_sku FROM public_product_identities WHERE id=$1', [product.public_product_identity_id])).rows[0].public_sku;
    await require('../src/services/product.service').deleteProductBySku(publicSku,
      { mutationContext: { actorUserId: suite.authenticatedSession.applicationUser.id } });
  } finally { global.fetch = originalFetch; }
  const saved = (await pool.query('SELECT * FROM products WHERE id=$1', [product.id])).rows[0];
  assert.equal(saved.status, 'archived');
  assert.equal(saved.exclude_from_export, 1);
  assert.equal((await pool.query('SELECT route FROM product_full_export_state WHERE product_id=$1', [product.id])).rows[0].route, 'retired');
  assert.equal(saved.public_product_identity_id, product.public_product_identity_id);
  assert.equal(product.full_sku, null);
  assert.equal((await pool.query('SELECT 1 FROM sku_registry WHERE first_product_id=$1', [product.id])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM audit_events WHERE event_key='product.archived' AND subject_id=$1", [String(product.id)])).rowCount, 1);
});

suite.test('test deletion ledger safety and recovery with fake Magento only', async (t) => {
  const { assert, Pool, crypto } = suite;
  const name = 'amber_test_delete_test'; const url = await suite.recreateTestDatabase(name);
  const db = new Pool({ connectionString: url });
  const service = require('../src/services/magento/test-deletion.service');
  const { hash, originHash } = require('../src/services/magento/binding-contract');
  const config = require('../src/config/magento').parseMagentoConfig({ MAGENTO_BASE_URL: 'https://delete.example.invalid',
    MAGENTO_CONSUMER_KEY: 'fake-key', MAGENTO_CONSUMER_SECRET: 'fake-secret',
    MAGENTO_ACCESS_TOKEN: 'fake-access', MAGENTO_ACCESS_TOKEN_SECRET: 'fake-access-secret' });
  try {
    await suite.runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().then(()=>process.exit()).catch(e=>{console.error(e);process.exit(1)})");
    const actor = (await db.query("INSERT INTO application_users(status,display_name) VALUES('active','Deletion tester') RETURNING id")).rows[0];
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor.id]);
    const mutations = { databasePool: db, mutationContext: { actorUserId: Number(actor.id) } };
    await db.query("INSERT INTO categories(code,name) VALUES('ZZ','Test')");
    for (const group of ['BR','NM','KL','CH','AR','SV']) await db.query('INSERT INTO categories(code,name) VALUES($1,$1)',[group]);
    const legacy = (await insertProductFixture(db, "INSERT INTO products(full_sku,category,total_price_uah) VALUES('ZZ-LEGACY','ZZ',100) RETURNING *")).rows[0];
    const fixture = require('../test/fixtures/magento-bindings');
    const definition = structuredClone(fixture.definition()); definition.sources = { sku: definition.sources.sku }; definition.tables = {};
    for (const group of definition.groups) for (const row of group.rows) row.cells = {
      sku: row.cells.sku, name: { op: 'literal', value: 'Test' }, store_view_code: { op: 'literal', value: row.id === 'base' ? '' : 'en' },
      attribute_set_code: { op: 'literal', value: 'Historical CSV name' }, product_type: { op: 'literal', value: 'simple' },
    };
    const templates = require('../src/services/export-templates/template.service');
    const family = await templates.createTemplate({ key: 'test-deletion', displayName: 'Test', definition }, mutations);
    const version = await templates.publishTemplate(family.id,
      { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, mutations);
    const binding = await require('../src/services/magento/binding.service').createDraft({ installationKey: 'test-delete',
      origin: config.baseUrl, templateVersionId: version.id, observedAt: new Date().toISOString(), schema: fixture.schema() }, mutations);
    const event = (await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id)
      VALUES('test.activation',$1,'{"displayName":"Test","preferredUsername":null}','test','test') RETURNING id`, [actor.id])).rows[0].id;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL amber.public_sku_activation='on'; SET LOCAL amber.magento_delivery_cutover='on'");
      await client.query('UPDATE public_sku_activation SET enabled=TRUE,activated_at=CURRENT_TIMESTAMP,activated_by_user_id=$1,activation_event_id=$2', [actor.id,event]);
      await client.query(`UPDATE magento_auto_sync_activation SET enabled=TRUE,installation_key='test-delete',actor_user_id=$1,
        legacy_product_csv_enabled=FALSE,cutover_at=CURRENT_TIMESTAMP,cutover_by_user_id=$1,cutover_event_id=$2`, [actor.id,event]);
      await client.query('COMMIT');
    } finally { client.release(); }
    async function scenario({isTestProduct=false}={}) {
      const product = (await require('./product-fixture').insertNativeProductFixture(db, { category: 'ZZ', isTestProduct, actorUserId:isTestProduct?actor.id:null })).rows[0];
      const lifecycleClient = await db.connect(), lifecycleGate = require('../src/services/full-product-cutover-gate');
      try {
        await lifecycleGate.begin(lifecycleClient);
        await lifecycleClient.query("UPDATE product_full_export_state SET business_exclusion_state='none',delivery_version=delivery_version+1 WHERE product_id=$1", [product.id]);
        await lifecycleGate.commit(lifecycleClient);
      } catch (error) { await lifecycleGate.rollback(lifecycleClient); throw error; }
      finally { await lifecycleGate.release(lifecycleClient); lifecycleClient.release(); }
      const sku = (await db.query('SELECT public_sku FROM public_product_identities WHERE id=$1', [product.public_product_identity_id])).rows[0].public_sku;
      const jobId = crypto.randomUUID(); const remoteId = product.id + 100000;
      await db.query(`INSERT INTO magento_sync_jobs(id,product_id,public_product_identity_id,sku,installation_key,origin_hash,
        binding_revision_id,binding_hash,amber_hash,plan_hash,intent,baseline,created_by_user_id,state,remote_product_id,acknowledged_at)
        VALUES($1,$2,$3,$4,'test-delete',$5,$6,$7,$7,$7,
          $10::jsonb,
          '{}',$8,'succeeded',$9,CURRENT_TIMESTAMP)`,
      [jobId,product.id,product.public_product_identity_id,sku,originHash(config.baseUrl),binding.id,hash({}),actor.id,remoteId,
        JSON.stringify({mode:'create',operations:[{domain:'coreProduct',payload:{product:{name:'Test',...(isTestProduct?{status:2}:{})}}}],englishValues:{name:'Test'}})]);
      await require('../src/services/magento/name-state').confirmJobNames(db,
        (await db.query('SELECT * FROM magento_sync_jobs WHERE id=$1',[jobId])).rows[0]);
      await db.query("UPDATE magento_product_sync_requests SET state='synced',synced_generation=desired_generation WHERE product_id=$1", [product.id]);
      const state = { remote: { id: remoteId, sku, status: 2 }, writes: 0, reads: 0, loseWrite: false, failRead: false, noMutation: false };
      const options = { ...mutations, fetchImpl: async (target, init) => {
        const u = new URL(target);
        if (init.method === 'DELETE') {
          assert.equal(u.pathname, `/rest/all/V1/products/${sku}`); state.writes++;
          const row = (await db.query('SELECT * FROM magento_test_deletions WHERE product_id=$1', [product.id])).rows[0];
          assert.equal(row.state,'dispatched'); assert.ok(row.dispatched_at);
          // A separate connection can lock the product during HTTP: no business lock is held.
          const lock = await db.connect();
          try { await lock.query('BEGIN'); await lock.query('SELECT id FROM products WHERE id=$1 FOR UPDATE NOWAIT',[product.id]); await lock.query('COMMIT'); }
          finally { lock.release(); }
          if (state.onWrite) await state.onWrite();
          if (!state.noMutation) state.remote = null;
          if (state.loseWrite) { state.failRead = true; throw new Error('simulated lost response'); }
          return new Response('true');
        }
        assert.equal(init.method, 'GET'); assert.equal(u.pathname, '/rest/all/V1/products'); state.reads++;
        assert.equal(u.searchParams.get('searchCriteria[filter_groups][0][filters][0][value]'),sku);
        if (state.failRead) throw new Error('simulated unavailable read');
        return new Response(JSON.stringify({ total_count: state.remote ? 1 : 0, items: state.remote ? [state.remote] : [] }),
          { headers: { 'content-type': 'application/json' } });
      } };
      const preview = () => service.preview(config, { productId: product.id }, options);
      const apply = (p, override = {}) => service.apply(config, { productId: product.id, previewHash: p.previewHash, confirmation: sku }, { ...options,...override });
      return { product, sku, jobId, state, options, preview, apply };
    }
    await t.test('success preserves permanent identifiers, terminalizes requests, hides history and never reuses AG-000002', async () => {
      await scenario(); const s = await scenario(); assert.equal(s.sku, 'AG-000002');
      const before = (await db.query('SELECT * FROM magento_sync_jobs WHERE id=$1', [s.jobId])).rows[0];
      const p = await s.preview(); let result;
      const singleConnection=new Pool({connectionString:url,max:1,connectionTimeoutMillis:1000});
      try { result=await s.apply(p,{databasePool:singleConnection}); }
      finally { await singleConnection.end(); }
      assert.equal(result.state,'finalized'); assert.equal(s.state.writes,1);
      assert.equal((await s.apply(p)).intentId,result.intentId); assert.equal(s.state.writes,1);
      const row = (await db.query('SELECT * FROM products WHERE id=$1',[s.product.id])).rows[0];
      assert.equal(row.status,'voided'); assert.equal(row.exclude_from_export,1);
      assert.equal((await db.query('SELECT route FROM product_full_export_state WHERE product_id=$1',[row.id])).rows[0].route,'retired');
      const request = (await db.query('SELECT * FROM magento_product_sync_requests WHERE product_id=$1',[row.id])).rows[0];
      assert.equal(request.state,'voided'); assert.equal(request.reason_code,null); assert.equal(request.synced_generation,'1');
      assert.equal(request.desired_generation,'2'); assert.equal(request.active_job_id,null);
      await require('../src/services/magento/automatic-sync-worker').createAutomaticSyncWorker(config, {
        databasePool:db, jobOptions:{fetchImpl:async()=>assert.fail('Voided product must never sync')},
      }).runProduct(row.public_product_identity_id);
      assert.equal((await require('../src/services/magento/sync-problems').summary(db)).problemCount,0);
      assert.deepEqual(await require('../src/services/magento/sync-problems').problems(config,db),[]);
      assert.deepEqual((await db.query('SELECT * FROM magento_sync_jobs WHERE id=$1',[s.jobId])).rows[0],before);
      assert.equal(row.full_sku,null);
      assert.equal((await db.query('SELECT 1 FROM sku_registry WHERE first_product_id=$1',[row.id])).rowCount,0);
      assert.equal((await db.query('SELECT 1 FROM public_product_identities WHERE id=$1',[row.public_product_identity_id])).rowCount,1);
      assert.equal((await db.query("SELECT 1 FROM audit_events WHERE event_key='product.test_delete_finalized' AND subject_id=$1",[String(row.id)])).rowCount,1);
      assert.ok(!(await require('../src/services/product/product-queries').getRecentProducts(db)).some((p) => p.id===row.id));
      assert.equal((await require('../src/services/product/public-identity').resolveProductLookup(db,s.sku)).product,null);
      assert.equal((await scenario()).sku,'AG-000003');
      await assert.rejects(db.query("UPDATE products SET status='active' WHERE id=$1",[row.id]), /frozen/);
      await assert.rejects(db.query('DELETE FROM products WHERE id=$1',[row.id]));
      await assert.rejects(db.query('DELETE FROM public_product_identities WHERE id=$1',[row.public_product_identity_id]),/immutable/);
      await assert.rejects(db.query("UPDATE magento_test_deletions SET state='sealed' WHERE product_id=$1",[row.id]),/immutable/);
    });
    for (const scope of ['scenario', 'global']) {
      for (const containsTarget of [false, true]) {
        await t.test(`${scope} draft ${containsTarget ? 'containing the exact product blocks' : 'containing only another product allows'} test deletion`, async () => {
          const s = await scenario(); const other = await scenario();
          const snapshot = require('../src/services/repricing/tokens').getRepricingPreviewSnapshot({
            scope, items: [{ productId: containsTarget ? s.product.id : other.product.id }],
          });
          const draft = (await db.query(`INSERT INTO repricing_drafts
            (scope,category_code,scenario_name,preview_fingerprint,preview_snapshot)
            VALUES($1,$2,'Test membership','test',$3::jsonb) RETURNING id`,
          [scope, scope === 'global' ? '*' : s.product.category, JSON.stringify(snapshot)])).rows[0];
          try {
            if (containsTarget) {
              await assert.rejects(s.preview(), { code: 'TEST_DELETE_BUSINESS_EVIDENCE' });
              assert.equal(s.state.writes, 0);
              assert.equal((await db.query('SELECT 1 FROM magento_test_deletions WHERE product_id=$1', [s.product.id])).rowCount, 0);
            } else {
              assert.equal((await s.apply(await s.preview())).state, 'finalized');
              assert.equal(s.state.writes, 1);
            }
            assert.deepEqual((await db.query('SELECT preview_snapshot FROM repricing_drafts WHERE id=$1', [draft.id])).rows[0].preview_snapshot,
              JSON.parse(JSON.stringify(snapshot)));
          } finally { await db.query("UPDATE repricing_drafts SET status='discarded' WHERE id=$1", [draft.id]); }
        });
      }
    }
    await t.test('draft membership added after preview blocks apply before sealing or dispatch', async () => {
      const s = await scenario(); const p = await s.preview();
      const draft = (await db.query(`INSERT INTO repricing_drafts
        (scope,category_code,scenario_name,preview_fingerprint,preview_snapshot)
        VALUES('global','*','Test membership','test',$1::jsonb) RETURNING id`,
      [JSON.stringify({ items: [{ productId: s.product.id }] })])).rows[0];
      try {
        await assert.rejects(s.apply(p), { code: 'TEST_DELETE_BUSINESS_EVIDENCE' });
        assert.equal(s.state.writes, 0);
        assert.equal((await db.query('SELECT 1 FROM magento_test_deletions WHERE product_id=$1', [s.product.id])).rowCount, 0);
        assert.equal((await db.query('SELECT status FROM products WHERE id=$1', [s.product.id])).rows[0].status, 'active');
      } finally { await db.query("UPDATE repricing_drafts SET status='discarded' WHERE id=$1", [draft.id]); }
    });
    await t.test('lost DELETE response is sticky across attempts; later exact absence safely finalizes', async () => {
      const s = await scenario(); const p = await s.preview(); s.state.loseWrite = true;
      const result = await s.apply(p); assert.equal(result.state,'dispatched'); assert.equal(result.reconciliationRequired,true);
      const counting = await db.connect();
      try {
        await counting.query('BEGIN');
        await counting.query("UPDATE magento_product_sync_requests SET state='needs_attention',reason_code='reconciliation_required' WHERE product_id=$1", [s.product.id]);
        const overview = await require('../src/services/magento/integration-overview').operationalCounts(counting, originHash(config.baseUrl));
        assert.equal(overview.count, 1, 'request and deletion overlap is one public product');
        assert.deepEqual(overview.categories.get('ZZ').reasons.map((reason) => [reason.code, reason.count]), [['TEST_DELETION_PENDING', 1]]);
      } finally { await counting.query('ROLLBACK'); counting.release(); }
      assert.equal((await require('../src/services/magento/sync-problems').summary(db)).problemCount,1);
      assert.equal((await require('../src/services/magento/sync-problems').problems(config,db))[0].problems[0].code,'TEST_DELETION_PENDING');
      assert.equal((await require('../src/services/magento/automatic-sync-status').readStatuses(db,[s.product.id])).get(s.product.id).state,'needs_attention');
      assert.equal((await db.query('SELECT status FROM products WHERE id=$1',[s.product.id])).rows[0].status,'active');
      await assert.rejects(s.apply(p)); assert.equal(s.state.writes,1);
      await assert.rejects(db.query('UPDATE products SET total_price_uah=101 WHERE id=$1',[s.product.id]), /frozen/);
      s.state.failRead=false;
      assert.equal((await s.apply(p)).state,'finalized'); assert.equal(s.state.writes,1);
    });
    await t.test('present after DELETE never resends; a fresh process recovers by reads', async () => {
      const s=await scenario(); const p=await s.preview(); s.state.noMutation=true;
      assert.equal((await s.apply(p)).state,'dispatched');
      const recovered=await s.preview(); assert.equal(recovered.previewHash,p.previewHash);
      assert.equal((await s.apply(recovered)).reconciliationRequired,true); assert.equal(s.state.writes,1);
      const result=await suite.runNodeInDatabase(url,`
        const assert=require('node:assert/strict'); const db=require('./src/db/pool'); let writes=0;
        require('./src/services/magento/test-deletion.service').apply(${JSON.stringify(config)},
          ${JSON.stringify({productId:s.product.id,previewHash:p.previewHash,confirmation:s.sku})},
          {mutationContext:{actorUserId:${actor.id}},fetchImpl:async(url,init)=>{
            if(init.method!=='GET'){writes++;throw new Error('No writes after restart');}
            return new Response(JSON.stringify({items:[],total_count:0}),{headers:{'content-type':'application/json'}});
          }}).then(result=>{assert.equal(writes,0);assert.equal(result.state,'finalized');})
          .catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>db.end());`);
      assert.equal(result.stderr,''); assert.equal(s.state.writes,1);
    });
    await t.test('already absent finalizes with zero DELETE and identity mismatch blocks', async () => {
      const s=await scenario(); s.state.remote=null;
      assert.equal((await s.apply(await s.preview())).state,'finalized'); assert.equal(s.state.writes,0);
      const mismatch=await scenario(); mismatch.state.remote.id++;
      await assert.rejects(mismatch.preview(),{code:'TEST_DELETE_REMOTE_IDENTITY_CHANGED'}); assert.equal(mismatch.state.writes,0);
      const changed=await scenario(); const p=await changed.preview(); changed.state.remote.id++;
      await assert.rejects(changed.apply(p),{code:'TEST_DELETE_REMOTE_IDENTITY_CHANGED'}); assert.equal(changed.state.writes,0);
      const manual=await scenario(); await db.query('DELETE FROM magento_product_sync_requests WHERE product_id=$1',[manual.product.id]);
      const review=await manual.preview(); manual.state.noMutation=true;
      assert.equal((await manual.apply(review)).state,'dispatched');
      assert.ok((await require('../src/services/magento/sync-problems').problems(config,db)).some((item)=>
        item.productId===manual.product.id && item.problems[0].code==='TEST_DELETION_PENDING'));
      assert.equal((await require('../src/services/magento/automatic-sync-status').readStatuses(db,[manual.product.id])).get(manual.product.id).state,'needs_attention');
      manual.state.remote=null; assert.equal((await manual.apply(review)).state,'finalized'); assert.equal(manual.state.writes,1);
    });
    await t.test('concurrent apply has one intent and one dispatch; product writes and business references are fenced', async () => {
      const s=await scenario(); const p=await s.preview(); let release; let entered;
      const waiting=new Promise((r)=>{entered=r;}); const barrier=new Promise((r)=>{release=r;});
      s.state.onWrite=async()=>{entered();await barrier;};
      const first=s.apply(p); await waiting;
      try {
        await assert.rejects(s.apply(p),{code:'TEST_DELETE_BUSY'});
        await assert.rejects(db.query('INSERT INTO product_export_revisions(product_id) VALUES($1)',[s.product.id]),/business evidence/);
        await assert.rejects(db.query("UPDATE products SET status='archived',exclude_from_export=1 WHERE id=$1",[s.product.id]),/frozen/);
      } finally { release(); }
      assert.equal((await first).state,'finalized'); assert.equal(s.state.writes,1);
      assert.equal((await db.query('SELECT 1 FROM magento_test_deletions WHERE product_id=$1',[s.product.id])).rowCount,1);
    });
    await t.test('legacy, sale-enabled remote, price, correction, export and repricing evidence fail closed', async () => {
      await assert.rejects(service.preview(config,{productId:legacy.id},mutations),{code:'TEST_DELETE_LEGACY_IDENTITY'});
      const sale=await scenario(); sale.state.remote.status=1;
      await assert.rejects(sale.preview(),{code:'TEST_DELETE_REMOTE_NOT_DISABLED'});
      const price=await scenario(); await db.query('INSERT INTO product_export_revisions(product_id) VALUES($1)',[price.product.id]);
      await assert.rejects(price.preview(),{code:'TEST_DELETE_BUSINESS_EVIDENCE'});
      const correction=await scenario(); await db.query("UPDATE products SET corrected_from_product_id=$1 WHERE id=$2",[legacy.id,correction.product.id]);
      await assert.rejects(correction.preview(),{code:'TEST_DELETE_NOT_CURRENT'});
      const exported=await scenario(); await db.query("UPDATE product_full_export_state SET confirmed_revision=1 WHERE product_id=$1",[exported.product.id]);
      await assert.rejects(exported.preview(),{code:'TEST_DELETE_LIFECYCLE_EVIDENCE'});
      const history=await scenario(); await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id)
        VALUES('product.price_changed',$1,'{"displayName":"Test","preferredUsername":null}','product',$2)`,[actor.id,String(history.product.id)]);
      await assert.rejects(history.preview(),{code:'TEST_DELETE_BUSINESS_EVIDENCE'});
      const requested=await scenario(); await db.query(`INSERT INTO correction_requests
        (source_product_id,category_code,source_sku,proposed_sku,old_payload,proposed_payload,preview_signature)
        VALUES($1,'ZZ',$2,NULL,'{}','{}','test')`,[requested.product.id,requested.sku]);
      await assert.rejects(requested.preview(),{code:'TEST_DELETE_BUSINESS_EVIDENCE'});
      const repriced=await scenario(); const batch=(await db.query(`INSERT INTO repricing_batches(scenario_name,preview_token)
        VALUES('Test',$1) RETURNING id`,[crypto.randomUUID()])).rows[0];
      await db.query(`INSERT INTO repricing_items(batch_id,product_id,sku,new_price_uah,price_delta_uah,old_payload,new_payload)
        VALUES($1,$2,$3,100,0,'{}','{}')`,[batch.id,repriced.product.id,repriced.sku]);
      await assert.rejects(repriced.preview(),{code:'TEST_DELETE_BUSINESS_EVIDENCE'});
      const snapshot=await scenario(); const snapshotId=crypto.randomUUID();
      await db.query(`WITH snapshot AS (INSERT INTO export_snapshots(id,idempotency_key,from_sku,resolved_to_sku,exported_to_product_id,
        row_count,file_name,csv_content,full_product_lifecycle_version) VALUES($1,$1,$2,$2,$3,1,'test.csv','test',1) RETURNING id)
        INSERT INTO export_snapshot_products(snapshot_id,product_id,sku_at_capture,capture_kind,evidence_origin,evidence_hash)
        SELECT id,$3,$2,'legacy_compatibility','live_capture',$4 FROM snapshot`,
      [snapshotId,snapshot.sku,snapshot.product.id,hash({})]);
      await assert.rejects(snapshot.preview(),{code:'TEST_DELETE_BUSINESS_EVIDENCE'});
      const unresolved=await scenario();
      await db.query(`INSERT INTO magento_sync_jobs(id,product_id,public_product_identity_id,sku,installation_key,origin_hash,
        binding_revision_id,binding_hash,amber_hash,plan_hash,intent,baseline,created_by_user_id,state)
        SELECT $1,product_id,public_product_identity_id,sku,installation_key,origin_hash,binding_revision_id,binding_hash,
          $2,plan_hash,intent,baseline,created_by_user_id,'uncertain' FROM magento_sync_jobs WHERE id=$3`,
      [crypto.randomUUID(),hash({pending:true}),unresolved.jobId]);
      await assert.rejects(unresolved.preview(),{code:'TEST_DELETE_UNRESOLVED_SYNC'});
    });
    await t.test('FK reference races serialize with sealing in both commit orders', async () => {
      const sealed=await scenario(); const seal=await db.connect(); const writer=await db.connect();
      try {
        await seal.query('BEGIN'); await seal.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[sealed.product.id]);
        await seal.query(`INSERT INTO magento_test_deletions(id,product_id,public_product_identity_id,public_sku,internal_sku,
          origin_hash,remote_product_id,create_job_id,actor_user_id,local_hash,remote_hash,preview_hash)
          SELECT $1,$2,$3,$4,$5,origin_hash,$6,$7,actor_user_id,local_hash,remote_hash,preview_hash
          FROM magento_test_deletions LIMIT 1`,[crypto.randomUUID(),sealed.product.id,sealed.product.public_product_identity_id,
          sealed.sku,sealed.product.full_sku,sealed.state.remote.id,sealed.jobId]);
        let settled=false;
        const pending=writer.query('INSERT INTO product_export_revisions(product_id) VALUES($1)',[sealed.product.id])
          .then(()=>{settled=true;return null;},e=>{settled=true;return e;});
        await new Promise(r=>setTimeout(r,80)); assert.equal(settled,false);
        await seal.query('COMMIT'); assert.match((await pending).message,/business evidence/);
        assert.equal((await db.query('SELECT 1 FROM product_export_revisions WHERE product_id=$1',[sealed.product.id])).rowCount,0);
        const referenced=await scenario(); const p=await referenced.preview();
        await writer.query('BEGIN'); await writer.query('INSERT INTO product_export_revisions(product_id) VALUES($1)',[referenced.product.id]);
        settled=false; const applying=referenced.apply(p).then(()=>{settled=true;return null;},e=>{settled=true;return e;});
        await new Promise(r=>setTimeout(r,80)); assert.equal(settled,false);
        await writer.query('COMMIT'); assert.equal((await applying).code,'TEST_DELETE_BUSINESS_EVIDENCE');
        assert.equal((await db.query('SELECT 1 FROM magento_test_deletions WHERE product_id=$1',[referenced.product.id])).rowCount,0);
        assert.equal(referenced.state.writes,0);
      } finally { await seal.query('ROLLBACK'); await writer.query('ROLLBACK'); seal.release();writer.release(); }
    });
    await t.test('actor revalidation, exact confirmation, and Administrator-only permission mapping', async () => {
      const s=await scenario(); const p=await s.preview();
      await assert.rejects(service.apply(config,{productId:s.product.id,previewHash:p.previewHash,confirmation:'INVALID-LEGACY-CONFIRMATION'},s.options),{code:'TEST_DELETE_CONFIRMATION_REQUIRED'});
      await assert.rejects(s.apply(p,{mutationContext:{actorUserId:999999}}),{code:'ADMIN_PERMISSION_REVOKED'});
      for(const role of ['manager','storekeeper']) await assert.rejects(db.query(`INSERT INTO role_permissions(role_id,permission_key)
        SELECT id,'products.delete_test' FROM roles WHERE role_key=$1`,[role]),/reserved/);
      assert.equal(s.state.writes,0);
    });
    await t.test('active lifecycle: failed final audit rolls back tombstone and recovery consumes verified absence without DELETE', async () => {
      const s=await scenario(); const p=await s.preview();
      const activation=await db.connect();
      try {
        await activation.query('BEGIN'); await activation.query("SET LOCAL amber.lifecycle_maintenance='on'");
        await activation.query("UPDATE full_product_export_activation SET phase='preparing',generation=generation+1 WHERE singleton");
        await activation.query(`UPDATE full_product_export_activation SET phase='active',selector_version=1,
          manifest_hash=$1,approval_event_id=$2,activation_event_id=$2,generation=generation+1 WHERE singleton`,[hash({active:true}),event]);
        await activation.query('COMMIT');
      } catch(error) { await activation.query('ROLLBACK'); throw error; }
      finally { activation.release(); }
      await db.query(`CREATE FUNCTION reject_test_final_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_key='product.test_delete_finalized' THEN RAISE EXCEPTION 'injected final audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_test_final_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_test_final_audit()`);
      try { await assert.rejects(s.apply(p),/injected final audit failure/); }
      finally { await db.query('DROP TRIGGER reject_test_final_audit ON audit_events; DROP FUNCTION reject_test_final_audit()'); }
      assert.equal((await db.query('SELECT status FROM products WHERE id=$1',[s.product.id])).rows[0].status,'active');
      assert.equal((await db.query('SELECT state FROM magento_test_deletions WHERE product_id=$1',[s.product.id])).rows[0].state,'verified');
      assert.equal((await s.apply(p)).state,'finalized'); assert.equal(s.state.writes,1);
    });
    await t.test('070 genuine TEST photo/archive history uses exact verified hide, preserves originals and never relaxes ordinary AG or business guards', async () => {
      const lifecycle=require('../src/services/product-lifecycle-state'),gate=require('../src/services/full-product-cutover-gate');
      async function archive(s){
        const client=await db.connect();let hide;
        try{
          await gate.begin(client,'BEGIN');
          const previous=await lifecycle.readTarget(client,s.product.id,{lock:true,origin:originHash(config.baseUrl)});
          await client.query("UPDATE products SET status='archived',exclude_from_export=1,archived_by_user_id=$2 WHERE id=$1",[s.product.id,actor.id]);
          await require('../src/services/full-product-export.service').retireFullProduct(client,s.product.id);
          hide=await require('../src/services/product-lifecycle.service').queueArchivedVisibility(client,{productId:s.product.id,
            actorUserId:actor.id,mutationContext:mutations.mutationContext,previousProduct:previous.product,previousLifecycle:previous.lifecycle},{config});
          await require('../src/audit/audit-events').writeAuditEvent(client,{mutationContext:mutations.mutationContext,eventKey:'product.archived',subjectType:'product',subjectId:s.product.id});
          await gate.commit(client);
        }catch(e){await gate.rollback(client);throw e;}finally{await gate.release(client);client.release();}
        // Synthetic exact GET receipt, not real-store acceptance. The ordinary
        // archive hook and permanent ledger capture the actual fixture state.
        const observed=await require('../src/services/magento/client').createMagentoClient(config,{fetchImpl:s.options.fetchImpl}).findProductBySku(s.sku);
        assert.equal(observed.status,2);assert.equal(observed.id,s.state.remote.id);
        await db.query("UPDATE product_visibility_intents SET state='verified',previous_remote_status=2,verified_at=CURRENT_TIMESTAMP WHERE id=$1",[hide.intentId]);
        await db.query("UPDATE magento_product_sync_requests SET state='needs_attention',reason_code='product_retired',active_job_id=NULL,active_generation=NULL WHERE product_id=$1",[s.product.id]);
        return hide;
      }
      const s=await scenario({isTestProduct:true}),photoId=crypto.randomUUID();
      const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=','base64');
      await db.query(`INSERT INTO product_photo_assets(id,actor_user_id,request_key,content_hash,mime_type,display_name,content,product_id)
        VALUES($1,$2,$3,$4,'image/png','synthetic TEST.png',$5,$6)`,[photoId,actor.id,crypto.randomUUID(),crypto.createHash('sha256').update(bytes).digest('hex'),bytes,s.product.id]);
      await db.query('INSERT INTO product_photo_sets(product_id,version,photo_ids,enable_when_verified) VALUES($1,1,$2,FALSE)',[s.product.id,[photoId]]);
      await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id)
        VALUES('product.photos_saved',$1,'{"displayName":"Test","preferredUsername":null}','product',$2)`,[actor.id,String(s.product.id)]);
      const hide=await archive(s),photoBefore=(await db.query('SELECT * FROM product_photo_assets WHERE id=$1',[photoId])).rows[0];
      const galleryBefore=(await db.query('SELECT * FROM product_photo_sets WHERE product_id=$1',[s.product.id])).rows[0];
      const before=(await db.query('SELECT * FROM magento_sync_jobs WHERE id=$1',[s.jobId])).rows[0];
      const archivedBefore=(await db.query('SELECT * FROM products WHERE id=$1',[s.product.id])).rows[0];
      const lifecycleBefore=(await db.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[s.product.id])).rows[0];
      const p=await s.preview();assert.equal((await s.apply(p)).state,'finalized');assert.equal(s.state.writes,1);
      assert.deepEqual((await db.query('SELECT * FROM products WHERE id=$1',[s.product.id])).rows[0],archivedBefore);
      assert.deepEqual((await db.query('SELECT * FROM product_full_export_state WHERE product_id=$1',[s.product.id])).rows[0],lifecycleBefore);
      assert.equal((await db.query('SELECT state FROM magento_product_sync_requests WHERE product_id=$1',[s.product.id])).rows[0].state,'voided');
      assert.equal((await s.apply(p)).state,'finalized');assert.equal(s.state.writes,1);
      const restoreClient=await db.connect();
      try { await gate.begin(restoreClient); await assert.rejects(restoreClient.query("UPDATE products SET status='active' WHERE id=$1",[s.product.id]),/frozen/); }
      finally { await gate.rollback(restoreClient); await gate.release(restoreClient);restoreClient.release(); }
      assert.deepEqual((await db.query('SELECT * FROM product_photo_assets WHERE id=$1',[photoId])).rows[0],photoBefore);
      assert.deepEqual((await db.query('SELECT * FROM product_photo_sets WHERE product_id=$1',[s.product.id])).rows[0],galleryBefore);
      assert.deepEqual((await db.query('SELECT * FROM magento_sync_jobs WHERE id=$1',[s.jobId])).rows[0],before);
      assert.equal((await db.query('SELECT state FROM product_visibility_intents WHERE id=$1',[hide.intentId])).rows[0].state,'verified');
      await assert.rejects(db.query('UPDATE product_photo_sets SET version=version+1 WHERE product_id=$1',[s.product.id]),/freezes media/);
      const ordinary=await scenario();await archive(ordinary);await assert.rejects(ordinary.preview(),{code:'TEST_DELETE_NOT_CURRENT'});assert.equal(ordinary.state.writes,0);
      const unknown=await scenario({isTestProduct:true});await archive(unknown);
      await db.query(`INSERT INTO audit_events(event_key,actor_user_id,actor_snapshot,subject_type,subject_id)
        VALUES('product.price_changed',$1,'{"displayName":"Test","preferredUsername":null}','product',$2)`,[actor.id,String(unknown.product.id)]);
      await assert.rejects(unknown.preview(),{code:'TEST_DELETE_BUSINESS_EVIDENCE'});assert.equal(unknown.state.writes,0);
      const sale=await scenario({isTestProduct:true});await archive(sale);sale.state.remote.status=1;
      await assert.rejects(sale.preview(),{code:'TEST_DELETE_REMOTE_NOT_DISABLED'});assert.equal(sale.state.writes,0);
      const stale=await scenario({isTestProduct:true});await archive(stale);
      const staleClient=await db.connect();
      try { await gate.begin(staleClient); await staleClient.query('UPDATE products SET total_price_uah=101 WHERE id=$1',[stale.product.id]); await gate.commit(staleClient); }
      catch(error) { await gate.rollback(staleClient); throw error; }
      finally { await gate.release(staleClient); staleClient.release(); }
      await assert.rejects(stale.preview(),{code:'TEST_DELETE_ARCHIVE_PROOF_REQUIRED'});assert.equal(stale.state.writes,0);
    });
  } finally { await db.end(); await suite.dropTestDatabase(name); }
});
