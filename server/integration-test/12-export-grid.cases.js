const { insertProductFixture } = require('./product-fixture');
const { test, assert, pool, crypto, request, authenticateApplicationSession, Pool, fs, path, os, serverRoot, runNodeInDatabase, recreateTestDatabase, dropTestDatabase } = require('./suite-context');
const templates = require('../src/services/export-templates/template.service');
const exportsService = require('../src/services/export.service');
const sessions = require('../src/services/export-sessions.service');
const { definition, installGoldenEvidence } = require('./12-export-templates.cases');
const { product } = require('../test/fixtures/magento-v1/contract');
const pre = (d) => ({ expectedRevision: d.revision, expectedDefinitionHash: d.definitionHash });
test('GRID system view is read-only; CAS upgrade, custom source, published/session preview and stored CSV stay identical', async () => {
  const admin = await authenticateApplicationSession(); const opts = { mutationContext: { actorUserId: admin.applicationUser.id } };
  const before = (await pool.query('SELECT count(*) FROM export_templates')).rows[0].count;
  const system = await request('/api/admin/export-templates/system', { authentication: admin });
  assert.equal(system.response.status, 200); assert.equal(system.data.kind, 'system');
  assert.equal(system.data.definition.groups.length, 6); assert.equal(system.data.versionId, undefined);
  assert.equal((await pool.query('SELECT count(*) FROM export_templates')).rows[0].count, before);
  await pool.query("INSERT INTO questions(category_code,key,label,sku_index,display_order,required,include_in_sku,input_type) VALUES('BR','synthetic_grid_note','Synthetic',0,999,0,0,'text')");
  await installGoldenEvidence();
  const d = definition('GRID product');
  const f = await templates.createTemplate({ key: 'grid-' + crypto.randomUUID(), displayName: 'Synthetic grid', definition: d }, opts);
  let draft = await templates.upgradeDraft(f.id, pre(f.draft), opts);
  await assert.rejects(templates.upgradeDraft(f.id, pre(f.draft), opts), (e) => e.code === 'TEMPLATE_DRAFT_CONFLICT');
  const same = await templates.upgradeDraft(f.id, pre(draft), opts); assert.equal(same.revision, draft.revision);
  const custom = structuredClone(draft.definition);
  custom.sources.grid = { kind: 'information', category: 'BR', key: 'synthetic_grid_note', type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] };
  custom.groups[0].columns.splice(2, 0, 'synthetic_target');
  custom.groups[0].rows[0].cells.synthetic_target = { op: 'text', input: { op: 'source', id: 'grid' }, trim: false, format: 'scalar-v1', onAbsent: 'empty' };
  custom.groups[0].rows[1].cells.synthetic_target = { op: 'literal', value: 'EN independent' };
  draft = await templates.saveDraft(f.id, { expectedRevision: draft.revision, definition: custom }, opts);
  const bad = structuredClone(custom); bad.groups[0].columns = bad.groups[0].columns.filter((c) => c !== 'sku');
  await assert.rejects(templates.saveDraft(f.id, { expectedRevision: draft.revision, definition: bad }, opts), (e) => e.code === 'TEMPLATE_INVALID');
  const malformed = structuredClone(custom); malformed.groups[0] = null;
  await assert.rejects(templates.saveDraft(f.id, { expectedRevision: draft.revision, definition: malformed }, opts), (e) => e.code === 'TEMPLATE_INVALID');
  const v = await templates.publishTemplate(f.id, pre(draft), opts);
  const sku = ('BR-GRID-' + crypto.randomUUID()).toUpperCase();
  const p = (await insertProductFixture(pool,"INSERT INTO products(full_sku,base_sku,category,weight,total_price_uah,details) VALUES($1,$1,'BR',12,450,$2::jsonb) RETURNING *", [sku, JSON.stringify({ answers: { synthetic_grid_note: `=SUM(1,2)
"literal"` } })])).rows[0];
  const input = { requestContract: 'template-v1', fromSku: sku, toSku: sku, selection: { mode: 'explicit', templateId: f.id, versionId: v.id } };
  const preview = await exportsService.previewExport(input, opts);
  assert.match(preview.artifacts[0].csvContent, /^sku,store_view_code,synthetic_target,name/);
  assert.match(preview.artifacts[0].csvContent, /EN independent/);
  const sample = await templates.testPreview(f.id, { ...pre(draft), productIds: [p.id] }, opts);
  assert.equal(sample.result.artifacts[0].csvContent, preview.artifacts[0].csvContent);
  const direct = await exportsService.createExportSnapshot({ ...input, previewToken: preview.previewToken, idempotencyKey: crypto.randomUUID() }, opts);
  assert.equal((await exportsService.getMagentoArtifact(direct.id, 'BR', opts)).csv_content, preview.artifacts[0].csvContent);
  const session = await sessions.createSession({ creationKey: crypto.randomUUID(), title: 'Grid session', settings: input }, opts);
  const detail = await sessions.detail(session.id, opts);
  const conditions = { expectedRevision: detail.configurationRevision, expectedAccessEpoch: detail.accessEpoch };
  const sessionPreview = await sessions.previewSession(session.id, opts);
  await assert.rejects(sessions.prepare(session.id, { ...conditions, expectedPreviewFingerprint: '0'.repeat(64) }, opts), (e) => e.code === 'EXPORT_PREVIEW_STALE');
  const attempt = await sessions.prepare(session.id, { ...conditions, expectedPreviewFingerprint: sessionPreview.tableFingerprint }, opts);
  const result = await sessions.generate(session.id, { ...conditions, attemptId: attempt.id }, opts);
  const artifact = await exportsService.getMagentoArtifact(result.id, 'BR', opts);
  assert.equal(artifact.profile_version, 'magento-products-columns-v2');
  assert.equal(artifact.csv_content, preview.artifacts[0].csvContent);
  const download = await request('/api/export/snapshots/' + result.id + '/magento/BR/csv', { authentication: admin });
  assert.equal(download.response.status, 200); assert.equal(download.text, artifact.csv_content);
  await pool.query("UPDATE products SET details=$2::jsonb WHERE id=$1", [p.id, JSON.stringify({ answers: { synthetic_grid_note: 'changed later' } })]);
  assert.equal((await exportsService.getMagentoArtifact(result.id, 'BR', opts)).csv_content, artifact.csv_content);
  assert.equal((await sessions.generate(session.id, { ...conditions, attemptId: attempt.id }, opts)).id, result.id);
});

test('GRID legacy preview expectation rejects changed product and preserves original-key stored bytes', async () => {
  const admin = await authenticateApplicationSession(); const opts = { mutationContext: { actorUserId: admin.applicationUser.id } };
  await installGoldenEvidence();
  const p = product('BR'); const sku = ('BR-GRID-LEGACY-' + crypto.randomUUID()).toUpperCase();
  const row = (await insertProductFixture(pool,"INSERT INTO products(full_sku,base_sku,category,weight,total_price_uah,details) VALUES($1,$1,'BR',$2,$3,$4::jsonb) RETURNING *", [sku,p.weight,p.total_price_uah,JSON.stringify(p.details)])).rows[0];
  const input = { fromSku: sku, toSku: sku };
  const preview = await exportsService.previewExport(input, opts);
  assert.equal(preview.errors.length, 0); assert.ok(preview.previewExpectation);
  await pool.query('UPDATE products SET total_price_uah=total_price_uah+1 WHERE id=$1', [row.id]);
  await assert.rejects(exportsService.createExportSnapshot({ ...input, previewExpectation: preview.previewExpectation, idempotencyKey: crypto.randomUUID() }, opts), (e) => e.code === 'EXPORT_PREVIEW_STALE');
  const fresh = await exportsService.previewExport(input, opts); const key = crypto.randomUUID();
  const snapshot = await exportsService.createExportSnapshot({ ...input, previewExpectation: fresh.previewExpectation, idempotencyKey: key }, opts);
  assert.equal(snapshot.template_version_id, null);
  assert.equal((await exportsService.getMagentoArtifact(snapshot.id,'BR',opts)).csv_content, fresh.artifacts[0].csvContent);
  await pool.query('UPDATE products SET total_price_uah=total_price_uah+1 WHERE id=$1', [row.id]);
  assert.equal((await exportsService.createExportSnapshot({ ...input, previewExpectation: fresh.previewExpectation, idempotencyKey: key }, opts)).id, snapshot.id);
  const compatible = await exportsService.createExportSnapshot({ ...input, idempotencyKey: crypto.randomUUID() }, opts);
  assert.ok(compatible.id);
});

test('GRID migration 037 checkpoint rolls back 038 atomically, upgrades and repeats without changing history', async () => {
  const name = 'amber_grid_upgrade_test';
  const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-grid-migrations-'));
  const db = new Pool({ connectionString: url });
  try {
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations'))).filter((f) => f.endsWith('.sql') && f < '038_')) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    const run = (dir) => runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations(" + (dir ? JSON.stringify({ directory: dir }) : '') + ").catch(e=>{console.error(e);process.exitCode=1})");
    await run(directory);
    const checksums = (await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    await db.query("INSERT INTO export_snapshots(id,idempotency_key,from_sku,resolved_to_sku,exported_to_product_id,row_count,file_name,csv_content) VALUES('old-grid','old-grid','A','A',1,1,'old.csv','old immutable bytes')");
    const file = '038_editable_export_columns.sql';
    const sql = await fs.readFile(path.join(serverRoot, 'migrations', file), 'utf8');
    await fs.writeFile(path.join(directory, file), sql + "\nSELECT 'grid rollback proof'::integer;");
    await assert.rejects(run(directory), /grid rollback proof/);
    assert.equal((await db.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_name='export_snapshots' AND column_name='legacy_preview_fingerprint'")).rows[0].n, 0);
    await run(); await run();
    assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name<'038_' ORDER BY name")).rows, checksums);
    const old = (await db.query("SELECT * FROM export_snapshots WHERE id='old-grid'")).rows[0];
    assert.equal(old.csv_content, 'old immutable bytes'); assert.equal(old.legacy_preview_fingerprint, null);
    await assert.rejects(db.query("UPDATE export_snapshots SET legacy_preview_fingerprint=$1 WHERE id='old-grid'", ['a'.repeat(64)]), /immutable/);
  } finally {
    await db.end();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('amber-grid-migrations-'));
    await fs.rm(directory, { recursive: true, force: true });
    await dropTestDatabase(name);
  }
});
