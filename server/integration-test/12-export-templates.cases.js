const suite = require('./suite-context'); // Sets DATABASE_URL before any database-bound import.
const { assert, test, pool, crypto, request, authenticateApplicationSession, authenticateIdentitySession,
  Pool, TEST_DATABASE_URL, fs, path, os, serverRoot, runNodeInDatabase, recreateTestDatabase, dropTestDatabase } = suite;
const templates = require('../src/services/export-templates/template.service');
const { compileDefinition } = require('../src/services/export-templates/definition');
const { evaluateBatch } = require('../src/services/export-templates/evaluate');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { loadSourceEvidence, validateSourceReferences } = require('../src/services/export-templates/source-references');
const { APPLICATION_USER_ADMIN_LOCK_KEY } = require('../src/services/access-admin-transaction');
const { catalog, product } = require('../test/fixtures/magento-v1/contract');
const { cases } = require('../test/fixtures/magento-v1/expected-rows');
const goldens = require('../test/fixtures/magento-v1/goldens.json');
const root = '/api/admin/export-templates';
const literal = (value) => ({ op: 'literal', value });
let admin;
function options(session = admin, databasePool = pool) {
  return { databasePool, mutationContext: { actorUserId: Number(session.applicationUser.id), requestId: 'pr2-integration' } };
}
function definition(name = 'Frozen PR2 fixture') {
  const d = materializeMagentoV1(catalog());
  d.sources = { sku: { kind: 'product', field: 'full_sku', type: 'text' },
    price: { kind: 'product', field: 'total_price_uah', type: 'scalar' } };
  d.tables = {}; d.questionContracts = {}; d.bindings = [];
  for (const group of d.groups) {
    group.evaluate = [];
    for (const row of group.rows) {
      row.cells = { sku: { op: 'text', input: { op: 'source', id: 'sku' }, trim: false, format: 'string-only-v1', onAbsent: 'empty' },
        store_view_code: literal(row.id === 'base' ? '' : 'en'), name: literal(name),
        attribute_set_code: literal(group.name), product_type: literal('simple') };
      if (row.id === 'base') row.cells.price = { op: 'numberText', input: { op: 'source', id: 'price' },
        format: 'js-number-positive-v1', error: { op: 'error', field: 'price', message: literal('Stored price required') } };
    }
  }
  compileDefinition(d);
  return d;
}
async function family(d = definition(), suffix = '') {
  return templates.createTemplate({ key: `pr2-${crypto.randomUUID()}${suffix}`, displayName: 'PR2 test', definition: d }, options());
}
function precondition(draft) { return { expectedRevision: draft.revision, expectedDefinitionHash: draft.definitionHash }; }
async function events(id, eventKey) {
  return (await pool.query('SELECT * FROM audit_events WHERE subject_id = $1 AND event_key = $2 ORDER BY id', [id, eventKey])).rows;
}
async function businessState() {
  // Fixed allowlist; complete rows catch payload changes as well as row-count changes.
  const state = {};
  for (const table of ['products', 'questions', 'options', 'sku_schema_versions', 'sku_schema_questions', 'sku_schema_options',
    'export_snapshots', 'magento_export_artifacts', 'price_export_snapshots', 'product_export_revisions', 'export_state']) {
    state[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(t ORDER BY to_jsonb(t)::text), '[]') AS data FROM ${table} t`)).rows[0].data;
  }
  return state;
}
async function waitBlocked(pid, blocker) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await pool.query('SELECT $2::integer = ANY(pg_blocking_pids($1)) AS blocked', [pid, blocker]);
    if (result.rows[0].blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  assert.fail(`Process ${pid} never waited on blocker ${blocker}`);
}
async function connectionPool() {
  const db = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  const pid = Number((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  return { db, pid };
}
async function heldAccessLock() {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [APPLICATION_USER_ADMIN_LOCK_KEY]);
  const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  return { client, pid };
}

async function installGoldenEvidence() {
  // Synthetic historical evidence inside the disposable fixture only. Never a startup baseline.
  const d = materializeMagentoV1(catalog());
  for (const group of d.groups) {
    await pool.query(`INSERT INTO categories (code, name, requires_weight) VALUES ($1,$2,0)
      ON CONFLICT (code) DO NOTHING`, [group.route, group.name]);
    const schema = (await pool.query(`INSERT INTO sku_schema_versions
      (category_code, version, marker, status, config_hash)
      SELECT $1, COALESCE(MAX(version), 0) + 1, $2, 'archived', 'PR2 synthetic reference fixture'
      FROM sku_schema_versions WHERE category_code = $1 RETURNING id`,
    [group.route, `pr2-${crypto.randomUUID()}`])).rows[0];
    let index = 0;
    for (const [sourceId, source] of Object.entries(d.sources).filter(([, s]) => s.category === group.route)) {
      if (source.kind === 'information') {
        const current = await pool.query('SELECT include_in_sku FROM questions WHERE category_code = $1 AND key = $2', [group.route, source.key]);
        if (!current.rows.length) await pool.query(`INSERT INTO questions
          (category_code, key, label, sku_index, display_order, required, include_in_sku, input_type)
          VALUES ($1,$2,'PR2 informational fixture',0,999,0,0,'text')`, [group.route, source.key]);
        else assert.equal(Number(current.rows[0].include_in_sku), 0);
        continue;
      }
      const q = (await pool.query(`INSERT INTO sku_schema_questions
        (schema_version_id, question_key, label, sku_index) VALUES ($1,$2,'PR2 historical fixture',$3) RETURNING id`,
      [schema.id, source.key, ++index])).rows[0];
      const ids = [...new Set(Object.values(d.questionContracts).filter((c) => c.source === sourceId).flatMap((c) => c.allowed))];
      for (const value of ids) await pool.query(`INSERT INTO sku_schema_options
        (schema_question_id, value_id, sku_code, label, archived) VALUES ($1,$2,$3,'Archived fixture; not an output source',true)`,
      [q.id, Number(value), String(Number(value) + 900)]);
    }
  }
}

test('PR2 fresh migration: legacy selection, Administrator grants, historical snapshots unattributed', async () => {
  admin = await authenticateApplicationSession();
  const selected = await templates.getActivation();
  assert.equal(selected.implementation, 'legacy'); assert.equal(selected.templateVersionId, null);
  assert.equal(selected.generation, '1'); assert.equal(selected.changedByUserId, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM export_templates')).rows[0].n, 0);
  assert.deepEqual((await pool.query(`SELECT r.role_key, count(*)::int AS n FROM roles r
    JOIN role_permissions rp ON rp.role_id = r.id WHERE rp.permission_key LIKE 'export_templates.%'
    GROUP BY r.role_key ORDER BY r.role_key`)).rows, [{ role_key: 'administrator', n: 4 }]);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM export_snapshots
    WHERE template_version_id IS NOT NULL`)).rows[0].n, 0);
  assert.equal((await request(`${root}/sources`, { authentication: admin })).response.status, 200);
  const hints = await templates.listSources();
  assert.equal(hints.productionAcceptanceVerified, false);
  assert.ok(hints.operations.includes('questionValue'));
});

module.exports = { definition, installGoldenEvidence };

test('PR2 JSONB drafts and publications retain canonical hashes and all ten independent exact CSV goldens', async () => {
  await installGoldenEvidence();
  for (const fixture of cases) {
    const rules = catalog();
    for (const [key, changes] of Object.entries(fixture.questions || {})) Object.assign(rules.get(fixture.group).get(key), changes);
    const original = compileDefinition(materializeMagentoV1(rules));
    const f = await family(original.definition);
    const loaded = await templates.getTemplate(f.id);
    assert.equal(loaded.draft.state, 'draft');
    const recompiled = compileDefinition(loaded.draft.definition);
    assert.equal(recompiled.hash, original.hash);
    const result = evaluateBatch(recompiled, [product(fixture.group, fixture.answers, fixture.product)]);
    assert.deepEqual(Buffer.from(result.artifacts[0].csvContent), Buffer.from(goldens[fixture.id]));
    const published = await templates.publishTemplate(f.id, precondition(loaded.draft), options());
    const durable = (await templates.getTemplate(f.id)).versions[0];
    assert.deepEqual(durable, published);
    const publishedPlan = compileDefinition(durable.definition);
    assert.equal(publishedPlan.hash, original.hash);
    const publishedOutput = evaluateBatch(publishedPlan, [product(fixture.group, fixture.answers, fixture.product)]);
    assert.deepEqual(Buffer.from(publishedOutput.artifacts[0].csvContent), Buffer.from(goldens[fixture.id]));
  }
  const large = materializeMagentoV1(catalog());
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 100 * 1024);
  const created = await request(root, { authentication: admin, method: 'POST', body: {
    key: `pr2-large-${crypto.randomUUID()}`, displayName: 'Large definition', definition: large,
  } });
  assert.equal(created.response.status, 201, created.text);
});

test('PR2 draft CAS, no-op, clone ownership, immutable publication and retry after edit', async () => {
  const f = await family({ groups: [] });
  await assert.rejects(templates.publishTemplate(f.id, precondition(f.draft), options()), { code: 'TEMPLATE_INVALID' });
  const d = await templates.saveDraft(f.id, { expectedRevision: '1', definition: definition() }, options());
  const same = await templates.saveDraft(f.id, { expectedRevision: d.revision, definition: d.definition }, options());
  assert.equal(same.revision, '2'); assert.equal((await events(f.id, 'export_template.draft_updated')).length, 1);
  await assert.rejects(templates.saveDraft(f.id, { expectedRevision: '1', definition: d.definition }, options()), { code: 'TEMPLATE_DRAFT_CONFLICT' });
  const before = await businessState(); const activation = await templates.getActivation();
  const version = await templates.publishTemplate(f.id, precondition(d), options());
  assert.equal(version.versionNumber, '1'); assert.equal(version.sourceDraftRevision, '2');
  assert.equal(version.publishedByUserId, String(admin.applicationUser.id));
  assert.deepEqual(await templates.getActivation(), activation);
  const newer = await templates.saveDraft(f.id, { expectedRevision: '2', definition: definition('new') }, options());
  assert.equal(newer.revision, '3');
  assert.deepEqual(await templates.publishTemplate(f.id, precondition(d), options()), version);
  await assert.rejects(templates.publishTemplate(f.id, { expectedRevision: '2', expectedDefinitionHash: 'f'.repeat(64) }, options()), { code: 'TEMPLATE_DRAFT_CONFLICT' });
  assert.equal((await events(f.id, 'export_template.published')).length, 1);
  const second = await templates.publishTemplate(f.id, precondition(newer), options());
  assert.equal(second.versionNumber, '2');
  const clone = await templates.cloneDraft(f.id, { expectedRevision: '3', versionId: version.id }, options());
  assert.equal(clone.revision, '4'); assert.equal(clone.baseVersionId, version.id);
  assert.equal(clone.definitionHash, version.definitionHash);
  const other = await family();
  await assert.rejects(templates.cloneDraft(other.id, { expectedRevision: '1', versionId: version.id }, options()), { code: 'TEMPLATE_DRAFT_CONFLICT' });
  await assert.rejects(pool.query('UPDATE export_template_drafts SET base_version_id = $1, revision = revision + 1 WHERE template_id = $2', [version.id, other.id]), { code: '23503' });
  for (const sql of [
    'UPDATE export_template_versions SET definition = definition WHERE id = $1',
    'UPDATE export_template_versions SET published_at = CURRENT_TIMESTAMP WHERE id = $1',
    'UPDATE export_template_versions SET definition_hash = definition_hash WHERE id = $1',
    'DELETE FROM export_template_versions WHERE id = $1',
  ]) await assert.rejects(pool.query(sql, [version.id]), /immutable/);
  await assert.rejects(pool.query('TRUNCATE export_template_versions CASCADE'), /publications are immutable/);
  await assert.rejects(pool.query('DELETE FROM export_templates WHERE id = $1', [f.id]), /permanent/);
  await assert.rejects(pool.query('UPDATE export_templates SET template_key = $2 WHERE id = $1', [f.id, 'rewritten']), /immutable/);
  await assert.rejects(pool.query('UPDATE export_template_drafts SET revision = 1 WHERE template_id = $1', [f.id]), /revision/);
  const stored = (await templates.getTemplate(f.id)).versions;
  assert.deepEqual(stored, [version, second]);
  assert.deepEqual(await businessState(), before);
});

test('PR2 controlled concurrent saves and publications use independent waiting connections', async () => {
  const f = await family(); const a = await connectionPool(); const b = await connectionPool();
  let blocker = await heldAccessLock();
  try {
    const left = templates.saveDraft(f.id, { expectedRevision: '1', definition: definition('left') }, options(admin, a.db));
    const settledLeft = left.then((value) => ({ value }), (error) => ({ error }));
    await waitBlocked(a.pid, blocker.pid);
    const right = templates.saveDraft(f.id, { expectedRevision: '1', definition: definition('right') }, options(admin, b.db));
    const settledRight = right.then((value) => ({ value }), (error) => ({ error }));
    await waitBlocked(b.pid, blocker.pid);
    await blocker.client.query('COMMIT'); blocker.client.release(); blocker = null;
    const results = await Promise.all([settledLeft, settledRight]);
    assert.equal(results.filter((r) => r.value).length, 1);
    assert.equal(results.find((r) => r.error).error.code, 'TEMPLATE_DRAFT_CONFLICT');
    const loaded = await templates.getTemplate(f.id);
    assert.equal(loaded.draft.revision, '2'); assert.equal((await events(f.id, 'export_template.draft_updated')).length, 1);
    blocker = await heldAccessLock();
    const one = templates.publishTemplate(f.id, precondition(loaded.draft), options(admin, a.db));
    await waitBlocked(a.pid, blocker.pid);
    const two = templates.publishTemplate(f.id, precondition(loaded.draft), options(admin, b.db));
    await waitBlocked(b.pid, blocker.pid);
    await blocker.client.query('COMMIT'); blocker.client.release(); blocker = null;
    const versions = await Promise.all([one, two]);
    assert.deepEqual(versions[0], versions[1]);
    assert.equal((await templates.getTemplate(f.id)).versions.length, 1);
    assert.equal((await events(f.id, 'export_template.published')).length, 1);
  } finally {
    if (blocker) { await blocker.client.query('ROLLBACK'); blocker.client.release(); }
    await a.db.end(); await b.db.end();
  }
});

test('PR2 publish/edit race locks one whole revision, including edit-first conflict', async () => {
  for (const publishFirst of [true, false]) {
    const f = await family(); const a = await connectionPool(); const b = await connectionPool();
    const blocker = await heldAccessLock();
    try {
      const publish = (db) => templates.publishTemplate(f.id, precondition(f.draft), options(admin, db));
      const edit = (db) => templates.saveDraft(f.id, { expectedRevision: '1', definition: definition('race edit') }, options(admin, db));
      const first = (publishFirst ? publish : edit)(a.db).then((value) => ({ value }), (error) => ({ error }));
      await waitBlocked(a.pid, blocker.pid);
      const last = (publishFirst ? edit : publish)(b.db).then((value) => ({ value }), (error) => ({ error }));
      await waitBlocked(b.pid, blocker.pid);
      await blocker.client.query('COMMIT');
      const results = await Promise.all([first, last]);
      assert.ok(results[0].value);
      const current = await templates.getTemplate(f.id);
      assert.equal(current.draft.revision, '2');
      if (publishFirst) {
        assert.ok(results[1].value); assert.equal(current.versions.length, 1);
        assert.equal(current.versions[0].definitionHash, f.draft.definitionHash);
      } else { assert.equal(results[1].error.code, 'TEMPLATE_DRAFT_CONFLICT'); assert.equal(current.versions.length, 0); }
      assert.equal((await events(f.id, 'export_template.published')).length, publishFirst ? 1 : 0);
    } finally {
      await blocker.client.query('ROLLBACK'); blocker.client.release(); await a.db.end(); await b.db.end();
    }
  }
});

test('PR2 metadata activation CAS, no-op and ABA leave actual exporters and business rows unchanged', async () => {
  const f = await family(); const a = await templates.publishTemplate(f.id, precondition(f.draft), options());
  const d = await templates.saveDraft(f.id, { expectedRevision: '1', definition: definition('B') }, options());
  const b = await templates.publishTemplate(f.id, precondition(d), options());
  const before = await businessState();
  const exportStatus = await request('/api/export/status', { authentication: admin });
  let current = await templates.getActivation();
  const unchanged = await templates.updateActivation({ expectedGeneration: current.generation, implementation: 'legacy', templateVersionId: null }, options());
  assert.deepEqual(unchanged, current);
  const auditBefore = (await events('selection', 'export_template.activated')).length;
  for (const id of [a.id, b.id, a.id]) {
    const prior = current.generation;
    current = await templates.updateActivation({ expectedGeneration: prior, implementation: 'template', templateVersionId: id }, options());
    assert.equal(BigInt(current.generation), BigInt(prior) + 1n);
    assert.equal(current.metadataOnly, true); assert.equal(current.effectiveExporter, 'legacy');
    await assert.rejects(templates.updateActivation({ expectedGeneration: prior, implementation: 'template', templateVersionId: id }, options()), { code: 'TEMPLATE_ACTIVATION_CONFLICT' });
    const same = await templates.updateActivation({ expectedGeneration: current.generation, implementation: 'template', templateVersionId: id }, options());
    assert.deepEqual(same, current);
  }
  assert.equal((await events('selection', 'export_template.activated')).length - auditBefore, 3);
  await assert.rejects(templates.updateActivation({ expectedGeneration: current.generation, implementation: 'legacy', templateVersionId: a.id }, options()), { code: 'TEMPLATE_COMMAND_INVALID' });
  await assert.rejects(templates.updateActivation({ expectedGeneration: current.generation, implementation: 'template', templateVersionId: crypto.randomUUID() }, options()), { code: 'TEMPLATE_VERSION_NOT_FOUND' });
  // An older/newer implementation may have inserted an unsupported immutable version.
  // Insert a fixture, never disable immutability to modify a publication.
  const unsupported = definition(); unsupported.evaluatorVersion = 'future-evaluator';
  const unsupportedId = crypto.randomUUID();
  await pool.query(`INSERT INTO export_template_versions
    (id, template_id, version_number, source_draft_revision, definition, definition_hash,
     format_version, evaluator_version, output_contract, published_by_user_id)
    VALUES ($1,$2,100,100,$3::jsonb,$4,1,'future-evaluator','magento-products-v1',$5)`,
  [unsupportedId, f.id, JSON.stringify(unsupported), 'a'.repeat(64), admin.applicationUser.id]);
  await assert.rejects(templates.updateActivation({ expectedGeneration: current.generation, implementation: 'template', templateVersionId: unsupportedId }, options()), { code: 'TEMPLATE_INVALID' });
  assert.deepEqual(await businessState(), before);
  assert.deepEqual((await request('/api/export/status', { authentication: admin })).data, exportStatus.data);
  const sku = (await pool.query("SELECT full_sku FROM products WHERE category = 'BR' ORDER BY id LIMIT 1")).rows[0]?.full_sku;
  if (sku) {
    const preview = await request('/api/export/preview', { authentication: admin, method: 'POST', body: { fromSku: sku, toSku: sku } });
    assert.equal(preview.response.status, 200, preview.text);
    assert.doesNotMatch(JSON.stringify(preview.data), /Frozen PR2 fixture|future-evaluator/);
  }
  await templates.updateActivation({ expectedGeneration: current.generation, implementation: 'legacy', templateVersionId: null }, options());
});

test('PR2 validation and test-preview read only authoritative stored inputs and bind revision/hash', async () => {
  const f = await family();
  const stored = (await pool.query(`INSERT INTO products (full_sku, base_sku, category, weight, total_price_uah, details)
    VALUES ($1, $1, 'BR', 10, 1234.56, '{"answers":{}}') RETURNING id, full_sku`, [`BR-PR2-${crypto.randomUUID()}`])).rows[0];
  const before = await businessState();
  const audits = (await pool.query('SELECT count(*) FROM audit_events')).rows[0].count;
  const body = precondition(f.draft);
  const valid = await request(`${root}/${f.id}/validate`, { authentication: admin, method: 'POST', body });
  assert.equal(valid.response.status, 200, valid.text);
  const preview = await request(`${root}/${f.id}/test-preview`, { authentication: admin, method: 'POST', body: { ...body, productIds: [stored.id] } });
  assert.equal(preview.response.status, 200, preview.text);
  assert.equal(preview.data.result.status, 'ready');
  assert.match(preview.data.result.artifacts[0].csvContent, /1234\.56/);
  assert.equal(preview.data.previewToken, undefined);
  for (const extra of [{ products: [{ id: stored.id, total_price_uah: 1 }] }, { total_price_uah: 1 }]) {
    const attempt = await request(`${root}/${f.id}/test-preview`, { authentication: admin, method: 'POST', body: { ...body, productIds: [stored.id], ...extra } });
    assert.equal(attempt.response.status, 400, attempt.text);
  }
  const missing = await request(`${root}/${f.id}/test-preview`, { authentication: admin, method: 'POST', body: { ...body, productIds: [stored.id, 2147483647] } });
  assert.equal(missing.response.status, 422); assert.deepEqual(missing.data.details.missingProductIds, [2147483647]);
  await assert.rejects(templates.testPreview(f.id, { ...body, productIds: Array.from({ length: 101 }, (_, i) => i + 1) }), { code: 'TEMPLATE_COMMAND_INVALID' });
  await assert.rejects(templates.testPreview(f.id, { ...body, expectedDefinitionHash: 'f'.repeat(64), productIds: [stored.id] }), { code: 'TEMPLATE_DRAFT_CONFLICT' });
  await assert.rejects(templates.validateDraft(f.id, { ...body, expectedRevision: '2' }), { code: 'TEMPLATE_DRAFT_CONFLICT' });
  assert.deepEqual(await businessState(), before);
  assert.equal((await pool.query('SELECT count(*) FROM audit_events')).rows[0].count, audits);
});

test('PR2 template metadata selection leaves normal Magento and dedicated price CSV dispatch unchanged', async () => {
  const input = product('BR');
  const stored = (await pool.query(`INSERT INTO products (full_sku, base_sku, category, weight, total_price_uah, details)
    VALUES ($1,$1,'BR',10.5,1234.56,$2::jsonb) RETURNING id, full_sku`,
  [`BR-PR2-EXPORT-${crypto.randomUUID()}`.toUpperCase(), JSON.stringify(input.details)])).rows[0];
  async function normalCsv() {
    const result = await request('/api/export/snapshots', { authentication: admin, method: 'POST', body: {
      fromSku: stored.full_sku, toSku: stored.full_sku, idempotencyKey: crypto.randomUUID(),
    } });
    assert.equal(result.response.status, 201, result.text);
    const download = await request(`/api/export/snapshots/${result.data.id}/magento/BR/csv`, { authentication: admin });
    assert.equal(download.response.status, 200, download.text);
    return download.text;
  }
  async function priceCsv() {
    const result = await request('/api/price-export/snapshots', { authentication: admin, method: 'POST', body: { idempotencyKey: crypto.randomUUID() } });
    assert.equal(result.response.status, 201, result.text);
    const download = await request(`/api/price-export/snapshots/${result.data.id}/csv`, { authentication: admin });
    assert.equal(download.response.status, 200, download.text);
    return download.text;
  }
  const legacy = await normalCsv();
  assert.match(legacy, /Браслет з натурального бурштину/);
  await pool.query('UPDATE product_export_revisions SET revision = 1, confirmed_revision = 0 WHERE product_id = $1', [stored.id]);
  const prices = await priceCsv();
  assert.ok(prices.startsWith('sku,price\n')); assert.ok(prices.includes(`${stored.full_sku},1234.56`));
  const f = await family(definition('SHOULD NOT BE EXPORTED'));
  const version = await templates.publishTemplate(f.id, precondition(f.draft), options());
  const before = await businessState();
  const prior = await templates.getActivation();
  const selected = await templates.updateActivation({ expectedGeneration: prior.generation, implementation: 'template', templateVersionId: version.id }, options());
  assert.deepEqual(await businessState(), before);
  try {
    assert.equal(await normalCsv(), legacy);
    assert.equal(await priceCsv(), prices);
  } finally {
    await templates.updateActivation({ expectedGeneration: selected.generation, implementation: 'legacy', templateVersionId: null }, options());
  }
});

test('PR2 mismatching stored publication hash fails closed without replacing provenance', async () => {
  const f = await family(); const id = crypto.randomUUID();
  await pool.query(`INSERT INTO export_template_versions
    (id, template_id, version_number, source_draft_revision, definition, definition_hash,
     format_version, evaluator_version, output_contract, published_by_user_id)
    VALUES ($1,$2,1,1,$3::jsonb,$4,1,'magento-declarative-1','magento-products-v1',$5)`,
  [id, f.id, JSON.stringify(f.draft.definition), 'b'.repeat(64), admin.applicationUser.id]);
  const selected = await templates.getActivation();
  await assert.rejects(templates.updateActivation({ expectedGeneration: selected.generation, implementation: 'template', templateVersionId: id }, options()), { code: 'TEMPLATE_VERSION_INTEGRITY' });
  await assert.rejects(templates.publishTemplate(f.id, { expectedRevision: '1', expectedDefinitionHash: 'b'.repeat(64) }, options()), { code: 'TEMPLATE_VERSION_INTEGRITY' });
  const after = await templates.getTemplate(f.id);
  assert.equal(after.versions[0].definitionHash, 'b'.repeat(64));
  assert.equal((await events(f.id, 'export_template.published')).length, 0);
});

test('PR2 repository source evidence rejects unresolved contracts and unsupported aliases', async () => {
  const evidence = await loadSourceEvidence(pool);
  const schema = evidence.schemas.find((s) => s.category_code === 'BR');
  assert.ok(schema);
  const q = schema.questions[0];
  const d = definition();
  d.sources.historical = { kind: 'semantic', category: 'BR', key: q.key, type: 'scalar', provenance: 'supplied-stored-answers-v1', aliases: [] };
  d.questionContracts.q = { source: 'historical', exists: true, required: false, rule: {}, allowed: q.value_ids };
  assert.deepEqual(validateSourceReferences(d, evidence), []);
  const f = await family(d);
  await templates.publishTemplate(f.id, precondition(f.draft), options());
  for (const mutate of [
    (next) => { next.sources.historical.key = 'no_such_question'; },
    (next) => { next.questionContracts.q.exists = false; },
    (next) => { next.questionContracts.q.allowed = ['999999']; },
    (next) => { next.sources.historical.aliases = [{ schemaId: String(schema.id), key: 'no_such_alias', evidence: 'client claim' }]; },
    (next) => { next.formatVersion = 99; },
    (next) => { next.evaluatorVersion = 'unsupported'; },
  ]) {
    const next = structuredClone(d); mutate(next); const invalid = await family(next);
    await assert.rejects(templates.publishTemplate(invalid.id, precondition(invalid.draft), options()), (err) => err.statusCode === 422);
    assert.equal((await templates.getTemplate(invalid.id)).versions.length, 0);
    assert.equal((await events(invalid.id, 'export_template.published')).length, 0);
  }
});

test('PR2 HTTP auth, active-state, CSRF and individually delegated capabilities', async () => {
  const f = await family();
  const calls = [
    [root, 'GET', null, 'view'], [`${root}/sources`, 'GET', null, 'view'], [`${root}/${f.id}`, 'GET', null, 'view'],
    [`${root}/activation`, 'GET', null, 'view'],
    [root, 'POST', { key: `pr2-denied-${crypto.randomUUID()}`, displayName: 'Denied' }, 'manage'],
    [`${root}/${f.id}/draft`, 'PUT', { expectedRevision: '1', definition: f.draft.definition }, 'manage'],
    [`${root}/${f.id}/draft/from-version`, 'POST', { expectedRevision: '1', versionId: crypto.randomUUID() }, 'manage'],
    [`${root}/${f.id}/validate`, 'POST', precondition(f.draft), 'manage'],
    [`${root}/${f.id}/test-preview`, 'POST', { ...precondition(f.draft), productIds: [1] }, 'manage'],
    [`${root}/${f.id}/publish`, 'POST', precondition(f.draft), 'publish'],
    [`${root}/activation`, 'PUT', { expectedGeneration: '1', implementation: 'legacy', templateVersionId: null }, 'activate'],
  ];
  const pending = await authenticateIdentitySession({ subject: `pr2-pending-${crypto.randomUUID()}` });
  for (const [url, method, body] of calls) {
    assert.equal((await request(url, { method, body, authentication: null })).response.status, 401);
    const denied = await request(url, { method, body, authentication: pending });
    assert.equal(denied.response.status, 403); assert.equal(denied.data.code, 'APP_ACCESS_PENDING');
    if (method !== 'GET') assert.equal((await request(url, { method, body, authentication: admin, csrfToken: null })).response.status, 403);
  }
  const roleResult = await request('/api/admin/roles', { authentication: admin, method: 'POST', body: {
    displayName: `PR2 delegated ${crypto.randomUUID()}`, description: 'Explicit template delegation', permissionKeys: [],
  } });
  assert.equal(roleResult.response.status, 201, roleResult.text);
  let role = roleResult.data.role;
  assert.equal((await request(`/api/admin/users/${pending.applicationUser.id}/approve`, { authentication: admin, method: 'POST', body: { roleId: role.id } })).response.status, 200);
  for (const [url, method, body, capability] of calls) {
    const denied = await request(url, { method, body, authentication: pending });
    assert.equal(denied.response.status, 403); assert.equal(denied.data.requiredPermission, `export_templates.${capability}`);
  }
  async function grant(keys) {
    const result = await request(`/api/admin/roles/${role.id}/permissions`, { authentication: admin, method: 'PUT', body: {
      permissionKeys: keys, expectedVersion: role.version, expectedActiveAssignedUserCount: 1,
    } });
    assert.equal(result.response.status, 200, result.text); role = result.data.role;
  }
  await grant(['export_templates.view']);
  for (const url of [root, `${root}/sources`, `${root}/activation`, `${root}/${f.id}`]) assert.equal((await request(url, { authentication: pending })).response.status, 200);
  await grant(['export_templates.manage']);
  const made = await request(root, { authentication: pending, method: 'POST', body: { key: `pr2-delegated-${crypto.randomUUID()}`, displayName: 'Delegated', definition: definition() } });
  assert.equal(made.response.status, 201, made.text);
  assert.equal((await request(`${root}/${made.data.id}/validate`, { authentication: pending, method: 'POST', body: precondition(made.data.draft) })).response.status, 200);
  const noExports = await request(`${root}/${made.data.id}/test-preview`, { authentication: pending, method: 'POST', body: { ...precondition(made.data.draft), productIds: [1] } });
  assert.equal(noExports.response.status, 403); assert.equal(noExports.data.requiredPermission, 'exports.view');
  await grant(['export_templates.manage', 'exports.view']);
  const previewProduct = (await pool.query("SELECT id FROM products WHERE category = 'BR' ORDER BY id DESC LIMIT 1")).rows[0];
  const preview = await request(`${root}/${made.data.id}/test-preview`, { authentication: pending, method: 'POST', body: {
    ...precondition(made.data.draft), productIds: [previewProduct.id],
  } });
  assert.equal(preview.response.status, 200, preview.text);
  await grant(['export_templates.publish']);
  const published = await request(`${root}/${made.data.id}/publish`, { authentication: pending, method: 'POST', body: precondition(made.data.draft) });
  assert.equal(published.response.status, 200, published.text);
  assert.equal(published.data.publishedByUserId, String(pending.applicationUser.id));
  const retry = await request(`${root}/${made.data.id}/publish`, { authentication: admin, method: 'POST', body: precondition(made.data.draft) });
  assert.deepEqual(retry.data, published.data);
  assert.equal((await events(made.data.id, 'export_template.published')).length, 1);
  for (const injected of [{ actorUserId: 1 }, { versionNumber: 99 }, { definitionHash: 'f'.repeat(64) }, { publishedAt: '2000-01-01' }]) {
    const denied = await request(`${root}/${made.data.id}/publish`, { authentication: pending, method: 'POST', body: {
      ...precondition(made.data.draft), ...injected,
    } });
    assert.equal(denied.response.status, 400, denied.text);
  }
  await grant(['export_templates.activate']);
  let selected = await templates.getActivation();
  const chosen = await request(`${root}/activation`, { authentication: pending, method: 'PUT', body: {
    expectedGeneration: selected.generation, implementation: 'template', templateVersionId: published.data.id,
  } });
  assert.equal(chosen.response.status, 200, chosen.text);
  assert.equal(chosen.data.changedByUserId, String(pending.applicationUser.id));
  selected = chosen.data;
  await templates.updateActivation({ expectedGeneration: selected.generation, implementation: 'legacy', templateVersionId: null }, options());
  assert.equal((await request('/api/admin/users', { authentication: pending })).response.status, 403);
  assert.equal((await request('/api/admin/audit-events', { authentication: pending })).response.status, 403);
  assert.equal((await request(`/api/admin/users/${pending.applicationUser.id}/disable`, { authentication: admin, method: 'POST', body: {} })).response.status, 200);
  for (const [url, method, body] of calls) {
    const denied = await request(url, { method, body, authentication: pending });
    assert.equal(denied.response.status, 403); assert.equal(denied.data.code, 'APP_ACCESS_DISABLED');
  }
  const audit = await request('/api/admin/audit-events?domain=export_template', { authentication: admin });
  assert.equal(audit.response.status, 200, audit.text);
  assert.ok(audit.data.items.some((item) => item.details.definitionHash));
});

test('PR2 permission revocation and disablement while publication waits recheck after access lock', async () => {
  for (const disable of [false, true]) {
    const f = await family();
    const actor = await authenticateIdentitySession({ subject: `pr2-revoke-${crypto.randomUUID()}` });
    const role = (await request('/api/admin/roles', { authentication: admin, method: 'POST', body: {
      displayName: `PR2 revocation ${crypto.randomUUID()}`, description: 'Race role', permissionKeys: ['export_templates.publish'],
    } })).data.role;
    await request(`/api/admin/users/${actor.applicationUser.id}/approve`, { authentication: admin, method: 'POST', body: { roleId: role.id } });
    const worker = await connectionPool(); const blocker = await heldAccessLock();
    try {
      const pending = templates.publishTemplate(f.id, precondition(f.draft), options(actor, worker.db))
        .then((value) => ({ value }), (error) => ({ error }));
      await waitBlocked(worker.pid, blocker.pid);
      if (disable) await blocker.client.query("UPDATE application_users SET status = 'disabled' WHERE id = $1", [actor.applicationUser.id]);
      else await blocker.client.query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_key = 'export_templates.publish'", [role.id]);
      await blocker.client.query('COMMIT');
      assert.equal((await pending).error.code, 'ADMIN_PERMISSION_REVOKED');
      assert.equal((await templates.getTemplate(f.id)).versions.length, 0);
      assert.equal((await events(f.id, 'export_template.published')).length, 0);
    } finally { await blocker.client.query('ROLLBACK'); blocker.client.release(); await worker.db.end(); }
  }
});

test('PR2 injected audit failure rolls back create, draft, publish and metadata selection atomically', async () => {
  const f = await family(); const other = await family();
  const version = await templates.publishTemplate(other.id, precondition(other.draft), options());
  const selected = await templates.getActivation(); const before = await templates.getTemplate(f.id);
  const key = `pr2-rollback-${crypto.randomUUID()}`;
  await pool.query(`CREATE FUNCTION fail_pr2_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_key LIKE 'export_template.%' THEN RAISE EXCEPTION 'PR2 forced audit failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER fail_pr2_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_pr2_audit()`);
  try {
    await assert.rejects(templates.createTemplate({ key, displayName: 'Must roll back' }, options()), /PR2 forced audit failure/);
    await assert.rejects(templates.saveDraft(f.id, { expectedRevision: '1', definition: definition('rollback') }, options()), /PR2 forced audit failure/);
    await assert.rejects(templates.publishTemplate(f.id, precondition(f.draft), options()), /PR2 forced audit failure/);
    await assert.rejects(templates.updateActivation({ expectedGeneration: selected.generation, implementation: 'template', templateVersionId: version.id }, options()), /PR2 forced audit failure/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM export_templates WHERE template_key = $1', [key])).rows[0].n, 0);
    assert.deepEqual(await templates.getTemplate(f.id), before);
    assert.deepEqual(await templates.getActivation(), selected);
    assert.equal((await events(f.id, 'export_template.published')).length, 0);
    assert.equal((await events(f.id, 'export_template.draft_updated')).length, 0);
  } finally {
    await pool.query('DROP TRIGGER fail_pr2_audit ON audit_events; DROP FUNCTION fail_pr2_audit()');
  }
});

test('PR2 migration 034 checkpoint, transactional failure rollback and repeated startup', async () => {
  const name = 'amber_pr2_upgrade_test'; const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-pr2-migrations-'));
  const db = new Pool({ connectionString: url });
  try {
    const files = (await fs.readdir(path.join(serverRoot, 'migrations'))).filter((file) => file.endsWith('.sql') && file < '035_');
    for (const file of files) await fs.copyFile(path.join(serverRoot, 'migrations', file), path.join(directory, file));
    const run = (dir) => runNodeInDatabase(url, `const {runMigrations}=require('./src/db/run-migrations');
      runMigrations(${dir ? `{directory:${JSON.stringify(dir)}}` : ''}).catch(e=>{console.error(e);process.exitCode=1})`);
    await run(directory);
    assert.equal((await db.query('SELECT max(name) AS name FROM schema_migrations')).rows[0].name, '034_product_magento_manual_names.sql');
    await db.query("INSERT INTO roles (role_key, display_name, description) VALUES ('pre_pr2_custom', 'Pre PR2 custom', 'Existing custom role')");
    const migration = '035_export_templates.sql';
    const sql = await fs.readFile(path.join(serverRoot, 'migrations', migration), 'utf8');
    await fs.writeFile(path.join(directory, migration), sql + "\nSELECT 'forced PR2 failure'::integer;\n");
    await assert.rejects(run(directory), /forced PR2 failure/);
    assert.equal((await db.query("SELECT to_regclass('export_templates') AS table_name")).rows[0].table_name, null);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM permissions WHERE permission_key LIKE 'export_templates.%'")).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM schema_migrations WHERE name = $1', [migration])).rows[0].n, 0);
    await run(); await run();
    assert.deepEqual((await db.query('SELECT implementation, generation, template_version_id, changed_by_user_id FROM export_template_activation')).rows,
      [{ implementation: 'legacy', generation: '1', template_version_id: null, changed_by_user_id: null }]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM export_templates')).rows[0].n, 0);
    assert.deepEqual((await db.query(`SELECT r.role_key, count(*)::int AS n FROM roles r JOIN role_permissions p ON p.role_id = r.id
      WHERE p.permission_key LIKE 'export_templates.%' GROUP BY r.role_key`)).rows, [{ role_key: 'administrator', n: 4 }]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE event_key LIKE 'export_template.%'")).rows[0].n, 0);
  } finally {
    await db.end(); await fs.rm(directory, { recursive: true, force: true }); await dropTestDatabase(name);
  }
});
