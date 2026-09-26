const { test, assert, pool, crypto, request, authenticateApplicationSession, authenticateIdentitySession, roleIdForKey } = require('./suite-context');
const exportsService = require('../src/services/export.service');
const prices = require('../src/services/price-export.service');
const templates = require('../src/services/export-templates/template.service');
const sessions = require('../src/services/export-sessions.service');
const { getExportHistory } = require('../src/services/export-history.service');
const { definition, installGoldenEvidence } = require('./12-export-templates.cases');
const { product } = require('../test/fixtures/magento-v1/contract');
const options = (user) => ({ mutationContext: { actorUserId: user.applicationUser.id } });
async function effects() {
  const result = {};
  for (const table of ['export_snapshots', 'price_export_snapshots', 'magento_export_artifacts', 'product_export_revisions', 'export_state', 'export_events', 'audit_events', 'export_sessions', 'export_session_attempts']) {
    result[table] = (await pool.query(`SELECT jsonb_agg(x ORDER BY x::text) data FROM (SELECT to_jsonb(t) x FROM ${table} t) q`)).rows[0].data;
  }
  return result;
}
async function insertProduct(group, answers = {}, overrides = {}) {
  const fixture = product(group, answers, overrides); const sku = `${group}-UX3-${crypto.randomUUID()}`.toUpperCase();
  return (await pool.query('INSERT INTO products(full_sku,base_sku,category,weight,total_price_uah,details) VALUES($1,$1,$2,$3,$4,$5::jsonb) RETURNING *',
    [sku, group, fixture.weight, fixture.total_price_uah, JSON.stringify(fixture.details)])).rows[0];
}

test('UX3 authoritative diagnostic preview is read-only and ready cells/downloaded bytes survive product changes', async () => {
  const actor = await authenticateApplicationSession(); await installGoldenEvidence();
  const ready = await insertProduct('BR'); const failed = await insertProduct('SV', { souvenir: 999 });
  const before = await effects();
  const mixed = await request('/api/export/preview', { authentication: actor, method: 'POST', body: { fromSku: ready.full_sku, toSku: failed.full_sku } });
  assert.equal(mixed.response.status, 200, mixed.text);
  assert.equal(mixed.data.review.identity, mixed.data.tableFingerprint); assert.equal(mixed.data.previewExpectation, null);
  assert.ok(mixed.data.review.files.find((f) => f.groupCode === 'SV').rows.some((r) => r.productId === failed.id && r.readiness === 'attention'));
  assert.equal(mixed.data.artifacts.some((f) => f.groupCode === 'SV'), false);
  assert.deepEqual(await effects(), before);
  const range = { fromSku: ready.full_sku, toSku: ready.full_sku };
  const preview = await exportsService.previewExport(range, options(actor));
  const snapshot = await exportsService.createExportSnapshot({ ...range, previewExpectation: preview.previewExpectation, idempotencyKey: crypto.randomUUID() }, options(actor));
  const stable = await effects();
  const manifest = await request(`/api/export/snapshots/${snapshot.id}?includeRows=false`, { authentication: actor });
  assert.equal(manifest.response.status, 200, manifest.text); assert.equal(manifest.data.createdByUserId, String(actor.applicationUser.id));
  assert.equal(manifest.data.artifacts[0].csvContent, undefined); assert.deepEqual(manifest.data.capturedRange, preview.range);
  const download = await request(`/api/export/snapshots/${snapshot.id}/magento/BR/csv`, { authentication: actor });
  assert.equal(download.text, preview.artifacts[0].csvContent); assert.deepEqual(await effects(), stable);
  await pool.query('UPDATE products SET total_price_uah=total_price_uah+100 WHERE id=$1', [ready.id]);
  assert.equal((await exportsService.getMagentoArtifact(snapshot.id, 'BR', options(actor))).csv_content, download.text);
  await exportsService.confirmExportSnapshot(snapshot.id, options(actor));
  const first = await exportsService.getExportSnapshot(snapshot.id, options(actor));
  await exportsService.confirmExportSnapshot(snapshot.id, options(actor));
  const second = await exportsService.getExportSnapshot(snapshot.id, options(actor));
  assert.equal(second.confirmed_at.getTime(), first.confirmed_at.getTime()); assert.equal(second.confirmed_by_user_id, first.confirmed_by_user_id);
});

test('UX3 shared history uses precise immutable time+ID pagination, nullable creators and no read effects', async () => {
  const actor = await authenticateApplicationSession(); const prefix = `ux3-${crypto.randomUUID()}`;
  for (let index = 0; index < 5; index++) {
    const id = `${prefix}-${index}`;
    await pool.query(`INSERT INTO export_snapshots(id,idempotency_key,from_sku,resolved_to_sku,exported_to_product_id,row_count,file_name,csv_content,generated_at,created_by_user_id)
      VALUES($1,$1,'OLD','OLD',0,1,'old.csv','sku,price\nOLD,1','2099-01-01T00:00:00.123456Z',$2)`, [id, index ? actor.applicationUser.id : null]);
    await pool.query(`INSERT INTO price_export_snapshots(id,idempotency_key,row_count,file_name,csv_content,captured_revisions,generated_at,created_by_user_id)
      VALUES($1,$1,1,'price.csv','sku,price\nOLD,1','[]','2099-01-01T00:00:00.123456Z',$2)`, [id, actor.applicationUser.id]);
  }
  const before = await effects(); let after; const found = [];
  do {
    const page = await getExportHistory({ limit: 3, ...(after ? { after } : {}) }, options(actor));
    found.push(...page.items); after = page.next;
  } while (after);
  const expected = (await pool.query(`SELECT 'product' stream,id FROM export_snapshots WHERE id LIKE $1 UNION ALL SELECT 'price',id FROM price_export_snapshots WHERE id LIKE $1 ORDER BY id DESC,stream DESC`, [prefix + '%'])).rows;
  assert.deepEqual(found.filter((r) => r.id.startsWith(prefix)).map(({ stream, id }) => ({ stream, id })), expected);
  assert.equal(new Set(found.map((r) => r.stream + ':' + r.id)).size, found.length);
  const old = found.find((r) => r.id === `${prefix}-0` && r.stream === 'product');
  assert.equal(old.createdByUserId, null); assert.equal(old.sessionId, undefined); assert.equal(old.recipe.kind, 'historical');
  const mine = await getExportHistory({ scope: 'mine', limit: 50 }, options(actor));
  assert.equal(mine.items.some((r) => r.id === old.id && r.stream === 'product'), false);
  assert.ok(mine.items.every((r) => String(r.createdByUserId) === String(actor.applicationUser.id)));
  const pricePage = await request('/api/export/history?stream=price&status=generated&limit=3', { authentication: actor });
  assert.equal(pricePage.response.status, 200, pricePage.text);
  assert.equal(pricePage.data.items.length, 3);
  assert.ok(pricePage.data.items.every((r) => r.stream === 'price' && r.status === 'generated'));
  assert.equal((await request('/api/export/history?stream=product&after=' + encodeURIComponent(pricePage.data.next), { authentication: actor })).response.status, 422);
  assert.equal((await request('/api/export/history?limit=51', { authentication: actor })).response.status, 422);
  assert.deepEqual(await effects(), before);
});

test('UX3 history and direct metadata share owner/accepted membership; Administrator and pending invitation are not bypasses', async () => {
  const actor = await authenticateApplicationSession(); await installGoldenEvidence();
  const other = await authenticateIdentitySession({ subject: 'ux3-other-' + crypto.randomUUID() });
  const approved = await request(`/api/admin/users/${other.applicationUser.id}/approve`, { authentication: actor, method: 'POST', body: { roleId: await roleIdForKey('administrator') } });
  assert.equal(approved.response.status, 200, approved.text);
  const family = await templates.createTemplate({ key: 'ux3-' + crypto.randomUUID(), displayName: 'UX3 history', definition: definition('UX3 frozen') }, options(actor));
  const version = await templates.publishTemplate(family.id, { expectedRevision: family.draft.revision, expectedDefinitionHash: family.draft.definitionHash }, options(actor));
  const p = await insertProduct('BR');
  const s = await sessions.createSession({ title: 'UX3 private', creationKey: crypto.randomUUID(), settings: { requestContract: 'template-v1', fromSku: p.full_sku, toSku: p.full_sku, selection: { mode: 'explicit', templateId: family.id, versionId: version.id } } }, options(actor));
  const condition = { expectedRevision: s.configurationRevision, expectedAccessEpoch: 'owner' };
  const checked = await sessions.previewSession(s.id, options(actor));
  const attempt = await sessions.prepare(s.id, { ...condition, expectedPreviewFingerprint: checked.tableFingerprint }, options(actor));
  assert.equal(attempt.preview.review.identity, checked.review.identity);
  const snapshot = await sessions.generate(s.id, { ...condition, attemptId: attempt.id }, options(actor));
  const visible = async () => {
    let after;
    do {
      const page = await getExportHistory({ stream: 'product', limit: 50, ...(after ? { after } : {}) }, options(other));
      if (page.items.some((r) => r.id === snapshot.id)) return true;
      after = page.next;
    } while (after);
    return false;
  };
  assert.equal(await visible(), false);
  const invited = await sessions.invite(s.id, { userId: other.applicationUser.id, expectedAccessEpoch: 'owner' }, options(actor));
  assert.equal(await visible(), false);
  assert.equal((await request(`/api/export/snapshots/${snapshot.id}?includeRows=false`, { authentication: other })).response.status, 404);
  await sessions.membership(s.id, { action: 'accept', expectedAccessEpoch: invited.epoch }, options(other));
  assert.equal(await visible(), true);
  const before = await effects();
  const manifest = await request(`/api/export/snapshots/${snapshot.id}?includeRows=false`, { authentication: other });
  assert.equal(manifest.response.status, 200, manifest.text); assert.equal(manifest.data.sessionId, s.id);
  assert.deepEqual(await effects(), before);
  await sessions.membership(s.id, { action: 'leave', expectedAccessEpoch: manifest.data.accessEpoch }, options(other));
  assert.equal(await visible(), false);
});

test('UX3 price review/metadata/download do not confirm; later revisions and repeated/out-of-order confirmation stay safe', async () => {
  const actor = await authenticateApplicationSession(); const p = await insertProduct('BR');
  await pool.query('INSERT INTO product_export_revisions(product_id,revision,confirmed_revision,has_product_snapshot) VALUES($1,1,0,TRUE)', [p.id]);
  const initial = await effects();
  const review = await request('/api/price-export/preview', { authentication: actor });
  assert.equal(review.response.status, 200, review.text); assert.ok(review.data.csvContent.startsWith('sku,price\n')); assert.equal(review.data.previewToken, undefined);
  assert.deepEqual(await effects(), initial);
  const snapshot = await prices.createPriceExportSnapshot({ idempotencyKey: crypto.randomUUID() }, options(actor));
  assert.equal(snapshot.status, 'generated');
  const before = await effects();
  const manifest = await request(`/api/price-export/snapshots/${snapshot.id}`, { authentication: actor });
  assert.equal(manifest.response.status, 200, manifest.text); assert.equal(manifest.data.captured_revisions, undefined); assert.equal(manifest.data.csvContent, undefined);
  const download = await request(`/api/price-export/snapshots/${snapshot.id}/csv`, { authentication: actor });
  assert.equal(download.text, snapshot.csv_content); assert.deepEqual(await effects(), before);
  await pool.query('UPDATE products SET total_price_uah=total_price_uah+100 WHERE id=$1', [p.id]);
  await pool.query('UPDATE product_export_revisions SET revision=2 WHERE product_id=$1', [p.id]);
  const cursor = (await pool.query('SELECT * FROM export_state')).rows;
  await prices.confirmPriceExportSnapshot(snapshot.id, options(actor));
  assert.equal((await pool.query('SELECT confirmed_revision FROM product_export_revisions WHERE product_id=$1', [p.id])).rows[0].confirmed_revision, '1');
  const later = await prices.createPriceExportSnapshot({ idempotencyKey: crypto.randomUUID() }, options(actor));
  await prices.confirmPriceExportSnapshot(later.id, options(actor)); await prices.confirmPriceExportSnapshot(snapshot.id, options(actor));
  assert.equal((await pool.query('SELECT confirmed_revision FROM product_export_revisions WHERE product_id=$1', [p.id])).rows[0].confirmed_revision, '2');
  assert.deepEqual((await pool.query('SELECT * FROM export_state')).rows, cursor);
  assert.equal((await prices.getPriceExportSnapshot(snapshot.id)).csv_content, snapshot.csv_content);
});
