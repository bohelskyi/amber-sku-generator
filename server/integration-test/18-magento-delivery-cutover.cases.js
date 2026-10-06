const suite = require('./suite-context');

suite.test('Magento delivery migration 045 upgrades checkpoint 044 atomically and starts with CSV enabled', async () => {
  const { assert, Pool, fs, os, path, serverRoot, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = suite;
  const name = 'amber_magento_delivery_migration_test'; const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-delivery-044-')); const db = new Pool({ connectionString: url });
  const migrate = () => runNodeInDatabase(url, `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
  try {
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations'))).filter((file) => file.endsWith('.sql') && file < '045')) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    await migrate(); const before = (await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    const file = '045_magento_delivery_cutover.sql'; const sql = await fs.readFile(path.join(serverRoot, 'migrations', file), 'utf8');
    await fs.writeFile(path.join(directory, file), `${sql}\nSELECT 1/0;`);
    await assert.rejects(migrate(), /division by zero/);
    assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows, before);
    assert.equal((await db.query(`SELECT count(*)::int n FROM information_schema.columns
      WHERE table_name='magento_auto_sync_activation' AND column_name='legacy_product_csv_enabled'`)).rows[0].n, 0);
    await fs.writeFile(path.join(directory, file), sql); await migrate(); await migrate();
    assert.deepEqual((await db.query(`SELECT enabled,legacy_product_csv_enabled,installation_key,cutover_at
      FROM magento_auto_sync_activation`)).rows[0], { enabled: false, legacy_product_csv_enabled: true,
      installation_key: null, cutover_at: null });
  } finally {
    await db.end(); await fs.rm(directory, { recursive: true, force: true }); await dropTestDatabase(name);
  }
});

suite.test('Magento delivery cutover is previewed, atomic, persistent and permanently retires product CSV creation', async () => {
  const { assert, Pool, crypto, recreateTestDatabase, dropTestDatabase, runNodeInDatabase } = suite;
  const name = 'amber_magento_delivery_cutover_test'; const url = await recreateTestDatabase(name);
  const db = new Pool({ connectionString: url });
  try {
    await runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    const actor = (await db.query(`INSERT INTO application_users(status,display_name,activated_at)
      VALUES('active','Cutover actor',CURRENT_TIMESTAMP) RETURNING id`)).rows[0];
    await db.query(`INSERT INTO user_role_assignments(application_user_id,role_id)
      SELECT $1,id FROM roles WHERE role_key='administrator'`, [actor.id]);
    const service = require('../src/services/magento/delivery-cutover.service');
    const exportService = require('../src/services/export.service');
    assert.deepEqual((await exportService.getExportStatus({ databasePool: db })).delivery,
      { legacyProductCsvEnabled: true, automaticSyncEnabled: false });
    const contract = require('../src/services/magento/binding-contract');
    const input = { expectedDatabase: name, installationKey: 'production', actorUserId: Number(actor.id),
      origin: 'https://cutover.example.invalid' };
    const before = (await db.query('SELECT * FROM magento_auto_sync_activation')).rows[0];
    const blocked = await service.preflight(input, { databasePool: db });
    assert.ok(blocked.blockers.some((item) => item.code === 'MAGENTO_CUTOVER_PUBLICATION_REQUIRED'));
    assert.ok(blocked.blockers.some((item) => item.code === 'MAGENTO_CUTOVER_PUBLIC_SKU_ACTIVATION_REQUIRED'));
    assert.deepEqual((await db.query('SELECT * FROM magento_auto_sync_activation')).rows[0], before, 'preflight is mutation-free');
    await assert.rejects(service.apply({ ...input, planHash: blocked.planHash }, { databasePool: db,
      mutationContext: { actorUserId: Number(actor.id) } }), { code: 'MAGENTO_CUTOVER_BLOCKED' });
    assert.deepEqual((await db.query('SELECT * FROM magento_auto_sync_activation')).rows[0], before, 'failed apply changes neither mechanism');

    const templateId = crypto.randomUUID(); const versionId = crypto.randomUUID(); const bindingId = crypto.randomUUID();
    const definition = { formatVersion: 1, evaluatorVersion: 'magento-declarative-3',
      outputContract: 'magento-products-v1', sourceContractVersion: 'public-product-identity-v1' };
    const definitionHash = contract.hash(definition);
    await db.query(`INSERT INTO export_templates(id,template_key,display_name,created_by_user_id)
      VALUES($1,'cutover-test','Cutover test',$2)`, [templateId, actor.id]);
    await db.query(`INSERT INTO export_template_drafts(template_id,definition,modified_by_user_id)
      VALUES($1,$2::jsonb,$3)`, [templateId, JSON.stringify(definition), actor.id]);
    await db.query(`INSERT INTO export_template_versions(id,template_id,version_number,source_draft_revision,definition,definition_hash,
        format_version,evaluator_version,output_contract,published_by_user_id)
      VALUES($4,$1,1,1,$2::jsonb,$5,1,'magento-declarative-3','magento-products-v1',$3)`,
    [templateId, JSON.stringify(definition), actor.id, versionId, definitionHash]);
    await db.query(`INSERT INTO magento_binding_revisions(id,installation_key,origin_hash,template_id,template_version_id,
      template_definition_hash,evaluator_version,output_contract,format_version,schema_fingerprint,topology_fingerprint,
      observed_at,observation_store_code,created_by_user_id,modified_by_user_id)
      VALUES($1,'production',$2,$3,$4,$5,'magento-declarative-3','magento-products-v1',1,$6,$6,CURRENT_TIMESTAMP,'all',$7,$7)`,
    [bindingId, contract.originHash(input.origin), templateId, versionId, definitionHash, '0'.repeat(64), actor.id]);
    await db.query(`UPDATE magento_binding_revisions SET state='published',revision=2,version_number=1,
      published_by_user_id=$2,published_at=CURRENT_TIMESTAMP,modified_by_user_id=$2,modified_at=CURRENT_TIMESTAMP WHERE id=$1`,
    [bindingId, actor.id]);
    const publicService = require('../src/services/public-sku-activation.service');
    const publicPreflight = await publicService.preflight({ expectedDatabase: name, actorUserId: Number(actor.id) },
      { databasePool: db });
    assert.deepEqual(publicPreflight.blockers, []);
    await publicService.apply({ expectedDatabase: name, actorUserId: Number(actor.id), planHash: publicPreflight.planHash },
      { databasePool: db, mutationContext: { actorUserId: Number(actor.id), requestId: 'public-sku-cutover-test' } });
    const ready = await service.preflight(input, { databasePool: db });
    assert.deepEqual(ready.blockers, []);
    const applied = await service.apply({ ...input, planHash: ready.planHash }, { databasePool: db,
      mutationContext: { actorUserId: Number(actor.id), requestId: 'cutover-test' } });
    assert.equal(applied.enabled, true); assert.equal(applied.legacyProductCsvEnabled, false);
    const restarted = new Pool({ connectionString: url });
    try {
      const persisted = (await restarted.query('SELECT enabled,legacy_product_csv_enabled,installation_key FROM magento_auto_sync_activation')).rows[0];
      assert.deepEqual(persisted, { enabled: true, legacy_product_csv_enabled: false, installation_key: 'production' });
    } finally { await restarted.end(); }
    await db.query("INSERT INTO categories(code,name) VALUES('ZZ','Cutover')");
    const client = await db.connect();
    let productId;
    try {
      await client.query('BEGIN');
      productId = (await require('./product-fixture').insertNativeProductFixture(client, { category: 'ZZ' })).rows[0].id;
      await client.query('COMMIT');
    } finally { client.release(); }
    assert.equal((await db.query('SELECT desired_generation FROM magento_product_sync_requests WHERE product_id=$1', [productId])).rows[0].desired_generation, '1');
    const lifecycle = (await db.query('SELECT revision,confirmed_revision,csv_retired_revision FROM product_full_export_state WHERE product_id=$1', [productId])).rows[0];
    assert.deepEqual(lifecycle, { revision: '1', confirmed_revision: '0', csv_retired_revision: '1' });
    await assert.rejects(db.query(`INSERT INTO magento_export_artifacts
      (snapshot_id,profile_version,group_code,file_name,csv_content,product_count,row_count)
      VALUES('00000000-0000-0000-0000-000000000000','v1','ZZ','blocked.csv','x',1,1)`), /retired/);
    await service.disable({ expectedDatabase: name, actorUserId: Number(actor.id), reason: 'Emergency test stop' },
      { databasePool: db, mutationContext: { actorUserId: Number(actor.id) } });
    const disabled = (await db.query('SELECT enabled,legacy_product_csv_enabled FROM magento_auto_sync_activation')).rows[0];
    assert.deepEqual(disabled, { enabled: false, legacy_product_csv_enabled: false });
    const presentation = await exportService.getExportStatus({ databasePool: db });
    assert.deepEqual(presentation.delivery, { legacyProductCsvEnabled: false, automaticSyncEnabled: false });
    assert.deepEqual(Object.keys(presentation.delivery).sort(), ['automaticSyncEnabled', 'legacyProductCsvEnabled']);
  } finally { await db.end(); await dropTestDatabase(name); }
});
