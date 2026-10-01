const suite = require('./suite-context');
const { test, assert, pool, Pool, crypto, fs, os, path, serverRoot, TEST_DATABASE_URL,
  authenticateApplicationSession, runNodeInDatabase, recreateTestDatabase, dropTestDatabase } = suite;
const bindings = require('../src/services/magento/binding.service');
const templates = require('../src/services/export-templates/template.service');
const { compareRevision } = require('../src/services/magento/binding-drift');
const transfer = require('../src/services/magento/binding-transfer');
const carryForward = require('../src/services/magento/binding-carry-forward');
const { APPLICATION_USER_ADMIN_LOCK_KEY } = require('../src/services/access-admin-transaction');
const fixture = require('../test/fixtures/magento-bindings');
const { getMigrationChecksum } = require('../src/db/run-migrations');

test('Magento binding migration 041: checkpoint 040 rollback, checksum retention, repeated startup and no seeds', async () => {
  const name = 'amber_magento_binding_migration_test'; const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-binding-040-')); const db = new Pool({ connectionString: url });
  const migrate = () => runNodeInDatabase(url, `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
  try {
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations'))).filter((f) => f.endsWith('.sql') && f < '041')) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    await migrate();
    const before = (await db.query('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows;
    const file = '041_magento_binding_revisions.sql'; const sql = await fs.readFile(path.join(serverRoot, 'migrations', file), 'utf8');
    await fs.writeFile(path.join(directory, file), sql + '\nSELECT 1/0;');
    await assert.rejects(migrate(), /division by zero/);
    assert.equal((await db.query("SELECT to_regclass('magento_binding_revisions') AS present")).rows[0].present, null);
    assert.equal((await db.query("SELECT count(*)::int n FROM pg_type WHERE typname='magento_binding_review'")).rows[0].n, 0);
    assert.deepEqual((await db.query('SELECT name, checksum FROM schema_migrations ORDER BY name')).rows, before);
    await fs.writeFile(path.join(directory, file), sql); await migrate(); await migrate();
    const canonical = sql.replace(/\r\n?/g, '\n');
    for (const ending of ['\r\n', '\r']) {
      await fs.writeFile(path.join(directory, file), canonical.replace(/\n/g, ending)); await migrate();
    }
    assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE name=$1', [file])).rows[0].checksum, getMigrationChecksum(canonical));
    assert.deepEqual((await db.query("SELECT name, checksum FROM schema_migrations WHERE name<'041' ORDER BY name")).rows, before);
    assert.equal((await db.query('SELECT count(*)::int n FROM magento_binding_revisions')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int n FROM audit_events')).rows[0].n, 0);
  } finally {
    await db.end();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('amber-binding-040-'));
    await fs.rm(directory, { recursive: true, force: true }); await dropTestDatabase(name);
  }
});

test('Magento migration 043 upgrades 042 atomically, retains checksums and literal route identities on rerun', async () => {
  const name = 'amber_magento_numeric_migration_test'; const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-binding-042-')); const db = new Pool({ connectionString: url });
  const migrate = () => runNodeInDatabase(url, `require('./src/db/run-migrations').runMigrations({directory:${JSON.stringify(directory)}}).catch(e=>{console.error(e);process.exitCode=1;});`);
  const predicate = JSON.stringify([{ questionKey: '2', valueId: '3', equal: true }]);
  const route = () => db.query("SELECT magento_binding_route_key('SV',$1::jsonb) key", [predicate]);
  try {
    for (const file of (await fs.readdir(path.join(serverRoot, 'migrations'))).filter((f) => f.endsWith('.sql') && f < '043')) {
      await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    }
    await migrate();
    const before = (await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
    const constraint = async () => (await db.query("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conname='magento_binding_options_question_key_check'")).rows;
    const oldConstraint = await constraint();
    await assert.rejects(route(), /invalid binding route predicate/);
    const file = '043_magento_literal_question_keys.sql'; const sql = await fs.readFile(path.join(serverRoot, 'migrations', file), 'utf8');
    await fs.writeFile(path.join(directory, file), sql + '\nSELECT 1/0;');
    await assert.rejects(migrate(), /division by zero/);
    assert.deepEqual(await constraint(), oldConstraint);
    await assert.rejects(route(), /invalid binding route predicate/);
    assert.deepEqual((await db.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows, before);
    await fs.writeFile(path.join(directory, file), sql); await migrate(); await migrate();
    assert.equal((await route()).rows[0].key, 'SV.2=value_id:3');
    assert.deepEqual((await db.query("SELECT name,checksum FROM schema_migrations WHERE name<'043' ORDER BY name")).rows, before);
    assert.equal((await db.query('SELECT checksum FROM schema_migrations WHERE name=$1', [file])).rows[0].checksum, getMigrationChecksum(sql));
    for (const key of ['2.3', '2&3', '2=3', '']) await assert.rejects(db.query("SELECT magento_binding_route_key('SV',$1::jsonb)", [JSON.stringify([{ questionKey: key, valueId: '3', equal: true }])]));
  } finally {
    await db.end(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('amber-binding-042-'));
    await fs.rm(directory, { recursive: true, force: true }); await dropTestDatabase(name);
  }
});

test('Magento binding foundation and current migrations apply to a fresh disposable database', async () => {
  const name = 'amber_magento_binding_fresh_test'; const url = await recreateTestDatabase(name);
  const db = new Pool({ connectionString: url });
  try {
    await runNodeInDatabase(url, "require('./src/db/run-migrations').runMigrations().catch(e=>{console.error(e);process.exitCode=1;});");
    assert.equal((await db.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 56);
    assert.equal((await db.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'magento_binding_%'")).rows[0].n, 13);
    assert.equal((await db.query('SELECT count(*)::int n FROM magento_binding_revisions')).rows[0].n, 0);
    for(const table of ['magento_binding_handoffs','magento_binding_handoff_items','magento_binding_name_pins'])assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
  } finally { await db.end(); await dropTestDatabase(name); }
});

test('Magento binding persistence, publication, immutability and real PostgreSQL races', async (t) => {
  const admin = await authenticateApplicationSession();
  const options = (databasePool = pool) => ({ databasePool, mutationContext: { actorUserId: Number(admin.applicationUser.id), requestId: 'binding-integration' } });
  for (const group of ['BR','NM','KL','CH','AR','SV']) await pool.query('INSERT INTO categories(code,name) VALUES($1,$1) ON CONFLICT(code) DO NOTHING', [group]);
  const questions = (await pool.query(`INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required)
    VALUES ('BR','binding_test_semantic','Synthetic binding source','options',0,0),
      ('BR','binding_test_size','Synthetic size source','text',0,0) RETURNING id,key`)).rows;
  const q = questions.find((q) => q.key === 'binding_test_semantic');
  await pool.query(`INSERT INTO options(question_id,value_id,sku_code,label)
    VALUES ($1,7,'91','Local red'),($1,8,'92','Local blue'),($1,9,'93','Different semantic red'),($1,29,'94','Unenumerated current value')`, [q.id]);
  const definition = fixture.definition(); const schema = fixture.schema();
  const family = await templates.createTemplate({ key: `binding-${crypto.randomUUID()}`, displayName: 'Synthetic binding template', definition }, options());
  const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options());
  const create = (key = `fixture-${crypto.randomUUID()}`, observation = schema) => bindings.createDraft({ installationKey: key,
    origin: 'https://binding.example.invalid', templateVersionId: version.id, observedAt: '2026-09-01T00:00:00.000Z', schema: observation }, options());
  const ready = async (key) => { const d = await create(key); return bindings.updateDraft(d.id, { expectedRevision: d.revision, bindings: fixture.approvedBindings(definition, schema) }, options()); };
  const publish = (draft, current = null, db = pool) => bindings.publishDraft(draft.id, { expectedRevision: draft.revision, expectedCurrentId: current }, options(db));
  const countEvents = async (id) => Number((await pool.query("SELECT count(*) n FROM audit_events WHERE subject_id=$1 AND event_key='magento_binding.published'", [id])).rows[0].n);

  await t.test('numeric semantic keys round trip literally, validate and retain publication immutability', async () => {
    const numeric = (await pool.query("INSERT INTO questions(category_code,key,label,input_type,include_in_sku,required) VALUES('BR','2','Numeric identity','options',0,0) RETURNING id")).rows[0];
    await pool.query("INSERT INTO options(question_id,value_id,sku_code,label) VALUES($1,7,'7','Red'),($1,8,'8','Blue'),($1,9,'9','Red again')", [numeric.id]);
    const d = structuredClone(definition); d.sources.color.key = '2';
    const f = await templates.createTemplate({ key: `numeric-${crypto.randomUUID()}`, displayName: 'Numeric identity', definition: d }, options());
    const v = await templates.publishTemplate(f.id, { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash }, options());
    const draft = await bindings.createDraft({ installationKey: `numeric-${crypto.randomUUID()}`, origin: 'https://binding.example.invalid', templateVersionId: v.id, observedAt: '2026-09-01T00:00:00.000Z', schema }, options());
    const saved = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: fixture.approvedBindings(d, schema) }, options());
    const rows = (await pool.query("SELECT question_key,source_key,value_id FROM magento_binding_options WHERE revision_id=$1 AND source_kind='semantic' ORDER BY value_id", [draft.id])).rows;
    assert.equal(rows.length, 3);
    assert.ok(rows.every((o) => o.question_key === '2' && o.source_key === `BR.2=value_id:${o.value_id}`));
    assert.equal((await bindings.validateDraft(saved.id)).valid, true);
    assert.equal((await publish(saved)).state, 'published');
    await assert.rejects(pool.query("UPDATE magento_binding_options SET question_key='friendly_alias' WHERE revision_id=$1", [draft.id]));
    assert.deepEqual((await pool.query("SELECT question_key,source_key,value_id FROM magento_binding_options WHERE revision_id=$1 AND source_kind='semantic' ORDER BY value_id", [draft.id])).rows, rows);
  });

  await t.test('clone copies current publication identities and every decision exactly, audits provenance, and rolls back atomically', async () => {
    const draft = await ready(); const source = await publish(draft);
    const clone = (input = { expectedRevision: source.revision }, opts = options()) => bindings.clonePublished(source.id, input, opts);
    const count = async () => (await pool.query('SELECT count(*)::int n FROM magento_binding_revisions')).rows[0].n;
    const before = await count();
    await assert.rejects(clone({ expectedRevision: draft.revision }), { code: 'MAGENTO_BINDING_CONFLICT' });
    await assert.rejects(bindings.clonePublished((await ready()).id, { expectedRevision: '2' }, options()), { code: 'MAGENTO_BINDING_CONFLICT' });
    await assert.rejects(clone(undefined, { ...options(), mutationContext: { actorUserId: 9999999 } }), { code: 'ADMIN_PERMISSION_REVOKED' });
    assert.equal(await count(), before + 1);
    const failingPool = { connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), query: (sql, values) => {
        if (/INSERT INTO audit_events/.test(sql)) throw new Error('clone audit failure');
        return client.query(sql, values);
      } };
    } };
    await assert.rejects(clone(undefined, options(failingPool)), /clone audit failure/);
    await assert.rejects(clone(undefined, { ...options(), prepareReceipt() { throw new Error('clone receipt failure'); } }), /clone receipt failure/);
    assert.equal(await count(), before + 1);
    const copied = await clone();
    assert.notEqual(copied.id, source.id); assert.equal(copied.revision, '1'); assert.equal(copied.state, 'draft');
    assert.equal(copied.versionNumber, null); assert.equal(copied.publishedByUserId, null); assert.equal(copied.publishedAt, null);
    for (const key of ['installationKey', 'originHash', 'templateId', 'templateVersionId', 'definitionHash',
      'evaluatorVersion', 'outputContract', 'formatVersion', 'schemaFingerprint', 'topologyFingerprint', 'observedAt', 'schema', 'bindings']) {
      assert.deepEqual(copied[key], source[key], key);
    }
    for (const table of ['schema_sets', 'schema_attributes', 'schema_options', 'schema_members', 'schema_stores',
      'routes', 'attributes', 'options', 'field_policies']) {
      const rows = async (id) => (await pool.query(`SELECT to_jsonb(t)-'revision_id' AS value
        FROM magento_binding_${table} t WHERE revision_id=$1 ORDER BY (to_jsonb(t)-'revision_id')::text`, [id])).rows;
      assert.deepEqual(await rows(copied.id), await rows(source.id), table);
    }
    const audit = (await pool.query("SELECT details FROM audit_events WHERE subject_id=$1 AND event_key='magento_binding.cloned'", [copied.id])).rows;
    assert.equal(audit.length, 1); assert.equal(audit[0].details.sourceRevisionId, source.id);
    assert.equal(audit[0].details.sourceRevision, source.revision);
    assert.equal(audit[0].details.bindingsHash, require('../src/services/magento/binding-contract').hash(source.bindings));
    const changed = structuredClone(copied.bindings); changed.policies[0].reviewState = 'review_required';
    await bindings.updateDraft(copied.id, { expectedRevision: copied.revision, bindings: changed }, options());
    await assert.rejects(bindings.updateDraft(copied.id, { expectedRevision: copied.revision, bindings: copied.bindings }, options()),
      { code: 'MAGENTO_BINDING_CONFLICT' });
    assert.deepEqual(await bindings.getRevision(source.id), source);
    assert.equal((await bindings.getCurrentPublished(source.installationKey)).id, source.id);
  });

  await t.test('clone versus publication races serialize and reject a superseded source without creating a stale clone', async () => {
    for (const cloneFirst of [true, false]) {
      const source = await publish(await ready());
      const successor = await ready(source.installationKey);
      const clone = (db) => bindings.clonePublished(source.id, { expectedRevision: source.revision }, options(db));
      const pub = (db) => publish(successor, source.id, db);
      const results = await race(cloneFirst ? clone : pub, cloneFirst ? pub : clone);
      assert.equal(results[0].status, 'fulfilled');
      if (cloneFirst) {
        assert.equal(results[1].status, 'fulfilled');
        assert.deepEqual((await bindings.getRevision(results[0].value.id)).bindings, source.bindings);
      } else assert.equal(results[1].reason.code, 'MAGENTO_BINDING_CONFLICT');
      assert.equal((await bindings.getCurrentPublished(source.installationKey)).id, successor.id);
      assert.deepEqual(await bindings.getRevision(source.id), source);
      const rows = (await pool.query('SELECT id,state FROM magento_binding_revisions WHERE installation_key=$1', [source.installationKey])).rows;
      assert.equal(rows.length, cloneFirst ? 3 : 2);
      assert.equal(rows.filter((r) => r.state === 'draft').length, cloneFirst ? 1 : 0);
    }
  });

  await t.test('bootstrap template, publication, candidate bindings and audit commit or roll back together', async () => {
    const { persistBootstrap } = require('../src/services/magento/binding-bootstrap-persistence');
    const { buildCandidates } = require('../src/services/magento/binding-bootstrap');
    const { compileDefinition } = require('../src/services/export-templates/definition');
    const compiled = compileDefinition(definition);
    const candidates = buildCandidates({ compiled, products: [], current: [] }, schema, [], { group: 'BR' });
    const counts = async () => (await pool.query(`SELECT (SELECT count(*) FROM export_templates) AS templates,
      (SELECT count(*) FROM export_template_drafts) AS drafts, (SELECT count(*) FROM export_template_versions) AS versions,
      (SELECT count(*) FROM magento_binding_revisions) AS bindings, (SELECT count(*) FROM magento_binding_routes) AS routes,
      (SELECT count(*) FROM magento_binding_options) AS options, (SELECT count(*) FROM audit_events) AS audit`)).rows[0];
    const input = { installationKey: `atomic-${crypto.randomUUID()}`, origin: 'https://binding.example.invalid',
      definition, definitionHash: compiled.hash, observedAt: new Date().toISOString(), schema, bindings: candidates };
    const before = await counts();
    await assert.rejects(persistBootstrap({ ...input, definitionHash: '0'.repeat(64) }, options()), { code: 'MAGENTO_BINDING_CONFLICT' });
    assert.deepEqual(await counts(), before, 'publication and its family/audit roll back');
    await assert.rejects(persistBootstrap(input, { ...options(), prepareReceipt() { throw new Error('injected receipt failure'); } }), /injected receipt failure/);
    assert.deepEqual(await counts(), before, 'all candidate rows and audits roll back after the latest possible precommit error');
    const saved = await persistBootstrap(input, options());
    assert.equal(saved.state, 'draft'); assert.equal(saved.revision, '1');
    assert.deepEqual(saved.bindings.options, (await bindings.getRevision(saved.id, options())).bindings.options);
    const after = await counts();
    assert.equal(Number(after.templates), Number(before.templates) + 1);
    assert.equal(Number(after.versions), Number(before.versions) + 1);
    assert.equal(Number(after.bindings), Number(before.bindings) + 1);
    assert.equal(Number(after.audit), Number(before.audit) + 3);
  });

  await t.test('bootstrap seeds proposed identities atomically; explicit review CAS, policies and publish reuse existing guards', async () => {
    const { buildCandidates } = require('../src/services/magento/binding-bootstrap');
    const { saveDecision, review } = require('../src/services/magento/binding-review');
    const { compileDefinition } = require('../src/services/export-templates/definition');
    const bootstrapDefinition = structuredClone(definition);
    bootstrapDefinition.groups[0].rows[0].cells.categories = { op: 'literal', value: 'Default/Fixture' };
    bootstrapDefinition.groups[0].rows[0].cells.product_online = { op: 'literal', value: '1' };
    const family = await templates.createTemplate({ key: `bootstrap-template-${crypto.randomUUID()}`,
      displayName: 'Bootstrap category evidence', definition: bootstrapDefinition }, options());
    const frozen = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision,
      expectedDefinitionHash: family.draft.definitionHash }, options());
    const observed = structuredClone(schema);
    observed.attributeSets[0].attribute_set_name = 'Historical CSV name';
    observed.attributes.find((a) => a.attribute_code === 'kolir').options.forEach((o) => {
      o.label = o.value === 'red-id' ? 'Red output' : 'Blue output';
    });
    const amber = { compiled: compileDefinition(bootstrapDefinition), products: [{ id: 1, category: 'BR', full_sku: 'BR/fixture',
      weight: 5, details: { answers: { binding_test_semantic: 7, binding_test_size: '17' } } }], current: [] };
    const nodes = [{ categoryId: '9876', path: 'Default/Fixture', normalizedPath: 'Default/Fixture', comparable: true }];
    const candidates = buildCandidates(amber, observed, nodes, { group: 'BR' });
    const key = `bootstrap-${crypto.randomUUID()}`;
    let draft = await bindings.createDraft({ installationKey: key, origin: 'https://binding.example.invalid',
      templateVersionId: frozen.id, observedAt: new Date().toISOString(), schema: observed, bindings: candidates }, options());
    assert.equal(draft.revision, '1');
    assert.ok(review(draft).every((r) => r.reviewState !== 'approved'));
    assert.ok(draft.bindings.attributes.length > 0);
    const categories = draft.bindings.attributes.find((a) => a.target === 'categories');
    assert.equal(categories.evidence.categories[0].categoryId, '9876');
    assert.equal(categories.evidence.categories[0].reviewState, 'proposed');
    assert.equal((await pool.query('SELECT count(*)::int n FROM magento_binding_options WHERE revision_id=$1', [draft.id])).rows[0].n, candidates.options.length);
    const first = draft;
    draft = (await saveDecision(draft.id, { action: 'approve-exact', group: 'BR', expectedRevision: draft.revision }, options())).revision;
    assert.equal(draft.bindings.attributes.find((a) => a.target === 'categories').evidence.categories[0].reviewState, 'approved');
    assert.ok(draft.bindings.policies.every((p) => p.reviewState === 'review_required'));
    await assert.rejects(saveDecision(draft.id, { action: 'approve-exact', group: 'BR', expectedRevision: first.revision }, options()), { code: 'MAGENTO_BINDING_CONFLICT' });
    assert.equal((await bindings.validateDraft(draft.id, options())).valid, false);
    await assert.rejects(publish(draft), { code: 'MAGENTO_BINDING_INVALID' });
    for (const p of review(draft).filter((e) => e.kind === 'policy')) {
      draft = (await saveDecision(draft.id, { action: 'approve', binding: p.id, expectedRevision: draft.revision,
        acceptReview: true, reason: 'Synthetic explicit ownership',
        ...(p.target === 'product_online' && p.row === 'base'
          ? { policy: 'initialize_create_only', createValue: '2' } : { policy: 'magento_managed' }) }, options())).revision;
    }
    const stored = await bindings.getRevision(draft.id, options());
    assert.equal(stored.bindings.policies.find((p) => p.evidence.createValue !== undefined).evidence.createValue, 2);
    assert.equal((await bindings.validateDraft(draft.id, options())).valid, true);
    const published = await publish(draft);
    assert.equal(published.state, 'published'); assert.equal(await countEvents(draft.id), 1);
    const { planPreview } = require('../src/services/magento/sync-preview');
    const preview = planPreview({ ...amber, product: { ...amber.products[0], status: 'active', exclude_from_export: 0 },
      revision: published }, observed, null, nodes);
    assert.equal(preview.attributeSet.status, 'resolved_authoritative');
    assert.equal(preview.attributes.find((a) => a.target === 'kolir').authority, 'authoritative');
    assert.equal(preview.categories.requested[0].authority, 'authoritative');
    assert.equal(preview.candidatePayload.product.status, 2);
    await assert.rejects(saveDecision(published.id, { action: 'approve-exact', group: 'BR', expectedRevision: published.revision }, options()), { code: 'MAGENTO_BINDING_CONFLICT' });
    const before = (await pool.query('SELECT count(*)::int n FROM magento_binding_revisions')).rows[0].n;
    const forbidden = structuredClone(candidates); forbidden.routes.find((r) => r.enabled).reviewState = 'approved';
    await assert.rejects(bindings.createDraft({ installationKey: `reject-${crypto.randomUUID()}`,
      origin: 'https://binding.example.invalid', templateVersionId: version.id, observedAt: new Date().toISOString(),
      schema: observed, bindings: forbidden }, options()), { code: 'MAGENTO_BINDING_INVALID' });
    assert.equal((await pool.query('SELECT count(*)::int n FROM magento_binding_revisions')).rows[0].n, before);
  });

  await t.test('sync preview coherently reads an explicit draft and its pinned publication without writes', async () => {
    const draft = await ready();
    const { insertProductFixture } = require('./product-fixture');
    const { readPreviewProduct } = require('../src/services/magento/sync-preview-db');
    const sku = 'BR/SYNC-BINDING-SYNTH';
    await insertProductFixture(pool, `INSERT INTO products
      (full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details)
      VALUES ($1,$1,0,'BR',5,1,42,1,42,$2::jsonb)`,
    [sku, JSON.stringify({ answers: { binding_test_semantic: 7, binding_test_size: '17' } })]);
    const before = await bindings.getRevision(draft.id);
    const commands = [];
    const snapshot = await readPreviewProduct({ connect: async () => {
      const c = await pool.connect();
      return { release: () => c.release(), query: async (sql, values) => {
        assert.match(sql.trim(), /^(SELECT|BEGIN|COMMIT|ROLLBACK)\b/); commands.push(sql);
        return c.query(sql, values);
      } };
    } }, { sku, bindingRevisionId: draft.id });
    assert.deepEqual(snapshot.revision, before);
    assert.equal(snapshot.template.versionId, version.id);
    assert.equal(snapshot.compiled.hash, before.definitionHash);
    assert.equal(commands.filter((s) => s.startsWith('BEGIN')).length, 1);
    assert.deepEqual(await bindings.getRevision(draft.id), before);
    // A legacy delivery hold is not same-SKU Magento UPDATE eligibility. Read
    // the typed signals through the real snapshot loader and preserve every row.
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query(`UPDATE product_full_export_state SET route='hold', hold_reason='prior_exposure',
        business_exclusion_state='unknown', recount_compatibility_excluded=FALSE,
        delivery_version=delivery_version+1 WHERE product_id=$1`, [snapshot.product.id]);
      await db.query('UPDATE products SET exclude_from_export=1 WHERE id=$1', [snapshot.product.id]);
      await db.query('COMMIT');
    } catch (cause) { await db.query('ROLLBACK'); throw cause; } finally { db.release(); }
    const storedState = async () => (await pool.query(`SELECT p.exclude_from_export, to_jsonb(f) AS lifecycle
      FROM products p JOIN product_full_export_state f ON f.product_id=p.id WHERE p.id=$1`, [snapshot.product.id])).rows[0];
    const legacyBefore = await storedState();
    const { syncEligibility } = require('../src/services/magento/sync-eligibility');
    const current = (await readPreviewProduct(pool, { sku, bindingRevisionId: draft.id })).product;
    assert.equal(syncEligibility(current, { sku }).eligible, true);
    assert.equal(syncEligibility(current, null).eligible, false);
    assert.deepEqual(await storedState(), legacyBefore);
    assert.equal(current.exportState.business_exclusion_state, 'unknown');
    assert.equal(current.exclude_from_export, 1, 'legacy queue exclusion remains unchanged');
    await pool.query(`UPDATE product_full_export_state SET evidence=evidence || '{"independentExclusion":true}'::jsonb,
      delivery_version=delivery_version+1 WHERE product_id=$1`, [snapshot.product.id]);
    const excluded = (await readPreviewProduct(pool, { sku, bindingRevisionId: draft.id })).product;
    assert.equal(excluded.exportState.independentExclusion, true);
    assert.equal(syncEligibility(excluded, { sku }).eligible, false);
    await assert.rejects(readPreviewProduct(pool, { sku, bindingRevisionId: draft.id,
      templateVersionId: crypto.randomUUID() }), { code: 'MAGENTO_PREVIEW_TEMPLATE_MISMATCH' });
  });

  await t.test('fresh migration, draft create/read/update, CAS and fail-closed candidates', async () => {
    assert.equal((await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE name='041_magento_binding_revisions.sql'")).rows[0].n, 1);
    const draft = await create(); assert.equal(draft.state, 'draft'); assert.equal(draft.versionNumber, null);
    assert.ok(draft.bindings.routes.every((r) => !r.enabled && r.reviewState === 'review_required' && r.setId === null));
    assert.equal((await bindings.getRevision(draft.id)).definitionHash, version.definitionHash);
    assert.equal(await bindings.getCurrentPublished(draft.installationKey), null);
    assert.equal((await bindings.validateDraft(draft.id)).valid, false);
    await assert.rejects(publish(draft), { code: 'MAGENTO_BINDING_INVALID' });
    const candidate = fixture.approvedBindings(); candidate.routes[0].reviewState = 'review_required';
    const saved = await bindings.updateDraft(draft.id, { expectedRevision: '1', bindings: candidate }, options());
    assert.equal(saved.revision, '2'); await assert.rejects(publish(saved), { code: 'MAGENTO_BINDING_INVALID' });
    await assert.rejects(bindings.updateDraft(draft.id, { expectedRevision: '1', bindings: candidate }, options()), { code: 'MAGENTO_BINDING_CONFLICT' });
    candidate.routes[0].reviewState = 'approved'; candidate.options.find((o) => o.sourceKind === 'semantic').reviewState = 'review_required';
    const reviewed = await bindings.updateDraft(draft.id, { expectedRevision: '2', bindings: candidate }, options());
    await assert.rejects(publish(reviewed), { code: 'MAGENTO_BINDING_INVALID' });
    const semantic = (await pool.query("SELECT value_id,sku_code_evidence,option_id FROM magento_binding_options WHERE revision_id=$1 AND value_id=7", [draft.id])).rows[0];
    assert.deepEqual(semantic, { value_id: 7, sku_code_evidence: '91', option_id: 'red-id' });
    assert.equal(await countEvents(draft.id), 0);
    const duplicate = fixture.approvedBindings(); duplicate.options.push(structuredClone(duplicate.options[0]));
    await assert.rejects(bindings.updateDraft(draft.id, { expectedRevision: '3', bindings: duplicate }, options()), { code: 'MAGENTO_BINDING_INVALID' });
    assert.equal((await bindings.getRevision(draft.id)).revision, '3');
  });
  await t.test('many-to-one retains both semantic identities; reviewed blocked decisions are publishable', async () => {
    const draft = await ready(); const b = structuredClone(draft.bindings);
    const known = b.options.find((o) => o.valueId === '8'); Object.assign(known, { optionId: null, reviewState: 'blocked' });
    const unenumerated = { ...known, valueId: '29', evaluatedOutput: null }; delete unenumerated.sourceKey;
    b.options.push(unenumerated);
    Object.assign(b.policies[0], { policy: 'blocked', reviewState: 'blocked' });
    const saved = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: b }, options());
    assert.deepEqual((await bindings.validateDraft(saved.id)).diagnostics, []);
    const published = await publish(saved);
    const provenance = (await pool.query("SELECT value_id,evaluated_output,option_id FROM magento_binding_options WHERE revision_id=$1 AND option_id='red-id' ORDER BY value_id", [draft.id])).rows;
    assert.deepEqual(provenance, [7,9].map((value_id) => ({ value_id, evaluated_output: 'Red output', option_id: 'red-id' })));
    assert.equal(published.bindings.options.filter((o) => o.reviewState === 'blocked').length, 2);
    assert.equal(published.bindings.routes.find((r) => r.enabled).evaluatorSetName, 'Historical CSV name');
    assert.equal(published.bindings.routes.find((r) => r.enabled).setId, 8001);
    const routeBlocked = await create();
    const routeBindings = structuredClone(routeBlocked.bindings); Object.assign(routeBindings.routes[0], { enabled: true, reviewState: 'blocked' });
    const blocked = await bindings.updateDraft(routeBlocked.id, { expectedRevision: routeBlocked.revision, bindings: routeBindings }, options());
    assert.equal((await publish(blocked)).state, 'published');
  });
  await t.test('audit failure rolls back publication and all attribution', async () => {
    const draft = await ready();
    const failingPool = { connect: async () => {
      const client = await pool.connect(); return { release: () => client.release(), query: (sql, values) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO audit_events')) throw new Error('synthetic audit failure');
        return client.query(sql, values);
      } };
    } };
    await assert.rejects(publish(draft, null, failingPool), /synthetic audit failure/);
    const after = await bindings.getRevision(draft.id);
    assert.equal(after.state, 'draft'); assert.equal(after.revision, draft.revision); assert.equal(after.publishedAt, null);
    assert.equal(await bindings.getCurrentPublished(draft.installationKey), null); assert.equal(await countEvents(draft.id), 0);
  });
  await t.test('current-only SKU identities permit explicit blocking, never invented approvals', async () => {
    const historical = (await pool.query(`INSERT INTO sku_schema_versions(category_code,version,marker,status,config_hash)
      SELECT 'BR',coalesce(max(version),0)+1,$1,'archived',$2 FROM sku_schema_versions WHERE category_code='BR' RETURNING id`,
    [`binding-${crypto.randomUUID()}`, 'a'.repeat(64)])).rows[0];
    const historicalQuestion = (await pool.query(`INSERT INTO sku_schema_questions(schema_version_id,question_key,label,sku_index)
      VALUES($1,'binding_test_semantic','Synthetic historical source',0) RETURNING id`, [historical.id])).rows[0];
    await pool.query(`INSERT INTO sku_schema_options(schema_question_id,value_id,sku_code,label)
      VALUES($1,7,'91','Historical red'),($1,8,'92','Historical blue')`, [historicalQuestion.id]);
    await pool.query('UPDATE questions SET include_in_sku=1 WHERE id=$1', [q.id]);
    try {
      const draft = await ready(); const b = structuredClone(draft.bindings);
      assert.ok((await bindings.validateDraft(draft.id)).diagnostics.some((d) => d.code === 'SEMANTIC_IDENTITY_UNRESOLVED' && d.sourceKey.endsWith('value_id:9')));
      Object.assign(b.options.find((o) => o.valueId === '9'), { reviewState: 'blocked', optionId: null });
      const extra = { ...b.options.find((o) => o.valueId === '9'), valueId: '29', evaluatedOutput: null }; delete extra.sourceKey;
      b.options.push(extra);
      const saved = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: b }, options());
      assert.deepEqual((await bindings.validateDraft(saved.id)).diagnostics, []);
      assert.equal((await publish(saved)).state, 'published');
    } finally { await pool.query('UPDATE questions SET include_in_sku=0 WHERE id=$1', [q.id]); }
  });
  await t.test('dictionary-only refusal validates without invented identity, but fresh active usage blocks publication', async () => {
    const d = structuredClone(definition);
    d.tables.fixtureColors['999'] = 'Red output';
    d.questionContracts.color = { source: 'color', exists: true, required: false,
      rule: {}, allowed: ['7', '8', '9', '29'] };
    const f = await templates.createTemplate({ key: `refusal-${crypto.randomUUID()}`, displayName: 'Dictionary refusal', definition: d }, options());
    const v = await templates.publishTemplate(f.id, { expectedRevision: f.draft.revision, expectedDefinitionHash: f.draft.definitionHash }, options());
    const draft = await bindings.createDraft({ installationKey: `refusal-${crypto.randomUUID()}`,
      origin: 'https://binding.example.invalid', templateVersionId: v.id, observedAt: '2026-09-01T00:00:00.000Z', schema }, options());
    const b = fixture.approvedBindings(d, schema);
    const refused = b.options.find((o) => o.valueId === '999');
    Object.assign(refused, { reviewState: 'blocked', evidence: { note: 'Dictionary-only, not an Amber semantic identity' } });
    const saved = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: b }, options());
    assert.equal((await bindings.validateDraft(saved.id)).valid, true);
    const sku = `REFUSAL-${crypto.randomUUID()}`;
    const { insertProductFixture } = require('./product-fixture');
    const p = (await insertProductFixture(pool, `INSERT INTO products
      (full_sku,base_sku,sequence_number,category,weight,total_price,total_price_uah,price_per_gram,uah_rate,details)
      VALUES($1,$1,0,'BR',5,1,42,1,42,$2::jsonb) RETURNING id`, [sku, JSON.stringify({ answers: { binding_test_semantic: 999 } })])).rows[0];
    assert.ok((await bindings.validateDraft(saved.id)).diagnostics.some((x) => x.code === 'SEMANTIC_IDENTITY_UNRESOLVED' && x.sourceKey.endsWith(':999')));
    await assert.rejects(publish(saved), { code: 'MAGENTO_BINDING_INVALID' });
    assert.equal((await bindings.getRevision(saved.id)).state, 'draft');
    assert.equal(await countEvents(saved.id), 0);
    await pool.query("UPDATE products SET status='archived' WHERE id=$1", [p.id]);
    assert.equal((await bindings.validateDraft(saved.id)).valid, true);
    assert.equal((await publish(saved)).state, 'published');
  });
  await t.test('database rejects wrong-attribute options, duplicate option identity and forged source kinds', async () => {
    const draft = await ready();
    for (const [sql, expected] of [
      ["UPDATE magento_binding_options SET option_id='size-id' WHERE revision_id=$1 AND value_id=8", '23503'],
      ["UPDATE magento_binding_options SET attribute_code='decor_weight' WHERE revision_id=$1 AND value_id=7", '23503'],
      ["UPDATE magento_binding_options SET option_id='blue-id' WHERE revision_id=$1 AND value_id=7", '23505'],
      ["UPDATE magento_binding_options SET value_id=7 WHERE revision_id=$1 AND source_kind='evaluated'", '23514'],
      ["UPDATE magento_binding_options SET source_kind='evaluated' WHERE revision_id=$1 AND value_id=8", '23514'],
      ["UPDATE magento_binding_options SET attribute_code=NULL,option_id=NULL,review_state='blocked' WHERE revision_id=$1 AND value_id=7", '23503'],
      ["UPDATE magento_binding_options SET value_id=NULL WHERE revision_id=$1 AND value_id=7", '23514'],
      ["UPDATE magento_binding_options SET source_key='sku_code:91' WHERE revision_id=$1 AND value_id=7", '23514'],
      ["UPDATE magento_binding_options SET source_key='BR.binding_test_semantic=value_id:7',value_id=7,option_id=NULL,review_state='blocked' WHERE revision_id=$1 AND value_id=9", '23505'],
      ["UPDATE magento_binding_options SET domain_key=repeat('a',64) WHERE revision_id=$1 AND value_id=7", '23514'],
      ["UPDATE magento_binding_options SET output_key=NULL WHERE revision_id=$1 AND source_kind='evaluated'", '23514'],
      ["UPDATE magento_binding_routes SET route_key='BR:ephemeral' WHERE revision_id=$1 AND amber_group='BR'", '23514'],
      ["UPDATE magento_binding_field_policies SET store_id=NULL WHERE revision_id=$1 AND store_code='en'", '23514'],
      ["UPDATE magento_binding_field_policies SET store_id=804 WHERE revision_id=$1 AND store_code='all'", '23514'],
      ["UPDATE magento_binding_field_policies SET store_id=99999 WHERE revision_id=$1 AND store_code='en'", '23503'],
      ["UPDATE magento_binding_field_policies SET policy='blocked' WHERE revision_id=$1", '23514'],
    ]) await assert.rejects(pool.query(sql, [draft.id]), (e) => e.code === expected, sql);
    assert.deepEqual(await bindings.getRevision(draft.id), draft);
    const roundtrip = await bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: draft.bindings }, options());
    assert.deepEqual(roundtrip.bindings, draft.bindings);
    const repeatable = await pool.connect();
    try {
      await repeatable.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await assert.rejects(repeatable.query('UPDATE magento_binding_options SET review_state=review_state WHERE revision_id=$1', [draft.id]), /require Read Committed/);
    } finally { await repeatable.query('ROLLBACK'); repeatable.release(); }
    const nameBindings = draft.bindings.attributes.filter((a) => a.target === 'name');
    const base = nameBindings.find((a) => a.rowId === 'base'); const english = nameBindings.find((a) => a.rowId === 'english');
    await assert.rejects(pool.query(`INSERT INTO magento_binding_field_policies
      (revision_id,binding_key,route_key,field_target,store_code,store_id,policy,review_state)
      SELECT revision_id,$2,route_key,field_target,store_code,store_id,policy,review_state
      FROM magento_binding_field_policies WHERE revision_id=$1 AND binding_key=$3`,
    [draft.id, base.bindingKey, english.bindingKey]), (e) => e.code === '23505');
    await assert.rejects(bindings.updateDraft(draft.id, { expectedRevision: roundtrip.revision, bindings: draft.bindings },
      { databasePool: pool, mutationContext: { actorUserId: 9999999 } }), { code: 'ADMIN_PERMISSION_REVOKED' });
  });
  await t.test('revision-scoped foreign keys reject objects observed only in another installation', async () => {
    const local = await ready(); const foreignSchema = structuredClone(schema);
    foreignSchema.attributes.push({ attribute_code: 'foreign_only', attribute_id: 9999, frontend_input: 'text', options: [] });
    foreignSchema.attributes.find((a) => a.attribute_code === 'kolir').options.push({ value: 'foreign-option', label: 'Remote red' });
    foreignSchema.attributeSets.push({ attribute_set_id: 9999, attribute_set_name: 'Foreign only', attributeCodes: ['foreign_only'] });
    foreignSchema.storeTopology.storeViews.push({ ...foreignSchema.storeTopology.storeViews[0], id: 9999, code: 'foreign_view' });
    const foreign = await create(undefined, foreignSchema); assert.notEqual(local.installationKey, foreign.installationKey);
    for (const sql of [
      "UPDATE magento_binding_routes SET set_id=9999 WHERE revision_id=$1 AND enabled",
      "UPDATE magento_binding_options SET option_id='foreign-option' WHERE revision_id=$1 AND value_id=8",
      "INSERT INTO magento_binding_schema_options VALUES($1,'foreign_only','foreign-option','Remote red')",
      "INSERT INTO magento_binding_schema_members VALUES($1,8001,'foreign_only')",
      "UPDATE magento_binding_field_policies SET store_id=9999,store_code='foreign_view' WHERE revision_id=$1 AND store_code='en'",
    ]) await assert.rejects(pool.query(sql, [local.id]), (e) => e.code === '23503');
    await assert.rejects(pool.query('UPDATE magento_binding_options SET revision_id=$2 WHERE revision_id=$1', [local.id, foreign.id]), /parent is immutable/);
    assert.deepEqual(await bindings.getRevision(local.id), local);
    const predicates = [{ questionKey: 'type', valueId: '2', equal: false }, { questionKey: 'souvenir', valueId: '5', equal: true }];
    for (const p of [predicates, [...predicates].reverse()]) {
      assert.equal((await pool.query('SELECT magento_binding_route_key($1,$2::jsonb) AS key', ['SV', JSON.stringify(p)])).rows[0].key,
        'SV.souvenir=value_id:5&type!=value_id:2');
    }
  });
  await t.test('atomic publish, completed retry, successor publication and complete database immutability', async () => {
    const draft = await ready(); const publication = await publish(draft);
    assert.equal(publication.versionNumber, '1'); assert.equal(publication.state, 'published');
    assert.deepEqual(await publish(draft), publication); assert.equal(await countEvents(draft.id), 1);
    await assert.rejects(bindings.updateDraft(draft.id, { expectedRevision: publication.revision, bindings: fixture.approvedBindings() }, options()), { code: 'MAGENTO_BINDING_CONFLICT' });
    await assert.rejects(pool.query('UPDATE magento_binding_revisions SET revision=revision+1 WHERE id=$1', [draft.id]), /immutable/);
    await assert.rejects(pool.query('DELETE FROM magento_binding_revisions WHERE id=$1', [draft.id]), /permanent/);
    await assert.rejects(pool.query('TRUNCATE magento_binding_revisions CASCADE'), /truncated|permanent/);
    const children = ['schema_sets','schema_attributes','schema_options','schema_members','schema_stores','routes','attributes','options','field_policies'];
    for (const table of children) {
      const storedColumns = (await pool.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, [`magento_binding_${table}`])).rows;
      assert.ok(storedColumns.every((c) => /^[a-z_]+$/.test(c.column_name)));
      const projection = storedColumns.map((c) => c.column_name).join(',');
      const columns = `(${projection})`;
      await assert.rejects(pool.query(`INSERT INTO magento_binding_${table} ${columns}
        SELECT ${projection} FROM magento_binding_${table} WHERE revision_id=$1 LIMIT 1`, [draft.id]), /immutable/);
      await assert.rejects(pool.query(`UPDATE magento_binding_${table} SET revision_id=revision_id WHERE revision_id=$1`, [draft.id]), /immutable/);
      await assert.rejects(pool.query(`DELETE FROM magento_binding_${table} WHERE revision_id=$1`, [draft.id]), /immutable/);
      await assert.rejects(pool.query(`TRUNCATE magento_binding_${table} CASCADE`), /truncated|permanent/);
    }
    await assert.rejects(pool.query(`INSERT INTO magento_binding_schema_sets VALUES($1,8999,'Late observation')`, [draft.id]), /immutable/);
    const successor = await ready(draft.installationKey);
    await assert.rejects(publish(successor), { code: 'MAGENTO_BINDING_CONFLICT' });
    const next = await publish(successor, publication.id); assert.equal(next.versionNumber, '2');
    assert.equal((await bindings.getCurrentPublished(draft.installationKey)).id, next.id);
    assert.equal((await bindings.listRevisions(draft.installationKey)).find((r) => r.id === publication.id).lifecycle, 'superseded');
    assert.deepEqual(await bindings.getRevision(publication.id), publication);
    assert.deepEqual(await publish(draft), publication);
  });
  async function race(first, second) {
    const a = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 }); const b = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const holder = await pool.connect(); const pending = [];
    try {
      const apid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const bpid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [APPLICATION_USER_ADMIN_LOCK_KEY]);
      const hpid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const wait = async (pid) => {
        for (let n = 0; n < 600; n++) {
          if ((await pool.query('SELECT $2::int=ANY(pg_blocking_pids($1)) AS blocked', [pid, hpid])).rows[0].blocked) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail('Independent PostgreSQL writer did not block');
      };
      pending.push(first(a)); pending[0].catch(() => {}); await wait(apid);
      pending.push(second(b)); pending[1].catch(() => {}); await wait(bpid);
      await holder.query('COMMIT'); return await Promise.allSettled(pending);
    } finally { await holder.query('ROLLBACK'); holder.release(); await Promise.allSettled(pending); await a.end(); await b.end(); }
  }
  await t.test('direct concurrent option writers cannot share an ID with conflicting evaluated outputs', async () => {
    const observed = structuredClone(schema);
    observed.attributes.find((a) => a.attribute_code === 'kolir').options.push({ value: 'race-id', label: 'Synthetic race option' });
    const created = await create(undefined, observed);
    const draft = await bindings.updateDraft(created.id, { expectedRevision: created.revision, bindings: fixture.approvedBindings(definition, observed) }, options());
    const first = await pool.connect(); const second = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    let pending;
    try {
      const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await first.query('BEGIN');
      await first.query("UPDATE magento_binding_options SET option_id='race-id',evaluated_output='First output' WHERE revision_id=$1 AND value_id=7", [draft.id]);
      pending = second.query("UPDATE magento_binding_options SET option_id='race-id',evaluated_output='Different output' WHERE revision_id=$1 AND value_id=8", [draft.id]);
      pending.catch(() => {});
      let blocked = false;
      for (let n = 0; n < 600; n++) {
        blocked = (await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'Independent option writer must wait for the revision lock');
      await first.query('COMMIT');
      await assert.rejects(pending, (e) => e.code === '23505');
      assert.deepEqual((await pool.query('SELECT value_id,option_id FROM magento_binding_options WHERE revision_id=$1 AND value_id IN(7,8) ORDER BY value_id', [draft.id])).rows,
        [{ value_id: 7, option_id: 'race-id' }, { value_id: 8, option_id: 'blue-id' }]);
    } finally { await first.query('ROLLBACK'); first.release(); await Promise.allSettled(pending ? [pending] : []); await second.end(); }
  });
  await t.test('real races: identical publishes, competing drafts, update before publish and publish before update', async () => {
    const one = await ready(); const identical = await race((db) => publish(one, null, db), (db) => publish(one, null, db));
    assert.ok(identical.every((r) => r.status === 'fulfilled')); assert.equal(await countEvents(one.id), 1);
    const a = await ready(); const b = await ready(a.installationKey);
    const distinct = await race((db) => publish(a, null, db), (db) => publish(b, null, db));
    assert.equal(distinct[0].status, 'fulfilled'); assert.equal(distinct[1].reason.code, 'MAGENTO_BINDING_CONFLICT');
    assert.equal((await bindings.getCurrentPublished(a.installationKey)).id, a.id);
    assert.equal((await bindings.getRevision(b.id)).state, 'draft');
    assert.deepEqual((await pool.query("SELECT version_number FROM magento_binding_revisions WHERE installation_key=$1 AND state='published'", [a.installationKey])).rows, [{ version_number: '1' }]);
    assert.equal((await publish(b, a.id)).versionNumber, '2');
    assert.deepEqual((await pool.query("SELECT version_number FROM magento_binding_revisions WHERE installation_key=$1 AND state='published' ORDER BY version_number", [a.installationKey])).rows, [{ version_number: '1' }, { version_number: '2' }]);
    for (const updateFirst of [true, false]) {
      const draft = await ready(); const changed = fixture.approvedBindings(); changed.policies[0].reviewState = 'review_required';
      const update = (db) => bindings.updateDraft(draft.id, { expectedRevision: draft.revision, bindings: changed }, options(db));
      const pub = (db) => publish(draft, null, db);
      const results = await race(updateFirst ? update : pub, updateFirst ? pub : update);
      assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'MAGENTO_BINDING_CONFLICT');
      const stored = await bindings.getRevision(draft.id);
      assert.equal(stored.state, updateFirst ? 'draft' : 'published'); assert.equal(await countEvents(draft.id), updateFirst ? 0 : 1);
      assert.equal(stored.bindings.policies.some((p) => p.reviewState === 'review_required'), updateFirst);
    }
  });
  await t.test('category create attempt survives process retry and serializes concurrent revisions before any remote dispatch', async () => {
    const { reserveAttempt } = require('../src/services/magento/category-create');
    const { TARGETS } = require('../src/services/magento/category-create-target');
    const { hash } = require('../src/services/magento/binding-contract');
    const first = await ready(); const second = await ready(first.installationKey);
    for (const target of TARGETS) {
      const operation = { method: 'POST', path: '/rest/all/V1/categories',
        body: { category: { parent_id: 5, name: target.name, is_active: true, include_in_menu: false } } };
      const attempts = await race((db) => reserveAttempt(first, operation, options(db), target),
        (db) => reserveAttempt(second, operation, options(db), target));
      assert.equal(attempts[0].status, 'fulfilled');
      assert.equal(attempts[1].reason.code, 'MAGENTO_CATEGORY_PREVIOUS_ATTEMPT_UNRESOLVED');
      const key = hash({ originHash: first.originHash, path: target.path });
      const receipts = (await pool.query("SELECT details FROM audit_events WHERE event_key='magento_category.create_attempted' AND subject_id=$1", [key])).rows;
      assert.equal(receipts.length, 1); assert.deepEqual(receipts[0].details.operation, operation);
      assert.equal(receipts[0].details.source, target.source);
      await assert.rejects(reserveAttempt(first, operation, options(), target), { code: 'MAGENTO_CATEGORY_PREVIOUS_ATTEMPT_UNRESOLVED' });
      assert.deepEqual(await bindings.getRevision(first.id), first, 'dispatch reservation never publishes or changes binding approvals');
      await assert.rejects(reserveAttempt({ ...first, revision: '999' }, operation, options(), target), { code: 'MAGENTO_BINDING_CONFLICT' });
    }
  });
  await t.test('persisted draft drift uses named GETs only and never changes the revision', async () => {
    const draft = await ready(); const calls = [];
    const config = { configured: true, baseUrl: 'https://binding.example.invalid', consumerKey: 'fake-key', consumerSecret: 'fake-secret', accessToken: 'fake-token', accessTokenSecret: 'fake-token-secret' };
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); calls.push(url);
      const route = new URL(url).pathname.split('/V1/')[1]; let value;
      if (route === 'store/websites') value = schema.storeTopology.websites;
      else if (route === 'store/storeGroups') value = schema.storeTopology.storeGroups;
      else if (route === 'store/storeViews') value = schema.storeTopology.storeViews;
      else if (route === 'products/attribute-sets/sets/list') value = { items: schema.attributeSets, total_count: 1 };
      else if (route === 'products/attributes') value = { items: schema.attributes, total_count: schema.attributes.length };
      else if (route === 'products/attribute-sets/8001/attributes') value = schema.attributes;
      else if (/^products\/attributes\/\w+\/options$/.test(route)) value = schema.attributes.find((a) => a.attribute_code === route.split('/')[2]).options;
      else assert.fail(`Unexpected Magento resource: ${route}`);
      return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    };
    assert.equal((await compareRevision(draft.id, config, { databasePool: pool, fetchImpl })).drifted, false);
    assert.ok(calls.length > 0); assert.deepEqual(await bindings.getRevision(draft.id), draft);
    await assert.rejects(compareRevision(draft.id, { ...config, baseUrl: 'https://other.example.invalid' }, { databasePool: pool, fetchImpl }), { code: 'MAGENTO_BINDING_INSTALLATION_MISMATCH' });
    const publication = await publish(draft);
    const changedFetch = async (url, init) => {
      const response = await fetchImpl(url, init); const body = await response.json();
      if (new URL(url).pathname.endsWith('/kolir/options')) body.find((o) => o.value === 'red-id').label = 'New remote label';
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    };
    const drift = await compareRevision(draft.id, config, { databasePool: pool, fetchImpl: changedFetch });
    assert.equal(drift.diagnostics.find((d) => d.code === 'OPTION_ID_LABEL_CHANGED').optionId, 'red-id');
    assert.deepEqual(await bindings.getRevision(draft.id), publication);
  });
  await t.test('binding transfer category drift ignores admin root zero and still verifies positive catalog roots', async () => {
    const { hash, normalizeSchema, originHash } = require('../src/services/magento/binding-contract');
    const observed = structuredClone(schema);
    observed.storeTopology.websites.unshift({ id: 0, code: 'admin', name: 'Admin', default_group_id: 0 });
    observed.storeTopology.storeGroups.unshift({ id: 0, name: 'Default', website_id: 0,
      root_category_id: 0, default_store_id: 0 });
    const reviewed = fixture.approvedBindings(definition, observed);
    reviewed.attributes[0].evidence = { categories: [{ normalizedPath: 'Default/Fixture',
      categoryId: '9876', reviewState: 'approved' }] };
    const normalized = normalizeSchema(observed);
    const artifact = { originHash: originHash('https://binding.example.invalid'),
      source: { revisionId: crypto.randomUUID(), revision: '1', schemaFingerprint: hash(normalized),
        topologyFingerprint: hash(normalized.storeTopology) }, schema: normalized, bindings: reviewed };
    const config = { configured: true, baseUrl: 'https://binding.example.invalid', consumerKey: 'fake-key',
      consumerSecret: 'fake-secret', accessToken: 'fake-token', accessTokenSecret: 'fake-token-secret' };
    const requestedRoots = [];
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
      const parsed = new URL(url); const route = parsed.pathname.split('/V1/')[1]; let value;
      if (route === 'store/websites') value = normalized.storeTopology.websites;
      else if (route === 'store/storeGroups') value = normalized.storeTopology.storeGroups;
      else if (route === 'store/storeViews') value = normalized.storeTopology.storeViews;
      else if (route === 'products/attribute-sets/sets/list') value = { items: normalized.attributeSets, total_count: 1 };
      else if (route === 'products/attributes') value = { items: normalized.attributes, total_count: normalized.attributes.length };
      else if (route === 'products/attribute-sets/8001/attributes') value = normalized.attributes;
      else if (/^products\/attributes\/\w+\/options$/.test(route)) value = normalized.attributes.find((a) => a.attribute_code === route.split('/')[2]).options;
      else if (route === 'categories') {
        requestedRoots.push(Number(parsed.searchParams.get('rootCategoryId')));
        value = { id: 803, parent_id: 0, name: 'Default', children_data: [
          { id: 9876, parent_id: 803, name: 'Fixture', children_data: [] },
        ] };
      } else assert.fail(`Unexpected Magento resource: ${route}`);
      return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    };
    const exact = await transfer.liveDrift(config, artifact, { fetchImpl });
    assert.equal(exact.drifted, false); assert.deepEqual(requestedRoots, [803]);
    const changedFetch = async (url, init) => {
      const response = await fetchImpl(url, init); const body = await response.json();
      if (new URL(url).pathname.endsWith('/categories')) body.children_data[0].id = 9999;
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    };
    const changed = await transfer.liveDrift(config, artifact, { fetchImpl: changedFetch });
    assert.equal(changed.diagnostics.some((item) => item.code === 'CATEGORY_IDENTITY_DRIFT'
      && item.categoryId === '9876'), true);
  });
  await t.test('reviewed decision carry-forward is atomic, idempotent and rejects stale source or target revisions', async () => {
    const publicDefinition = structuredClone(definition);
    publicDefinition.evaluatorVersion = 'magento-declarative-3';
    publicDefinition.sourceContractVersion = 'public-product-identity-v1';
    publicDefinition.sources.sku.field = 'public_sku';
    const publicFamily = await templates.createTemplate({ key: `binding-public-${crypto.randomUUID()}`,
      displayName: 'Synthetic public identity binding', definition: publicDefinition }, options());
    const publicVersion = await templates.publishTemplate(publicFamily.id, { expectedRevision: publicFamily.draft.revision,
      expectedDefinitionHash: publicFamily.draft.definitionHash }, options());
    const resetBindings = () => {
      const candidate = fixture.approvedBindings(publicDefinition, schema);
      for (const route of candidate.routes) route.reviewState = route.setId === null ? 'review_required' : 'proposed';
      for (const attribute of candidate.attributes) attribute.reviewState = 'proposed';
      for (const option of candidate.options) option.reviewState = option.optionId === null ? 'blocked' : 'proposed';
      for (const policy of candidate.policies) {
        policy.policy = 'magento_managed'; policy.reviewState = 'review_required'; policy.evidence = {};
      }
      return candidate;
    };
    async function pair(prefix) {
      const source = await publish(await ready(`${prefix}-${crypto.randomUUID()}`));
      const target = await bindings.createDraft({ installationKey: source.installationKey,
        origin: 'https://binding.example.invalid', templateVersionId: publicVersion.id,
        observedAt: '2026-09-01T00:00:00.000Z', schema, bindings: resetBindings() }, options());
      const database = (await pool.query('SELECT current_database() name')).rows[0].name;
      const input = { expectedDatabase: database, actorUserId: Number(admin.applicationUser.id),
        sourceId: source.id, sourceRevision: source.revision, targetId: target.id, targetRevision: target.revision };
      return { source, target, input };
    }

    const exact = await pair('carry-exact');
    const artifact = await carryForward.preflight(exact.input, { databasePool: pool });
    assert.deepEqual(artifact.blockers, []);
    const receipt = await carryForward.apply({ expectedDatabase: artifact.plan.database,
      actorUserId: artifact.plan.actorUserId, plan: artifact.plan, planHash: artifact.planHash },
    { databasePool: pool, mutationContext: { actorUserId: Number(admin.applicationUser.id),
      requestId: 'binding-carry-apply' } });
    assert.equal(receipt.alreadyApplied, false);
    const changed = await bindings.getRevision(exact.target.id);
    assert.equal(changed.state, 'draft');
    assert.equal(changed.templateVersionId, publicVersion.id);
    assert.equal(changed.evaluatorVersion, 'magento-declarative-3');
    assert.equal(changed.revision, String(BigInt(exact.target.revision) + 1n));
    assert.deepEqual(changed.bindings.policies.map((row) => [row.policy, row.reviewState]),
      exact.source.bindings.policies.map((row) => [row.policy, row.reviewState]));
    assert.deepEqual(await bindings.getRevision(exact.source.id), exact.source);
    assert.equal((await bindings.getCurrentPublished(exact.source.installationKey)).id, exact.source.id);
    const retry = await carryForward.apply({ expectedDatabase: artifact.plan.database,
      actorUserId: artifact.plan.actorUserId, plan: artifact.plan, planHash: artifact.planHash },
    { databasePool: pool, mutationContext: { actorUserId: Number(admin.applicationUser.id),
      requestId: 'binding-carry-retry' } });
    assert.equal(retry.alreadyApplied, true);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM audit_events
      WHERE event_key='magento_binding.review_carried_forward' AND subject_id=$1`, [exact.target.id])).rows[0].n, 1);

    const staleTarget = await pair('carry-stale-target');
    const targetArtifact = await carryForward.preflight(staleTarget.input, { databasePool: pool });
    const edited = structuredClone(staleTarget.target.bindings);
    edited.policies[0].evidence = { note: 'Independent review after preflight' };
    await bindings.updateDraft(staleTarget.target.id,
      { expectedRevision: staleTarget.target.revision, bindings: edited }, options());
    await assert.rejects(carryForward.apply({ expectedDatabase: targetArtifact.plan.database,
      actorUserId: targetArtifact.plan.actorUserId, plan: targetArtifact.plan, planHash: targetArtifact.planHash },
    { databasePool: pool, mutationContext: { actorUserId: Number(admin.applicationUser.id) } }),
    { code: 'MAGENTO_BINDING_CARRY_PREFLIGHT_STALE' });

    const staleSource = await pair('carry-stale-source');
    const sourceArtifact = await carryForward.preflight(staleSource.input, { databasePool: pool });
    const successor = await ready(staleSource.source.installationKey);
    await publish(successor, staleSource.source.id);
    await assert.rejects(carryForward.apply({ expectedDatabase: sourceArtifact.plan.database,
      actorUserId: sourceArtifact.plan.actorUserId, plan: sourceArtifact.plan, planHash: sourceArtifact.planHash },
    { databasePool: pool, mutationContext: { actorUserId: Number(admin.applicationUser.id) } }),
    { code: 'MAGENTO_BINDING_CARRY_PREFLIGHT_STALE' });
    assert.equal((await bindings.getRevision(staleSource.target.id)).revision, staleSource.target.revision);

    const live = await pair('carry-live-evidence');
    const dynamicAttribute = live.target.bindings.attributes.find((row) => row.strategy === 'dynamic_exact_label_option');
    assert.ok(dynamicAttribute);
    const missingDynamic = live.target.bindings.options.find((row) => row.bindingKey === dynamicAttribute.bindingKey
      && row.sourceKind === 'evaluated');
    assert.ok(missingDynamic);
    const withoutDynamic = fixture.editable(live.target.bindings);
    withoutDynamic.options = withoutDynamic.options.filter((row) => !(row.bindingKey === dynamicAttribute.bindingKey
      && row.sourceKind === 'evaluated' && row.outputKey === missingDynamic.outputKey));
    const updatedTarget = await bindings.updateDraft(live.target.id,
      { expectedRevision: live.target.revision, bindings: withoutDynamic }, options());
    const liveInput = { ...live.input, targetRevision: updatedTarget.revision };
    const config = { configured: true, baseUrl: 'https://binding.example.invalid' };
    let liveOptions = [{ value: missingDynamic.optionId, label: missingDynamic.evaluatedOutput }];
    const magentoClient = {
      getProductAttribute: async (code) => ({ attribute_id: schema.attributes.find((row) => row.attribute_code === code).attribute_id,
        attribute_code: code, frontend_input: 'select' }),
      getProductAttributeOptions: async () => structuredClone(liveOptions),
    };
    const liveArtifact = await carryForward.preflight(liveInput,
      { databasePool: pool, config, magentoClient });
    assert.deepEqual(liveArtifact.blockers, []);
    assert.equal(liveArtifact.plan.liveVerification.dynamicOptions.length, 1);
    assert.equal(liveArtifact.plan.liveVerification.dynamicOptions[0].optionById[0].value, missingDynamic.optionId);
    const targetBeforeStaleApply = await bindings.getRevision(live.target.id);
    liveOptions = [];
    await assert.rejects(carryForward.apply({ expectedDatabase: liveArtifact.plan.database,
      actorUserId: liveArtifact.plan.actorUserId, plan: liveArtifact.plan, planHash: liveArtifact.planHash },
    { databasePool: pool, config, magentoClient,
      mutationContext: { actorUserId: Number(admin.applicationUser.id) } }),
    { code: 'MAGENTO_BINDING_CARRY_PREFLIGHT_STALE' });
    assert.deepEqual(await bindings.getRevision(live.target.id), targetBeforeStaleApply);
    liveOptions = [{ value: missingDynamic.optionId, label: missingDynamic.evaluatedOutput }];
    const liveReceipt = await carryForward.apply({ expectedDatabase: liveArtifact.plan.database,
      actorUserId: liveArtifact.plan.actorUserId, plan: liveArtifact.plan, planHash: liveArtifact.planHash },
    { databasePool: pool, config, magentoClient,
      mutationContext: { actorUserId: Number(admin.applicationUser.id), requestId: 'binding-carry-live-apply' } });
    assert.equal(liveReceipt.alreadyApplied, false);
    const liveChanged = await bindings.getRevision(live.target.id);
    const restoredDynamic = liveChanged.bindings.options.find((row) => row.bindingKey === dynamicAttribute.bindingKey
      && row.sourceKind === 'evaluated' && row.optionId === missingDynamic.optionId);
    assert.ok(restoredDynamic);
    assert.equal(restoredDynamic.domainKey, missingDynamic.domainKey);
  });
  await t.test('reviewed publication transfer round-trips as a new draft and target drift rolls back', async () => {
    const source = await publish(await ready(`transfer-${crypto.randomUUID()}`));
    const database = (await pool.query('SELECT current_database() name')).rows[0].name;
    const wrapper = await transfer.exportArtifact(source.id, { expectedRevision: source.revision,
      expectedDatabase: database }, { databasePool: pool });
    assert.equal(wrapper.artifact.source.bindingHash, require('../src/services/magento/binding-contract').hash(source.bindings));
    assert.equal(Object.keys(wrapper.artifact).some((key) => /user|actor/i.test(key)), false, 'portable artifact omits local-user fields');
    const config = { configured: true, baseUrl: 'https://binding.example.invalid', consumerKey: 'fake-key',
      consumerSecret: 'fake-secret', accessToken: 'fake-token', accessTokenSecret: 'fake-token-secret' };
    const fetchImpl = async (url, init) => {
      assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
      const route = new URL(url).pathname.split('/V1/')[1]; let value;
      if (route === 'store/websites') value = schema.storeTopology.websites;
      else if (route === 'store/storeGroups') value = schema.storeTopology.storeGroups;
      else if (route === 'store/storeViews') value = schema.storeTopology.storeViews;
      else if (route === 'products/attribute-sets/sets/list') value = { items: schema.attributeSets, total_count: 1 };
      else if (route === 'products/attributes') value = { items: schema.attributes, total_count: schema.attributes.length };
      else if (route === 'products/attribute-sets/8001/attributes') value = schema.attributes;
      else if (/^products\/attributes\/\w+\/options$/.test(route)) value = schema.attributes.find((a) => a.attribute_code === route.split('/')[2]).options;
      else assert.fail(`Unexpected Magento resource: ${route}`);
      return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    };
    const imported = await transfer.importArtifact(wrapper, { expectedHash: wrapper.artifactHash,
      expectedDatabase: database, installationKey: source.installationKey, actorUserId: Number(admin.applicationUser.id) },
    config, { databasePool: pool, fetchImpl, mutationContext: { actorUserId: Number(admin.applicationUser.id), requestId: 'transfer-import' } });
    assert.equal(imported.state, 'draft'); assert.notEqual(imported.id, source.id);
    const stored = await bindings.getRevision(imported.id);
    assert.deepEqual(stored.bindings, source.bindings); assert.equal(stored.state, 'draft');
    assert.equal((await bindings.validateDraft(imported.id)).valid, true);
    assert.equal((await pool.query("SELECT count(*)::int n FROM audit_events WHERE event_key='magento_binding.imported' AND subject_id=$1", [imported.id])).rows[0].n, 1);
    const before = (await pool.query('SELECT count(*)::int n FROM magento_binding_revisions')).rows[0].n;
    const changedFetch = async (url, init) => {
      const response = await fetchImpl(url, init); const body = await response.json();
      if (new URL(url).pathname.endsWith('/kolir/options')) body.find((o) => o.value === 'red-id').label = 'Changed';
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    };
    const altered = structuredClone(wrapper); altered.artifact.source.revisionId = crypto.randomUUID();
    altered.artifactHash = require('../src/services/magento/binding-contract').hash(altered.artifact);
    await assert.rejects(transfer.importArtifact(altered, { expectedHash: altered.artifactHash,
      expectedDatabase: database, installationKey: source.installationKey, actorUserId: Number(admin.applicationUser.id) },
    config, { databasePool: pool, fetchImpl: changedFetch, mutationContext: { actorUserId: Number(admin.applicationUser.id) } }),
    { code: 'MAGENTO_BINDING_TARGET_DRIFT' });
    assert.equal((await pool.query('SELECT count(*)::int n FROM magento_binding_revisions')).rows[0].n, before);
  });
});
