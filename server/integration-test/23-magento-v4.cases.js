const { test, assert, Pool, fs, os, path, serverRoot, runNodeInDatabase,
  recreateTestDatabase, dropTestDatabase } = require('./suite-context');
const templates = require('../src/services/export-templates/template.service');
const bindings = require('../src/services/magento/binding.service');
const fixture = require('../test/fixtures/magento-v4');
const legacy = require('../test/fixtures/magento-bindings');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { getMigrationChecksum } = require('../src/db/run-migrations');

test('v4 migration: 050 upgrade, rollback, frozen publications, declared categories and immutable evidence', async () => {
  const name = 'amber_magento_v4_test'; const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-v4-050-'));
  const db = new Pool({ connectionString: url });
  const migrate = () => runNodeInDatabase(url, `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
  try {
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations'))).filter((f) => f.endsWith('.sql') && f < '051')) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    await migrate();
    const actor = (await db.query("INSERT INTO application_users(status,display_name) VALUES('active','V4 test administrator') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO user_role_assignments(application_user_id,role_id) SELECT $1,id FROM roles WHERE role_key='administrator'", [actor]);
    const options = { databasePool: db, mutationContext: { actorUserId: Number(actor), requestId: 'v4-test' } };
    for (const group of ['BR', 'NM', 'KL', 'CH', 'AR', 'SV', 'XG']) {
      await db.query('INSERT INTO categories(code,name) VALUES($1,$1)', [group]);
    }
    const publishTemplate = async (key, definition) => {
      const family = await templates.createTemplate({ key, displayName: key, definition }, options);
      return templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options);
    };
    const create = (key, version, schema) => bindings.createDraft({ installationKey: key, origin: 'https://v4.example.invalid',
      templateVersionId: version.id, observedAt: '2026-10-01T00:00:00.000Z', schema }, options);
    const d = structuredClone(legacy.definition());
    d.sources = { sku: d.sources.sku }; d.tables = {}; d.questionContracts = {};
    for (const g of d.groups) for (const r of g.rows) {
      delete r.cells.kolir; delete r.cells.dovzhyna_brasletu_diuimiv; delete r.cells.decor_weight;
    }
    const published = [];
    for (const version of [1, 2, 3]) {
      const def = structuredClone(d); def.evaluatorVersion = `magento-declarative-${version}`;
      if (version === 2) def.sourceSupport = { version: 'historical-source-support-v1', sources: {} };
      if (version === 3) { def.sourceContractVersion = 'public-product-identity-v1'; def.sources.sku.field = 'public_sku'; }
      const v = await publishTemplate(`v${version}-frozen`, def);
      const draft = await create(`v${version}-frozen`, v, legacy.schema());
      const saved = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: legacy.approvedBindings(def) }, options);
      published.push(await bindings.publishDraft(saved.id, { expectedRevision: saved.revision, expectedCurrentId: null }, options));
    }
    const snapshot = async () => ({
      bindingViews: await Promise.all(published.map((r) => bindings.getRevision(r.id, { databasePool: db }))),
      templates: (await db.query('SELECT * FROM export_template_versions ORDER BY id')).rows,
      revisions: (await db.query('SELECT * FROM magento_binding_revisions ORDER BY id')).rows,
      routes: (await db.query('SELECT * FROM magento_binding_routes ORDER BY revision_id,route_key')).rows,
      options: (await db.query('SELECT * FROM magento_binding_options ORDER BY revision_id,binding_key,source_key')).rows,
      activation: (await db.query('SELECT * FROM export_template_activation')).rows,
      audit: (await db.query('SELECT * FROM audit_events ORDER BY id')).rows,
    });
    const frozen = await snapshot(); const ledger = (await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    const file = '051_magento_extensible_categories.sql'; const sql = await fs.readFile(path.join(serverRoot, 'migrations', file), 'utf8');
    await fs.writeFile(path.join(directory, file), sql + '\nSELECT 1/0;');
    await assert.rejects(migrate(), /division by zero/);
    assert.equal((await db.query("SELECT count(*)::int n FROM pg_proc WHERE proname='check_magento_extensible_category'")).rows[0].n, 0);
    assert.deepEqual(await snapshot(), frozen);
    assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows, ledger);
    await fs.writeFile(path.join(directory, file), sql); await migrate(); await migrate();
    assert.deepEqual(await snapshot(), frozen);
    assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name<'051' ORDER BY name")).rows, ledger);
    assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE name=$1', [file])).rows[0].checksum, getMigrationChecksum(sql));
    for (const r of published) assert.equal((await bindings.getRevision(r.id, { databasePool: db })).state, 'published');
    const oldDraft = await create('legacy-no-new-group', { id: published[0].templateVersionId }, legacy.schema());
    await assert.rejects(db.query(`INSERT INTO magento_binding_routes(revision_id,route_key,amber_group,predicates,enabled,review_state)
      VALUES($1,'XG:all','XG','[]',false,'review_required')`, [oldDraft.id]), /declared v4 template group/);

    const q = (await db.query(`INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required)
      VALUES('XG','new_color','New color','options',1,1),('XG','new_note','New note','text',0,0) RETURNING id,key`)).rows;
    await db.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,7,'91','Explicit Amber label')", [q.find((r) => r.key === 'new_color').id]);
    // A configured SKU option alone is not publication evidence.
    const f = await templates.createTemplate({ key: 'v4-new-category', displayName: 'New category', definition: fixture.definition() }, options);
    await assert.rejects(templates.publishTemplate(f.id, { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash }, options), { code: 'TEMPLATE_SOURCE_INVALID' });
    // Use the existing authoritative SKU publisher, rather than manufacture historical proof.
    await runNodeInDatabase(url, `require('./src/services/sku-schema.service').publishSkuSchema('XG',{mutationContext:{actorUserId:${Number(actor)}}}).catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>require('./src/db/pool').end());`);
    const v = await templates.publishTemplate(f.id, { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash }, options);
    assert.equal(v.definitionHash, compileDefinition(fixture.definition()).hash);
    const draft = await create('v4-new-category', v, fixture.observation());
    await assert.rejects(db.query(`INSERT INTO magento_binding_routes(revision_id,route_key,amber_group,predicates,enabled,review_state)
      VALUES($1,'OTHER:all','OTHER','[]',false,'review_required')`, [draft.id]), /declared v4 template group/);
    await assert.rejects(bindings.updateDraft(draft.id, { expectedRevision: '999', bindings: legacy.editable(fixture.approvedBindings()) }, options), { code: 'MAGENTO_BINDING_CONFLICT' });
    assert.equal((await bindings.getRevision(draft.id, { databasePool: db })).revision, draft.revision);
    const saved = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: legacy.editable(fixture.approvedBindings()) }, options);
    assert.equal((await bindings.validateDraft(saved.id, { databasePool: db })).valid, true);
    const current = await bindings.publishDraft(saved.id, { expectedRevision: saved.revision, expectedCurrentId: null }, options);
    const semantic = (await db.query("SELECT amber_group,question_key,value_id,option_id,sku_code_evidence FROM magento_binding_options WHERE revision_id=$1 AND source_kind='semantic'", [current.id])).rows;
    assert.deepEqual(semantic, [{ amber_group: 'XG', question_key: 'new_color', value_id: 7, option_id: 'red-id', sku_code_evidence: '91' }]);
    const evidence = await require('../src/services/magento/binding-evidence-db').readAmberEvidence(db, { templateVersionId: v.id });
    assert.ok(evidence.current.some((q) => q.category_code === 'XG' && q.key === 'new_color'));
    assert.ok(evidence.historical.some((q) => q.category_code === 'XG' && q.key === 'new_color'));
    assert.deepEqual(evidence.plans.map((p) => p.amberGroup), ['XG']);
    await assert.rejects(db.query("UPDATE magento_binding_routes SET enabled=false WHERE revision_id=$1", [current.id]), /immutable/);
    await assert.rejects(db.query("UPDATE export_template_versions SET definition='{}' WHERE id=$1", [v.id]), /immutable/);
    await assert.rejects(bindings.updateDraft(current.id, { expectedRevision: current.revision, bindings: legacy.editable(fixture.approvedBindings()) }, options), { code: 'MAGENTO_BINDING_CONFLICT' });
  } finally {
    await db.end(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('amber-v4-050-'));
    await fs.rm(directory, { recursive: true, force: true }); await dropTestDatabase(name);
  }
});
