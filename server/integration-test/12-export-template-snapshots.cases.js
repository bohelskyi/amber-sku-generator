const { insertProductFixture } = require('./product-fixture');
const suite = require('./suite-context');
const { assert, test, pool, Pool, TEST_DATABASE_URL, crypto, request, authenticateApplicationSession,
  authenticateIdentitySession, fs, path, os, serverRoot, runNodeInDatabase, recreateTestDatabase, dropTestDatabase } = suite;
const templates = require('../src/services/export-templates/template.service');
const exportsService = require('../src/services/export.service');
const prices = require('../src/services/price-export.service');
const { definition, installGoldenEvidence } = require('./12-export-templates.cases');
const { materializeMagentoV1 } = require('../src/services/export-templates/magento-v1-definition');
const { catalog, product } = require('../test/fixtures/magento-v1/contract');
const { cases } = require('../test/fixtures/magento-v1/expected-rows');
const goldens = require('../test/fixtures/magento-v1/goldens.json');
const { makeSigner } = require('../src/services/export-templates/snapshot-binding');
const signer = makeSigner(require('../src/config/env').sessionSecret);
const { APPLICATION_USER_ADMIN_LOCK_KEY } = require('../src/services/access-admin-transaction');
let admin;
let version;
const opts = (databasePool = pool, actor = admin) => ({ databasePool,
  mutationContext: { actorUserId: actor.applicationUser.id, requestId: 'pr3-integration' } });
const explicit = (v = version) => ({ mode: 'explicit', templateId: v.templateId, versionId: v.id });
const command = (p, selection = explicit()) => ({ requestContract: 'template-v1', selection,
  fromSku: p.full_sku, toSku: p.full_sku });
async function publish(d = definition('PR3 persisted')) {
  const family = await templates.createTemplate({ key: `pr3-${crypto.randomUUID()}`, displayName: 'PR3 fixture', definition: d }, opts());
  return templates.publishTemplate(family.id, { expectedRevision: family.draft.revision,
    expectedDefinitionHash: family.draft.definitionHash }, opts());
}
async function select(v) {
  const previous = await templates.getActivation();
  return templates.updateActivation({ expectedGeneration: previous.generation,
    implementation: v ? 'template' : 'legacy', templateVersionId: v?.id || null }, opts());
}
async function insert(p = product('BR'), sku = `BR-PR3-${crypto.randomUUID()}`.toUpperCase()) {
  return (await insertProductFixture(pool,`INSERT INTO products
    (full_sku, base_sku, category, weight, total_price_uah, details, magento_name_subject_ua, magento_name_subject_en)
    VALUES ($1,$1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *`, [sku, p.category, p.weight, p.total_price_uah,
    JSON.stringify(p.details), p.magento_name_subject_ua || null, p.magento_name_subject_en || null])).rows[0];
}
async function preview(input, options = opts()) { return exportsService.previewExport(input, options); }
async function create(input, p, key = crypto.randomUUID(), options = opts()) {
  return exportsService.createExportSnapshot({ ...input, idempotencyKey: key, previewToken: p?.previewToken }, options);
}
async function countEvents(id, key = 'export_snapshot.created') {
  return (await pool.query('SELECT count(*)::int AS n FROM audit_events WHERE subject_id=$1 AND event_key=$2', [id, key])).rows[0].n;
}
async function exportState() {
  const result = {};
  for (const table of ['export_snapshots', 'magento_export_artifacts', 'product_export_revisions', 'export_state']) {
    result[table] = (await pool.query(`SELECT COALESCE(jsonb_agg(t ORDER BY to_jsonb(t)::text),'[]') AS data FROM ${table} t`)).rows[0].data;
  }
  result.events = (await pool.query("SELECT count(*) FROM audit_events WHERE event_key LIKE 'export_snapshot.%'")).rows[0].count;
  return result;
}
async function worker() {
  const db = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  return { db, pid };
}
async function blocked(pid, by) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await pool.query('SELECT $2::int = ANY(pg_blocking_pids($1)) AS yes', [pid, by])).rows[0].yes) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`Expected backend ${pid} to wait on ${by}`);
}
async function blockedApplication(application, blockers) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await pool.query(`SELECT pid FROM pg_stat_activity
      WHERE application_name=$1 AND pg_blocking_pids(pid) && $2::int[]`, [application, blockers]);
    if (result.rows.length) return result.rows[0].pid;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`Expected independent process ${application} to wait on ${blockers}`);
}
async function barrier(sql, args = []) {
  const client = await pool.connect(); await client.query('BEGIN');
  await client.query(sql, args);
  return { client, pid: (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid };
}
const settled = (promise) => promise.then((value) => ({ value }), (error) => ({ error }));
function gatePool(db, pattern) {
  let reached;
  let release;
  const arrived = new Promise((r) => { reached = r; });
  const hold = new Promise((r) => { release = r; });
  let once = false;
  return { arrived, release, database: { query: (...args) => db.query(...args),
    connect: async () => {
      const client = await db.connect();
      return { release: (...args) => client.release(...args), query: async (...args) => {
        const result = await client.query(...args);
        if (!once && pattern.test(args[0])) { once = true; reached(); await hold; }
        return result;
      } };
    } } };
}

test('PR3 persisted preview and HTTP stored/downloaded parity for ten golden cases and all six groups', async () => {
  admin = await authenticateApplicationSession();
  await installGoldenEvidence();
  version = await publish();
  const byGroup = new Map();
  const durable = [];
  for (const fixture of cases) {
    const rules = catalog();
    for (const [key, changes] of Object.entries(fixture.questions || {})) Object.assign(rules.get(fixture.group).get(key), changes);
    const v = await publish(materializeMagentoV1(rules));
    const p = product(fixture.group, fixture.answers, fixture.product);
    let stored = byGroup.get(p.full_sku);
    if (!stored) { stored = await insert(p, p.full_sku); byGroup.set(p.full_sku, stored); }
    else await pool.query(`UPDATE products SET weight=$2,total_price_uah=$3,details=$4::jsonb,
      magento_name_subject_ua=$5,magento_name_subject_en=$6 WHERE id=$1`, [stored.id, p.weight, p.total_price_uah,
      JSON.stringify(p.details), p.magento_name_subject_ua || null, p.magento_name_subject_en || null]);
    const input = command(stored, explicit(v));
    const before = await exportState();
    const result = await request('/api/export/preview', { method: 'POST', authentication: admin, body: input });
    assert.equal(result.response.status, 200, result.text);
    assert.equal(result.data.representedCount, 1); assert.equal(result.data.readyCount, 1);
    assert.ok(result.data.previewToken); assert.equal(result.data.template.definitionHash, v.definitionHash);
    assert.deepEqual(await exportState(), before);
    const made = await request('/api/export/snapshots', { method: 'POST', authentication: admin,
      body: { ...input, previewToken: result.data.previewToken, idempotencyKey: crypto.randomUUID() } });
    assert.equal(made.response.status, 201, made.text);
    assert.equal(made.data.rowCount, 1); assert.equal(made.data.template.versionId, v.id);
    assert.equal(made.data.artifacts[0].rowCount, 2); assert.equal(made.data.artifacts[0].productCount, 1);
    assert.equal(made.data.artifacts[0].profileVersion, 'magento-products-v1');
    const download = await request(`/api/export/snapshots/${made.data.id}/magento/${fixture.group}/csv`, { authentication: admin });
    // The pure escaping oracle supplies a leading-space SKU, which migration 001
    // always trims on INSERT. Keep that oracle unchanged; adapt only its SKU to
    // the authoritative persisted value. All other bytes remain exact.
    const expected = fixture.id === 'SV-escaping' ? goldens[fixture.id].replaceAll(' =SKU', '=SKU') : goldens[fixture.id];
    assert.equal(stored.full_sku, p.full_sku.trim().toUpperCase());
    assert.deepEqual(Buffer.from(download.text), Buffer.from(expected), fixture.id);
    const artifact = await exportsService.getMagentoArtifact(made.data.id, fixture.group);
    assert.deepEqual(Buffer.from(artifact.csv_content), Buffer.from(expected));
    if (fixture.id === 'SV-escaping') {
      assert.equal(p.full_sku, ' =SKU', 'original pure fixture, before persistence');
      const authoritative = (await pool.query('SELECT * FROM products WHERE id=$1', [stored.id])).rows[0];
      assert.equal(authoritative.full_sku, '=SKU', '001 products_reserve_sku / reserve_product_sku: UPPER(TRIM(...))');
      const oldOutput = require('../src/services/magento-products-v1').buildMagentoPayload([authoritative], rules);
      assert.deepEqual(oldOutput.errors, []);
      assert.deepEqual(Buffer.from(oldOutput.artifacts[0].csvContent), Buffer.from(artifact.csv_content),
        'old mapper and published-template stored artifact: same persisted facts and captured catalog rules');
    }
    durable.push({ id: made.data.id, group: fixture.group, bytes: expected });
  }
  assert.equal(new Set([...byGroup.values()].map((p) => p.category)).size, 6);
  const allRows = [...byGroup.values()];
  const allInput = { ...command(allRows[0]), toSku: allRows.at(-1).full_sku };
  const all = await create(allInput, await preview(allInput));
  const allArtifacts = await exportsService.getMagentoArtifacts(all.id);
  assert.deepEqual(allArtifacts.map((a) => a.groupCode), ['BR', 'NM', 'KL', 'CH', 'AR', 'SV']);
  assert.equal(allArtifacts.reduce((n, a) => n + a.productCount, 0), allRows.length);
  assert.ok(allArtifacts.every((a) => a.rowCount === a.productCount * 2));
  const before = await exportState();
  for (const item of durable) {
    assert.equal((await exportsService.getMagentoArtifact(item.id, item.group)).csv_content, item.bytes);
    const manifest = await request(`/api/export/snapshots/${item.id}`, { authentication: admin });
    assert.equal(manifest.data.requestContract, 'template-v1');
  }
  assert.deepEqual(await exportState(), before);
});

test('PR3 full ranges exceed the administrative 100-product limit and persist complete provenance', async () => {
  const rows = [];
  for (let i = 0; i < 105; i++) rows.push(await insert());
  const input = { ...command(rows[0]), toSku: rows.at(-1).full_sku };
  const p = await preview(input); assert.equal(p.representedCount, 105); assert.equal(p.readyCount, 105);
  const s = await create(input, p);
  assert.equal(s.row_count, 105); assert.equal(s.template_version_id, version.id);
  assert.equal(s.request_contract, 'template-v1'); assert.deepEqual(s.request_intent, p.intent);
  assert.equal(s.binding_evidence.inputFingerprint, s.input_fingerprint);
  const artifacts = await exportsService.getMagentoArtifacts(s.id);
  assert.equal(artifacts.length, 1); assert.equal(artifacts[0].rowCount, 210); assert.equal(artifacts[0].productCount, 105);
  for (const field of ['template_version_id', 'template_definition_hash', 'input_fingerprint']) {
    await assert.rejects(pool.query(`UPDATE export_snapshots SET ${field}=NULL WHERE id=$1`, [s.id]), /immutable/);
  }
  await assert.rejects(pool.query("UPDATE export_snapshots SET request_intent='{}' WHERE id=$1", [s.id]), /immutable/);
  await assert.rejects(pool.query("UPDATE export_snapshots SET binding_evidence='{}' WHERE id=$1", [s.id]), /immutable/);
  for (const mutation of [
    { template_version_id: null }, { input_fingerprint: null }, { request_intent: null },
    { binding_evidence: null }, { template_definition_hash: 'f'.repeat(64), binding_evidence: {
      ...s.binding_evidence, effective: { ...s.binding_evidence.effective, definitionHash: 'f'.repeat(64) } } },
  ]) {
    const clone = { ...s, ...mutation, id: crypto.randomUUID(), idempotency_key: crypto.randomUUID() };
    await assert.rejects(pool.query(`INSERT INTO export_snapshots SELECT * FROM jsonb_populate_record(NULL::export_snapshots,$1::jsonb)`,
      [JSON.stringify(clone)]), (e) => ['23514', '23503'].includes(e.code));
  }
  await exportsService.confirmExportSnapshot(s.id, opts());
  assert.equal((await exportsService.getExportSnapshot(s.id)).confirmed_by_user_id, String(admin.applicationUser.id));
  assert.equal(await countEvents(s.id, 'export_snapshot.confirmed'), 1);
});

test('PR3 retry identity survives confirmation, expiry, product and activation changes without re-evaluation', async () => {
  await select(version);
  const row = await insert(); const input = command(row, { mode: 'active' }); const p = await preview(input);
  const key = crypto.randomUUID(); const s = await create(input, p, key);
  await exportsService.confirmExportSnapshot(s.id, opts());
  await pool.query('UPDATE products SET total_price_uah=2222 WHERE id=$1', [row.id]);
  const refreshed = await preview(input);
  await assert.rejects(create(input, refreshed, key), { code: 'EXPORT_IDEMPOTENCY_CONFLICT' });
  await select(await publish(definition('another active version')));
  await assert.rejects(create(input, await preview(input), key), { code: 'EXPORT_IDEMPOTENCY_CONFLICT' });
  await select(null);
  const oldBinding = signer.verify(p.previewToken, { completed: true });
  const expired = { previewToken: signer.sign(oldBinding, Date.now() - 3600000) };
  const before = await exportState();
  for (const token of [p, expired, undefined]) {
    const retried = await create(input, token, key);
    assert.equal(retried.id, s.id); assert.equal(retried.status, 'confirmed');
    assert.equal(retried.created_by_user_id, s.created_by_user_id);
  }
  assert.deepEqual(await exportState(), before); assert.equal(await countEvents(s.id), 1);
  for (const change of [{ mode: 'new' }, { toSku: null }, { fromSku: 'OTHER' }, { selection: explicit() }, { profile: 'internal-legacy' }]) {
    await assert.rejects(create({ ...input, ...change }, undefined, key), { code: 'EXPORT_IDEMPOTENCY_CONFLICT' });
  }
  await assert.rejects(exportsService.createExportSnapshot({ fromSku: row.full_sku, toSku: row.full_sku, idempotencyKey: key }, opts()), { code: 'EXPORT_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(create(input, undefined), { code: 'EXPORT_PREVIEW_REQUIRED' });
  await assert.rejects(create(input, expired), { code: 'EXPORT_PREVIEW_EXPIRED' });
  await assert.rejects(create(input, { previewToken: 'draft-test-preview' }, key), { code: 'EXPORT_PREVIEW_INVALID' });
  await assert.rejects(preview(input), { code: 'EXPORT_TEMPLATE_NOT_SELECTED' });
});

test('PR3 active ABA stales unused keys; explicit pins ignore activation and draft edits', async () => {
  await select(version); const other = await publish(definition('other'));
  const row = await insert(); const active = command(row, { mode: 'active' }); const pinned = command(row);
  const a = await preview(active); const p = await preview(pinned);
  await select(other); await select(version);
  await assert.rejects(create(active, a), { code: 'EXPORT_PREVIEW_STALE' });
  const family = await templates.getTemplate(version.templateId);
  await templates.saveDraft(version.templateId, { expectedRevision: family.draft.revision, definition: { incomplete: true } }, opts());
  await select(null);
  const made = await create(pinned, p); assert.equal(made.template_version_id, version.id);
  const legacy = await exportsService.createExportSnapshot({ fromSku: row.full_sku, toSku: row.full_sku,
    idempotencyKey: crypto.randomUUID() }, opts());
  assert.equal(legacy.request_contract, 'legacy'); assert.equal(legacy.template_version_id, null);
  const bytes = (await exportsService.getMagentoArtifact(legacy.id, 'BR')).csv_content;
  await select(other);
  assert.equal((await exportsService.createExportSnapshot({ fromSku: ` ${row.full_sku.toLowerCase()} `,
    toSku: row.full_sku, idempotencyKey: legacy.idempotency_key }, opts())).id, legacy.id);
  assert.equal((await exportsService.getMagentoArtifact(legacy.id, 'BR')).csv_content, bytes);
  await assert.rejects(create(pinned, p, legacy.idempotency_key), { code: 'EXPORT_IDEMPOTENCY_CONFLICT' });
  await select(null);
});

test('PR3 authoritative fingerprints stale on price, answers, weight, names, exclusion, schema and internal catalog', async () => {
  const changes = [
    "total_price_uah=2345.67", "weight=11.25", "details=jsonb_set(details,'{answers,unknown}','null')",
    "details=jsonb_set(details,'{answers,unknown}','0')", "details=jsonb_set(details,'{answers,unknown}','\"\"')",
    "magento_name_subject_ua='Нова',magento_name_subject_en='New'", 'exclude_from_export=1',
    "full_sku=full_sku || '-CHANGED'", "category='NM'",
  ];
  for (const set of changes) {
    const row = await insert(); const input = command(row); const p = await preview(input);
    await pool.query(`UPDATE products SET ${set} WHERE id=$1`, [row.id]);
    const before = await exportState();
    await assert.rejects(create(input, p), { code: 'EXPORT_PREVIEW_STALE' });
    assert.deepEqual(await exportState(), before);
  }
  const row = await insert(); const input = command(row); const p = await preview(input);
  const schema = (await pool.query("SELECT id FROM sku_schema_versions WHERE category_code='BR' ORDER BY id LIMIT 1")).rows[0];
  await pool.query('UPDATE products SET sku_schema_version_id=$2 WHERE id=$1', [row.id, schema.id]);
  await assert.rejects(create(input, p), { code: 'EXPORT_PREVIEW_STALE' });
  const p2 = await preview(input);
  const q = (await pool.query("SELECT id,label FROM questions WHERE category_code='BR' AND include_in_sku=0 ORDER BY id LIMIT 1")).rows[0];
  await pool.query("UPDATE questions SET label=label || ' PR3' WHERE id=$1", [q.id]);
  try { await assert.rejects(create(input, p2), { code: 'EXPORT_PREVIEW_STALE' }); }
  finally { await pool.query('UPDATE questions SET label=$2 WHERE id=$1', [q.id, q.label]); }
  const sourceVersion = await publish(materializeMagentoV1(catalog()));
  const sourceInput = command(row, explicit(sourceVersion)); const sourcePreview = await preview(sourceInput);
  const stored = await create(sourceInput, sourcePreview);
  const storedArtifact = await exportsService.getMagentoArtifact(stored.id, 'BR');
  const info = (await pool.query("SELECT id,key FROM questions WHERE category_code='BR' AND key='braclet_size'")).rows[0];
  await pool.query("UPDATE questions SET key='pr3_unresolved_size' WHERE id=$1", [info.id]);
  try {
    await assert.rejects(create(sourceInput, sourcePreview), { code: 'TEMPLATE_SOURCE_INVALID' });
    assert.equal((await exportsService.getMagentoArtifact(stored.id, 'BR')).csv_content, storedArtifact.csv_content);
    await exportsService.confirmExportSnapshot(stored.id, opts());
  }
  finally { await pool.query('UPDATE questions SET key=$2 WHERE id=$1', [info.id, info.key]); }
});

test('PR3 frozen rules and stored-price exports ignore live requiredness, rates and revision-only changes', async () => {
  const v = await publish(materializeMagentoV1(catalog()));
  const row = await insert(); const input = command(row, explicit(v)); const p = await preview(input);
  const q = (await pool.query("SELECT id,required,visible_if_json FROM questions WHERE category_code='BR' AND key='color'")).rows[0];
  await pool.query("UPDATE questions SET required=1,visible_if_json='{\"raw_type\":999}' WHERE id=$1", [q.id]);
  try {
    await pool.query('UPDATE exchange_rate_cache SET rate=rate+1');
    await pool.query('UPDATE price_matrix SET price=price+1 WHERE price > 0');
    // Existing exposure changes only capture evidence, never exported product facts.
    await pool.query('INSERT INTO product_export_revisions (product_id,revision,confirmed_revision,has_product_snapshot) VALUES ($1,2,0,true)', [row.id]);
    await pool.query('UPDATE product_export_revisions SET revision=3 WHERE product_id=$1', [row.id]);
    const s = await create(input, p); assert.deepEqual(s.reexport_revisions, []);
    assert.equal((await pool.query('SELECT confirmed_revision FROM product_export_revisions WHERE product_id=$1', [row.id])).rows[0].confirmed_revision, '0');
  } finally {
    await pool.query('UPDATE questions SET required=$2,visible_if_json=$3 WHERE id=$1', [q.id, q.required, q.visible_if_json]);
    await pool.query('UPDATE exchange_rate_cache SET rate=rate-1');
    await pool.query('UPDATE price_matrix SET price=price-1 WHERE price > 1');
  }
});

test('PR3 bounded/open range membership and new-mode caller intent, cursor, empty and readiness boundaries', async () => {
  const first = await insert(); const last = await insert();
  const bounded = { ...command(first), toSku: last.full_sku };
  const open = { ...bounded, toSku: null }; const b = await preview(bounded); const o = await preview(open);
  await insert();
  await assert.rejects(create(open, o), { code: 'EXPORT_PREVIEW_STALE' });
  await create(bounded, b);
  const upper = (await pool.query('SELECT full_sku FROM products ORDER BY id DESC LIMIT 1')).rows[0];
  const drain = await exportsService.createExportSnapshot({ fromSku: upper.full_sku, toSku: upper.full_sku,
    profile: 'internal-legacy', idempotencyKey: crypto.randomUUID() }, opts());
  await exportsService.confirmExportSnapshot(drain.id, opts());
  const input = { requestContract: 'template-v1', mode: 'new', selection: explicit() };
  const empty = await preview(input); assert.equal(empty.range, null); assert.equal(empty.previewToken, null);
  const row = await insert(); const p = await preview(input);
  assert.equal(p.intent.fromSku, null); assert.equal(p.range.fromSku, row.full_sku);
  const explicitAnchors = { ...input, fromSku: p.range.fromSku, toSku: p.range.toSku };
  await assert.rejects(create(explicitAnchors, p), { code: 'EXPORT_PREVIEW_STALE' });
  const key = crypto.randomUUID(); const s = await create(input, p, key);
  await exportsService.confirmExportSnapshot(s.id, opts());
  await insert(); assert.equal((await create(input, undefined, key)).id, s.id);
  await assert.rejects(create(input, p), { code: 'EXPORT_PREVIEW_STALE' });
  const bad = await insert(product('BR', { color: 99999 }));
  const good = await insert();
  const strict = await publish(materializeMagentoV1(catalog()));
  const strictInput = { ...command(bad, explicit(strict)), toSku: good.full_sku }; const before = await exportState();
  const notReady = await preview(strictInput);
  assert.equal(notReady.representedCount, 2); assert.equal(notReady.readyCount, 1); assert.equal(notReady.previewToken, null);
  await assert.rejects(create(strictInput, notReady), { code: 'EXPORT_PREVIEW_REQUIRED' });
  assert.deepEqual(await exportState(), before);
});

test('PR3 HTTP compatibility, auth/CSRF and delegated active export without template-management capability', async () => {
  const row = await insert(); const active = command(row, { mode: 'active' }); await select(version);
  const pending = await authenticateIdentitySession({ subject: `pr3-access-${crypto.randomUUID()}` });
  for (const url of ['/api/export/preview', '/api/export/snapshots']) {
    assert.equal((await request(url, { method: 'POST', body: active, authentication: null })).response.status, 401);
    assert.equal((await request(url, { method: 'POST', body: active, authentication: pending })).data.code, 'APP_ACCESS_PENDING');
    assert.equal((await request(url, { method: 'POST', body: active, authentication: admin, csrfToken: null })).response.status, 403);
  }
  const role = (await request('/api/admin/roles', { method: 'POST', authentication: admin, body: {
    displayName: `PR3 export ${crypto.randomUUID()}`, description: 'Export only', permissionKeys: ['exports.view', 'exports.create'],
  } })).data.role;
  await request(`/api/admin/users/${pending.applicationUser.id}/approve`, { method: 'POST', authentication: admin, body: { roleId: role.id } });
  const p = await request('/api/export/preview', { method: 'POST', authentication: pending, body: active });
  assert.equal(p.response.status, 200, p.text);
  assert.equal((await request(`/api/admin/export-templates/${version.templateId}`, { authentication: pending })).response.status, 403);
  const key = crypto.randomUUID();
  const made = await request('/api/export/snapshots', { method: 'POST', authentication: pending,
    body: { ...active, previewToken: p.data.previewToken, idempotencyKey: key } });
  assert.equal(made.response.status, 201, made.text);
  for (const [token, status, code] of [
    ['draft-preview-hash', 422, 'EXPORT_PREVIEW_INVALID'],
    [p.data.previewToken.slice(0, -4), 422, 'EXPORT_PREVIEW_INVALID'],
    ['x'.repeat(8193), 422, 'EXPORT_PREVIEW_INVALID'],
    [signer.sign(signer.verify(p.data.previewToken), Date.now() - 3600000), 409, 'EXPORT_PREVIEW_EXPIRED'],
  ]) {
    const invalid = await request('/api/export/snapshots', { method: 'POST', authentication: pending,
      body: { ...active, previewToken: token, idempotencyKey: crypto.randomUUID() } });
    assert.equal(invalid.response.status, status, invalid.text); assert.equal(invalid.data.code, code);
  }
  const adminRetry = await create(active, undefined, key);
  assert.equal(adminRetry.created_by_user_id, String(pending.applicationUser.id));
  assert.equal(await countEvents(adminRetry.id), 1);
  const pinnedInput = command(row);
  const pinnedPreview = await preview(pinnedInput, opts(pool, pending)); // Currently active exception.
  const pinnedKey = crypto.randomUUID();
  const pinned = await create(pinnedInput, pinnedPreview, pinnedKey, opts(pool, pending));
  await select(null);
  await assert.rejects(create(pinnedInput, pinnedPreview, crypto.randomUUID(), opts(pool, pending)), { code: 'INSUFFICIENT_PERMISSION' });
  assert.equal((await create(pinnedInput, undefined, pinnedKey, opts(pool, pending))).id, pinned.id);
  const retry = await request('/api/export/snapshots', { method: 'POST', authentication: pending, body: { ...active, idempotencyKey: key } });
  assert.equal(retry.data.id, made.data.id); assert.equal(retry.response.status, 201);
  assert.equal((await request(`/api/export/snapshots/${made.data.id}/confirm`, { method: 'POST', body: {}, authentication: pending })).response.status, 200);
  for (const body of [{ ...active, requestContract: 'future' }, { ...active, profile: 'internal-legacy' },
    { ...active, selection: { mode: 'explicit', templateId: version.templateId } }]) {
    const result = await request('/api/export/preview', { method: 'POST', authentication: admin, body });
    assert.equal(result.response.status, 422, result.text); assert.ok(result.data.code);
  }
  await request(`/api/admin/users/${pending.applicationUser.id}/disable`, { method: 'POST', authentication: admin, body: {} });
  const denied = await request('/api/export/snapshots', { method: 'POST', authentication: pending, body: { ...active, idempotencyKey: key } });
  assert.equal(denied.data.code, 'APP_ACCESS_DISABLED');
});

test('PR3 full creation rollback after exposure, artifact insertion and audit failure preserves all export state', async () => {
  for (const table of ['export_snapshots', 'magento_export_artifacts', 'audit_events']) {
    const row = await insert(); const input = command(row);
    if (table === 'magento_export_artifacts') input.toSku = (await insert(product('NM'))).full_sku;
    const p = await preview(input); const before = await exportState();
    await pool.query(`CREATE FUNCTION fail_pr3_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN ${table === 'magento_export_artifacts' ? "IF NEW.group_code <> 'NM' THEN RETURN NEW; END IF;" : ''}
      RAISE EXCEPTION 'PR3 injected ${table} failure'; END; $$;
      CREATE TRIGGER fail_pr3_insert BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_pr3_insert()`);
    try { await assert.rejects(create(input, p), /PR3 injected/); }
    finally { await pool.query(`DROP TRIGGER fail_pr3_insert ON ${table}; DROP FUNCTION fail_pr3_insert()`); }
    assert.deepEqual(await exportState(), before);
  }
});

test('PR3 real same-key advisory wait retains an older RR snapshot and recovers matching or conflicting winner', async () => {
  for (const variant of ['same', 'different', 'no-token']) {
    const different = variant === 'different';
    const row = await insert(); const input = command(row, different ? { mode: 'active' } : explicit());
    const otherVersion = different ? await publish(definition('different binding')) : version;
    if (different) await select(otherVersion);
    const otherInput = input;
    const otherPreview = variant === 'no-token' ? undefined : await preview(otherInput);
    if (different) await select(version);
    const p = await preview(input);
    const a = await worker(); const b = await worker(); const key = crypto.randomUUID();
    const gate = gatePool(a.db, /UPDATE product_export_revisions/);
    let left; let right;
    try {
      left = settled(create(input, p, key, opts(gate.database)));
      await gate.arrived;
      right = settled(create(otherInput, otherPreview, key, opts(b.db)));
      await blocked(b.pid, a.pid); // advisory SELECT already established b's old RR snapshot.
      gate.release();
      const first = await left; const second = await right;
      assert.ok(first.value, first.error?.stack);
      if (different) assert.equal(second.error?.code, 'EXPORT_IDEMPOTENCY_CONFLICT');
      else assert.equal(second.value?.id, first.value.id, second.error?.stack);
      const rows = (await pool.query('SELECT * FROM export_snapshots WHERE idempotency_key=$1', [key])).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].template_version_id, version.id);
      assert.equal(rows[0].created_by_user_id, String(admin.applicationUser.id));
      assert.equal(await countEvents(rows[0].id), 1);
      assert.equal((await exportsService.getMagentoArtifacts(rows[0].id)).length, 1);
      assert.equal((await pool.query('SELECT has_product_snapshot,confirmed_revision FROM product_export_revisions WHERE product_id=$1', [row.id])).rows[0].confirmed_revision, '0');
    } finally { gate.release(); await Promise.all([left, right]); await a.db.end(); await b.db.end(); if (different) await select(null); }
  }
});

test('PR3 legacy versus template one-key race in both winner orders checks contract after rollback', async () => {
  for (const templateFirst of [true, false]) {
    const row = await insert(); const input = command(row); const p = await preview(input); const key = crypto.randomUUID();
    const a = await worker(); const b = await worker(); const gate = gatePool(a.db, /UPDATE product_export_revisions/);
    const normal = (database) => exportsService.createExportSnapshot({ fromSku: row.full_sku, toSku: row.full_sku, idempotencyKey: key }, opts(database));
    const configured = (database) => create(input, p, key, opts(database));
    let left; let right;
    try {
      left = settled((templateFirst ? configured : normal)(gate.database)); await gate.arrived;
      right = settled((templateFirst ? normal : configured)(b.db)); await blocked(b.pid, a.pid);
      gate.release(); const winner = await left; const loser = await right;
      assert.ok(winner.value, winner.error?.stack); assert.equal(loser.error?.code, 'EXPORT_IDEMPOTENCY_CONFLICT');
      const s = (await pool.query('SELECT * FROM export_snapshots WHERE idempotency_key=$1', [key])).rows;
      assert.equal(s.length, 1); assert.equal(s[0].request_contract, templateFirst ? 'template-v1' : 'legacy');
      assert.equal(await countEvents(s[0].id), 1); assert.equal((await exportsService.getMagentoArtifacts(s[0].id)).length, 1);
    } finally { gate.release(); await Promise.all([left, right]); await a.db.end(); await b.db.end(); }
  }
});

test('PR3 product/name/price mutation versus capture both orders yields one coherent instant', async () => {
  for (const mutationFirst of [true, false]) {
    const row = await insert(); const input = command(row); const p = await preview(input); const w = await worker();
    const mutation = await worker(); const key = crypto.randomUUID();
    const sql = "UPDATE products SET total_price_uah=8888,weight=20,magento_name_subject_ua='Зміна',magento_name_subject_en='Changed' WHERE id=$1";
    let result;
    if (mutationFirst) {
      const hold = await barrier(sql, [row.id]);
      try {
        const pending = settled(create(input, p, key, opts(w.db)));
        await blocked(w.pid, hold.pid); await hold.client.query('COMMIT'); result = await pending;
        assert.equal(result.error?.code, 'EXPORT_PREVIEW_STALE');
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM export_snapshots WHERE idempotency_key=$1', [key])).rows[0].n, 0);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_export_revisions WHERE product_id=$1', [row.id])).rows[0].n, 0);
      } finally { await hold.client.query('ROLLBACK'); hold.client.release(); }
    } else {
      const gate = gatePool(w.db, /FOR SHARE OF p/); let change; let pending;
      try {
        pending = settled(create(input, p, key, opts(gate.database))); await gate.arrived;
        change = mutation.db.query(sql, [row.id]); await blocked(mutation.pid, w.pid);
        gate.release(); result = await pending; await change;
        assert.ok(result.value, result.error?.stack);
        assert.ok(result.value.csv_content.includes('1234.56'));
        assert.ok((await exportsService.getMagentoArtifact(result.value.id, 'BR')).csv_content.includes('1234.56'));
        assert.equal(await countEvents(result.value.id), 1);
      } finally { gate.release(); await Promise.all([pending, change]); }
    }
    assert.equal((await pool.query('SELECT total_price_uah FROM products WHERE id=$1', [row.id])).rows[0].total_price_uah, '8888.00');
    await w.db.end(); await mutation.db.end();
  }
});

test('PR3 activation versus active capture both orders protects selection and access revocation waits', async () => {
  const other = await publish(definition('activation race'));
  for (const activationFirst of [true, false]) {
    await select(version); const row = await insert(); const input = command(row, { mode: 'active' }); const p = await preview(input);
    const a = await worker(); const b = await worker();
    const current = await templates.getActivation();
    const activate = (database) => templates.updateActivation({ expectedGeneration: current.generation,
      implementation: 'template', templateVersionId: other.id }, opts(database));
    let first; let last;
    const gate = gatePool(a.db, activationFirst ? /UPDATE export_template_activation SET/ : /FOR SHARE OF p/);
    try {
      first = settled(activationFirst ? activate(gate.database) : create(input, p, crypto.randomUUID(), opts(gate.database)));
      await gate.arrived;
      last = settled(activationFirst ? create(input, p, crypto.randomUUID(), opts(b.db)) : activate(b.db));
      await blocked(b.pid, a.pid); gate.release(); const one = await first; const two = await last;
      assert.ok(one.value, one.error?.stack);
      if (activationFirst) assert.equal(two.error?.code, 'EXPORT_PREVIEW_STALE');
      else {
        assert.ok(two.value, two.error?.stack); assert.equal(one.value.template_version_id, version.id);
        assert.equal(await countEvents(one.value.id), 1);
      }
      assert.equal((await templates.getActivation()).templateVersionId, other.id);
    } finally { gate.release(); await Promise.all([first, last]); await a.db.end(); await b.db.end(); }
  }
  await select(null);
});

test('PR3 access revocation committed before RR capture denies the previously issued preview', async () => {
  const actor = await authenticateIdentitySession({ subject: `pr3-revoke-${crypto.randomUUID()}` });
  const role = (await request('/api/admin/roles', { authentication: admin, method: 'POST', body: {
    displayName: `PR3 revocation ${crypto.randomUUID()}`, description: 'Race', permissionKeys: ['exports.view','exports.create'],
  } })).data.role;
  await request(`/api/admin/users/${actor.applicationUser.id}/approve`, { authentication: admin, method: 'POST', body: { roleId: role.id } });
  await select(version); const row = await insert(); const input = command(row, { mode: 'active' }); const p = await preview(input, opts(pool, actor));
  const w = await worker(); const hold = await barrier('SELECT pg_advisory_xact_lock(hashtext($1))', [APPLICATION_USER_ADMIN_LOCK_KEY]);
  try {
    const key = crypto.randomUUID(); const pending = settled(create(input, p, key, opts(w.db, actor)));
    await blocked(w.pid, hold.pid);
    await hold.client.query("DELETE FROM role_permissions WHERE role_id=$1 AND permission_key='exports.create'", [role.id]);
    await hold.client.query('COMMIT');
    assert.equal((await pending).error?.code, 'ADMIN_PERMISSION_REVOKED');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM export_snapshots WHERE idempotency_key=$1', [key])).rows[0].n, 0);
  } finally { await hold.client.query('ROLLBACK'); hold.client.release(); await w.db.end(); await select(null); }
});

test('PR3 normal confirmation versus new template capture both orders keeps revisions before cursor', async () => {
  for (const confirmFirst of [true, false]) {
    const last = (await pool.query('SELECT full_sku FROM products ORDER BY id DESC LIMIT 1')).rows[0];
    const drain = await exportsService.createExportSnapshot({ fromSku: last.full_sku, toSku: last.full_sku,
      profile: 'internal-legacy', idempotencyKey: crypto.randomUUID() }, opts());
    await exportsService.confirmExportSnapshot(drain.id, opts());
    const row = await insert();
    await pool.query('INSERT INTO product_export_revisions (product_id,revision,confirmed_revision,has_product_snapshot) VALUES ($1,1,0,false)', [row.id]);
    const normal = await exportsService.createExportSnapshot({ fromSku: row.full_sku, toSku: row.full_sku, idempotencyKey: crypto.randomUUID() }, opts());
    assert.deepEqual(normal.reexport_revisions, [{ productId: row.id, revision: 1 }]);
    const input = { requestContract: 'template-v1', mode: 'new', selection: explicit() }; const p = await preview(input);
    const a = await worker(); const b = await worker(); const key = crypto.randomUUID();
    const gate = gatePool(a.db, confirmFirst ? /INSERT INTO export_state/ : /INSERT INTO export_snapshots/);
    let first; let second;
    try {
      const confirm = (db) => exportsService.confirmExportSnapshot(normal.id, opts(db));
      const capture = (db) => create(input, p, key, opts(db));
      first = settled((confirmFirst ? confirm : capture)(gate.database)); await gate.arrived;
      second = settled((confirmFirst ? capture : confirm)(b.db)); await blocked(b.pid, a.pid);
      gate.release(); const one = await first; const two = await second;
      assert.ok(one.value, one.error?.stack);
      if (confirmFirst) assert.equal(two.error?.code, 'EXPORT_PREVIEW_STALE');
      else { assert.ok(two.value, two.error?.stack); assert.deepEqual(one.value.reexport_revisions, []); }
      assert.equal((await pool.query('SELECT exported_to_product_id FROM export_state')).rows[0].exported_to_product_id, row.id);
      const revision = (await pool.query('SELECT * FROM product_export_revisions WHERE product_id=$1', [row.id])).rows[0];
      assert.equal(revision.revision, '1'); assert.equal(revision.confirmed_revision, '1'); assert.equal(revision.has_product_snapshot, true);
      assert.equal(await countEvents(normal.id, 'export_snapshot.confirmed'), 1);
      const stored = (await pool.query('SELECT * FROM export_snapshots WHERE idempotency_key=$1', [key])).rows;
      assert.equal(stored.length, confirmFirst ? 0 : 1);
      if (stored.length) { assert.equal(await countEvents(stored[0].id), 1); assert.equal((await exportsService.getMagentoArtifacts(stored[0].id)).length, 1); }
    } finally { gate.release(); await Promise.all([first, second]); await a.db.end(); await b.db.end(); }
  }
});

test('PR3 normal/template/price confirmation ordering never consumes a later pending price', async () => {
  for (const newestFirst of [true, false]) {
  const row = await insert();
  await pool.query('INSERT INTO product_export_revisions (product_id,revision,confirmed_revision,has_product_snapshot) VALUES ($1,1,0,false)', [row.id]);
  const initial = await create(command(row), await preview(command(row)));
  assert.deepEqual(initial.reexport_revisions, [{ productId: row.id, revision: 1 }]);
  async function change(price, revision) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('UPDATE products SET total_price_uah=$2 WHERE id=$1', [row.id, price]);
      await client.query('UPDATE product_export_revisions SET revision=$2 WHERE product_id=$1', [row.id, revision]); await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  await change(2000, 2);
  const price2 = await prices.createPriceExportSnapshot({ idempotencyKey: crypto.randomUUID() }, opts());
  await change(3000, 3);
  const price3 = await prices.createPriceExportSnapshot({ idempotencyKey: crypto.randomUUID() }, opts());
  const template = await create(command(row), await preview(command(row)));
  const normal = await exportsService.createExportSnapshot({ fromSku: row.full_sku, toSku: row.full_sku, idempotencyKey: crypto.randomUUID() }, opts());
  assert.deepEqual(template.reexport_revisions, []); assert.deepEqual(normal.reexport_revisions, []);
  const artifact = await exportsService.getMagentoArtifact(template.id, 'BR');
  await change(4000, 4);
  const held = await barrier('SELECT product_id FROM product_export_revisions WHERE product_id=$1 FOR UPDATE', [row.id]);
  const ordered = newestFirst ? [price3, price2] : [price2, price3];
  const jobs = [];
  try {
    for (let index = 0, priorPid = held.pid; index < ordered.length; index++) {
      const application = `pr3-price-confirm-${crypto.randomUUID()}`;
      jobs.push(settled(runNodeInDatabase(TEST_DATABASE_URL, `
        const p=require('./src/services/price-export.service'); const pool=require('./src/db/pool');
        p.confirmPriceExportSnapshot(${JSON.stringify(ordered[index].id)},${JSON.stringify({ mutationContext: opts().mutationContext })})
          .catch(e=>{console.error(e);process.exitCode=1}).finally(()=>pool.end());`, { PGAPPNAME: application })));
      priorPid = await blockedApplication(application, [held.pid, priorPid]);
    }
    await held.client.query('COMMIT');
    for (const job of await Promise.all(jobs)) assert.ok(job.value, job.error?.stack);
  } finally { await held.client.query('ROLLBACK'); held.client.release(); await Promise.all(jobs); }
  await Promise.all([exportsService.confirmExportSnapshot(initial.id, opts()),
    exportsService.confirmExportSnapshot(template.id, opts()), exportsService.confirmExportSnapshot(normal.id, opts())]);
  assert.deepEqual((await pool.query('SELECT revision,confirmed_revision,has_product_snapshot FROM product_export_revisions WHERE product_id=$1', [row.id])).rows[0],
    { revision: '4', confirmed_revision: '3', has_product_snapshot: true });
  assert.equal((await exportsService.getMagentoArtifact(template.id, 'BR')).csv_content, artifact.csv_content);
  for (const s of [initial, template, normal]) {
    assert.equal(await countEvents(s.id, 'export_snapshot.confirmed'), 1);
    assert.equal((await exportsService.getExportSnapshot(s.id)).confirmed_by_user_id, String(admin.applicationUser.id));
  }
  assert.ok(price2.csv_content.includes(`${row.full_sku},2000`)); assert.ok(price3.csv_content.includes(`${row.full_sku},3000`));
  for (const s of [price2, price3]) {
    assert.equal(await countEvents(s.id, 'price_export_snapshot.created'), 1);
    assert.equal(await countEvents(s.id, 'price_export_snapshot.confirmed'), 1);
    assert.equal((await prices.getPriceExportSnapshot(s.id)).confirmed_by_user_id, String(admin.applicationUser.id));
  }
  }
});

test('PR3 insertion committed after RR membership capture remains eligible for the next new operation', async () => {
  const last = (await pool.query('SELECT full_sku FROM products ORDER BY id DESC LIMIT 1')).rows[0];
  const drain = await exportsService.createExportSnapshot({ fromSku: last.full_sku, toSku: last.full_sku,
    profile: 'internal-legacy', idempotencyKey: crypto.randomUUID() }, opts());
  await exportsService.confirmExportSnapshot(drain.id, opts());
  const first = await insert();
  const input = { requestContract: 'template-v1', mode: 'new', selection: explicit() }; const p = await preview(input);
  const w = await worker(); const gate = gatePool(w.db, /FOR SHARE OF p/); let pending;
  try {
    pending = settled(create(input, p, crypto.randomUUID(), opts(gate.database))); await gate.arrived;
    const later = await insert(); gate.release(); const result = await pending;
    assert.ok(result.value, result.error?.stack); assert.equal(result.value.row_count, 1);
    assert.equal(result.value.exported_to_product_id, first.id);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_export_revisions WHERE product_id=$1', [later.id])).rows[0].n, 0);
    await exportsService.confirmExportSnapshot(result.value.id, opts());
    const next = await preview(input); assert.equal(next.representedCount, 1);
    assert.equal(next.range.fromSku, later.full_sku); assert.equal(next.range.toSku, later.full_sku);
    assert.equal((await pool.query('SELECT exported_to_product_id FROM export_state')).rows[0].exported_to_product_id, first.id);
    assert.equal(await countEvents(result.value.id), 1);
  } finally { gate.release(); await pending; await w.db.end(); }
});

test('PR3 completed retries, stored reads and confirmation do not need an available evaluator', async () => {
  const row = await insert(); const input = command(row); const p = await preview(input); const key = crypto.randomUUID();
  const s = await create(input, p, key);
  await runNodeInDatabase(TEST_DATABASE_URL, `
    const definition=require('./src/services/export-templates/definition');
    definition.compileDefinition=()=>{throw Error('Evaluator deliberately unavailable')};
    const exp=require('./src/services/export.service');
    const pool=require('./src/db/pool');
    const assert=require('node:assert/strict');
    (async()=>{
      const input=${JSON.stringify({ ...input, idempotencyKey: key })};
      const options=${JSON.stringify({ mutationContext: opts().mutationContext })};
      const retry=await exp.createExportSnapshot(input,options); assert.equal(retry.id,${JSON.stringify(s.id)});
      const withToken=await exp.createExportSnapshot({...input,previewToken:${JSON.stringify(p.previewToken)}},options);
      assert.equal(withToken.id,retry.id);
      const artifact=await exp.getMagentoArtifact(retry.id,'BR'); assert.ok(artifact.csv_content);
      await exp.confirmExportSnapshot(retry.id,options);
    })().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>pool.end());`);
  assert.equal(await countEvents(s.id), 1); assert.equal(await countEvents(s.id, 'export_snapshot.confirmed'), 1);
});

test('PR3 actual 035 checkpoint upgrade, failed migration rollback, repeat startup and historical bytes/actors', async () => {
  const name = 'amber_pr3_upgrade_test'; const url = await recreateTestDatabase(name);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'amber-pr3-migrations-'));
  const db = new Pool({ connectionString: url });
  try {
    const files = (await fs.readdir(path.join(serverRoot, 'migrations'))).filter((f) => f.endsWith('.sql') && f < '036_');
    for (const f of files) await fs.copyFile(path.join(serverRoot, 'migrations', f), path.join(directory, f));
    const run = (dir) => runNodeInDatabase(url, `require('./src/db/run-migrations').runMigrations(${dir ? `{directory:${JSON.stringify(dir)}}` : ''})
      .catch(e=>{console.error(e);process.exitCode=1})`);
    await run(directory);
    assert.equal((await db.query('SELECT max(name) AS name FROM schema_migrations')).rows[0].name, '035_export_templates.sql');
    const actor = (await db.query("INSERT INTO application_users (status,display_name) VALUES ('active','Historical creator') RETURNING id")).rows[0].id;
    await db.query(`INSERT INTO export_snapshots (id,idempotency_key,from_sku,to_sku,resolved_to_sku,exported_to_product_id,
      row_count,file_name,csv_content,created_by_user_id,reexport_revisions)
      VALUES ('old','old-key','A',NULL,'A',7,1,'old.csv',$1,$2,'[{"productId":7,"revision":5}]')`, ['sku,price\r\nA,12.34', actor]);
    await db.query(`INSERT INTO magento_export_artifacts (snapshot_id,profile_version,group_code,file_name,csv_content,product_count,row_count)
      VALUES ('old','magento-products-v1','BR','old-magento.csv',$1,1,2)`, ['sku,name\nA,старий\nA,old']);
    const before = (await db.query("SELECT * FROM export_snapshots WHERE id='old'")).rows[0];
    const artifacts = (await db.query('SELECT * FROM magento_export_artifacts')).rows;
    const migration = '036_export_snapshot_template_binding.sql'; const sql = await fs.readFile(path.join(serverRoot, 'migrations', migration), 'utf8');
    await fs.writeFile(path.join(directory, migration), sql + "\nSELECT 'PR3 forced migration rollback'::integer;\n");
    await assert.rejects(run(directory), /PR3 forced migration rollback/);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='export_snapshots' AND column_name='request_contract'")).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM schema_migrations WHERE name=$1', [migration])).rows[0].n, 0);
    await run(); await run();
    const after = (await db.query("SELECT * FROM export_snapshots WHERE id='old'")).rows[0];
    for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value, key);
    assert.equal(after.request_contract, 'legacy');
    for (const key of ['template_id','template_version_id','template_definition_hash','template_evaluator_version',
      'template_output_contract','template_format_version','request_intent','input_fingerprint','binding_evidence']) assert.equal(after[key], null);
    assert.deepEqual((await db.query('SELECT * FROM magento_export_artifacts')).rows, artifacts);
    await assert.rejects(db.query("UPDATE export_snapshots SET request_contract='template-v1' WHERE id='old'"), /immutable/);
    await db.query("UPDATE export_snapshots SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP,confirmed_by_user_id=$1 WHERE id='old'", [actor]);
    await assert.rejects(db.query("UPDATE export_snapshots SET reexport_revisions='[]' WHERE id='old'"), /immutable/);
    assert.equal((await db.query("SELECT csv_content FROM export_snapshots WHERE id='old'")).rows[0].csv_content, before.csv_content);
  } finally {
    await db.end();
    // fs.mkdtemp returned this exact task-owned directory; never a computed useful path.
    assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('amber-pr3-migrations-'));
    await fs.rm(directory, { recursive: true, force: true }); await dropTestDatabase(name);
  }
});

test('PR3 output-limit failure during transactional capture leaves no parent, artifacts, audit or exposure', async () => {
  const v = await publish(definition('x'.repeat(4096)));
  const row = await insert(); const input = { ...command(row, explicit(v)), toSku: null };
  const p = await preview(input);
  await insertProductFixture(pool,`INSERT INTO products (full_sku,base_sku,category,weight,total_price_uah,details)
    SELECT 'BR-PR3-LIMIT-' || n,'BR-PR3-LIMIT','BR',10,100,'{"answers":{}}'::jsonb FROM generate_series(1,8200) n`);
  const before = await exportState();
  await assert.rejects(create(input, p), { code: 'EVALUATION_LIMIT' });
  assert.deepEqual(await exportState(), before);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM product_export_revisions r JOIN products p ON p.id=r.product_id WHERE p.full_sku LIKE 'BR-PR3-LIMIT-%'")).rows[0].n, 0);
});
